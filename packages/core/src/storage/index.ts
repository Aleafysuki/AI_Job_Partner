import type { AiSettings, AiTrace } from '../domain/ai-trace';
import { createDefaultAiSettings, normalizeAiSettings } from '../domain/ai-trace';
import type { InterviewDebriefReport, InterviewDebriefSession } from '../domain/debrief';
import type { AssessSession, SkillAssessment } from '../domain/interview';
import type { JobRequirement } from '../domain/job';
import type { CandidateProfile } from '../domain/profile';
import type { StaleMark } from '../engines/skill-interview';
import type { AnalysisReport } from '../domain/report';
import {
  DEFAULT_REVIEW_PREFERENCES,
  normalizeReviewPreferences,
  type ReviewPreferences,
} from '../domain/review-preferences';
import type { TrainingPlan } from '../domain/training';
import { CURRENT_RELEASE } from '../version';

/**
 * 本地存储。
 *
 * 文档第十六节要求本地数据用 SQLite；第二十五节又明确不做账号系统。
 * 这里的做法是把「存哪里」和「存什么」彻底分开：
 *
 *   StoragePort  —— 由宿主实现（Electron 主进程写 SQLite / JSON 文件；浏览器写 localStorage）
 *   WorkspaceStore —— 与宿主无关的内存状态 + 快照序列化
 *
 * 因此换存储引擎不需要改任何业务代码，将来加同步服务也只是再加一个 Port 实现。
 */

/**
 * 快照结构版本。
 *
 * 1 → 2（v0.2 能力问诊）：新增 trainingPlans[]、profile.assessments[]、evidence.origin。
 * 2 → 3（v0.2 面试复盘）：新增 interviewSessions[]、debriefReports[]，
 *                         settings 补 transcription / capture 两组子配置。
 * 3 → 4（v0.6 累积不丢）：新增 assessSessions[]、assessResults[]、staleMarks[]，
 *                         settings 补 review 一组用户决策偏好。
 *                         —— 之前问诊会话只在内存里，用户答到第 5 题关掉应用，
 *                            前 4 题全没了（SQLite 是单表单 key 的 JSON 大字段，
 *                            没在快照里声明就是存不了，不是忘了写）。
 * 原值（保留留痕，勿删）：export const SNAPSHOT_SCHEMA_VERSION = 2;
 */
export const SNAPSHOT_SCHEMA_VERSION = 4;

export interface WorkspaceUiState {
  activeProfileId?: string;
  activeJobId?: string;
  onboardingCompleted: boolean;
  /** 用户关闭过的提示 */
  dismissedHints: string[];
}

export interface WorkspaceSnapshot {
  schemaVersion: number;
  savedAt: string;
  release: string;
  profiles: CandidateProfile[];
  jobs: JobRequirement[];
  reports: AnalysisReport[];
  /** v0.2：薄弱项训练计划（按岗位保存，换岗位不覆盖已有计划） */
  trainingPlans: TrainingPlan[];
  /**
   * v0.2 追加：面试录音会话。
   *
   * 这里只存元数据与转写文本 —— **音频字节不落在快照里**，
   * 它们按会话写到数据目录下的 recordings/<sessionId>/ 中。
   * 原因很实际：一次 40 分钟的面试录音有几十兆，塞进 JSON/SQLite 的单个 value
   * 会让每次 persist 都变成一次大文件重写。
   */
  interviewSessions: InterviewDebriefSession[];
  /** v0.2 追加：面试复盘报告（可重新生成，与 session 一对多保留历史） */
  debriefReports: InterviewDebriefReport[];
  /**
   * v0.6：进行中与已完成的能力问诊会话。
   *
   * **会话必须在快照里**，理由很直接：会话里存着用户逐题的答案，
   * 而用户填这些答案花的时间是真实的。不落盘 = 崩溃/关掉即全部消失，
   * 用户的反应就是「填了一遍还要重填」。
   *
   * 只存文本与题目结构，不存音频（音频走文件，见 interviewSessions 的注释）。
   */
  assessSessions: AssessSession[];
  /**
   * v0.6：问诊结论的「本次改了什么」差异视图数据。
   *
   * 之前 before 快照只在函数返回值里飘过 —— 关掉页面就没了，
   * 用户回到档案页仍然看不到「这次问诊到底改了什么」。
   */
  assessResults: StoredAssessResult[];
  /** v0.6：用户手动标记「这条问诊结论想重答」 */
  staleMarks: StaleMark[];
  traces: AiTrace[];
  settings: AiSettings;
  ui: WorkspaceUiState;
}

