import type { AiTrace } from '../domain/ai-trace';
import type { Assessment, TriLevel } from '../domain/common';
import type {
  CaptureSegment,
  DebriefBasis,
  DebriefCharts,
  DebriefComputation,
  DebriefDecisionTier,
  DebriefDimStatus,
  DebriefDimension,
  DebriefEvidence,
  DebriefEvidenceType,
  DebriefFitAssessment,
  DebriefFitItem,
  DebriefFinding,
  DebriefPressureLevel,
  DebriefQuestion,
  DebriefQuestionCategory,
  DebriefScenario,
  DebriefSynthesis,
  DebriefTable,
  InterviewDebriefReport,
  InterviewDebriefSession,
  InterviewPerformanceSummary,
  PerformanceOverall,
  Speaker,
  TranscriptTurn,
} from '../domain/debrief';
import {
  DEBRIEF_BOUNDARY_STATEMENT,
  DEBRIEF_DISCLAIMER,
  DEBRIEF_SCHEMA_VERSION,
  pressureToScore,
  sessionTranscript,
} from '../domain/debrief';
import type { JobRequirement } from '../domain/job';
import type { CandidateProfile } from '../domain/profile';
import type { AnalysisReport } from '../domain/report';
import { anonymizeTranscript, type AnonymizeReport } from '../debrief/anonymize';
import {
  BOUNDARY_PATTERNS,
  CANDIDATE_QUESTION_PATTERNS,
  COMPENSATION_INPUTS,
  DECISION_TIERS,
  DEPTH_PATTERNS,
  DEBRIEF_DIMENSIONS,
  EVASION_PATTERNS,
  FACT_PATTERNS,
  FIT_DIMENSIONS,
  HARD_REQUIREMENT_CHECKLIST,
  IMPLICIT_REQUIREMENT_CHECKLIST,
  INTERVIEWER_PATTERNS,
  PERFORMANCE_DIMENSION_DEFS,
  RISK_SIGNALS,
  SCENARIO_TYPES,
  STRESS_TYPES,
  STRUCTURE_MARKERS,
  SUSTAINABILITY_AXES,
  VAGUE_PATTERNS,
  WORKDAY_MINUTES,
  WORK_TYPE_TAXONOMY,
  workloadTimeTable,
} from '../debrief/dimensions';
import type { AiGateway } from '../ai/gateway';
import {
  DEBRIEF_ANALYSIS_SYSTEM_PROMPT,
  DEBRIEF_EVIDENCE_SYSTEM_PROMPT,
  DEBRIEF_SYNTHESIS_SYSTEM_PROMPT,
} from '../ai/prompts';
import { findSkillsInText, textMentionsSkill } from '../nlp/skills';
import { clamp, newId, normalizeText, truncate } from '../utils/text';

/**
 * 面试复盘引擎（v0.2 追加）
 * ==========================
 *
 * 四步，和 `multi-dimension-fit-report` 的纪律一一对应：
 *
 *   ① 证据抽取  —— 把转写拆成原子事实（一句话一个 fact，带数字的原样保留）
 *   ② 维度分析  —— 机会侧 D1–D12 + 表现侧 P1–P6，每条结论必须挂上证据编号
 *   ③ 适配评定  —— 复用项目的五档结论与证据强度刻度，不新造评分体系
 *   ④ 综合决策  —— 三种情景 + 三档决策表 + 唯一一个下一步动作
 *
 * 两条贯穿全局的实现原则：
 *
 * **A. 规则是主体，模型是增强。**
 * 每一阶段都先算一份确定性的规则结果；模型可用时用它的输出覆盖对应字段，
 * 模型失败/没配 Key/返回非法 JSON 时**整条链路照常产出报告**。
 * 这样复盘永远不会因为「今天接口不通」而变成不可用功能。
 *
 * **B. 判断不交给模型。**
 * 压力等级映射、可行性测算、证据编号校验、表现密度统计全都由本地算；
 * 模型只负责「把中文读懂」—— 它描述得再好，也改不了数字和证据链。
 */

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 句末切分。转写文本没有段落结构，只能靠标点断句 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/\s/g, '').length >= 4);
}

/** 说话人标签：【面试方】【我】【未区分】，与 SPEAKER_LABEL 对应 */
function parseSpeakerTag(line: string): { speaker: Speaker; text: string } {
  const match = /^【([^】]+)】\s*(.*)$/.exec(line.trim());
  if (!match) return { speaker: 'unknown', text: line.trim() };
  const label = match[1];
  const body = match[2].trim();
  if (label.includes('面试方') || label.includes('面试官') || label.includes('招聘')) return { speaker: 'interviewer', text: body };
  if (label === '我' || label.includes('求职') || label.includes('候选人')) return { speaker: 'candidate', text: body };
  return { speaker: 'unknown', text: body };
}

/**
 * 推断说话人。
 *
 * 这不是「说话人分离」（那需要双声道或专门的 diarization 模型），
 * 而是语用启发式：面试方更常提问、更常提「我们公司 / 这个岗位」，
 * 求职者更常讲「我做过 / 我之前」。
 * 因此界面上必须允许用户手工改正 —— 标错会直接污染表现侧评分。
 */
export function inferSpeaker(text: string): Speaker {
  const t = text.trim();
  if (!t) return 'unknown';
  const interviewer = INTERVIEWER_PATTERNS.filter((re) => re.test(t)).length;
  const candidate = [/我(之前|当时|做过|负责|参与|是|在)/, /(我的|我们团队|我个人)/, /(离职|跳槽|简历|投递)/].filter((re) => re.test(t)).length;
  if (interviewer > candidate) return 'interviewer';
  if (candidate > interviewer) return 'candidate';
  if (/[?？]\s*$/.test(t)) return 'interviewer';
  return 'unknown';
}

function uniqueBy<T, K>(items: T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function countMatches(patterns: RegExp[], text: string): number {
  return patterns.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
}

function anyMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

function pct(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

// ---------------------------------------------------------------------------
// ① 证据抽取
// ---------------------------------------------------------------------------

export interface RawTurn {
  speaker: Speaker;
  text: string;
  startOffsetMs: number;
  endOffsetMs: number;
}

/** 把会话的转写段落摊平成「轮」；没有 ASR 结果时退回手工粘贴的整段文本 */
export function debriefTurns(session: InterviewDebriefSession): RawTurn[] {
  if (session.turns.length > 0) {
    return session.turns
      .slice()
      .sort((a, b) => a.startOffsetMs - b.startOffsetMs)
      .map((t) => ({
        speaker: t.speaker,
        text: t.text,
        startOffsetMs: t.startOffsetMs,
        endOffsetMs: t.endOffsetMs,
      }));
  }
  const manual = (session.manualTranscript ?? '').trim();
  if (!manual) return [];
  const lines = manual.split('\n').map((l) => l.trim()).filter(Boolean);
  let offset = 0;
  return lines.map((line) => {
    const parsed = parseSpeakerTag(line);
    const speaker = parsed.speaker === 'unknown' ? inferSpeaker(parsed.text) : parsed.speaker;
    const start = offset;
    offset += Math.max(2000, parsed.text.length * 180);
    return { speaker, text: parsed.text, startOffsetMs: start, endOffsetMs: offset };
  });
}

export function classifyTopic(text: string, speaker: Speaker): DebriefEvidence['topic'] {
  const t = text;
  if (/(薪|工资|月薪|底薪|绩效|到手|税前|税后|五险|社保|公积金|补贴|奖金|提成|福利|年假|待遇|签字费)/.test(t)) return 'pay';
  if (/(上班|下班|工时|加班|排班|轮班|倒班|大小周|单休|双休|作息|几点|节假日|值班|弹性|到岗)/.test(t)) return 'schedule';
  if (/(多少(个|条|单|件)|任务量|工作量|指标|KPI|考核|单量|工单|配额|定额|产出量)/i.test(t)) return 'workload';
  if (/(要求|需要|必须|学历|本科|大专|硕士|经验|年限|证书|专业|门槛|统招|全日制|资格)/.test(t)) return 'requirement';
  if (/(团队|同事|氛围|领导|老板|管理风格|文化|办公|环境|出差|地点|工位|通勤)/.test(t)) return 'environment';
  if (/(负责|工作内容|岗位职责|主要做|日常|业务|产品|系统|项目|开发|运营|设计|对接|流程)/.test(t)) return 'content';
  if (speaker === 'candidate') return 'performance';
  return 'other';
}

export function classifyEvidenceType(text: string): DebriefEvidenceType {
  const hasNumber = /\d/.test(text) && FACT_PATTERNS.some((re) => re.test(text));
  const evasionPatterns = RISK_SIGNALS.find((s) => s.key === 'evasion')?.patterns ?? [];
  if (anyMatch(EVASION_PATTERNS, text) || anyMatch(evasionPatterns, text)) return 'evasion';
  if (/如果.{0,24}(就|可以|能)|只要.{0,16}(就|可以)|表现(好|优秀).{0,10}(可以|能)/.test(text)) return 'promise';
  if (/(成长|空间大|机会多|平台好|能学到|锻炼|前景|氛围很好)/.test(text)) return 'claim';
  if (hasNumber) return 'number';
  return 'fact';
}

/** 同一 topic 下出现互相矛盾的数字 → 全部标 conflicting（它们是 D9 与 D11 的输入） */
function markConflicts(evidence: DebriefEvidence[]): DebriefEvidence[] {
  const groups = new Map<string, DebriefEvidence[]>();
  for (const e of evidence) {
    if (e.type !== 'number') continue;
    const list = groups.get(e.topic) ?? [];
    list.push(e);
    groups.set(e.topic, list);
  }
  const conflicting = new Set<string>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const numbers = new Set(
      list.flatMap((e) => (e.quote.match(/\d+(\.\d+)?/g) ?? []).map((n) => String(Number(n)))),
    );
    if (numbers.size > 1) for (const e of list) conflicting.add(e.id);
  }
  return evidence.map((e) => (conflicting.has(e.id) ? { ...e, consistency: 'conflicting' as const } : e));
}

export const MAX_DEBRIEF_EVIDENCE = 400;

/**
 * 规则版证据抽取。
 *
 * 这一份是**兜底，也是基准**：模型可用时它的结果会与模型输出合并，
 * 模型不可用时它就是最终结果 —— 所以它必须自己站得住。
 */
export function extractEvidenceByRule(transcript: string): DebriefEvidence[] {
  const turns = transcript
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = parseSpeakerTag(line);
      return { speaker: parsed.speaker === 'unknown' ? inferSpeaker(parsed.text) : parsed.speaker, text: parsed.text };
    });

  const evidence: DebriefEvidence[] = [];
  let seq = 1;
  for (const turn of turns) {
    for (const sentence of splitSentences(turn.text)) {
      if (evidence.length >= MAX_DEBRIEF_EVIDENCE) break;
      evidence.push({
        id: `E${seq}`,
        quote: truncate(sentence, 200),
        speaker: turn.speaker,
        type: classifyEvidenceType(sentence),
        topic: classifyTopic(sentence, turn.speaker),
        consistency: 'unique',
      });
      seq += 1;
    }
  }
  return markConflicts(evidence);
}

export interface DebriefEvidenceExtractOutput {
  evidence: DebriefEvidence[];
  engine: 'rule' | 'ai' | 'hybrid';
  trace: AiTrace | null;
  warning?: string;
}

export interface AiEvidenceShape {
  evidence?: Array<{
    id?: string;
    quote?: string;
    speaker?: string;
    type?: string;
    topic?: string;
    consistency?: string;
    note?: string;
  }>;
}

const SPEAKERS: Speaker[] = ['interviewer', 'candidate', 'unknown'];
const EVIDENCE_TYPES: DebriefEvidenceType[] = ['claim', 'fact', 'number', 'promise', 'evasion'];
const TOPICS: DebriefEvidence['topic'][] = [
  'workload',
  'pay',
  'schedule',
  'content',
  'environment',
  'requirement',
  'performance',
  'other',
];

/** 模型输出必须先过这里才准入库：编号连续、枚举合法、quote 非空 */
function sanitizeAiEvidence(raw: AiEvidenceShape | null): DebriefEvidence[] {
  const list = raw?.evidence;
  if (!Array.isArray(list)) return [];
  const out: DebriefEvidence[] = [];
  let seq = 1;
  for (const item of list) {
    const quote = (item?.quote ?? '').trim();
    if (!quote) continue;
    const speaker = SPEAKERS.includes(item.speaker as Speaker) ? (item.speaker as Speaker) : 'unknown';
    const type = EVIDENCE_TYPES.includes(item.type as DebriefEvidenceType) ? (item.type as DebriefEvidenceType) : 'fact';
    const topic = TOPICS.includes(item.topic as DebriefEvidence['topic'])
      ? (item.topic as DebriefEvidence['topic'])
      : classifyTopic(quote, speaker);
    out.push({
      // 编号一律本地重排 —— 模型的编号偶尔会跳号或重号，下游全靠它做引用
      id: `E${seq}`,
      quote: truncate(quote, 200),
      speaker,
      type,
      topic,
      consistency: item.consistency === 'conflicting' ? 'conflicting' : 'unique',
      note: (item.note ?? '').trim() || undefined,
    });
    seq += 1;
    if (out.length >= MAX_DEBRIEF_EVIDENCE) break;
  }
  return markConflicts(out);
}

