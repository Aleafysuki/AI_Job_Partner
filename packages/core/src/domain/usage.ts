import type { AiTrace, AiUsage, ModelPricing } from './ai-trace';
import { AI_PURPOSE_LABEL, costOf, estimateTokens } from './ai-trace';

/**
 * 模型用量与费用统计（v0.3）
 * ========================
 *
 * 用户问的是「我花了多少钱」。这里必须诚实地处理三件事，否则这个数字会误导人：
 *
 * 1. **本应用查不到服务商的账户余额**。
 *    API Key 是用户自己填的，服务商后台的余额、账单、套餐都不在本机。
 *    任何声称能显示「余额」的界面都是假的。所以本模块只统计**本机累计调用**，
 *    界面必须同时说明「这不是账户余额，真实余额请到服务商后台看」。
 *
 * 2. **精确值与估算值不能混在一起显示**。
 *    接口返回 usage 时是精确的；没返回时是按字数估算的。
 *    两者混算会得到一个看起来很精确、实际不可信的总数，所以汇总里分开统计。
 *
 * 3. **本地规则引擎与本地模型不花钱**。
 *    但它们消耗的是用户的时间与算力，token 数照样要显示，
 *    否则会出现「本地模式显示 0 token 0 元」，用户无法判断哪个更省事。
 */

export interface UsageBucket {
  purpose: AiTrace['purpose'];
  label: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costYuan: number;
  /** 里面有多少条是估算值 */
  estimatedCalls: number;
}

export interface UsageSummary {
  calls: number;
  /** 真正发出去的请求数（降级到本地规则的不算） */
  remoteCalls: number;
  /** 走本地规则引擎、没有产生外部费用的次数 */
  localCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costYuan: number;
  /** 全部由估算得出的费用 */
  estimatedCostYuan: number;
  /** 全部由接口返回的 usage 算出的费用 */
  exactCostYuan: number;
  byPurpose: UsageBucket[];
  /** 按模型分组 */
  byModel: Array<{ model: string; calls: number; totalTokens: number; costYuan: number }>;
  /** 本地模型消耗的 token（不计费，但值得知道） */
  localTokens: number;
}

/**
 * 汇总一批留痕。
 *
 * 为什么要重算而不是累加已存费用：
 * 单价会变（模型换版本、服务商调价、用户手动改价）。
 * 存的是 token 数（事实），费用在读的时候按当前单价算（推导）——
 * 这样改了单价以后历史费用会一起变，不会出现新旧口径混在一张表里。
 */
