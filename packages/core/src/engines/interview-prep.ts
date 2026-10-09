import { AiGateway } from '../ai/gateway';
import type { AiMessage, AiTrace } from '../domain/ai-trace';
import type { CandidateEvidence } from '../domain/evidence';
import type { CandidateProfile } from '../domain/profile';
import type { JobRequirement } from '../domain/job';
import {
  ANSWER_BLUEPRINTS,
  QUESTION_KIND_LABEL,
  type AnswerBlueprint,
  type CitableEvidence,
  type InterviewQuestionKind,
  type PrepareQuestionsOutput,
  type PreparedQuestion,
} from '../domain/interview-prep';
import { capabilityLevelOfEvidence } from '../domain/levels';
import { findSkillsInText, textMentionsSkill } from '../nlp/skills';
import { newId, truncate, unique } from '../utils/text';
import { PREP_QUESTIONS_SYSTEM_PROMPT } from '../ai/prompts';

/**
 * 面试官问答推荐引擎（v0.4）
 * ============================
 *
 * 输入：用户手头的面试问题（可能几条，可能一大段）
 * 输出：每条问题 → 问题类别 → 回答必须覆盖的要点 + 档案里可能引用的证据
 *
 * **输出里没有「可以这样回答」**。这是本模块最重要的一条设计约束：
 * 一旦系统开始生成可直接照抄的答案，用户就会去背它，
 * 而背出来的答案在追问下必然崩掉 —— 那时候工具反而帮了倒忙。
 * 所以引擎只做两件事：分类、找证据。
 */

// ---------------------------------------------------------------------------
// 问题分类
// ---------------------------------------------------------------------------

/**
 * 关键词 → 类别。
 *
 * **顺序就是优先级，先命中先判**。这不只是「排个好看的顺序」，
 * 排错会直接导致答法给偏，而答偏了用户是发现不了的：
 *
 *   「为什么用 Redis 做缓存」
 *     同时命中 motivation 的「为什么」与 technical 的「为什么用」。
 *     这里靠两条规则解决：
 *       1. motivation 的正则要求「为什么 + 来/想做/选择/加入」这个组合，
 *          单独的「为什么」不触发 —— 否则所有技术「为什么」都会被抢走；
 *       2. 纯技术词（原理/架构/实现…）出现在句子里时，technical 优先级更高。
 *
 *   「为什么想加入我们」
 *     必须命中 motivation 而不是落进 behavioral 兜底，
 *     否则会给一段「讲一件具体的事」的答法 —— 对动机类问题完全跑偏。
 */
const KIND_RULES: Array<{ kind: InterviewQuestionKind; patterns: RegExp }> = [
  // 纯技术词：优先级高于动机。
  // 「为什么」本身不算技术信号（它对动机类问题同样常见），必须靠这些实词。
  {
    kind: 'technical',
    patterns: /(原理|实现|架构|源码|底层|数据结构|算法|并发|性能|调试|排查|优化|选型|技术方案|怎么用|如何用|区别|用什么)/,
  },
  // 动机：必须「为什么 + 具体动词」，避免抢走技术问题
  {
    kind: 'motivation',
    patterns: /(为什么(想|要|会)?(来|做|选择|加入|投|申请)|怎么(会)?想|兴趣|热情|驱动|理想|期待加入)/,
  },
  // 压力 / 失败
  {
    kind: 'pressure',
    patterns: /(最难|失败|搞砸|出错|事故|背锅|压力|扛不住|委屈|被拒绝|没做成)/,
  },
  // 匹配
  {
    kind: 'fit',
    patterns: /(适合|匹配|胜任|优势|凭什么|我们为什么(应该|要)(选|用)你|为什么你)/,
  },
  // 现状
  {
    kind: 'situation',
    patterns: /(薪资|待遇|期望薪|当前状态|离职|跳槽|待业|加班|出差|base|城市|地点)/,
  },
  // 协作
  {
    kind: 'collaboration',
    patterns: /(同事|协作|配合|团队|上级|领导|跨部门|冲突|意见不一致|带人|管人|沟通)/,
  },
  // 规划
  {
    kind: 'future',
    patterns: /(未来|规划|三年|五年|长期|成长|学习计划|打算|职业方向)/,
  },
  // 行为（兜底前的最后一道）：句子里有「讲一件 / 举个例子 / 描述」这类信号
  {
    kind: 'behavioral',
    patterns: /(介绍一下|讲(一个|一次|一件)|举个例子|说说|描述|遇到|处理过|负责过)/,
  },
];

