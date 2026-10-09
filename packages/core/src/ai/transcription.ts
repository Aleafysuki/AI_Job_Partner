import type { AiSettings, TranscriptionSettings } from '../domain/ai-trace';
import type { HttpTransport } from './types';

/**
 * 语音转写客户端。
 *
 * 定位与 `AiGateway` 平行，但刻意不复用它 —— 两者要发的东西完全不同：
 *   AiGateway     发的是**脱敏后的文本**，prompt / trace / JSON 校验都要走那套纪律；
 *   本模块         发的是**音频本身**，没有 prompt，返回的是自由文本，也不需要 JSON 解析。
 *
 * 因此这里单独一条通道，但共用同一套透明度设计：
 * - 音频走宿主的 HttpTransport（Electron 下由主进程出网，页面上下文里没有 Key）；
 * - 「是否允许把音频发出去」由 `TranscriptionSettings.enabled` 单独控制，
 *   与「允许调用远程模型」解耦 —— 用户可以接受发文本、但不接受发录音。
 *
 * 说话人分离（谁在说话）**不在这里做**：绝大多数 OpenAI 兼容转写接口都不返回 speaker，
 * 因此说话人由 `debrief-engine` 用提问/作答的语用特征做启发式推断，
 * 并在界面里明确标注「可手工改正」。
 */

export interface TranscriptionRequest {
  audioBytes: Uint8Array;
  /** 例如 audio/webm */
  mimeType: string;
  /** 传给服务端的文件名，扩展名要与 mimeType 一致（服务端常常靠扩展名判断容器） */
  fileName: string;
  language?: string;
  /** 上下文提示。把岗位名、技能名、公司内部术语放进去能明显改善专有名词识别 */
  prompt?: string;
  timeoutMs?: number;
}

export interface TranscriptionResult {
  text: string;
  model: string;
  durationMs: number;
  /** 服务端返回的整体时长（秒），部分服务不返回 */
  audioSeconds?: number;
}

export interface TranscriptionOutcome {
  ok: boolean;
  result?: TranscriptionResult;
  error?: string;
}

export interface AiTranscriber {
  readonly modelName: string;
  isReady(): boolean;
  whyNotReady(): string | undefined;
  transcribe(req: TranscriptionRequest): Promise<TranscriptionOutcome>;
  /** 人类可读的端点描述，用于透明度展示 */
  describe(): string;
}

/** OpenAI Whisper 的硬上限是 25MB；留一点余量给 multipart 的头 */
export const TRANSCRIPTION_MAX_BYTES = 24 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// multipart/form-data 构造（纯 Web 标准 API，不依赖 Buffer）
// ---------------------------------------------------------------------------

const BOUNDARY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomBoundary(): string {
  let suffix = '';
  for (let i = 0; i < 24; i += 1) {
    suffix += BOUNDARY_ALPHABET[Math.floor(Math.random() * BOUNDARY_ALPHABET.length)];
  }
  return `----aijob${suffix}`;
}

const encoder = new TextEncoder();

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface MultipartPart {
  name: string;
  value: string;
}

export interface MultipartFile {
  name: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * 拼一个 multipart/form-data 请求体。
 *
 * 手工拼是因为这个包不能依赖 Node 的 FormData/Blob（宿主无关约束），
 * 而浏览器侧的 FormData 又拿不出可直接发给 IPC 的字节。
 * 结果是这段代码在 Electron / 浏览器 / Node 下行为完全一致。
 */
export function buildMultipartBody(
  parts: MultipartPart[],
  file: MultipartFile,
  boundary: string,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const crlf = '\r\n';

  for (const part of parts) {
    chunks.push(encoder.encode(`--${boundary}${crlf}`));
    chunks.push(encoder.encode(`Content-Disposition: form-data; name="${part.name}"${crlf}${crlf}`));
    chunks.push(encoder.encode(`${part.value}${crlf}`));
  }

  chunks.push(encoder.encode(`--${boundary}${crlf}`));
  chunks.push(
    encoder.encode(`Content-Disposition: form-data; name="${file.name}"; filename="${file.fileName}"${crlf}`),
  );
  chunks.push(encoder.encode(`Content-Type: ${file.mimeType}${crlf}${crlf}`));
  chunks.push(file.bytes);
  chunks.push(encoder.encode(crlf));
  chunks.push(encoder.encode(`--${boundary}--${crlf}`));

  return concatBytes(chunks);
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** 部分服务返回 `{text}`，部分把结果包在 `{data:{text}}` 或返回纯文本，统一在这里收敛 */
export function extractTranscriptText(raw: string): { text: string; audioSeconds?: number } | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const direct = parsed.text ?? parsed.transcript ?? parsed.result;
    if (typeof direct === 'string') {
      const duration = parsed.duration ?? parsed.audio_duration;
      return { text: direct.trim(), audioSeconds: typeof duration === 'number' ? duration : undefined };
    }
    const nested = parsed.data;
    if (nested && typeof nested === 'object') {
      const inner = (nested as Record<string, unknown>).text;
      if (typeof inner === 'string') return { text: inner.trim() };
    }
    return null;
  } catch {
    // 不是 JSON —— 有的网关直接返回纯文本
    return { text: trimmed };
  }
}