export async function extractDebriefEvidence(input: {
  transcript: string;
  gateway: AiGateway;
}): Promise<DebriefEvidenceExtractOutput> {
  const ruleEvidence = extractEvidenceByRule(input.transcript);
  const run = await input.gateway.runJson<AiEvidenceShape>(
    'interview_debrief_evidence',
    [
      { role: 'system', content: DEBRIEF_EVIDENCE_SYSTEM_PROMPT },
      { role: 'user', content: input.transcript },
    ],
    { maxTokens: 4096 },
  );

  const aiEvidence = run.value ? sanitizeAiEvidence(run.value) : [];
  if (aiEvidence.length === 0) {
    // 模型不可用、返回非法 JSON、或一条都没抽出来 —— 一律用规则结果，并说明原因
    const warning = run.error
      ? `证据抽取走了本地规则（${run.error}）`
      : aiEvidence.length === 0 && run.value
        ? '证据抽取走了本地规则（模型未产出可用事实）'
        : undefined;
    return { evidence: ruleEvidence, engine: 'rule', trace: run.trace, warning };
  }

  // 两者取并集：规则的 quote 反而可能更"原样"（模型常顺手润色），
  // 而模型更擅长判断 topic/type 与说话人，所以以 quote 去重后优先保留模型版本
  const merged = mergeEvidence(ruleEvidence, aiEvidence);
  const engine: 'ai' | 'hybrid' = merged.usedRuleOnly ? 'hybrid' : 'ai';
  return { evidence: merged.list, engine, trace: run.trace };
}

function mergeEvidence(
  rule: DebriefEvidence[],
  ai: DebriefEvidence[],
): { list: DebriefEvidence[]; usedRuleOnly: boolean } {
  const normalize = (s: string) => normalizeText(s).replace(/[。，、；：！？,.;:!?\s]/g, '');
  const keys = new Set(ai.map((e) => normalize(e.quote).slice(0, 40)));
  let usedRuleOnly = false;
  const merged: DebriefEvidence[] = [...ai];
  for (const r of rule) {
    const key = normalize(r.quote).slice(0, 40);
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(r);
    usedRuleOnly = true;
  }
  // 重排编号，保证 E1..En 连续（下游的引用全靠它）
  const list = merged.slice(0, MAX_DEBRIEF_EVIDENCE).map((e, i) => ({ ...e, id: `E${i + 1}` }));
  return { list, usedRuleOnly };
}

// ---------------------------------------------------------------------------
// 数值提取（D3 / D10 的输入）
// ---------------------------------------------------------------------------

export interface QuotaHit {
  raw: string;
  count: number;
  unit: string;
  period: 'day' | 'week' | 'month' | 'term';
  evidenceId: string;
}

/**
 * 数量指标的模式。
 *
 * 中括号那段是为了吃下「每周 3 到 5 个」这种**区间写法** ——
 * 它比「每天 170 个」更常见，而只匹配单值的实现会整条漏掉。
 * 区间取较小的那个数作为估算基准：宁可低估强度，也不要把上限当常态。
 */
const QUOTA_PATTERNS: Array<{ re: RegExp; period: QuotaHit['period'] }> = [
  { re: /(每天|每日|一天|日均)[^\d]{0,6}(\d+)(?:\s*[-~到至]\s*(\d+))?\s*(个|条|单|件|篇|次|人|通|家)/, period: 'day' },
  { re: /(\d+)(?:\s*[-~到至]\s*(\d+))?\s*(个|条|单|件|篇|次|人|通|家)\s*\/\s*(天|日)/, period: 'day' },
  { re: /(每周|每星期)[^\d]{0,6}(\d+)(?:\s*[-~到至]\s*(\d+))?\s*(个|条|单|件|篇|次|人|通|家)/, period: 'week' },
  { re: /(每月|每个月|月均)[^\d]{0,6}(\d+)(?:\s*[-~到至]\s*(\d+))?\s*(个|条|单|件|篇|次|人|通|家)/, period: 'month' },
];

export function extractQuotas(evidence: DebriefEvidence[]): QuotaHit[] {
  const hits: QuotaHit[] = [];
  for (const e of evidence) {
    if (e.speaker === 'candidate' && e.topic === 'performance') continue;
    for (const { re, period } of QUOTA_PATTERNS) {
      const m = re.exec(e.quote);
      if (!m) continue;
      const numbers = m.slice(1).filter((g) => /^\d+$/.test(g ?? ''));
      const count = Number(numbers[0]);
      if (!Number.isFinite(count) || count <= 0) continue;
      const unit = m.slice(1).find((g) => g && !/^\d+$/.test(g) && !/天|日|周|月/.test(g)) ?? '个';
      hits.push({ raw: m[0], count, unit, period, evidenceId: e.id });
      break;
    }
  }
  return uniqueBy(hits, (h) => `${h.count}-${h.unit}-${h.period}`);
}

export interface PayHit {
  raw: string;
  monthly: number;
  min: number;
  max: number;
  evidenceId: string;
}

export function extractPay(evidence: DebriefEvidence[]): PayHit | null {
  for (const e of evidence) {
    if (!/(薪|工资|到手|综合|月|待遇|报酬)/.test(e.quote)) continue;

    // 「20 到 30K」这类带单位的区间：口语里比「20000 到 30000」常见得多
    const kRange = /(\d{1,3})\s*[-~到至]\s*(\d{1,3})\s*[Kk]/.exec(e.quote);
    if (kRange) {
      const a = Number(kRange[1]) * 1000;
      const b = Number(kRange[2]) * 1000;
      return { raw: kRange[0], min: Math.min(a, b), max: Math.max(a, b), monthly: Math.round((a + b) / 2), evidenceId: e.id };
    }

    const range = /(\d{4,6})\s*[-~到至]\s*(\d{4,6})/.exec(e.quote);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      return { raw: range[0], min: Math.min(a, b), max: Math.max(a, b), monthly: Math.round((a + b) / 2), evidenceId: e.id };
    }

    const single = /(底薪|月薪|工资|薪资|到手|综合)\s*(?:是|大概|约|为|：|:)?\s*(\d{3,6})/.exec(e.quote);
    if (single) {
      const v = Number(single[2]);
      return { raw: single[0], min: v, max: v, monthly: v, evidenceId: e.id };
    }
  }
  return null;
}

export interface HoursHit {
  dailyHours: number;
  restDaysPerMonth: number;
  rawDaily?: string;
  rawRest?: string;
  evidenceIds: string[];
}

export function extractHours(evidence: DebriefEvidence[]): HoursHit {
  let dailyHours = 8;
  let restDaysPerMonth = 8;
  const evidenceIds: string[] = [];
  let rawDaily: string | undefined;
  let rawRest: string | undefined;

  for (const e of evidence) {
    /**
     * 时间区间。必须处理「10 点到晚上 8 点」这种写法 ——
     * 直接按字面算会得到 22 小时，把整条工时推成不可能。
     */
    const span = /(\d{1,2})\s*(?:点|:00|：00)\s*(?:到|至|-|~)\s*(早上|上午|中午|下午|晚上|凌晨)?\s*(\d{1,2})\s*(?:点|:00)?/.exec(e.quote);
    if (span && !rawDaily) {
      const start = Number(span[1]);
      let end = Number(span[3]);
      const meridiem = span[2];
      if (meridiem && /下午|晚上/.test(meridiem) && end < 12) end += 12;
      const hours = end > start ? end - start : end + 24 - start;
      // 超过 16 小时的「工时」几乎一定是解析错了，宁可保留默认值
      if (hours > 0 && hours <= 16) {
        dailyHours = hours;
        rawDaily = span[0];
        evidenceIds.push(e.id);
      }
    }
    const rest = /月休\s*(\d{1,2})\s*天/.exec(e.quote);
    if (rest) {
      restDaysPerMonth = Number(rest[1]);
      rawRest = rest[0];
      evidenceIds.push(e.id);
    } else if (/双休/.test(e.quote)) {
      restDaysPerMonth = 8;
      rawRest = '双休';
      evidenceIds.push(e.id);
    } else if (/单休/.test(e.quote)) {
      restDaysPerMonth = 4;
      rawRest = '单休';
      evidenceIds.push(e.id);
    } else if (/大小周/.test(e.quote)) {
      restDaysPerMonth = 6;
      rawRest = '大小周';
      evidenceIds.push(e.id);
    }
  }
  return { dailyHours, restDaysPerMonth, rawDaily, rawRest, evidenceIds: uniqueBy(evidenceIds, (x) => x) };
}

// ---------------------------------------------------------------------------
// ② 维度分析
// ---------------------------------------------------------------------------

/** 先建骨架：所有维度都在，默认 insufficient_info。这样模型漏字段也不会让报告缺块 */
export function debriefDimensionSkeleton(): DebriefDimension[] {
  return DEBRIEF_DIMENSIONS.map((def) => ({
    id: def.id,
    kind: def.kind,
    key: def.key,
    name: def.name,
    goal: def.goal,
    status: 'insufficient_info' as DebriefDimStatus,
    basis: 'inferred' as DebriefBasis,
    verdictLine: '本次材料里没有支持这个维度的内容。',
    findings: [],
    extras: {},
    computation: null,
    scores: {},
    unknowns: [],
    questions: [],
    evidenceIds: [],
  }));
}

function finding(text: string, basis: DebriefBasis, ids: string[]): DebriefFinding {
  return { text, basis, evidenceIds: uniqueBy(ids, (x) => x) };
}

function withIds(dim: DebriefDimension): DebriefDimension {
  const ids = uniqueBy(
    [...dim.findings.flatMap((f) => f.evidenceIds), ...dim.evidenceIds],
    (x) => x,
  );
  return { ...dim, evidenceIds: ids };
}

interface DimensionContext {
  evidence: DebriefEvidence[];
  profile: CandidateProfile | null;
  job: JobRequirement | null;
  candidateText: string;
  interviewerText: string;
}

const QUESTION_CATEGORY_BY_TOPIC: Record<DebriefEvidence['topic'], DebriefQuestionCategory> = {
  workload: 'workload_kpi',
  pay: 'pay_benefit',
  schedule: 'time_shift',
  content: 'environment_content',
  environment: 'org_position',
  requirement: 'org_position',
  performance: 'self_improve',
  other: 'org_position',
};

function question(text: string, priority: TriLevel, category: DebriefQuestionCategory, targets?: string): DebriefQuestion {
  return { text, priority, category, targets };
}

// ---- D1 实态还原 ----

const FLOW_ACTIONS: Array<{ re: RegExp; label: string }> = [
  { re: /(打卡|到岗|上班|晨会)/, label: '到岗' },
  { re: /(查看|领取|接收|接单|分配)/, label: '领取任务' },
  { re: /(沟通|对接|联系|沟通)/, label: '沟通对接' },
  { re: /(执行|操作|处理|制作|开发|设计|撰写|跟进)/, label: '执行' },
  { re: /(自测|检查|质检|审核|评审)/, label: '检查' },
  { re: /(提交|上报|交付|发布|上线)/, label: '交付' },
  { re: /(修改|返工|调整|迭代)/, label: '修改' },
  { re: /(记录|登记|填报|复盘|总结)/, label: '记录' },
  { re: /(汇报|同步|例会)/, label: '汇报' },
];

function analyzeD1(ctx: DimensionContext, dim: DebriefDimension): DebriefDimension {
  const content = ctx.evidence.filter((e) => e.topic === 'content' && e.speaker !== 'candidate');
  if (content.length === 0) {
    return {
      ...dim,
      unknowns: ['对方没有具体描述日常工作内容'],
      questions: [question('这个岗位每天具体在做什么？能按上午、下午各说一遍吗？', 'high', 'environment_content', 'D1')],
    };
  }
  const flowLabels: string[] = [];
  for (const item of FLOW_ACTIONS) {
    if (content.some((e) => item.re.test(e.quote)) && !flowLabels.includes(item.label)) flowLabels.push(item.label);
  }
  const flow = flowLabels.length >= 2 ? `上班 → ${flowLabels.join(' → ')} → 下班` : '';
  const ids = content.slice(0, 4).map((e) => e.id);
  return withIds({
    ...dim,
    status: content.length >= 3 ? 'ok' : 'partial',
    basis: 'stated',
    verdictLine: `对方用 ${content.length} 句话描述了这个角色的日常内容。`,
    findings: [
      finding(`对方明确说到的日常内容：${content.slice(0, 3).map((e) => truncate(e.quote, 40)).join('；')}`, 'stated', ids),
    ],
    extras: { realityFlow: flow, contentQuotes: content.slice(0, 6).map((e) => ({ id: e.id, quote: e.quote })) },
    unknowns: content.length < 3 ? ['日常工作流程的完整链路未被说明'] : [],
    questions: [question('一个典型工作日的上午和下午分别是怎么安排的？', 'high', 'environment_content', 'D1')],
  });
}