/** 没命中任何规则时的兜底 */
const DEFAULT_KIND: InterviewQuestionKind = 'behavioral';

/**
 * 把一段文本切成多个问题。
 *
 * 为什么必须切分：用户很可能是从招聘网站整段复制「面试官会问的问题」进来，
 * 一次十几条。逐条处理才有意义 —— 而逐条处理正是本功能的价值所在。
 *
 * 切分后的清理必须把编号后的「.」「、」「)」一起吃掉：
 * 只删数字会留下「. 为什么想加入我们」，读起来像是残句。
 */
export function splitQuestions(raw: string): string[] {
  return String(raw ?? '')
    .split(/[\n\r]+|[；;]|(?<=[？?。.!！])\s*(?=[0-9①-⑩一二三四五六七八九十、·•（(])/)
    .map((s) =>
      s
        .replace(/^[\s\d①-⑩一二三四五六七八九十]+[.、．)）:：]\s*/, '')
        .replace(/^[\s、·•]+/, '')
        .trim(),
    )
    // 短句多半是残句，不是完整问题
    .filter((s) => s.length >= 5 && s.length <= 120)
    .slice(0, 20);
}

/**
 * 判定问题类别。
 *
 * 为什么不能只靠关键词：「为什么用 Redis 做缓存」这类问题里，
 * 既没有「原理/架构」也没有「为什么想加入」—— 纯正则会把它漏到兜底，
 * 然后给一段「讲一件事」的答法，而正确答案是技术取舍。
 *
 * 所以加了一条词典兜底：**句子里出现技能词典里的技术名词时判 technical**。
 * 这比继续往正则里加词可靠得多 —— 词典本来就是用来认技术名词的。
 */
export function classifyQuestion(text: string): InterviewQuestionKind {
  for (const rule of KIND_RULES) {
    if (rule.patterns.test(text)) return rule.kind;
  }

  // 关键词没命中时，用技能词典兜底。
  // 只认非软技能 —— 「沟通表达」出现在问题里不代表这是行为类问题，
  // 而「Redis / RAG / SQL」出现基本就是技术问题。
  const skills = findSkillsInText(text).filter((h) => h.def.kind !== 'soft' && h.def.kind !== 'certificate');
  if (skills.length > 0) return 'technical';

  return DEFAULT_KIND;
}

// ---------------------------------------------------------------------------
// 匹配档案里的证据
// ---------------------------------------------------------------------------

/**
 * 找出可能可以引用的证据。
 *
 * **刻意不给「改写后的说法」**，只给原文与出处。理由见文件头：
 * 一旦系统替用户组织语言，用户就分不清哪句是自己说的 ——
 * 这个风险与问诊「候选答案」那条规则是同一条，所以两处的口径必须一致。
 */
