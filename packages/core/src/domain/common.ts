/** 全领域共享的基础类型 */

/** 数据来源定位：任何 AI 结论都要能回答「依据在哪里」 */
export interface SourceRef {
  /** 来源类型 */
  kind: 'resume' | 'jd' | 'user' | 'ai' | 'import';
  /** 人类可读的定位，例如「岗位原文第 4 条」「简历 - 项目经历 第 2 段」 */
  locator: string;
  /** 原文片段（截断），用于回查 */
  excerpt: string;
}

export function emptySource(kind: SourceRef['kind'] = 'user', locator = '用户手动录入'): SourceRef {
  return { kind, locator, excerpt: '' };
}

/**
 * 匹配结论 —— 严格对齐产品文档第七节的五种输出，
 * 刻意不使用「分数」，避免虚假精确感。
 */
export type Assessment = 'matched' | 'partial' | 'lacking_evidence' | 'gap' | 'unknown';

export const ASSESSMENT_LABEL: Record<Assessment, string> = {
  matched: '满足',
  partial: '部分满足',
  lacking_evidence: '缺少证据',
  gap: '明显缺口',
  unknown: '无法判断',
};

export const ASSESSMENT_ORDER: Assessment[] = ['matched', 'partial', 'lacking_evidence', 'gap', 'unknown'];

export type TriLevel = 'high' | 'medium' | 'low';

export const IMPORTANCE_LABEL: Record<TriLevel, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/** 证据强度 —— 整个系统的核心刻度 */
export type EvidenceStrength = 'strong' | 'medium' | 'weak' | 'none';

export const STRENGTH_LABEL: Record<EvidenceStrength, string> = {
  strong: '强',
  medium: '中',
  weak: '弱',
  none: '无',
};

export function strengthRank(s: EvidenceStrength): number {
  return { none: 0, weak: 1, medium: 2, strong: 3 }[s];
}

export function maxStrength(list: EvidenceStrength[]): EvidenceStrength {
  if (list.length === 0) return 'none';
  return list.reduce((acc, cur) => (strengthRank(cur) > strengthRank(acc) ? cur : acc), 'none' as EvidenceStrength);
}
