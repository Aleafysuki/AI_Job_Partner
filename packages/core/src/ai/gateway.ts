import type { AiMessage, AiPurpose, AiProviderId, AiSettings, AiTrace, AiUsage } from '../domain/ai-trace';
import { AI_PROVIDER_LABEL, costOf, estimateTokens } from '../domain/ai-trace';
import { newId } from '../utils/text';
import { OllamaProvider } from './ollama';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { FetchTransport, extractJson, type AiProvider, type HttpTransport } from './types';

/**
 * AI 网关。
 *
 * 职责：
 * 1. 根据设置决定「这次分析要不要用模型」——没配置/关掉远程调用时直接返回降级信号；
 * 2. 记录每一次调用的完整留痕（prompt / 返回 / 耗时 / 是否降级）；
 * 3. 永远不因为模型失败而让整个分析流程中断 —— 上层引擎会退到本地规则引擎。
 *
 * 这是文档「AI Provider 可替换」+「AI 输出可验证」+「不绑死某一家 API」的落地点。
 */

export interface GatewayOptions {
  transport?: HttpTransport;
  onTrace?: (trace: AiTrace) => void;
  /** 发送前拦截（对应设置里的「发送前确认」），返回 false 表示用户拒绝发送 */
  beforeSend?: (purpose: AiPurpose, messages: AiMessage[]) => boolean | Promise<boolean>;
}

export interface RunResult<T> {
  value: T | null;
  trace: AiTrace;
  error?: string;
}

export function createProvider(settings: AiSettings, transport: HttpTransport): AiProvider | null {
  switch (settings.providerId) {
    case 'openai-compatible':
      return new OpenAiCompatibleProvider(settings, transport);
    case 'ollama':
      return new OllamaProvider(settings, transport);
    default:
      return null;
  }
}

export class AiGateway {
  private provider: AiProvider | null;
  private transport: HttpTransport;

  constructor(
    public settings: AiSettings,
    private options: GatewayOptions = {},
  ) {
    this.transport = options.transport ?? new FetchTransport();
    this.provider = createProvider(settings, this.transport);
  }

  /** 本次分析是否真的会调用模型 */
  get active(): boolean {
    return Boolean(this.settings.allowRemote && this.provider?.isReady());
  }

  get providerLabel(): string {
    if (!this.settings.allowRemote) return '本地规则引擎（已关闭远程调用）';
    return this.provider ? AI_PROVIDER_LABEL[this.provider.id] : '本地规则引擎';
  }

  get modelName(): string {
    return this.provider?.modelName ?? '—';
  }

  get transportLabel(): string {
    return this.transport.describe();
  }

  /** 当前不可用时，给出明确原因（UI 直接展示给用户） */
  reasonUnavailable(): string | undefined {
    if (!this.settings.allowRemote) return '设置里未开启「允许调用远程模型」，当前使用本地规则引擎';
    if (!this.provider) return '当前选择的是本地规则引擎';
    return this.provider.whyNotReady();
  }

  private buildTrace(
    purpose: AiPurpose,
    messages: AiMessage[],
    partial: Partial<AiTrace> & { receivedRaw?: string; durationMs?: number; reportedUsage?: { promptTokens: number; completionTokens: number } },
  ): AiTrace {
    const sentChars = messages.reduce((n, m) => n + m.content.length, 0);
    const receivedRaw = partial.receivedRaw ?? '';
    const model = this.provider?.modelName ?? '—';
    const trace: AiTrace = {
      id: newId('trace'),
      purpose,
      providerId: (this.provider?.id ?? 'local') as AiProviderId,
      model,
      sentMessages: messages,
      receivedRaw,
      usedFallback: partial.usedFallback ?? false,
      fallbackReason: partial.fallbackReason,
      error: partial.error,
      promptChars: sentChars,
      responseChars: receivedRaw.length,
      durationMs: partial.durationMs ?? 0,
      usage: this.computeUsage(messages, receivedRaw, model, partial.reportedUsage, partial.usedFallback ?? false),
      createdAt: new Date().toISOString(),
    };
    this.options.onTrace?.(trace);
    return trace;
  }

