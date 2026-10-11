import { AiGateway } from '../ai/gateway';
import { SKILL_ASSESS_SYSTEM_PROMPT, SKILL_QUESTIONS_SYSTEM_PROMPT } from '../ai/prompts';
import type { AiMessage, AiTrace } from '../domain/ai-trace';
import type { EvidenceStrength } from '../domain/common';
import { computeEvidenceStrength, type CandidateEvidence } from '../domain/evidence';
import {
  levelFromSignals,
  levelIsSubstantive,
  levelToSelfLevel,
  selfReportScore,
  SKILL_LEVEL_LABEL,
  SKILL_LEVEL_MEANING,
  type AssessAnswer,
  type AssessSession,
  type AssessmentSignals,
  type SkillAssessment,
  type SkillLevel,
} from '../domain/interview';
import type { JobRequirement } from '../domain/job';
import type { CandidateProfile, SkillItem } from '../domain/profile';
import { DEFAULT_REVIEW_PREFERENCES, type ReviewPreferences } from '../domain/review-preferences';
import {
  ASK_SHAPE_LABEL,
  askShapeOf,
  mergeAiQuestions,
  seedsFromEvidence,
  type AskShape,
  type PlannedQuestion,
} from '../nlp/ask-planner';
import { buildQuestions, estimateMinutes } from '../nlp/skill-questions';
import { resolveSkill, textMentionsSkill } from '../nlp/skills';
import { finalizeProfile } from './profile-builder';
import { evidenceKey } from './profile-merge';
import { resolveCapabilityLevel, type CapabilityLevel } from '../domain/levels';
import { extractLinks, extractMetrics, matchDateRange } from '../parsers/resume-structure';
import { newId, truncate, unique } from '../utils/text';

/**
 * 能力问诊引擎（v0.2）
 * ====================
 *
 * 输入是一组问答，输出是三样东西：掌握程度判断、一条可加入能力库的证据、明确的待学习项。
 *
 * 两条设计底线：
 *   1. **结论必须可复算**：等级由确定性信号算出（场景具体度 / 使用深度 / 产出 / 自我认知），
 *      模型只能补充措辞，不能改变证据强度。
 *   2. **问诊证据强度封顶为「中」**：这是自述，没有外部载体。
 *      想成为「强」证据只有一条路 —— 补上链接、数字、时间。
 */

// ---------------------------------------------------------------------------
// 信号识别（确定性规则）
// ---------------------------------------------------------------------------

const SCENE_MARKERS = /(项目|系统|平台|网站|工具|脚本|应用|产品|公司|团队|部门|客户|业务方|实习|工作|上线|发布|交付|比赛|竞赛|课程设计|毕业设计|课题|论文)/;
const DEPTH_MARKERS = /(坑|问题|报错|失败|优化|权衡|取舍|替代|调优|重构|性能|对比|边界|限制|不足|局限|坑点|异常|超时|内存|并发)/;
const TRADEOFF_MARKERS = /(因为|所以|如果|为什么|原因是|代价|成本|为了|考虑到|相比之下)/;
const DELIVERABLE_MARKERS = /(上线|发布|交付|落地|部署|演示|文档|作品|仓库|报告|给别人用|给团队用|已投入使用)/;
const VAGUE_ANSWER = /^(没有|都没有|都懂|都会|不清楚|不知道|不确定|无|略|暂无|没啥|没有的|不太清楚|说不上来)[。.!！?？]*$/;
const WORK_CONTEXT = /(公司|团队|部门|客户|业务方|在职|实习|同事|生产环境|线上|甲方|老板|领导)/;
// 「做过」的表述方式很多，只认「做过/写过」会漏掉「用过 / 调过 / 负责」这类最常见的说法
const DOING_MARKERS = /(做过|写过|搭过|实现|开发|做了|构建|设计|完成|上线|部署|处理过|遇到过|负责|用过|调过|改过|修过|优化过|跑过|接过|参与|搭建|维护)/;
// 但「没用过 / 没做过」是明确否认，不能算成做过
const NOT_DONE_MARKERS = /(没有|没|未|尚未|从未|不太)[^，,。；;\n]{0,4}(用过|做过|写过|搭过|实现过|参与过|上手过)/;

function clamp03(value: number): number {
  return Math.min(3, Math.max(0, value));
}/**
 * 场景具体度 0-3。
 *
 * 口径很关键：**说出场景是硬要求，不能靠"写得长"凑分**。
 * 说「RAG 就是把文档切分后做向量检索」这种概念复述，无论多长都拿不到分 ——
 * 因为没有出现任何「你在哪用过」的事实。
 */
function specificityScore(text: string): number {
  const body = (text ?? '').trim();
  if (!body) return 0;
  let score = 0;
  if (SCENE_MARKERS.test(body)) score += 2;
  if (/\d/.test(body)) score += 1;
  if (body.length >= 20) score += 1;
  return clamp03(score);
}

/** 使用深度 0-3：有没有提到踩过的坑、做过的调整、以及为什么那样做 */
function depthScore(text: string): number {
  const body = (text ?? '').trim();
  if (!body) return 0;
  let score = 0;
  if (DEPTH_MARKERS.test(body)) score += 2;
  if (TRADEOFF_MARKERS.test(body)) score += 1;
  if (body.length >= 20) score += 1;
  return clamp03(score);
}

function answerOf(session: AssessSession, layer: AssessAnswer['layer']): AssessAnswer | undefined {
  return session.answers.find((a) => a.layer === layer);
}

