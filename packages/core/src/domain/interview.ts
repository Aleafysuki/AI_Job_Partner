/**
 * 能力问诊（v0.2）
 * =================
 *
 * 要解决的问题：简历里写「熟悉 RAG」，但系统不知道这是「看过文章」还是「独立交付过」。
 * 匹配引擎只能把它判成「缺少证据」，用户看到的是一个自己也不知道该怎么改的结论。
 *
 * 问诊用一组递进问题把这件事问清楚，产出三样东西：
 *   1. 掌握程度判断（SkillLevel）—— 用户自己也能对照
 *   2. 一条可加入能力库的**证据补充**（origin = 'qa'，强度封顶为「中」）
 *   3. 明确的待学习项（用户自己说"还不确定"的部分）
 *
 * 设计上刻意不做的事：不给出「你这项技能打了 78 分」这类伪精确结论，
 * 只输出离散等级 + 判断依据（signals） + 下一步动作。
 */

import type { TriLevel } from './common';

/** 问诊的五个层次，从易到难，逐层探测 */
export type AssessLayer = 'self_report' | 'fact' | 'depth' | 'output' | 'boundary';

export const ASSESS_LAYER_LABEL: Record<AssessLayer, string> = {
  self_report: '自评',
  fact: '具体场景',
  depth: '使用深度',
  output: '产出结果',
  boundary: '认知边界',
};

export type AssessQuestionKind = 'choice' | 'text';

/**
 * v0.3 追加：一个可一键采纳的候选回答。
 *
 * 为什么要有这个结构（这是用户实测后最痛的一点）：
 * 原来的问诊只有「填空一个文本框」，用户必须自己回忆、组织、编写一整段话 ——
 * 于是「用起来太费脑子」，多数人直接放弃。
 * 现在改成：**系统把候选答案摆出来，用户只需要点一下或者改几个字**。
 *
 * label 是给人看的短句，draft 是采纳后真正写进档案的内容。
 * 两者分开的原因：短句要能一眼扫完，长句才能构成一条合格的证据
 * （证据要同时含场景与动作，否则本地规则会判为「不算做过」）。
 */
export interface AssessOption {
  label: string;
  /** 采纳后写入答案的正文。为空时用 label 本身。 */
  draft?: string;
  /** 这个候选是从哪条既有证据里摘出来的（可回溯，用户能核实不是编的） */
  fromEvidenceId?: string;
  /** 来自既有证据时，原文出处 */
  fromEvidenceTitle?: string;
}

/**
 * v0.4 追加：一个「点一下就能完成这道题」的候选。
 *
 * 与 `suggestions` 的区别，两者是不同的东西：
 *   - `suggestions` 来自**用户自己写过的档案内容**（原句摘出，可核实出处）；
 *   - `quickChoices` 来自**系统预置的常见情形**（不含任何用户特有的事实）。
 *
 * 为什么要分开：用户反馈「提的问题对于用户来说还是太繁重了」。
 * 光有「从自己档案里抽候选」不够 —— 档案里没写过的事仍然要用户自己想，
 * 而那恰恰是最费脑子的部分。`quickChoices` 让用户**连回忆都不必**：
 * 从几句现成的情形里挑一个，就算答完了。
 *
 * 两条不可越过的约束：
 *   1. 每一项都不得含具体数字、公司名、项目名 —— 系统不替用户编经历；
 *   2. 永远配一个「以上都不像，我自己写」的兜底项 ——
 *      强制用户从四个都不对的选项里挑一个，会往能力库里写进假信息，
 *      那比不填更糟。
 */
export interface QuickChoice {
  label: string;
  /** 选完这一项是否还需要补充细节（界面上会展开输入框并聚焦） */
  needsDetail?: boolean;
  /**
   * 这是不是「以上都不像，我自己写」的兜底项。
   *
   * 必须显式标记而不能靠 `needsDetail` 推断：普通选项也会标
   * `needsDetail`（选了补一句即可），而兜底项点下去要**跳到输入框重写**。
   * 两者界面行为不同，界面不该去猜。
   */
  isEscape?: boolean;
}