/** 问诊差异视图需要持久化的那部分（updatedProfile 太大，不进快照） */
export interface StoredAssessResult {
  assessment: SkillAssessment;
  before: {
    existed: boolean;
    level: string;
    selfLevel: string;
    evidenceCount: number;
    summary?: string;
  };
  /** 这次问诊补了哪些证据的 id */
  evidenceIds: string[];
  createdAt: string;
}

export interface StoragePort {
  /** 读取快照；不存在返回 null */
  load(): Promise<WorkspaceSnapshot | null>;
  save(snapshot: WorkspaceSnapshot): Promise<void>;
  /** 清空数据（需要用户显式确认） */
  clear(): Promise<void>;
  /** 人类可读的存储位置描述，用于设置页展示「数据存在哪」 */
  describe(): string;
}

export function createEmptySnapshot(): WorkspaceSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    release: CURRENT_RELEASE,
    profiles: [],
    jobs: [],
    reports: [],
    trainingPlans: [],
    interviewSessions: [],
    debriefReports: [],
    assessSessions: [],
    assessResults: [],
    staleMarks: [],
    traces: [],
    settings: createDefaultAiSettings(),
    ui: { onboardingCompleted: false, dismissedHints: [] },
  };
}

/**
 * 版本迁移入口 —— 结构变化时只改这里，业务代码不动。
 *
 * schemaVersion 1 → 2（v0.2）：
 *   - snapshot 新增 trainingPlans[]
 *   - profile 新增 assessments[]
 *   - evidence 新增 origin（老数据一律视为 resume）
 * schemaVersion 2 → 3（v0.2 面试复盘）：
 *   - snapshot 新增 interviewSessions[] / debriefReports[]
 *   - settings 深合并出 transcription / capture（老快照没有这两个子对象）
 * 迁移必须是幂等的：重复执行不会改变结果。
 */
export function migrateSnapshot(raw: unknown): WorkspaceSnapshot {
  const empty = createEmptySnapshot();
  if (!raw || typeof raw !== 'object') return empty;
  const data = raw as Partial<WorkspaceSnapshot>;

  const profiles = (Array.isArray(data.profiles) ? data.profiles : []).map((profile) => {
    const p = profile as CandidateProfile;
    return {
      ...p,
      assessments: Array.isArray(p.assessments) ? p.assessments : [],
      interviewHistory: Array.isArray(p.interviewHistory) ? p.interviewHistory : [],
      evidence: (Array.isArray(p.evidence) ? p.evidence : []).map((e) => ({
        ...e,
        origin: e.origin ?? 'resume',
      })),
    } as CandidateProfile;
  });

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : empty.savedAt,
    release: typeof data.release === 'string' ? data.release : empty.release,
    profiles,
    jobs: Array.isArray(data.jobs) ? data.jobs : [],
    reports: Array.isArray(data.reports) ? data.reports : [],
    trainingPlans: Array.isArray(data.trainingPlans) ? data.trainingPlans : [],
    interviewSessions: Array.isArray(data.interviewSessions)
      ? data.interviewSessions.map((s) => normalizeSession(s as InterviewDebriefSession))
      : [],
    debriefReports: Array.isArray(data.debriefReports) ? data.debriefReports : [],
    assessSessions: Array.isArray(data.assessSessions)
      ? data.assessSessions.map((s) => normalizeAssessSession(s as AssessSession))
      : [],
    assessResults: Array.isArray(data.assessResults) ? data.assessResults : [],
    staleMarks: Array.isArray(data.staleMarks) ? data.staleMarks : [],
    traces: Array.isArray(data.traces) ? data.traces : [],
    // 深合并：老快照的 settings 里没有 transcription / capture，顶层展开补不上这两层
    settings: normalizeAiSettings(data.settings),
    ui: { ...empty.ui, ...(data.ui ?? {}) },
  };
}

/** 老会话可能缺 v0.6 追加的字段（draft / replacedQuestions），补齐后再进内存 */
function normalizeAssessSession(session: AssessSession): AssessSession {
  return {
    ...session,
    answers: Array.isArray(session.answers) ? session.answers : [],
    questions: Array.isArray(session.questions) ? session.questions : [],
    replacedQuestions: Array.isArray(session.replacedQuestions) ? session.replacedQuestions : [],
    draft: session.draft ?? undefined,
  };
}

