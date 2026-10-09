import { AiGateway } from '../ai/gateway';
import { TRAINING_PLAN_SYSTEM_PROMPT } from '../ai/prompts';
import type { AiMessage, AiTrace } from '../domain/ai-trace';
import type { RequirementMatch } from '../domain/match';
import type { CandidateProfile } from '../domain/profile';
import type { JobRequirement } from '../domain/job';
import {
  computePlanStats,
  type SelfScore,
  type TrainingItem,
  type TrainingItemType,
  type TrainingPlan,
  type TrainingWeakness,
} from '../domain/training';
import { knowledgeFor } from '../nlp/skill-knowledge';
import { findSkillsInText, resolveSkill } from '../nlp/skills';
import { newId, truncate, unique } from '../utils/text';

/**
 * 薄弱项训练计划生成（v0.2）
 * ===========================
 *
 * 题目来源不是随机题库，而是**这次匹配分析里真实没答上的那几条要求**。
 * 好处：练的东西和岗位严格对齐；练完能直接回到报告里看那条结论有没有变化。
 *
 * 出题类型由薄弱原因决定，而不是由技能决定：
 *   gap              连经历痕迹都没有 → 概念题（先确认你懂不懂它解决什么问题）
 *   lacking_evidence 说过但拿不出产出 → 讲清楚题（把做法讲成 90 秒能说完的话）
 *   partial          沾边但不够       → 对比与取舍题（面试官最爱追这一层）
 *   软技能类要求                        → 自查题（准备一个真实例子）
 */

export interface BuildTrainingInput {
  profile: CandidateProfile;
  job: JobRequirement;
  matches: RequirementMatch[];
  /** 上限，避免一次生成几十道题让人放弃 */
  maxItems?: number;
  gateway?: AiGateway | null;
  onMessages?: (messages: AiMessage[]) => void;
}

export interface BuildTrainingOutput {
  plan: TrainingPlan;
  trace: AiTrace | null;
  warnings: string[];
}

const WEAKNESS_ORDER: TrainingWeakness[] = ['gap', 'lacking_evidence', 'partial'];
const IMPORTANCE_ORDER: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 1, low: 2 };

/** 一次训练计划最多出多少题 —— 再多用户会直接放弃 */
export const TRAINING_MAX_ITEMS = 12;

function weaknessOf(match: RequirementMatch): TrainingWeakness | null {
  if (match.assessment === 'gap' || match.assessment === 'lacking_evidence' || match.assessment === 'partial') {
    return match.assessment;
  }
  return null;
}

/**
 * 训练候选的筛选规则（引擎与界面共用同一份，避免「统计说 7 条、实际只出 3 题」的口径不一致）。
 *
 * 排除条件：
 *   - 已经满足或无法判断的要求（判不了的东西练不出来）
 *   - 重要度为「低」的加分项（练它有收益，但不值得占用用户的时间）
 */
export function trainingCandidates(
  matches: RequirementMatch[],
  max: number = TRAINING_MAX_ITEMS,
): Array<{ match: RequirementMatch; weakness: TrainingWeakness }> {
  return matches
    .map((match) => ({ match, weakness: weaknessOf(match) }))
    .filter((row): row is { match: RequirementMatch; weakness: TrainingWeakness } => row.weakness !== null)
    .filter((row) => row.match.importance !== 'low' || row.match.hardGate)
    .sort((a, b) => {
      const w = WEAKNESS_ORDER.indexOf(a.weakness) - WEAKNESS_ORDER.indexOf(b.weakness);
      if (w !== 0) return w;
      return IMPORTANCE_ORDER[a.match.importance] - IMPORTANCE_ORDER[b.match.importance];
    })
    .slice(0, max);
}

function primarySkillOf(match: RequirementMatch): string | null {
  // 优先用匹配阶段识别出的能力名；缺失的排在前面（那才是薄弱点）
  for (const keyword of [...match.missingSkills, ...match.matchedSkills]) {
    const def = resolveSkill(keyword);
    if (def) return def.name;
  }
  // 回退：直接从要求原文里再找一遍
  const hits = findSkillsInText(match.requirement);
  return hits.length > 0 ? hits[0].def.name : null;
}

