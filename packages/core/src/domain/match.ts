import type { Assessment, EvidenceStrength, TriLevel } from './common';
import type { EvidenceKind, EvidenceOrigin } from './evidence';
import type { RequirementType } from './job';

/**
 * MatchResult —— 系统内部的第三类核心数据。
 * 单位不是「关键词」，而是 Requirement → Evidence → Assessment。
 */

export interface EvidenceHit {
  evidenceId: string;
  kind: EvidenceKind;
  title: string;
  content: string;
  strength: EvidenceStrength;
  /**
   * 证据来源渠道。
   * 报告里要能一眼看出「这条结论是简历里写过的，还是问诊时补的」——
   * 两者的可信度不同，不能混在一起给人看。
   */
  origin: EvidenceOrigin;
  /** 该证据是怎么和这条要求关联上的 */
  linkReason: string;
}

/** 可解释性：结论命中了哪条规则 / 模型给了什么理由 */
export interface ExplainStep {
  rule: string;
  detail: string;
}

export interface RequirementMatch {
  id: string;
  requirementId: string;
  requirement: string;
  original: string;
  type: RequirementType;
  importance: TriLevel;
  hardGate: boolean;

  /** 支撑这条要求的证据（可能为空） */
  evidence: EvidenceHit[];
  matchedSkills: string[];
  missingSkills: string[];

  assessment: Assessment;
  confidence: TriLevel;
  /** 为什么是这个判断 */
  reason: string;
  /** 下一步行动（文档：Action）。null 表示无需行动 */
  action: string | null;
  /** 判定依据链，UI 可展开查看 */
  explain: ExplainStep[];
}

export interface MatchSummary {
  total: number;
  matched: number;
  partial: number;
  lackingEvidence: number;
  gap: number;
  unknown: number;
}

/** 重点补强建议（文档：用户最需要知道「接下来具体应该改什么」） */
export interface PriorityAction {
  title: string;
  why: string;
  how: string;
  requirementIds: string[];
  effort: TriLevel;
}

export interface MatchResult {
  id: string;
  schemaVersion: number;
  createdAt: string;

  profileId: string;
  /** 记录匹配时档案的版本，档案更新后可以提示「结论已过期」 */
  profileUpdatedAt: string;
  jobId: string;

  matches: RequirementMatch[];
  summary: MatchSummary;
  priorities: PriorityAction[];
  riskNotes: string[];
  /** 用的是哪条引擎链路产出结论 */
  engine: 'rule' | 'ai' | 'hybrid';
  /** 是否使用了模型（用于透明度展示） */
  usedModel: boolean;
}

export function emptySummary(): MatchSummary {
  return { total: 0, matched: 0, partial: 0, lackingEvidence: 0, gap: 0, unknown: 0 };
}

export function summarize(matches: RequirementMatch[]): MatchSummary {
  const s = emptySummary();
  s.total = matches.length;
  for (const m of matches) {
    switch (m.assessment) {
      case 'matched': s.matched += 1; break;
      case 'partial': s.partial += 1; break;
      case 'lacking_evidence': s.lackingEvidence += 1; break;
      case 'gap': s.gap += 1; break;
      case 'unknown': s.unknown += 1; break;
      default: break;
    }
  }
  return s;
}

/**
 * 整体判断（不是分数）。
 *
 * 三条规则，按顺序生效：
 *   1. 只看「高重要度 + 硬门槛」的要求 —— 决定能不能过简历初筛的是这些，
 *      低重要度的加分项缺口不应该把整体判断拉到「明显缺口」。
 *      如果岗位没有任何高重要度要求，才回退到全部要求。
 *   2. 「无法判断」的要求（原文表述模糊）不计入分母，否则模糊表述会稀释结论。
 *   3. 少量缺口 + 较多证据不足时，判「缺少证据」而不是「存在缺口」——
 *      这两者的改进动作完全不同：前者是改写简历，后者是补能力。
 */
export function overallVerdict(matches: RequirementMatch[]): Assessment {
  if (matches.length === 0) return 'unknown';

  const important = matches.filter((m) => m.importance === 'high' || m.hardGate);
  const pool = important.length > 0 ? important : matches;

  const count = (a: Assessment) => pool.filter((m) => m.assessment === a).length;
  const matched = count('matched');
  const partial = count('partial');
  const lacking = count('lacking_evidence');
  const gap = count('gap');
  const unknown = count('unknown');
  const judged = pool.length - unknown;

  if (judged === 0) return 'unknown';
  if (gap === 0 && lacking === 0) {
    // 能判断的要求都满足，且没有「部分满足」→ 满足；否则是部分满足
    return matched === judged && partial === 0 ? 'matched' : 'partial';
  }
  if (gap === 0) return 'lacking_evidence';
  // 缺口占能判断部分一半以上，才算「明显缺口」
  return gap >= judged * 0.5 ? 'gap' : 'lacking_evidence';
}