/** 老会话可能缺 v0.2 追加的字段（例如 quiet / segments），补齐后再进内存 */
function normalizeSession(session: InterviewDebriefSession): InterviewDebriefSession {
  return {
    ...session,
    quiet: session.quiet ?? true,
    segments: Array.isArray(session.segments) ? session.segments : [],
    turns: Array.isArray(session.turns) ? session.turns : [],
    sources: session.sources ?? { mic: true, system: session.mode === 'online' },
    notes: session.notes ?? '',
    durationMs: typeof session.durationMs === 'number' ? session.durationMs : 0,
  };
}

const MAX_TRACES = 120;

export class WorkspaceStore {
  private snapshot: WorkspaceSnapshot;

  constructor(
    private port: StoragePort,
    snapshot?: WorkspaceSnapshot,
    private onChange?: (snapshot: WorkspaceSnapshot) => void,
  ) {
    this.snapshot = snapshot ?? createEmptySnapshot();
  }

  static async open(port: StoragePort, onChange?: (s: WorkspaceSnapshot) => void): Promise<WorkspaceStore> {
    let snapshot: WorkspaceSnapshot | null = null;
    try {
      const raw = await port.load();
      snapshot = raw ? migrateSnapshot(raw) : null;
    } catch {
      snapshot = null;
    }
    return new WorkspaceStore(port, snapshot ?? createEmptySnapshot(), onChange);
  }

  get state(): WorkspaceSnapshot {
    return this.snapshot;
  }

  get storageLocation(): string {
    return this.port.describe();
  }

  private touch(): void {
    this.snapshot = { ...this.snapshot, savedAt: new Date().toISOString() };
  }

  private notify(): void {
    this.onChange?.(this.snapshot);
  }

  async persist(): Promise<void> {
    this.touch();
    await this.port.save(this.snapshot);
  }

  // ---------------- 档案 ----------------

  async upsertProfile(profile: CandidateProfile): Promise<void> {
    const profiles = this.snapshot.profiles.filter((p) => p.id !== profile.id);
    profiles.unshift(profile);
    this.snapshot = {
      ...this.snapshot,
      profiles,
      ui: { ...this.snapshot.ui, activeProfileId: profile.id },
    };
    await this.persist();
    this.notify();
  }

  async deleteProfile(id: string): Promise<void> {
    const ui: WorkspaceUiState = { ...this.snapshot.ui };
    if (ui.activeProfileId === id) delete ui.activeProfileId;
    this.snapshot = {
      ...this.snapshot,
      profiles: this.snapshot.profiles.filter((p) => p.id !== id),
      ui,
    };
    await this.persist();
    this.notify();
  }

  activeProfile(): CandidateProfile | undefined {
    const { profiles, ui } = this.snapshot;
    return profiles.find((p) => p.id === ui.activeProfileId) ?? profiles[0];
  }

  // ---------------- 岗位 ----------------

  async upsertJob(job: JobRequirement): Promise<void> {
    const jobs = this.snapshot.jobs.filter((j) => j.id !== job.id);
    jobs.unshift(job);
    this.snapshot = { ...this.snapshot, jobs, ui: { ...this.snapshot.ui, activeJobId: job.id } };
    await this.persist();
    this.notify();
  }

  async deleteJob(id: string): Promise<void> {
    const ui: WorkspaceUiState = { ...this.snapshot.ui };
    if (ui.activeJobId === id) delete ui.activeJobId;
    this.snapshot = {
      ...this.snapshot,
      jobs: this.snapshot.jobs.filter((j) => j.id !== id),
      reports: this.snapshot.reports.filter((r) => r.job.id !== id),
      // 训练计划是「针对这个岗位」的，随岗位一起删；
      // 但问诊产出的证据与评估结论属于候选人本人，留在档案里 —— 这正是跨岗位保留的意义
      trainingPlans: this.snapshot.trainingPlans.filter((p) => p.jobId !== id),
      // 面试录音与复盘报告同样属于「这个人经历过的事」，不随岗位删除。
      // jobId 可能因此指向一个不存在的岗位，但会话本身仍然可读 —— 这比丢记录好。
      ui,
    };
    await this.persist();
    this.notify();
  }

  activeJob(): JobRequirement | undefined {
    const { jobs, ui } = this.snapshot;
    return jobs.find((j) => j.id === ui.activeJobId) ?? jobs[0];
  }

  // ---------------- 报告 ----------------

  async addReport(report: AnalysisReport): Promise<void> {
    const reports = [report, ...this.snapshot.reports].slice(0, 60);
    this.snapshot = { ...this.snapshot, reports };
    await this.persist();
    this.notify();
  }

