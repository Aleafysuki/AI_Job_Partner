/**
 * 模拟面试引擎（v0.4）
 * ====================
 *
 * 四个能力在这里串成一条链：
 *   interview.generate           出题（岗位要求 / 用户真题 / 档案缺口 / 指定领域）
 *   interview.mock               逐轮追问（答完第 1 轮才知道第 2 轮问什么）
 *   interview.analyze_answer     五维分析（只说缺什么，不给可照读的答案）
 *   interview.weak_point_training 薄弱点回流到能力库
 *
 * ── 本模块最重要的一条约束 ──
 * **不生成任何「你可以这样回答」的内容。**
 *
 * 这与 `training.reference_answer`（训练题给参考答案）是刻意不同的：
 *   训练题有客观对错（联合索引是什么），参考答案帮用户确认「我懂了」；
 *   模拟面试是开放表达，给出参考话术会诱导背诵，
 *   而背出来的表达在第三轮追问下必然崩 —— 那一刻工具帮了倒忙。
 *
 * 所以分析只产出三类东西：
 *   1. 缺什么（哪个维度没提到）
 *   2. 依据（引用作答原文，可核对）
 *   3. 接下来会被问什么（提前知道压力在哪）
 */

import { newId, truncate, unique } from '../utils/text';
import { findSkillsInText, textMentionsSkill } from '../nlp/skills';
import type { TriLevel } from '../domain/common';
import { capabilityLevelOfEvidence } from '../domain/levels';
import type { CandidateProfile } from '../domain/profile';
import type { CandidateEvidence } from '../domain/evidence';
import type { JobRequirement } from '../domain/job';
import {
  ANSWER_DIMENSION_LABEL,
  DIMENSION_VERDICT_LABEL,
  MOCK_DISCLAIMER,
  type AnswerAnalysis,
  type AnswerDimension,
  type DimensionFinding,
  type DimensionVerdict,
  type MockAnswer,
  type MockQuestion,
  type MockSession,
  type MockWeakness,
  type MockQuestionKind,
  type QuestionSource,
  type QuestionSourceRef,
  type WeakeningAction,
  type WeakeningInput,
  type WeakeningSuggestion,
  type FollowUpHook,
} from '../domain/mock-interview';
import { prepareQuestions } from './interview-prep';
import { buildAnswerFeedback, extractFollowUpHooks } from './interactive-followup';

// ---------------------------------------------------------------------------
// 一、出题（interview.generate）
// ---------------------------------------------------------------------------

export interface GenerateQuestionsInput {
  profile: CandidateProfile | null;
  job?: JobRequirement | null;
  /** 用户粘贴的真题原文。可空 */
  realQuestions?: string;
  /** 真题与原文的对应。用户没给就按顺序编号 */
  realQuestionRefs?: QuestionSourceRef[];
  /** 用户指定的知识领域，如「数据库」「消息队列」 */
  domains?: string[];
  /** 是否包含压力题（质疑你的判断） */
  includePressure?: boolean;
  /** 是否按档案缺口出题 */
  includeGap?: boolean;
  /** 题目上限。题太多会让人放弃，默认很少 */
  maxQuestions?: number;
}

export interface GeneratedQuestionSet {
  questions: MockQuestion[];
  /** 出题说明。告诉用户这些题「凭什么被选中」 */
  rationale: string;
  /** 没能出的题（比如岗位要求里有 8 条，但只取了 3 条） */
  dropped: string[];
}

/** 压力题模板。
 *
 * 只问「你当时怎么想的」，不问「你为什么错了」——
 * 后者是质问，前者是让用户自己复盘。语气差别会直接改变用户的回答质量。
 */
const PRESSURE_TEMPLATES = [
  {
    text: '你刚才提到{point}。如果这条数据是错的，你的结论会怎么变？',
    intent: '考察你是否知道自己方案的失效边界。只说「会重新检查」是不够的。',
    probes: ['那你怎么发现它是错的？', '谁会第一个发现？'],
  },
  {
    text: '如果让你现在重做{point}，你会改哪一步？为什么？',
    intent: '考察自我评估能力 —— 答不出来说明还没真正理解自己做的东西。',
    probes: ['这个改动会带来什么新问题？'],
  },
];

