/**
 * 模拟面试的领域模型（v0.4，`interview.mock` / `interview.analyze_answer` /
 * `interview.generate` / `interview.weak_point_training`）。
 *
 * 为什么单独一个文件而不并进 domain/training.ts：
 *   训练是「已知自己缺什么、练已知的那几条」；
 *   模拟面试是「不知道会被问什么、由对方决定顺序、并且会追问」。
 * 两者���数据流方向不同 —— 训练是 job → 薄弱项 → 题目，
 *   模拟面试是「你的档案 + 岗位 + 真题」→ 临时出题 → 逐轮追问 → 回流。
 * 合并会让两个都很长，且改动任一方都要读另一方。
 *
 * ── 一条必须守住的产品立场 ──
 * 和 `interview-prep` 一样：**不给可以直接照读的答案**。
 * 但这里比 Prep 更严格 —— 模拟面试的价值在于「你被追问了」，
 * 如果系统把第 3 轮的追问答案也准备好，用户会去背，而背出来的答案
 * 在真实面试的第三轮追问里必然崩掉。所以：
 *
 *   分析只给「缺了什么 / 哪里没答到点 / 结构上缺哪一环」
 *   不给「你应该这么答」
 *
 * 这一点与 `training.reference_answer` 是**刻意不同的**：
 * 训练题有客观对错（什么是 B+ 树的联合索引），可以给参考答案；
 * 模拟面试是开放表达，参考答案会诱导背诵。
 */

import type { CandidateProfile } from './profile';
import type { JobRequirement } from './job';
import type { CandidateEvidence } from './evidence';
import type { SkillLevel } from './interview';

// ---------------------------------------------------------------------------
// 一、题目生成（interview.generate）
// ---------------------------------------------------------------------------

/**
 * 面试题的来源。不同来源的用途不同：
 *   requirement 由岗位要求推导 —— 面试官一定会问的
 *   real      用户粘贴的真题 —— 最贴近真实考场
 *   gap       由「你的档案没写」推出 —— 最可能问倒你的地方
 *   domain    指定知识领域 —— 用户主动补弱
 */
export type QuestionSource = 'requirement' | 'real' | 'gap' | 'domain';

/**
 * 为什么题目来源必须显式标出来，而不是混在一起：
 *   用户对「真题」和「模型猜的题」的信任度完全不同，
 *   混在一起他会默认全都见过，于是准备的重点整个错位。
 * 界面上必须分开显示，并且真题要标出「这是真实出现过的」。
 */
export const QUESTION_SOURCE_LABEL: Record<QuestionSource, string> = {
  requirement: '由岗位要求推导',
  real: '你提供的真题',
  gap: '你的档案里缺证据',
  domain: '指定领域',
};

/** 真题的出处。用户粘贴时可填，填了会显著提高这条题的参考价值 */
export interface QuestionSourceRef {
  /** 岗位名 / 公司名（用户自己填，不做识别） */
  org?: string;
  /** 「一面」「二面」「HR 面」之类 */
  round?: string;
  /** 原题出处（复盘链接、题库页）。本地存储，用户自己决定是否留 */
  note?: string;
}

export type MockQuestionKind =
  | 'fact'        // 事实与原理
  | 'depth'       // 追问细节
  | 'scenario'    // 真实场景处理
  | 'motivation'  // 为什么做这件事
  | 'pressure';   // 压力题（质疑你的判断）

export const MOCK_KIND_LABEL: Record<MockQuestionKind, string> = {
  fact: '事实与原理',
  depth: '追问细节',
  scenario: '真实场景',
  motivation: '动机',
  pressure: '压力题',
};

/**
 * 追问问的是**下一轮**，不是同一轮的下一个问题。
 * 这一点决定了整个流程的形状：用户答完第 1 轮，系统才知道该问什么。
 */
export interface MockQuestion {
  id: string;
  /** 第几轮。从 1 开始 */
  round: number;
  source: QuestionSource;
  sourceRef?: QuestionSourceRef;
  kind: MockQuestionKind;
  /** 问题正文（用户看到并回答的） */
  text: string;
  /** 为什么问这个问题 —— 回答完会一并展示，帮用户理解考察点 */
  intent: string;
  /** 期望答到的要点。仅用于「有没有答到点」的判断，不作为标准答案展示 */
  expectedPoints: string[];
  /** 关联到岗位的哪一条要求（若能关联）。用于复盘时回看 */
  requirementId?: string;
  /** 关联到哪条证据（若能关联） */
  evidenceIds?: string[];
  /** 本轮是否会继续追问。false 表示这是收尾题 */
  probes?: string[];
}