/**
 * OpenAI 兼容的 `/audio/transcriptions` 客户端。
 *
 * 复用对话 Provider 的 baseUrl / apiKey 作为默认值：
 * 用户已经为对话配过一次，不该再配第二遍。
 */
export class OpenAiCompatibleTranscriber implements AiTranscriber {
  readonly modelName: string;
  private readonly settings: TranscriptionSettings;
  private readonly transport: HttpTransport;
  private readonly fallbackBaseUrl: string;
  private readonly fallbackApiKey: string;

  constructor(settings: AiSettings, transport: HttpTransport) {
    this.settings = settings.transcription;
    this.transport = transport;
    this.fallbackBaseUrl = settings.baseUrl;
    this.fallbackApiKey = settings.apiKey;
    this.modelName = this.settings.model || 'whisper-1';
  }

  private get baseUrl(): string {
    return (this.settings.baseUrl || this.fallbackBaseUrl || '').trim();
  }

  private get apiKey(): string {
    return (this.settings.apiKey || this.fallbackApiKey || '').trim();
  }

  isReady(): boolean {
    return Boolean(this.settings.enabled && this.baseUrl && (this.apiKey || this.isLocalEndpoint()));
  }

  whyNotReady(): string | undefined {
    if (!this.settings.enabled) return '设置里未开启「录音转写」，当前只录音不转写';
    if (!this.baseUrl) return '没有填写转写接口地址（Base URL）';
    if (!this.apiKey && !this.isLocalEndpoint()) return '没有填写转写接口的 API Key';
    return undefined;
  }

  /** 本机地址（Ollama / faster-whisper 这类）通常不需要 Key */
  private isLocalEndpoint(): boolean {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(this.baseUrl);
  }

  describe(): string {
    return `${this.baseUrl || '（未配置）'}/audio/transcriptions · 模型 ${this.modelName}`;
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionOutcome> {
    const notReady = this.whyNotReady();
    if (notReady) return { ok: false, error: notReady };

    if (req.audioBytes.length === 0) {
      return { ok: false, error: '音频分片为空，跳过' };
    }
    if (req.audioBytes.length > TRANSCRIPTION_MAX_BYTES) {
      return {
        ok: false,
        error: `音频分片 ${(req.audioBytes.length / 1024 / 1024).toFixed(1)}MB 超过 ${(TRANSCRIPTION_MAX_BYTES / 1024 / 1024).toFixed(0)}MB 上限，请把分片时长调短`,
      };
    }

    const boundary = randomBoundary();
    const parts: MultipartPart[] = [
      { name: 'model', value: this.modelName },
      { name: 'response_format', value: 'json' },
    ];
    const language = req.language ?? this.settings.language;
    if (language) parts.push({ name: 'language', value: language });
    if (req.prompt) parts.push({ name: 'prompt', value: req.prompt });

    const body = buildMultipartBody(
      parts,
      {
        name: 'file',
        fileName: req.fileName,
        mimeType: req.mimeType,
        bytes: req.audioBytes,
      },
      boundary,
    );

    const headers: Record<string, string> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const started = Date.now();
    const response = await this.transport.request({
      url: joinUrl(this.baseUrl, '/audio/transcriptions'),
      method: 'POST',
      headers,
      bodyBytes: body,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if (!response.ok) {
      const detail = response.networkError
        ? response.networkError
        : `HTTP ${response.status}：${response.text.slice(0, 200)}`;
      return { ok: false, error: detail };
    }

    const parsed = extractTranscriptText(response.text);
    if (!parsed) {
      return { ok: false, error: `无法解析转写返回：${response.text.slice(0, 160)}` };
    }

    return {
      ok: true,
      result: {
        text: parsed.text,
        model: this.modelName,
        durationMs: Date.now() - started,
        audioSeconds: parsed.audioSeconds,
      },
    };
  }
}

/**
 * 未配置转写时的占位实现。
 *
 * 存在的意义不是「兜底转写」（那做不到），而是让调用方永远只面对一个接口 ——
 * 拿不到转写就诚实返回原因，界面据此引导用户走「手工粘贴转写」这条路。
 */
export class DisabledTranscriber implements AiTranscriber {
  readonly modelName = '—';
  constructor(private reason = '未配置转写服务') {}
  isReady(): boolean {
    return false;
  }
  whyNotReady(): string | undefined {
    return this.reason;
  }
  describe(): string {
    return '未配置（只录音，不转写）';
  }
  async transcribe(): Promise<TranscriptionOutcome> {
    return { ok: false, error: this.reason };
  }
}

/** 按设置挑一个实现：能转就真转，不能转就返回带原因的占位实现 */
export function createTranscriber(settings: AiSettings, transport: HttpTransport): AiTranscriber {
  const client = new OpenAiCompatibleTranscriber(settings, transport);
  if (!client.isReady()) return new DisabledTranscriber(client.whyNotReady() ?? '未配置转写服务');
  return client;
}