/**
 * 从岗位要求里取「面试官一定会问」的点。
 *
 * 排序规则：**硬门槛优先，其次按权重**。
 * 理由：面试官的提问顺序通常也是先问硬门槛（学历、经验年限），
 * 但真正需要用户准备的是权重要求 —— 硬门槛通常已经筛过了。
 */
function questionsFromRequirements(
  job: JobRequirement | null,
  limit: number,
): Array<{ text: string; intent: string; expected: string[]; requirementId: string }> {
  if (!job) return [];
  // 排序：先按硬门槛（面试必问），再按重要度（权重要求才是需要准备的部分）
  const rank = (r: { hardGate: boolean; importance: TriLevel }): number => {
    const gate = r.hardGate ? 0 : 1;
    const imp = r.importance === 'high' ? 0 : r.importance === 'medium' ? 1 : 2;
    return gate * 10 + imp;
  };
  const reqs = [...job.items].sort((a, b) => rank(a) - rank(b));
  const out: Array<{ text: string; intent: string; expected: string[]; requirementId: string }> = [];
  for (const r of reqs) {
    if (out.length >= limit) break;
    // 期望点用「关键词」而不是整句 —— 整句太长，用户不可能逐字复述，
    // 拿它当「有没有答到点」的判据会永远判成没答到。
    const expected = r.keywords.length > 0 ? r.keywords.slice(0, 4) : [truncate(r.content, 16)];
    out.push({
      text: `岗位要求里写了「${truncate(r.content, 40)}」，你在实际工作里是怎么做的？`,
      intent: `这一条${r.hardGate ? '是硬门槛' : `在岗位里重要度${r.importance === 'high' ? '高' : r.importance === 'medium' ? '中' : '低'}`}，面试官大概率会问。`,
      expected,
      requirementId: r.id,
    });
  }
  return out;
}

/**
 * 从「档案里没有证据」的地方出题。
 *
 * 这是最有价值的一类题 —— 用户答不出来的不是他不会，
 * 而是他**从没写下来过**（所以面试时想不起来）。
 * 但这类题的措辞必须是「追问」而不是「质问」：
 * 「你的简历里没写 X，能说说吗」比「你会不会 X」更容易让人说真话。
 */
function questionsFromGaps(
  profile: CandidateProfile | null,
  job: JobRequirement | null,
  limit: number,
): MockQuestion[] {
  if (!profile) return [];
  const mentioned = profile.evidence.map((e) => e.content).join('\n');
  const jobText = (job?.items ?? []).map((r) => `${r.content}\n${r.keywords.join(' ')}`).join('\n');
  const targets = unique([
    ...findSkillsInText(jobText).map((h) => h.def.name),
    ...findSkillsInText(mentioned).map((h) => h.def.name),
  ]).slice(0, limit);

  const out: MockQuestion[] = [];
  for (const skill of targets) {
    const has = textMentionsSkill(mentioned, skill);
    if (has) continue;
    out.push({
      id: newId('mock'),
      round: 0, // 生成阶段不定轮次，由 placeRounds 分配
      source: 'gap' as QuestionSource,
      kind: 'fact' as MockQuestionKind,
      text: `你的档案里没有提到${skill}。如果面试官问「${skill}你用过吗」，你会怎么答？`,
      intent: '这一条在你的档案里查不到任何证据。没有证据不等于不会，但面试官看不到你的能力 —— 这一题考的是你怎么把没有的东西讲清楚。',
      expectedPoints: [
        '有没有真实用过（用过就要能说出具体做了什么）',
        '没用过但了解（就要说清了解到什么程度）',
        '完全没用过（诚实说明是最优解，编造会在追问下崩）',
      ],
      evidenceIds: [],
    });
  }
  return out;
}

/**
 * 按指定领域出题。
 *
 * 刻意出「原理 + 场景 + 边界」三种角度而不是同一个领域出多道同类型的题 ——
 * 同类型重复出题只会浪费用户的准备时间。
 */