function citableFrom(evidence: CandidateEvidence[], text: string): CitableEvidence[] {
  const skills = findSkillsInText(text).map((h) => h.def.name);
  const scored = evidence
    .map((item) => {
      let score = 0;
      for (const skill of skills) {
        if (item.skills.includes(skill)) score += 2;
        else if (textMentionsSkill(skill, item.content)) score += 1;
      }
      // 关键词命中也算一点，让没有技能标注的证据有机会被选中
      if (keywordsOverlap(text, item.content)) score += 1;
      if (score === 0) return null;
      return { item, score };
    })
    .filter((x): x is { item: CandidateEvidence; score: number } => x !== null)
    .sort((a, b) => b.score - a.score || capabilityLevelOfEvidence(b.item) - capabilityLevelOfEvidence(a.item));

  return scored.slice(0, 3).map(({ item }) => ({
    evidenceId: item.id,
    title: item.title,
    excerpt: truncate(item.content, 160),
    kind: item.kind,
    strength: item.strength,
  }));
}

function keywordsOverlap(question: string, content: string): boolean {
  const words = question
    .replace(/[？?。，,！!：:；;（）()「」【】""'']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  return words.filter((w) => content.includes(w)).length >= 2;
}

/**
 * 这个问题与档案的对接情况。
 *
 * 这一段是本功能对用户最有用的部分：不是给答案，而是告诉他
 * 「你能不能答上来」—— 档案里没材料的问题，才是真正要提前准备的。
 */
function coverageOf(
  text: string,
  evidence: CandidateEvidence[],
  citable: CitableEvidence[],
  profile: CandidateProfile | null,
): PreparedQuestion['coverage'] {
  const skills = findSkillsInText(text).map((h) => h.def.name);
  const skillMatched = Boolean(
    profile &&
      (profile.skills.some((s) => skills.includes(s.name)) || skills.length > 0),
  );

  if (citable.length === 0) {
    return {
      hasEvidence: false,
      skillMatched,
      note: skillMatched
        ? '档案里有这项能力，但没有任何一条证据能对上这个问题 —— 需要先想清楚例子'
        : '档案里既没有这项能力，也没有相关经历 —— 这是最需要提前准备的一类',
    };
  }

  const strongest = citable[0];
  if (strongest.strength === 'strong') {
    return {
      hasEvidence: true,
      skillMatched,
      note: '档案里有能直接引用的证据（强度「强」），先把这几条讲透',
    };
  }
  return {
    hasEvidence: true,
    skillMatched,
    note: '档案里有相关经历，但强度只有「中」—— 讲之前先想清楚可核对的载体是什么',
  };
}

// ---------------------------------------------------------------------------
// 本地建议
// ---------------------------------------------------------------------------

/**
 * 无模型时给出的本地建议。
 *
 * 只做一件事：指出这道题最容易被追问的地方。
 * 不生成任何台词 —— 那条边界见文件头。
 */
function localAdvice(kind: InterviewQuestionKind, coverage: PreparedQuestion['coverage'], text: string): string {
  const blueprint = ANSWER_BLUEPRINTS[kind];
  const short = truncate(text, 24);
  if (!coverage.hasEvidence) {
    return `「${short}」在你的档案里找不到能引用的东西。先想好一件事：有没有哪怕不相关但能说明同一件事的经历？如果真的没有，这一题的准备重点是「承认没做过 + 说清你会怎么上手」，不是编。`;
  }
  return `「${short}」属于${QUESTION_KIND_LABEL[kind]}问题。按「${blueprint.mustCover[0].slice(0, 20)}…」这类结构组织，展开前先把档案里那 ${blueprint.mustCover.length} 个要点各写一句话。`;
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

interface AiPrepPayload {
  items?: Array<{
    text?: string;
    kind?: string;
    advice?: string;
    extraMustCover?: string[];
  }>;
}

const VALID_KINDS: InterviewQuestionKind[] = [
  'behavioral',
  'technical',
  'motivation',
  'situation',
  'collaboration',
  'future',
  'pressure',
  'fit',
];

export interface PrepareQuestionsInput {
  profile: CandidateProfile | null;
  job?: JobRequirement | null;
  /** 用户原样输入的问题，可以是一大段 */
  raw: string;
  gateway?: AiGateway | null;
  onMessages?: (messages: AiMessage[]) => void;
}

export async function prepareQuestions(input: PrepareQuestionsInput): Promise<PrepareQuestionsOutput> {
  const warnings: string[] = [];
  const questions = splitQuestions(input.raw);

  if (questions.length === 0) {
    return {
      items: [],
      engine: 'rule',
      warnings: ['没有识别出完整的问题。你可以直接输入一整段面试问题，系统会按条拆开处理。'],
    };
  }

  const evidence = input.profile?.evidence ?? [];
  const items: PreparedQuestion[] = questions.map((text) => {
    const kind = classifyQuestion(text);
    const blueprint: AnswerBlueprint = ANSWER_BLUEPRINTS[kind];
    const citable = citableFrom(evidence, text);
    const coverage = coverageOf(text, evidence, citable, input.profile);
    return {
      id: newId('prep'),
      text,
      kind,
      kindLabel: QUESTION_KIND_LABEL[kind],
      blueprint,
      citable,
      coverage,
      advice: localAdvice(kind, coverage, text),
    };
  });

  let engine: PrepareQuestionsOutput['engine'] = 'rule';
  let trace: AiTrace | null = null;

  // 模型可用时，让它补一条针对性的提醒。
  // 注意 prompt 里明确禁止它生成可直接照说的答案 —— 那条边界不能只写在代码注释里。
  if (input.gateway?.active && items.length > 0) {
    const messages: AiMessage[] = [
      { role: 'system', content: PREP_QUESTIONS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `目标岗位：${input.job?.jobTitle ?? '（未指定）'}`,
          input.job?.roleSummary ? `岗位定位：${input.job.roleSummary}` : '',
          '',
          '候选人档案里已有的能力：',
          (input.profile?.skills ?? []).slice(0, 25).map((s) => `- ${s.name}（${s.selfLevel}）`).join('\n') || '（档案为空）',
          '',
          `用户拿到的面试问题共 ${items.length} 条：`,
          ...items.map((it, i) => `${i + 1}. [${it.kind}] ${it.text}\n   档案里可引用的证据：${it.citable.length} 条${it.citable.length > 0 ? `（${it.citable.map((c) => c.title).join('、')}）` : ''}`),
          '',
          '请为每条补一条针对性的提醒。',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];

    input.onMessages?.(messages);
    const run = await input.gateway.runJson<AiPrepPayload>('interview_prep', messages, { maxTokens: 2048 });
    trace = run.trace;

    if (run.value?.items?.length) {
      let applied = 0;
      for (const aiItem of run.value.items) {
        const target = items.find((it) => it.text === aiItem.text || it.text.includes(aiItem.text ?? '§'));
        if (!target) continue;
        if (typeof aiItem.advice === 'string' && aiItem.advice.trim()) {
          target.advice = aiItem.advice.trim();
          applied += 1;
        }
        // 类型纠正：模型的分类常比本地规则准（本地规则只能看关键词）
        if (typeof aiItem.kind === 'string' && VALID_KINDS.includes(aiItem.kind as InterviewQuestionKind)) {
          const modelKind = aiItem.kind as InterviewQuestionKind;
          if (modelKind !== target.kind) {
            target.kind = modelKind;
            target.kindLabel = QUESTION_KIND_LABEL[modelKind];
            target.blueprint = ANSWER_BLUEPRINTS[modelKind];
          }
        }
        if (Array.isArray(aiItem.extraMustCover) && aiItem.extraMustCover.length > 0) {
          target.blueprint = {
            ...target.blueprint,
            mustCover: unique([...target.blueprint.mustCover, ...aiItem.extraMustCover.map((s) => String(s).trim())]).slice(0, 5),
          };
        }
      }
      if (applied > 0) engine = 'hybrid';
    } else if (run.error) {
      warnings.push(`模型提醒不可用，已使用本地规则：${run.error}`);
    }
  }

  return { items, engine, warnings: unique(warnings) };
}