// ---- D2 要求拆解 ----

function analyzeD2(ctx: DimensionContext, dim: DebriefDimension): DebriefDimension {
  const text = ctx.interviewerText || ctx.evidence.map((e) => e.quote).join('\n');
  const results: Array<{ key: string; result: '满足' | '不满足' | '未知' }> = [];
  const ids: string[] = [];

  for (const item of HARD_REQUIREMENT_CHECKLIST) {
    const hit = ctx.evidence.find((e) => itemProbe(item.key).test(e.quote));
    if (hit) {
      results.push({ key: item.key, result: '满足' });
      ids.push(hit.id);
    } else {
      results.push({ key: item.key, result: '未知' });
    }
  }

  const implicit: Array<{ key: string; intensity: number; reason: string }> = [];
  for (const item of IMPLICIT_REQUIREMENT_CHECKLIST) {
    const hits = ctx.evidence.filter((e) => itemProbe(item.key).test(e.quote));
    const intensity = hits.length === 0 ? 1 : hits.length >= 3 ? 5 : hits.length === 2 ? 4 : 3;
    implicit.push({ key: item.key, intensity, reason: hits.length === 0 ? '材料里没有提到' : `命中 ${hits.length} 处相关表述` });
    for (const h of hits) ids.push(h.id);
  }

  const known = results.filter((r) => r.result === '满足').length;
  const avgIntensity = Math.round(implicit.reduce((n, i) => n + i.intensity, 0) / Math.max(1, implicit.length));
  void text;

  return withIds({
    ...dim,
    status: known === 0 ? 'insufficient_info' : known >= 5 ? 'ok' : 'partial',
    basis: 'stated',
    verdictLine:
      known === 0
        ? '对方没有明确说明任何一项硬性安排（工时、休息、指标、考核）。'
        : `对方明确提到了 ${known} 项硬性安排，隐性要求总体强度为 ${avgIntensity}/5。`,
    findings: [
      finding(
        `明确提到的硬性安排共 ${known} 项，其中最影响判断的是：${results
          .filter((r) => r.result === '满足')
          .slice(0, 4)
          .map((r) => HARD_REQUIREMENT_CHECKLIST.find((c) => c.key === r.key)?.item ?? r.key)
          .join('、')}`,
        'stated',
        ids.slice(0, 6),
      ),
    ].filter((f) => f.evidenceIds.length > 0),
    extras: { checklistResults: results, implicitRequirements: implicit },
    scores: { implicit_requirement_intensity: avgIntensity },
    unknowns: results.filter((r) => r.result === '未知').map((r) => `${HARD_REQUIREMENT_CHECKLIST.find((c) => c.key === r.key)?.item ?? r.key}：未提及`),
    questions: [
      question('每日任务量是硬性指标还是参考数量？完不成会有什么后果？', 'high', 'workload_kpi', 'D2'),
      question('试用期的考核标准是什么？转正的判定由谁做？', 'medium', 'org_position', 'D2'),
    ],
  });
}

function itemProbe(key: string): RegExp {
  const map: Record<string, RegExp> = {
    daily_hours: /(小时|几点|工时|朝九|作息)/,
    rest_days: /(月休|单休|双休|大小周|休息日)/,
    fixed_shift: /(排班|轮班|班次|固定班|倒班)/,
    holiday_work: /(节假日|法定假|过节|值班)/,
    daily_quota: /(\d+\s*(个|条|单|件|篇)|任务量|工作量|指标)/,
    revenue_kpi: /(业绩|销售额|回款|转化|成单|目标)/,
    per_item_duration: /(响应时间|多久之内|时长要求|分钟内)/,
    success_rate: /(成功率|通过率|转化率|接通率|完成率)/,
    qa_audit: /(质检|抽检|检查|审核)/,
    kpi_aggregate: /(KPI|指标|考核)/i,
    penalty: /(扣|罚|处罚|警告|淘汰|追责)/,
    overtime: /(加班|值班|延点)/,
    training: /(培训|带教|上手|试用期)/,
    tools: /(系统|软件|平台|工具|后台|表格)/,
    continuous_output: /(不停|连续|一直在|随时|及时回复)/,
    rejection: /(拒绝|驳回|打回|不同意|被拒)/,
    negative_emotion: /(投诉|情绪|指责|骂|不满)/,
    persuasion: /(说服|谈判|促成|影响对方)/,
    fast_reaction: /(临场|即时|马上|快速|应变)/,
    sustained_attention: /(长时间|专注|一直盯|连续)/,
    complex_memory: /(流程|规范|话术|记)/,
    multitasking: /(同时|多任务|并行|几个系统)/,
    monitoring_tolerance: /(监控|质检|抽查|看板|日报)/,
    dual_pressure: /(既要|同时要求|又快又好)/,
  };
  return map[key] ?? /(?!)/;
}

// ---- D3 工作量测算 ----

function analyzeD3(ctx: DimensionContext, dim: DebriefDimension): DebriefDimension {
  const quotas = extractQuotas(ctx.evidence);
  if (quotas.length === 0) {
    return {
      ...dim,
      unknowns: ['没有出现可换算的数量指标（每日/每周任务个数）'],
      questions: [question('平均每项任务处理时长大概是多少？', 'high', 'workload_kpi', 'D3')],
    };
  }
  const daily = quotas.find((q) => q.period === 'day') ?? quotas[0];
  const perItemSeconds = 120; // 明确标为假设值，不许悄悄当成事实
  const pureMinutes = Math.round((daily.count * perItemSeconds) / 60);
  const remaining = WORKDAY_MINUTES - pureMinutes;
  const feasibility = remaining <= 0 ? '不可能完成' : remaining >= 240 ? '轻松完成' : remaining >= 120 ? '紧张但可行' : '余量很小';

  const table = workloadTimeTable(daily.count);
  const computation: DebriefComputation = {
    formula: '纯处理时间 = 每日指标数量 × 单项平均处理时长',
    inputs: {
      daily_quota: daily.count,
      quota_unit: daily.unit,
      per_item_seconds: perItemSeconds,
      per_item_note: '假设值：材料里没有给出单件耗时，按 2 分钟估；实际以提问澄清为准',
      available_minutes: WORKDAY_MINUTES,
    },
    result: { pure_minutes: pureMinutes, remaining_minutes: remaining, feasibility },
    verdict: `按每天 ${daily.count} ${daily.unit}、单件 2 分钟估，纯处理需要约 ${pureMinutes} 分钟（${daily.count} × 2 分钟），8 小时工作日剩余约 ${remaining} 分钟。这个测算还没算上查看任务、系统切换、等待与记录的时间成本。`,
  };

  return withIds({
    ...dim,
    status: 'ok',
    basis: 'stated',
    verdictLine: `对方给出的数量指标换算后，纯处理时间约 ${pureMinutes} 分钟／天，可行性判断：${feasibility}。`,
    findings: [
      finding(`材料中出现 ${quotas.length} 处数量指标，其中「${daily.raw}」可用于换算。`, 'stated', [daily.evidenceId]),
      finding('这个测算只用了数量与假设的单件耗时，未包含记录、切换、等待等额外时间成本。', 'inferred', [daily.evidenceId]),
    ],
    extras: { workloadTable: table, quotas },
    computation,
    scores: { quantity_pressure: daily.count >= 120 ? 5 : daily.count >= 60 ? 4 : daily.count >= 20 ? 3 : 2, time_pressure: remaining <= 0 ? 5 : remaining <= 110 ? 4 : 3 },
    unknowns: ['单项平均处理时长未给出（当前用的是假设值）', '口径未说明是「做了多少个」还是「达成多少个」'],
    questions: [
      question(`「${daily.raw}」是名义上完成 ${daily.count} ${daily.unit}，还是有效达成 ${daily.count} ${daily.unit}？两者区别是什么？`, 'high', 'workload_kpi', 'D3'),
      question('平均每项任务的处理时长是多少？有没有时限要求？', 'high', 'workload_kpi', 'D3'),
    ],
  });
}

// ---- D4 压力画像 ----

function analyzeD4(ctx: DimensionContext, dim: DebriefDimension): DebriefDimension {
  const levels: Array<{ key: string; level: DebriefPressureLevel; evidenceIds: string[] }> = [];
  const topicTouched = new Set(ctx.evidence.map((e) => e.topic));

  for (const stress of STRESS_TYPES) {
    const hits = ctx.evidence.filter((e) => stress.patterns.some((re) => re.test(e.quote)));
    const touched =
      hits.length > 0 ||
      (stress.key === 'quantity' && topicTouched.has('workload')) ||
      (stress.key === 'schedule' && topicTouched.has('schedule'));

    let level: DebriefPressureLevel;
    if (hits.length >= 3) level = 'high';
    else if (hits.length >= 1) level = 'medium';
    else if (touched) level = 'low';
    else level = 'unknown';

    levels.push({ key: stress.key, level, evidenceIds: uniqueBy(hits.map((h) => h.id), (x) => x) });
  }

  const scored = levels.filter((l) => l.level !== 'unknown');
  const high = levels.filter((l) => l.level === 'high');
  const scores: Record<string, DebriefPressureLevel> = {};
  for (const l of levels) scores[l.key] = l.level;

  return withIds({
    ...dim,
    status: scored.length === 0 ? 'insufficient_info' : high.length > 0 ? 'ok' : 'partial',
    basis: 'inferred',
    verdictLine:
      scored.length === 0
        ? '材料里没有任何可用于判断压力的内容。'
        : high.length > 0
          ? `9 类压力中有 ${high.length} 类达到「高」：${high.map((h) => STRESS_TYPES.find((s) => s.key === h.key)?.label ?? h.key).join('、')}。`
          : `9 类压力中没有出现「高」等级，${scored.length} 类有信息可判。`,
    findings: high.length
      ? [
          finding(
            `达到「高」的压力类型：${high.map((h) => STRESS_TYPES.find((s) => s.key === h.key)?.label ?? h.key).join('、')}。`,
            'inferred',
            uniqueBy(high.flatMap((h) => h.evidenceIds), (x) => x).slice(0, 6),
          ),
        ]
      : [],
    extras: { stressLevels: levels },
    scores,
    unknowns: levels.filter((l) => l.level === 'unknown').map((l) => `${STRESS_TYPES.find((s) => s.key === l.key)?.label ?? l.key}：材料里没有依据`),
    questions: [
      question('这个岗位最近三个月的离职情况是怎样的？', 'medium', 'org_position', 'D4'),
      question('业务高峰期一般集中在什么时候？那时候的工作节奏是怎样的？', 'medium', 'workload_kpi', 'D4'),
    ],
  });
}

// ---- D5 名义 vs 实际口径 ----

function analyzeD5(ctx: DimensionContext, dim: DebriefDimension): DebriefDimension {
  const quotas = extractQuotas(ctx.evidence);
  if (quotas.length === 0) {
    return { ...dim, unknowns: ['材料里没有出现需要区分口径的达标类指标'] };
  }
  const pairs = quotas.map((q) => {
    const effective = /(电话|客户|联|沟通)/.test(q.raw)
      ? `有效沟通 ${q.count} 个`
      : /(稿|方案)/.test(q.raw)
        ? `通过评审的 ${q.count} 份`
        : /(功能|开发|需求)/.test(q.raw)
          ? `上线稳定的 ${q.count} 个`
          : `真正达成结果的 ${q.count} ${q.unit}`;
    const hidden = /(电话|客户|联)/.test(q.raw)
      ? '大量未接通、关机、拒接'
      : /(稿|方案)/.test(q.raw)
        ? '需要大幅修改重做'
        : /(功能|开发)/.test(q.raw)
          ? '联调与 debug 修复'
          : '未被记录的前置成本';
    return { nominal: q.raw, effective, hiddenCost: hidden, evidenceIds: [q.evidenceId] };
  });

  return withIds({
    ...dim,
    status: 'partial',
    basis: 'inferred',
    verdictLine: `材料里出现 ${pairs.length} 处达标类指标，但没有一处说明考核的是名义口径还是实际口径。`,
    findings: pairs.map((p) =>
      finding(`「${p.nominal}」在不同口径下强度差别很大：名义口径是「${p.nominal}」，实际口径是「${p.effective}」，被掩盖的成本是「${p.hiddenCost}」。`, 'inferred', p.evidenceIds),
    ),
    extras: { nominalVsEffective: pairs, pairs },
    unknowns: ['所有指标的考核口径都未说明'],
    questions: [
      question('这些指标考核的是完成数量还是达成结果？两者的统计方式有什么不同？', 'high', 'workload_kpi', 'D5'),
    ],
  });
}