function itemTypeOf(weakness: TrainingWeakness, isSoft: boolean, hasSkill: boolean): TrainingItemType {
  if (!hasSkill) return 'self_check';
  if (isSoft) return 'self_check';
  if (weakness === 'gap') return 'concept';
  if (weakness === 'lacking_evidence') return 'explain';
  return 'compare';
}

/**
 * 认不出具体技能时的自查要点。
 *
 * 宁可给这类「怎么把这段经历讲清楚」的通用要点，也不要把某个技能品类的知识要点硬套上去 ——
 * 那会让用户练到与岗位无关的东西，比不给要点更糟。
 */
const REQUIREMENT_REFERENCE_POINTS = [
  '按「当时的情况 → 你做了什么 → 结果 / 对方反馈」组织，缺哪一段就补哪一段',
  '讲具体行为，不要用「沟通能力强」「有责任心」这类形容词',
  '如果这件事你确实没做过，如实保留缺口，不要用相近经历硬套',
  '补完这段经历后，把它写进能力档案里再重跑一次匹配，看结论有没有变化',
];

function buildQuestion(type: TrainingItemType, skill: string, requirementText: string, scenario?: string): string {
  switch (type) {
    case 'concept':
      return `用一句话说明「${skill}」解决什么问题，再举一个它并不适用的场景。`;
    case 'explain':
      return `把你在「${truncate(requirementText, 28)}」这件事上的做法按「场景 → 做法 → 结果」讲一遍，控制在 90 秒内。`;
    case 'compare':
      return `「${skill}」在这个场景下至少有两种做法。各自的代价是什么？你为什么选现在这种？`;
    case 'scenario':
      return scenario ?? `给一个具体情形：如果「${skill}」在你手上失效了，你会按什么顺序排查？`;
    case 'self_check':
      return `准备一个能说明「${truncate(requirementText, 28)}」的真实例子：说清当时的情况、你做了什么、对方反馈如何。`;
    default:
      return `讲一讲你对「${skill}」的理解与使用经验。`;
  }
}

interface AiTrainingPayload {
  items?: Array<{
    requirementId?: string;
    type?: string;
    question?: string;
    referencePoints?: string[];
    referenceAnswer?: string;
    followUp?: string;
  }>;
}

/**
 * 本地参考答案（v0.3）。
 *
 * 这是用户明确要的「参考答案一类的东西」。为什么不能只有自查要点：
 * 要点说的是「要提到 A、B、C」，用户仍然要自己把它们组织成一段话 —— 还是很费脑子。
 * 示例答复的价值在于给出一个**可以直接读的实物**。
 *
 * 三条不能越过的线：
 *   1. 绝不虚构用户的经历。示例里只能用「（这里填你的具体情况）」这类占位，
 *      绝不能写「你负责了 XX 系统，日处理 800 条」—— 那等于替用户编简历。
 *   2. 必须标清这是示例，不是标准答案。
 *   3. 优先用本地知识库的真实要点；没有要点时才退到通用模板。
 */
