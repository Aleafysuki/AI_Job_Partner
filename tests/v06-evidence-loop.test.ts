import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_PREFERENCES,
  TRAINING_EVIDENCE_WHY,
  anchorIsReal,
  assessedSkillsFor,
  carryOverAnswers,
  evaluateAssessment,
  finalizeProfile,
  judgeTrainingAnswer,
  pendingSkillsFor,
  replanQuestions,
  summarizeAnswer,
  summaryToEvidence,
  type AssessSession,
  type CandidateEvidence,
  type CandidateProfile,
  type ReviewPreferences,
  type TrainingItem,
  type TrainingPlan,
} from '@aijob/core';

/**
 * v0.6「证据闭环」的规则测试
 * =========================
 *
 * 这一批改的不是新功能，而是**修一个假闭环**：
 * 用户填了问诊、练了训练，但两者都不进能力库，于是匹配结论永远不变，
 * 而界面上却写着「练完去重跑匹配」。用户照做，发现什么都没变 ——
 * 于是观感变成「我填的东西不算数，要我重填」。
 *
 * 所以下面每条断言都对应一个「用户会遇到的坑」，而不是一个函数：
 *   1. 换题不清空已答的
 *   2. AI 整理的每一条都能点回原话
 *   3. 模型编的内容会被丢掉，且明说丢了
 *   4. 同一个技能反复问诊不会攒出一堆重复证据
 *   5. 已问诊过的技能不再出现在待办里
 *   6. 训练补的证据强度封顶「中」，永远到不了「强」
 *   7. 重新生成训练计划时用户写过的答案还在
 *   8. 判定对「太短 / 只复述概念 / 有场景有数字」三档给出不同结果
 */

// ---------------------------------------------------------------------------
// 造数据的工具
// ---------------------------------------------------------------------------

const NOW = '2026-06-01T00:00:00.000Z';

const ev = (partial: Partial<CandidateEvidence>): CandidateEvidence => ({
  id: 'evd_x',
  kind: 'project',
  title: '',
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
  createdAt: NOW,
  updatedAt: NOW,
  ...partial,
});

function profileOf(partial: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    id: 'p1',
    name: '我的档案',
    createdAt: NOW,
    updatedAt: NOW,
    skills: [],
    evidence: [],
    projects: [],
    experiences: [],
    education: [],
    assessments: [],
    rawSections: {},
    privacyLog: [],
    ...partial,
  } as unknown as CandidateProfile;
}