// ---- D6 工作类型 ----

function analyzeD6(ctx: DimensionContext, dim: DebriefDimension): DebriefDimension {
  const scored = WORK_TYPE_TAXONOMY.map((t) => ({
    key: t.key,
    label: t.label,
    reason: t.trait,
    hits: ctx.evidence.filter((e) => t.patterns.some((re) => re.test(e.quote))).length,
  })).filter((t) => t.hits > 0);
  scored.sort((a, b) => b.hits - a.hits);
  const top = scored.slice(0, 3);

  if (top.length === 0) {
    return { ...dim, unknowns: ['材料里没有出现可用于判定工作类型的内容'] };
  }
  return {
    ...dim,
    status: 'partial',
    basis: 'inferred',
    verdictLine: `从实际描述看，这个角色最接近：${top.map((t) => t.label).join('、')}。`,
    findings: top.map((t) =>
      finding(`归入「${t.label}」：${t.reason}（材料里有 ${t.hits} 处相关表述）。`, 'inferred', ctx.evidence.filter((e) => WORK_TYPE_TAXONOMY.find((x) => x.key === t.key)?.patterns.some((re) => re.test(e.quote))).slice(0, 2).map((e) => e.id)),
    ),
    extras: { typeTags: top.map((t) => ({ key: t.key, label: t.label, reason: t.reason })), taxonomyScores: scored },
    unknowns: ['工作类型是按描述推断的，岗位名称可能与实际不符'],
  };
}

// ---- D7 个体适配 ----

function analyzeD7(ctx: DimensionContext, dim: DebriefDimension, all: DebriefDimension[] = []): DebriefDimension {
  if (!ctx.profile) {
    return {
      ...dim,
      unknowns: ['尚未建立能力档案，无法做适配度对比'],
      questions: [question('可以先用简历建立一个能力档案，才能做逐项适配分析。', 'high', 'self_improve', 'D7')],
    };
  }

  // 收窄一次，后面在闭包里用 —— TS 的类型收窄不会穿过回调边界
  const profile = ctx.profile;
  const preferenceText = normalizeText([profile.summary, ...profile.selfDescriptions, profile.basics.targetRoles.join(' ')].join('\n'));
  const profileSkills = new Set(profile.skills.map((s) => s.name));
  // D4 已经算出每类压力的等级，D7 直接复用 —— 两处各算一遍迟早会不一致
  const d4Levels = (all.find((d) => d.id === 'D4')?.extras?.stressLevels as Array<{ key: string; level: DebriefPressureLevel }> | undefined) ?? [];
  const stressLevels = new Map<string, DebriefPressureLevel>(d4Levels.map((s) => [s.key, s.level]));
  const boundaryHits: string[] = [];

  const fitScores = FIT_DIMENSIONS.map((fd) => {
    const touched = fd.patterns.length > 0 && ctx.evidence.some((e) => fd.patterns.some((re) => re.test(e.quote)));
    if (!touched && fd.key !== 'short_term_transition') {
      return { key: fd.key, label: fd.label, score: null, reason: '这次面试没有谈到这一点', touchedBoundary: false };
    }

    let score = 3;
    const reasons: string[] = ['信息中性，按 3 分起步'];

    // 技能重合：档案里提到、材料里也出现的能力名
    if (fd.key === 'skill') {
      const mentioned = new Set(ctx.evidence.map((e) => e.quote).filter((q) => findSkillsInText(q).length > 0).join(' '));
      const overlap = profile.skills.filter((s) => s.name && (mentioned.has(s.name) || textMentionsSkill(s.name, [...mentioned].join(' '))));
      if (overlap.length > 0) {
        score += 1;
        reasons.push(`能力档案里有 ${overlap.length} 项能力与材料提到的一致（${overlap.slice(0, 3).map((s) => s.name).join('、')}）`);
      } else if (profileSkills.size > 0) {
        reasons.push('能力档案里的技能在材料中未被提及');
      }
    }

    // 压力等级反推：该维度对应的压力越高，适配分越低
    const stressKeyByFit: Record<string, string> = {
      communication: 'communication',
      repetition: 'attention',
      attention: 'attention',
      emotion_pressure: 'emotion',
      kpi: 'performance',
      schedule: 'schedule',
      physical: 'physical',
    };
    const stressKey = stressKeyByFit[fd.key];
    if (stressKey) {
      const level = stressLevels.get(stressKey) ?? 'unknown';
      if (level === 'high') {
        score -= 1;
        reasons.push(`对应的压力类型判定为「高」`);
      }
    }

    // 心理边界：档案里的偏好文本命中该维度的边界词 → 直接压到低分
    if (fd.boundaryPatterns && anyMatch(fd.boundaryPatterns, preferenceText)) {
      score -= 2;
      boundaryHits.push(fd.label);
      reasons.push('与你在档案里写下的偏好 / 边界相冲突');
    }

    return {
      key: fd.key,
      label: fd.label,
      score: clamp(score, 1, 5),
      reason: reasons.join('；'),
      touchedBoundary: boundaryHits.includes(fd.label),
    };
  });

  const judged = fitScores.filter((f) => f.score !== null);
  const items: DebriefFitItem[] = fitScores.map((f) => ({
    key: f.key,
    label: f.label,
    score: f.score,
    reason: f.reason,
    touchedBoundary: f.touchedBoundary,
  }));
  const scores: Record<string, number | null> = {};
  for (const f of fitScores) scores[f.key] = f.score;

  return {
    ...dim,
    status: judged.length === 0 ? 'insufficient_info' : judged.length >= 5 ? 'ok' : 'partial',
    basis: 'inferred',
    verdictLine:
      judged.length === 0
        ? '这次面试没有谈到足以判断适配度的内容。'
        : `10 个适配维度中有 ${judged.length} 项可判，其中最低的是「${judged.slice().sort((a, b) => (a.score ?? 9) - (b.score ?? 9))[0]?.label}」（${judged.slice().sort((a, b) => (a.score ?? 9) - (b.score ?? 9))[0]?.score}/5）。`,
    findings: items
      .filter((i) => i.score !== null)
      .slice(0, 5)
      .map((i) => finding(`${i.label}：${i.score}/5 —— ${i.reason}`, 'inferred', ctx.evidence.slice(0, 1).map((e) => e.id))),
    extras: { fitScores: items },
    scores,
    unknowns: items.filter((i) => i.score === null).map((i) => `${i.label}：这次面试没有谈到`),
    questions: boundaryHits.length
      ? [question('这个岗位在这方面的实际投入，和你现在能接受的范围差多少？', 'high', 'self_improve', 'D7')]
      : [],
  };
}

// ---- D8 持续性推演 ----

function analyzeD8(ctx: DimensionContext, dim: DebriefDimension): DebriefDimension {
  if (!ctx.profile) {
    return { ...dim, unknowns: ['尚未建立能力档案，无法做持续性推演'] };
  }
  const highStress = STRESS_TYPES.filter((s) =>
    ctx.evidence.filter((e) => s.patterns.some((re) => re.test(e.quote))).length >= 3,
  );
  const hasContent = ctx.evidence.some((e) => e.speaker !== 'candidate');

  const sustainability: Record<string, string[]> = {
    day1: ['第一天会经历完整的上手流程，是否能完成当天任务取决于带教安排。'],
    week1: ['新鲜感消退后，最先出现问题的是：' + (highStress.length > 0 ? highStress.map((s) => s.label).join('、') : '任务量是否与描述一致') + '。'],
    month1: ['决定能否长期留下的因素通常不是技能，而是上面那几类压力是否持续叠加。'],
  };

  const baseScore = highStress.length === 0 ? 4 : highStress.length === 1 ? 3 : 2;

  return withIds({
    ...dim,
    status: hasContent ? 'partial' : 'insufficient_info',
    basis: 'inferred',
    verdictLine: `按三个时间尺度看：第一天与第一周的障碍主要来自「${highStress.length > 0 ? highStress[0].label : '信息不足'}」，第一个月的关键变量是这些压力是否持续叠加。`,
    findings: [
      finding(sustainability.week1[0], 'inferred', ctx.evidence.slice(0, 2).map((e) => e.id)),
      finding('以上是机制层面的推演，不是对结果的预测。', 'inferred', ctx.evidence.slice(0, 1).map((e) => e.id)),
    ],
    extras: { sustainability, axes: SUSTAINABILITY_AXES },
    scores: { day1: clamp(baseScore + 1, 1, 5), week1: baseScore, month1: clamp(baseScore - 1, 1, 5) },
    unknowns: ['没有对方关于团队人员流动与上手周期的具体说明'],
    questions: [question('上手期一般多久？期间有没有明确的产出要求？', 'medium', 'org_position', 'D8')],
  });
}

// ---- D9 风险信号 ----

function analyzeD9(ctx: DimensionContext, dim: DebriefDimension): DebriefDimension {
  const signals: Array<{ key: string; label: string; quote: string; positive: string; negative: string; verify: string; evidenceIds: string[] }> = [];

  for (const signal of RISK_SIGNALS) {
    if (signal.key === 'inconsistency') {
      const conflicts = ctx.evidence.filter((e) => e.consistency === 'conflicting');
      if (conflicts.length > 0) {
        signals.push({
          key: signal.key,
          label: signal.label,
          quote: truncate(conflicts[0].quote, 60),
          positive: signal.positive,
          negative: signal.negative,
          verify: signal.verify,
          evidenceIds: conflicts.slice(0, 3).map((e) => e.id),
        });
      }
      continue;
    }
    const hit = ctx.evidence.find((e) => e.speaker !== 'candidate' && signal.patterns.some((re) => re.test(e.quote)));
    if (!hit) continue;
    signals.push({
      key: signal.key,
      label: signal.label,
      quote: truncate(hit.quote, 60),
      positive: signal.positive,
      negative: signal.negative,
      verify: signal.verify,
      evidenceIds: [hit.id],
    });
  }

  if (signals.length === 0) {
    return { ...dim, status: 'partial', verdictLine: '本次材料里没有命中风险信号库中的话术模式。', findings: [] };
  }

  return withIds({
    ...dim,
    status: 'ok',
    basis: 'stated',
    verdictLine: `命中 ${signals.length} 类风险信号。命中的是**表述方式**，不等于对方在说谎 —— 每条都给出了正面理解与验证方法。`,
    findings: signals.map((s) =>
      finding(`「${s.label}」：「${s.quote}」—— 正面理解：${s.positive}；反面理解：${s.negative}`, 'stated', s.evidenceIds),
    ),
    extras: { riskSignals: signals },
    unknowns: [],
    questions: signals.slice(0, 3).map((s) =>
      question(s.verify.replace(/^追问：/, '').replace(/^把.*$/, '把两份说法分别复述一遍，请对方解释差异来自哪里。'), 'high', QUESTION_CATEGORY_BY_TOPIC.other, 'D9'),
    ),
  });
}

// ---- D10 实际回报 ----

