import { describe, expect, it } from 'vitest';
import {
  ANSWER_DIMENSION_LABEL,
  DIMENSION_VERDICT_LABEL,
  MOCK_DISCLAIMER,
  QUESTION_SOURCE_LABEL,
  WEAKENING_ACTION_LABEL,
  analyzeAnswer,
  buildWeakeningSuggestions,
  collectWeaknesses,
  computeMockStats,
  finishMockSession,
  generateMockQuestions,
  newMockSession,
  nextQuestionOf,
  resolveMockLevel,
  type CandidateEvidence,
  type CandidateProfile,
  type JobRequirement,
  type MockQuestion,
  type RequirementItem,
} from '@aijob/core';

/**
 * v0.4 模拟面试链路（generate → mock → analyze_answer → weak_point_training）。
 *
 * 这批测试里有两条是**产品立场**而不是计算规则，��以写成断言：
 *
 *  1. **不生成可以直接照读的答案。** 一旦开始生成，用户就会去背它，
 *     而背下来的回答在第三轮追问下必然崩掉 —— 那时工具帮了倒忙。
 *     所以下面有一条测试直接扫全部产出，断言不含「你应该这么说」这类话。
 *
 *  2. **表达类问题不进能力库。** 「结构不清」「讲太长」练几次就能改，
 *     把它们算成能力薄弱会污染跨岗位保留的能力库。
 */

const ev = (partial: Partial<CandidateEvidence>): CandidateEvidence => ({
  id: 'evd_1',
  kind: 'project',
  title: '证据',
  content: '',
  skills: [],
  metrics: [],
  links: [],
  timeRange: '',
  strength: 'medium',
  strengthReason: '',
  origin: 'resume',
  sourceRef: { kind: 'resume', locator: '简历', excerpt: '' },
  editedByUser: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...partial,
});

const profile: CandidateProfile = {
  id: 'pro_1',
  schemaVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  privacy: { redacted: true, findings: [], policyVersion: 'v0.1' },
  headline: '',
  summary: '',
  targetRoles: [],
  evidences: [],
  skills: [],
  importedFrom: 'scratch',
  updatedAtIso: '2026-01-01T00:00:00.000Z',
  ...({ evidence: [] } as Record<string, unknown>),
} as unknown as CandidateProfile;

const reqItem = (partial: Partial<RequirementItem>): RequirementItem => ({
  id: 'r1',
  index: 1,
  content: '用 Redis 做缓存',
  original: '熟练使用 Redis 做缓存',
  type: 'skill',
  importance: 'high',
  hardGate: false,
  keywords: ['Redis', '缓存'],
  evidenceNeeded: 'project',
  sourceRef: { kind: 'jd', locator: 'JD 第 3 行', excerpt: '熟练使用 Redis 做缓存' },
  confidence: 'high',
  editedByUser: false,
  ...partial,
});

const job: JobRequirement = {
  id: 'job_1',
  schemaVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  jobTitle: '后端工程师',
  company: '',
  source: 'text',
  roleSummary: '',
  items: [reqItem({})],
  screenRisks: [],
  rawText: '',
  privacy: { redacted: true, findings: [], policyVersion: 'v0.1' },
  parsedBy: 'rule',
} as unknown as JobRequirement;

// ---------------------------------------------------------------------------
// 1. 出题（interview.generate）
// ---------------------------------------------------------------------------

