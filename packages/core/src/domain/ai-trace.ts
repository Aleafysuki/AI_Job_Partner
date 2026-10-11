/**
 * AI 调用留痕（透明度设计，文档第十一节 / 第二十二节第 3、4 点）
 *
 * 每一次模型调用都被记录：发出去的到底是什么、返回了什么、有没有降级。
 * 用户可以在界面上逐条查看，并且能确认没有原始 PII 被送出。
 */

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type AiProviderId = 'local' | 'openai-compatible' | 'ollama';

export const AI_PROVIDER_LABEL: Record<AiProviderId, string> = {
  local: '本地规则引擎（不联网）',
  'openai-compatible': 'OpenAI 兼容接口',
  ollama: 'Ollama 本地模型',
};

export type AiPurpose =
  | 'connection_test'
  | 'profile_build'
  | 'job_analyze'
  | 'matching'
  | 'skill_assessment'
  /**
   * v0.3 追加：按当前能力动态生成问诊题目。
   *
   * 为什么要单独一个用途（而不是复用 skill_assessment）：
   * `skill_assessment` 是「读完用户的回答后给结论」，
   * 这一条是「还没问之前先想清楚该问什么」。
   * 两者的 prompt、返回结构、失败降级方式都不同，混在一起会让留痕失真。
   */
  | 'skill_questions'
  /** v0.4 追加：面试官问题 → 回答结构建议 */
  | 'interview_prep'
  | 'training_plan'
  | 'minimum_candidate'
  /**
   * v0.6 追加：把用户口述的回答整理成档案条目。
   *
   * 单独一个用途而不是复用 skill_assessment：
   * skill_assessment 是「读完给等级」，这一条是「读完给一段可写进档案的文字」，
   * 后者每个字段都要带 anchor（用户原话出处），校验方式完全不同。
   */
  | 'answer_summary'
  // ---- v0.2 追加：面试复盘链路 ----
  | 'interview_transcribe'
  | 'interview_debrief_evidence'
  | 'interview_debrief_analysis'
  | 'interview_debrief_synthesis';

export const AI_PURPOSE_LABEL: Record<AiPurpose, string> = {
  connection_test: '接口连通性测试',
  profile_build: '简历 → Candidate Profile',
  job_analyze: 'JD → Job Requirement',
  matching: 'Requirement → Evidence → Assessment',
  skill_assessment: '能力问诊 → 掌握程度判断',
  skill_questions: '能力问诊 → 动态出题',
  interview_prep: '面试问题 → 回答结构建议',
  training_plan: '薄弱项 → 训练计划',
  minimum_candidate: '最低候选人画像（v0.3）',
  answer_summary: '口述回答 → 档案条目（带原话出处）',
  interview_transcribe: '面试录音 → 文字转写',
  interview_debrief_evidence: '转写 → 原子事实抽取',
  interview_debrief_analysis: '原子事实 → 逐维度分析',
  interview_debrief_synthesis: '维度结论 → 情景与决策',
};

/**
 * v0.3 追加：一次调用的用量与折算费用。
 *
 * 为什么要有这个：用户问「花了多少钱」。此前界面只记录字符数，
 * 而不同服务商用「字符数」和「token 数」计价，口径完全不同，
 * 字符数换算出来的数字既不可信也不能拿去对账。
 *
 * 口径必须写清楚，不能含糊：
 *   - tokens 若接口返回了 usage 就用接口的（准确）；
 *   - 接口没返回时用本地估算（近似），并在 estimated 里标 true；
 *   - 本地 Ollama 不计费，cost 恒为 0。
 */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** true = 本地估算值，接口没返回 usage */
  estimated: boolean;
  /** 折算费用（元）。未配置单价时为 null —— 没有单价就不能编一个数字出来 */
  costYuan: number | null;
  /** 用的是哪一条单价 */
  pricingId?: string;
}

