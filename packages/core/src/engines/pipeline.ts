import { AiGateway, type GatewayOptions } from '../ai/gateway';
import type { HttpTransport } from '../ai/types';
import type { AiSettings, AiTrace } from '../domain/ai-trace';
import type { AssessSession } from '../domain/interview';
import type { JobRequirement } from '../domain/job';
import type { CandidateProfile } from '../domain/profile';
import type { AnalysisReport } from '../domain/report';
import type { MatchResult, RequirementMatch } from '../domain/match';
import { redactPII } from '../privacy/redactor';
import { buildProfile, finalizeProfile } from './profile-builder';
import { analyzeJob, finalizeJob } from './job-analyzer';
import { runMatching } from './matching-engine';
import { buildReport } from './report-builder';
import { mergeProfiles, type MergeReport } from './profile-merge';
import { evaluateAssessment, type EvaluateOutput } from './skill-interview';
import { buildTrainingPlan, type BuildTrainingOutput } from './training-planner';

/**
 * AnalysisPipeline —— 文档第十八节的 MVP 主链路，也是唯一被允许的入口：
 *
 *   上传简历 → 隐私识别 → Candidate Profile
 *              → 输入岗位 → Job Requirement
 *              → Candidate × Job → 匹配分析 → 可解释报告
 *
 * 上面每一环都可以单独调用（便于分步 UI 与后续的 Web / 移动端复用）。
 */

export interface PipelineStep {
  id: string;
  label: string;
}

/** 首次使用时的解析进度展示（文档第十四节） */
export const PARSE_STEPS: PipelineStep[] = [
  { id: 'privacy', label: '检查隐私信息并脱敏' },
  { id: 'education', label: '提取教育经历' },
  { id: 'work', label: '提取工作经历' },
  { id: 'project', label: '提取项目' },
  { id: 'skill', label: '提取技能' },
  { id: 'evidence', label: '识别可验证成果' },
];

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped';
export type ProgressHandler = (stepId: string, status: StepStatus, detail?: string) => void;

export interface PipelineOptions {
  settings: AiSettings;
  transport?: HttpTransport;
  onTrace?: (trace: AiTrace) => void;
  beforeSend?: GatewayOptions['beforeSend'];
  onProgress?: ProgressHandler;
}

function createGateway(options: PipelineOptions): AiGateway {
  return new AiGateway(options.settings, {
    transport: options.transport,
    onTrace: options.onTrace,
    beforeSend: options.beforeSend,
  });
}

/**
 * 供交互式流程（能力问诊、训练计划）在界面上直接构造网关。
 *
 * 这两条流程是「一题一答」的，没法塞进一次性 pipeline 调用里，
 * 所以把网关构造暴露出来，由界面持有会话状态，收尾时再统一评估。
 */
export function createPipelineGateway(options: PipelineOptions): AiGateway {
  return createGateway(options);
}

export interface ResumeAnalyzeInput extends PipelineOptions {
  rawText: string;
  fileName?: string;
  profileLabel?: string;
}

export interface ResumeAnalyzeOutput {
  profile: CandidateProfile;
  trace: AiTrace | null;
  warnings: string[];
  engine: 'ai' | 'rule';
}

export async function analyzeResume(input: ResumeAnalyzeInput): Promise<ResumeAnalyzeOutput> {
  const progress = input.onProgress;
  progress?.('privacy', 'running');
  const privacy = redactPII(input.rawText, { apply: true });
  progress?.('privacy', 'done', privacy.findings.length > 0
    ? `识别并脱敏 ${privacy.findings.length} 处敏感信息`
    : '未发现需要脱敏的信息');

  progress?.('education', 'running');
  const gateway = createGateway(input);
  const built = await buildProfile({
    redactedText: privacy.redactedText,
    privacy,
    originalText: input.rawText,
    profileLabel: input.profileLabel,
    gateway,
  });

  progress?.('education', built.profile.education.length > 0 ? 'done' : 'skipped', `${built.profile.education.length} 条`);
  progress?.('work', built.profile.experiences.length > 0 ? 'done' : 'skipped', `${built.profile.experiences.length} 段`);
  progress?.('project', built.profile.projects.length > 0 ? 'done' : 'skipped', `${built.profile.projects.length} 个`);
  progress?.('skill', built.profile.skills.length > 0 ? 'done' : 'skipped', `${built.profile.skills.length} 项`);
  progress?.('evidence', built.profile.evidence.length > 0 ? 'done' : 'skipped', `${built.profile.evidence.length} 条`);

  return {
    profile: built.profile,
    trace: built.trace,
    warnings: built.warnings,
    engine: built.engine,
  };
}

export interface JobAnalyzeInput extends PipelineOptions {
  rawText: string;
  source?: JobRequirement['source'];
  sourceFileName?: string;
  jobTitleHint?: string;
}

export interface JobAnalyzeOutput {
  job: JobRequirement;
  trace: AiTrace | null;
  warnings: string[];
  engine: 'ai' | 'rule';
}

export async function analyzeJobDescription(input: JobAnalyzeInput): Promise<JobAnalyzeOutput> {
  const privacy = redactPII(input.rawText, { apply: true });
  const gateway = createGateway(input);
  const analyzed = await analyzeJob({
    redactedText: privacy.redactedText,
    privacy,
    source: input.source ?? 'text',
    sourceFileName: input.sourceFileName,
    jobTitleHint: input.jobTitleHint,
    gateway,
  });
  return {
    job: analyzed.job,
    trace: analyzed.trace,
    warnings: analyzed.warnings,
    engine: analyzed.engine,
  };
}