function analyzeD10(ctx: DimensionContext, dim: DebriefDimension): DebriefDimension {
  const pay = extractPay(ctx.evidence);
  if (!pay) {
    return {
      ...dim,
      unknowns: ['材料里没有出现具体薪酬数字'],
      questions: [question('这个岗位的薪资区间是多少？其中基本工资与绩效分别占多少？', 'high', 'pay_benefit', 'D10')],
    };
  }
  const hours = extractHours(ctx.evidence);
  const workDays = clamp(30 - hours.restDaysPerMonth, 18, 31);
  const monthlyHours = workDays * hours.dailyHours;
  const hourly = Math.round(pay.monthly / Math.max(1, monthlyHours));

  const scenario = (label: string, income: number, days: number, daily: number) => ({
    label,
    income,
    workDays: days,
    dailyHours: daily,
    hourly: Math.round(income / Math.max(1, days * daily)),
  });
  const rows = [
    scenario('A 理想', pay.max, clamp(workDays, 18, 31), Math.max(6, hours.dailyHours - 1)),
    scenario('B 正常', pay.monthly, workDays, hours.dailyHours),
    scenario('C 最差', pay.min, clamp(workDays + 2, 18, 31), hours.dailyHours + 2),
  ];

  const table: DebriefTable = {
    formula: '单位时间回报 = 实发月收入 ÷ (月工作天数 × 每日净工作时长)',
    rows: rows.map((r) => ({ scenario: r.label, monthlyIncome: r.income, workDays: r.workDays, dailyHours: r.dailyHours, hourly: r.hourly })),
    verdict: `按材料里的数字测算，单位时间回报约 ${Math.min(...rows.map((r) => r.hourly))}–${Math.max(...rows.map((r) => r.hourly))} 元/小时（月收入 ${pay.min}–${pay.max} 元 ÷ 月工时 ${monthlyHours} 小时上下）。三个情景的区别来自休息天数与加班是否另计。`,
  };

  return withIds({
    ...dim,
    status: 'partial',
    basis: 'stated',
    verdictLine: `按材料中的薪酬与工时估算，单位时间回报约 ${Math.min(...rows.map((r) => r.hourly))}–${Math.max(...rows.map((r) => r.hourly))} 元/小时。`,
    findings: [
      finding(`材料中出现的薪酬信息：「${pay.raw}」。`, 'stated', [pay.evidenceId]),
      finding(
        hours.rawRest
          ? `休息安排：「${hours.rawRest}」，据此估算月工作 ${workDays} 天、每日净工作 ${hours.dailyHours} 小时。`
          : `没有说明休息安排，暂按每月 ${hours.restDaysPerMonth} 天休息、每日 ${hours.dailyHours} 小时估算。`,
        hours.evidenceIds.length > 0 ? 'stated' : 'inferred',
        hours.evidenceIds.length > 0 ? hours.evidenceIds : [pay.evidenceId],
      ),
    ],
    extras: { compensationRows: rows, compensationInputs: COMPENSATION_INPUTS },
    computation: {
      formula: table.formula,
      inputs: { monthly_income: pay.monthly, work_days_per_month: workDays, daily_hours: hours.dailyHours },
      result: { hourly_min: Math.min(...rows.map((r) => r.hourly)), hourly_max: Math.max(...rows.map((r) => r.hourly)) },
      verdict: table.verdict,
    },
    unknowns: [
      '薪资区间的构成（基本工资 / 绩效比例）未说明',
      '加班是否另计、社保个人承担部分未说明',
    ],
    questions: [
      question('薪资区间的构成是什么？写入合同的基本工资是多少？', 'high', 'pay_benefit', 'D10'),
      question('是否需要加班？加班费怎么算？法定节假日怎么计算工资？', 'high', 'pay_benefit', 'D10'),
    ],
  });
}

// ---- D11 问题清单 ----

function analyzeD11(ctx: DimensionContext, dim: DebriefDimension, all: DebriefDimension[]): DebriefDimension {
  const collected = dedupeQuestions(all.flatMap((d) => d.questions));
  const fromUnknowns = all
    .filter((d) => d.status === 'insufficient_info')
    .flatMap((d) => d.unknowns.map((u) => question(`${u}——可以就此确认一下吗？`, 'medium', QUESTION_CATEGORY_BY_TOPIC.other, d.id)));
  const conflicts = ctx.evidence.filter((e) => e.consistency === 'conflicting');
  const fromConflicts = conflicts.length
    ? [question('关于同一个信息我听到过两种说法，能帮我确认一下哪个是实际的吗？', 'high', 'workload_kpi', 'D11')]
    : [];

  const merged = dedupeQuestions([...collected, ...fromConflicts, ...fromUnknowns]).slice(0, 15);

  return withIds({
    ...dim,
    status: merged.length === 0 ? 'insufficient_info' : 'ok',
    basis: 'inferred',
    verdictLine: merged.length === 0 ? '没有产生新的待确认问题。' : `共 ${merged.length} 个问题，按「工作量与 KPI / 薪酬与福利 / 时间与排班 / 环境与内容 / 组织与岗位」分组。`,
    findings: [],
    extras: { questionCount: merged.length },
    questions: merged,
  });
}

