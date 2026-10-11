/**
 * 回答整理（v0.6）
 * ================
 *
 * 用途：用户在能力问诊里写了一堆口语化的回答，系统把这些话**整理**成能进档案的描述，
 * 交给用户逐条确认后才写入。
 *
 * ── 这个引擎最重要的一条规则 ──
 *
 * **只能整理，不能补写。**
 *
 * 每一句话都必须能在用户原话里找到出处（`anchor`），找不到出处的字段一律丢弃，
 * 并在 `dropped` 里如实告诉用户「这句我没敢替你补」。
 *
 * 为什么这么严：这批文字会写进**跨岗位保留的能力库**，之后所有岗位的判断都用它。
 * 如果模型把「提升了响应速度」补成「提升了 30%」，用户不会立刻发现 ——
 * 他会在三个月后的面试里被问到那个 30% 是怎么测出来的，而那时他答不上来。
 *
 * 这与 v0.3 立下的「简历建议绝不为『你补一个 Redis 项目』开口子」是同一件事：
 * 编造的内容在面试的第二个问题就会崩。
 *
 * ── 所以这里宁可少写 ──
 *
 * 模型返回了但没锚点的字段 → 丢弃
 * 模型漏掉了用户说过的重点 → 丢弃（宁可漏，不可编）
 * 用户全部拒绝 → 那是合法结果，不是失败
 */

import type { AiGateway } from '../ai/gateway';
import type { AiMessage, AiTrace } from '../domain/ai-trace';
import type { CandidateEvidence } from '../domain/evidence';
import { truncate, unique } from '../utils/text';

export const SUMMARY_DISCLAIMER =
  '系统只把你说过的话重新组织一遍，不会替你补任何你没说的内容。' +
  '每一句都能点回看你的原话，你觉得哪句不对，直接改或者删掉。';

export interface SummaryField {
  /** 整理后的字段值 */
  value: string;
  /**
   * 用户原话里的出处片段（必须是原始回答的连续子串）。
   *
   * 这是硬要求，不是元数据：`anchor` 缺失或对不上原话的字段会被丢弃。
   * 没有它，用户就无法验证「这句是我说的吗」。
   */
  anchor: string;
  /** 用户可以用自己的话覆盖它 */
  edited?: boolean;
  /** 用户主动删掉了 */
  rejected?: boolean;
}

export interface AnswerSummary {
  /** 一句话概述（同样必须有 anchor） */
  headline: SummaryField | null;
  /** 场景：什么时候、什么项目、做了什么 */
  scenario: SummaryField | null;
  /** 做法：怎么做的、踩过什么坑 */
  approach: SummaryField | null;
  /** 结果：有什么可核对的东西 */
  outcome: SummaryField | null;
  /** 被丢弃的字段与原因（要给用户看，不能静默失败） */
  dropped: Array<{ field: string; reason: string }>;
  /** 真正可用的字段（应用用户编辑后的结果） */
  usable: SummaryField[];
  engine: 'rule' | 'ai';
  trace: AiTrace | null;
}

export interface SummarizeInput {
  /** 用户本次问诊的全部回答原文（拼接后作为 anchor 的比对基准） */
  answers: Array<{ layer: string; text: string; skipped?: boolean }>;
  skillName: string;
  gateway?: AiGateway;
}

/**
 * anchor 校验：必须真的出现在原话里。
 *
 * 为什么要程序校验而不是相信模型：模型经常会「顺手改写」它引用的原话，
 * 改写后语义相近但字面不同。字面不符 = 用户点「查看原话」看到的东西对不上，
 * 比不给 anchor 更糟 —— 那会让用户以为系统编了内容，而事实上只是错标。
 *
 * 判定口径：去空白后子串匹配。多打几个空格不算「没说过」。
 *
 * 标点**不算**容错 —— 原话用逗号、anchor 用句号，即使语义一样也判为对不上。
 * 这是刻意的偏严方向：宁可丢掉一条整理结果让用户自己补，也不要放进一条
 * 用户点开原话发现字面不符的条目 —— 那比不给更糟，它会让用户以为系统在编内容。
 */
export function anchorIsReal(anchor: string, source: string): boolean {
  const a = anchor.replace(/\s+/g, '');
  const s = source.replace(/\s+/g, '');
  return a.length > 0 && s.includes(a);
}

/** 规则版整理：不调模型，纯按 layer 把用户原话归位 */
function ruleSummary(input: SummarizeInput, source: string): Omit<AnswerSummary, 'engine' | 'trace'> {
  const dropped: Array<{ field: string; reason: string }> = [];
  const pick = (layer: string): SummaryField | null => {
    const hit = input.answers.find((a) => a.layer === layer && !a.skipped && a.text.trim());
    if (!hit) return null;
    return { value: hit.text.trim(), anchor: hit.text.trim() };
  };
  const scenario = pick('fact');
  const approach = pick('depth');
  const outcome = pick('output');
  const headline = scenario
    ? { value: `在${input.skillName}上：${truncate(scenario.value, 60)}`, anchor: scenario.anchor }
    : null;

  if (!scenario) dropped.push({ field: 'scenario', reason: '这次没有回答「在什么场景下用过它」，补上就能整理出来。' });

  return {
    headline,
    scenario,
    approach,
    outcome,
    dropped,
    usable: [headline, scenario, approach, outcome].filter((f): f is SummaryField => Boolean(f)),
  };
}

