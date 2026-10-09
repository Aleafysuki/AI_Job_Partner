import type { Assessment, TriLevel } from './common';

/**
 * 面试复盘（v0.2 追加需求）
 * =========================
 *
 * 要解决的问题：当面 / 线上的面试说完就过去了，事后只剩一个模糊印象 ——
 * 「感觉还行」「有几个问题没答好」，但说不清到底哪里没答好、岗位到底是不是自己想的那样。
 *
 * 这条链路把「面试过程」变成可复核的材料：
 *
 *   现场/线上录音 → 分段转写 → 去标识化 → 原子事实抽取
 *     → 机会侧 12 维（这岗位实际是什么样）
 *     → 表现侧 6 维（我答得怎么样）
 *     → 岗位适配度评定（我能不能稳定做下去）
 *     → 唯一下一步动作
 *
 * 三条不能破的边界（写在类型注释里，因为这是产品承诺而不是文档措辞）：
 *
 * 1. **只做复盘，不做实时提示。** 面试进行中不产生任何界面输出 ——
 *    录音与转写只落盘。系统不会、也不应该在被问到的当下给用户递答案。
 * 2. **录音期间不弹任何提示。** 静默模式下面试过程零 UI 干扰（见 `quiet`）。
 * 3. **结论只用录音里出现过的话。** 推不出来的写 `unknown`，不拿常识补全 ——
 *    这条与 `multi-dimension-fit-report` 框架的纪律一致。
 */

// ---------------------------------------------------------------------------
// 采集侧
// ---------------------------------------------------------------------------

/** 面试形态：面对面只看麦克风；线上再叠一路系统内录，把对方的声音也收进来 */
export type DebriefMode = 'onsite' | 'online';

export const DEBRIEF_MODE_LABEL: Record<DebriefMode, string> = {
  onsite: '面对面面试',
  online: '线上面试',
};

export interface DebriefAudioSources {
  /** 麦克风 —— 录到用户自己的声音（两种形态都需要） */
  mic: boolean;
  /**
   * 系统内录（loopback）—— 录到对方从扬声器出来的声音。
   * 线上面试时两路都开，才能拿到完整对话；只开麦克风会丢掉面试官那一半。
   */
  system: boolean;
}

export type CaptureSegmentStatus = 'pending' | 'transcribing' | 'done' | 'failed' | 'skipped';

/**
 * 一段录音切片。
 *
 * 为什么分段而不是录一整个文件：浏览器侧的 MediaRecorder 只有第一段带头信息，
 * 后续 timeslice 分片单独拿去解码会失败。所以每段用独立的 MediaRecorder 录制，
 * 既保证每段都能独立解码/送转写，也能让转写在面试过程中就滚动进行。
 */
export interface CaptureSegment {
  /** 0 起的序号，同时决定文件名 seg-0001 */
  index: number;
  fileName: string;
  /** 相对会话开始的毫秒偏移，用于把转写结果对回时间轴 */
  startOffsetMs: number;
  durationMs: number;
  bytes: number;
  status: CaptureSegmentStatus;
  /** 转写失败原因（只影响这一段，不影响整场） */
  error?: string;
}

export type Speaker = 'interviewer' | 'candidate' | 'unknown';

export const SPEAKER_LABEL: Record<Speaker, string> = {
  interviewer: '面试方',
  candidate: '我',
  unknown: '未区分',
};

/**
 * 一条转写结果。
 *
 * `speaker` 在单话筒录音里是推断出来的（靠提问/作答的语用特征），
 * 因此 UI 必须允许用户手工改正 —— 标错说话人会连带影响表现侧评分。
 */
export interface TranscriptTurn {
  id: string;
  segmentIndex: number;
  startOffsetMs: number;
  endOffsetMs: number;
  speaker: Speaker;
  text: string;
  source: 'asr' | 'manual';
}

export type DebriefSessionStatus =
  | 'recording'
  | 'paused'
  | 'transcribing'
  | 'ready'
  | 'analyzed'
  | 'failed';

export const DEBRIEF_SESSION_STATUS_LABEL: Record<DebriefSessionStatus, string> = {
  recording: '录制中',
  paused: '已暂停',
  transcribing: '转写中',
  ready: '待复盘',
  analyzed: '已复盘',
  failed: '录制异常',
};

export interface InterviewDebriefSession {
  id: string;
  schemaVersion: number;
  profileId: string;
  /** 这场面试对应的岗位（可能还没录入 JD，那就只做表现复盘） */
  jobId?: string;
  jobTitle?: string;