function dedupeQuestions(list: DebriefQuestion[]): DebriefQuestion[] {
  const seen = new Set<string>();
  const out: DebriefQuestion[] = [];
  for (const q of list) {
    const key = normalizeText(q.text).slice(0, 30);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

// ---- D12 情景与决策 ----

function analyzeD12(
  ctx: DimensionContext,
  dim: DebriefDimension,
  all: DebriefDimension[],
): DebriefDimension {
  const byId = new Map(all.map((d) => [d.id, d]));
  const d3 = byId.get('D3');
  const d4 = byId.get('D4');
  const d5 = byId.get('D5');
  const d9 = byId.get('D9');
  const d10 = byId.get('D10');

  const feasibility = String(d3?.computation?.result?.feasibility ?? '');
  const stressLevels = (d4?.extras?.stressLevels as Array<{ key: string; level: DebriefPressureLevel }> | undefined) ?? [];
  const highStress = stressLevels.filter((s) => s.level === 'high');
  const riskCount = ((d9?.extras?.riskSignals as unknown[] | undefined) ?? []).length;
  const conflicting = ctx.evidence.filter((e) => e.consistency === 'conflicting').length;

  const conditions = {
    consider: [] as string[],
    caution: [] as string[],
    mismatch: [] as string[],
  };
  if (d3?.status === 'ok' && !feasibility.includes('不可能')) conditions.consider.push('工作量测算在 8 小时内可行');
  if (highStress.length === 0 && (d4?.status ?? 'insufficient_info') !== 'insufficient_info') conditions.consider.push('没有出现「高」等级的压力类型');
  if ((d10?.status ?? '') === 'partial') conditions.consider.push('薪酬与工时信息给出了区间与算式，可以自己复算');
  if (riskCount > 0) conditions.caution.push(`命中 ${riskCount} 类风险话术，需要按报告里的问题逐条确认`);
  if (conflicting > 0) conditions.caution.push(`${conflicting} 处说法互相矛盾，需要先确认哪个是实际口径`);
  if ((d5?.status ?? '') === 'partial') conditions.caution.push('数量指标的口径未说明（名义 vs 实际）');
  if (highStress.length >= 2) conditions.mismatch.push(`${highStress.length} 类压力同时达到「高」`);
  if (feasibility.includes('不可能')) conditions.mismatch.push('工作量在正常工作时间内物理不可行');
  if (all.filter((d) => d.kind === 'opportunity' && d.status === 'insufficient_info').length >= 6) {
    conditions.caution.push('多数维度证据不足，当前材料还不足以判断');
  }

  const decisionTable: DebriefDecisionTier[] = DECISION_TIERS.map((tier) => ({
    key: tier.key,
    label: tier.label,
    conditions: conditions[tier.key],
  }));

  const scenarios: DebriefScenario[] = SCENARIO_TYPES.map((type) => ({
    key: type.key,
    label: type.label,
    points: type.fields.map((field, index) => ({
      field,
      text: scenarioText(type.key, index, { feasibility, highStress: highStress.length, riskCount, hasPay: Boolean(d10 && d10.status !== 'insufficient_info') }),
    })),
  }));

  const scored = all.filter((d) => d.kind === 'opportunity');
  const insufficient = scored.filter((d) => d.status === 'insufficient_info').length;
  let tier: DebriefSynthesis['tier'];
  if (insufficient >= 6) tier = 'insufficient';
  else if (conditions.mismatch.length > 0) tier = 'mismatch';
  else if (conditions.caution.length > 0) tier = 'caution';
  else tier = 'consider';

  return {
    ...dim,
    status: 'ok',
    basis: 'inferred',
    verdictLine: `按现有材料归入「${tier === 'consider' ? '可以考虑' : tier === 'caution' ? '需要谨慎' : tier === 'mismatch' ? '明显不匹配' : '当前信息不足以归类'}」。`,
    findings: [],
    extras: { conditions, tier, scenarios, decisionTable, highStressCount: highStress.length, riskCount },
  };
}

function scenarioText(key: 'A' | 'B' | 'C', index: number, info: { feasibility: string; highStress: number; riskCount: number; hasPay: boolean }): string {
  if (key === 'A') {
    const texts = [
      '对方关于工作量与待遇的说法都属实，指标口径与实际执行一致',
      info.feasibility.includes('不可能') ? '即使描述可信，按给出的数量算工作时间也不够用' : '按目前的数量与节奏，这是可以长期维持的工作强度',
      '适合能接受这类节奏、且不依赖频繁变化的人',
    ];
    return texts[index];
  }
  if (key === 'B') {
    const texts = [
      info.riskCount > 0 ? `已命中 ${info.riskCount} 类风险话术，实际要求大概率高于字面描述` : '若实际要求高于字面描述，最先变化的是任务量与加班',
      '最坏情况是任务量与收入都偏离预期，且「成长」这类说法无法兑现',
      '最有效的应对是在入职前把指标口径、加班计算、试用期考核落到书面',
    ];
    return texts[index];
  }
  const texts = [
    info.hasPay ? '最需要盯的两个数字：单位时间回报，以及月工作天数' : '最需要盯的是任务量的实际口径与考核方式',
    info.highStress > 0 ? `已出现 ${info.highStress} 类高压力信号，如果面试后仍然无法得到明确答复，就应该重新评估` : '如果连续两次追问都得不到具体回答，说明信息不透明本身就是信号',
  ];
  return texts[index];
}

// ---- P1–P6 表现侧 ----

/** 表现侧的一个分析单元。必须带上原始证据编号 —— 表现侧结论同样要能回查到原话 */
interface PerfTurn {
  text: string;
  evidenceId: string;
}

interface PerformanceContext {
  candidateTurns: PerfTurn[];
  job: JobRequirement | null;
}

function performanceCtx(ctx: DimensionContext, job: JobRequirement | null): PerformanceContext {
  return {
    candidateTurns: ctx.evidence
      .filter((e) => e.speaker === 'candidate')
      .map((e) => ({ text: e.quote, evidenceId: e.id })),
    job,
  };
}

function perfIds(turns: PerfTurn[], limit = 3): string[] {
  return uniqueBy(turns.slice(0, limit).map((t) => t.evidenceId), (x) => x);
}

function blankPerformance(dim: DebriefDimension, reason: string): DebriefDimension {
  return {
    ...dim,
    status: 'insufficient_info',
    verdictLine: reason,
    unknowns: [reason],
  };
}

function analyzeP1(pc: PerformanceContext, dim: DebriefDimension): DebriefDimension {
  const turns = pc.candidateTurns;
  if (turns.length === 0) return blankPerformance(dim, '转写里没有区分出「我」的回答段落，无法判断结构。');
  const structured = turns.filter((t) => anyMatch(STRUCTURE_MARKERS, t.text));
  const ratio = pct(structured.length, turns.length);
  const score = ratio >= 0.6 ? 5 : ratio >= 0.4 ? 4 : ratio >= 0.2 ? 3 : ratio > 0 ? 2 : 1;
  return withIds({
    ...dim,
    status: 'ok',
    basis: 'inferred',
    verdictLine: `${turns.length} 段回答里有 ${structured.length} 段出现了显式结构标记（首先 / 其次 / 结论是……），占比 ${Math.round(ratio * 100)}%。`,
    findings: [
      finding(
        `有结构标记的回答占 ${Math.round(ratio * 100)}%；结构清晰指的是「先给结论，再说依据」，而不是说得长。`,
        'inferred',
        perfIds(structured.length > 0 ? structured : turns),
      ),
    ],
    extras: { structuredCount: structured.length, totalCount: turns.length, samples: structured.slice(0, 3).map((t) => truncate(t.text, 60)) },
    scores: { structure: score },
  });
}

function analyzeP2(pc: PerformanceContext, dim: DebriefDimension): DebriefDimension {
  const turns = pc.candidateTurns;
  if (turns.length === 0) return blankPerformance(dim, '转写里没有区分出「我」的回答段落，无法判断事实密度。');
  const facts = turns.filter((t) => anyMatch(FACT_PATTERNS, t.text));
  const vague = turns.filter((t) => anyMatch(VAGUE_PATTERNS, t.text) && !anyMatch(FACT_PATTERNS, t.text));
  const ratio = pct(facts.length, turns.length);
  const score = clamp(Math.round(ratio * 5) || 1, 1, 5);
  return withIds({
    ...dim,
    status: 'ok',
    basis: 'inferred',
    verdictLine: `${turns.length} 段回答里，${facts.length} 段含可核对的事实（数字 / 时间 / 动作 / 交付物），${vague.length} 段只有评价性表述。`,
    findings: [
      finding(
        `事实密度 ${Math.round(ratio * 100)}%。事实是指别人能拿去核对的东西，而不是听起来有把握的表述。`,
        'inferred',
        perfIds(facts.length > 0 ? facts : turns),
      ),
      ...(vague.length > 0
        ? [
            finding(
              `有 ${vague.length} 段回答只给出评价性表述（例如「挺熟悉的」），没有跟上具体做过什么。`,
              'inferred',
              perfIds(vague),
            ),
          ]
        : []),
    ],
    extras: { factCount: facts.length, vagueCount: vague.length, totalCount: turns.length, ratio: Number(ratio.toFixed(2)) },
    scores: { specificity: score },
    unknowns: vague.length > 0 ? ['有回答缺少可核对的事实'] : [],
  });
}

function analyzeP3(pc: PerformanceContext, dim: DebriefDimension): DebriefDimension {
  const job = pc.job;
  const turns = pc.candidateTurns;
  if (!job || job.items.length === 0) {
    return blankPerformance(dim, '还没有这个岗位的要求列表，无法判断回答与岗位的对齐度。');
  }
  if (turns.length === 0) return blankPerformance(dim, '转写里没有区分出「我」的回答段落。');
  const answerText = turns.map((t) => t.text).join('\n');
  const keywords = uniqueBy(job.items.flatMap((i) => i.keywords), (k) => k);
  const hit = keywords.filter((k) => textMentionsSkill(k, answerText));
  const missing = keywords.filter((k) => !hit.includes(k));
  const ratio = pct(hit.length, Math.max(1, keywords.length));
  const score = keywords.length === 0 ? null : clamp(Math.round(ratio * 5) || 1, 1, 5);
  return withIds({
    ...dim,
    status: 'ok',
    basis: 'inferred',
    verdictLine: `岗位涉及 ${keywords.length} 个能力关键词，回答里明确回应了 ${hit.length} 个。`,
    findings: [
      finding(
        missing.length > 0
          ? `岗位要求里出现、但回答中没有回应的关键词：${missing.slice(0, 6).join('、')}。没提到不等于不会，只说明这次没说。`
          : '岗位要求里出现的关键词，回答里基本都覆盖到了。',
        'inferred',
        perfIds(turns),
      ),
    ],
    extras: { jobKeywords: keywords, hitKeywords: hit, missingKeywords: missing },
    scores: score === null ? {} : { job_alignment: score },
  });
}

function analyzeP4(pc: PerformanceContext, dim: DebriefDimension): DebriefDimension {
  const turns = pc.candidateTurns;
  if (turns.length === 0) return blankPerformance(dim, '转写里没有区分出「我」的回答段落。');
  const depth = turns.filter((t) => anyMatch(DEPTH_PATTERNS, t.text));
  const ratio = pct(depth.length, turns.length);
  const score = clamp(Math.round(ratio * 5) || 1, 1, 5);
  return withIds({
    ...dim,
    status: 'ok',
    basis: 'inferred',
    verdictLine: `${turns.length} 段回答里，${depth.length} 段讲到了「为什么这么做」或「还考虑过别的做法」。`,
    findings: [
      finding(
        `讲清取舍的回答占 ${Math.round(ratio * 100)}%。深度体现在「为什么选这个方案」和「放弃了什么」，不在于用了多少工具。`,
        'inferred',
        perfIds(depth.length > 0 ? depth : turns),
      ),
    ],
    extras: { depthCount: depth.length, totalCount: turns.length },
    scores: { depth: score },
  });
}

function analyzeP5(pc: PerformanceContext, dim: DebriefDimension): DebriefDimension {
  const turns = pc.candidateTurns;
  if (turns.length === 0) return blankPerformance(dim, '转写里没有区分出「我」的回答段落。');
  const boundary = turns.filter((t) => anyMatch(BOUNDARY_PATTERNS, t.text));
  const evasion = turns.filter((t) => anyMatch(EVASION_PATTERNS, t.text));
  const score = clamp(3 + (boundary.length > 0 ? 1 : 0) - (evasion.length > 0 ? 2 : 0), 1, 5);
  return withIds({
    ...dim,
    status: 'ok',
    basis: 'inferred',
    verdictLine: `${boundary.length} 段回答里明确划出了认知边界，${evasion.length} 段用了含糊表述绕开。`,
    findings: [
      finding(
        '对不会的部分说「这块我没深入过」是加分项 —— 面试官据此判断的是可信度，不是能力上限。',
        'inferred',
        perfIds(boundary.length > 0 ? boundary : turns),
      ),
      ...(evasion.length > 0
        ? [
            finding(
              `有 ${evasion.length} 段回答用「看情况」「差不多」这类表述绕开了问题，这里是最容易被追问穿的地方。`,
              'inferred',
              perfIds(evasion),
            ),
          ]
        : []),
    ],
    extras: { boundaryCount: boundary.length, evasionCount: evasion.length },
    scores: { boundary: score },
  });
}

function analyzeP6(pc: PerformanceContext, dim: DebriefDimension): DebriefDimension {
  const turns = pc.candidateTurns;
  const asks = turns.filter((t) => anyMatch(CANDIDATE_QUESTION_PATTERNS, t.text));
  if (turns.length === 0 && asks.length === 0) return blankPerformance(dim, '转写里没有区分出「我」的发言段落。');
  const interaction = clamp(3 + (asks.length > 0 ? 1 : 0), 1, 5);
  return withIds({
    ...dim,
    status: 'ok',
    basis: 'inferred',
    verdictLine: `我方发言 ${turns.length} 段，其中主动提问 ${asks.length} 段。`,
    findings: [
      finding(
        asks.length === 0
          ? '转写里没有出现我方主动提问。提问不是加分表演，但它决定你能不能在入职前拿到关键信息。'
          : `主动提问的内容包括：${asks.slice(0, 2).map((t) => truncate(t.text, 40)).join('；')}。`,
        'inferred',
        perfIds(asks.length > 0 ? asks : turns),
      ),
    ],
    extras: { askCount: asks.length, answerCount: turns.length },
    scores: { interaction },
    questions: asks.length === 0 ? [question('准备 3 个只能由对方回答的具体问题（指标口径、加班计算、上手安排）。', 'medium', 'self_improve', 'P6')] : [],
  });
}

// ---- 规则版整体分析 ----

export function analyzeDimensionsByRule(input: {
  evidence: DebriefEvidence[];
  profile: CandidateProfile | null;
  job: JobRequirement | null;
}): DebriefDimension[] {
  const ctx: DimensionContext = {
    evidence: input.evidence,
    profile: input.profile,
    job: input.job,
    candidateText: input.evidence.filter((e) => e.speaker === 'candidate').map((e) => e.quote).join('\n'),
    interviewerText: input.evidence.filter((e) => e.speaker === 'interviewer').map((e) => e.quote).join('\n'),
  };
  const skeleton = debriefDimensionSkeleton();
  const byId = new Map(skeleton.map((d) => [d.id, d]));
  const done: DebriefDimension[] = [];

  const run = (id: string, fn: (dim: DebriefDimension) => DebriefDimension) => {
    const dim = byId.get(id);
    if (!dim) return;
    done.push(fn(dim));
  };

  run('D1', (d) => analyzeD1(ctx, d));
  run('D2', (d) => analyzeD2(ctx, d));
  run('D3', (d) => analyzeD3(ctx, d));
  run('D4', (d) => analyzeD4(ctx, d));
  run('D5', (d) => analyzeD5(ctx, d));
  run('D6', (d) => analyzeD6(ctx, d));
  run('D7', (d) => analyzeD7(ctx, d, done));
  run('D8', (d) => analyzeD8(ctx, d));
  run('D9', (d) => analyzeD9(ctx, d));
  run('D10', (d) => analyzeD10(ctx, d));

  const performance = performanceCtx(ctx, input.job);
  run('P1', (d) => analyzeP1(performance, d));
  run('P2', (d) => analyzeP2(performance, d));
  run('P3', (d) => analyzeP3(performance, d));
  run('P4', (d) => analyzeP4(performance, d));
  run('P5', (d) => analyzeP5(performance, d));
  run('P6', (d) => analyzeP6(performance, d));

  // D11 / D12 依赖前面的维度结论，必须在最后算
  const d11 = analyzeD11(ctx, byId.get('D11') as DebriefDimension, done);
  const d12 = analyzeD12(ctx, byId.get('D12') as DebriefDimension, done);
  done.push(d11, d12);

  // 按框架顺序返回（D1..D12, P1..P6），而不是执行顺序
  const order = new Map(DEBRIEF_DIMENSIONS.map((d, i) => [d.id, i]));
  return done.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

// ---------------------------------------------------------------------------
// AI 增强（覆盖规则结果的对应字段）
// ---------------------------------------------------------------------------

export interface AiDimensionShape {
  dimensions?: Array<{
    id?: string;
    status?: string;
    basis?: string;
    verdictLine?: string;
    findings?: Array<{ text?: string; basis?: string; evidence_ids?: string[]; evidenceIds?: string[] }>;
    unknowns?: string[];
    questions?: Array<{ text?: string; priority?: string; category?: string; targets?: string }>;
    extras?: Record<string, unknown>;
  }>;
}

const VALID_IDS = new Set(DEBRIEF_DIMENSIONS.map((d) => d.id));
const VALID_QUESTION_CATEGORIES = new Set(Object.keys(QUESTION_CATEGORY_BY_TOPIC));
const VALID_EVIDENCE_ID = /^E[0-9]+$/;

/**
 * 用模型输出覆盖规则结果。
 *
 * 三条守则：
 * 1. 维度 id 必须在框架内 —— 模型不许凭空造一个 D13；
 * 2. evidence_ids 必须是真的证据编号 —— 编造的引用一律丢掉；
 * 3. 挂不上证据的 finding 一律丢掉 —— 这是框架里最硬的一条纪律。
 */
export function applyAiDimensions(base: DebriefDimension[], raw: AiDimensionShape | null, evidenceIds: Set<string>): DebriefDimension[] {
  const list = raw?.dimensions;
  if (!Array.isArray(list)) return base;
  const byId = new Map(list.map((d) => [d.id, d]));

  return base.map((dim) => {
    const patch = byId.get(dim.id);
    if (!patch) return dim;

    const findings: DebriefFinding[] = (patch.findings ?? [])
      .map((f) => ({
        text: (f.text ?? '').trim(),
        basis: (f.basis === 'stated' ? 'stated' : 'inferred') as DebriefBasis,
        evidenceIds: uniqueBy((f.evidence_ids ?? f.evidenceIds ?? []).filter((id) => VALID_EVIDENCE_ID.test(id) && evidenceIds.has(id)), (x) => x),
      }))
      .filter((f) => f.text.length > 0 && f.evidenceIds.length > 0);

    const questions: DebriefQuestion[] = (patch.questions ?? [])
      .map((q) => ({
        text: (q.text ?? '').trim(),
        priority: (q.priority === 'high' || q.priority === 'low' ? q.priority : 'medium') as TriLevel,
        // 分类枚举由本地校验，模型写了不认识的分类就退回 other
        category: (VALID_QUESTION_CATEGORIES.has(String(q.category)) ? String(q.category) : 'other') as DebriefQuestionCategory,
        targets: q.targets && VALID_IDS.has(q.targets) ? q.targets : dim.id,
      }))
      .filter((q) => q.text.length > 0);

    const status: DebriefDimStatus =
      patch.status === 'ok' || patch.status === 'partial' || patch.status === 'insufficient_info'
        ? patch.status
        : dim.status;
    const basis: DebriefBasis | 'mixed' =
      patch.basis === 'stated' || patch.basis === 'inferred' || patch.basis === 'mixed' ? patch.basis : dim.basis;

    // 若模型给出的 findings 全被过滤掉（例如引用编号不存在），保留规则版本 —— 不许出现空结论维度
    const useAiFindings = findings.length > 0;
    return withIds({
      ...dim,
      status,
      basis,
      verdictLine: (patch.verdictLine ?? '').trim() || dim.verdictLine,
      findings: useAiFindings ? findings : dim.findings,
      unknowns: Array.isArray(patch.unknowns) && patch.unknowns.length > 0 ? patch.unknowns.map((u) => String(u)) : dim.unknowns,
      questions: questions.length > 0 ? questions : dim.questions,
      extras: patch.extras && typeof patch.extras === 'object' ? { ...dim.extras, ...patch.extras } : dim.extras,
    });
  });
}

// ---------------------------------------------------------------------------
// ③ 表现总评 / 岗位适配评定
// ---------------------------------------------------------------------------

export function buildPerformanceSummary(dimensions: DebriefDimension[]): InterviewPerformanceSummary {
  const perf = dimensions.filter((d) => d.kind === 'performance');
  const byId = new Map(perf.map((d) => [d.id, d]));
  const p2 = byId.get('P2');
  const facts = Number((p2?.extras?.factCount as number | undefined) ?? 0);
  const vague = Number((p2?.extras?.vagueCount as number | undefined) ?? 0);
  const total = Number((p2?.extras?.totalCount as number | undefined) ?? 0);

  let overall: PerformanceOverall;
  if (total === 0) {
    overall = 'insufficient';
  } else {
    const factRatio = pct(facts, total);
    const structureScore = Number((byId.get('P1')?.scores?.structure as number | undefined) ?? 0);
    if (factRatio >= 0.6 && structureScore >= 4) overall = 'excellent';
    else if (factRatio >= 0.4) overall = 'good';
    else if (factRatio >= 0.2) overall = 'fair';
    else overall = 'weak';
  }

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const improvable: InterviewPerformanceSummary['improvable'] = [];

  const weakThreshold: Record<string, number> = { structure: 3, specificity: 3, job_alignment: 3, depth: 3, boundary: 3, interaction: 3 };
  for (const dim of perf) {
    for (const [key, value] of Object.entries(dim.scores)) {
      if (typeof value !== 'number') continue;
      if (value >= 4) strengths.push(`${dim.name}：${dim.verdictLine}`);
      else if (value <= (weakThreshold[key] ?? 3)) {
        weaknesses.push(`${dim.name}：${dim.verdictLine}`);
        improvable.push({ point: dim.name, howTo: improveHowTo(dim.id), evidenceIds: dim.evidenceIds.slice(0, 2) });
      }
    }
  }

  return {
    overall,
    strengths: uniqueBy(strengths, (s) => s.slice(0, 20)).slice(0, 5),
    weaknesses: uniqueBy(weaknesses, (s) => s.slice(0, 20)).slice(0, 5),
    improvable: uniqueBy(improvable, (i) => i.point).slice(0, 5),
    answerTurns: total,
    factBackedTurns: facts,
    vagueTurns: vague,
  };
}

function improveHowTo(dimensionId: string): string {
  const map: Record<string, string> = {
    P1: '下次回答先给一句话结论，再补两条依据；实在想不起结构就先用「分三点说」。',
    P2: '把「挺熟悉的」换成「在 X 项目里用它做过 Y，结果是 Z」——补上数字、时间或交付物。',
    P3: '面试前把岗位要求里的关键词抄出来，每个词准备一句「我用它做过什么」。',
    P4: '每讲一个做法，补一句「当时还考虑过另一个方案，没选它是因为……」。',
    P5: '不会的问题直接说「这块我没深入过，我的理解是……」，比绕开更容易被信任。',
    P6: '面试尾声至少问一个只能由对方回答的问题（指标口径、加班计算、上手安排）。',
  };
  return map[dimensionId] ?? '回看这段录音，把它改成一句带事实的表述。';
}

export function buildFitAssessment(input: {
  dimensions: DebriefDimension[];
  profile: CandidateProfile | null;
  job: JobRequirement | null;
  matchReport: AnalysisReport | null;
}): DebriefFitAssessment {
  const d7 = input.dimensions.find((d) => d.id === 'D7');
  const fitScores = (d7?.extras?.fitScores as DebriefFitItem[] | undefined) ?? [];
  const boundaryHits = fitScores.filter((f) => f.touchedBoundary).map((f) => f.label);

  if (!input.profile) {
    return {
      status: 'insufficient_info',
      basedOn: input.matchReport ? 'match_report' : 'interview_only',
      matchReportId: input.matchReport?.id,
      overallVerdict: input.matchReport?.verdict ?? null,
      summary: '尚未建立能力档案，这次只复盘了面试表现，没有做岗位适配度评定。建议先用简历建一份档案。',
      items: [],
      boundaryHits: [],
    };
  }

  const judged = fitScores.filter((f) => f.score !== null);
  const lowest = judged.slice().sort((a, b) => (a.score ?? 9) - (b.score ?? 9))[0];
  const status: DebriefDimStatus = judged.length === 0 ? 'insufficient_info' : judged.length >= 5 ? 'ok' : 'partial';

  const source = input.matchReport
    ? `本次结论在已有匹配报告（${input.matchReport.verdict ? '整体判断已给出' : '无整体判断'}）基础上，叠加了面试里新获得的信息。`
    : '这次没有对应的匹配报告，适配度只依据面试里谈到的事实。';

  return {
    status,
    basedOn: input.matchReport ? 'match_report' : 'interview_only',
    matchReportId: input.matchReport?.id,
    overallVerdict: input.matchReport?.verdict ?? null,
    summary:
      judged.length === 0
        ? `${source} 但这场面试没有谈到足以判断适配度的内容。`
        : `${source} 可判的 ${judged.length} 项里，最弱的是「${lowest?.label}」（${lowest?.score}/5）。${boundaryHits.length > 0 ? `注意：有 ${boundaryHits.length} 项触碰了你写下的偏好边界。` : ''}`,
    items: judged,
    boundaryHits,
  };
}

// ---------------------------------------------------------------------------
// ④ 综合与决策
// ---------------------------------------------------------------------------

export interface SynthesizeOutput {
  synthesis: DebriefSynthesis;
  charts: DebriefCharts;
  questions: DebriefQuestion[];
}

export function synthesizeByRule(dimensions: DebriefDimension[]): SynthesizeOutput {
  const byId = new Map(dimensions.map((d) => [d.id, d]));
  const d4 = byId.get('D4');
  const d3 = byId.get('D3');
  const d9 = byId.get('D9');
  const d10 = byId.get('D10');
  const d12 = byId.get('D12');

  const stressLevels = (d4?.extras?.stressLevels as Array<{ key: string; level: DebriefPressureLevel; evidenceIds: string[] }> | undefined) ?? [];
  const tier = (d12?.extras?.tier as DebriefSynthesis['tier'] | undefined) ?? 'insufficient';
  const decisionTable = (d12?.extras?.decisionTable as DebriefDecisionTier[] | undefined) ?? DECISION_TIERS.map((t) => ({ key: t.key, label: t.label, conditions: [] }));
  const scenarios = (d12?.extras?.scenarios as DebriefScenario[] | undefined) ?? [];

  const charts: DebriefCharts = {
    pressure: stressLevels.map((s) => ({
      axis: STRESS_TYPES.find((t) => t.key === s.key)?.label ?? s.key,
      value: pressureToScore(s.level),
    })),
    fit: ((byId.get('D7')?.extras?.fitScores as DebriefFitItem[] | undefined) ?? []).map((f) => ({ axis: f.label, value: f.score })),
    performance: PERFORMANCE_DIMENSION_DEFS.map((def) => {
      const dim = byId.get(def.id);
      const value = Object.values(dim?.scores ?? {}).find((v) => typeof v === 'number');
      return { axis: def.name, value: typeof value === 'number' ? value : null };
    }),
    workloadTime: d3?.extras?.workloadTable
      ? {
          formula: d3.computation?.formula ?? '',
          rows: d3.extras.workloadTable as Array<Record<string, number | string | null>>,
          verdict: d3.computation?.verdict ?? '',
        }
      : null,
    compensation: d10?.extras?.compensationRows
      ? {
          formula: d10.computation?.formula ?? '',
          rows: d10.extras.compensationRows as Array<Record<string, number | string | null>>,
          verdict: d10.computation?.verdict ?? '',
        }
      : null,
  };

  const highlights: DebriefSynthesis['highlights'] = [];
  const highStress = stressLevels.filter((s) => s.level === 'high');
  if (highStress.length > 0) {
    highlights.push({
      text: `${highStress.length} 类压力被判定为「高」：${highStress.map((s) => STRESS_TYPES.find((t) => t.key === s.key)?.label ?? s.key).join('、')}`,
      evidenceIds: uniqueBy(highStress.flatMap((s) => s.evidenceIds), (x) => x).slice(0, 4),
    });
  }
  const riskSignals = (d9?.extras?.riskSignals as Array<{ label: string; evidenceIds: string[] }> | undefined) ?? [];
  if (riskSignals.length > 0) {
    highlights.push({
      text: `出现 ${riskSignals.length} 类风险话术（${riskSignals.slice(0, 3).map((r) => r.label).join('、')}），报告里给出了验证方法`,
      evidenceIds: uniqueBy(riskSignals.flatMap((r) => r.evidenceIds), (x) => x).slice(0, 4),
    });
  }
  if (d10?.status === 'partial') {
    highlights.push({
      text: '薪酬与工时已按材料中的数字算出单位时间回报区间，可以自己复算',
      evidenceIds: d10.evidenceIds.slice(0, 3),
    });
  }
  if (d3?.status === 'ok') {
    highlights.push({ text: d3.verdictLine, evidenceIds: d3.evidenceIds.slice(0, 3) });
  }
  if (highlights.length === 0 && dimensions.length > 0) {
    const first = dimensions.find((d) => d.findings.length > 0);
    if (first) highlights.push({ text: first.findings[0].text, evidenceIds: first.findings[0].evidenceIds });
  }

  const questions = dedupeQuestions(dimensions.flatMap((d) => d.questions));

  const verdictParagraph = buildVerdictParagraph(tier, dimensions, highStress.length, riskSignals.length);
  const oneLine = buildOneLine(tier);

  return {
    synthesis: {
      oneLine,
      tier,
      verdictParagraph,
      highlights: highlights.filter((h) => h.evidenceIds.length > 0).slice(0, 5),
      scenarios,
      decisionTable,
      nextAction: buildNextAction(tier, dimensions, questions),
      boundaryStatement: DEBRIEF_BOUNDARY_STATEMENT,
    },
    charts,
    questions,
  };
}

function buildOneLine(tier: DebriefSynthesis['tier']): string {
  switch (tier) {
    case 'consider':
      return '这次面试拿到的信息以正面为主，可以进入下一步，但存量疑点需要问清。';
    case 'caution':
      return '这次面试存在需要先验证的疑点，确认之后再做决定。';
    case 'mismatch':
      return '按录音里出现的信息判断，这条路的实际强度与代价都比较高。';
    default:
      return '这次面试拿到的可用信息不足，暂时无法归类。';
  }
}

function buildVerdictParagraph(
  tier: DebriefSynthesis['tier'],
  dimensions: DebriefDimension[],
  highStressCount: number,
  riskCount: number,
): string {
  const judged = dimensions.filter((d) => d.kind === 'opportunity' && d.status !== 'insufficient_info').length;
  const insufficient = dimensions.filter((d) => d.status === 'insufficient_info').length;
  const head =
    tier === 'consider'
      ? '从这次面试能听到的内容看，没有出现足以直接否掉这条路的信号。'
      : tier === 'caution'
        ? '这次面试里有几处需要先确认再决定的地方。'
        : tier === 'mismatch'
          ? '按录音里出现的信息，这份工作的实际强度明显高于寻常水平。'
          : '这次面试能用的信息太少，还不足以给出归类。';

  const body =
    tier === 'insufficient'
      ? `${dimensions.length} 个维度里有 ${insufficient} 个证据不足。多数情况下这是面试本身没说清，而不是问题不存在 —— 建议按报告结尾的问题清单再问一轮。`
      : `机会侧有 ${judged} 个维度拿到了可用证据${highStressCount > 0 ? `，其中 ${highStressCount} 类压力被判定为「高」` : ''}${riskCount > 0 ? `，命中 ${riskCount} 类风险话术` : ''}。`;

  return `${head}${body}报告只使用录音里出现过的话，没有用行业惯例补全任何缺失的部分。`;
}

function buildNextAction(
  tier: DebriefSynthesis['tier'],
  dimensions: DebriefDimension[],
  questions: DebriefQuestion[],
): string {
  const highPriority = questions.filter((q) => q.priority === 'high').slice(0, 3);
  const improvable = dimensions.find((d) => d.kind === 'performance' && d.status === 'ok');

  if (tier === 'insufficient') {
    return highPriority.length > 0
      ? `今天把这条消息发给对方：${highPriority[0].text}`
      : '今天把这次面试里自己没答上来的问题写下来，列出三个需要补的知识点。';
  }
  if (tier === 'mismatch') {
    return '今天先不要推进这条线，把时间投到其他机会上；如果已经有 offer 在等，按报告里的决策表逐条核对后再回复。';
  }
  if (tier === 'caution') {
    return highPriority.length > 0
      ? `今天把这条消息发给对方：${highPriority[0].text}`
      : '今天把报告里的风险话术对应的问题整理成一条消息，发给对方确认。';
  }
  // consider：机会侧没问题，那就把下一步放在自己身上
  return improvable
    ? `今天回看录音里自己最不满意的那一段，按「结论 + 两条依据」重写一遍并读出来。`
    : '今天把报告里的问题清单发给对方确认，同时开始准备下一轮面试。';
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export interface BuildDebriefInput {
  session: InterviewDebriefSession;
  profile: CandidateProfile | null;
  job: JobRequirement | null;
  /** 已有的匹配报告（有就复用它的五档结论，不重复造刻度） */
  matchReport?: AnalysisReport | null;
  gateway: AiGateway;
  /** 是否对转写做去标识化，默认 true */
  anonymize?: boolean;
}

export interface BuildDebriefOutput {
  report: InterviewDebriefReport;
  anonymizeReport: AnonymizeReport;
  /** 送给分析链路的文本（已脱敏），留档用于「AI 实际收到了什么」 */
  analysisText: string;
  warnings: string[];
  engine: 'rule' | 'ai' | 'hybrid';
}

export async function buildInterviewDebrief(input: BuildDebriefInput): Promise<BuildDebriefOutput> {
  const warnings: string[] = [];
  const rawTranscript = sessionTranscript(input.session);

  if (rawTranscript.trim().length === 0) {
    throw new Error('这个会话里没有可分析的文本：既没有转写结果，也没有手工粘贴的内容');
  }

  const useAnonymize = input.anonymize !== false;
  const anonymized = useAnonymize
    ? anonymizeTranscript(rawTranscript, { apply: true })
    : anonymizeTranscript(rawTranscript, { apply: false });
  const analysisText = anonymized.text;

  // ---- ① 证据 ----
  const extract = await extractDebriefEvidence({ transcript: analysisText, gateway: input.gateway });
  if (extract.warning) warnings.push(extract.warning);
  const evidence = extract.evidence;
  if (evidence.length === 0) warnings.push('没有从转写里抽出任何可用的事实，报告会以「证据不足」为主。');

  // ---- ② 维度 ----
  const ruleDimensions = analyzeDimensionsByRule({ evidence, profile: input.profile, job: input.job });
  const evidenceIdSet = new Set(evidence.map((e) => e.id));
  const analysisRun = await input.gateway.runJson<AiDimensionShape>(
    'interview_debrief_analysis',
    [
      { role: 'system', content: DEBRIEF_ANALYSIS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          evidence,
          profile: input.profile
            ? {
                skills: input.profile.skills.map((s) => s.name),
                summary: input.profile.summary,
                selfDescriptions: input.profile.selfDescriptions,
              }
            : null,
          jobRequirements: input.job?.items.map((i) => ({ content: i.content, type: i.type, importance: i.importance, keywords: i.keywords })) ?? [],
        }),
      },
    ],
    { maxTokens: 8192 },
  );
  let dimensions = ruleDimensions;
  if (analysisRun.value) {
    dimensions = applyAiDimensions(ruleDimensions, analysisRun.value, evidenceIdSet);
  } else if (analysisRun.error) {
    warnings.push(`维度分析走了本地规则（${analysisRun.error}）`);
  }

  // ---- ③ 表现与适配 ----
  const performance = buildPerformanceSummary(dimensions);
  const fit = buildFitAssessment({
    dimensions,
    profile: input.profile,
    job: input.job,
    matchReport: input.matchReport ?? null,
  });

  // ---- ④ 综合 ----
  const ruleSynthesis = synthesizeByRule(dimensions);
  const synthesisRun = await input.gateway.runJson<{ synthesis?: Partial<DebriefSynthesis>; questions?: DebriefQuestion[] }>(
    'interview_debrief_synthesis',
    [
      { role: 'system', content: DEBRIEF_SYNTHESIS_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ dimensions: dimensions.map((d) => ({ id: d.id, status: d.status, verdictLine: d.verdictLine, findings: d.findings, scores: d.scores })) }) },
    ],
    { maxTokens: 4096 },
  );
  let synthesis = ruleSynthesis.synthesis;
  let questions = ruleSynthesis.questions;
  if (synthesisRun.value) {
    synthesis = mergeSynthesis(ruleSynthesis.synthesis, synthesisRun.value.synthesis, evidenceIdSet);
    const aiQuestions = (synthesisRun.value.questions ?? []).filter((q) => (q?.text ?? '').trim().length > 0);
    if (aiQuestions.length > 0) questions = aiQuestions;
  } else if (synthesisRun.error) {
    warnings.push(`综合与决策走了本地规则（${synthesisRun.error}）`);
  }

  const engine: 'rule' | 'ai' | 'hybrid' =
    extract.engine === 'ai' && analysisRun.value && synthesisRun.value
      ? 'ai'
      : extract.engine === 'rule' && !analysisRun.value && !synthesisRun.value
        ? 'rule'
        : 'hybrid';

  const speakers = uniqueBy(evidence.map((e) => e.speaker), (s) => s);
  const completeness: InterviewDebriefReport['meta']['completeness'] =
    evidence.length === 0
      ? 'fragment'
      : speakers.includes('candidate') && speakers.includes('interviewer')
        ? 'full'
        : 'partial';

  const report: InterviewDebriefReport = {
    id: newId('debrief'),
    schemaVersion: DEBRIEF_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    domain: 'interview-debrief',
    sessionId: input.session.id,
    profileId: input.session.profileId,
    jobId: input.session.jobId,
    jobTitle: input.session.jobTitle ?? input.job?.jobTitle,
    meta: {
      title: `${input.session.jobTitle ?? input.job?.jobTitle ?? '这次面试'} · 面试复盘`,
      mode: input.session.mode,
      sources: input.session.sources,
      quiet: input.session.quiet,
      durationMs: input.session.durationMs,
      anonymized: useAnonymize,
      confidence: evidence.length >= 40 ? 'high' : evidence.length >= 12 ? 'medium' : 'low',
      transcriptChars: rawTranscript.length,
      speakers,
      completeness,
      limitations: buildLimitations(input.session, evidence, speakers, warnings),
      engine,
    },
    evidence,
    dimensions,
    performance,
    fit,
    charts: ruleSynthesis.charts,
    synthesis,
    questions,
    disclaimer: DEBRIEF_DISCLAIMER,
  };

  return { report, anonymizeReport: anonymized.report, analysisText, warnings, engine };
}

