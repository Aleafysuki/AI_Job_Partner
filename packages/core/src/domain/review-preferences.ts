/**
 * 用户决策偏好（v0.6）
 * ======================
 *
 * 三个原本是「开发时必须拍板」的问题，这里改成**用户自己决定**：
 *
 *   1. 问诊结论什么时候算「过时」—— 时间维度最简单但最武断，
 *      因为三个月前答得不好不代表现在想改口，三天前答得很好也不代表不会变。
 *      事实维度（岗位变了 / 用户主动标）没有这个问题。
 *   2. 审核界面一屏展示还是分页—— 取决于 AI 拆分粒度，
 *      而拆分粒度依赖模型表现，不同 provider 差别很大，写死在代码里是猜。
 *   3. 训练判定要不要让用户看到判据—— 「不判定对错」是这个产品对训练的立场，
 *      但「我帮你指出这句里没有具体场景」和「我给你打个分」不是一回事。
 *      看到判据更像前者，不看到更像后者。让用户自己权衡。
 *
 * 为什么放在设置里而不是硬编码：
 * 这三条没有一条是「哪种都对」的，它们是**价值取舍**。
 * 开发替用户选，等于替用户表态。
 */

/** 结论过时的判定方式 */
export type StalePolicy =
  /** 只看事实：岗位要求变了、或用户手动标为想改口。时间不参与。 */
  | 'by_change'
  /** 事实优先，但同一技能的结论超过 N 天也算过时 */
  | 'by_change_and_age'
  /** 只要问过就永远不过时，最省心 */
  | 'never';

/** 审核界面的展开方式 */
export type ReviewLayout =
  /** 一屏全部展示并排对照 */
  | 'inline'
  /** 每次展开一条，逐条确认 */
  | 'stepwise';

export interface ReviewPreferences {
  stalePolicy: StalePolicy;
  /** by_change_and_age 时生效：多少天算过时 */
  staleAfterDays: number;
  reviewLayout: ReviewLayout;
  /**
   * 训练判定是否展示判据。
   *
   * 注意这个开关**只管显不显示判据**，不管判不判 ——
   * 判定永远会发生（否则「练到达标」无从谈起），关掉的只是解释。
   * 理由见上方注释：不显示判据不等于不判定，那只是把判定藏起来，
   * 那才是真的骗人。
   */
  showJudgeReason: boolean;
}

export const DEFAULT_REVIEW_PREFERENCES: ReviewPreferences = {
  stalePolicy: 'by_change',
  staleAfterDays: 90,
  reviewLayout: 'stepwise',
  showJudgeReason: true,
};

export const STALE_POLICY_LABEL: Record<StalePolicy, string> = {
  by_change: '只在内容变了的时候提示',
  by_change_and_age: '内容变了或者放太久了都提示',
  never: '问过就一直算数，不再提示',
};

export const STALE_POLICY_WHY: Record<StalePolicy, string> = {
  by_change:
    '岗位要求变了、或者你自己标了「想重答」，系统才会提示重问。' +
    '不问时间是因为——三个月前答得不好不代表你现在想改口。',
  by_change_and_age:
    '在「内容变了」的基础上，加一条时间线：同一个技能的结论超过设定天数后，' +
    '系统会问你要不要重答一次。时间只是提醒，不会自动改写你的档案。',
  never:
    '只要问过就一直算数，不会再提醒你重问。适合你已经很清楚自己能力、不想被打扰的情况。',
};

export const REVIEW_LAYOUT_LABEL: Record<ReviewLayout, string> = {
  inline: '全部列出来，一屏看完',
  stepwise: '一次看一条，逐条确认',
};

export const REVIEW_LAYOUT_WHY: Record<ReviewLayout, string> = {
  inline:
    '所有条目一次列出，便于你上下扫一遍统一决定。条目多时页面会比较长。',
  stepwise:
    '每次只出现一条，确认或跳过再进下一条。条目多时更省力，但不好回头比较。',
};

export function normalizeReviewPreferences(
  raw: Partial<ReviewPreferences> | null | undefined,
): ReviewPreferences {
  const d = DEFAULT_REVIEW_PREFERENCES;
  if (!raw) return { ...d };
  const policy = raw.stalePolicy;
  return {
    stalePolicy: policy === 'by_change_and_age' || policy === 'never' ? policy : d.stalePolicy,
    staleAfterDays:
      typeof raw.staleAfterDays === 'number' && Number.isFinite(raw.staleAfterDays) && raw.staleAfterDays > 0
        ? Math.round(raw.staleAfterDays)
        : d.staleAfterDays,
    reviewLayout: raw.reviewLayout === 'inline' ? 'inline' : d.reviewLayout,
    showJudgeReason: typeof raw.showJudgeReason === 'boolean' ? raw.showJudgeReason : d.showJudgeReason,
  };
}
