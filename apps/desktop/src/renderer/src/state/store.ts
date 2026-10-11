import { create } from 'zustand';
import {
  AiGateway,
  PARSE_STEPS,
  SAMPLE_JD,
  SAMPLE_RESUME,
  SAMPLE_INTERVIEW_TRANSCRIPT,
  WorkspaceStore,
  analyzeJobDescription,
  answerTrainingItem,
  buildInterviewDebrief,
  buildTrainingPlan,
  createDefaultAiSettings,
  createEmptyDebriefSession,
  createEmptySnapshot,
  createPipelineGateway,
  createTranscriber,
  debriefHtmlFileName,
  evaluateAssessment,
  evidenceKey,
  finalizeProfile,
  importResume,
  isEnabled,
  newId,
  recomputeJob,
  recomputeProfile,
  recordAnswer,
  recordDraft,
  replanQuestions,
  renderDebriefHtml,
  runMatchPipeline,
  segmentProgress,
  sessionTranscript,
  SKILL_LEVEL_LABEL,
  planAssessmentSession,
  summarizeAnswer,
  summaryToEvidence,
  carryOverAnswers,
  judgeTrainingAnswer,
  parkTrainingItem,
  TRAINING_EVIDENCE_WHY,
  turnsFromSegment,
  type AiMessage,
  type AiPurpose,
  type AiSettings,
  type AiTrace,
  type AnalysisReport,
  type AnonymizeReport,
  type AnswerSummary,
  type AssessSession,
  type CandidateEvidence,
  type CandidateProfile,
  type CaptureSegment,
  type EvaluateOutput,
  type InterviewDebriefReport,
  type InterviewDebriefSession,
  type JobRequirement,
  type MergeReport,
  type SelfScore,
  type StepStatus,
  type SummaryField,
  type TrainingJudgement,
  type TrainingPlan,
  type WorkspaceSnapshot,
} from '@aijob/core';
import {
  capturePort,
  isDesktop,
  mediaPort,
  quietPort,
  runtimeInfo,
  saveHtml,
  saveText,
  setStopHotkey,
  storagePort,
  transport,
  type RuntimeInfo,
} from '../lib/bridge';
import { pickAndExtract } from '../lib/extract';
import {
  InterviewRecorder,
  describeCaptureError,
  listMicrophones,
  systemAudioHint,
  type CaptureSegmentPayload,
  type RecorderState,
} from '../lib/recorder';

/**
 * 全局状态。
 *
 * 刻意保持「薄」：状态里不存放任何业务判断，
 * 所有分析都通过调用 @aijob/core 的 pipeline 完成，这里只负责调度与提示。
 */

export type Route =
  | 'workbench'
  | 'profile'
  | 'job'
  | 'match'
  | 'interview'
  | 'training'
  | 'prep'
  | 'mock'
  | 'debrief'
  | 'settings';

export interface ToastMessage {
  id: string;
  kind: 'success' | 'error' | 'info';
  text: string;
}

export interface StepState {
  status: StepStatus;
  detail?: string;
}

interface ConfirmRequest {
  purpose: AiPurpose;
  messages: AiMessage[];
  resolve: (ok: boolean) => void;
}

/** 录音期间的一路音源状态，界面用它显示「内录已降级」这类事实 */
export interface ResolvedSources {
  mic: boolean;
  system: boolean;
  note?: string;
}

export interface CaptureEnvironment {
  checked: boolean;
  /** 桌面端才真正支持录音落盘 */
  supported: boolean;
  /** 浏览器模式下的说明 */
  unsupportedReason?: string;
  microphones: Array<{ deviceId: string; label: string }>;
  freeBytes: number;
  lowSpace: boolean;
  directory: string;
  systemAudioHint: string;
}

export interface TranscribeProgress {
  done: number;
  total: number;
  failed: number;
}

/**
 * v0.3：一次问诊的出题元信息。
 *
 * 界面上必须如实展示这三条，因为它们回答了用户最直接的疑问：
 *   - 题目是谁出的（模型还是本地规则）；
 *   - 这项能力被当成哪一类（决定了为什么软技能没有自评题）；
 *   - 有几个候选可以点选（决定了要不要费脑子回忆）。
 */
export interface AssessMeta {
  shape: 'technical' | 'behavioral' | 'credential' | 'domain';
  shapeLabel: string;
  origin: 'ai' | 'rule';
  suggestionCount: number;
  /** 出题过程中的提示（例如模型返回的题被丢弃了） */
  warnings: string[];
}

export interface AppStore {
  ready: boolean;
  ws: WorkspaceStore | null;
  snapshot: WorkspaceSnapshot;
  runtime: RuntimeInfo | null;
  route: Route;
  busy: string | null;
  progress: Record<string, StepState>;
  progressVisible: boolean;
  warnings: string[];
  toast: ToastMessage | null;
  confirm: ConfirmRequest | null;

  /** v0.2：当前进行中的能力问诊会话 */
  assessSession: AssessSession | null;
  /** v0.2：最近一次问诊的评估结论 */
  assessResult: EvaluateOutput | null;
  /** v0.6：从磁盘恢复出来的进行中会话（界面上要提示「上次答到一半」） */
  assessResumed: boolean;
  /** v0.6：回答整理结果，等用户逐条确认后才写进档案 */
  assessSummary: AnswerSummary | null;
  /** v0.2：最近一次导入的合并报告（告诉用户新增了什么、保留了什么） */
  lastMergeReport: MergeReport | null;
  /** v0.3：本次问诊的出题元信息 */
  assessMeta: AssessMeta | null;
  /** v0.6：训练判定结果（给用户看「还差哪」而不是让他猜） */
  trainingJudge: Record<string, TrainingJudgement>;

  // ---- v0.2 追加：面试复盘 ----
  /** 当前选中/进行中的面试会话 */
  debriefSession: InterviewDebriefSession | null;
  /** 当前展示的复盘报告 */
  debriefReport: InterviewDebriefReport | null;
  /** 最近一次复盘的去标识化摘要 */
  lastAnonymizeReport: AnonymizeReport | null;
  /** 录音机状态（静默模式下界面不显示，但仍要维护） */
  recorderState: RecorderState;
  recorderElapsedMs: number;
  resolvedSources: ResolvedSources | null;
  transcribeProgress: TranscribeProgress;
  captureEnv: CaptureEnvironment;
  /** 选中的麦克风设备（空字符串 = 系统默认） */
  micDeviceId: string;
  /**
   * 静默录制进行中。
   *
   * 打开后这一层**不产生任何 toast**。它不是「把提示藏起来」，
   * 而是从源头不发 —— 面试进行中屏幕上多出来的任何东西都可能被对方看到。
   */
  suppressToasts: boolean;

  // 生命周期
  init: () => Promise<void>;
  navigate: (route: Route) => void;

  // 档案
  importResumeFromText: (text: string, label?: string, sourceName?: string, mode?: 'merge' | 'replace') => Promise<void>;
  importResumeFromFile: () => Promise<void>;
  updateProfile: (profile: CandidateProfile) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  reparseProfile: () => Promise<void>;
  dismissMergeReport: () => void;

  // 岗位
  analyzeJobText: (text: string, options?: { titleHint?: string; source?: JobRequirement['source']; fileName?: string }) => Promise<void>;
  updateJob: (job: JobRequirement) => Promise<void>;
  deleteJob: (id: string) => Promise<void>;

  // 匹配
  runMatch: () => Promise<AnalysisReport | null>;

