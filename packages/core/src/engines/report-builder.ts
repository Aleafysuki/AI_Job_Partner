import { ASSESSMENT_LABEL } from '../domain/common';
import { overallVerdict, type MatchResult } from '../domain/match';
import type { CandidateProfile } from '../domain/profile';
import type { JobRequirement } from '../domain/job';
import { REPORT_DISCLAIMER, type AnalysisReport } from '../domain/report';
import { unique } from '../utils/text';

/**
 * ReportBuilder —— 把「档案 × 岗位 × 匹配结果」聚合为一份结构化报告。
 *
 * 注意：报告里没有一个 0–100 的分数（文档第二节明确反对）。
 * headline 是一句话结论，verdict 是五个离散判断之一。
 */

export interface BuildReportInput {
  profile: CandidateProfile;
  job: JobRequirement;
  result: MatchResult;
}

const VERDICT_HEADLINE: Record<string, string> = {
  matched: '你的证据基本能支撑这个岗位的主要要求',
  partial: '你的证据能支撑大部分要求，但还有几处需要补强',
  lacking_evidence: '你具备不少相关能力，但简历里缺少能证明它们的证据',
  gap: '这个岗位有较多要求在你的经历中找不到对应证据',
  unknown: '岗位要求信息不足，暂时无法给出可靠判断',
};

export function buildReport(input: BuildReportInput): AnalysisReport {
  const { profile, job, result } = input;
  const verdict = overallVerdict(result.matches);
  const strongEvidence = profile.evidence.filter((e) => e.strength === 'strong').length;

  const headline = `${VERDICT_HEADLINE[verdict]}（${ASSESSMENT_LABEL[verdict]}：满足 ${result.summary.matched} / 部分满足 ${result.summary.partial} / 缺少证据 ${result.summary.lackingEvidence} / 存在缺口 ${result.summary.gap} / 无法判断 ${result.summary.unknown}）`;

  return {
    id: `report_${Date.now().toString(36)}`,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    headline,
    verdict,
    profile: {
      id: profile.id,
      displayName: profile.basics.displayName,
      skillCount: profile.skills.length,
      evidenceCount: profile.evidence.length,
      strongEvidenceCount: strongEvidence,
    },
    job: {
      id: job.id,
      title: job.jobTitle,
      company: job.company,
      requirementCount: job.items.length,
      hardGateCount: job.items.filter((i) => i.hardGate).length,
    },
    summary: result.summary,
    matches: result.matches,
    priorities: result.priorities,
    riskNotes: unique([...result.riskNotes, ...job.screenRisks]).slice(0, 8),
    engine: result.engine,
    usedModel: result.usedModel,
    disclaimer: REPORT_DISCLAIMER,
  };
}

/**
 * 「我为什么不匹配」—— 文档第 23 节要求的两个问题之一。
 * 直接把匹配结果翻译成人类语言的因果链，不新增判断。
 */
export function explainWhyNot(profile: CandidateProfile, report: AnalysisReport): string[] {
  const reasons: string[] = [];
  const byAssessment = (a: string) => report.matches.filter((m) => m.assessment === a);

  const gaps = byAssessment('gap');
  if (gaps.length > 0) {
    reasons.push(
      `有 ${gaps.length} 条要求在档案中完全找不到对应证据：${gaps.slice(0, 5).map((g) => g.requirement).join('；')}。这不是简历写法问题，而是能力/经历缺口。`,
    );
  }
  const lacking = byAssessment('lacking_evidence');
  if (lacking.length > 0) {
    reasons.push(
      `有 ${lacking.length} 条你其实提到过，但只停留在自我声明：${lacking.slice(0, 5).map((l) => l.requirement).join('；')}。档案里现有 ${profile.skills.length} 项技能、${profile.evidence.length} 条证据，其中强证据只有 ${report.profile.strongEvidenceCount} 条。`,
    );
  }
  const hardFail = report.matches.filter((m) => m.hardGate && m.assessment === 'gap');
  if (hardFail.length > 0) {
    reasons.push(`有 ${hardFail.length} 条硬门槛不满足：${hardFail.map((h) => h.requirement).join('；')}。这类条件通常无法通过简历改写解决。`);
  }
  if (reasons.length === 0) {
    reasons.push('从你提供的证据看，没有发现明显的结构性缺口。剩下的主要是表达与证据强度问题。');
  }
  return reasons;
}