const SUMMARY_SYSTEM_PROMPT = `你把求职者口述的经历整理成档案条目。

铁律：
1. **只重新组织，不补充**。你写的每个要点都必须能在用户原话里找到出处。
2. 禁止补充用户没说的数字、指标、项目名、角色、时间、结果。
3. 禁止把含糊的话具体化（"提升了响应速度" 不能变成 "提升 30%"）。
4. 每个要点必须带上 \`anchor\`：用户原话里一段**连续的、不超过 40 字**的原文，逐字照抄，不要改标点。
5. 如果某一项在原话里找不到依据，就不要产出这一项。不要用常识补。
6. 用平实的书面语，不要夸张的形容词，不要给建议。

只输出 JSON，不要任何解释文字。`;

export async function summarizeAnswer(input: SummarizeInput): Promise<AnswerSummary> {
  const source = input.answers
    .filter((a) => !a.skipped)
    .map((a) => a.text)
    .join('\n')
    .trim();

  if (!source) {
    return {
      headline: null, scenario: null, approach: null, outcome: null,
      dropped: [{ field: '*', reason: '这次问诊没有写下具体内容，所以没有可整理的内容。' }],
      usable: [], engine: 'rule', trace: null,
    };
  }

  const base = ruleSummary(input, source);

  if (!input.gateway?.active) return { ...base, engine: 'rule', trace: null };

  // ---- 模型只用来「改写得更清楚」，失败就用规则版 ----
  const run = await input.gateway.runJson<Record<string, unknown>>('answer_summary', [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `能力名称：${input.skillName}`,
          '',
          '用户原话（anchor 必须从这里逐字摘取）：',
          source,
          '',
          '输出格式：',
          '{"headline":{"value":"","anchor":""},"scenario":{"value":"","anchor":""},',
          '"approach":{"value":"","anchor":""},"outcome":{"value":"","anchor":""}}',
          '找不到依据的字段写 null，不要编。',
        ].join('\n'),
      },
    ]);

  if (run.error || !run.value) {
    return {
      ...base,
      dropped: [...base.dropped, { field: '*', reason: `模型整理不可用，已按你的原话原样保留：${run.error ?? '返回为空'}` }],
      engine: 'rule',
      trace: null,
    };
  }

  const dropped: Array<{ field: string; reason: string }> = [...base.dropped];
  const pickField = (name: string): SummaryField | null => {
    const raw = (run.value as Record<string, unknown>)[name];
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as { value?: unknown; anchor?: unknown };
    const value = typeof obj.value === 'string' ? obj.value.trim() : '';
    const anchor = typeof obj.anchor === 'string' ? obj.anchor.trim() : '';
    if (!value) return null;
    // 关键闸门：没有出处就不要
    if (!anchor || !anchorIsReal(anchor, source)) {
      dropped.push({ field: name, reason: '模型给的这条在你原话里找不到出处，已经丢掉了 —— 不想凭空补内容。' });
      return null;
    }
    return { value, anchor };
  };

  const headline = pickField('headline');
  const scenario = pickField('scenario');
  const approach = pickField('approach');
  const outcome = pickField('outcome');

  // 模型一条都没产出有用的 → 直接退回规则版，不要让用户对着空屏
  const usable = [headline, scenario, approach, outcome].filter((f): f is SummaryField => Boolean(f));
  if (usable.length === 0) {
    return { ...base, dropped, engine: 'rule', trace: run.trace ?? null };
  }

  return {
    headline, scenario, approach, outcome,
    dropped: unique(dropped.map((d) => `${d.field}|${d.reason}`)).map((s) => {
      const [field, reason] = s.split('|');
      return { field, reason };
    }),
    usable,
    engine: 'ai',
    trace: run.trace ?? null,
  };
}

/**
 * 把用户确认后的字段写进一条证据。
 *
 * 三个必须守住的点：
 *   1. `origin: 'qa'` → 强度封顶「中」（MAX_STRENGTH_BY_ORIGIN），这是产品铁律。
 *      训练和问诊产出的都是自述，自述永远无法自证。
 *   2. `content` 里保留用户确认后的原文，不做任何改写。
 *   3. 用户改了某条字段 → `editedByUser: true`，finalizeProfile 会跳过它的强度重算，
 *      因为那是用户明确表达过的。
 */
export function summaryToEvidence(input: {
  skillName: string;
  jobTitle?: string;
  summary: AnswerSummary;
  newId: (prefix: string) => string;
}): CandidateEvidence | null {
  const { skillName, summary } = input;

  // 一条都不可用 → 不产出证据，而不是产出一条空的
  const live = summary.usable.filter((f) => !f.rejected && f.value.trim());
  if (live.length === 0) return null;

  const section = (label: string, field: SummaryField | null) =>
    field && !field.rejected && field.value.trim() ? `${label}：${field.value.trim()}` : '';

  const content = [
    section('场景', summary.scenario),
    section('做法与遇到的问题', summary.approach),
    section('结果', summary.outcome),
  ]
    .filter(Boolean)
    .join('\n');

  if (!content.trim()) return null;

  const now = new Date().toISOString();
  const userEdited = live.some((f) => f.edited);

  return {
    id: input.newId('evd'),
    kind: 'project',
    title: `${skillName} · 问诊补充`,
    content,
    skills: [skillName],
    metrics: [],
    links: [],
    timeRange: undefined,
    // 强度由 finalizeProfile 按 qa 封顶规则算；这里给 weak 是最低起点，
    // 避免在还没归一化之前就虚高
    strength: 'weak',
    strengthReason: '来自能力问诊的自述，尚无可核对载体',
    origin: 'qa',
    fromJobTitle: input.jobTitle,
    sourceRef: {
      kind: 'user',
      locator: '能力问诊（用户确认后的整理）',
      // 引用用户自己确认过的原话，而不是模型的改写
      excerpt: truncate(live.map((f) => f.anchor).join(' / '), 160),
    },
    editedByUser: userEdited,
    createdAt: now,
    updatedAt: now,
  };
}