  // v0.2 能力问诊
  /**
   * v0.3：改为异步，因为要调模型出题。
   * 改动的原因：固定五层模板对「人际交往」这类能力问掌握程度是不合适的，
   * 而本地规则只能按能力形状分流出题，要真正贴合某项能力的分水岭需要模型。
   */
  startAssess: (skillName: string, compact?: boolean) => Promise<void>;
  answerAssess: (
    questionId: string,
    answer: { text?: string; choiceIndex?: number; skipped?: boolean; skipReason?: 'not_done' | 'cant_recall' },
  ) => void;
  /** v0.6：草稿随输入变化写入会话（切页不丢正在写的那一题） */
  draftAssess: (draft: NonNullable<AssessSession['draft']> | undefined) => void;
  finishAssess: () => Promise<void>;
  cancelAssess: () => void;
  /** v0.6：换未答的题，**保留已答的答案**（之前是重开会话，已答的全丢） */
  replanAssess: () => Promise<void>;
  /** v0.6：从磁盘恢复上次没答完的会话 */
  resumeAssess: () => Promise<void>;
  /** v0.6：把回答交给 AI 整理（先只出草稿，不写档案） */
  summarizeAssess: () => Promise<void>;
  /** v0.6：用户在审核界面逐条改写/删除字段 */
  editSummaryField: (field: 'headline' | 'scenario' | 'approach' | 'outcome', patch: Partial<SummaryField> | null) => void;
  /** v0.6：把用户确认后的内容写进档案 */
  applySummary: () => Promise<void>;
  /** v0.6：标记「这条问诊结论想重答」 */
  markStale: (skillName: string, reason: string) => Promise<void>;
  unmarkStale: (skillName: string) => Promise<void>;

  // v0.2 薄弱项训练
  generateTraining: () => Promise<void>;
  updateTrainingItem: (itemId: string, patch: { userAnswer?: string; selfScore?: SelfScore; markReviewed?: boolean; followUpCount?: number }) => Promise<void>;
  /** v0.6：判定当前答案是否达标，并落盘判定结果 */
  judgeTraining: (itemId: string) => Promise<void>;
  /** v0.6：把训练回答补成证据写进档案 */
  submitTrainingEvidence: (itemId: string) => Promise<void>;
  /** v0.6：判定不过但用户不想继续 —— 先放着，答案一个字都不删 */
  parkTraining: (itemId: string, reason: string) => Promise<void>;
  deleteTrainingPlan: (id: string) => Promise<void>;

  // ---- v0.2 追加：面试复盘 ----
  refreshCaptureEnvironment: () => Promise<void>;
  setMicDevice: (deviceId: string) => void;
  startInterviewCapture: (options: { mode: InterviewDebriefSession['mode']; sources: { mic: boolean; system: boolean }; quiet: boolean }) => Promise<void>;
  pauseInterviewCapture: () => void;
  resumeInterviewCapture: () => void;
  stopInterviewCapture: () => Promise<void>;
  /** 放弃本次录制（音频移入 _discarded/，不是删除） */
  discardInterviewCapture: () => Promise<void>;
  /** 没有录音也能用：直接粘贴 / 导入转写文本 */
  importTranscriptText: (text: string, options?: { mode?: InterviewDebriefSession['mode']; quiet?: boolean; label?: string }) => Promise<void>;
  updateTranscriptText: (sessionId: string, text: string) => Promise<void>;
  selectDebriefSession: (sessionId: string) => void;
  deleteDebriefSession: (sessionId: string) => Promise<void>;
  updateDebriefNotes: (sessionId: string, notes: string) => Promise<void>;
  runDebrief: (sessionId?: string) => Promise<void>;
  exportDebriefHtml: () => Promise<void>;
  exportDebriefJson: () => Promise<void>;
  openCaptureFolder: () => Promise<void>;
  loadSampleDebrief: () => Promise<void>;

  // 设置
  updateSettings: (patch: Partial<AiSettings>) => Promise<void>;
  testConnection: () => Promise<boolean>;

  // 工具
  loadSample: () => Promise<void>;
  exportJson: () => Promise<string | null>;
  clearAll: () => Promise<void>;
  resolveConfirm: (ok: boolean) => void;
  dismissToast: () => void;
  clearWarnings: () => void;
}

