/**
 * 薄弱项训练（v0.2）
 * ==================
 *
 * 训练项的来源不是随机题库，而是**这次匹配分析里真实没答上的那几条要求**：
 *   gap              → 连经历痕迹都没有 → 出「概念 + 最小产出」题
 *   lacking_evidence → 说过但拿不出产出 → 出「把做法讲清楚」题
 *   partial          → 沾边但不够       → 出「讲清取舍」题
 *
 * 所以训练计划和匹配报告是同一份数据推出来的，不会出现「练的东西和岗位无关」。
 */

import type { Assessment, TriLevel } from './common';

export type TrainingItemType = 'concept' | 'explain' | 'compare' | 'scenario' | 'self_check';

export const TRAINING_TYPE_LABEL: Record<TrainingItemType, string> = {
  concept: '概念',
  explain: '讲清楚',
  compare: '对比与取舍',
  scenario: '场景应用',
  self_check: '自查',
};

/** 训练项对应的薄弱类型，直接来自匹配结论 */
export type TrainingWeakness = Extract<Assessment, 'gap' | 'lacking_evidence' | 'partial'>;

export const TRAINING_WEAKNESS_LABEL: Record<TrainingWeakness, string> = {
  gap: '能力缺口',
  lacking_evidence: '缺少证据',
  partial: '证据不足',
};

/** 0=完全答不上 1=能说概念 2=能说清做法 3=能讲清取舍与结果 */
export type SelfScore = 0 | 1 | 2 | 3;

export const SELF_SCORE_LABEL: Record<SelfScore, string> = {
  0: '完全答不上来',
  1: '只能说出概念',
  2: '能说清做法',
  3: '能讲清取舍与结果',
};

export interface TrainingItem {
  id: string;
  type: TrainingItemType;
  skillName: string;
  skillCategory: string;
  weakness: TrainingWeakness;
  /** 来自哪条岗位要求（可回溯到原文） */
  requirementId?: string;
  requirementText?: string;
  importance: TriLevel;

  question: string;
  /**
   * 参考答复（v0.3 追加）。
   *
   * 与 `referencePoints` 的区别，这是用户明确提出要的东西：
   *   - referencePoints = 自查要点，回答**之前**看，告诉你要覆盖哪几块；
   *   - referenceAnswer = 一段**可以直接读的示例答复**，回答**之后**对照，
   *     让你看到「一个及格答案长什么样」，而不只是「你应该提到这四点」。
   *
   * 必须写清它是示例而不是标准答案：
   * 真实答案取决于用户自己的经历，系统给不出、也不该给唯一正解。
   * 这个字段不参与任何评分，只是让人有一个具体的参照物。
   */
  referenceAnswer?: string;
  /** 参考答案里哪些句子对应自查要点（用于 UI 并排对照） */
  referenceAnswerPoints?: string[];
  /** 参考答案出处：本地知识库模板 / 模型生成 */
  referenceAnswerOrigin?: 'rule' | 'ai';
  /** 参考答案要点（自查用，不是标准答案） */
  referencePoints: string[];
  /** 追问：如果这题答得顺，面试官大概率会接着问什么 */
  followUp?: string;

  userAnswer?: string;
  selfScore?: SelfScore;
  /**
   * v0.6：这次回答判定为通过的时间。
   *
   * 之前只有 `status` 一个单向状态机（todo → answered → reviewed），
   * 没有「练到达标」的概念，也就无从判断该不该重跑匹配。
   */
  passedAt?: string;
  /**
   * v0.6：这次回答产出的证据 id（已写进能力库）。
   *
   * **这个字段是这个产品真闭环的关键** ——
   * 在它出现之前，`TrainingItem` 与能力库之间没有任何连接，
   * 用户练完的答案只是 trainingPlans 里的一段文本，
   * 匹配结论永远不会因为「练了」而变化。训练页却写着「练完去重跑匹配」，
   * 那是一个必然让人失望的假闭环。
   *
   * 与 `SkillAssessment.producedEvidenceIds` 语义一致，
   * 两者都是「这次操作往档案里写了什么」的追溯凭据。
   */
  evidenceIds?: string[];
  /** v0.6：这一题已经追问过几轮 */
  followUpCount?: number;
  /** v0.6：最近一次判定没过的原因（给用户看「还差哪」而不是让他猜） */
  lastJudgeHeadline?: string;
  /**
   * v0.6：用户选择「先放着」。
   *
   * 没练过的题不能删 —— 删了就等于告诉用户「你写的这段没用」，
   * 那正是最不该让他感到的。所以只标一个状态和原因，答案本身留着。
   */
  parked?: { reason: string; at: string };
  status: 'todo' | 'answered' | 'reviewed' | 'passed' | 'parked';
  updatedAt: string;
}

export interface TrainingPlan {
  id: string;
  schemaVersion: number;
  profileId: string;
  jobId: string;
  jobTitle: string;
  createdAt: string;
  updatedAt: string;
  items: TrainingItem[];
  stats: {
    total: number;
    todo: number;
    answered: number;
    reviewed: number;
    /** v0.6：判定通过的训练题数 */
    passed: number;
    /** v0.6：用户选择「先放着」的题数 */
    parked: number;
    /** 自评平均分（0-3），没有作答时为 null */
    averageScore: number | null;
  };
  /** 计划里各类薄弱项的条数，让用户知道自己在补什么 */
  source: Record<TrainingWeakness, number>;
  engine: 'rule' | 'ai' | 'hybrid';
  /** 训练完成后的建议：是否值得重新跑一次匹配 */
  suggestedNextStep: string;
}

export function computePlanStats(items: TrainingItem[]): TrainingPlan['stats'] {
  const todo = items.filter((i) => i.status === 'todo').length;
  const answered = items.filter((i) => i.status === 'answered').length;
  const reviewed = items.filter((i) => i.status === 'reviewed').length;
  const passed = items.filter((i) => i.status === 'passed').length;
  const parked = items.filter((i) => i.status === 'parked').length;
  const scored = items.filter((i) => typeof i.selfScore === 'number');
  return {
    total: items.length,
    todo,
    answered,
    reviewed,
    passed,
    parked,
    averageScore: scored.length > 0
      ? Math.round((scored.reduce((sum, i) => sum + (i.selfScore as number), 0) / scored.length) * 10) / 10
      : null,
  };
}

/**
 * 新一次作答是否让之前「达标」的题又变回未达标。
 *
 * 为什么要重新判定：用户达标之后可能又改了答案。改了答案就该重新算，
 * 否则会出现「界面上显示通过，但档案里存的是他改之前那段内容」的错位。
 */
export function answerInvalidatesPass(item: TrainingItem): boolean {
  return item.status === 'passed' && !item.passedAt;
}

export const SELF_SCORE_OPTIONS: Array<{ value: SelfScore; label: string }> = [
  { value: 0, label: SELF_SCORE_LABEL[0] },
  { value: 1, label: SELF_SCORE_LABEL[1] },
  { value: 2, label: SELF_SCORE_LABEL[2] },
  { value: 3, label: SELF_SCORE_LABEL[3] },
];