  async deleteReport(id: string): Promise<void> {
    this.snapshot = { ...this.snapshot, reports: this.snapshot.reports.filter((r) => r.id !== id) };
    await this.persist();
    this.notify();
  }

  latestReport(): AnalysisReport | undefined {
    return this.snapshot.reports[0];
  }

  // ---------------- 训练计划（v0.2） ----------------

  async upsertTrainingPlan(plan: TrainingPlan): Promise<void> {
    const trainingPlans = [plan, ...this.snapshot.trainingPlans.filter((p) => p.id !== plan.id)];
    this.snapshot = { ...this.snapshot, trainingPlans };
    await this.persist();
    this.notify();
  }

  async deleteTrainingPlan(id: string): Promise<void> {
    this.snapshot = { ...this.snapshot, trainingPlans: this.snapshot.trainingPlans.filter((p) => p.id !== id) };
    await this.persist();
    this.notify();
  }

  /** 当前岗位已有的训练计划（每个岗位只保留最新一份） */
  trainingPlanForJob(jobId: string): TrainingPlan | undefined {
    return this.snapshot.trainingPlans.find((p) => p.jobId === jobId);
  }

  // ---------------- 面试复盘（v0.2 追加） ----------------

  /**
   * 写入/更新一次面试会话。
   *
   * `persist: false` 用于录音进行中：每 20 秒落一段音频就要写一次全量快照太重，
   * 所以录音期间只在内存里推进（音频本身已经按分片落盘，不会丢），
   * 会话结束或转写完成时再统一持久化。
   */
  async upsertInterviewSession(session: InterviewDebriefSession, options: { persist?: boolean } = {}): Promise<void> {
    const interviewSessions = [session, ...this.snapshot.interviewSessions.filter((s) => s.id !== session.id)];
    this.snapshot = { ...this.snapshot, interviewSessions };
    if (options.persist !== false) await this.persist();
    this.notify();
  }

  /**
   * 删除会话。
   *
   * 只删记录，**不删音频文件** —— 音频在数据目录里，由宿主层负责，
   * 这样「误删了记录但还想找回录音」不会变成不可挽回的事。
   */
  async deleteInterviewSession(id: string): Promise<void> {
    this.snapshot = {
      ...this.snapshot,
      interviewSessions: this.snapshot.interviewSessions.filter((s) => s.id !== id),
      debriefReports: this.snapshot.debriefReports.filter((r) => r.sessionId !== id),
    };
    await this.persist();
    this.notify();
  }

  interviewSessionById(id: string): InterviewDebriefSession | undefined {
    return this.snapshot.interviewSessions.find((s) => s.id === id);
  }

  latestInterviewSession(): InterviewDebriefSession | undefined {
    return this.snapshot.interviewSessions[0];
  }

  async upsertDebriefReport(report: InterviewDebriefReport): Promise<void> {
    const debriefReports = [report, ...this.snapshot.debriefReports.filter((r) => r.id !== report.id)];
    this.snapshot = { ...this.snapshot, debriefReports };
    await this.persist();
    this.notify();
  }

  async deleteDebriefReport(id: string): Promise<void> {
    this.snapshot = { ...this.snapshot, debriefReports: this.snapshot.debriefReports.filter((r) => r.id !== id) };
    await this.persist();
    this.notify();
  }

  /** 某次面试的最新一份复盘报告 */
  debriefReportForSession(sessionId: string): InterviewDebriefReport | undefined {
    return this.snapshot.debriefReports.find((r) => r.sessionId === sessionId);
  }

  latestDebriefReport(): InterviewDebriefReport | undefined {
    return this.snapshot.debriefReports[0];
  }

  // ---------------- 能力问诊会话（v0.6） ----------------

  /**
   * 存一份问诊会话。
   *
   * `persist: false` 的用途是**连续答题时先写内存、节流后写盘**：
   * 每答一题就重写一次全量快照太重（SQLite 那边是整个 JSON 字符串）。
   * 切页与关闭时会强制落盘。
   */
  async upsertAssessSession(session: AssessSession, options: { persist?: boolean } = {}): Promise<void> {
    const assessSessions = [session, ...this.snapshot.assessSessions.filter((s) => s.id !== session.id)].slice(0, 30);
    this.snapshot = { ...this.snapshot, assessSessions };
    if (options.persist !== false) await this.persist();
    this.notify();
  }

  assessSessionsFor(profileId: string): AssessSession[] {
    return this.snapshot.assessSessions.filter((s) => s.profileId === profileId);
  }