  mode: DebriefMode;
  sources: DebriefAudioSources;

  /**
   * 静默录制。
   *
   * 打开后录制期间：不弹 toast / 不弹窗 / 不弹系统通知 / 不改窗口标题 /
   * 不动托盘图标 / 不抢焦点，主窗口可以直接最小化。
   * 面试过程中界面上不出现任何「正在录音」的可见信号。
   */
  quiet: boolean;

  status: DebriefSessionStatus;

  startedAt: string;
  endedAt?: string;
  durationMs: number;

  segments: CaptureSegment[];
  turns: TranscriptTurn[];

  /** 手工粘贴/导入的整段转写（没有 ASR 时的降级路径，也是最短可用路径） */
  manualTranscript?: string;
  /** 用户自己的补充备注（面试官几次打断、当时的状态等） */
  notes: string;

  transcribeError?: string;

  createdAt: string;
  updatedAt: string;
}

export function createEmptyDebriefSession(
  profileId: string,
  options: Partial<Pick<InterviewDebriefSession, 'mode' | 'sources' | 'quiet' | 'jobId' | 'jobTitle'>> = {},
): InterviewDebriefSession {
  const now = new Date().toISOString();
  const mode: DebriefMode = options.mode ?? 'onsite';
  return {
    id: '',
    schemaVersion: 1,
    profileId,
    jobId: options.jobId,
    jobTitle: options.jobTitle,
    mode,
    sources: options.sources ?? { mic: true, system: mode === 'online' },
    quiet: options.quiet ?? true,
    status: 'ready',
    startedAt: now,
    durationMs: 0,
    segments: [],
    turns: [],
    notes: '',
    createdAt: now,
    updatedAt: now,
  };
}

/** 把会话里的可用文本拼成一份转写（ASR 结果优先，其次手工粘贴） */
export function sessionTranscript(session: InterviewDebriefSession): string {
  if (session.turns.length > 0) {
    return session.turns
      .slice()
      .sort((a, b) => a.startOffsetMs - b.startOffsetMs)
      .map((t) => `【${SPEAKER_LABEL[t.speaker]}】${t.text}`)
      .join('\n');
  }
  return (session.manualTranscript ?? '').trim();
}

/** 会话进度摘要（界面与报告 meta 都用它） */
export function sessionStats(session: InterviewDebriefSession) {
  const done = session.segments.filter((s) => s.status === 'done').length;
  return {
    segmentCount: session.segments.length,
    transcribedCount: done,
    failedCount: session.segments.filter((s) => s.status === 'failed').length,
    turnCount: session.turns.length,
    charCount: sessionTranscript(session).length,
    durationMs: session.durationMs,
  };
}

// ---------------------------------------------------------------------------
// 分析侧：通用刻度
// ---------------------------------------------------------------------------

/** 结论依据：对方明说 / 从描述推断。两者不得混写在同一句里 */
export type DebriefBasis = 'stated' | 'inferred';

export const DEBRIEF_BASIS_LABEL: Record<DebriefBasis | 'mixed', string> = {
  stated: '原话',
  inferred: '推断',
  mixed: '原话 + 推断',
};

export type DebriefDimStatus = 'ok' | 'partial' | 'insufficient_info';

export const DEBRIEF_DIM_STATUS_LABEL: Record<DebriefDimStatus, string> = {
  ok: '证据充分',
  partial: '部分可判',
  insufficient_info: '证据不足',
};

export type DebriefPressureLevel = 'low' | 'medium' | 'high' | 'unknown';

export const DEBRIEF_PRESSURE_LABEL: Record<DebriefPressureLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  unknown: '信息不足',
};

/** 压力等级 → 雷达图数值。unknown 必须留 null，不允许用均值填充 */
export function pressureToScore(level: DebriefPressureLevel): number | null {
  return { low: 2, medium: 3, high: 5, unknown: null }[level];
}

export type DebriefEvidenceType = 'claim' | 'fact' | 'number' | 'promise' | 'evasion';

export const DEBRIEF_EVIDENCE_TYPE_LABEL: Record<DebriefEvidenceType, string> = {
  claim: '主张',
  fact: '事实',
  number: '数字',
  promise: '承诺',
  evasion: '回避',
};