/** 单价表（人民币：每百万 token） */
export interface ModelPricing {
  id: string;
  label: string;
  /** 匹配用的关键词（对 model 名做小写包含匹配） */
  match: string[];
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * 常见模型单价（2026 年量级，元 / 百万 token）。
 *
 * 定位说明：这是**估算**，用来让用户知道大致花掉了多少，
 * 不是账单。真实开销以服务商后台为准 —— 界面也必须这么写。
 * 用户可以在设置里改价，改完所有历史费用会按新价重算。
 */
export const MODEL_PRICING: ModelPricing[] = [
  { id: 'deepseek-chat', label: 'DeepSeek V3', match: ['deepseek-chat'], inputPerMillion: 2.0, outputPerMillion: 8.0 },
  { id: 'deepseek-reasoner', label: 'DeepSeek R1', match: ['deepseek-reasoner'], inputPerMillion: 4.0, outputPerMillion: 16.0 },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', match: ['gpt-4o-mini'], inputPerMillion: 0.15, outputPerMillion: 0.6 },
  { id: 'gpt-4o', label: 'GPT-4o', match: ['gpt-4o'], inputPerMillion: 2.5, outputPerMillion: 10.0 },
  { id: 'qwen-plus', label: '通义千问 plus', match: ['qwen-plus'], inputPerMillion: 0.8, outputPerMillion: 2.0 },
  { id: 'glm-4-flash', label: '智谱 GLM-4-Flash', match: ['glm-4-flash'], inputPerMillion: 0.1, outputPerMillion: 0.1 },
  { id: 'moonshot', label: 'Moonshot', match: ['moonshot'], inputPerMillion: 12.0, outputPerMillion: 12.0 },
  { id: 'siliconflow', label: '硅基流动', match: ['siliconflow'], inputPerMillion: 0.5, outputPerMillion: 0.5 },
];

/** 找不到匹配时用一个保守的中位价，避免显示「0 元」这种明显不对的数字 */
export const FALLBACK_PRICING: ModelPricing = {
  id: 'fallback',
  label: '未收录模型（按通义千问 plus 的量级估）',
  match: [],
  inputPerMillion: 0.8,
  outputPerMillion: 2.0,
};

export function pricingFor(model: string): ModelPricing {
  const key = (model ?? '').toLowerCase();
  return MODEL_PRICING.find((p) => p.match.some((m) => key.includes(m))) ?? FALLBACK_PRICING;
}

export function costOf(usage: Pick<AiUsage, 'promptTokens' | 'completionTokens'>, model: string): {
  costYuan: number;
  pricingId: string;
} {
  const pricing = pricingFor(model);
  const cost =
    (usage.promptTokens / 1_000_000) * pricing.inputPerMillion +
    (usage.completionTokens / 1_000_000) * pricing.outputPerMillion;
  return { costYuan: Math.round(cost * 10_000) / 10_000, pricingId: pricing.id };
}

/**
 * token 估算。
 *
 * 中英文混排的实际分词比例约为 1 个汉字 ≈ 0.67 token、4 个英文字符 ≈ 1 token。
 * 取的是量级，不是精确对账 —— 中文比英文**更费** token（同样字符数下），
 * 这与直觉相反，所以这里显式写明，避免以后有人把除数写反。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿　-〿]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.round((cjk / 1.5 + rest / 4) * 10) / 10);
}

export interface AiTrace {
  id: string;
  purpose: AiPurpose;
  providerId: AiProviderId;
  model: string;
  /** 实际发送给模型的内容（已确认不含原始 PII） */
  sentMessages: AiMessage[];
  /** 模型返回的原始文本 */
  receivedRaw: string;
  /** 是否因为失败/未配置而降级到本地规则引擎 */
  usedFallback: boolean;
  fallbackReason?: string;
  error?: string;
  promptChars: number;
  responseChars: number;
  durationMs: number;
  /** v0.3 追加：本次调用的 token 用量与折算费用 */
  usage?: AiUsage;
  createdAt: string;
}

/**
 * 语音转写设置（面试复盘用）。
 *
 * 单独一组而不是复用上面的对话模型配置，原因是三件事不一样：
 * 1. 转写走的是 `/audio/transcriptions`，不是 `/chat/completions`；
 * 2. 它需要把**音频**发出去 —— 与「只发脱敏文本」完全不同级别的数据，
 *    因此必须有独立开关，让用户可以「只录音、不转写」；
 * 3. 转写模型和对话模型通常是两家（对话用 DeepSeek，转写用 Whisper）。
 */
