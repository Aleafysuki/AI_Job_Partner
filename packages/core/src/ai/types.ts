import type { AiMessage, AiProviderId } from '../domain/ai-trace';

/**
 * AI Provider 抽象（文档 22.6：不要把业务逻辑写死在某一家模型 API 中）
 *
 * 分两层解耦：
 *   Provider  —— 负责「请求长什么样」（OpenAI 兼容 / Ollama / 未来的任何协议）
 *   Transport —— 负责「谁来发这个请求」（浏览器 fetch / Electron 主进程 / 代理）
 *
 * 这样渲染进程不需要持有 API Key，也能在浏览器模式下直接跑。
 */

export interface HttpRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
  /**
   * 二进制请求体（面试录音转写这类 multipart 请求需要）。
   *
   * 为什么用 Uint8Array 而不是 base64 字符串：
   * 1. Electron 的 IPC 用结构化克隆，Uint8Array 可以直接过去，不做编解码；
   * 2. base64 会让体积膨胀约 33%，而录音分片是这条链路上最大的一块数据；
   * 3. 核心层因此不需要依赖 Buffer（那是 Node 专属），只依赖 Web 标准的 TextEncoder。
   *
   * 与 `body` 二选一，同时存在时以 `bodyBytes` 为准。
   */
  bodyBytes?: Uint8Array;
  timeoutMs: number;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  text: string;
  /** 网络层错误（DNS / 超时 / 被拦截），与 HTTP 错误区分开 */
  networkError?: string;
}

export interface HttpTransport {
  request(input: HttpRequest): Promise<HttpResponse>;
  /** 描述这个 transport 会从哪里发出请求，用于透明度展示 */
  describe(): string;
}

/** 默认实现：直接使用全局 fetch（浏览器 / Electron 渲染进程 / Node 18+ 都可用） */
export class FetchTransport implements HttpTransport {
  describe(): string {
    return '当前进程直接发起 HTTPS 请求';
  }

  async request(input: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const res = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        // bodyBytes（音频分片）优先；类型断言是为了让本包不依赖 DOM 的 BodyInit 名
        body: (input.bodyBytes ?? input.body) as RequestInit['body'],
        signal: controller.signal,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    } catch (err) {
      const e = err as Error;
      return {
        ok: false,
        status: 0,
        text: '',
        networkError: e?.name === 'AbortError' ? `请求超时（>${input.timeoutMs}ms）` : e?.message || String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface CompletionRequest {
  messages: AiMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 要求模型返回 JSON */
  json?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  providerId: AiProviderId;
  durationMs: number;
  /**
   * v0.3 追加：服务端返回的 token 用量。
   *
   * 不做兜底估算 —— 估算统一放在 gateway.buildTrace() 里，
   * 这样「精确值」与「估算值」只有一处产生，不会出现两套口径。
   * Ollama 与不支持 usage 的兼容实现可以不填。
   */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface AiProvider {
  id: AiProviderId;
  label: string;
  modelName: string;
  /** 是否具备调用条件（有 key / 有地址） */
  isReady(): boolean;
  /** 不满足条件时给出人类可读原因 */
  whyNotReady(): string | undefined;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** 从模型返回的自由文本里抠出 JSON —— 模型经常包 ```json 围栏或加解释 */
export function extractJson(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const firstBrace = candidate.indexOf('{');
  const firstBracket = candidate.indexOf('[');
  let start = -1;
  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) start = firstBrace;
  else if (firstBracket >= 0) start = firstBracket;
  if (start < 0) return candidate;
  const openChar = candidate[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return candidate.slice(start);
}