function mergeSynthesis(
  base: DebriefSynthesis,
  patch: Partial<DebriefSynthesis> | undefined,
  evidenceIds: Set<string>,
): DebriefSynthesis {
  if (!patch) return base;
  const highlights = (patch.highlights ?? [])
    .map((h) => ({
      text: (h?.text ?? '').trim(),
      evidenceIds: uniqueBy((h?.evidenceIds ?? []).filter((id) => evidenceIds.has(id)), (x) => x),
    }))
    .filter((h) => h.text.length > 0 && h.evidenceIds.length > 0);
  return {
    oneLine: (patch.oneLine ?? '').trim() || base.oneLine,
    tier: patch.tier && ['consider', 'caution', 'mismatch', 'insufficient'].includes(patch.tier) ? patch.tier : base.tier,
    verdictParagraph: (patch.verdictParagraph ?? '').trim() || base.verdictParagraph,
    highlights: highlights.length > 0 ? highlights.slice(0, 5) : base.highlights,
    scenarios: Array.isArray(patch.scenarios) && patch.scenarios.length === 3 ? patch.scenarios : base.scenarios,
    decisionTable: Array.isArray(patch.decisionTable) && patch.decisionTable.length === 3 ? patch.decisionTable : base.decisionTable,
    nextAction: (patch.nextAction ?? '').trim() || base.nextAction,
    boundaryStatement: base.boundaryStatement,
  };
}

