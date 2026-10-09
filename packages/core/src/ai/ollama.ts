import type { AiSettings } from '../domain/ai-trace';
import type { AiProvider, CompletionRequest, CompletionResult, HttpTransport } from './types';

/** Ollama 本地模型 Provider —— 完全离线可用，适合不想把简历发给云端的用户 */
export class OllamaProvider implements AiProvider {
  readonly id = 'ollama' as const;
  readonly label = 'Ollama 本地模型';

  constructor(
    private settings: AiSettings,
    private transport: HttpTransport,
  ) {}

  get modelName(): string {
    return this.settings.model;
  }

  private endpoint(): string {
    const base = (this.settings.baseUrl || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
    if (/\/api\/chat$/.test(base)) return base;
    return `${base}/api/chat`;
  }

  isReady(): boolean {
    return Boolean(this.endpoint() && this.settings.model);
  }

  whyNotReady(): string | undefined {
    if (!this.endpoint()) return '未填写 Ollama 服务地址';
    if (!this.settings.model) return '未填写模型名（例如 qwen2.5:7b）';
    return undefined;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.settings.model,
      messages: req.messages,
      stream: false,
      options: { temperature: req.temperature ?? this.settings.temperature },
    };
    if (req.json) body.format = 'json';

    const res = await this.transport.request({
      url: this.endpoint(),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 180_000,
    });

    if (res.networkError) {
      throw new Error(`无法连接到 Ollama：${res.networkError}`);
    }
    if (!res.ok) {
      throw new Error(`Ollama 返回 ${res.status}：${res.text.slice(0, 400)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new Error(`Ollama 返回不是合法 JSON：${res.text.slice(0, 200)}`);
    }

    const payload = parsed as {
      message?: { content?: string };
      // Ollama 的 /api/chat 返回的是 prompt_eval_count / eval_count，不是 OpenAI 那套 usage
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const content = payload?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Ollama 返回内容为空');
    }

    // 本地推理不计费，但 token 数仍然要记 —— 它决定了本地机器多久能跑完一次分析
    const promptTokens = payload.prompt_eval_count;
    const completionTokens = payload.eval_count;

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