function toastOf(kind: ToastMessage['kind'], text: string): ToastMessage {
  return { id: `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind, text };
}

/**
 * 录音机与转写队列放在模块作用域，而不是 store 里。
 *
 * 原因：`MediaRecorder` / `AudioContext` / `MediaStream` 都是不可序列化的宿主对象，
 * 塞进 zustand 的状态里会让每次快照比较都变成一次无意义的大对象遍历。
 * store 只持有它们的**状态**（recorderState / elapsedMs / progress），实例本身放这里。
 */
let recorder: InterviewRecorder | null = null;
/** 转写必须串行：并发发请求既会打爆服务端限流，也会让分段顺序错乱 */
let transcribeChain: Promise<void> = Promise.resolve();
let transcribeFailureNotified = false;

function estimateTranscriptDuration(text: string): number {
  // 中文口播大约每秒 4 个字；只用于给「时长」一个量级参考，不作为分析依据
  return Math.round((text.replace(/\s/g, '').length / 4) * 1000);
}

function updateSegment(
  session: InterviewDebriefSession,
  index: number,
  patch: Partial<CaptureSegment>,
): InterviewDebriefSession {
  return {
    ...session,
    segments: session.segments.map((s) => (s.index === index ? { ...s, ...patch } : s)),
  };
}

/** 录音计时器放模块级：静默模式下界面可能不可见，但计时必须继续 */
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function stopElapsedTimer(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

export const useApp = create<AppStore>((set, get) => {
  const sync = () => {
    const ws = get().ws;
    if (ws) set({ snapshot: ws.state });
  };

  /**
   * 统一的提示出口。
   *
   * 静默录制期间直接 return —— 不是「把 toast 藏起来」，而是根本不产生。
   * 面试进行中屏幕上出现的任何东西都可能被对方看到，所以这一步必须在源头做。
   */
  const say = (kind: ToastMessage['kind'], text: string): void => {
    if (get().suppressToasts) return;
    set({ toast: toastOf(kind, text) });
  };

  const gatewayOptions = () => ({
    settings: get().snapshot.settings,
    transport,
    onTrace: (trace: AiTrace) => {
      get().ws?.addTrace(trace);
    },
    beforeSend: async (purpose: AiPurpose, messages: AiMessage[]) => {
      if (!get().snapshot.settings.confirmBeforeSend) return true;
      return new Promise<boolean>((resolve) => set({ confirm: { purpose, messages, resolve } }));
    },
  });

  /** 会话写库的统一入口。录音期间用 persist:false，避免每 20 秒重写一次全量快照 */
  const applySession = async (
    session: InterviewDebriefSession,
    options: { persist?: boolean } = {},
  ): Promise<void> => {
    set({ debriefSession: session });
    await get().ws?.upsertInterviewSession(session, options);
  };

  /**
   * 给转写服务的上下文提示。
   *
   * 只放岗位名与技能名这类**非身份信息** —— 它们能明显提升专有名词的识别率，
   * 而这几项本来就会出现在录音里，不构成新的泄露面。
   */
  const transcriptContextPrompt = (): string => {
    const job = get().ws?.activeJob();
    const profile = get().ws?.activeProfile();
    const bits: string[] = [];
    if (job) {
      bits.push(`岗位：${job.jobTitle}`);
      const keywords = job.items.flatMap((i) => i.keywords).slice(0, 20);
      if (keywords.length > 0) bits.push(`相关技能：${keywords.join('、')}`);
    }
    if (profile) {
      const skills = profile.skills.map((s) => s.name).slice(0, 15);
      if (skills.length > 0) bits.push(`候选人技能：${skills.join('、')}`);
    }
    return bits.join('；').slice(0, 400);
  };

  /**
   * 一段录音落盘 + 排队转写。
   *
   * 顺序是刻意的：**先落盘，再转写**。
   * 音频是不可再生的（面试不会重来），而转写失败随时可以重跑 ——
   * 任何情况下都不能让转写失败影响到录音的保存。
   */
  const handleSegment = async (sessionId: string, payload: CaptureSegmentPayload): Promise<void> => {
    const current = get().debriefSession;
    if (!current || current.id !== sessionId) return;

    let written = payload.bytes.byteLength;
    try {
      const result = await capturePort.writeSegment(sessionId, payload.fileName, payload.bytes);
      written = result.bytes;
    } catch (err) {
      say('error', `录音分片写入失败：${(err as Error).message}`);
      return;
    }

    const segment: CaptureSegment = {
      index: payload.index,
      fileName: payload.fileName,
      startOffsetMs: payload.startOffsetMs,
      durationMs: payload.durationMs,
      bytes: written,
      status: 'pending',
    };
    const merged: InterviewDebriefSession = {
      ...current,
      durationMs: recorder?.elapsedMs ?? current.durationMs,
      segments: [...current.segments.filter((s) => s.index !== segment.index), segment].sort(
        (a, b) => a.index - b.index,
      ),
    };
    await applySession(merged, { persist: false });
    set({ transcribeProgress: segmentProgress(merged.segments) });

    const settings = get().snapshot.settings;
    const transcriber = createTranscriber(settings, transport);
    if (!transcriber.isReady()) {
      // 「只录音、不转写」是合法配置而不是降级 —— 如实把段落标成 skipped
      const skipped = updateSegment(merged, payload.index, { status: 'skipped' });
      await applySession(skipped, { persist: false });
      set({ transcribeProgress: segmentProgress(skipped.segments) });
      return;
    }

    transcribeChain = transcribeChain.then(async () => {
      const session = get().debriefSession;
      if (!session || session.id !== sessionId) return;
      const target = session.segments.find((s) => s.index === payload.index);
      if (!target) return;
      await applySession(updateSegment(session, payload.index, { status: 'transcribing' }), { persist: false });

      const outcome = await transcriber.transcribe({
        audioBytes: payload.bytes,
        mimeType: payload.mimeType,
        fileName: payload.fileName,
        prompt: transcriptContextPrompt(),
      });

      const after = get().debriefSession;
      if (!after || after.id !== sessionId) return;

      if (!outcome.ok || !outcome.result) {
        const failed = updateSegment(after, payload.index, {
          status: 'failed',
          error: outcome.error ?? '转写失败',
        });
        await applySession({ ...failed, transcribeError: outcome.error }, { persist: false });
        set({ transcribeProgress: segmentProgress(failed.segments) });
        // 失败只提示一次：一段 20 秒，逐条弹窗会把界面刷满
        if (!transcribeFailureNotified) {
          transcribeFailureNotified = true;
          say('error', `转写失败，录音已完整保留：${outcome.error}`);
        }
        return;
      }

      const turns = turnsFromSegment({ ...target, status: 'done' }, outcome.result.text);
      const ok = updateSegment(after, payload.index, { status: 'done' });
      await applySession({ ...ok, turns: [...ok.turns, ...turns] }, { persist: false });
      set({ transcribeProgress: segmentProgress(ok.segments) });
    });
  };

  return {
    ready: false,
    ws: null,
    snapshot: createEmptySnapshot(),
    runtime: null,
    route: 'workbench',
    busy: null,
    progress: {},
    progressVisible: false,
    warnings: [],
    toast: null,
    confirm: null,
    assessSession: null,
    assessResult: null,
    assessResumed: false,
    assessSummary: null,
    lastMergeReport: null,
    assessMeta: null,
    trainingJudge: {},

    debriefSession: null,
    debriefReport: null,
    lastAnonymizeReport: null,
    recorderState: 'idle',
    recorderElapsedMs: 0,
    resolvedSources: null,
    transcribeProgress: { done: 0, total: 0, failed: 0 },
    captureEnv: {
      checked: false,
      supported: false,
      microphones: [],
      freeBytes: -1,
      lowSpace: false,
      directory: '',
      systemAudioHint: systemAudioHint(),
    },
    micDeviceId: '',
    suppressToasts: false,

    async init() {
      const ws = await WorkspaceStore.open(storagePort, (snapshot) => set({ snapshot }));
      const runtime = await runtimeInfo();
      set({ ws, snapshot: ws.state, runtime, ready: true });
    },

    navigate(route) {
      set({ route });
    },

    // ------------------------------------------------------------------
    // 档案
    // ------------------------------------------------------------------

    async importResumeFromText(text, label, sourceName, mode) {
      const ws = get().ws;
      if (!ws) return;
      if (!text.trim()) {
        set({ toast: toastOf('error', '内容为空，没有可解析的简历文本') });
        return;
      }
      const existingProfile = ws.activeProfile() ?? null;
      const effectiveMode = mode ?? (existingProfile ? 'merge' : 'replace');

      set({
        busy: 'resume',
        progressVisible: true,
        progress: Object.fromEntries(PARSE_STEPS.map((s) => [s.id, { status: 'pending' as StepStatus }])),
        warnings: [],
      });

      try {
        const result = await importResume({
          rawText: text,
          fileName: sourceName,
          profileLabel: label || existingProfile?.basics.displayName || '我的档案',
          existingProfile,
          mode: effectiveMode,
          ...gatewayOptions(),
          onProgress: (stepId, status, detail) =>
            set((state) => ({ progress: { ...state.progress, [stepId]: { status, detail } } })),
        });
        await ws.upsertProfile(result.profile);
        await ws.persist();
        sync();
        set({
          busy: null,
          progressVisible: false,
          warnings: result.warnings,
          lastMergeReport: result.mergeReport ?? null,
          route: 'profile',
          toast: toastOf(
            'success',
            result.mergeReport
              ? `已并入能力库：${result.mergeReport.summary}`
              : `档案已建立：${result.profile.skills.length} 项技能、${result.profile.projects.length} 个项目、${result.profile.evidence.length} 条证据`,
          ),
        });
      } catch (err) {
        set({
          busy: null,
          progressVisible: false,
          toast: toastOf('error', `简历解析失败：${(err as Error).message}`),
        });
      }
    },

    async importResumeFromFile() {
      set({ busy: 'pick' });
      try {
        const doc = await pickAndExtract();
        set({ busy: null });
        if (!doc) return;
        if (doc.warnings.length > 0) {
          set({ warnings: doc.warnings, toast: toastOf('info', doc.warnings[0]) });
        }
        if (!doc.text.trim()) {
          set({ toast: toastOf('error', `没有从 ${doc.fileName} 里提取到文字，请改用粘贴方式`) });
          return;
        }
        await get().importResumeFromText(doc.text, undefined, doc.fileName);
      } catch (err) {
        set({ busy: null, toast: toastOf('error', `读取文件失败：${(err as Error).message}`) });
      }
    },

    dismissMergeReport() {
      set({ lastMergeReport: null });
    },

    async updateProfile(profile) {
      const ws = get().ws;
      if (!ws) return;
      await ws.upsertProfile(recomputeProfile(profile));
      sync();
    },

    async deleteProfile(id) {
      const ws = get().ws;
      if (!ws) return;
      await ws.deleteProfile(id);
      sync();
      set({ toast: toastOf('info', '档案已删除') });
    },

    async reparseProfile() {
      const profile = get().ws?.activeProfile();
      if (!profile) {
        set({ toast: toastOf('error', '还没有可重新解析的档案') });
        return;
      }
      // 用已脱敏的文本重新跑一遍（不会把原始 PII 拉回来，这是刻意的）
      await get().importResumeFromText(profile.rawText, profile.basics.displayName, profile.rawSourceRef.locator);
    },

    // ------------------------------------------------------------------
    // 岗位
    // ------------------------------------------------------------------

    async analyzeJobText(text, options = {}) {
      const ws = get().ws;
      if (!ws) return;
      if (!text.trim()) {
        set({ toast: toastOf('error', '岗位内容为空') });
        return;
      }
      set({ busy: 'job', warnings: [] });
      try {
        const result = await analyzeJobDescription({
          rawText: text,
          source: options.source ?? 'text',
          sourceFileName: options.fileName,
          jobTitleHint: options.titleHint,
          ...gatewayOptions(),
        });
        await ws.upsertJob(result.job);
        sync();
        set({
          busy: null,
          warnings: result.warnings,
          route: 'job',
          toast: toastOf('success', `已拆解出 ${result.job.items.length} 条要求（${result.job.jobTitle}）`),
        });

        // 已经建立档案时，直接接着跑匹配 —— 这是文档第 23 节那个「3 分钟流程」
        const profile = ws.activeProfile();
        if (profile) {
          await get().runMatch();
        }
      } catch (err) {
        set({ busy: null, toast: toastOf('error', `岗位解析失败：${(err as Error).message}`) });
      }
    },

    async updateJob(job) {
      const ws = get().ws;
      if (!ws) return;
      await ws.upsertJob(recomputeJob(job));
      sync();
    },

    async deleteJob(id) {
      const ws = get().ws;
      if (!ws) return;
      await ws.deleteJob(id);
      sync();
      set({ toast: toastOf('info', '岗位记录已删除') });
    },

    // ------------------------------------------------------------------
    // 匹配
    // ------------------------------------------------------------------

    async runMatch() {
      const ws = get().ws;
      if (!ws) return null;
      const profile = ws.activeProfile();
      const job = ws.activeJob();
      if (!profile) {
        set({ toast: toastOf('error', '请先建立能力档案') });
        return null;
      }
      if (!job) {
        set({ toast: toastOf('error', '请先分析一个岗位') });
        return null;
      }

      set({ busy: 'match', warnings: [] });
      try {
        const matched = await runMatchPipeline({ profile, job, ...gatewayOptions() });
        await ws.addReport(matched.report);
        await ws.persist();
        sync();
        set({
          busy: null,
          route: 'match',
          warnings: matched.warnings,
          toast: toastOf(
            'success',
            `分析完成：满足 ${matched.result.summary.matched} · 部分满足 ${matched.result.summary.partial} · 缺少证据 ${matched.result.summary.lackingEvidence} · 缺口 ${matched.result.summary.gap}`,
          ),
        });
        return matched.report;
      } catch (err) {
        set({ busy: null, toast: toastOf('error', `匹配分析失败：${(err as Error).message}`) });
        return null;
      }
    },

    // ------------------------------------------------------------------
    // v0.2 能力问诊
    // ------------------------------------------------------------------

    startAssess: async (skillName, compact) => {
      const ws = get().ws;
      const profile = ws?.activeProfile();
      if (!profile) {
        set({ toast: toastOf('error', '请先建立能力档案') });
        return;
      }
      set({ busy: 'assess', assessResult: null, assessSummary: null, assessResumed: false });
      try {
        const planned = await planAssessmentSession({
          profile,
          skillName,
          job: ws?.activeJob() ?? null,
          compact,
          gateway: createPipelineGateway(gatewayOptions()),
        });
        const session: AssessSession = {
          id: newId('assess'),
          profileId: profile.id,
          skillName,
          jobId: ws?.activeJob()?.id,
          jobTitle: ws?.activeJob()?.jobTitle,
          questions: planned.questions,
          answers: [],
          status: 'draft',
          startedAt: new Date().toISOString(),
        };
        // v0.6：会话一开就落盘。之前只在 finishAssess 落盘，
        // 于是「开一场问诊 → 中途关掉应用」等于前面的功夫全白费
        await ws?.upsertAssessSession(session);
        set({
          busy: null,
          assessSession: session,
          assessMeta: {
            shape: planned.shape,
            shapeLabel: planned.shapeLabel,
            origin: planned.origin,
            suggestionCount: planned.suggestionCount,
            warnings: planned.warnings,
          },
        });
      } catch (err) {
        set({ busy: null });
        say('error', `出题失败：${(err as Error).message}`);
      }
    },

    /**
     * v0.6：换一套**未答的**题，已答的原样保留。
     *
     * 之前这里是 `await startAssess(session.skillName)` —— 而 startAssess 会
     * `set({ assessSession: null })` 后重开一个会话，于是**已答的全部被清空**。
     * UI 上的文案是「换一套问题」，用户以为只是换题，结果把一晚上的回答弄没了。
     * 这是全项目唯一一处「用户点一个看起来无害的按钮就丢数据」的地方。
     */
    async replanAssess() {
      const ws = get().ws;
      const session = get().assessSession;
      const profile = ws?.activeProfile();
      if (!session) return;
      if (session.answers.length > 0 && !get().confirm) return; // 交互由界面的 confirm 承担
      const next = replanQuestions(session, { profile });
      if (!next) {
        say('info', '没有更多可换的题目了 —— 已经答完，或者题库对这一项没有更多问法了。');
        return;
      }
      set({ assessSession: next });
      await ws?.upsertAssessSession(next);
      sync();
      say(
        'success',
        `已换 ${next.replacedQuestions?.length ?? 0} 道未答的题，你已答的 ${session.answers.length} 道题原样保留。`,
      );
    },

    answerAssess(questionId, answer) {
      const ws = get().ws;
      const session = get().assessSession;
      if (!session) return;
      const next = recordAnswer(session, { questionId, ...answer });
      set({ assessSession: next });
      // v0.6：答完一题立刻落盘。这是「不丢」的全部意义所在 ——
      // 只要他不关应用，他答过的每一道题都在磁盘上
      void ws?.upsertAssessSession(next);
    },

    draftAssess(draft) {
      const ws = get().ws;
      const session = get().assessSession;
      if (!session) return;
      const next = recordDraft(session, draft);
      set({ assessSession: next });
      // 草稿落盘但不强制写盘：边打字边写 SQLite 会卡，
      // 节流到切页时由 flushAssessSession 强制写一次
      void ws?.upsertAssessSession(next, { persist: false });
    },

    async resumeAssess() {
      const ws = get().ws;
      const profile = ws?.activeProfile();
      if (!ws || !profile) return;
      const session = ws.activeAssessSession(profile.id);
      if (!session) {
        set({ toast: toastOf('info', '没有找到没答完的问诊') });
        return;
      }
      set({ assessSession: session, assessResumed: true });
      sync();
      say('info', `已恢复上次的问诊：「${session.skillName}」，${session.answers.length} 道题已答。`);
    },

    async finishAssess() {
      const ws = get().ws;
      const session = get().assessSession;
      const profile = ws?.activeProfile();
      if (!ws || !session || !profile) return;

      set({ busy: 'assess' });
      try {
        const result = await evaluateAssessment({
          session,
          profile,
          gateway: createPipelineGateway(gatewayOptions()),
        });
        await ws.upsertProfile(result.updatedProfile);
        // v0.6：before/after 落盘。之前 before 只在函数返回值里飘过，
        // 关掉页面就没了，用户回到档案页仍然看不到「这次问诊改了什么」
        await ws.addAssessResult({
          assessment: result.assessment,
          before: {
            existed: result.before.existed,
            level: result.before.level,
            selfLevel: result.before.selfLevel,
            evidenceCount: result.before.evidenceCount,
            summary: result.before.summary,
          },
          evidenceIds: result.assessment.producedEvidenceIds,
          createdAt: result.assessment.createdAt,
        });
        await ws.deleteAssessSession(session.id);
        sync();
        set({
          busy: null,
          assessResult: result,
          assessSummary: null,
          assessSession: null,
          assessResumed: false,
          warnings: result.warnings,
          toast: toastOf(
            'success',
            result.evidence
              ? `问诊完成：掌握程度「${SKILL_LEVEL_LABEL[result.assessment.level]}」，并补充了 1 条证据（已并入能力库）`
              : `问诊完成：掌握程度「${SKILL_LEVEL_LABEL[result.assessment.level]}」，本次没有生成证据`,
          ),
        });
      } catch (err) {
        set({ busy: null, toast: toastOf('error', `问诊评估失败：${(err as Error).message}`) });
      }
    },

    cancelAssess() {
      const ws = get().ws;
      const session = get().assessSession;
      // 放弃会话要删掉磁盘上那份，否则下次进页面会「恢复」一个用户已放弃的问诊
      if (session) void ws?.deleteAssessSession(session.id);
      set({ assessSession: null, assessResult: null, assessMeta: null, assessSummary: null, assessResumed: false });
    },

    // ------------------------------------------------------------------
    // v0.6 回答整理 → 用户逐条审核 → 写进档案
    // ------------------------------------------------------------------

    async summarizeAssess() {
      const ws = get().ws;
      const session = get().assessSession;
      if (!session) return;
      set({ busy: 'assess' });
      try {
        const summary = await summarizeAnswer({
          answers: session.answers.map((a) => ({ layer: a.layer, text: a.text, skipped: a.skipped })),
          skillName: session.skillName,
          gateway: createPipelineGateway(gatewayOptions()),
        });
        if (summary.trace) get().ws?.addTrace(summary.trace);
        set({ busy: null, assessSummary: summary });
        if (summary.usable.length === 0) {
          say('info', '这次没有可整理的内容 —— 至少要回答「在什么场景下用过它」这一题。');
        }
      } catch (err) {
        set({ busy: null, toast: toastOf('error', `整理失败：${(err as Error).message}`) });
      }
    },

    editSummaryField(field, patch) {
      const summary = get().assessSummary;
      if (!summary) return;
      const current = summary[field];
      // null 表示用户删掉这一条 —— 这是合法操作，不是异常
      const next = patch === null ? (current ? { ...current, rejected: true } : null) : current ? { ...current, ...patch, edited: true } : null;
      set({ assessSummary: { ...summary, [field]: next } as AnswerSummary });
    },

    async applySummary() {
      const ws = get().ws;
      const summary = get().assessSummary;
      const session = get().assessSession;
      const profile = ws?.activeProfile();
      if (!ws || !summary || !session || !profile) return;

      const evidence = summaryToEvidence({
        skillName: session.skillName,
        jobTitle: session.jobTitle,
        summary,
        newId,
      });

      set({ busy: 'assess' });
      try {
        if (!evidence) {
          // 全部拒绝是合法结果，不是失败
          await ws.deleteAssessSession(session.id);
          sync();
          set({ busy: null, assessSummary: null, assessSession: null, assessResumed: false });
          say('info', '没有写入任何内容 —— 你的档案保持原样。');
          return;
        }

        const next: CandidateProfile = {
          ...profile,
          evidence: [...profile.evidence, evidence],
          updatedAt: new Date().toISOString(),
        };
        await ws.upsertProfile(finalizeProfile(next));
        await ws.deleteAssessSession(session.id);
        sync();
        set({ busy: null, assessSummary: null, assessSession: null, assessResumed: false });
        say('success', '已按你确认的内容写入能力库（来源标为「能力问诊」，强度封顶为「中」）。');
      } catch (err) {
        set({ busy: null, toast: toastOf('error', `写入失败：${(err as Error).message}`) });
      }
    },

    async markStale(skillName, reason) {
      const ws = get().ws;
      if (!ws) return;
      await ws.addStaleMark({ skillName, reason, createdAt: new Date().toISOString() });
      sync();
      say('info', `已标记「${skillName}」，下次进入问诊会提示你要不要重答。`);
    },

    async unmarkStale(skillName) {
      const ws = get().ws;
      if (!ws) return;
      await ws.removeStaleMark(skillName);
      sync();
      say('info', `已取消「${skillName}」的重答标记。`);
    },

    // ------------------------------------------------------------------
    // v0.2 薄弱项训练
    // ------------------------------------------------------------------

    async generateTraining() {
      const ws = get().ws;
      if (!ws) return;
      const profile = ws.activeProfile();
      const job = ws.activeJob();
      const report = ws.latestReport();
      if (!profile) {
        set({ toast: toastOf('error', '请先建立能力档案') });
        return;
      }
      if (!job) {
        set({ toast: toastOf('error', '请先分析一个岗位') });
        return;
      }
      if (!report || report.job.id !== job.id) {
        set({ toast: toastOf('error', '请先对这个岗位跑一次匹配分析，训练题是按匹配结果出的') });
        return;
      }

      set({ busy: 'training', warnings: [] });
      try {
        const built = await buildTrainingPlan({
          profile,
          job,
          matches: report.matches,
          gateway: createPipelineGateway(gatewayOptions()),
        });
        // 同一岗位只保留最新一份计划，避免越攒越多
        // v0.6：删之前先把已写的答案搬过去。之前直接删重建，
        // 用户写了一整晚的回答在点「重新生成」的那一刻全没了 —— 
        // 与「换一套问题清空答案」是同一类错误。
        const existing = ws.trainingPlanForJob(job.id);
        const carried = existing?.items.some((i) => i.userAnswer || i.evidenceIds?.length)
          ? carryOverAnswers(built.plan, existing)
          : built.plan;
        if (existing) await ws.deleteTrainingPlan(existing.id);
        await ws.upsertTrainingPlan(carried);
        const kept = carried.items.filter((i) => i.userAnswer).length;
        sync();
        set({
          busy: null,
          route: 'training',
          warnings: built.warnings,
          toast: toastOf(
            'success',
            kept > 0
              ? `已重新生成 ${carried.items.length} 道训练题，其中 ${kept} 道你写过的答案已保留`
              : `已生成 ${carried.items.length} 道训练题`,
          ),
        });
      } catch (err) {
        set({ busy: null, toast: toastOf('error', `生成训练计划失败：${(err as Error).message}`) });
      }
    },

    async updateTrainingItem(itemId, patch) {
      const ws = get().ws;
      const job = ws?.activeJob();
      if (!ws || !job) return;
      const plan = ws.trainingPlanForJob(job.id);
      if (!plan) return;
      await ws.upsertTrainingPlan(answerTrainingItem(plan, itemId, patch));
      sync();
    },

    /**
     * v0.6：判定这一题的答案是否达标。
     *
     * 判定结果同时写进训练计划（status / passedAt / lastJudgeHeadline），
     * 判据明细留在 store 的 `trainingJudge` 里供界面显示 ——
     * 设置页关掉「显示判定依据」只影响明文展示，判定本身照常发生。
     */
    async judgeTraining(itemId) {
      const ws = get().ws;
      const job = ws?.activeJob();
      if (!ws || !job) return;
      const plan = ws.trainingPlanForJob(job.id);
      if (!plan) return;
      const item = plan.items.find((i) => i.id === itemId);
      if (!item || !item.userAnswer || !item.userAnswer.trim()) {
        say('info', '先写点东西再判定 —— 空着没有可判的。');
        return;
      }

      const judgement = judgeTrainingAnswer({
        answer: item.userAnswer,
        item,
        followUpCount: item.followUpCount ?? 0,
      });

      await ws.upsertTrainingPlan(
        answerTrainingItem(plan, itemId, { judged: { passed: judgement.verdict === 'passed', headline: judgement.headline } }),
      );
      set({ trainingJudge: { ...get().trainingJudge, [itemId]: judgement } });
      sync();

      if (judgement.verdict === 'passed') {
        say('success', '这题答到了。它只能证明「你现在能讲清」—— 想确认岗位结论有没有变，去重跑一次匹配。');
      } else if (judgement.exhausted) {
        say('info', `还差一点：${judgement.headline}。可以先放着（答案会留着），也可以补一句再判。`);
      }
    },

    /**
     * v0.6：把训练回答补成证据写进能力库。
     *
     * 三条约束在这里生效：
     *   1. origin 固定 'qa' → 强度封顶「中」（MAX_STRENGTH_BY_ORIGIN）
     *      练到会讲不等于真做过，这条不能在训练这里松掉
     *   2. 只能挂到**这道题对应的那一个技能**上，不允许顺手改别的
     *   3. 走与简历导入同一条去重键（evidenceKey），不会重复堆
     */
    async submitTrainingEvidence(itemId) {
      const ws = get().ws;
      const job = ws?.activeJob();
      const profile = ws?.activeProfile();
      if (!ws || !job || !profile) return;
      const plan = ws.trainingPlanForJob(job.id);
      if (!plan) return;
      const item = plan.items.find((i) => i.id === itemId);
      if (!item || !item.userAnswer || !item.userAnswer.trim()) {
        say('info', '先写点东西 —— 空内容不会进能力库。');
        return;
      }

      const key = evidenceKey({ kind: 'project', title: `${item.skillName} · 训练补充`, content: item.userAnswer });
      const dup = profile.evidence.find((e) => evidenceKey(e) === key);
      if (dup) {
        say('info', '这条经历已经在档案里了（内容相同），不重复写入。');
        return;
      }

      const now = new Date().toISOString();
      const evidence: CandidateEvidence = {
        id: newId('evd'),
        kind: 'project',
        title: `${item.skillName} · 训练补充`,
        content: item.userAnswer.trim(),
        skills: [item.skillName],
        metrics: [],
        links: [],
        timeRange: undefined,
        strength: 'weak',
        strengthReason: TRAINING_EVIDENCE_WHY,
        origin: 'qa',
        fromJobTitle: job.jobTitle,
        sourceRef: {
          kind: 'user',
          locator: '薄弱项训练（用户自己写的回答）',
          excerpt: item.userAnswer.trim().slice(0, 160),
        },
        editedByUser: true,
        createdAt: now,
        updatedAt: now,
      };

      await ws.upsertProfile(
        finalizeProfile({
          ...profile,
          evidence: [...profile.evidence, evidence],
          updatedAt: now,
        }),
      );
      await ws.upsertTrainingPlan(answerTrainingItem(plan, itemId, { evidenceIds: [evidence.id] }));
      sync();
      say('success', '已补进能力库（只挂在这道题对应的技能上）。强度按「中」算 —— 想让它更硬，得补数字或链接。');
    },

    async parkTraining(itemId, reason) {
      const ws = get().ws;
      const job = ws?.activeJob();
      if (!ws || !job) return;
      const plan = ws.trainingPlanForJob(job.id);
      if (!plan) return;
      await ws.upsertTrainingPlan(parkTrainingItem(plan, itemId, reason));
      sync();
      say('info', '已标记「先放着」。你写的答案一个字都没删，随时可以回来继续。');
    },

    async deleteTrainingPlan(id) {
      const ws = get().ws;
      if (!ws) return;
      await ws.deleteTrainingPlan(id);
      sync();
      set({ toast: toastOf('info', '训练计划已删除') });
    },

    // ------------------------------------------------------------------
    // 设置
    // ------------------------------------------------------------------

    async updateSettings(patch) {
      const ws = get().ws;
      if (!ws) return;
      await ws.updateSettings(patch);
      sync();
    },

    async testConnection() {
      const settings = get().snapshot.settings;
      const gateway = new AiGateway(settings, {
        transport,
        onTrace: (trace) => {
          get().ws?.addTrace(trace);
        },
      });
      set({ busy: 'test' });
      const result = await gateway.testConnection();
      await get().ws?.persist();
      sync();
      set({ busy: null });
      if (result.value) {
        set({ toast: toastOf('success', '接口连通成功，已记录一条调用留痕') });
        return true;
      }
      set({ toast: toastOf('error', `连通失败：${result.error ?? '未知原因'}`) });
      return false;
    },

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------

    async loadSample() {
      // 档案名刻意不含真实姓名 —— 与「系统不保存姓名」的隐私设计保持一致
      await get().importResumeFromText(SAMPLE_RESUME, '示例档案', '内置示例简历.txt');
      await get().analyzeJobText(SAMPLE_JD, { titleHint: 'AI Agent 开发工程师', source: 'text', fileName: '内置示例岗位.txt' });
      set({ toast: toastOf('success', '示例数据已跑完整条链路，可以直接查看报告') });
    },

    async exportJson() {
      const { ws } = get();
      if (!ws) return null;
      const profile = ws.activeProfile();
      const job = ws.activeJob();
      const report = ws.latestReport();
      const payload = {
        exportedAt: new Date().toISOString(),
        note: '这是内部结构化 JSON 契约的原文（文档第十五节）。报告导出属于 v0.2 能力，此处导出的是原始数据。',
        profile: profile ?? null,
        job: job ?? null,
        report: report ?? null,
      };
      const name = `ai-job-partner-${new Date().toISOString().slice(0, 10)}.json`;
      const saved = await saveTextSafe(name, JSON.stringify(payload, null, 2));
      set({ toast: toastOf(saved ? 'success' : 'error', saved ? `已导出到 ${saved}` : '导出已取消') });
      return saved;
    },

    async clearAll() {
      const ws = get().ws;
      if (!ws) return;
      await ws.clearAll();
      sync();
      set({ toast: toastOf('info', '本地数据已清空') });
    },

    resolveConfirm(ok) {
      const confirm = get().confirm;
      if (!confirm) return;
      confirm.resolve(ok);
      set({ confirm: null });
    },

    dismissToast() {
      set({ toast: null });
    },

    clearWarnings() {
      set({ warnings: [] });
    },

    // ------------------------------------------------------------------
    // v0.2 追加：面试复盘
    // ------------------------------------------------------------------

    async refreshCaptureEnvironment() {
      const supported = capturePort.supported;
      let freeBytes = -1;
      let directory = '';
      let lowSpace = false;
      if (supported) {
        try {
          const space = await capturePort.freeSpace();
          freeBytes = space.freeBytes;
          directory = space.directory;
          lowSpace = space.isLow;
        } catch {
          /* 拿不到磁盘信息不影响录音，忽略 */
        }
      }
      const microphones = await listMicrophones();
      set({
        captureEnv: {
          checked: true,
          supported,
          unsupportedReason: supported
            ? undefined
            : '浏览器 / 演示模式只能做「粘贴转写文本 → 复盘」。录音与内录需要桌面端。',
          microphones,
          freeBytes,
          lowSpace,
          directory,
          systemAudioHint: systemAudioHint(),
        },
      });
    },

    setMicDevice(deviceId) {
      set({ micDeviceId: deviceId });
    },

    async startInterviewCapture(options) {
      const ws = get().ws;
      const profile = ws?.activeProfile();
      if (!ws || !profile) {
        say('error', '请先建立能力档案 —— 复盘报告要知道「你是谁」才能算适配度');
        return;
      }
      if (!isEnabled('interview.record')) {
        say('error', '当前版本未开放面试录音能力');
        return;
      }
      if (!capturePort.supported) {
        say('error', '浏览器 / 演示模式不支持录音落盘，请使用桌面端');
        return;
      }
      const state = get().recorderState;
      if (recorder && (state === 'recording' || state === 'paused' || state === 'starting')) {
        say('info', '已经在录制中了');
        return;
      }

      const job = ws.activeJob() ?? null;
      const settings = get().snapshot.settings;
      const sessionId = newId('sess');

      try {
        await capturePort.begin(sessionId);
      } catch (err) {
        say('error', `无法创建录音目录：${(err as Error).message}`);
        return;
      }

      try {
        const space = await capturePort.freeSpace();
        set((s) => ({
          captureEnv: { ...s.captureEnv, freeBytes: space.freeBytes, directory: space.directory, lowSpace: space.isLow },
        }));
        if (space.isLow && !options.quiet) {
          say('info', `磁盘剩余空间不足 200MB（${Math.round(space.freeBytes / 1024 / 1024)}MB），长时间录制可能中断`);
        }
      } catch {
        /* 忽略 */
      }

      if (options.sources.mic) {
        const permission = await mediaPort.requestMic();
        if (permission.status === 'denied') {
          say('error', permission.reason);
          return;
        }
      }
      if (options.sources.system) {
        const ok = await mediaPort.setSystemAudio(true);
        if (!ok) say('info', '系统内录未能开启，本次只录麦克风（对方的声音可能录不全）');
      }

      if (options.quiet) {
        // 顺序很重要：先让提示静音，再进入静默，避免中间那一瞬间漏出一个 toast
        set({ suppressToasts: true });
        await quietPort.set(true, {
          showTray: true,
          hideWindow: true,
          hotkey: settings.capture.hotkey,
        });
      }

      const session: InterviewDebriefSession = {
        ...createEmptyDebriefSession(profile.id, {
          mode: options.mode,
          sources: options.sources,
          quiet: options.quiet,
          jobId: job?.id,
          jobTitle: job?.jobTitle,
        }),
        id: sessionId,
        status: 'recording',
        startedAt: new Date().toISOString(),
      };
      await ws.upsertInterviewSession(session);
      sync();
      transcribeFailureNotified = false;
      set({
        debriefSession: session,
        debriefReport: null,
        lastAnonymizeReport: null,
        resolvedSources: null,
        transcribeProgress: { done: 0, total: 0, failed: 0 },
        recorderState: 'starting',
        recorderElapsedMs: 0,
        route: 'debrief',
      });

      recorder = new InterviewRecorder();
      try {
        await recorder.start({
          sources: options.sources,
          segmentSeconds: settings.capture.segmentSeconds,
          micDeviceId: get().micDeviceId || undefined,
          onSegment: (payload) => handleSegment(sessionId, payload),
          onError: (message) => say('error', message),
          onStateChange: (next) => set({ recorderState: next }),
          onResolvedSources: (actual) => {
            set({ resolvedSources: actual });
            if (actual.note && !options.quiet) say('info', actual.note);
          },
        });
      } catch (err) {
        recorder = null;
        await quietPort.set(false).catch(() => undefined);
        await mediaPort.setSystemAudio(false).catch(() => undefined);
        await ws.upsertInterviewSession({ ...session, status: 'failed' });
        sync();
        set({ suppressToasts: false, recorderState: 'error' });
        say('error', describeCaptureError(err));
        return;
      }

      stopElapsedTimer();
      elapsedTimer = setInterval(() => {
        const ms = recorder?.elapsedMs ?? 0;
        set({ recorderElapsedMs: ms });
        // 计时也要写进会话：万一应用被强杀，落盘的记录里至少有实际时长
        const current = get().debriefSession;
        if (current && current.id === sessionId) {
          void get().ws?.upsertInterviewSession({ ...current, durationMs: ms }, { persist: false });
        }
      }, 1000);

      set({ recorderState: 'recording', recorderElapsedMs: 0 });
      if (options.quiet) {
        say('success', '已在静默录制中');
      } else {
        say('success', '录制已开始');
      }
    },

    pauseInterviewCapture() {
      if (get().recorderState !== 'recording') return;
      recorder?.pause();
      set({ recorderState: 'paused' });
      say('info', '已暂停录制');
    },

    resumeInterviewCapture() {
      if (get().recorderState !== 'paused') return;
      recorder?.resume();
      set({ recorderState: 'recording' });
      say('info', '已继续录制');
    },

    async stopInterviewCapture() {
      const ws = get().ws;
      const session = get().debriefSession;
      if (!ws || !session) return;

      stopElapsedTimer();
      set({ recorderState: 'stopping' });
      const elapsed = recorder?.elapsedMs ?? session.durationMs;
      try {
        await recorder?.stop();
      } catch (err) {
        say('error', `停止录音时出错：${(err as Error).message}`);
      }
      recorder = null;
      // 等转写队列排空，否则最后一段会来不及落库
      await transcribeChain.catch(() => undefined);

      const finished: InterviewDebriefSession = {
        ...(get().debriefSession ?? session),
        status: 'ready',
        endedAt: new Date().toISOString(),
        durationMs: Math.max(elapsed, get().debriefSession?.durationMs ?? 0),
      };
      await applySession(finished, { persist: true });
      sync();
      set({ recorderState: 'stopped', recorderElapsedMs: 0, suppressToasts: false });

      await mediaPort.setSystemAudio(false).catch(() => undefined);
      await setStopHotkey(null).catch(() => undefined);
      if (session.quiet) await quietPort.set(false).catch(() => undefined);

      say('success', `录制结束：${finished.segments.length} 段音频 · ${finished.turns.length} 条转写`);
    },

    async discardInterviewCapture() {
      const ws = get().ws;
      const session = get().debriefSession;
      if (!ws || !session) return;

      stopElapsedTimer();
      if (recorder) {
        await recorder.stop().catch(() => undefined);
        recorder = null;
      }
      await transcribeChain.catch(() => undefined);
      await mediaPort.setSystemAudio(false).catch(() => undefined);
      await setStopHotkey(null).catch(() => undefined);
      if (session.quiet) await quietPort.set(false).catch(() => undefined);

      // 音频移入 recordings/_discarded/，不是删除 —— 面试不会重来
      let moved = true;
      try {
        await capturePort.discard(session.id);
      } catch {
        moved = false;
      }
      await ws.deleteInterviewSession(session.id);
      sync();
      set({
        debriefSession: null,
        debriefReport: null,
        lastAnonymizeReport: null,
        recorderState: 'idle',
        recorderElapsedMs: 0,
        suppressToasts: false,
      });
      say(
        'info',
        moved
          ? '本次录音已移到 recordings/_discarded/ 备份目录，没有直接删除'
          : '会话记录已删除；音频目录未能移动，请到录音目录手动处理',
      );
    },

    async importTranscriptText(text, options = {}) {
      const ws = get().ws;
      const profile = ws?.activeProfile();
      if (!ws || !profile) {
        say('error', '请先建立能力档案 —— 复盘报告要知道「你是谁」才能算适配度');
        return;
      }
      const trimmed = (text ?? '').trim();
      if (!trimmed) {
        say('error', '转写内容为空，没有可复盘的材料');
        return;
      }
      const job = ws.activeJob() ?? null;
      const session: InterviewDebriefSession = {
        ...createEmptyDebriefSession(profile.id, {
          mode: options.mode ?? 'onsite',
          quiet: options.quiet ?? true,
          jobId: job?.id,
          jobTitle: job?.jobTitle,
        }),
        id: newId('sess'),
        status: 'ready',
        manualTranscript: trimmed,
        durationMs: estimateTranscriptDuration(trimmed),
        notes: options.label ?? '',
      };
      await ws.upsertInterviewSession(session);
      sync();
      set({
        debriefSession: session,
        debriefReport: null,
        lastAnonymizeReport: null,
        route: 'debrief',
      });
      say('success', `已导入 ${trimmed.length} 字转写文本，可以直接开始复盘`);
    },

    async updateTranscriptText(sessionId, text) {
      const ws = get().ws;
      const session = ws?.interviewSessionById(sessionId);
      if (!ws || !session) return;
      const updated: InterviewDebriefSession = {
        ...session,
        manualTranscript: text,
        durationMs: estimateTranscriptDuration(text),
      };
      await ws.upsertInterviewSession(updated);
      sync();
      set({ debriefSession: updated });
    },

    selectDebriefSession(sessionId) {
      const ws = get().ws;
      if (!ws) return;
      const session = ws.interviewSessionById(sessionId) ?? null;
      set({
        debriefSession: session,
        debriefReport: session ? (ws.debriefReportForSession(session.id) ?? null) : null,
        lastAnonymizeReport: null,
        route: 'debrief',
      });
    },

    async deleteDebriefSession(sessionId) {
      const ws = get().ws;
      if (!ws) return;
      await ws.deleteInterviewSession(sessionId);
      sync();
      const next = ws.latestInterviewSession() ?? null;
      set({
        debriefSession: next,
        debriefReport: next ? (ws.debriefReportForSession(next.id) ?? null) : null,
        lastAnonymizeReport: null,
      });
      say('info', '面试记录已删除；录音文件仍保留在录音目录里');
    },

    async updateDebriefNotes(sessionId, notes) {
      const ws = get().ws;
      const session = ws?.interviewSessionById(sessionId);
      if (!ws || !session) return;
      const updated: InterviewDebriefSession = { ...session, notes };
      await ws.upsertInterviewSession(updated);
      sync();
      set({ debriefSession: updated });
    },

    async runDebrief(sessionId) {
      const ws = get().ws;
      if (!ws) return;
      const session = (sessionId ? ws.interviewSessionById(sessionId) : get().debriefSession) ?? null;
      if (!session) {
        say('error', '请先选择一次面试记录');
        return;
      }
      if (!isEnabled('interview.debrief')) {
        say('error', '当前版本未开放面试复盘');
        return;
      }
      if (!sessionTranscript(session).trim()) {
        say('error', '这次记录里既没有转写结果，也没有手工粘贴的内容');
        return;
      }

      set({ busy: 'debrief', warnings: [], route: 'debrief', debriefSession: session });
      try {
        const result = await buildInterviewDebrief({
          session,
          profile: ws.activeProfile() ?? null,
          job: ws.activeJob() ?? null,
          matchReport: ws.latestReport() ?? null,
          gateway: createPipelineGateway(gatewayOptions()),
        });
        await ws.upsertDebriefReport(result.report);
        const updated: InterviewDebriefSession = { ...session, status: 'analyzed' };
        await ws.upsertInterviewSession(updated);
        sync();
        const judged = result.report.dimensions.filter((d) => d.status !== 'insufficient_info').length;
        set({
          busy: null,
          debriefSession: updated,
          debriefReport: result.report,
          lastAnonymizeReport: result.anonymizeReport,
          warnings: result.warnings,
        });
        say('success', `复盘完成：${result.report.evidence.length} 条事实 · ${judged} 个维度有结论`);
      } catch (err) {
        set({ busy: null });
        say('error', `复盘失败：${(err as Error).message}`);
      }
    },

    async exportDebriefHtml() {
      const report = get().debriefReport;
      if (!report) {
        say('error', '还没有可导出的复盘报告');
        return;
      }
      if (!isEnabled('interview.debrief_export')) {
        say('error', '当前版本未开放报告导出');
        return;
      }
      try {
        const html = renderDebriefHtml(report, { subtitle: '由面试录音转写推导 · 自包含离线报告，不含任何外部请求' });
        const saved = await saveHtml(debriefHtmlFileName(report), html);
        say(saved ? 'success' : 'info', saved ? `已导出到 ${saved}` : '导出已取消');
      } catch (err) {
        say('error', `导出失败：${(err as Error).message}`);
      }
    },

    async exportDebriefJson() {
      const report = get().debriefReport;
      const session = get().debriefSession;
      if (!report) {
        say('error', '还没有可导出的复盘报告');
        return;
      }
      const payload = {
        exportedAt: new Date().toISOString(),
        note: '面试复盘的内部结构化契约原文。report 是唯一事实源，HTML 报告由它渲染而来；这里不含音频字节。',
        session: session ?? null,
        report,
      };
      const name = `面试复盘-${report.createdAt.slice(0, 10)}.json`;
      const saved = await saveText(name, JSON.stringify(payload, null, 2));
      say(saved ? 'success' : 'info', saved ? `已导出到 ${saved}` : '导出已取消');
    },

    async openCaptureFolder() {
      const session = get().debriefSession;
      if (!session) {
        say('error', '请先选择一次面试记录');
        return;
      }
      if (!capturePort.supported) {
        say('error', '浏览器 / 演示模式没有本地录音目录');
        return;
      }
      try {
        await capturePort.openFolder(session.id);
      } catch (err) {
        say('error', `打开录音目录失败：${(err as Error).message}`);
      }
    },

    async loadSampleDebrief() {
      await get().importTranscriptText(SAMPLE_INTERVIEW_TRANSCRIPT, {
        mode: 'onsite',
        quiet: true,
        label: '内置示例面试转写',
      });
      await get().runDebrief();
    },
  };
});

/** 导出走 bridge。独立成一个函数是为了让调用点读起来是「安全导出」而不是「随便写盘」 */
async function saveTextSafe(name: string, content: string): Promise<string | null> {
  // 原实现这里用 `await import('../lib/bridge')` 延迟加载，但 bridge 在本文件里本来就是
  // 静态导入的，动态导入只会让打包器报一条「同一模块既静态又动态导入」的警告，没有实际收益。
  return saveText(name, content);
}

export const defaultAiSettings = createDefaultAiSettings();
export const platformIsDesktop = isDesktop;