function buildLimitations(
  session: InterviewDebriefSession,
  evidence: DebriefEvidence[],
  speakers: Speaker[],
  warnings: string[],
): string[] {
  const limits: string[] = [];
  if (!speakers.includes('interviewer')) limits.push('转写里没有区分出面试方的发言，机会侧维度主要靠推断');
  if (!speakers.includes('candidate')) limits.push('转写里没有区分出你方发言，表现侧维度无法评估');
  if (session.segments.some((s) => s.status === 'failed')) {
    limits.push(`${session.segments.filter((s) => s.status === 'failed').length} 段录音转写失败，内容有缺口`);
  }
  if (session.sources.system === false && session.mode === 'online') {
    limits.push('线上面试没有开启内录，对方的声音可能只通过麦克风间接录到');
  }
  if (evidence.length < 12) limits.push('可用事实偏少，多数维度只能给「证据不足」');
  for (const w of warnings) if (!limits.includes(w)) limits.push(w);
  return limits;
}

/**
 * 便捷入口：**完全离线**地跑完整条复盘链路（不联网、不调用任何模型）。
 *
 * 用途有两个，都很实在：
 *   1. 单测与冒烟测试需要一个确定性的、可复现的报告，不受网络与 Key 影响；
 *   2. 用户没配模型时，界面可以直接走这条路出一份「规则版」报告 ——
 *      它比模型版粗，但每一条结论都能机械复核。
 */
export function buildDebriefRulesOnly(input: {
  session: InterviewDebriefSession;
  profile: CandidateProfile | null;
  job: JobRequirement | null;
  matchReport?: AnalysisReport | null;
  /** 是否对转写做去标识化，默认 true */
  anonymize?: boolean;
}): {
  report: InterviewDebriefReport;
  evidence: DebriefEvidence[];
  dimensions: DebriefDimension[];
  synthesis: SynthesizeOutput;
  analysisText: string;
} {
  const rawTranscript = sessionTranscript(input.session);
  const useAnonymize = input.anonymize !== false;
  const analysisText = anonymizeTranscript(rawTranscript, { apply: useAnonymize }).text;

  const evidence = extractEvidenceByRule(analysisText);
  const dimensions = analyzeDimensionsByRule({ evidence, profile: input.profile, job: input.job });
  const synthesis = synthesizeByRule(dimensions);
  const speakers = uniqueBy(evidence.map((e) => e.speaker), (s) => s);

  const report: InterviewDebriefReport = {
    id: newId('debrief'),
    schemaVersion: DEBRIEF_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    domain: 'interview-debrief',
    sessionId: input.session.id,
    profileId: input.session.profileId,
    jobId: input.session.jobId,
    jobTitle: input.session.jobTitle ?? input.job?.jobTitle,
    meta: {
      title: `${input.session.jobTitle ?? input.job?.jobTitle ?? '这次面试'} · 面试复盘`,
      mode: input.session.mode,
      sources: input.session.sources,
      quiet: input.session.quiet,
      durationMs: input.session.durationMs,
      anonymized: useAnonymize,
      confidence: evidence.length >= 40 ? 'high' : evidence.length >= 12 ? 'medium' : 'low',
      transcriptChars: rawTranscript.length,
      speakers,
      completeness:
        evidence.length === 0 ? 'fragment' : speakers.includes('candidate') && speakers.includes('interviewer') ? 'full' : 'partial',
      limitations: buildLimitations(input.session, evidence, speakers, []),
      engine: 'rule',
    },
    evidence,
    dimensions,
    performance: buildPerformanceSummary(dimensions),
    fit: buildFitAssessment({
      dimensions,
      profile: input.profile,
      job: input.job,
      matchReport: input.matchReport ?? null,
    }),
    charts: synthesis.charts,
    synthesis: synthesis.synthesis,
    questions: synthesis.questions,
    disclaimer: DEBRIEF_DISCLAIMER,
  };

  return { report, evidence, dimensions, synthesis, analysisText };
}

/** 分段转写的进度摘要，界面用它显示「第 3/12 段」 */
export function segmentProgress(segments: CaptureSegment[]): { done: number; total: number; failed: number } {
  return {
    done: segments.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    total: segments.length,
    failed: segments.filter((s) => s.status === 'failed').length,
  };
}

/** 转写段落 → 会话轮次（按换行切分，保留时间轴） */
export function turnsFromSegment(
  segment: CaptureSegment,
  text: string,
  fallbackSpeaker: Speaker = 'unknown',
): TranscriptTurn[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  const per = segment.durationMs / sentences.length;
  return sentences.map((sentence, i) => {
    const parsed = parseSpeakerTag(sentence);
    const speaker = parsed.speaker === 'unknown' ? (fallbackSpeaker === 'unknown' ? inferSpeaker(parsed.text) : fallbackSpeaker) : parsed.speaker;
    return {
      id: newId('turn'),
      segmentIndex: segment.index,
      startOffsetMs: Math.round(segment.startOffsetMs + per * i),
      endOffsetMs: Math.round(segment.startOffsetMs + per * (i + 1)),
      speaker,
      text: parsed.text,
      source: 'asr' as const,
    };
  });
}

/** 适配度总评的一句话（界面顶部展示） */
export function fitHeadline(fit: DebriefFitAssessment): string {
  if (fit.status === 'insufficient_info') return '这次没有足够的信息做适配度评定';
  const lowest = fit.items.slice().sort((a, b) => (a.score ?? 9) - (b.score ?? 9))[0];
  const avg = fit.items.length > 0 ? fit.items.reduce((n, i) => n + (i.score ?? 0), 0) / fit.items.length : 0;
  return `可判 ${fit.items.length} 项，均值 ${avg.toFixed(1)}/5，最弱项是「${lowest?.label}」（${lowest?.score}/5）`;
}

/** 供界面展示的：这次复盘到底覆盖了多少机会侧维度 */
export function debriefCoverage(report: InterviewDebriefReport): { opportunity: number; judged: number; performance: number; overall: Assessment | null } {
  return {
    opportunity: report.dimensions.filter((d) => d.kind === 'opportunity').length,
    judged: report.dimensions.filter((d) => d.kind === 'opportunity' && d.status !== 'insufficient_info').length,
    performance: report.dimensions.filter((d) => d.kind === 'performance' && d.status === 'ok').length,
    overall: report.fit.overallVerdict,
  };
}