export interface MatchPipelineInput extends PipelineOptions {
  profile: CandidateProfile;
  job: JobRequirement;
}

export interface MatchPipelineOutput {
  result: MatchResult;
  report: AnalysisReport;
  trace: AiTrace | null;
  /** 本次匹配用的是哪条链路：模型 / 本地规则 / 两者结合 */
  engine: 'rule' | 'ai' | 'hybrid';
  warnings: string[];
}

export async function runMatchPipeline(input: MatchPipelineInput): Promise<MatchPipelineOutput> {
  const gateway = createGateway(input);
  const matched = await runMatching({ profile: input.profile, job: input.job, gateway });
  const report = buildReport({ profile: input.profile, job: input.job, result: matched.result });
  return { result: matched.result, report, trace: matched.trace, engine: matched.engine, warnings: matched.warnings };
}

export interface FullPipelineInput extends PipelineOptions {
  resumeText: string;
  jdText: string;
  profileLabel?: string;
  jobTitleHint?: string;
}

export interface FullPipelineOutput {
  profile: CandidateProfile;
  job: JobRequirement;
  result: MatchResult;
  report: AnalysisReport;
  traces: AiTrace[];
  warnings: string[];
  engine: { profile: 'ai' | 'rule'; job: 'ai' | 'rule'; match: 'rule' | 'ai' | 'hybrid' };
}

/** 一条命令跑完整条链路 —— 端到端测试与首个可展示版本（文档 24. Phase 6）都走这里 */
export async function runFullPipeline(input: FullPipelineInput): Promise<FullPipelineOutput> {
  const traces: AiTrace[] = [];
  const warnings: string[] = [];
  const collect = (trace: AiTrace) => {
    traces.push(trace);
    input.onTrace?.(trace);
  };

  const resume = await analyzeResume({
    ...input,
    rawText: input.resumeText,
    onTrace: collect,
  });
  warnings.push(...resume.warnings);

  const job = await analyzeJobDescription({
    ...input,
    rawText: input.jdText,
    onTrace: collect,
  });
  warnings.push(...job.warnings);

  const matched = await runMatchPipeline({
    ...input,
    profile: resume.profile,
    job: job.job,
    onTrace: collect,
  });
  warnings.push(...matched.warnings);

  return {
    profile: resume.profile,
    job: job.job,
    result: matched.result,
    report: matched.report,
    traces,
    warnings,
    engine: { profile: resume.engine, job: job.engine, match: matched.engine },
  };
}

/** 用户手工修改档案后重新归一化（保证强度刻度与技能关联自洽） */
export function recomputeProfile(profile: CandidateProfile): CandidateProfile {
  return finalizeProfile(profile);
}

export function recomputeJob(job: JobRequirement): JobRequirement {
  return finalizeJob(job);
}

// ---------------------------------------------------------------------------
// v0.2：能力库导入（默认合并，跨岗位保留积累）
// ---------------------------------------------------------------------------

export interface ImportResumeInput extends PipelineOptions {
  rawText: string;
  fileName?: string;
  profileLabel?: string;
  /** 已存在的能力库。传了就默认走合并，不会覆盖已有积累 */
  existingProfile?: CandidateProfile | null;
  /** merge（默认：并入现有能力库） / replace（新建一份档案） */
  mode?: 'merge' | 'replace';
}

export interface ImportResumeOutput extends ResumeAnalyzeOutput {
  /** 采用合并模式时的合并报告，UI 用它告诉用户「新增了什么、保留了什么」 */
  mergeReport?: MergeReport;
}

/**
 * v0.2 的档案导入入口。
 *
 * 与 analyzeResume 的区别：analyzeResume 只管「简历 → 档案」，
 * 这里多了一步「并入已有能力库」，这是换岗位不丢积累的关键。
 */
export async function importResume(input: ImportResumeInput): Promise<ImportResumeOutput> {
  const parsed = await analyzeResume(input);
  const mode = input.mode ?? (input.existingProfile ? 'merge' : 'replace');

  if (mode !== 'merge' || !input.existingProfile) {
    return { ...parsed, mergeReport: undefined };
  }

  const { profile, report } = mergeProfiles(input.existingProfile, parsed.profile);
  return {
    profile,
    trace: parsed.trace,
    warnings: [...parsed.warnings, `已并入现有能力库：${report.summary}`],
    engine: parsed.engine,
    mergeReport: report,
  };
}

// ---------------------------------------------------------------------------
// v0.2：能力问诊与薄弱项训练
// ---------------------------------------------------------------------------

export interface AssessPipelineInput extends PipelineOptions {
  session: AssessSession;
  profile: CandidateProfile;
}

/** 问诊收尾评估（题目与作答由界面持有，见 startAssessment / recordAnswer） */
export async function runSkillAssessment(input: AssessPipelineInput): Promise<EvaluateOutput> {
  return evaluateAssessment({
    session: input.session,
    profile: input.profile,
    gateway: createGateway(input),
  });
}

export interface TrainingPipelineInput extends PipelineOptions {
  profile: CandidateProfile;
  job: JobRequirement;
  matches: RequirementMatch[];
  maxItems?: number;
}

export async function runTrainingPlan(input: TrainingPipelineInput): Promise<BuildTrainingOutput> {
  return buildTrainingPlan({
    profile: input.profile,
    job: input.job,
    matches: input.matches,
    maxItems: input.maxItems,
    gateway: createGateway(input),
  });
}