function buildReferenceAnswer(
  type: TrainingItemType,
  skill: string,
  requirementText: string,
  points: string[],
): string {
  const head = '（以下是示例答复，把括号里的部分换成你自己的真实情况）';
  const req = truncate(requirementText, 40);

  switch (type) {
    case 'concept':
      return [
        head,
        `「${skill}」主要解决的是：（用一句话说清它替代了什么手工流程 / 绕开了什么麻烦）。`,
        `它不适用的情况是：（举一个你判断「这里不该用它」的场景，例如数据量太小、或对实时性要求极高）。`,
        `判断依据是：（你的数据规模、延迟要求、团队现状，任选其一）。`,
      ].join('\n');
    case 'explain':
      return [
        head,
        `当时的情况：在（哪个项目 / 哪条业务线）需要解决（什么问题），当时的做法是（原来的方式或痛点）。`,
        `我做的事：具体分两步 —— 一是（做了什么），二是（做了什么）。`,
        `关键取舍：在（某个环节）上我选了（方案 A）而不是（方案 B），因为（原因，例如当时人力不够 / 延迟不允许 / 数据量还没到那个量级）。`,
        `结果：（可量化的变化；没有数字就写交付了什么、对方怎么反馈）。`,
      ].join('\n');
    case 'compare':
      return [
        head,
        `在「${skill}」这个场景里，我至少考虑过两种做法：${points[0] ?? '（写下你知道的两种做法）'}；${points[1] ?? '（另一种做法）'}。`,
        `各自的代价：前者要付出（时间 / 人力 / 复杂度），后者要付出（什么）。`,
        `我选现在这种的理由：（结合当时的约束讲，而不是讲哪个「更先进」）。`,
        `如果约束变了，我会改选：（说清什么条件出现时会切换方案）—— 这句是这道题真正想听的。`,
      ].join('\n');
    case 'scenario':
      return [
        head,
        `我会按这个顺序排查：先确认问题出在哪一层（输入 / 处理 / 输出），再（第一个动作），然后（第二个动作）。`,
        `我这么排的理由是：（为什么先查这一层，能最快排除掉什么）。`,
        `如果查到这里还没有结论，我会（转向哪个方向、需要什么额外信息）。`,
      ].join('\n');
    case 'self_check':
    default:
      return [
        head,
        `拿「${req}」这件事来说：当时的情况是（时间、场合、对方是谁、这件事为什么重要）。`,
        `我具体做的动作是：（一句话里至少有一个可观察的动作，不是「我参与了」而是「我做了 X」）。`,
        `对方的反应是：（对方原本的态度 → 我做了什么 → 对方后来的态度，这个变化过程最有说服力）。`,
        `如果重来一次，我会把（某一步）提前。`,
      ].join('\n');
  }
}

/** 没有识别出具体技能时的兜底答复骨架 */
const GENERIC_REFERENCE_ANSWER = [
  '（以下是示例答复，把括号里的部分换成你自己的真实情况）',
  '这件事发生在（时间 + 场合 + 对方是谁）。',
  '我当时负责的是（写清你个人承担的部分，而不是团队整体做的事）。',
  '我做的关键动作是：（一个可观察的具体动作）。',
  '遇到的问题是（卡点），我用了（方法）解决。',
  '结果是（可量化的变化 / 对方的反馈）。',
].join('\n');

const VALID_TYPES: TrainingItemType[] = ['concept', 'explain', 'compare', 'scenario', 'self_check'];

/**
 * 判断模型给的参考答案里有没有替用户编造经历。
 *
 * 这条检查不是形式主义。本地模板的每句话都带占位符，
 * 而模型很容易顺手写出一句「你负责了 XX 系统，日处理 800 条」——
 * 那不是参考答案，那是替用户虚构简历，而且用户很可能直接抄进自己的简历。
 *
 * 判定口径（宁可多拒）：
 *   - 出现具体数字却没有「示例 / 请替换 / 你自己」这类免责标记 → 判为编造；
 *   - 出现第一人称的完成态陈述（「我负责了」「我上线了」）→ 判为编造。
 */
function isSafeReferenceAnswer(text: string): boolean {
  const body = text.trim();
  if (body.length < 20) return false;

  const disclaimer = /(示例|参考|请替换|填入|你的情况|括号里|改成你|自行)/;
  if (!disclaimer.test(body)) {
    // 没有免责标记时，只要出现第一人称完成态就直接拒
    if (/(我负责了|我上线了|我完成了|我实现了|我搭建了|我主导了)/.test(body)) return false;
  }

  // 具体数字 + 无免责标记 = 高概率是编造
  const hasConcreteNumber = /\d{2,}/.test(body) || /(每天|每月|提升|降低|万元|倍)/.test(body);
  if (hasConcreteNumber && !disclaimer.test(body)) return false;

  return true;
}