function questionsFromDomains(domains: string[], limit: number): MockQuestion[] {
  const ANGLES: Array<{ kind: MockQuestionKind; make: (d: string) => string; intent: string }> = [
    {
      kind: 'fact',
      make: (d) => `${d}的核心原理是什么？它解决了什么问题？`,
      intent: '基础是否扎实。答不上来说明这个领域只是「用过」而不是「懂」。',
    },
    {
      kind: 'scenario',
      make: (d) => `如果${d}在你的项目里出问题，你怎么定位？`,
      intent: '有没有真的在生产环境用过 —— 用过的人会自然说出排查路径，没用过的人会背步骤。',
    },
    {
      kind: 'depth',
      make: (d) => `${d}在什么情况下会失效？`,
      intent: '边界意识。这题答得好会明显拉开差距，但很少有人主动准备。',
    },
  ];

  const out: MockQuestion[] = [];
  for (const d of domains) {
    for (const a of ANGLES) {
      if (out.length >= limit) break;
      out.push({
        id: newId('mock'),
        round: 0,
        source: 'domain' as QuestionSource,
        kind: a.kind,
        text: a.make(d),
        intent: a.intent,
        expectedPoints: [],
        evidenceIds: [],
      });
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 生成一整套题并排好轮次。
 *
 * **轮次分配是这里最重要的一件事**：
 * 把「压力题」排到最后，「档案缺口」排在前面。
 * 原因是压力题会让用户紧张 —— 一上来就问「你错了怎么办」，
 * 大多数人当场就乱了，后面的正常问题也答不好。
 */
export function generateMockQuestions(input: GenerateQuestionsInput): GeneratedQuestionSet {
  const max = Math.max(1, Math.min(input.maxQuestions ?? 4, 8));
  const pool: Array<{ q: MockQuestion; sourceWeight: number }> = [];

  // 真题优先：用户自己拿到的题，一定是真实会问的
  const real: MockQuestion[] = [];
  if (input.realQuestions && input.realQuestions.trim()) {
    const refs = input.realQuestionRefs ?? [];
    const lines = input.realQuestions
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t.length > 3);
    lines.forEach((text, i) => {
      real.push({
        id: newId('mock'),
        round: 0,
        source: 'real',
        sourceRef: refs[i],
        kind: classifyMockKind(text),
        text,
        intent: '这是你提供的真题，考察点与你实际会遇到的一致。',
        expectedPoints: [],
        evidenceIds: [],
      });
    });
  }
  for (const q of real) pool.push({ q, sourceWeight: 0 });

  // 岗位要求
  const fromReq = questionsFromRequirements(input.job ?? null, max);
  for (const r of fromReq) {
    pool.push({
      q: {
        id: newId('mock'),
        round: 0,
        source: 'requirement',
        kind: 'scenario',
        text: r.text,
        intent: r.intent,
        expectedPoints: r.expected,
        requirementId: r.requirementId,
        evidenceIds: [],
      },
      sourceWeight: 1,
    });
  }

  // 档案缺口
  if (input.includeGap) {
    const gaps = questionsFromGaps(input.profile, input.job ?? null, max);
    for (const q of gaps) pool.push({ q, sourceWeight: 2 });
  }

  // 指定领域
  for (const q of questionsFromDomains(input.domains ?? [], max)) {
    pool.push({ q, sourceWeight: 1 });
  }

  // 压力题放最后
  if (input.includePressure) {
    const anchor = pool.find((p) => p.q.expectedPoints.length > 0)?.q;
    const point = anchor ? truncate(anchor.expectedPoints[0], 24) : '你刚才说的那个做法';
    for (const t of PRESSURE_TEMPLATES) {
      pool.push({
        q: {
          id: newId('mock'),
          round: 0,
          source: 'requirement',
          kind: 'pressure',
          text: t.text.replace('{point}', point),
          intent: t.intent,
          expectedPoints: [],
          evidenceIds: [],
          probes: t.probes,
        },
        // 3 = 排到最后
        sourceWeight: 3,
      });
    }
  }

  // 去重（同一段文本可能既来自真题又来自岗位要求）
  const seen = new Set<string>();
  const picked: MockQuestion[] = [];
  const dropped: string[] = [];
  for (const item of pool) {
    const key = item.q.text.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    if (picked.length < max) picked.push(item.q);
    else dropped.push(key);
  }

  // 按 sourceWeight 稳定排序，然后编轮次
  const ordered = picked
    .map((q, i) => ({ q, i }))
    .sort((a, b) => {
      const wa = pool.findIndex((p) => p.q.id === a.q.id);
      const wb = pool.findIndex((p) => p.q.id === b.q.id);
      return wa - wb;
    })
    .map(({ q }) => q)
    .map((q, i) => ({ ...q, round: i + 1 }));

  return {
    questions: ordered,
    rationale: buildRationale(ordered),
    dropped,
  };
}

function buildRationale(questions: MockQuestion[]): string {
  if (questions.length === 0) return '没有生成任何题目。请先粘贴真题、指定一个领域，或补一个岗位。';
  const bySource = new Map<QuestionSource, number>();
  for (const q of questions) bySource.set(q.source, (bySource.get(q.source) ?? 0) + 1);
  const parts: string[] = [];
  if (bySource.get('real')) parts.push(`${bySource.get('real')} 道你提供的真题`);
  if (bySource.get('requirement')) parts.push(`${bySource.get('requirement')} 道由岗位要求推导`);
  if (bySource.get('gap')) parts.push(`${bySource.get('gap')} 道针对你档案里没有证据的地方`);
  if (bySource.get('domain')) parts.push(`${bySource.get('domain')} 道来自你指定的领域`);
  return `共 ${questions.length} 道：${parts.join('、')}。压力题排在最后 —— 一上来就问「你错了怎么办」，大多数人会当场乱掉。`;
}

/** 从真题文本判断题型。规则刻意保守，判不准就归 scenario */
function classifyMockKind(text: string): MockQuestionKind {
  if (/(原理|什么是|是什么|区别|底层|数据结构|算法|复杂度)/.test(text)) return 'fact';
  if (/(为什么.*(选|用|做)|动机|想加入|为什么来)/.test(text)) return 'motivation';
  if (/(如果|假如|遇到|怎么办|怎么处理|排查|定位)/.test(text)) return 'scenario';
  if (/(你没|你能保证|万一|如果.*错|凭什么|质疑)/.test(text)) return 'pressure';
  return 'scenario';
}

// ---------------------------------------------------------------------------
// 二、回答分析（interview.analyze_answer）
// ---------------------------------------------------------------------------

/**
 * 五维分析里的「命中」判定。
 *
 * 全部是**本地纯函数**，不调模型：判定「有没有说到某个点」是可枚举的，
 * 交给模型反而会给出「他大致提到了相关思路」这类无法核对的结论。
 */
export function analyzeAnswer(input: {
  question: MockQuestion;
  answer: MockAnswer;
  profile?: CandidateProfile | null;
}): AnswerAnalysis {
  const { question, answer } = input;
  const text = answer.text ?? '';
  const findings: DimensionFinding[] = [];
  const has = (kw: string | string[]) => {
    const list = Array.isArray(kw) ? kw : [kw];
    return list.some((k) => text.includes(k));
  };

  // ---- 1. 是否答到点 ----
  // 判据是「expectedPoints 里的关键概念有没有出现」。
  // 刻意不做语义相似度：相似度是模型的主场，而模型的结论无法核对。
  // 只用 includes 判定，理由同 predictFollowUps 里的注释：
  // textMentionsSkill 只认词典内的技能，期望点可能是自定义短语，叠上会误判成全缺失。
  const missed = question.expectedPoints.filter((p) => !text.includes(p));
  const hitCount = question.expectedPoints.length - missed.length;
  let hitPoint: AnswerAnalysis['hitPoint'] = 'yes';
  if (question.expectedPoints.length > 0) {
    const ratio = hitCount / question.expectedPoints.length;
    hitPoint = ratio >= 0.7 ? 'yes' : ratio >= 0.35 ? 'partly' : 'no';
  }

  // ---- 2. 知识是否正确 ----
  // 只判「有没有讲清机制」，不判对错 —— 对错需要领域知识，
  // 而模型在这件事上的错误率太高，用户被误导的成本远大于收益。
  // 所以这一维的判断措辞是「有没有讲清」，不是「对不对」。
  const hasMechanism =
    has(['因为', '原理', '机制', '本质', '原因是', '底层', '为了', '所以']) ||
    (question.expectedPoints.length > 0 && hitCount > 0);
  findings.push({
    dimension: 'correctness',
    verdict: hasMechanism ? (text.length >= 40 ? 'ok' : 'partial') : 'missing',
    quotedFromAnswer: quoteFirst(text, ['因为', '原理', '机制', '本质', '底层']),
    gap: hasMechanism ? undefined : '你没说清它是怎么work的。面试官问「怎么做」时，想听的是机制而不是结论。',
  });

  // ---- 3. 是否讲全了 ----
  if (question.expectedPoints.length > 0) {
    findings.push({
      dimension: 'completeness',
      verdict: hitPoint === 'yes' ? 'ok' : hitPoint === 'partly' ? 'partial' : 'missing',
      gap:
        missed.length > 0
          ? `这几个点没提到：${missed.map((m) => truncate(m, 18)).join('、')}`
          : undefined,
    });
  } else {
    // 没有期望点时改判「长度是否够展开」——这是能诚实判定的
    const len = text.trim().length;
    findings.push({
      dimension: 'completeness',
      verdict: len >= 120 ? 'ok' : len >= 40 ? 'partial' : 'missing',
      gap: len >= 40 ? undefined : '你的回答只有一句话。面试里这一句通常只能撑 10 秒，然后就被打断了。',
    });
  }

  // ---- 4. 结构是否清楚 ----
  // 判据：分点信号（首先/其次/第一/然后/最后）或因果连接。
  // 这不是文风评价 —— 是「面试官能不能跟上」的问题。
  const structured =
    has(['首先', '其次', '第一', '其次', '然后', '最后', '一方面', '另一方面', '结论']) ||
    (text.match(/[。；;]/g) ?? []).length >= 4;
  findings.push({
    dimension: 'structure',
    verdict: structured ? 'ok' : text.length > 30 ? 'partial' : 'missing',
    quotedFromAnswer: quoteFirst(text, ['首先', '其次', '然后', '最后']),
    gap: structured ? undefined : '没有分点。面试官听三句话还跟不上，就会开始想下一个问题。',
  });

  // ---- 5. 是否答到点 ----
  findings.push({
    dimension: 'on_point',
    verdict: hitPoint === 'yes' ? 'ok' : hitPoint === 'partly' ? 'partial' : 'missing',
    gap:
      hitPoint === 'no'
        ? '你答的内容和这题问的不是一回事。这个问题最容易发生的情况是：问「怎么做」，你答「为什么重要」。'
        : undefined,
  });

  // ---- 6. 是否过度展开 ----
  // 这一维是反向的：太长同样是问题。
  // 判据是字数与期望点数的比例 —— 期望点越少，越不该长篇大论。
  const expected = Math.max(1, question.expectedPoints.length);
  const ratio = text.trim().length / (expected * 60);
  findings.push({
    dimension: 'restraint',
    verdict: ratio > 4 ? 'missing' : ratio > 2 ? 'partial' : 'ok',
    gap:
      ratio > 2
        ? `你的回答是期望篇幅的 ${ratio.toFixed(1)} 倍。面试官会打断你，而被打断时你最容易漏掉结尾。`
        : undefined,
  });

  // ---- 7. 证据引用 ----
  const quotes = quoteFromEvidence(text, input.profile);
  findings.sort((a, b) => dimOrder(a.dimension) - dimOrder(b.dimension));

  /*
   * 追问与反馈：交给 interactive-followup 引擎。
   *
   * 为什么不在这里自己写：追问这件事有**状态**（追过几次、还剩几轮），
   * 而 analyzeAnswer 是无状态的纯函数。把状态留在会话层，
   * 逻辑放在专门模块里，两者都不需要知道自己是谁。
   */
  const hooks = extractFollowUpHooks(text, { knownSkills: input.profile ? profileSkills(input.profile) : [] });
  const feedback = buildAnswerFeedback({
    answerText: text,
    hooks,
    expectedPoints: question.expectedPoints,
    usedEvidence: quotes.length > 0,
  });

  return {
    questionId: question.id,
    findings,
    hitPoint,
    likelyFollowUps: unique([...predictFollowUps(question, text), ...hooks.map((h) => h.text)]).slice(0, 3),
    evidenceQuotes: quotes,
    usedEvidence: quotes.length > 0,
    // 新增两段（可选字段，老数据不受影响）
    followUpHooks: hooks,
    feedback,
  };
}

/** 从档案里取技能名，供追问用 */
function profileSkills(profile: CandidateProfile): string[] {
  return profile.evidence.flatMap((e) => e.skills);
}

function dimOrder(d: AnswerDimension): number {
  const order: AnswerDimension[] = ['on_point', 'correctness', 'completeness', 'structure', 'restraint'];
  return order.indexOf(d);
}

/**
 * 追问预测。
 *
 * 与 Prep 引擎的做法一致，但维度不同：
 *   Prep 预测的是「答完这句对方会问什么」（针对内容）；
 *   这里预测的是「针对你这次的回答，对方会追问什么」（针对你的薄弱处）。
 * 后者更有用 —— 因为它正好指出你答得薄的地方。
 */
function predictFollowUps(question: MockQuestion, answerText: string): string[] {
  const out: string[] = [];

  // 题目自带 probes 时用自带的（岗位类问题通常有）
  if (question.probes && question.probes.length > 0) out.push(...question.probes);

  // 依据回答里的薄弱信号追问 —— 这才是「针对你」的。
  //
  // 判定只用 `includes`，不叠 textMentionsSkill：
  // 后者只在「已知技能」里查，而期望点可能是「缓存淘汰策略」这类自定义短语，
  // 叠上它反而永远判成「没提到」，会把整份期望点都算成缺失。
  const missing = question.expectedPoints.filter((p) => !answerText.includes(p));
  for (const m of missing.slice(0, 2)) {
    out.push(`你刚才没提${truncate(m, 16)} —— 这块具体是怎么做的？`);
  }
  if (!hasAnySignal(answerText, ['因为', '原理', '机制'])) {
    out.push('你为什么这么做？（追原理，不是追结论）');
  }
  if (answerText.trim().length < 40) {
    out.push('能不能展开讲一下具体过程？');
  }
  if (answerText.trim().length > expectedLength(question) * 4) {
    out.push('如果只能保留一条结论，你留哪条？');
  }
  return unique(out).slice(0, 3);
}

function expectedLength(q: MockQuestion): number {
  return Math.max(60, q.expectedPoints.length * 60);
}

function hasAnySignal(text: string, kws: string[]): boolean {
  return kws.some((k) => text.includes(k));
}

/** 从作答里引一段原文。只引原文，不改写。 */
function quoteFirst(text: string, markers: string[]): string | undefined {
  for (const m of markers) {
    const i = text.indexOf(m);
    if (i >= 0) return truncate(text.slice(Math.max(0, i - 12), i + 40), 52);
  }
  return undefined;
}

/** 找出作答里引用了档案中的哪几条证据 */
function quoteFromEvidence(
  text: string,
  profile?: CandidateProfile | null,
): AnswerAnalysis['evidenceQuotes'] {
  if (!profile) return [];
  const out: AnswerAnalysis['evidenceQuotes'] = [];
  for (const ev of profile.evidence) {
    // 取原文里最长的 6 个字作为指纹
    const fingerprint = longestRun(text, ev.content);
    if (!fingerprint) continue;
    out.push({
      evidenceId: ev.id,
      quote: fingerprint,
      source: ev.title || '你的档案',
    });
    if (out.length >= 3) break;
  }
  return out;
}

/** 判断 answer 是否复述了 evidence 的一部分：取共有的最长连续片段 */
function longestRun(a: string, b: string): string | null {
  let best = '';
  for (let len = Math.min(a.length, b.length); len >= 6; len--) {
    for (let i = 0; i + len <= b.length; i++) {
      const seg = b.slice(i, i + len);
      if (a.includes(seg) && seg.length > best.length) {
        best = seg;
        break;
      }
    }
    if (best) break;
  }
  return best || null;
}

// ---------------------------------------------------------------------------
// 三、薄弱点回流（interview.weak_point_training）
// ---------------------------------------------------------------------------

/**
 * 从分析结果里提炼薄弱点。
 *
 * 判据只有一条：**某个维度判成 missing 或 partial**。
 * 不做「综合打分后取最低三项」—— 那会让排序结果无法解释。
 */
export function collectWeaknesses(session: MockSession): MockWeakness[] {
  const byDimension = new Map<AnswerDimension, { questions: string[]; quotes: string[]; gap: string }>();

  for (const analysis of session.analyses) {
    const question = session.questions.find((q) => q.id === analysis.questionId);
    if (!question) continue;
    const answer = session.answers.find((a) => a.questionId === analysis.questionId);
    for (const f of analysis.findings) {
      if (f.verdict === 'ok') continue;
      const key = f.dimension;
      const cur = byDimension.get(key);
      if (cur) {
        cur.questions.push(question.id);
        if (f.quotedFromAnswer) cur.quotes.push(f.quotedFromAnswer);
        if (!cur.gap && f.gap) cur.gap = f.gap;
      } else {
        byDimension.set(key, {
          questions: [question.id],
          quotes: f.quotedFromAnswer ? [f.quotedFromAnswer] : [],
          gap: f.gap ?? `这一维度没做到位（${ANSWER_DIMENSION_LABEL[key]}）`,
        });
      }
      void answer;
    }
  }

  /**
   * 哪些维度算「能力薄弱」。
   *
   * 刻意排除 structure 与 restraint —— 那两个是表达习惯，练几次就能改。
   * 把它们写进能力库会污染跨岗位保留的技能等级：
   * 用户练了两场面试表达变好了，但档案里「结构是否清楚」还挂着，
   * 那条记录对任何岗位的判断都没有贡献。
   */
  const ABILITY_DIMENSIONS = new Set<AnswerDimension>(['correctness', 'on_point', 'completeness']);

  const out: MockWeakness[] = [];
  for (const [dimension, v] of byDimension) {
    if (!ABILITY_DIMENSIONS.has(dimension)) continue;
    const severity: MockWeakness['severity'] =
      dimension === 'on_point' ? 'gap' : dimension === 'completeness' ? 'lacking_evidence' : 'partial';
    out.push({
      skillName: undefined,
      gap: `${ANSWER_DIMENSION_LABEL[dimension]}：${v.gap}`,
      severity,
      fromQuestionIds: unique(v.questions),
      evidenceQuotes: v.quotes,
    });
  }
  return out;
}

/**
 * 生成回流建议。
 *
 * **刻意只给三个动作，不给「建议提升到 L3」**：
 * 模拟面试回答的是「这个人缺什么」，而等级回答的是「岗位要什么」，
 * 两个坐标系不同，硬换算会得出误导性的结论。
 */
export function buildWeakeningSuggestions(input: WeakeningInput): WeakeningSuggestion[] {
  const { weaknesses } = input;
  return weaknesses.map((w) => {
    const isExpression = w.severity === 'partial';
    const action: WeakeningAction = isExpression
      ? 'practice_expression'
      : w.severity === 'lacking_evidence'
        ? 'add_evidence'
        : 'learn_concept';
    const why =
      action === 'practice_expression'
        ? '这类问题练几次就能改，不需要改能力等级。'
        : action === 'add_evidence'
          ? '你可能做过，但档案里没有能核对的东西 —— 先补证据比补知识更划算。'
          : '这一轮里你完全没提到，说明它现在是空白而不是半会。';
    return { weakness: w, action, why };
  });
}

/** 新建一场空会话。选题在 generateMockQuestions 之后注入 */
export function newMockSession(input: {
  jobTitle?: string;
  domains?: string[];
  includePressure?: boolean;
  includeGap?: boolean;
  maxQuestions?: number;
}): MockSession {
  return {
    id: newId('mock'),
    createdAt: new Date().toISOString(),
    jobTitle: input.jobTitle,
    questions: [],
    answers: [],
    analyses: [],
    weaknesses: [],
    input: {
      domains: input.domains ?? [],
      includePressure: input.includePressure ?? false,
      includeGap: input.includeGap ?? false,
      maxQuestions: input.maxQuestions ?? 4,
    },
    status: 'questioning',
  };
}

/** 复盘结束时收尾：算薄弱点、算等级调整 */
export function finishMockSession(session: MockSession): MockSession {
  const weaknesses = collectWeaknesses(session);
  return {
    ...session,
    weaknesses,
    status: session.answers.length === session.questions.length ? 'finished' : 'abandoned',
  };
}

export { MOCK_DISCLAIMER, DIMENSION_VERDICT_LABEL };
export { capabilityLevelOfEvidence };