export interface TranscriptionSettings {
  /** 转写总开关。关掉后只录音，转写文本由用户手工粘贴 —— 完全离线的路径 */
  enabled: boolean;
  /** 留空表示复用上面 Provider 的 baseUrl */
  baseUrl: string;
  /** 留空表示复用上面 Provider 的 apiKey */
  apiKey: string;
  model: string;
  /** 提示语言，空表示让服务端自动判断 */
  language: string;
}

export function createDefaultTranscriptionSettings(): TranscriptionSettings {
  return {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: 'whisper-1',
    language: 'zh',
  };
}

/** 常见转写服务预设，用户也可以自己填 */
export const TRANSCRIPTION_PRESETS = [
  { label: 'OpenAI Whisper', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  { label: '硅基流动 SenseVoice', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall' },
  { label: 'Groq Whisper Large v3', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
  { label: '本地 faster-whisper 服务', baseUrl: 'http://127.0.0.1:8000/v1', model: 'Systran/faster-whisper-small' },
  { label: '与上面的对话模型相同', baseUrl: '', model: 'whisper-1' },
];

/**
 * 面试录音设置。
 *
 * `quietByDefault` 默认 true 是本功能的一条产品立场：
 * 面试正在进行时，屏幕上多出来的任何东西都可能被对方看到 ——
 * 那会让用户陷入「解释不清」的处境，而这跟复盘本身毫无关系。
 */
export interface InterviewCaptureSettings {
  /** 默认静默录制：面试期间不弹提示、不弹窗、不改窗口标题、不动托盘图标 */
  quietByDefault: boolean;
  /** 线上面试默认是否叠一路系统内录（否则会丢掉面试官那一半对话） */
  systemAudioByDefault: boolean;
  /** 单个录音分片的目标时长（秒）。越短越接近实时，但请求次数越多 */
  segmentSeconds: number;
  /** 录音保留天数；0 表示不自动清理 */
  retentionDays: number;
  /** 全局快捷键（Electron accelerator 语法），留空表示不注册 */
  hotkey: string;
}

export function createDefaultCaptureSettings(): InterviewCaptureSettings {
  return {
    quietByDefault: true,
    systemAudioByDefault: true,
    segmentSeconds: 20,
    retentionDays: 0,
    hotkey: 'Control+Alt+R',
  };
}

export interface AiSettings {
  providerId: AiProviderId;
  /** OpenAI 兼容接口的 base url，例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** 是否在每次分析前把脱敏后的内容展示给用户确认 */
  confirmBeforeSend: boolean;
  /** 关闭后所有分析走本地规则引擎 */
  allowRemote: boolean;
  /** v0.2 追加：面试录音 → 文字转写 */
  transcription: TranscriptionSettings;
  /** v0.2 追加：录音行为与静默策略 */
  capture: InterviewCaptureSettings;
  /**
   * v0.3 追加：月度费用预算上限（元）。
   *
   * 为什么需要：模型调用是花钱的，而默认设置是「只发脱敏文本」而不是「不发」。
   * 用户要能自己定一条线。null / 0 表示不限制 —— 但界面必须提醒这是不限制。
   */
  monthlyBudgetYuan: number | null;
}

export function createDefaultAiSettings(): AiSettings {
  return {
    providerId: 'local',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.2,
    confirmBeforeSend: false,
    allowRemote: false,
    transcription: createDefaultTranscriptionSettings(),
    capture: createDefaultCaptureSettings(),
    monthlyBudgetYuan: null,
  };
}

/** 合并设置：老快照缺哪个子对象就补默认值（深合并，避免顶层展开把新字段丢掉） */
export function normalizeAiSettings(raw: Partial<AiSettings> | null | undefined): AiSettings {
  const base = createDefaultAiSettings();
  const data = raw ?? {};
  return {
    ...base,
    ...data,
    transcription: { ...base.transcription, ...(data.transcription ?? {}) },
    capture: { ...base.capture, ...(data.capture ?? {}) },
  };
}

/** 常见 OpenAI 兼容服务商预设，用户也可以自己填 */
export const PROVIDER_PRESETS = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Moonshot（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: '阿里通义 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' },
  { label: '自定义', baseUrl: '', model: '' },
];