export type DebriefTopic =
  | 'workload'
  | 'pay'
  | 'schedule'
  | 'content'
  | 'environment'
  | 'requirement'
  | 'performance'
  | 'other';

export const DEBRIEF_TOPIC_LABEL: Record<DebriefTopic, string> = {
  workload: '工作量',
  pay: '薪酬',
  schedule: '时间与排班',
  content: '工作内容',
  environment: '环境与关系',
  requirement: '要求与门槛',
  performance: '面试表现',
  other: '其他',
};

/** 原子事实：一句一事实，quote 原样摘录 */
export interface DebriefEvidence {
  id: string;
  quote: string;
  speaker: Speaker;
  type: DebriefEvidenceType;
  topic: DebriefTopic;
  consistency: 'unique' | 'conflicting';
  note?: string;
}

export interface DebriefFinding {
  text: string;
  basis: DebriefBasis;
  /** 不得为空 —— 没有证据可挂的结论不许写 */
  evidenceIds: string[];
}

export type DebriefQuestionCategory =
  | 'workload_kpi'
  | 'pay_benefit'
  | 'time_shift'
  | 'environment_content'
  | 'org_position'
  | 'self_improve';

export const DEBRIEF_QUESTION_CATEGORY_LABEL: Record<DebriefQuestionCategory, string> = {
  workload_kpi: '关于工作量和 KPI',
  pay_benefit: '关于薪酬和福利',
  time_shift: '关于工作时间和排班',
  environment_content: '关于工作环境和内容',
  org_position: '关于组织和岗位',
  self_improve: '关于我自己的表达改进',
};

export interface DebriefQuestion {
  text: string;
  priority: TriLevel;
  category: DebriefQuestionCategory;
  /** 指向产生该问题的维度：D1–D12（机会）或 P1–P6（表现） */
  targets?: string;
}

export interface DebriefComputation {
  formula: string;
  inputs: Record<string, number | string | null>;
  result: Record<string, number | string | null>;
  verdict: string;
}

export type DebriefDimensionKind = 'opportunity' | 'performance';

/**
 * 维度结果。机会侧（D*）与表现侧（P*）共用同一个形状 ——
 * 这样报告渲染、校验、雷达图都只需要一套逻辑。
 */
export interface DebriefDimension {
  /** D1–D12 / P1–P6 */
  id: string;
  kind: DebriefDimensionKind;
  key: string;
  name: string;
  goal: string;

  status: DebriefDimStatus;
  basis: DebriefBasis | 'mixed';
  /** 该维度的一句话结论（先结论后依据） */
  verdictLine: string;

  findings: DebriefFinding[];
  /** 各维度专属结构（实态流程、压力等级表、清单结果等） */
  extras: Record<string, unknown>;
  computation?: DebriefComputation | null;
  /** 量表取值只能在 dimensions 定义范围内；不足为 null */
  scores: Record<string, number | null | DebriefPressureLevel>;

  unknowns: string[];
  questions: DebriefQuestion[];
  evidenceIds: string[];
}

// ---------------------------------------------------------------------------
// 分析侧：表现总评
// ---------------------------------------------------------------------------

export type PerformanceOverall = 'excellent' | 'good' | 'fair' | 'weak' | 'insufficient';

export const PERFORMANCE_OVERALL_LABEL: Record<PerformanceOverall, string> = {
  excellent: '讲得清楚且有实证',
  good: '基本讲清楚，个别处偏虚',
  fair: '说到了，但停在概念层',
  weak: '多数回答缺少可核对的事实',
  insufficient: '可用回答太少，无法判断',
};

/**
 * 面试表现总评。
 *
 * 刻意不给「综合得分」：表现好坏的可解释部分全在 6 个维度里，
 * 挤成一个数字只会让人拿去和别人比，而比不了。
 */
export interface InterviewPerformanceSummary {
  overall: PerformanceOverall;
  strengths: string[];
  weaknesses: string[];
  /** 可改进项：每条给出「动作」，不是「建议加强沟通能力」这类空话 */
  improvable: Array<{ point: string; howTo: string; evidenceIds: string[] }>;
  /** 我方的回答轮数 */
  answerTurns: number;
  /** 其中含具体事实（数字 / 时间 / 动作 / 交付物）的轮数 */
  factBackedTurns: number;
  /** 只有形容词与概念的轮数 */
  vagueTurns: number;
}

// ---------------------------------------------------------------------------
// 分析侧：岗位适配度评定
// ---------------------------------------------------------------------------

