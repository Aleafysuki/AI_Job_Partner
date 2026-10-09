import type { Assessment } from './common';
import type { MatchResult, MatchSummary, PriorityAction, RequirementMatch } from './match';

/**
 * AnalysisReport —— 给 UI / 导出使用的聚合产物。
 * 结构化 JSON 是唯一契约，Markdown / PDF 只是某一种渲染器。
 */

/** v0.2 功能：最低可解释候选人画像（此处只保留结构，v0.1 不生产内容） */
export interface MinimumCandidateModel {
  jobId: string;
  targetRole: string;
  buckets: Array<{
    group: string;
    items: string[];
    derivedFromRequirementIds: string[];
  }>;
  note: string;
}

export interface AnalysisReport {
  id: string;
  schemaVersion: number;
  createdAt: string;

  /** 一句话结论 */
  headline: string;
  verdict: Assessment;

  profile: {
    id: string;
    displayName: string;
    skillCount: number;
    evidenceCount: number;
    strongEvidenceCount: number;
  };

  job: {
    id: string;
    title: string;
    company: string;
    requirementCount: number;
    hardGateCount: number;
  };

  summary: MatchSummary;
  matches: RequirementMatch[];
  priorities: PriorityAction[];
  riskNotes: string[];

  /** v0.2 预留 */
  minimumCandidate?: MinimumCandidateModel;

  engine: MatchResult['engine'];
  usedModel: boolean;

  /** 免责声明：产品不能声称「达到条件就一定能通过初筛」 */
  disclaimer: string;
}

export const REPORT_DISCLAIMER =
  '本报告基于你提供的简历与岗位要求进行分析，描述的是「你提供的证据能否支撑该岗位要求」，不代表招聘方的实际筛选结果。真实结果还受竞争情况、筛选方式等因素影响。';