export function computeSignals(session: AssessSession): AssessmentSignals {
  const self = answerOf(session, 'self_report');
  const fact = answerOf(session, 'fact');
  const depth = answerOf(session, 'depth');
  const output = answerOf(session, 'output');
  const boundary = answerOf(session, 'boundary');

  const factText = fact?.skipped ? '' : fact?.text ?? '';
  const depthText = depth?.skipped ? '' : depth?.text ?? '';
  const outputText = output?.skipped ? '' : output?.text ?? '';

  const specificity = specificityScore(factText);
  const depthValue = depthScore(depthText);

  let outputScore = 0;
  if (outputText.trim()) {
    if (extractMetrics(outputText).length > 0) outputScore += 1;
    if (extractLinks(outputText).length > 0) outputScore += 1;
    if (DELIVERABLE_MARKERS.test(outputText)) outputScore += 1;
    // 至少说了结果是什么，但没给出任何可核对载体
    if (outputScore === 0 && outputText.trim().length >= 12) outputScore += 1;
  }

  const boundaryText = boundary?.skipped ? '' : boundary?.text ?? '';
  const selfAwareness = boundaryText.trim().length >= 4 && !VAGUE_ANSWER.test(boundaryText.trim()) ? 1 : 0;

  /**
   * 明确否认「做过」时必须单独记一笔：不能让场景词把等级抬到「实际用过」。
   *
   * v0.3 两处修正：
   *   1. 只有 skipReason === 'not_done' 才算否认 —— 「想不起来」不是否认，
   *      否则用户只是记不清就会被判成「只是了解概念」，而他其实明明做过。
   *   2. **跳过的题也可能带否认信息**。用户点了「想不起来」但顺手写了一句
   *      「没用过，我压根没接触过」，这句话必须被采信 ——
   *      它比任何场景词都更能说明「这个人不会」。
   *      原实现把 skipped 题的文本整个丢掉，导致明确否认被漏判。
   */
  const allText = [factText, depthText, outputText, ...session.answers.map((a) => a.text ?? '')].join('；');
  const denial =
    NOT_DONE_MARKERS.test(factText) ||
    NOT_DONE_MARKERS.test(depthText) ||
    NOT_DONE_MARKERS.test(allText) ||
    answerOf(session, 'fact')?.skipReason === 'not_done' ||
    answerOf(session, 'depth')?.skipReason === 'not_done'
      ? 1
      : 0;

  return {
    specificity,
    depth: depthValue,
    output: clamp03(outputScore),
    selfAwareness,
    selfReport: selfReportScore(self?.choiceIndex),
    // v0.3：软技能不出自评题，这里必须如实记 false，否则等级会被凭空压低一档
    selfReportAsked: Boolean(self && !self.skipped && typeof self.choiceIndex === 'number'),
    denial,
  };
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export interface StartAssessmentInput {
  profile: CandidateProfile;
  skillName: string;
  job?: JobRequirement | null;
  /** 精简模式：只问自评 + 场景 + 产出 */
  compact?: boolean;
}

export function startAssessment(input: StartAssessmentInput): AssessSession {
  const def = resolveSkill(input.skillName);
  const skillName = def?.name ?? input.skillName;
  return {
    id: newId('assess'),
    profileId: input.profile.id,
    skillName,
    jobId: input.job?.id,
    jobTitle: input.job?.jobTitle,
    questions: buildQuestions(skillName, { compact: input.compact }),
    answers: [],
    status: 'draft',
    startedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// v0.3 追加：动态出题
// ---------------------------------------------------------------------------

export interface PlanSessionInput {
  profile: CandidateProfile;
  skillName: string;
  job?: JobRequirement | null;
  compact?: boolean;
  gateway?: AiGateway | null;
  onMessages?: (messages: AiMessage[]) => void;
}

export interface PlanSessionOutput {
  questions: AssessSession['questions'];
  /** 出题来源：模型按该能力的真实分水岭出的，或本地规则 */
  origin: 'ai' | 'rule';
  /** 这项能力被判定为哪一种形状，界面要显示，因为它决定了「为什么没问自评」 */
  shape: AskShape;
  shapeLabel: string;
  /** 从档案里抽出来的候选回答数 */
  suggestionCount: number;
  trace: AiTrace | null;
  warnings: string[];
}

interface AiQuestionsPayload {
  questions?: PlannedQuestion[];
}

/**
 * 建立一次问诊会话（v0.3 主入口）。
 *
 * 相比原来的 `startAssessment()`，这里多做三件事：
 *   1. 按能力形状分流 —— 软技能不再问「属于了解还是熟悉」；
 *   2. 有模型时让模型按这项能力的分水岭重写题面；
 *   3. 从档案里已有的证据抽候选回答，让用户点选而不是凭空回忆。
 *
 * 三者都只影响「怎么问」，不影响「怎么判」——
 * 判定仍然是 computeSignals() + levelFromSignals() 的本地纯函数。
 */
export async function planAssessmentSession(input: PlanSessionInput): Promise<PlanSessionOutput> {
  const warnings: string[] = [];
  const def = resolveSkill(input.skillName);
  const skillName = def?.name ?? input.skillName;
  const shape = askShapeOf(skillName, def?.kind ?? skillKindHint(input.skillName));
  const shapeLabel = ASK_SHAPE_LABEL[shape];

  // ---- 1. 从已有证据抽候选 ----
  const seeds = seedsFromEvidence(
    input.profile.evidence.map((e) => ({ id: e.id, title: e.title, content: e.content, skills: e.skills })),
    skillName,
    shape,
  );

  // ---- 2. 本地出题（一定是有效的兜底） ----
  let questions = buildQuestions(skillName, { compact: input.compact, origin: 'rule' });

  // ---- 3. 模型重写题面（可选） ----
  let origin: 'ai' | 'rule' = 'rule';
  let trace: AiTrace | null = null;

  if (input.gateway?.active) {
    const knownFacts = input.profile.evidence
      .filter((e) => e.skills.includes(skillName) || textMentionsSkill(skillName, e.content))
      .slice(0, 5)
      .map((e) => `- ${truncate(e.content, 80)}`);

    const messages: AiMessage[] = [
      { role: 'system', content: SKILL_QUESTIONS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `能力名称：${skillName}`,
          `能力形状：${shape}（${shapeLabel}）`,
          shape === 'behavioral' ? '注意：这项能力不能问掌握程度等级，只能问最近发生的具体事例。' : '',
          input.job?.jobTitle ? `目标岗位：${input.job.jobTitle}` : '',
          '',
          '用户档案里已经写过的相关事实（不要重复问同一件事）：',
          ...(knownFacts.length > 0 ? knownFacts : ['（暂无）']),
          '',
          `本地规则为这项能力准备了 ${questions.length} 道题，层分别是：${questions.map((q) => q.layer).join('、')}。`,
          '请为每一个层重新写一道更贴合这项能力分水岭的题，层的数量与顺序必须保持一致。',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];

    input.onMessages?.(messages);
    const run = await input.gateway.runJson<AiQuestionsPayload>('skill_questions', messages, { maxTokens: 1024 });
    trace = run.trace;

    if (run.value?.questions?.length) {
      const merged = mergeAiQuestions(
        questions.map((q) => ({ layer: q.layer, prompt: q.prompt, hint: q.hint, critical: q.critical })),
        run.value.questions,
        shape,
      );
      if (merged.accepted > 0) {
        const overrides: Record<string, string> = {};
        for (let i = 0; i < questions.length; i += 1) {
          const before = questions[i];
          const after = merged.specs.find((s) => s.layer === before.layer);
          if (after && after.prompt !== before.prompt) overrides[before.layer] = after.prompt;
        }
        questions = buildQuestions(skillName, { compact: input.compact, origin: 'ai', overrides });
        origin = 'ai';
      }
      warnings.push(...merged.rejected);
      if (merged.accepted < questions.length) {
        warnings.push(`模型只重写了 ${merged.accepted}/${questions.length} 道题，其余保持本地题面`);
      }
    } else if (run.error) {
      warnings.push(`动态出题不可用，已使用本地题库出题：${run.error}`);
    }
  }

  // ---- 4. 把候选回答挂到最需要它的那道题上 ----
  questions = attachSuggestions(questions, seeds);

  return {
    questions,
    origin,
    shape,
    shapeLabel,
    suggestionCount: seeds.length,
    trace,
    warnings: unique(warnings),
  };
}

/** 本地没有 kind 提示时，用软技能关键词兜底判断形状 */
function skillKindHint(skillName: string): string | undefined {
  return resolveSkill(skillName)?.kind;
}

/**
 * 候选回答挂载策略。
 *
 * 只挂到 `fact` 层（具体场景）与 `output` 层（结果）：
 * 这两层是产出证据的必要条件，挂了才可能升级证据强度。
 * 挂在 depth / boundary 上没有意义 —— 深度和边界只能用户自己想。
 */
function attachSuggestions(
  questions: AssessSession['questions'],
  seeds: ReturnType<typeof seedsFromEvidence>,
): AssessSession['questions'] {
  if (seeds.length === 0) return questions;
  return questions.map((q) => {
    if (q.layer !== 'fact' && q.layer !== 'output') return q;
    // fact 层挂全部候选；output 层只挂第一个，避免用户被选项淹没
    const list = q.layer === 'fact' ? seeds : seeds.slice(0, 1);
    return {
      ...q,
      suggestions: list.map((s) => ({
        label: s.label,
        draft: s.draft,
        fromEvidenceId: s.evidenceId,
        fromEvidenceTitle: s.evidenceTitle,
      })),
      origin: 'evidence' as const,
    };
  });
}

export function estimateSessionMinutes(session: AssessSession): number {
  return estimateMinutes(session.questions);
}

export interface AnswerInput {
  questionId: string;
  text?: string;
  choiceIndex?: number;
  skipped?: boolean;
  /** v0.3：区分「明确否认做过」与「只是想不起来」 */
  skipReason?: 'not_done' | 'cant_recall';
}

export function recordAnswer(session: AssessSession, input: AnswerInput): AssessSession {
  const question = session.questions.find((q) => q.id === input.questionId);
  if (!question) return session;
  // v0.3：跳过时用户可能顺手写了一句限定（例如「没用过，我压根没接触」）。
  // 界面上的两个跳过按钮都不弹输入框，所以这里保留文本是防御性的 ——
  // 但一旦有文本，就必须留着：它是比任何关键词都直接的否认信号。
  const answer: AssessAnswer = {
    questionId: question.id,
    layer: question.layer,
    choiceIndex: input.choiceIndex,
    text: (input.text ?? '').trim(),
    answeredAt: new Date().toISOString(),
    skipped: input.skipped,
    skipReason: input.skipReason,
  };
  const answers = [...session.answers.filter((a) => a.questionId !== question.id), answer];
  const answeredAll = session.questions.every((q) => answers.some((a) => a.questionId === q.id));
  // 答案已经落到 answers 里，草稿就没用了 —— 不清掉的话下次进来会看到
  // 「这一题你已经答了，但输入框里还留着上一段文字」的怪状态
  return { ...session, answers, status: answeredAll ? 'completed' : 'draft', draft: undefined };
}

/** 记录草稿（不提交）。切页时靠它保住正在写的那一题。 */
export function recordDraft(session: AssessSession, draft: AssessSession['draft']): AssessSession {
  if (!draft) return session;
  return { ...session, draft };
}

/** 清掉草稿（「下一题」/ 放弃时用） */
export function clearDraft(session: AssessSession): AssessSession {
  if (!session.draft) return session;
  return { ...session, draft: undefined };
}

/**
 * 换一套未答的题 —— **保留已答的题与答案**。
 *
 * v0.6 之前这里叫 `replanAssess`，UI 上的文案是「换一套问题」，
 * 实际实现是调 `startAssess` 重开一个会话，于是**已答的全部题目被清空**。
 * 这是全项目唯一一处「用户点一个看起来无害的按钮就丢数据」的地方，
 * 而它恰好在答题页顶部最容易点到。
 *
 * 现在的行为：
 *   - 已答的题与答案原样保留（它们已经产生了信息，不能因为换题而消失）
 *   - 只对**未答的题**换一批新的
 *   - 被换掉的题存进 `replacedQuestions`，界面上要能看见「这题你不用再答了」
 *   - 新题库也用完了 → 明确告知，而不是静默什么都不发生
 *
 * 换不到新题时返回 `null`，让界面如实说「没有更多题可以换了」。
 */
export function replanQuestions(
  session: AssessSession,
  options: { max?: number; profile?: CandidateProfile; compact?: boolean } = {},
): AssessSession | null {
  const max = options.max ?? session.questions.length;
  const answeredIds = new Set(session.answers.map((a) => a.questionId));
  const pending = session.questions.filter((q) => !answeredIds.has(q.id));

  // 全部答完就没有「换题」这件事了
  if (pending.length === 0) return null;

  const def = resolveSkill(session.skillName);
  const skillName = def?.name ?? session.skillName;
  const shape = askShapeOf(skillName, def?.kind ?? skillKindHint(session.skillName));

  // 仍然挂上档案候选，让换题后的题目一样能从用户写过的东西里挑
  const seeds = options.profile
    ? seedsFromEvidence(
        options.profile.evidence.map((e) => ({ id: e.id, title: e.title, content: e.content, skills: e.skills })),
        skillName,
        shape,
      )
    : [];

  const fresh = buildQuestions(skillName, { compact: options.compact, origin: 'rule' })
    .filter((q) => !answeredIds.has(q.id) && !session.replacedQuestions?.some((r) => r.id === q.id))
    .slice(0, max);

  if (fresh.length === 0) return null;

  const replaced: AssessSession['replacedQuestions'] = [...(session.replacedQuestions ?? []), ...pending];
  return {
    ...session,
    questions: [...session.questions.filter((q) => answeredIds.has(q.id)), ...attachSuggestions(fresh, seeds)],
    replacedQuestions: replaced,
    draft: undefined,
    status: 'draft',
  };
}

/** 当前应该回答哪一题（UI 用它做单题流式问答） */
export function nextQuestion(session: AssessSession): { question: AssessSession['questions'][number]; index: number } | null {
  for (let i = 0; i < session.questions.length; i += 1) {
    const q = session.questions[i];
    if (!session.answers.some((a) => a.questionId === q.id)) return { question: q, index: i };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 证据转化
// ---------------------------------------------------------------------------

export interface DerivedEvidence {
  evidence: CandidateEvidence | null;
  /** 为什么没有产出证据（要给用户看的原因，不能静默失败） */
  skippedReason?: string;
}

/**
 * 把问诊回答转成一条证据。
 *
 * 产出证据的两个必要条件：
 *   1. 说清了具体场景（出现项目 / 公司 / 工具 / 上线 这类场景词）
 *   2. 提到了自己实际做过的事（做过 / 写过 / 实现过 …）
 * 任一不满足就返回 null 并说明原因 —— 比起造一条空证据污染能力库，不如让用户知道差在哪。
 */
export function deriveEvidenceFromSession(session: AssessSession): DerivedEvidence {
  const fact = answerOf(session, 'fact');
  const depth = answerOf(session, 'depth');
  const output = answerOf(session, 'output');
  const parts = [fact?.skipped ? '' : fact?.text, depth?.skipped ? '' : depth?.text, output?.skipped ? '' : output?.text]
    .map((t) => (t ?? '').trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return { evidence: null, skippedReason: '这次问诊没有写下具体内容，因此没有产生证据。' };
  }

  const combined = parts.join('；');

  // 场景是硬要求：光复述概念不构成证据
  if (!SCENE_MARKERS.test(combined)) {
    return {
      evidence: null,
      skippedReason: '你还没有说清「在什么场景下用过它」，所以无法生成证据。补上场景（哪个项目、做什么事）就能生成。',
    };
  }
  if (NOT_DONE_MARKERS.test(combined)) {
    return {
      evidence: null,
      skippedReason: '你的回答里明确说了「没有做过」，所以不能生成证据。如果确实还没上手，建议把它放进「待学习」。',
    };
  }
  if (!DOING_MARKERS.test(combined)) {
    return {
      evidence: null,
      skippedReason: '描述里没有出现你实际做过的事（例如「做过/用过/负责/实现过」）。如果只是了解原理，建议放到「待学习」。',
    };
  }

  const isWorkContext = WORK_CONTEXT.test(combined);
  const kind: CandidateEvidence['kind'] = isWorkContext ? 'work' : 'project';

  const metrics = extractMetrics(combined);
  const links = extractLinks(combined);
  const timeRange = matchDateRange(combined);
  const content = [
    `场景：${fact?.text?.trim() ?? '（未填写）'}`,
    depth?.text?.trim() ? `做法与遇到的问题：${depth.text.trim()}` : '',
    output?.text?.trim() ? `结果：${output.text.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const computed = computeEvidenceStrength({
    kind,
    content,
    metrics,
    links,
    hasTimeRange: Boolean(timeRange),
    origin: 'qa',
  });

  const now = new Date().toISOString();
  return {
    evidence: {
      id: newId('evd'),
      kind,
      title: `${session.skillName} · 问诊补充`,
      content,
      skills: [session.skillName],
      metrics,
      links,
      timeRange,
      strength: computed.strength,
      strengthReason: computed.reason,
      origin: 'qa',
      fromJobTitle: session.jobTitle,
      sourceRef: {
        kind: 'user',
        locator: '能力问诊（自述）',
        excerpt: truncate(combined, 140),
      },
      editedByUser: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

// ---------------------------------------------------------------------------
// 评估
// ---------------------------------------------------------------------------
/**
 * 合并一条新产出的问诊证据。
 *
 * 复用 `profile-merge.ts` 的 `evidenceKey`（kind + 归一化标题 + 内容前 60 字）——
 * 之前这里���是裸数组拼接，导致「同一个技能问三次」在档案里留下三条一模一样的证据。
 * 这不只是难看：档案页的「N 条证据」会被撑大，匹配引擎也会把它们当成三条独立支撑。
 *
 * 原写法保留在下方 `_deprecated` 注释里，便于日后核对口径。
 */
function mergeQaEvidence(
  existing: CandidateEvidence[],
  incoming: CandidateEvidence | null,
): CandidateEvidence[] {
  if (!incoming) return existing;
  const key = evidenceKey(incoming);
  const hit = existing.findIndex((e) => evidenceKey(e) === key);
  if (hit < 0) return [...existing, incoming];
  // 保留旧那条（id 被技能 evidenceIds 引用着，换 id 会让引用失效），只更新内容
  const next = existing.slice();
  next[hit] = { ...next[hit], content: incoming.content, updatedAt: incoming.updatedAt };
  return next;
}

/** _deprecated：v0.6 之前的写法（裸拼接），保留留痕勿删
 * const evidence = derived.evidence ? [...profile.evidence, derived.evidence] : profile.evidence;
 */
function unusedEvidenceKeyMarker() {
  return evidenceKey;
}

export interface EvaluateInput {
  session: AssessSession;
  profile: CandidateProfile;
  gateway?: AiGateway | null;
  onMessages?: (messages: AiMessage[]) => void;
}

export interface EvaluateOutput {
  assessment: SkillAssessment;
  /** 新产出的证据（null 表示这次没有产出） */
  evidence: CandidateEvidence | null;
  /** 已经并入证据与评估结论、并重新归一化过的档案 */
  updatedProfile: CandidateProfile;
  trace: AiTrace | null;
  warnings: string[];
  /**
   * v0.6：这次问诊之前的样子。
   *
   * 为什么必须显式存下来：`SkillAssessment` 是**覆盖式**写入的
   * （去重键是 skillName，后一次覆盖前一次），所以评估完成之后再回头查，
   * 旧等级已经找不回来了 —— 于是界面上没法回答「这次问诊到底改了什么」，
   * 用户只能自己跑去档案页逐条对比。before/after 对比视图依赖这个字段。
   */
  before: AssessmentSnapshot;
}

/** 档案里某项能力的「当前样子」，用于 before/after 对比 */
export interface AssessmentSnapshot {
  /** 之前有没有问过这个技能 */
  existed: boolean;
  /** 之前的综合能力等级（证据与问诊取较低者），之前没有任何数据时为 'unverified' */
  level: CapabilityLevel;
  /** 之前的自评等级 */
  selfLevel: SkillItem['selfLevel'];
  /** 之前挂在该技能上的证据条数 */
  evidenceCount: number;
  /** 之前的问诊结论摘要 */
  summary?: string;
}

function buildSummary(level: SkillLevel, skillName: string, signals: AssessmentSignals): string {
  const head = `「${skillName}」的掌握程度：${SKILL_LEVEL_LABEL[level]}。`;
  const bits: string[] = [];
  if (signals.specificity === 0) bits.push('没有说清使用场景');
  if (signals.depth === 0) bits.push('没有提到实现细节或踩过的坑');
  if (signals.output === 0) bits.push('没有给出结果或可核对载体');
  return bits.length > 0 ? `${head}${bits.join('；')}。` : head;
}

function buildRecommendation(level: SkillLevel, skillName: string, signals: AssessmentSignals): string {
  switch (level) {
    case 'unverified':
    case 'aware':
      return `先不要写进简历。花半天时间用「${skillName}」做一个小而完整的东西（能跑、能演示），做完再来问诊一次。`;
    case 'practiced':
      return '把「跟着教程做」升级成「自己定需求自己做」：脱离教程改一个功能，或者解决教程里没覆盖的问题。';
    case 'applied':
      return signals.output === 0
        ? '你已经能说清做法，现在缺的是结果。把这件事的产出量化或留下链接（代码仓库、线上地址、文档），强度就能从「中」升到「强」。'
        : '把这段描述按「场景 → 做法 → 结果」写进简历，排在靠前的位置。';
    case 'delivered':
      return '这条可以写进简历并放在前面。面试前准备两个追问的答案：换一种做法会怎样、当时为什么这样选。';
    case 'expert':
      return '准备把它作为主打能力来写，并在面试中主动讲取舍 —— 能讲清边界比堆功能更有说服力。';
    default:
      return '补充更多具体细节后可以再做一次问诊。';
  }
}

function buildGaps(signals: AssessmentSignals, evidenceCreated: boolean): string[] {
  const gaps: string[] = [];
  if (signals.denial >= 1) gaps.push('你自己说了还没有实际做过，所以这次不会生成证据');
  if (signals.specificity === 0) gaps.push('没有说清使用场景');
  else if (signals.depth === 0) gaps.push('没有提到具体做法或踩过的坑');
  if (signals.output === 0) gaps.push('没有给出结果或可核对载体（数字 / 链接 / 交付物）');
  if (signals.selfAwareness === 0) gaps.push('没有说出自己不确定的部分 —— 面试官容易在这里继续追问');
  if (!evidenceCreated) gaps.push('本次没有生成证据，能力库里不会新增条目');
  return gaps;
}

interface AiAssessPayload {
  level?: string;
  summary?: string;
  strengths?: string[];
  gaps?: string[];
  uncertainties?: string[];
  recommendedAction?: string;
}

const VALID_LEVELS: SkillLevel[] = ['unverified', 'aware', 'practiced', 'applied', 'delivered', 'expert'];

export async function evaluateAssessment(input: EvaluateInput): Promise<EvaluateOutput> {
  const { session, profile } = input;
  const warnings: string[] = [];
  const signals = computeSignals(session);
  const localLevel = levelFromSignals(signals);
  const derived = deriveEvidenceFromSession(session);

  const boundary = answerOf(session, 'boundary');
  const uncertainties =
    boundary && !boundary.skipped && boundary.text.trim() && !VAGUE_ANSWER.test(boundary.text.trim())
      ? boundary.text
          .split(/[；;。\n、,，]/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2 && t.length <= 24)
          .slice(0, 4)
      : [];

  let level: SkillLevel = localLevel;
  let summary = buildSummary(localLevel, session.skillName, signals);
  let strengths: string[] = [];
  let gaps = buildGaps(signals, Boolean(derived.evidence));
  let recommendedAction = buildRecommendation(localLevel, session.skillName, signals);
  let engine: SkillAssessment['engine'] = 'rule';
  let trace: AiTrace | null = null;
  // 模型是否接管了措辞。如果接管了就不再用本地文案覆盖，否则在等级被闸门调整后要重建文案
  let summaryFromAi = false;
  let actionFromAi = false;

  const strengthsFromSignals: string[] = [];
  if (signals.specificity >= 1) strengthsFromSignals.push('能说清具体的使用场景');
  if (signals.depth >= 1) strengthsFromSignals.push('能说出实现细节或遇到的问题');
  if (signals.output >= 1) strengthsFromSignals.push('能给出结果或可核对载体');
  if (signals.selfAwareness >= 1) strengthsFromSignals.push('清楚自己的能力边界');
  strengths = strengthsFromSignals;

  if (input.gateway?.active) {
    const messages: AiMessage[] = [
      { role: 'system', content: SKILL_ASSESS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `技能：${session.skillName}`,
          session.jobTitle ? `目标岗位：${session.jobTitle}` : '',
          '',
          '问答记录：',
          ...session.questions.map((q) => {
            const a = session.answers.find((x) => x.questionId === q.id);
            const value = a?.skipped
              ? '（用户表示不会，已跳过）'
              : q.kind === 'choice'
                ? `（选择）${typeof a?.choiceIndex === 'number' ? q.options?.[a.choiceIndex] ?? '未选' : '未答'}`
                : a?.text || '（未填写）';
            return `Q[${q.layer}] ${q.prompt}\nA: ${value}`;
          }),
          '',
          `本地规则算出的信号：场景具体度 ${signals.specificity}/3，使用深度 ${signals.depth}/3，产出 ${signals.output}/3，自我认知 ${signals.selfAwareness}/1。`,
          signals.selfReportAsked
            ? `本地规则给出的等级是 ${localLevel}（${SKILL_LEVEL_LABEL[localLevel]}）。如果你认为不一致，请给出理由充分的等级。`
            : `这次没有问自评题（该项能力不适合用熟练度阶梯衡量），本地规则给出的等级是 ${localLevel}（${SKILL_LEVEL_LABEL[localLevel]}）。不要因为缺少自评而下调等级。`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];
    input.onMessages?.(messages);
    const run = await input.gateway.runJson<AiAssessPayload>('skill_assessment', messages, { maxTokens: 1536 });
    trace = run.trace;
    if (run.value) {
      const aiLevel = typeof run.value.level === 'string' && VALID_LEVELS.includes(run.value.level as SkillLevel)
        ? (run.value.level as SkillLevel)
        : null;
      // 模型不能把等级抬到「有产出」以上：那需要真实的结果或链接，由本地证据强度决定
      if (aiLevel) {
        const capIndex = signals.output >= 1 ? VALID_LEVELS.length - 1 : VALID_LEVELS.indexOf('applied');
        const aiIndex = VALID_LEVELS.indexOf(aiLevel);
        level = aiIndex > capIndex ? VALID_LEVELS[Math.max(capIndex, 0)] : aiLevel;
        if (aiIndex > capIndex) warnings.push('模型给出的等级高于本地证据能支撑的档位，已按规则下调');
      }
      if (typeof run.value.summary === 'string' && run.value.summary.trim()) {
        summary = run.value.summary.trim();
        summaryFromAi = true;
      }
      if (Array.isArray(run.value.strengths) && run.value.strengths.length > 0) {
        strengths = run.value.strengths.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
      }
      if (Array.isArray(run.value.gaps) && run.value.gaps.length > 0) {
        gaps = run.value.gaps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
      }
      if (Array.isArray(run.value.uncertainties) && run.value.uncertainties.length > 0) {
        uncertainties.splice(
          0,
          uncertainties.length,
          ...run.value.uncertainties.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 4),
        );
      }
      if (typeof run.value.recommendedAction === 'string' && run.value.recommendedAction.trim()) {
        recommendedAction = run.value.recommendedAction.trim();
        actionFromAi = true;
      }
      engine = 'hybrid';
    } else if (run.error) {
      warnings.push(`模型评估不可用，已使用本地规则引擎：${run.error}`);
    }
  }

  const def = resolveSkill(session.skillName);

  // v0.6 证据去重：原来是裸数组拼接，于是同一个技能问 N 次就会堆 N 条
  // title 完全相同的 qa 证据，虚高 qaEvidenceCount。问诊证据走
  // 与简历导入同一条去重键（kind|title|content 前 60 字），
  // 同一条经历只留一份，不同经历才会并存。
  const evidence = mergeQaEvidence(profile.evidence, derived.evidence);

  // ---- 等级闸门：单次问诊不能把技能判成「可讲清取舍」 ----
  // 「能讲清取舍」的前提是多场景使用，这一点不可能从一次问答里得到。
  // 允许例外：能力库里已经有这个技能的项目/工作/开源类证据（说明确实做过）。
  if (level === 'expert') {
    const priorRealEvidence = profile.evidence.some(
      (e) =>
        e.origin !== 'qa' &&
        (e.kind === 'project' || e.kind === 'work' || e.kind === 'open_source') &&
        (e.skills.includes(session.skillName) || textMentionsSkill(session.skillName, e.content)),
    );
    if (!priorRealEvidence) {
      level = 'delivered';
      warnings.push('单次问诊不足以判断「能讲清取舍」（那需要多场景使用），已按「有产出」计；如果你确实在多个项目里用过它，把它补进档案后会重新判定。');
    }
  }

  // 等级被闸门调整过之后，本地文案必须跟着重算 ——
  // 否则会出现「等级显示有产出、正文却说可讲清取舍」这种自相矛盾
  if (!summaryFromAi) summary = buildSummary(level, session.skillName, signals);
  if (!actionFromAi) recommendedAction = buildRecommendation(level, session.skillName, signals);

  const assessment: SkillAssessment = {
    id: newId('asm'),
    profileId: profile.id,
    skillName: session.skillName,
    skillCategory: def?.kind ?? 'domain',
    jobId: session.jobId,
    jobTitle: session.jobTitle,
    sessionId: session.id,
    level,
    confidence: signals.specificity >= 2 && signals.output >= 1 ? 'high' : signals.specificity >= 1 ? 'medium' : 'low',
    signals,
    summary: `${summary}${strengths.length === 0 ? '' : ''} ${SKILL_LEVEL_MEANING[level]}`.trim(),
    strengths,
    gaps,
    uncertainties,
    producedEvidenceIds: derived.evidence ? [derived.evidence.id] : [],
    recommendedAction,
    learnNext: uncertainties.length > 0 ? [session.skillName] : [],
    createdAt: new Date().toISOString(),
    engine,
  };

  // ---- 并入能力库（跨岗位保留：只增量，不覆盖既有证据与技能） ----
  // v0.6：先取 before 快照。必须在写档案之前取 —— 结论是覆盖式写入的，
  // 写完就再也回不到旧状态了。
  const before: AssessmentSnapshot = (() => {
    const prevAssessment = (profile.assessments ?? []).find((a) => a.skillName === session.skillName);
    const prevSkill = profile.skills.find((s) => s.name === session.skillName);
    const prevEvidenceIds = prevSkill?.evidenceIds ?? [];
    return {
      existed: Boolean(prevAssessment),
      level: resolveCapabilityLevel(prevSkill?.derivedStrength ?? 'none', prevAssessment?.level ?? null).level,
      selfLevel: prevSkill?.selfLevel ?? '未声明',
      evidenceCount: prevEvidenceIds.length,
      summary: prevAssessment?.summary,
    };
  })();

  const existingSkillIndex = profile.skills.findIndex((s) => s.name === session.skillName);
  const skills: SkillItem[] = profile.skills.slice();
  const nextSelfLevel = levelToSelfLevel(level);
  if (existingSkillIndex >= 0) {
    const current = skills[existingSkillIndex];
    // 只在问诊结论更强时提升自评等级，不因为一次问诊答得差就下调用户原本的声明
    const rank: Record<string, number> = { 未声明: 0, 了解: 1, 熟悉: 2, 熟练: 3, 精通: 4 };
    const merged = (rank[nextSelfLevel] ?? 0) > (rank[current.selfLevel] ?? 0) ? nextSelfLevel : current.selfLevel;
    skills[existingSkillIndex] = { ...current, selfLevel: merged, aliases: resolveSkill(session.skillName)?.aliases ?? current.aliases };
  } else {
    skills.push({
      id: newId('skl'),
      name: session.skillName,
      aliases: resolveSkill(session.skillName)?.aliases ?? [],
      category: def?.kind ?? 'domain',
      selfLevel: nextSelfLevel,
      evidenceIds: [],
      derivedStrength: 'none' as EvidenceStrength,
    });
  }

  const assessments = [...(profile.assessments ?? []).filter((a) => a.skillName !== session.skillName), assessment];

  const updatedProfile = finalizeProfile({
    ...profile,
    skills,
    assessments,
    evidence,
    updatedAt: new Date().toISOString(),
  });

  if (derived.skippedReason) warnings.push(derived.skippedReason);
  if (!levelIsSubstantive(level)) {
    warnings.push(`当前等级是「${SKILL_LEVEL_LABEL[level]}」，建议只放进「待学习」，暂时不要写进简历。`);
  }

  return { assessment, evidence: derived.evidence, updatedProfile, trace, warnings: unique(warnings), before };
}

// ---------------------------------------------------------------------------
// 「该问哪些技能」
// ---------------------------------------------------------------------------

export interface PendingSkill {
  skillName: string;
  reason: string;
  /** 优先级，越小越该先问 */
  priority: number;
  /** 来自岗位要求的条数 */
  requirementCount: number;
  importance: 'high' | 'medium' | 'low';
  /**
   * v0.6：这个技能现在是什么状态。
   *
   * 原来这里只有一个 `assessed: boolean`，而它**只被当成排序权重**（priority +100），
   * 从来没有用于过滤 —— 于是用户问过的技能照样出现在「建议先问这些」里，
   * 旁边还挂着一个可点的「开始问诊」。数据没丢，但观感是「要求你重填一遍」。
   *
   * 拆成三态是因为它们该给的动作不同：
   *   fresh      从没问过        → 该问
   *   assessed   问过且结论还在   → **不该再出现在可点列表里**，只该展示结论
   *   stale      问过但已过时     → 该问，但必须说清「你上次答的是 X」
   */
  state: 'fresh' | 'assessed' | 'stale';
  /** state === 'stale' 时，上次结论里记下的等级 */
  previousLevel?: string;
  /** state === 'stale' 时，为什么判定为过时（要直接展示给用户，不能只写「过时了」） */
  staleReason?: string;
}

/** 用户主动标记「这条结论我想重答」时，档案上打的戳 */
export interface StaleMark {
  skillName: string;
  reason: string;
  createdAt: string;
}

/**
 * 判断一条已有结论现在算不算「仍在生效」。
 *
 * 判定口径由用户在设置页决定（ReviewPreferences.stalePolicy），这里只负责执行。
 * 之所以不写死成「90 天」：三个月前答得不好，不代表现在想改口；
 * 三个月前答得很好，也不代表能力退化了。时间线只能当提醒，不能当判据。
 */
export function assessFreshness(
  assessment: { skillName: string; createdAt: string } | undefined,
  job: JobRequirement | null,
  mark: StaleMark | undefined,
  prefs: ReviewPreferences = DEFAULT_REVIEW_PREFERENCES,
  now = new Date(),
): { fresh: boolean; reason?: string } {
  if (!assessment) return { fresh: false };

  // 用户主动标过想重答 —— 这是最强的一条信号，任何策略下都算过时
  if (mark) return { fresh: false, reason: `你自己标了想重答：${mark.reason}` };

  if (prefs.stalePolicy === 'never') return { fresh: true };

  // 事实维度：这个技能的岗位要求还在吗？要求变了说明上下文变了
  if (job) {
    const stillRequired = (job.items ?? []).some((item) => item.keywords.some((k) => {
      const def = resolveSkill(k);
      return def ? def.name === assessment.skillName : k === assessment.skillName;
    }));
    if (!stillRequired) {
      return { fresh: false, reason: '当前岗位的要求里已经不再提这项了' };
    }
  }

  if (prefs.stalePolicy === 'by_change_and_age') {
    const days = Math.floor((now.getTime() - new Date(assessment.createdAt).getTime()) / 86_400_000);
    if (Number.isFinite(days) && days > prefs.staleAfterDays) {
      return { fresh: false, reason: `这条结论是 ${days} 天前做的，要不要再确认一次` };
    }
  }

  return { fresh: true };
}

/**
 * 推荐问诊顺序。
 *
 * 排序依据：岗位高重要度要求里「系统判不了」的能力优先 —— 即
 * 没有证据的（gap）> 只有自我声明的（lacking_evidence）> 已有证据的（不必问）。
 *
 * v0.6 起**只返回该问的**：已问过且结论仍生效的技能会被移出列表，
 * 改由 `assessedSkillsFor()` 提供只读展示。这样推荐列表里的每一项都是真能推进的。
 */
export function pendingSkillsFor(
  profile: CandidateProfile,
  job: JobRequirement | null,
  options: {
    prefs?: ReviewPreferences;
    marks?: StaleMark[];
    now?: Date;
  } = {},
): PendingSkill[] {
  const prefs = options.prefs ?? DEFAULT_REVIEW_PREFERENCES;
  const now = options.now ?? new Date();
  const markMap = new Map((options.marks ?? []).map((m) => [m.skillName, m]));

  const assessments = profile.assessments ?? [];
  const assessmentMap = new Map(assessments.map((a) => [a.skillName, a]));

  const map = new Map<string, { count: number; importance: 'high' | 'medium' | 'low'; hasEvidence: boolean }>();
  const importanceRank = { high: 0, medium: 1, low: 2 } as const;

  const consider = (skillName: string) => {
    const def = resolveSkill(skillName);
    if (!def) return;
    const name = def.name;
    const evidence = profile.evidence.filter(
      (e) => e.skills.includes(name) || textMentionsSkill(name, e.content) || textMentionsSkill(name, e.title),
    );
    const hasEvidence = evidence.length > 0;
    const current = map.get(name) ?? { count: 0, importance: 'low' as const, hasEvidence };
    map.set(name, { ...current, hasEvidence });
  };

  for (const item of job?.items ?? []) {
    if (item.type === 'soft' || item.type === 'implicit') continue;
    for (const keyword of item.keywords) {
      const def = resolveSkill(keyword);
      if (!def) continue;
      consider(def.name);
      const current = map.get(def.name);
      if (!current) continue;
      map.set(def.name, {
        ...current,
        count: current.count + 1,
        importance: importanceRank[item.importance] < importanceRank[current.importance] ? item.importance : current.importance,
      });
    }
  }

  // 没有岗位时，退化为「档案里只有自我声明（或完全没有证据）的技能」
  if (map.size === 0) {
    for (const skill of profile.skills) {
      const linked = profile.evidence.filter((e) => skill.evidenceIds.includes(e.id));
      const onlySelfClaim = linked.length === 0 || linked.every((e) => e.kind === 'self_claim');
      if (onlySelfClaim) {
        map.set(skill.name, {
          count: 0,
          importance: 'medium',
          hasEvidence: linked.length > 0,
        });
      }
    }
  }

  return Array.from(map.entries())
    .map(([skillName, info]) => {
      const assessment = assessmentMap.get(skillName);
      const freshness = assessFreshness(assessment, job, markMap.get(skillName), prefs, now);
      const state: PendingSkill['state'] = !assessment ? 'fresh' : freshness.fresh ? 'assessed' : 'stale';
      const staleWhy = freshness.reason ?? '情况变了';

      const priority = (info.hasEvidence ? 20 : 0) + importanceRank[info.importance] * 5 + (info.count > 0 ? 0 : 3);
      const why =
        state === 'stale'
          ? `上次问过，但${staleWhy} —— 这次可以重答一次`
          : info.hasEvidence
            ? '已有部分证据，问诊可以把掌握程度说清楚，顺便补强证据'
            : '岗位要求提到它，但你的能力库里没有对应证据 —— 这正是最该先问的';

      return {
        skillName,
        reason: why,
        priority,
        requirementCount: info.count,
        importance: info.importance,
        state,
        previousLevel: state === 'stale' && assessment ? SKILL_LEVEL_LABEL[assessment.level] : undefined,
        staleReason: state === 'stale' ? staleWhy : undefined,
      };
    })
    // 已问过且结论仍然生效的，直接不进列表 —— 它们由 assessedSkillsFor() 负责展示
    .filter((row) => row.state !== 'assessed')
    .sort((a, b) => a.priority - b.priority || b.requirementCount - a.requirementCount)
    .slice(0, 12);
}

/**
 * 已问过且结论仍然生效的技能（只读展示用）。
 *
 * v0.6 新增：以前这些技能只是被 `pendingSkillsFor` 排到列表末尾，
 * 用户看到的仍是一个可点的「开始问诊」。现在它们走这个出口 ——
 * 展示上次结论 + 给「重问 / 先留着」两个动作，不再混在待办里。
 */
export function assessedSkillsFor(
  profile: CandidateProfile,
  job: JobRequirement | null,
  options: { prefs?: ReviewPreferences; marks?: StaleMark[]; now?: Date } = {},
): Array<{
  skillName: string;
  level: SkillLevel;
  summary: string;
  createdAt: string;
  evidenceCount: number;
}> {
  const prefs = options.prefs ?? DEFAULT_REVIEW_PREFERENCES;
  const now = options.now ?? new Date();
  const markMap = new Map((options.marks ?? []).map((m) => [m.skillName, m]));

  return (profile.assessments ?? [])
    .filter((a) => assessFreshness(a, job, markMap.get(a.skillName), prefs, now).fresh)
    .map((a) => ({
      skillName: a.skillName,
      level: a.level,
      summary: a.summary,
      createdAt: a.createdAt,
      evidenceCount: a.producedEvidenceIds?.length ?? 0,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
