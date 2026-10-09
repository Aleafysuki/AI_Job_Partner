import type { EvidenceStrength, SourceRef } from './common';

/**
 * 证据（Evidence）—— 本系统最重要的概念。
 *
 * 文档第四节：系统必须区分
 *   自我声明（Self Claim） → 是否有证据 → 证据来源 → 证据强度
 * 从而避免因为用户写了「精通 Python」就直接判定其精通 Python。
 */

export type EvidenceKind =
  | 'project'      // 项目证据
  | 'work'         // 工作经历证据
  | 'education'    // 教育背景证据
  | 'certificate'  // 证书 / 资格
  | 'competition'  // 竞赛 / 获奖
  | 'open_source'  // 开源 / 作品链接
  | 'metric'       // 可量化结果
  | 'self_claim'   // 纯自我声明（无外部支撑）
  | 'other';

export const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  project: '项目',
  work: '工作经历',
  education: '教育背景',
  certificate: '证书',
  competition: '竞赛/获奖',
  open_source: '开源/作品',
  metric: '量化结果',
  self_claim: '自我声明',
  other: '其他',
};

/** 弱证据不参与「满足」判定，只作为「部分满足」的支撑 */
export const EVIDENCE_KINDS_WEAK: EvidenceKind[] = ['self_claim'];

/**
 * 证据来源渠道。
 *
 * v0.2 新增 `qa`（能力问诊）：用户通过问答补充的产出。
 * 之所以要单独标出来，是因为它和简历、手工录入的「可核对载体」性质不同 ——
 * 问诊是**自述**，没有外部可核对物，因此强度会被封顶（见 MAX_STRENGTH_BY_ORIGIN）。
 */
export type EvidenceOrigin = 'resume' | 'qa' | 'manual' | 'import';

export const EVIDENCE_ORIGIN_LABEL: Record<EvidenceOrigin, string> = {
  resume: '简历解析',
  qa: '能力问诊',
  manual: '手工补录',
  import: '导入',
};

/**
 * 各来源渠道允许达到的最高强度。
 *
 * 这是 v0.2 的一条硬规则：问诊结论无论写得多具体，都只能到「中」。
 * 理由：证据强度衡量的是「这条经历能不能被外部核对」，自述永远无法自证；
 * 一旦允许问诊产出「强」证据，产品就等于自己废掉了 v0.1 立下的判断标准。
 * 想升级到「强」只有一条路：补上链接、数字、时间这类可核对的载体。
 */
export const MAX_STRENGTH_BY_ORIGIN: Record<EvidenceOrigin, EvidenceStrength> = {
  resume: 'strong',
  manual: 'strong',
  import: 'strong',
  qa: 'medium',
};

export function capStrengthByOrigin(
  strength: EvidenceStrength,
  origin: EvidenceOrigin,
): { strength: EvidenceStrength; capped: boolean } {
  const cap = MAX_STRENGTH_BY_ORIGIN[origin] ?? 'strong';
  const rank: Record<EvidenceStrength, number> = { none: 0, weak: 1, medium: 2, strong: 3 };
  if (rank[strength] <= rank[cap]) return { strength, capped: false };
  return { strength: cap, capped: true };
}

export interface CandidateEvidence {
  id: string;
  kind: EvidenceKind;
  /** 证据标题，例如「网页采集工具」 */
  title: string;
  /** 证据内容描述 */
  content: string;
  /** 该证据支撑的归一化技能名 */
  skills: string[];
  /** 可量化结果，例如「每天约 800 条数据」「准确率 92%」 */
  metrics: string[];
  /** 可外部验证的链接：GitHub / 线上地址 / 作品集 */
  links: string[];
  timeRange?: string;
  /** 系统评估的证据强度 —— 用户可修正 */
  strength: EvidenceStrength;
  /** 为什么是这个强度（可解释） */
  strengthReason: string;
  /** 来源渠道（v0.2 起用于区分简历证据与问诊证据） */
  origin: EvidenceOrigin;
  /** 这条证据是在分析哪个岗位时补充的，用于展示「跨岗位积累」 */
  fromJobTitle?: string;
  sourceRef: SourceRef;
  /** 是否被用户修改过（AI 不是最终数据拥有者） */
  editedByUser: boolean;
  createdAt: string;
  updatedAt: string;
}

export function computeEvidenceStrength(input: {
  kind: EvidenceKind;
  content: string;
  metrics: string[];
  links: string[];
  hasTimeRange: boolean;
  /** 不传按 resume 处理（保持 v0.1 调用方无需修改） */
  origin?: EvidenceOrigin;
}): { strength: EvidenceStrength; reason: string } {
  const origin: EvidenceOrigin = input.origin ?? 'resume';
  const reasons: string[] = [];

  if (input.kind === 'self_claim') {
    reasons.push('来源是自我声明，没有可核对的载体');
    return { strength: 'weak', reason: reasons.join('；') };
  }

  let score = 0;
  if (input.kind === 'project' || input.kind === 'work') {
    score += 2;
    reasons.push('属于项目/工作经历类证据');
  } else if (input.kind === 'open_source' || input.kind === 'competition' || input.kind === 'certificate') {
    score += 2;
    reasons.push('属于可外部核对的成果类证据');
  } else if (input.kind === 'education' || input.kind === 'metric') {
    score += 1;
    reasons.push('属于背景/结果类证据');
  }

  if (input.metrics.length > 0) {
    score += 1;
    reasons.push(`包含 ${input.metrics.length} 项量化结果`);
  } else {
    reasons.push('缺少量化结果');
  }

  if (input.links.length > 0) {
    score += 1;
    reasons.push('提供可访问的链接');
  }

  if (input.hasTimeRange) {
    score += 1;
    reasons.push('标注了时间范围');
  }

  // 描述过短说明信息量不足
  if (input.content.replace(/\s/g, '').length < 24) {
    score -= 1;
    reasons.push('描述过短，无法判断具体做了什么');
  }

  // 口径说明（与 docs/DATA_MODEL.md 保持一致）：
  //   满分 5（类型 +2、量化 +1、链接 +1、时间 +1），描述过短再扣 1。
  //   strong 需要「类型 + 量化结果 + 时间范围」三者齐备（=4），
  //   因为能说清「什么时候做的、做出了什么数字」的经历才算真正立得住；
  //   只有类型 + 量化（=3）算 medium。
  let strength: EvidenceStrength = 'medium';
  if (score >= 4) strength = 'strong';
  else if (score >= 3) strength = 'medium';
  else if (score >= 1) strength = 'weak';
  else strength = 'none';

  const capped = capStrengthByOrigin(strength, origin);
  if (capped.capped) {
    reasons.push(`来源是${EVIDENCE_ORIGIN_LABEL[origin]}，属于自述，强度封顶为「中」`);
    strength = capped.strength;
  } else {
    strength = capped.strength;
  }

  return { strength, reason: reasons.join('；') };
}