/** 一个「问过 Redis、结论有效」的档案 */
function assessedProfile(): CandidateProfile {
  return profileOf({
    skills: [
      {
        id: 's1',
        name: 'Redis',
        kind: 'hard',
        level: 'familiar',
        evidenceIds: [],
        source: 'resume',
        confidence: 'low',
      },
    ] as never,
    assessments: [
      {
        id: 'a1',
        skillName: 'Redis',
        level: 'applied',
        confidence: 'medium',
        summary: '在电商项目里用过 Redis 做缓存。',
        signals: { specificity: 2, depth: 1, output: 0, selfAwareness: 1, selfReportAsked: true },
        recommendedAction: '补一个可核对的载体。',
        strengths: [],
        gaps: [],
        uncertainties: [],
        producedEvidenceIds: [],
        engine: 'rule',
        jobTitle: '后端工程师',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ] as never,
  });
}

const job = {
  id: 'j1',
  profileId: 'p1',
  jobTitle: '后端工程师',
  rawText: '要求熟悉 Redis',
  items: [
    {
      id: 'r1',
      type: 'hard',
      text: '熟悉 Redis',
      keywords: ['Redis'],
      importance: 'high',
      source: 'text',
      original: '熟悉 Redis',
    },
  ],
} as never;

/** 造一场已经答了两题的会话（第五题留给换题用） */
function answeredSession(): AssessSession {
  return {
    id: 'assess_1',
    profileId: 'p1',
    skillName: 'Redis',
    jobTitle: '后端工程师',
    questions: [
      {
        id: 'q1',
        skillName: 'Redis',
        layer: 'fact',
        kind: 'text',
        prompt: '在哪个项目里用过 Redis？',
      },
      {
        id: 'q2',
        skillName: 'Redis',
        layer: 'depth',
        kind: 'text',
        prompt: '你怎么处理缓存失效？',
      },
      {
        id: 'q3',
        skillName: 'Redis',
        layer: 'output',
        kind: 'text',
        prompt: '有没有可核对的结果？',
      },
      {
        id: 'q4',
        skillName: 'Redis',
        layer: 'boundary',
        kind: 'text',
        prompt: '哪些是你不确定的？',
      },
    ],
    answers: [
      {
        questionId: 'q1',
        layer: 'fact',
        text: '在电商的商品详情页里用它扛读流量。',
        answeredAt: NOW,
      },
      {
        questionId: 'q2',
        layer: 'depth',
        text: '因为热点 key 会打穿缓存，所以加了随机过期时间打散。',
        answeredAt: NOW,
      },
    ],
    status: 'questioning',
    startedAt: NOW,
  };
}

const item = (partial: Partial<TrainingItem>): TrainingItem => ({
  id: 't1',
  type: 'evidence',
  skillName: 'Redis',
  skillCategory: '后端',
  weakness: 'evidence',
  importance: 'high',
  question: '讲一次你用 Redis 解决线上问题的经历。',
  referencePoints: ['缓存失效策略', '命中率'],
  userAnswer: undefined,
  status: 'todo',
  createdAt: NOW,
  updatedAt: NOW,
  ...partial,
} as TrainingItem);

function planOf(items: TrainingItem[]): TrainingPlan {
  return {
    id: 'plan1',
    schemaVersion: 1,
    profileId: 'p1',
    jobId: 'j1',
    jobTitle: '后端工程师',
    createdAt: NOW,
    updatedAt: NOW,
    items,
    stats: { total: items.length, todo: 0, answered: 0, reviewed: 0, passed: 0, parked: 0, averageScore: null },
    source: { evidence: 1, correctness: 0, on_point: 0, completeness: 0, depth: 0, structure: 0 } as never,
    engine: 'rule',
    suggestedNextStep: '',
  } as TrainingPlan;
}

// ---------------------------------------------------------------------------
// 1. 换一套问题不能清空已答的
// ---------------------------------------------------------------------------

describe('v0.6 · 换题保留已答', () => {
  it('点「换一套问题」之后 session.answers 一条不少', () => {
    const session = answeredSession();
    expect(session.answers).toHaveLength(2);

    const next = replanQuestions(session, { profile: assessedProfile() });
    expect(next).not.toBeNull();

    // 已答的答案逐条保留，连顺序都不变
    expect(next!.answers.map((a) => a.questionId)).toEqual(['q1', 'q2']);
    expect(next!.answers.map((a) => a.text)).toEqual(session.answers.map((a) => a.text));

    // 已答的题留在 questions 里（评估时要看到完整问答对），
    // 但 nextQuestion 会跳过它们 —— 用户不会被要求回答第二遍
    const stillPending = next!.questions.filter((q) => next!.answers.some((a) => a.questionId === q.id));
    expect(stillPending.length).toBe(2);

    // 换掉的题有留痕，界面上能说清「这道你已经答过了」
    expect(next!.replacedQuestions ?? []).not.toHaveLength(0);
  });

  it('全部答完之后换题要明确说「换不了」，不能悄悄返回一个空会话', () => {
    const session = answeredSession();
    const done: AssessSession = {
      ...session,
      answers: session.questions.map((q) => ({
        questionId: q.id,
        layer: q.layer,
        text: '答过了',
        answeredAt: NOW,
      })),
    };
    expect(replanQuestions(done, { profile: assessedProfile() })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. AI 整理必须能点回原话；编的内容要丢掉并明说
// ---------------------------------------------------------------------------

describe('v0.6 · AI 整理的每一条都要能点回原话', () => {
  const answers = [
    { layer: 'fact', text: '在电商的商品详情页里用它扛读流量。' },
    { layer: 'depth', text: '因为热点 key 会打穿缓存，所以加了随机过期时间打散。' },
  ];

  it('anchorIsReal：多打的空格仍算「说过」，改字或换标点则不算', () => {
    const source = '在电商的商品详情页里用它扛读流量。';
    expect(anchorIsReal('商品详情页', source)).toBe(true);
    expect(anchorIsReal('商 品 详情页', source)).toBe(true); // 去空白后仍是连续子串
    expect(anchorIsReal('详情页里用它扛读流量', source)).toBe(true);
    expect(anchorIsReal('购物车页面', source)).toBe(false); // 改字 = 用户没说过
    // 标点不宽容：宁可丢掉一条，也不放进一条用户点开发现字面不符的条目
    expect(anchorIsReal('商品详情页。', source)).toBe(false);
    expect(anchorIsReal('', source)).toBe(false);
  });

  it('规则版整理产出的每一个字段，anchor 都真的在原话里', async () => {
    const summary = await summarizeAnswer({ answers, skillName: 'Redis' });
    expect(summary.usable.length).toBeGreaterThan(0);
    for (const field of summary.usable) {
      expect(field.anchor.length).toBeGreaterThan(0);
      expect(anchorIsReal(field.anchor, answers.map((a) => a.text).join('\n'))).toBe(true);
    }
  });

  it('模型给的字段没有出处 → 丢掉，并把原因说给用户听', async () => {
    const fakeGateway = {
      active: true,
      runJson: async () => ({
        value: {
          // 一条有出处（合法），一条编造（无 anchor），一条改字（anchor 对不上）
          scenario: { value: '电商商品详情页扛读流量', anchor: '在电商的商品详情页里' },
          outcome: { value: '把响应时间压到 80 毫秒', anchor: '' },
          approach: { value: '做了热点 key 治理', anchor: '我在服务网格集群上做过' },
        },
        error: undefined,
        trace: null,
      }),
    } as never;

    const summary = await summarizeAnswer({ answers, skillName: 'Redis', gateway: fakeGateway });

    // 编数字的那条没有 anchor → 必须没有
    expect(summary.outcome).toBeNull();
    // anchor 对不上原话的那条 → 也必须没有
    expect(summary.approach).toBeNull();
    // 合法的那条留下
    expect(summary.scenario?.value).toBe('电商商品详情页扛读流量');

    // 丢弃必须留原因，且要在 dropped 里，用户才不会被悄悄减少内容
    expect(summary.dropped.some((d) => d.field === 'outcome')).toBe(true);
    expect(summary.dropped.some((d) => d.field === 'approach')).toBe(true);
    expect(summary.dropped.every((d) => d.reason.trim().length > 0)).toBe(true);
  });

  it('整理结果写进证据时，来源标为 qa（强度封顶中）且引用的是用户原话', () => {
    const summary = {
      headline: null,
      scenario: { value: '电商商品详情页扛读流量', anchor: '在电商的商品详情页里' },
      approach: { value: '随机过期时间打散热点', anchor: '加了随机过期时间打散' },
      outcome: null,
      dropped: [],
      usable: [
        { value: '电商商品详情页扛读流量', anchor: '在电商的商品详情页里' },
        { value: '随机过期时间打散热点', anchor: '加了随机过期时间打散' },
      ],
      engine: 'rule' as const,
      trace: null,
    };

    const e = summaryToEvidence({ skillName: 'Redis', jobTitle: '后端工程师', summary, newId: () => 'evd_new' });
    expect(e).not.toBeNull();
    expect(e!.origin).toBe('qa');
    expect(e!.skills).toEqual(['Redis']);
    // excerpt 引用用户确认过的 anchor，而不是模型的改写
    expect(e!.sourceRef.excerpt).toContain('在电商的商品详情页里');

    // 全部拒绝是合法结果：宁可不写，也不往档案里塞空内容
    const rejected = { ...summary, usable: summary.usable.map((f) => ({ ...f, rejected: true })) };
    expect(summaryToEvidence({ skillName: 'Redis', summary: rejected, newId: () => 'e2' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4 & 5. 反复问诊不产生重复证据；已问诊的不再进待办
// ---------------------------------------------------------------------------

describe('v0.6 · 反复问诊不产生重复证据', () => {
  it('同一个技能问三次，档案里的证据条数不增长', async () => {
    const session = answeredSession();
    let profile = profileOf({ evidence: [] });

    const sizes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const out = await evaluateAssessment({ session, profile, gateway: null });
      profile = out.updatedProfile;
      sizes.push(profile.evidence.length);
    }

    // 产出的证据条数全程不变（0 或 1），而不是 1/2/3
    expect(sizes[0]).toBeLessThanOrEqual(1);
    expect(sizes[1]).toBe(sizes[0]);
    expect(sizes[2]).toBe(sizes[0]);
  });

  it('问诊结论覆盖写入，但 before 快照留着上一次的等级', async () => {
    const first = await evaluateAssessment({ session: answeredSession(), profile: assessedProfile(), gateway: null });
    // 已问过 Redis 且结论有效 → before.existed 为 true，且拿到了旧等级
    expect(first.before.existed).toBe(true);
    expect(first.before.level).toBeTruthy();

    const second = await evaluateAssessment({
      session: answeredSession(),
      profile: first.updatedProfile,
      gateway: null,
    });
    // 第二次的 before 应该是第一次的结果，而不是「问过很多遍就没法比了」
    expect(second.before.existed).toBe(true);
  });
});

describe('v0.6 · 已问诊过的技能不再出现在待办列表', () => {
  const prefs: ReviewPreferences = DEFAULT_REVIEW_PREFERENCES;

  it('结论仍然有效的技能不出现在 pending 里，只出现在只读区', () => {
    const profile = assessedProfile();
    const pending = pendingSkillsFor(profile, job, { prefs, now: new Date(NOW) });
    const assessed = assessedSkillsFor(profile, job, { prefs, now: new Date(NOW) });

    // 之前这里的 assessed 只当排序权重，于是已问诊的技能照旧列在待办里
    expect(pending.map((p) => p.skillName)).not.toContain('Redis');
    expect(assessed.map((a) => a.skillName)).toContain('Redis');
  });

  it('用户标了「想重答」→ 回到待办列表，并显示上次等级与原因', () => {
    const profile = assessedProfile();
    const marks = [{ skillName: 'Redis', reason: '我觉得上次答得不准', createdAt: NOW }];

    const pending = pendingSkillsFor(profile, job, { prefs, marks, now: new Date(NOW) });
    const row = pending.find((p) => p.skillName === 'Redis');

    expect(row).toBeTruthy();
    expect(row!.state).toBe('stale');
    expect(row!.previousLevel).toBeTruthy();
    expect(row!.reason).toContain('上次答得不准');
  });

  it('「永不过时」策略下只有手动标记才让它回待办 —— 口径由设置决定', () => {
    const neverStale: ReviewPreferences = { ...DEFAULT_REVIEW_PREFERENCES, stalePolicy: 'never' };
    const profile = assessedProfile();
    // 没标 → 不进待办
    expect(
      pendingSkillsFor(profile, job, { prefs: neverStale, now: new Date(NOW) }).map((p) => p.skillName),
    ).not.toContain('Redis');
    // 标了 → 进待办（用户主动标记是最高优先级，任何策略下都算过时）
    expect(
      pendingSkillsFor(profile, job, {
        prefs: neverStale,
        marks: [{ skillName: 'Redis', reason: '想重答', createdAt: NOW }],
        now: new Date(NOW),
      }).map((p) => p.skillName),
    ).toContain('Redis');
  });
});

// ---------------------------------------------------------------------------
// 6. 训练补的证据永远到不了「强」
// ---------------------------------------------------------------------------

describe('v0.6 · 训练补的证据强度封顶「中」', () => {
  it('一段写得非常「硬」的自述，本地规则算出 strong，但封顶后只能是 medium', () => {
    const rich =
      '我在电商平台的商品详情服务里负责缓存层，因为热点 key 会打穿 Redis，所以做了本地缓存加随机过期时间，' +
      '上线后 P99 从 800ms 降到 120ms，命中率从 91% 到 98.6%，方案文档在内部 wiki，仓库可以公开。';

    // 先确认这段内容**本身**够硬：同一段话换成简历来源时就是 strong。
    // 不做这一步，断言「封顶成 medium」就变成了「本来就是 medium」，测不出封顶。
    const asResume = finalizeProfile(
      profileOf({
        evidence: [
          ev({
            id: 'evd_resume',
            origin: 'resume',
            skills: ['Redis'],
            content: rich,
            title: '商品详情缓存优化',
            metrics: ['P99 800ms → 120ms', '命中率 91% → 98.6%'],
            links: ['https://example.com/wiki/cache'],
            timeRange: '2025-03 ~ 2025-06',
            strength: 'weak',
          }),
        ],
      }),
    );
    expect(asResume.evidence[0].strength).toBe('strong');

    const asQa = finalizeProfile(
      profileOf({
        evidence: [
          ev({
            id: 'evd_train',
            origin: 'qa',
            skills: ['Redis'],
            content: rich,
            title: 'Redis · 训练补充',
            metrics: ['P99 800ms → 120ms', '命中率 91% → 98.6%'],
            links: ['https://example.com/wiki/cache'],
            timeRange: '2025-03 ~ 2025-06',
            strength: 'weak',
          }),
        ],
      }),
    );
    const hit = asQa.evidence.find((e) => e.id === 'evd_train')!;

    // 同样的内容、同样的载体，只是来源是自述 —— 强度必须掉到「中」
    expect(hit.origin).toBe('qa');
    expect(hit.strength).toBe('medium');
    // 文案要说清为什么到不了「强」，且不承诺「补上数字就能到强」
    expect(TRAINING_EVIDENCE_WHY).toContain('不等于');
  });
});

// ---------------------------------------------------------------------------
// 7. 重新生成训练计划时答案还在
// ---------------------------------------------------------------------------

describe('v0.6 · 重��生成训练计划不丢答案', () => {
  it('答案、达标时间、证据 id 都搬过去了', () => {
    const oldPlan = planOf([
      item({
        id: 'old_1',
        // 注意 id 是新分配的 —— 按 id 匹配一条都对不上，等于没搬
        userAnswer: '我在电商项目里用随机过期时间解决了热点 key 打穿的问题。',
        selfScore: 2,
        status: 'passed',
        passedAt: NOW,
        evidenceIds: ['evd_train'],
      }),
    ]);

    const fresh = planOf([item({ id: 'new_1', userAnswer: undefined, status: 'todo' })]);
    const merged = carryOverAnswers(fresh, oldPlan);

    expect(merged.items[0].userAnswer).toBe('我在电商项目里用随机过期时间解决了热点 key 打穿的问题。');
    expect(merged.items[0].evidenceIds).toEqual(['evd_train']);
    expect(merged.items[0].passedAt).toBe(NOW);
    expect(merged.items[0].status).toBe('passed');
    // 统计也要跟着重算，否则进度条显示 0
    expect(merged.stats.passed).toBe(1);
  });

  it('没写过的题不会被搬来一个空答案', () => {
    const oldPlan = planOf([item({ id: 'old_1' })]);
    const fresh = planOf([item({ id: 'new_1' })]);
    const merged = carryOverAnswers(fresh, oldPlan);
    expect(merged.items[0].userAnswer).toBeUndefined();
    expect(merged.items[0].status).toBe('todo');
  });
});

// ---------------------------------------------------------------------------
// 8. 判定引擎的三档结果
// ---------------------------------------------------------------------------

describe('v0.6 · 训练判定只看可核对的四件事', () => {
  const target = { skillName: 'Redis', referencePoints: ['随机过期', '命中率'], type: 'evidence' as const };

  it('太短 → too_short，且不追问（没东西可追）', () => {
    const j = judgeTrainingAnswer({ answer: '做过缓存优化。', item: target, followUpCount: 0 });
    expect(j.verdict).toBe('too_short');
    expect(j.hooks).toHaveLength(0);
  });

  it('只复述概念 → needs_work：场景/数字/要点三项缺失', () => {
    const j = judgeTrainingAnswer({
      answer: 'Redis 就是内存缓存。常见的失效策略有过期时间和惰性删除两种，用好了能提升响应速度。',
      item: target,
      followUpCount: 0,
    });
    expect(j.verdict).toBe('needs_work');
    const byKey = Object.fromEntries(j.reasons.map((r) => [r.key, r.ok]));
    // 复述概念正是这个形状：没有场景、没有数字、要点一个都没提到
    expect(byKey.scene).toBe(false);
    expect(byKey.output).toBe(false);
    expect(byKey.points).toBe(false);
  });

  it('有具体场景 + 因果 + 数字 + 覆盖要点 → passed', () => {
    const j = judgeTrainingAnswer({
      answer:
        '我在电商平台的商品详情服务里负责缓存层。线上出现热点 key 打穿 Redis 的问题，所以我改成随机过期时间，' +
        '并加了命中率监控。上线后命中率从 91% 提到 98%。',
      item: target,
      followUpCount: 0,
    });
    expect(j.verdict).toBe('passed');
    expect(j.reasons.every((r) => r.ok)).toBe(true);
    // 判定的结论不能越界成「这个岗位能投了」
    expect(j.headline).toContain('不能证明');
  });

  it('表达类问题（条理/长度）不参与判定 —— 判据只有四项', () => {
    const j = judgeTrainingAnswer({
      answer:
        '嗯……就是在那个项目里面吧，反正是做了缓存，然后就是加了一些随机过期时间，命中率也确实高了一些，大概 98% 左右吧。',
      item: { skillName: 'Redis', referencePoints: [], type: 'evidence' },
      followUpCount: 0,
    });
    // 判据里没有任何一项是「表达是否清晰」
    expect(j.reasons.map((r) => r.key).sort()).toEqual(['causal', 'output', 'scene']);
    expect(j.reasons.some((r) => r.key.includes('struct') || r.key.includes('length'))).toBe(false);
  });

  it('问过若干轮之后不再追问，并标记为 exhausted（用户可以「先放着」）', () => {
    const j = judgeTrainingAnswer({
      answer: '在电商项目里做的缓存。因为有热点 key，所以加了随机过期时间。命中率大概 98%。',
      // 要点里有一条「缓存失效策略」没提到 → 判定不过；已追问 3 轮 → 不再追
      item: { skillName: 'Redis', referencePoints: ['热点 key 持续时间'], type: 'evidence' },
      followUpCount: 3,
    });
    expect(j.verdict).toBe('needs_work');
    expect(j.hooks).toHaveLength(0);
    expect(j.exhausted).toBe(true);
  });
});