  /**
   * 折算本次调用的 token 与费用。
   *
   * 三条口径，界面上必须区分开：
   *   1. 接口返回了 usage → 用它的，estimated = false；
   *   2. 没返回且真的调用了 → 本地估算，estimated = true；
   *   3. 没真正发出去（降级 / 未启用）→ 费用记 0，但仍记估算 token，
   *      因为用户要看到「如果这次真调了模型，大概会花多少」。
   * 第 3 条是刻意设计：只显示「0 元」会让人以为本地规则引擎不要钱，
   * 而它不要的是真金白银，不是算力。
   */
  private computeUsage(
    messages: AiMessage[],
    receivedRaw: string,
    model: string,
    reported: { promptTokens: number; completionTokens: number } | undefined,
    usedFallback: boolean,
  ): AiUsage {
    const sentText = messages.map((m) => m.content).join('');
    const promptTokens = reported?.promptTokens ?? estimateTokens(sentText);
    const completionTokens = reported?.completionTokens ?? estimateTokens(receivedRaw);
    // 本地 Ollama 不产生外部费用，恒为 0 —— 但 token 数照样记录
    if (this.provider?.id === 'ollama') {
      return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: !reported, costYuan: 0, pricingId: 'local' };
    }
    const { costYuan, pricingId } = costOf({ promptTokens, completionTokens }, model);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimated: !reported,
      // 降级（没真发出去）不算钱，但仍然保留估算 token 供对照
      costYuan: usedFallback && !reported ? 0 : costYuan,
      pricingId,
    };
  }

  /**
   * 发起一次要求 JSON 输出的调用。
   * 无论成功 / 失败 / 降级，都会产出一条 trace，value 为 null 时调用方必须走本地规则引擎。
   */
  async runJson<T>(purpose: AiPurpose, messages: AiMessage[], options: { maxTokens?: number } = {}): Promise<RunResult<T>> {
    if (!this.settings.allowRemote) {
      const trace = this.buildTrace(purpose, messages, {
        usedFallback: true,
        fallbackReason: '未开启远程模型调用',
      });
      return { value: null, trace, error: trace.fallbackReason };
    }

    if (!this.provider) {
      const trace = this.buildTrace(purpose, messages, {
        usedFallback: true,
        fallbackReason: '当前为本地规则引擎模式',
      });
      return { value: null, trace, error: trace.fallbackReason };
    }

    const notReady = this.provider.whyNotReady();
    if (notReady) {
      const trace = this.buildTrace(purpose, messages, { usedFallback: true, fallbackReason: notReady });
      return { value: null, trace, error: notReady };
    }

    if (this.options.beforeSend) {
      const allowed = await this.options.beforeSend(purpose, messages);
      if (!allowed) {
        const trace = this.buildTrace(purpose, messages, {
          usedFallback: true,
          fallbackReason: '用户取消了本次发送',
        });
        return { value: null, trace, error: trace.fallbackReason };
      }
    }

    const started = Date.now();
    try {
      const result = await this.provider.complete({
        messages,
        temperature: this.settings.temperature,
        json: true,
        maxTokens: options.maxTokens,
      });
      const jsonText = extractJson(result.text);
      let parsed: T | null = null;
      try {
        parsed = JSON.parse(jsonText) as T;
      } catch (parseErr) {
        const trace = this.buildTrace(purpose, messages, {
          receivedRaw: result.text,
          durationMs: Date.now() - started,
          usedFallback: true,
          fallbackReason: '模型返回的内容不是合法 JSON',
          error: (parseErr as Error).message,
        });
        return { value: null, trace, error: trace.fallbackReason };
      }
      const trace = this.buildTrace(purpose, messages, {
        receivedRaw: result.text,
        durationMs: result.durationMs,
        usedFallback: false,
        reportedUsage: result.usage,
      });
      return { value: parsed, trace };
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      const trace = this.buildTrace(purpose, messages, {
        durationMs: Date.now() - started,
        usedFallback: true,
        fallbackReason: `模型调用失败：${message}`,
        error: message,
      });
      return { value: null, trace, error: message };
    }
  }

  /** 设置页的连通性测试 */
  async testConnection(): Promise<RunResult<{ ok: boolean }>> {
    const messages: AiMessage[] = [
      { role: 'system', content: '你是一个测试端点。只输出 JSON。' },
      { role: 'user', content: '请输出 {"ok": true}' },
    ];
    return this.runJson<{ ok: boolean }>('connection_test', messages, { maxTokens: 64 });
  }
}

export type { HttpTransport } from './types';
export { FetchTransport, extractJson } from './types';