export function summarizeUsage(traces: AiTrace[], pricingOverride?: ModelPricing | null): UsageSummary {
  const summary: UsageSummary = {
    calls: traces.length,
    remoteCalls: 0,
    localCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costYuan: 0,
    estimatedCostYuan: 0,
    exactCostYuan: 0,
    byPurpose: [],
    byModel: [],
    localTokens: 0,
  };

  const purposeMap = new Map<string, UsageBucket>();
  const modelMap = new Map<string, { model: string; calls: number; totalTokens: number; costYuan: number }>();

  for (const trace of traces) {
    const usage = usageOf(trace);
    const isLocal = trace.providerId === 'ollama' || trace.providerId === 'local';

    /**
     * 降级（usedFallback）意味着请求**根本没发出去** —— 没发出去就没有账单。
     * 之前漏判这一条，会把「没开远程调用」的用户算出一笔费用，
     * 那是最不能错的一类数字错误：它在凭空告诉用户「你花了钱」。
     */
    const freeOfCharge = isLocal || trace.usedFallback;

    if (isLocal) {
      summary.localCalls += 1;
      summary.localTokens += usage.totalTokens;
    } else if (!trace.usedFallback) {
      summary.remoteCalls += 1;
    } else {
      summary.localCalls += 1;
    }

    summary.promptTokens += usage.promptTokens;
    summary.completionTokens += usage.completionTokens;
    summary.totalTokens += usage.totalTokens;

    const { costYuan } = freeOfCharge
      ? { costYuan: 0 }
      : pricingOverride
        ? { costYuan: 0 } // 下面统一按 override 处理
        : costOf({ promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }, trace.model);

    const finalCost = freeOfCharge
      ? 0
      : pricingOverride
        ? Math.round(
            ((usage.promptTokens / 1_000_000) * pricingOverride.inputPerMillion +
              (usage.completionTokens / 1_000_000) * pricingOverride.outputPerMillion) *
              10_000,
          ) / 10_000
        : costYuan;

    if (!freeOfCharge) {
      summary.costYuan += finalCost;
      if (usage.estimated) summary.estimatedCostYuan += finalCost;
      else summary.exactCostYuan += finalCost;
    }

    const bucket =
      purposeMap.get(trace.purpose) ??
      ({
        purpose: trace.purpose,
        label: AI_PURPOSE_LABEL[trace.purpose] ?? trace.purpose,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costYuan: 0,
        estimatedCalls: 0,
      } satisfies UsageBucket);
    bucket.calls += 1;
    bucket.promptTokens += usage.promptTokens;
    bucket.completionTokens += usage.completionTokens;
    bucket.totalTokens += usage.totalTokens;
    bucket.costYuan = Math.round((bucket.costYuan + (freeOfCharge ? 0 : finalCost)) * 10_000) / 10_000;
    if (usage.estimated) bucket.estimatedCalls += 1;
    purposeMap.set(trace.purpose, bucket);

    const modelRow =
      modelMap.get(trace.model) ?? { model: trace.model, calls: 0, totalTokens: 0, costYuan: 0 };
    modelRow.calls += 1;
    modelRow.totalTokens += usage.totalTokens;
    modelRow.costYuan = Math.round((modelRow.costYuan + (freeOfCharge ? 0 : finalCost)) * 10_000) / 10_000;
    modelMap.set(trace.model, modelRow);
  }

  summary.byPurpose = Array.from(purposeMap.values())
    .map((b) => ({ ...b, costYuan: Math.round(b.costYuan * 10_000) / 10_000 }))
    .sort((a, b) => b.costYuan - a.costYuan || b.totalTokens - a.totalTokens);

  summary.byModel = Array.from(modelMap.values())
    .map((m) => ({ ...m, costYuan: Math.round(m.costYuan * 10_000) / 10_000 }))
    .sort((a, b) => b.costYuan - a.costYuan);

  summary.costYuan = Math.round(summary.costYuan * 10_000) / 10_000;
  summary.estimatedCostYuan = Math.round(summary.estimatedCostYuan * 10_000) / 10_000;
  summary.exactCostYuan = Math.round(summary.exactCostYuan * 10_000) / 10_000;

  return summary;
}

/**
 * 老留痕（v0.2 存的）没有 usage 字段，按字符估算补一个，保证统计不断档。
 *
 * 注意降级（usedFallback）的调用费用恒为 0：请求没发出去就没有账单。
 */
function usageOf(trace: AiTrace): AiUsage {
  if (trace.usage) return trace.usage;
  const promptTokens = estimateTokens(trace.sentMessages.map((m) => m.content).join(''));
  const completionTokens = estimateTokens(trace.receivedRaw);
  const free = trace.providerId === 'ollama' || trace.providerId === 'local' || trace.usedFallback;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
    costYuan: free ? 0 : null,
  };
}

/** 预算档位提示：给用户一个可执行的判断，而不是一个吓人的数字 */
export function budgetAdvice(summary: UsageSummary, budgetYuan: number | null | undefined): {
  level: 'none' | 'safe' | 'near' | 'over';
  text: string;
} {
  if (!budgetYuan || budgetYuan <= 0) {
    return { level: 'none', text: '还没有设置预算上限。设置之后，超过八成会在设置页提示。' };
  }
  const ratio = summary.costYuan / budgetYuan;
  if (ratio >= 1) {
    return { level: 'over', text: `已超出预算上限 ${Math.round((ratio - 1) * 100)}%，可以关掉远程调用继续用本地规则引擎。` };
  }
  if (ratio >= 0.8) {
    return { level: 'near', text: `已用掉预算的 ${Math.round(ratio * 100)}%，接近上限。` };
  }
  return { level: 'safe', text: `已用掉预算的 ${Math.round(ratio * 100)}%。` };
}

/** 按用途排序的一句话建议：告诉用户钱花在哪儿了 */
export function topCostAdvice(summary: UsageSummary): string | null {
  const top = summary.byPurpose.filter((b) => b.costYuan > 0)[0];
  if (!top) return null;
  const share = summary.costYuan > 0 ? Math.round((top.costYuan / summary.costYuan) * 100) : 0;
  return `花费最多的是「${top.label}」，占 ${share}%（${top.calls} 次调用）。关掉这一处的远程调用能省下大头。`;
}