export interface AssessQuestion {
  id: string;
  skillName: string;
  layer: AssessLayer;
  kind: AssessQuestionKind;
  prompt: string;
  /** 填答提示，帮用户知道「说到什么程度算够」 */
  hint?: string;
  /** 选择题选项 */
  options?: string[];
  /** v0.3：可一键采纳的候选回答（含草稿正文） */
  suggestions?: AssessOption[];
  /**
   * v0.4：系统预置的「常见情形」选项。
   * 点一下即完成这道题，不含用户特有事实，因此**不可核实** ——
   * 界面必须把它与 suggestions（来自用户自己的档案）区分展示。
   */
  quickChoices?: QuickChoice[];
  /**
   * v0.3：题目出处。
   * - ai      模型按这个能力的实际分水岭生成
   * - rule    本地规则生成（没有模型 / 模型不可用）
   * - evidence 候选直接来自用户档案里已有的证据
   */
  origin?: 'ai' | 'rule' | 'evidence';
  /** 该项是否是决定「能否产出证据」的关键题 */
  critical?: boolean;
}

export interface AssessAnswer {
  questionId: string;
  layer: AssessLayer;
  /** 选择题选项下标 */
  choiceIndex?: number;
  text: string;
  answeredAt: string;
  /** 跳过（用户明确表示不会） */
  skipped?: boolean;
  /**
   * v0.3：跳过原因。两个跳过语义完全不同，混成一个按钮会出错：
   *   - 'not_done' 用户明确说了「没做过」→ 系统必须按否认处理，等级封顶在「了解概念」，
   *     绝不能因为别处出现场景词就判成「实际用过」；
   *   - 'cant_recall' 用户只是想不起来 → **不是否认**，不该影响等级判定。
   *
   * 原实现只有一个 `skipped: true`，用户点错了没法补救，
   * 而误判成「没做过」会让认真做过的事被判成「只是了解」，这是很伤的错误。
   */
  skipReason?: 'not_done' | 'cant_recall';
}

export type AssessSessionStatus = 'draft' | 'completed';

export interface AssessSession {
  id: string;
  profileId: string;
  skillName: string;
  /** 这次问诊是在分析哪个岗位时发起的（用于把证据标注来源岗位） */
  jobId?: string;
  jobTitle?: string;
  questions: AssessQuestion[];
  answers: AssessAnswer[];
  status: AssessSessionStatus;
  startedAt: string;
  completedAt?: string;
}

/**
 * 掌握程度等级。
 *
 * 六个等级全部对应「能不能说出具体事实」，而不是「感觉如何」：
 *   unverified  答不出来 / 跳过
 *   aware       只能复述概念，说不出自己用过的场景
 *   practiced   跟着教程或课程做过，但没有独立产出
 *   applied     在项目或工作中实际用过，能说清做法
 *   delivered   能说清做法 + 结果，且有可核对载体（链接 / 数字）
 *   expert      多场景、有取舍判断，并能指出自身边界（最高档，问诊很少给出）
 */
export type SkillLevel = 'unverified' | 'aware' | 'practiced' | 'applied' | 'delivered' | 'expert';

export const SKILL_LEVEL_LABEL: Record<SkillLevel, string> = {
  unverified: '未验证',
  aware: '了解概念',
  practiced: '跟做过',
  applied: '实际用过',
  delivered: '有产出',
  expert: '可讲清取舍',
};

export const SKILL_LEVEL_ORDER: SkillLevel[] = ['unverified', 'aware', 'practiced', 'applied', 'delivered', 'expert'];

/** 问诊给每个等级配一句「这个等级意味着什么」，避免用户看到标签不懂含义 */
export const SKILL_LEVEL_MEANING: Record<SkillLevel, string> = {
  unverified: '这次问诊没有拿到可用信息，系统无法判断你的掌握程度。',
  aware: '你了解它是什么，但还没有说过自己动手用过的场景 —— 面试时这类描述会被追问到答不上来。',
  practiced: '你跟着教程或课程做过，但还没有独立产出。可以把它写进「待学习」，先做一个小产出去补上。',
  applied: '你在真实场景里用过，能说清做法。缺的是结果和可核对载体，补上就能升级成「有产出」。',
  delivered: '你能说清做法和结果，简历里的描述已经站得住。面试时准备好被追问细节与替代方案。',
  expert: '你不只做过，还能讲清不同方案的取舍和自身边界 —— 这类能力在简历里应当排在最前面。',
};

