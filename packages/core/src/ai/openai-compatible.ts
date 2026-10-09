import type { AiSettings } from '../domain/ai-trace';
import type { AiProvider, CompletionRequest, CompletionResult, HttpTransport } from './types';

/**
 * OpenAI 兼容接口 Provider。
 * DeepSeek / OpenAI / Moonshot / 智谱 / DashScope 兼容模式 / 硅基流动 等都能用同一份实现。
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly id = 'openai-compatible' as const;
  readonly label = 'OpenAI 兼容接口';

  constructor(
    private settings: AiSettings,
    private transport: HttpTransport,
  ) {}

  get modelName(): string {
    return this.settings.model;
  }

  private endpoint(): string {
    const base = (this.settings.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (/\/chat\/completions$/.test(base)) return base;
    return `${base}/chat/completions`;
  }

  isReady(): boolean {
    return Boolean(this.endpoint() && this.settings.model && this.settings.apiKey);
  }

  whyNotReady(): string | undefined {
    if (!this.endpoint()) return '未填写接口地址（Base URL）';
    if (!this.settings.model) return '未填写模型名';
    if (!this.settings.apiKey) return '未填写 API Key';
    return undefined;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.settings.model,
      messages: req.messages,
      temperature: req.temperature ?? this.settings.temperature,
    };
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.json) body.response_format = { type: 'json_object' };

    const res = await this.transport.request({
      url: this.endpoint(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: JSON.stringify(body),
      timeoutMs: 90_000,
    });

    if (res.networkError) {
      throw new Error(`网络请求失败：${res.networkError}`);
    }
    if (!res.ok) {
      throw new Error(`接口返回 ${res.status}：${res.text.slice(0, 400) || '（空响应）'}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new Error(`接口返回不是合法 JSON：${res.text.slice(0, 200)}`);
    }

    const payload = parsed as {
      choices?: Array<{ message?: { content?: string } }>;
      // v0.3：兼容接口普遍会返回 usage，DeepSeek / 智谱 / Moonshot / SiliconFlow 都有
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('接口返回内容为空');
    }

    const promptTokens = payload.usage?.prompt_tokens;
    const completionTokens = payload.usage?.completion_tokens;

    return {
      text: content,
      model: this.settings.model,
      providerId: this.id,
      durationMs: Date.now() - started,
      usage:
        typeof promptTokens === 'number' && typeof completionTokens === 'number'
          ? { promptTokens, completionTokens }
          : undefined,
    };
  }
}