export async function buildTrainingPlan(input: BuildTrainingInput): Promise<BuildTrainingOutput> {
  const { profile, job, matches } = input;
  const warnings: string[] = [];
  const maxItems = input.maxItems ?? 12;

  const candidates = trainingCandidates(matches, maxItems);

  if (candidates.length === 0) {
    warnings.push('这次匹配没有发现需要训练的薄弱项（缺口 / 缺少证据 / 部分满足），或者它们的重要度都是「低」。');
  }

  const items: TrainingItem[] = candidates.map(({ match, weakness }) => {
    const skill = primarySkillOf(match);
    const hasSkill = Boolean(skill);
    const def = skill ? resolveSkill(skill) : undefined;
    const knowledge = skill ? knowledgeFor(skill) : null;
    const isSoft = match.type === 'soft';
    const type = itemTypeOf(weakness, isSoft, hasSkill);
    const displayName = def?.name ?? skill ?? truncate(match.requirement, 22);

    const referencePoints: string[] = hasSkill && knowledge ? knowledge.core.slice(0, 5) : [...REQUIREMENT_REFERENCE_POINTS];
    if (type === 'explain') {
      referencePoints.unshift('按「场景 → 你做了什么 → 用什么方法 → 可量化的结果」组织，缺哪一段面试官就会追哪一段');
    }
    if (type === 'compare') {
      referencePoints.unshift('先给出两个方案的代价对比，再说你的选择依据 —— 只讲结论会被认为没想过');
    }
    if (isSoft) {
      referencePoints.unshift('用具体行为讲，不要用「沟通能力强」这类形容词');
    }

    return {
      id: newId('trn'),
      type,
      skillName: displayName,
      // 'unknown' 表示没能从这条要求里识别出具体技能，界面会据此提示「要点是通用版」
      skillCategory: hasSkill ? (def?.kind ?? 'domain') : 'unknown',
      weakness,
      requirementId: match.requirementId,
      requirementText: match.requirement,
      importance: match.importance,
      question: hasSkill
        ? buildQuestion(type, displayName, match.requirement, knowledge?.scenario)
        : buildQuestion(type, displayName, match.requirement),
      referencePoints: unique(referencePoints).slice(0, 6),
      referenceAnswer: hasSkill
        ? buildReferenceAnswer(type, displayName, match.requirement, referencePoints)
        : GENERIC_REFERENCE_ANSWER,
      referenceAnswerPoints: referencePoints.slice(0, 4),
      referenceAnswerOrigin: 'rule' as const,
      followUp: knowledge?.followUps[0],
      status: 'todo',
      updatedAt: new Date().toISOString(),
    };
  });

  let trace: AiTrace | null = null;
  let engine: TrainingPlan['engine'] = 'rule';

  if (input.gateway?.active && items.length > 0) {
    const messages: AiMessage[] = [
      { role: 'system', content: TRAINING_PLAN_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `岗位：${job.jobTitle}`,
          `候选人已有的相关能力：${profile.skills.slice(0, 40).map((s) => s.name).join('、') || '（无）'}`,
          '',
          '需要出题的要求（每条出一道）：',
          ...items.map((item) => {
            const knowledge = knowledgeFor(item.skillName);
            return [
              `- requirementId=${item.requirementId} type=${item.type} 薄弱原因=${item.weakness}`,
              `  要求原文：${item.requirementText}`,
              `  涉及技能：${item.skillName}`,
              `  答错/答不上来的原因：${item.weakness === 'gap' ? '完全没有相关经历' : item.weakness === 'lacking_evidence' ? '只有自我声明，没有可核对产出' : '有相关经历但覆盖度不足'}`,
              `  可用知识要点（只作参考，不要照抄无关内容）：${knowledge.core.slice(0, 3).join('；')}`,
            ].join('\n');
          }),
        ].join('\n'),
      },
    ];
    input.onMessages?.(messages);
    const run = await input.gateway.runJson<AiTrainingPayload>('training_plan', messages, { maxTokens: 4096 });
    trace = run.trace;

    if (run.value?.items?.length) {
      let applied = 0;
      for (const aiItem of run.value.items) {
        const target = items.find((i) => i.requirementId === aiItem.requirementId);
        if (!target) continue;
        const type = typeof aiItem.type === 'string' && VALID_TYPES.includes(aiItem.type as TrainingItemType)
          ? (aiItem.type as TrainingItemType)
          : target.type;
        const question = typeof aiItem.question === 'string' && aiItem.question.trim() ? aiItem.question.trim() : target.question;
        const referencePoints = Array.isArray(aiItem.referencePoints)
          ? aiItem.referencePoints.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).slice(0, 6)
          : [];
        target.type = type;
        target.question = question;
        // 本地知识库的要点永远保留：模型漏掉时不能把用户的自查依据清空
        target.referencePoints = unique([...referencePoints, ...target.referencePoints]).slice(0, 6);
        if (typeof aiItem.followUp === 'string' && aiItem.followUp.trim()) target.followUp = aiItem.followUp.trim();
        // v0.3：模型给的参考答案只在「没有替用户编造经历」时才采纳
        if (typeof aiItem.referenceAnswer === 'string' && aiItem.referenceAnswer.trim()) {
          if (isSafeReferenceAnswer(aiItem.referenceAnswer)) {
            target.referenceAnswer = aiItem.referenceAnswer.trim();
            target.referenceAnswerOrigin = 'ai';
          } else {
            warnings.push(`「${target.skillName}」这一题的模型参考答案里出现了编造的经历，已丢弃并改用本地模板`);
          }
        }
        applied += 1;
      }
      if (applied > 0) engine = 'hybrid';
      else warnings.push('模型返回的训练题无法与本地要求对应，已全部使用本地生成的题目');
    } else if (run.error) {
      warnings.push(`模型出题不可用，已使用本地知识库生成题目：${run.error}`);
    }
  }

  const now = new Date().toISOString();
  const stats = computePlanStats(items);
  const source: Record<TrainingWeakness, number> = {
    gap: items.filter((i) => i.weakness === 'gap').length,
    lacking_evidence: items.filter((i) => i.weakness === 'lacking_evidence').length,
    partial: items.filter((i) => i.weakness === 'partial').length,
  };

  const plan: TrainingPlan = {
    id: newId('plan'),
    schemaVersion: 1,
    profileId: profile.id,
    jobId: job.id,
    jobTitle: job.jobTitle,
    createdAt: now,
    updatedAt: now,
    items,
    stats,
    source,
    engine,
    suggestedNextStep:
      items.length === 0
        ? '当前岗位没有需要专项训练的薄弱项。可以换一个要求更高的岗位再分析一次。'
        : source.lacking_evidence > 0
          ? '先把「讲清楚」类题目答一遍 —— 这类不用新学东西，只需要把做过的讲明白，能立刻改善简历。'
          : '按顺序答完所有题目并自评；自评 0-1 分的题说明是能力缺口，建议先做最小产出再回来重答。',
  };

  return { plan, trace, warnings: unique(warnings) };
}

/** 更新单题的作答与自评，返回新的训练计划（不可变更新） */
export function answerTrainingItem(
  plan: TrainingPlan,
  itemId: string,
  patch: { userAnswer?: string; selfScore?: SelfScore; markReviewed?: boolean },
): TrainingPlan {
  const items = plan.items.map((item) => {
    if (item.id !== itemId) return item;
    const next: TrainingItem = {
      ...item,
      userAnswer: patch.userAnswer !== undefined ? patch.userAnswer : item.userAnswer,
      selfScore: patch.selfScore !== undefined ? patch.selfScore : item.selfScore,
      updatedAt: new Date().toISOString(),
    };
    if (patch.markReviewed) next.status = 'reviewed';
    else if (next.userAnswer && next.userAnswer.trim() && typeof next.selfScore === 'number') next.status = 'answered';
    else if (next.userAnswer && next.userAnswer.trim()) next.status = 'answered';
    else next.status = 'todo';
    return next;
  });

  return { ...plan, items, stats: computePlanStats(items), updatedAt: new Date().toISOString() };
}