/** 确定性信号（全部由规则算出，可复算、可解释） */
export interface AssessmentSignals {
  /** 是否说清了具体场景（项目 / 公司 / 时间 / 对象） */
  specificity: number;
  /** 是否体现出使用深度（踩坑 / 调优 / 权衡 / 替代方案） */
  depth: number;
  /** 是否有结果与可核对载体（数字 / 链接 / 交付物） */
  output: number;
  /** 是否清楚自己的边界（能说出不确定的部分） */
  selfAwareness: number;
  /** 自评等级（0-4，由选择题换算） */
  selfReport: number;
  /**
   * v0.3 追加：这次问诊**有没有**问自评。
   *
   * 为什么必须单独记一个布尔值：
   * 软技能（沟通、协作、抗压）不再问「属于了解还是熟悉」—— 那种问法只能得到自我感觉，
   * 用户答「熟练」系统并不会多知道任何事实。但 `levelFromSignals()` 里有一条
   * 「自评不高且讲不出取舍 → 跟做过」的分支，若把「没问自评」当成「自评 = 0」，
   * 就会凭空把用户压低一档。所以「没问」与「答了最低档」必须能被区分开。
   */
  selfReportAsked: boolean;
  /**
   * 是否明确否认做过这件事（「没用过」「没做过」）。
   *
   * 必须有这个信号：用户自己说没做过、系统却根据场景词给出「实际用过」，
   * 是这类产品最不能犯的错。一旦命中，等级最高只能到「了解概念」。
   */
  denial: number;
}

export interface SkillAssessment {
  id: string;
  profileId: string;
  skillName: string;
  skillCategory: string;
  jobId?: string;
  jobTitle?: string;
  sessionId: string;

  level: SkillLevel;
  confidence: TriLevel;
  signals: AssessmentSignals;

  /** 一句话结论 */
  summary: string;
  /** 这次问诊里能站住的部分 */
  strengths: string[];
  /** 说不清 / 缺失的部分 */
  gaps: string[];
  /** 用户自己承认还不确定的部分（会进入待学习） */
  uncertainties: string[];

  /** 由这次问诊产出的证据 id（已在能力库里） */
  producedEvidenceIds: string[];
  /** 下一步动作（单一、可执行） */
  recommendedAction: string;
  /** 建议加入待学习的技能 */
  learnNext: string[];

  createdAt: string;
  engine: 'rule' | 'ai' | 'hybrid';
}

export const SELF_REPORT_OPTIONS = [
  '没接触过',
  '看过资料，但没动手',
  '跟着教程/课程做过',
  '独立做过完整的东西',
  '在正式工作里交付过',
];

/** 自评选项 → 0-4 分 */
export function selfReportScore(choiceIndex: number | undefined): number {
  if (typeof choiceIndex !== 'number' || choiceIndex < 0) return 0;
  return Math.min(choiceIndex, SELF_REPORT_OPTIONS.length - 1);
}

export function levelFromSignals(signals: AssessmentSignals): SkillLevel {
  // 用户明确说了「没做过」时，任何场景词都不能把等级抬上去
  if (signals.denial >= 1) return signals.selfReport >= 1 ? 'aware' : 'unverified';

  // 场景具体度 ≥ 2 才算「说清了使用场景」（见 skill-interview.ts 的 specificityScore：
  // 复述概念无论多长都拿不到 2 分，必须出现真实场景）
  const hasFact = signals.specificity >= 2;
  const deep = signals.depth >= 2;
  const hasDepth = signals.depth >= 1;
  const hasOutput = signals.output >= 1;

  // v0.3：没问自评时（软技能不走这道题），不能拿 selfReport === 0 当成「自评最低」
  const lowSelfReport = signals.selfReportAsked ? signals.selfReport <= 2 : false;

  if (!hasFact) return signals.selfReportAsked && signals.selfReport === 0 ? 'unverified' : 'aware';
  // 说得出场景、但自评不高且讲不出取舍 → 大概率是跟着教程做过
  if (lowSelfReport && !hasDepth) return 'practiced';
  if (hasOutput && deep) return 'expert';
  if (hasOutput) return 'delivered';
  return 'applied';
}

/** 等级是否足以支撑「这条能力可以写进简历」 */
export function levelIsSubstantive(level: SkillLevel): boolean {
  return level === 'applied' || level === 'delivered' || level === 'expert';
}

/** 等级 → 档案里的自评等级（用于让 finalizeProfile 的推导保持自洽） */
export function levelToSelfLevel(level: SkillLevel): '了解' | '熟悉' | '熟练' | '精通' | '未声明' {
  switch (level) {
    case 'delivered':
    case 'expert':
      return '熟练';
    case 'applied':
      return '熟悉';
    case 'practiced':
    case 'aware':
      return '了解';
    default:
      return '未声明';
  }
}