export interface DebriefFitItem {
  key: string;
  label: string;
  /** 1–5，证据不足为 null（禁止用中位数填充） */
  score: number | null;
  reason: string;
  /** 是否踩到了当事人自己写下的心理边界 */
  touchedBoundary: boolean;
}

export interface DebriefFitAssessment {
  status: DebriefDimStatus;
  /** 结论是接着已有匹配报告算的，还是只凭这场面试算的 */
  basedOn: 'match_report' | 'interview_only';
  matchReportId?: string;
  /** 复用项目的五档结论，不新造刻度 */
  overallVerdict: Assessment | null;
  summary: string;
  items: DebriefFitItem[];
  boundaryHits: string[];
}

// ---------------------------------------------------------------------------
// 分析侧：综合与决策
// ---------------------------------------------------------------------------

export type DebriefTier = 'consider' | 'caution' | 'mismatch' | 'insufficient';

export const DEBRIEF_TIER_LABEL: Record<DebriefTier, string> = {
  consider: '可以考虑',
  caution: '需要谨慎',
  mismatch: '明显不匹配',
  insufficient: '当前信息不足以归类',
};

export interface DebriefScenario {
  key: 'A' | 'B' | 'C';
  label: string;
  points: Array<{ field: string; text: string }>;
}

export interface DebriefDecisionTier {
  key: 'consider' | 'caution' | 'mismatch';
  label: string;
  conditions: string[];
}

export interface DebriefSynthesis {
  oneLine: string;
  tier: DebriefTier;
  verdictParagraph: string;
  highlights: Array<{ text: string; evidenceIds: string[] }>;
  scenarios: DebriefScenario[];
  decisionTable: DebriefDecisionTier[];
  /** 有且仅有一个动作 */
  nextAction: string;
  boundaryStatement: string;
}

export const DEBRIEF_BOUNDARY_STATEMENT =
  '本报告不替你做决定，只把做决定所需的信息整理清楚。它描述的是「录音里能听到的内容」，面试官的实际评价不在其中。';

export interface DebriefRadarSeries {
  axis: string;
  value: number | null;
}

export interface DebriefTable {
  formula: string;
  rows: Array<Record<string, number | string | null>>;
  verdict: string;
}

export interface DebriefCharts {
  pressure: DebriefRadarSeries[];
  fit: DebriefRadarSeries[];
  performance: DebriefRadarSeries[];
  workloadTime: DebriefTable | null;
  compensation: DebriefTable | null;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

export const DEBRIEF_SCHEMA_VERSION = 1;

export interface InterviewDebriefReport {
  id: string;
  schemaVersion: number;
  createdAt: string;
  domain: 'interview-debrief';

  sessionId: string;
  profileId: string;
  jobId?: string;
  jobTitle?: string;

  meta: {
    title: string;
    mode: DebriefMode;
    sources: DebriefAudioSources;
    quiet: boolean;
    durationMs: number;
    anonymized: boolean;
    confidence: TriLevel;
    transcriptChars: number;
    speakers: Speaker[];
    /** full = 完整对话；partial = 缺一方或部分段落；fragment = 只有片段 */
    completeness: 'full' | 'partial' | 'fragment';
    limitations: string[];
    engine: 'rule' | 'ai' | 'hybrid';
  };

  evidence: DebriefEvidence[];
  dimensions: DebriefDimension[];
  performance: InterviewPerformanceSummary;
  fit: DebriefFitAssessment;
  charts: DebriefCharts;
  synthesis: DebriefSynthesis;
  questions: DebriefQuestion[];

  disclaimer: string;
}

export const DEBRIEF_DISCLAIMER =
  '本报告由录音转写推导而来，只反映「录音里能听到的内容」。转写可能出错，说话人也可能被识别错，重要结论请回看原始录音确认。报告不评价面试官，也不预测面试结果。';

/** 复盘报告里证据编号的统一前缀，渲染与校验都依赖它 */
export const DEBRIEF_EVIDENCE_PREFIX = 'E';

export function isDebriefEvidenceId(id: string): boolean {
  return new RegExp(`^${DEBRIEF_EVIDENCE_PREFIX}[0-9]+$`).test(id);
}

/** 表现侧维度的 id 前缀，用于区分两组维度的展示顺序 */
export const PERFORMANCE_DIMENSION_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

export function isPerformanceDimension(id: string): boolean {
  return PERFORMANCE_DIMENSION_IDS.includes(id);
}