// ---------------------------------------------------------------------------
// 二、用户作答
// ---------------------------------------------------------------------------

export type AnswerChannel = 'text' | 'voice';

export const ANSWER_CHANNEL_LABEL: Record<AnswerChannel, string> = {
  text: '文字作答',
  voice: '语音作答（转写后同样进入分析）',
};

/**
 * 一次作答。
 *
 * **不存录音**：语音作答在转写完成后只保留文字（audio 的落盘与生命周期
 * 由录音模块管，不进 WorkspaceSnapshot —— 那是既有约束，本模块不破坏它）。
 * 理由：录音留在快照里会让快照体积不可控，而复盘只需要文字。
 */
export interface MockAnswer {
  questionId: string;
  /** 文字内容。语音作答时是转写结果 */
  text: string;
  channel: AnswerChannel;
  /** 用时（毫秒）。用于识别「想了很久才答」这种信号 */
  durationMs?: number;
  /** 用户自评：答完之后觉得怎么样。0~3，与训练页同一套刻度 */
  selfScore?: 0 | 1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// 三、回答分析（interview.analyze_answer）
// ---------------------------------------------------------------------------

/**
 * 五个分析维度。
 *
 * 为什么是这五个、而不是「好/不好」：
 *   「答得好不好」用户自己判断不了（这正是他要工具的原因），
 *   但「你没说清原理」「你答的不是我问的」这种他能立刻看懂并修正。
 *
 * 每个维度独立给结论，**不给总分** —— 与「不提供 0–100 匹配分」同源：
 * 五个维度合成一个分，权重就成了隐藏的产品判断，而用户无法反驳它。
 */
export type AnswerDimension = 'correctness' | 'completeness' | 'structure' | 'on_point' | 'restraint';

export const ANSWER_DIMENSION_LABEL: Record<AnswerDimension, string> = {
  correctness: '知识是否正确',
  completeness: '是否讲全了',
  structure: '结构是否清楚',
  on_point: '是否答到点',
  restraint: '是否过度展开',
};

/** 维度里的档位。刻意只有三档 —— 多了用户分不清，也多了会显得系统在装精确 */
export type DimensionVerdict = 'ok' | 'partial' | 'missing';

export const DIMENSION_VERDICT_LABEL: Record<DimensionVerdict, string> = {
  ok: '到位',
  partial: '部分到位',
  missing: '没提到',
};

export interface DimensionFinding {
  dimension: AnswerDimension;
  verdict: DimensionVerdict;
  /** 依据：具体引用了用户作答里的哪一句。不给改写后的说法 */
  quotedFromAnswer?: string;
  /** 这一维度缺什么。用「缺的是…」的表述，不用「你应该说…」 */
  gap?: string;
}

export interface AnswerAnalysis {
  questionId: string;
  /** 五个维度各自结论 */
  findings: DimensionFinding[];
  /** 答到点了吗 —— 综合判断，用离散值不给分 */
  hitPoint: 'yes' | 'partly' | 'no';
  /** 追问建议。给的是「对方接下来会问什么」，不是「你应该怎么答」 */
  likelyFollowUps: string[];
  /** 本地规则与证据命中的原文。没有证据支撑的判断会被标为推断 */
  evidenceQuotes: Array<{ evidenceId: string; quote: string; source: string }>;
  /** 有没有引用到证据。空数组表示「这一轮你全靠自己临场」 */
  usedEvidence: boolean;