describe('模拟面试 · 出题', () => {
  it('真题优先，且保留出处', () => {
    const out = generateMockQuestions({
      profile,
      job,
      realQuestions: '介绍一下你自己\n讲一个你做过的最有挑战的项目',
      realQuestionRefs: [{ org: '某厂', round: '一面' }, {}],
      maxQuestions: 2,
    });
    expect(out.questions.length).toBe(2);
    // 顺序：weight 低的（真题 = 0）在前
    expect(out.questions[0].source).toBe('real');
    expect(out.questions[0].sourceRef?.org).toBe('某厂');
  });

  it('每种来源都有中文标签 —— 用户必须知道题目从哪来', () => {
    for (const k of Object.keys(QUESTION_SOURCE_LABEL)) {
      expect(QUESTION_SOURCE_LABEL[k as keyof typeof QUESTION_SOURCE_LABEL].length).toBeGreaterThan(2);
    }
  });

  it('压力题排在最后 —— 一上来就问「你错了怎么办」会让人当场乱掉', () => {
    const out = generateMockQuestions({
      profile,
      job,
      includePressure: true,
      maxQuestions: 5,
    });
    const kinds = out.questions.map((q) => q.kind);
    if (kinds.includes('pressure')) {
      expect(kinds.indexOf('pressure')).toBeGreaterThan(0);
      expect(kinds[kinds.length - 1]).toBe('pressure');
    }
  });

  it('轮次从 1 开始连续编号', () => {
    const out = generateMockQuestions({ profile, job, includePressure: true, includeGap: true, maxQuestions: 6 });
    expect(out.questions.map((q) => q.round)).toEqual(out.questions.map((_, i) => i + 1));
  });

  it('题量上限被强制约束（题太多会让人放弃）', () => {
    const out = generateMockQuestions({ profile, job, includePressure: true, maxQuestions: 99 });
    expect(out.questions.length).toBeLessThanOrEqual(8);
  });

  it('岗位要求里没有 Redis 时，期望点用关键词而不是整句 —— 整句当判据会永远判成没答到', () => {
    const out = generateMockQuestions({ profile, job, maxQuestions: 1 });
    const q = out.questions.find((x) => x.source === 'requirement');
    expect(q).toBeDefined();
    for (const p of q!.expectedPoints) {
      expect(p.length).toBeLessThanOrEqual(20);
    }
  });

  it('指定领域时出「原理 / 场景 / 边界」三种角度，不重复同类型', () => {
    const out = generateMockQuestions({ profile, domains: ['Redis'], maxQuestions: 3 });
    const kinds = out.questions.map((q) => q.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('出题说明要讲清「凭什么选这些题」', () => {
    const out = generateMockQuestions({ profile, job, realQuestions: '为什么想加入我们', maxQuestions: 2 });
    expect(out.rationale.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// 2. 五维分析（interview.analyze_answer）
// ---------------------------------------------------------------------------

const q = (partial: Partial<MockQuestion>): MockQuestion => ({
  id: 'q1',
  round: 1,
  source: 'requirement',
  kind: 'scenario',
  text: '你在实际工作里是怎么用 Redis 做缓存的？',
  intent: '',
  expectedPoints: ['Redis', '缓存'],
  evidenceIds: [],
  ...partial,
});

describe('模拟面试 · 五维分析', () => {
  it('五个维度都有结论', () => {
    const a = analyzeAnswer({
      question: q({}),
      answer: { questionId: 'q1', text: '首先我用 Redis 做缓存，因为读多写少。', channel: 'text' },
    });
    expect(a.findings.length).toBe(5);
    for (const f of a.findings) {
      expect(ANSWER_DIMENSION_LABEL[f.dimension]).toBeTruthy();
      expect(DIMENSION_VERDICT_LABEL[f.verdict]).toBeTruthy();
    }
  });

  it('维度顺序固定：先说「是否答到点」—— 那是用户最想知道的', () => {
    const a = analyzeAnswer({
      question: q({}),
      answer: { questionId: 'q1', text: '因为读多写少所以用缓存。', channel: 'text' },
    });
    expect(a.findings[0].dimension).toBe('on_point');
  });

  it('答到期望点 → hitPoint 为 yes；完全没提 → no', () => {
    const yes = analyzeAnswer({
      question: q({}),
      answer: { questionId: 'q1', text: '我用 Redis 承载缓存，读多写少。', channel: 'text' },
    });
    const no = analyzeAnswer({
      question: q({}),
      answer: { questionId: 'q1', text: '这个我们用了很多技术方案。', channel: 'text' },
    });
    expect(yes.hitPoint).toBe('yes');
    expect(no.hitPoint).toBe('no');
  });

  it('只引用作答原文，不给改写后的说法', () => {
    const a = analyzeAnswer({
      question: q({}),
      answer: {
        questionId: 'q1',
        text: '首先我用 Redis 做缓存，因为读多写少，减少数据库压力。',
        channel: 'text',
      },
    });
    for (const f of a.findings) {
      if (f.quotedFromAnswer) {
        // 引文必须真的出现在作答里
        expect(
          f.quotedFromAnswer.length === 0 ||
            '首先我用 Redis 做缓存，因为读多写少，减少数据库压力。'.includes(f.quotedFromAnswer.slice(0, 6)),
        ).toBe(true);
      }
    }
  });

  it('过度展开会被判为 restraint = missing（太长同样是问题）', () => {
    const long = '啊'.repeat(2000);
    const a = analyzeAnswer({
      question: q({ expectedPoints: ['Redis'] }),
      answer: { questionId: 'q1', text: `Redis 缓存。${long}`, channel: 'text' },
    });
    const restraint = a.findings.find((f) => f.dimension === 'restraint')!;
    expect(restraint.verdict).toBe('missing');
  });

  it('回答很短 → completeness 与 structure 都判 missing，并说清缺什么', () => {
    const a = analyzeAnswer({
      question: q({ expectedPoints: [] }),
      answer: { questionId: 'q1', text: '用过。', channel: 'text' },
    });
    const comp = a.findings.find((f) => f.dimension === 'completeness')!;
    const st = a.findings.find((f) => f.dimension === 'structure')!;
    expect(comp.verdict).toBe('missing');
    expect(st.verdict).toBe('missing');
    expect(comp.gap).toBeTruthy();
  });

  it('缺期望点时，追问建议要针对薄弱处而不是泛泛而谈', () => {
    const a = analyzeAnswer({
      question: q({ expectedPoints: ['Redis', '缓存淘汰策略'] }),
      answer: { questionId: 'q1', text: '用了 Redis。', channel: 'text' },
    });
    expect(a.likelyFollowUps.length).toBeGreaterThan(0);
    expect(a.likelyFollowUps.some((f) => f.includes('缓存淘汰策略'))).toBe(true);
  });

  it('本题：全流程产物里不含任何「你可以这样回答」类话术', () => {
    const out = generateMockQuestions({ profile, job, includePressure: true, maxQuestions: 4 });
    const blob = JSON.stringify(out);
    for (const banned of ['你可以这样回答', '参考话术', '照着说', '建议这样说', '标准答案']) {
      expect(blob).not.toContain(banned);
    }
    const a = analyzeAnswer({
      question: out.questions[0] ?? q({}),
      answer: { questionId: 'q1', text: '因为读多写少所以用 Redis 做缓存。', channel: 'text' },
    });
    const analysisBlob = JSON.stringify(a);
    for (const banned of ['你可以这样回答', '参考话术', '照着说', '标准答案']) {
      expect(analysisBlob).not.toContain(banned);
    }
    // 免责声明必须存在，且说明「为什么不给答案」
    expect(MOCK_DISCLAIMER).toContain('不生成可以照读的答案');
  });

  it('命中档案证据时要标出来（用户知道自己哪一段是真的）', () => {
    const p = {
      ...profile,
      evidence: [
        ev({
          id: 'evd_9',
          title: '接口缓存改造',
          content: '用 Redis 承载接口缓存，把详情接口的响应时间从 800ms 降到 90ms',
        }),
      ],
    } as unknown as CandidateProfile;
    const a = analyzeAnswer({
      question: q({ expectedPoints: [] }),
      answer: {
        questionId: 'q1',
        text: '我用 Redis 承载接口缓存，详情接口的响应时间从 800ms 降到 90ms。',
        channel: 'text',
      },
      profile: p,
    });
    expect(a.usedEvidence).toBe(true);
    expect(a.evidenceQuotes.length).toBeGreaterThan(0);
    expect(a.evidenceQuotes[0].source).toBe('接口缓存改造');
  });
});

// ---------------------------------------------------------------------------
// 3. 会话推进
// ---------------------------------------------------------------------------

describe('模拟面试 · 会话', () => {
  it('nextQuestionOf 按轮次顺序推进，不跳题', () => {
    const s = newMockSession({ maxQuestions: 3 });
    const qs: MockQuestion[] = [
      q({ id: 'q1', round: 1 }),
      q({ id: 'q2', round: 2 }),
      q({ id: 'q3', round: 3 }),
    ];
    s.questions = qs;
    expect(nextQuestionOf(s)?.id).toBe('q1');
    s.answers.push({ questionId: 'q1', text: 'a', channel: 'text' });
    expect(nextQuestionOf(s)?.id).toBe('q2');
    s.answers.push({ questionId: 'q2', text: 'b', channel: 'text' });
    expect(nextQuestionOf(s)?.id).toBe('q3');
    s.answers.push({ questionId: 'q3', text: 'c', channel: 'text' });
    expect(nextQuestionOf(s)).toBeUndefined();
  });

  it('统计只给离散结论，不给百分比', () => {
    const s = newMockSession({ maxQuestions: 3 });
    s.questions = [q({ id: 'q1', round: 1 }), q({ id: 'q2', round: 2 }), q({ id: 'q3', round: 3 })];
    s.answers = [
      { questionId: 'q1', text: 'Redis 缓存', channel: 'text' },
      { questionId: 'q2', text: 'Redis', channel: 'text' },
      { questionId: 'q3', text: '嗯', channel: 'text' },
    ];
    const st = computeMockStats(s);
    expect(['all', 'most', 'few', 'none']).toContain(st.hitRate);
    expect(['good', 'fair', 'poor']).toContain(st.dimensionHealth);
    expect(JSON.stringify(st)).not.toMatch(/\d+\s*%/);
  });

  it('未答完就结束 → status 为 abandoned（不假装完成）', () => {
    const s = newMockSession({ maxQuestions: 3 });
    s.questions = [q({ id: 'q1', round: 1 }), q({ id: 'q2', round: 2 })];
    s.answers = [{ questionId: 'q1', text: 'x', channel: 'text' }];
    expect(finishMockSession(s).status).toBe('abandoned');
  });

  it('答完即 finished', () => {
    const s = newMockSession({ maxQuestions: 1 });
    s.questions = [q({ id: 'q1', round: 1 })];
    s.answers = [{ questionId: 'q1', text: 'x', channel: 'text' }];
    expect(finishMockSession(s).status).toBe('finished');
  });
});

// ---------------------------------------------------------------------------
// 4. 薄弱点回流（interview.weak_point_training）
// ---------------------------------------------------------------------------

describe('模拟面试 · 薄弱点回流', () => {
  it('知识类问题算能力薄弱，表达类不算 —— 后者练几次就能改，混进能力库会污染它', () => {
    const s = newMockSession({ maxQuestions: 2 });
    s.questions = [q({ id: 'q1', round: 1 }), q({ id: 'q2', round: 2 })];
    s.answers = [
      { questionId: 'q1', text: '嗯。', channel: 'text' },
      { questionId: 'q2', text: '嗯。', channel: 'text' },
    ];
    s.analyses = [
      analyzeAnswer({ question: s.questions[0], answer: s.answers[0] }),
      analyzeAnswer({ question: s.questions[1], answer: s.answers[1] }),
    ];
    const out = collectWeaknesses(s);
    expect(out.length).toBeGreaterThan(0);
    for (const w of out) {
      // 表达类（结构 / 过度展开）不应出现
      expect(w.gap).not.toContain('结构是否清楚');
      expect(w.gap).not.toContain('是否过度展开');
    }
    // 至少要有一条是知识正确性
    expect(out.some((w) => w.gap.includes('知识是否正确'))).toBe(true);
  });

  it('回流建议只给三个动作，不给等级建议', () => {
    const s = newMockSession({ maxQuestions: 1 });
    s.questions = [q({ id: 'q1', round: 1 })];
    s.answers = [{ questionId: 'q1', text: '嗯。', channel: 'text' }];
    s.analyses = [analyzeAnswer({ question: s.questions[0], answer: s.answers[0] })];
    const ws = collectWeaknesses(s);
    const sugg = buildWeakeningSuggestions({ profile, weaknesses: ws });
    expect(sugg.length).toBe(ws.length);
    for (const s2 of sugg) {
      expect(WEAKENING_ACTION_LABEL[s2.action]).toBeTruthy();
      expect(s2.why.length).toBeGreaterThan(5);
      // 不出现等级词汇 —— 等级回答的是「岗位要什么」，与「这个人缺什么」坐标系不同
      expect(s2.why).not.toContain('L3');
      expect(s2.why).not.toContain('升级');
    }
  });

  it('等级调整取「现场暴露的更严重一侧」—— 宁可低估', () => {
    // 现场完全没提到 → 降一档
    expect(resolveMockLevel('delivered', { gap: '', severity: 'gap', fromQuestionIds: [], evidenceQuotes: [] }))
      .toBe('applied');
    // 只判部分到位 → 不降
    expect(
      resolveMockLevel('delivered', { gap: '', severity: 'lacking_evidence', fromQuestionIds: [], evidenceQuotes: [] }),
    ).toBe('delivered');
    // 没暴露问题 → 不动
    expect(resolveMockLevel('delivered', undefined)).toBe('delivered');
    // 档案里没有该技能 → unverified
    expect(resolveMockLevel(undefined, undefined)).toBe('unverified');
    // 已经是最低档时不再往下
    expect(resolveMockLevel('unverified', { gap: '', severity: 'gap', fromQuestionIds: [], evidenceQuotes: [] }))
      .toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// 5. 能力开关
// ---------------------------------------------------------------------------

describe('v0.4 模拟面试四项能力', () => {
  it('已解锁 —— 实装完成后 CURRENT_RELEASE 提到了 v0.4', async () => {
    const { isEnabled, CURRENT_RELEASE } = await import('@aijob/core');
    expect(CURRENT_RELEASE).toBe('v0.4');
    for (const id of ['interview.generate', 'interview.mock', 'interview.analyze_answer', 'interview.weak_point_training']) {
      expect(isEnabled(id)).toBe(true);
    }
  });

  it('解锁没有连带打开铁律', async () => {
    const { isEnabled } = await import('@aijob/core');
    // 这次提到 v0.4 之所以安全，是因为 v0.3 与 v0.4 两批都已实装完；
    // 如果当时只做完 v0.4 就提版本，就会连带解锁 v0.3 的四个空壳。
    expect(isEnabled('restrict.auto_resume_rewrite')).toBe(false);
    expect(isEnabled('restrict.full_interview_system')).toBe(false);
    expect(isEnabled('restrict.mobile_client')).toBe(false);
  });
});