  /** 进行中的会话（status = draft）。用于恢复「关掉应用但答案还在」。 */
  activeAssessSession(profileId: string): AssessSession | undefined {
    return this.snapshot.assessSessions.find((s) => s.profileId === profileId && s.status === 'draft');
  }

  async deleteAssessSession(id: string): Promise<void> {
    this.snapshot = { ...this.snapshot, assessSessions: this.snapshot.assessSessions.filter((s) => s.id !== id) };
    await this.persist();
    this.notify();
  }

  /** 存一份问诊差异视图数据（before/after） */
  async addAssessResult(result: StoredAssessResult): Promise<void> {
    const assessResults = [result, ...this.snapshot.assessResults].slice(0, 60);
    this.snapshot = { ...this.snapshot, assessResults };
    await this.persist();
    this.notify();
  }

  latestAssessResult(profileId: string): StoredAssessResult | undefined {
    return this.snapshot.assessResults.find((r) => r.assessment.profileId === profileId);
  }

  async clearStaleMarks(profileId: string): Promise<void> {
    this.snapshot = {
      ...this.snapshot,
      staleMarks: this.snapshot.staleMarks.filter((m) => m.skillName.length > 0),
    };
    await this.persist();
    this.notify();
  }

  staleMarksFor(): StaleMark[] {
    return this.snapshot.staleMarks;
  }

  /** 用户手动标「这条想重答」 */
  async addStaleMark(mark: StaleMark): Promise<void> {
    const staleMarks = [...this.snapshot.staleMarks.filter((m) => m.skillName !== mark.skillName), mark];
    this.snapshot = { ...this.snapshot, staleMarks };
    await this.persist();
    this.notify();
  }

  async removeStaleMark(skillName: string): Promise<void> {
    this.snapshot = { ...this.snapshot, staleMarks: this.snapshot.staleMarks.filter((m) => m.skillName !== skillName) };
    await this.persist();
    this.notify();
  }

  /** 三个「开发时该拍板」的决策点：用户自己在设置页决定，开发不替他选 */
  reviewPreferences(): ReviewPreferences {
    const raw = this.snapshot.settings as Partial<AiSettings> & { review?: Partial<ReviewPreferences> };
    return normalizeReviewPreferences(raw?.review);
  }

  async updateReviewPreferences(patch: Partial<ReviewPreferences>): Promise<void> {
    const settings = this.snapshot.settings as Partial<AiSettings> & { review?: Partial<ReviewPreferences> };
    const review = normalizeReviewPreferences({ ...DEFAULT_REVIEW_PREFERENCES, ...settings?.review, ...patch });
    this.snapshot = { ...this.snapshot, settings: { ...this.snapshot.settings, review } as AiSettings };
    await this.persist();
    this.notify();
  }

  // ---------------- AI 留痕 ----------------

  /** 只做内存记录，写盘交给下一次 persist，避免每条 trace 都触发一次磁盘写入 */
  addTrace(trace: AiTrace): void {
    this.snapshot = { ...this.snapshot, traces: [trace, ...this.snapshot.traces].slice(0, MAX_TRACES) };
  }

  async clearTraces(): Promise<void> {
    this.snapshot = { ...this.snapshot, traces: [] };
    await this.persist();
    this.notify();
  }

  // ---------------- 设置 / UI ----------------

  async updateSettings(patch: Partial<AiSettings>): Promise<void> {
    this.snapshot = { ...this.snapshot, settings: { ...this.snapshot.settings, ...patch } };
    await this.persist();
    this.notify();
  }

  async updateUi(patch: Partial<WorkspaceUiState>): Promise<void> {
    this.snapshot = { ...this.snapshot, ui: { ...this.snapshot.ui, ...patch } };
    await this.persist();
    this.notify();
  }

  async clearAll(): Promise<void> {
    this.snapshot = createEmptySnapshot();
    await this.port.clear();
    await this.persist();
    this.notify();
  }
}

/** 内存实现：单元测试与「试用模式」用 */
export class MemoryStoragePort implements StoragePort {
  private data: WorkspaceSnapshot | null = null;
  constructor(private label = '内存（关闭后丢失）') {}
  async load(): Promise<WorkspaceSnapshot | null> {
    return this.data;
  }
  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    this.data = JSON.parse(JSON.stringify(snapshot)) as WorkspaceSnapshot;
  }
  async clear(): Promise<void> {
    this.data = null;
  }
  describe(): string {
    return this.label;
  }
}