  /**
   * 从这一答里抽出的可追问点（v0.5 交互式）。
   *
   * 下一轮的问题从这里长出来，而不是从题单顺序里取。
   * 每一点都带 `anchor`（原文片段）—— 没有原文的追问是凭空编的，
   * 用户会困惑「我哪句没说清」。
   */
  followUpHooks?: FollowUpHook[];
  /** 对这一答的反馈。只说缺什么，不给该怎么说。 */
  feedback?: AnswerFeedbackView;
}

/**
 * 一个可追问的点。
 *
 * **必须有 `anchor`（原文片段）** —— 这是硬要求：
 * 没有原文就追问，等于凭空编一个「你可能没讲清楚的地方」，
 * 用户会困惑「我哪句没说清」，而那比不追问更糟。
 */
export interface FollowUpHook {
  id: string;
  /** 触发追问的原文片段。必须真的出现在用户回答里 */
  anchor: string;
  kind: 'vague_quantifier' | 'unbacked_claim' | 'no_mechanism' | 'self_doubt' | 'unfinished' | 'skill_gap';
  /** 追问正文 */
  text: string;
  /** 为什么追这个。回答后一并展示，帮用户理解考察点 */
  intent: string;
  /** 期望这次答到的要点。**不给标准答案** —— 只用来判断「有没有答到」 */
  expectedPoints: string[];
}

/** 反馈的展示形态。放这里是为了避免 domain 反向依赖 engines */
export interface AnswerFeedbackView {
  headline: string;
  gaps: Array<{ text: string; anchor?: string }>;
  strengths: string[];
  nextQuestionPreview?: string;
}

/** 提问建议的免责声明。硬编码在数据里，不写在页面文案上 */
export const MOCK_DISCLAIMER =
  '这里只判断缺什么，不生成可以照读的答案。原因很实际：' +
  '背下来的回答在对方第三轮追问时会崩，而那时你甚至不知道它是从哪来的。';

// ---------------------------------------------------------------------------
// 四、薄弱点回流（interview.weak_point_training）
// ---------------------------------------------------------------------------

/**
 * 模拟面试暴露出的薄弱点。
 *
 * 回流去向是**能力库的待补列表**，不是训练计划 —— 这是有意的：
 *   训练计划是「针对这次岗位的已知缺口」，会随岗位变；
 *   待补列表是「这个人就是不会」，跨岗位保留（符合 library.cross_job 的立场）。
 */
export interface MockWeakness {
  /** 关联到档案里的哪条技能。识别不出时为 undefined */
  skillName?: string;
  /** 缺的具体内容 */
  gap: string;
  /** 缺到什么程度 */
  severity: 'gap' | 'lacking_evidence' | 'partial';
  /** 来源：哪一轮暴露的 */
  fromQuestionIds: string[];
  /** 判断依据（引用作答原文） */
  evidenceQuotes: string[];
}

/**
 * 回流到能力库的建议动作。
 *
 * 刻意只给三件事：**补证据 / 补知识 / 练表达**。
 * 不给「建议提升到 L3」这种 —— 那需要知道岗位要求，而模拟面试
 * 回答的是「这个人缺什么」，两件事的坐标系不一样。
 */
export type WeakeningAction = 'add_evidence' | 'learn_concept' | 'practice_expression';

export const WEAKENING_ACTION_LABEL: Record<WeakeningAction, string> = {
  add_evidence: '补一条能核对的证据',
  learn_concept: '把这个概念弄懂',
  practice_expression: '练一遍怎么说',
};

export interface WeakeningSuggestion {
  weakness: MockWeakness;
  action: WeakeningAction;
  /** 为什么是这个动作。用一句话，不说教 */
  why: string;
}

// ---------------------------------------------------------------------------
// 五、会话
// ---------------------------------------------------------------------------

export type MockSessionStatus = 'questioning' | 'finished' | 'abandoned';

export const MOCK_STATUS_LABEL: Record<MockSessionStatus, string> = {
  questioning: '进行中',
  finished: '已完成',
  abandoned: '已中止',
};

export interface MockSession {
  id: string;
  createdAt: string;
  /** 关联到哪个岗位（可空：用户也可能只是练技术） */
  jobTitle?: string;
  /** 本场用掉的题目，按轮次顺序 */
  questions: MockQuestion[];
  answers: MockAnswer[];
  analyses: AnswerAnalysis[];
  weaknesses: MockWeakness[];
  /** 生成参数，便于复现同一场 */
  input: {
    /** 用户指定的知识领域（对应 source: 'domain'） */
    domains: string[];
    /** 是否包含压力题 */
    includePressure: boolean;
    /** 是否按档案缺口出题（对应 source: 'gap'） */
    includeGap: boolean;
    /** 用户指定的题目上限。题太多会让人放弃，所以默认很少 */
    maxQuestions: number;
  };
  status: MockSessionStatus;
}

/**
 * 「当前该问哪一题」的唯一定义。
 *
 * 放在领域层而不是组件里 —— 「什么是进行中的模拟面试」是业务规则，
 * 界面只是按它渲染。组件自己判断会出现两份逻辑不一致。
 */
export function nextQuestionOf(session: MockSession): MockQuestion | undefined {
  const answered = new Set(session.answers.map((a) => a.questionId));
  const byRound = [...session.questions].sort((a, b) => a.round - b.round);
  // 顺序推进：只在最后一轮之后才结束，中途不跳题
  return byRound.find((q) => !answered.has(q.id));
}

/** 会话统计。只给离散结论，不给「你答对了几个」这种百分比 */
export interface MockStats {
  answeredCount: number;
  questionCount: number;
  /** 答到点的比例，映射成三档而非具体数字 */
  hitRate: 'all' | 'most' | 'few' | 'none';
  /** 五维里「到位」的占比，三档 */
  dimensionHealth: 'good' | 'fair' | 'poor';
  weaknessCount: number;
}

export function computeMockStats(session: MockSession): MockStats {
  const answered = session.answers.length;
  const total = session.questions.length;
  const analyses = session.analyses;
  const hits = analyses.filter((a) => a.hitPoint === 'yes').length;
  const partials = analyses.filter((a) => a.hitPoint === 'partly').length;

  let hitRate: MockStats['hitRate'] = 'none';
  if (answered > 0) {
    const rate = (hits + partials * 0.5) / answered;
    hitRate = rate >= 0.8 ? 'all' : rate >= 0.5 ? 'most' : 'few';
  }

  let dimensionHealth: MockStats['dimensionHealth'] = 'good';
  if (analyses.length > 0) {
    const all = analyses.flatMap((a) => a.findings);
    const ok = all.filter((f) => f.verdict === 'ok').length;
    const ratio = ok / all.length;
    dimensionHealth = ratio >= 0.75 ? 'good' : ratio >= 0.45 ? 'fair' : 'poor';
  }

  return {
    answeredCount: answered,
    questionCount: total,
    hitRate,
    dimensionHealth,
    weaknessCount: session.weaknesses.length,
  };
}

export const HIT_RATE_LABEL: Record<MockStats['hitRate'], string> = {
  all: '基本都答到点了',
  most: '多数答到点，个别没接住',
  few: '多数没答到点上',
  none: '基本没答到点上',
};

export const DIMENSION_HEALTH_LABEL: Record<MockStats['dimensionHealth'], string> = {
  good: '表达整体清楚',
  fair: '有能听懂的，也有听不明白的',
  poor: '多处讲不清',
};

/**
 * 把某条技能在档案里的当前等级，与模拟面试暴露的问题放在一起看。
 *
 * 取**较低者** —— 与 levels.ts 的立场一致：宁可低估，也不要让用户
 * 以为已经够了。档案里的等级来自证据与问诊，模拟面试是现场表现，
 * 两者都只是信号，任何一个都不能单独定论。
 */
export function resolveMockLevel(
  profileLevel: SkillLevel | undefined,
  weakest: MockWeakness | undefined,
): SkillLevel {
  if (!profileLevel) return 'unverified';
  if (!weakest) return profileLevel;
  // 现场暴露「完全没提到」→ 降一档；「部分到位」→ 不降
  if (weakest.severity === 'gap') {
    const order: SkillLevel[] = ['unverified', 'aware', 'practiced', 'applied', 'delivered', 'expert'];
    const idx = order.indexOf(profileLevel);
    return idx > 0 ? order[idx - 1] : profileLevel;
  }
  return profileLevel;
}

/** 回流建议的构造入口参数。引擎与界面共用这套类型 */
export interface WeakeningInput {
  profile: CandidateProfile;
  weaknesses: MockWeakness[];
  /** 用于判断某条缺口能不能靠补证据解决 */
  evidences?: CandidateEvidence[];
  jobRequirements?: JobRequirement[];
}