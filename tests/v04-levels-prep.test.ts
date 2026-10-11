import { describe, expect, it } from 'vitest';
import {
  ANSWER_BLUEPRINTS,
  ANSWER_DISCLAIMER,
  CAPABILITY_LEVELS,
  CAPABILITY_LEVEL_ORDER,
  ASSESSMENT_TO_LEVEL,
  CURRENT_RELEASE,
  SKILL_TO_LEVEL,
  STRENGTH_TO_LEVEL,
  classifyQuestion,
  isEnabled,
  levelRank,
  levelReference,
  prepareQuestions,
  resolveCapabilityLevel,
  splitQuestions,
  weakerLevel,
  type CandidateEvidence,
  type CandidateProfile,
} from '@aijob/core';

/**
 * v0.4 三项新功能的规则测试。
 *
 * 本批改的东西里有两条是**产品立场**而不是判断规则，
 * 所以必须写成断言而不是靠代码评审：
 *   1. 五套等级刻度收敛到一条主线，且精确/大致必须区分；
 *   2. 面试问答**不生成可直接照抄的答案** —— 这条一旦破了，
 *      用户会去背它，而背下来的答案在追问下必然崩掉。
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

// ---------------------------------------------------------------------------
// 1. 等级收敛
// ---------------------------------------------------------------------------

describe('能力层级 · 五套刻度收敛到一条主线', () => {
  it('主线只有四级，且顺序从高到低', () => {
    expect(CAPABILITY_LEVEL_ORDER).toEqual(['L4', 'L3', 'L2', 'L1']);
    expect(CAPABILITY_LEVELS.L4.short).toBe('交付');
    expect(CAPABILITY_LEVELS.L1.short).toBe('待验证');
  });

  it('每一级都写清「怎么升上去」—— 这是比档位名更有用的信息', () => {
    for (const id of CAPABILITY_LEVEL_ORDER) {
      const def = CAPABILITY_LEVELS[id];
      expect(def.criteria.length).toBeGreaterThan(5);
      expect(def.toNext.length).toBeGreaterThan(5);
    }
    // 只有 L4 之外的三级可以写进简历；L4 是「已经是最高级」
    expect(CAPABILITY_LEVELS.L1.canWriteInResume).toBe(false);
    expect(CAPABILITY_LEVELS.L2.canWriteInResume).toBe(false);
    expect(CAPABILITY_LEVELS.L3.canWriteInResume).toBe(true);
  });

  it('四级是可比的，levelRank 能排序，weakerLevel 取低', () => {
    expect(levelRank('L4')).toBeGreaterThan(levelRank('L3'));
    expect(levelRank('L3')).toBeGreaterThan(levelRank('L2'));
    expect(levelRank('L2')).toBeGreaterThan(levelRank('L1'));
    expect(weakerLevel('L4', 'L2')).toBe('L2');
    expect(weakerLevel('L1', 'L3')).toBe('L1');
  });

  it('证据强度的映射全部是精确对应', () => {
    for (const key of ['strong', 'medium', 'weak', 'none'] as const) {
      expect(STRENGTH_TO_LEVEL[key].exact).toBe(true);
    }
  });

  /**
   * 这条是本文件最重要的断言之一：
   * 匹配结论看起来像在讲能力，但它衡量的是「岗位的某一条要求」，
   * 而且会被硬门槛左右（学历不满足就是 gap，与会不会那个技能无关）。
   * 把它们标成「精确对应」就是在骗用户。
   */
  it('匹配结论的映射全部标为「大致对应」，且必须说明差异来源', () => {
    for (const key of ['matched', 'partial', 'lacking_evidence', 'gap', 'unknown'] as const) {
      expect(ASSESSMENT_TO_LEVEL[key].exact).toBe(false);
      expect(ASSESSMENT_TO_LEVEL[key].note).toBeTruthy();
    }
  });

  it('问诊等级：中间两档必须标为大致对应（判定口径不同）', () => {
    expect(SKILL_TO_LEVEL.delivered.exact).toBe(true);
    expect(SKILL_TO_LEVEL.applied.exact).toBe(true);
    expect(SKILL_TO_LEVEL.practiced.exact).toBe(false);
    expect(SKILL_TO_LEVEL.aware.exact).toBe(false);
    expect(SKILL_TO_LEVEL.unverified.exact).toBe(true);
  });

  it('对照表覆盖全部五套刻度，每套都给出「它在回答什么」', () => {
    const ref = levelReference();
    // 主线 + 四套侧面
    expect(ref.groups).toHaveLength(5);
    for (const g of ref.groups) {
      expect(g.what.length).toBeGreaterThan(5);
      expect(g.rows.length).toBeGreaterThan(0);
      for (const row of g.rows) {
        expect(CAPABILITY_LEVELS[row.to]).toBeTruthy();
      }
    }
  });

  it('最终层级取「证据」与「问诊」的较低者 —— 宁可低估', () => {
    // 证据强但问诊只到 L2 → 取 L2
    expect(resolveCapabilityLevel('strong', 'practiced').level).toBe('L2');
    // 证据只有 weak 但问诊说 delivered → 取 L2（weak 对应 L2）
    expect(resolveCapabilityLevel('weak', 'delivered').level).toBe('L2');
    // 没有证据也没问过 → L1
    expect(resolveCapabilityLevel('none', null).level).toBe('L1');
    // 两者都在 L4 → L4
    expect(resolveCapabilityLevel('strong', 'delivered').level).toBe('L4');
  });

  it('最终层级必须给出「为什么」，不能只给结论', () => {
    const r = resolveCapabilityLevel('strong', 'practiced');
    expect(r.why).toContain('问诊');
    expect(r.why.length).toBeGreaterThan(8);
  });
});

// ---------------------------------------------------------------------------
// 2. 问诊零打字
// ---------------------------------------------------------------------------

describe('问诊 · 每题都自带预置选项', () => {
  const CASES: Array<{ skill: string; name: string }> = [
    { skill: 'Python', name: '技术能力' },
    { skill: '沟通表达', name: '行为能力' },
    { skill: '学历：本科及以上', name: '资质能力' },
    { skill: '电商业务', name: '领域知识' },
  ];

  for (const { skill, name } of CASES) {
    it(`${name}：除了自评题以外，每道题都有可点选的选项`, async () => {
      const { buildQuestions } = await import('@aijob/core');
      const questions = buildQuestions(skill);
      const textQuestions = questions.filter((q) => q.kind === 'text');
      expect(textQuestions.length).toBeGreaterThan(0);
      for (const q of textQuestions) {
        expect(q.quickChoices, `${skill} 的「${q.layer}」题缺少 quickChoices`).toBeTruthy();
        expect(q.quickChoices!.length).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('每道题都必须有「都不像，我自己写」的兜底项', async () => {
    const { buildQuestions } = await import('@aijob/core');
    for (const { skill } of CASES) {
      for (const q of buildQuestions(skill)) {
        if (!q.quickChoices) continue;
        const hasEscape = q.quickChoices.some((c) => c.needsDetail === true);
        // 强制用户从几个都不对的选项里挑一个，会往档案里写进假信息
        expect(hasEscape, `${skill} 的「${q.layer}」题缺少兜底项`).toBe(true);
      }
    }
  });

  it('预置选项不得替用户编造具体经历', async () => {
    const { buildQuestions } = await import('@aijob/core');
    for (const { skill } of CASES) {
      for (const q of buildQuestions(skill)) {
        for (const c of q.quickChoices ?? []) {
          // 具体结果指标（项目里的量级描述是允许的，结果数据不是）
          expect(c.label, `${skill} / ${q.layer} 出现了结果指标：${c.label}`).not.toMatch(/\d+\s*%/);
          // 具体的公司/项目名。这里用「科技/集团/有限」这种强信号词，
          // 不能用「公司」—— 「只在一家公司工作过」是通用量词，不是编造。
          expect(c.label, `${skill} / ${q.layer} 出现了疑似具体公司名：${c.label}`).not.toMatch(
            /(科技|集团|股份|有限|Inc|Ltd|Corp)/,
          );
        }
      }
    }
  });

  it('「兜底项」必须显式标记 isEscape，界面行为才不靠猜', async () => {
    const { buildQuestions } = await import('@aijob/core');
    for (const { skill } of CASES) {
      for (const q of buildQuestions(skill)) {
        if (!q.quickChoices) continue;
        const escape = q.quickChoices.find((c) => c.isEscape === true);
        expect(escape, `${skill} / ${q.layer} 没有 isEscape 兜底项`).toBeTruthy();
        expect(escape!.needsDetail).toBe(true);
        expect(escape!.label).toMatch(/自己写|都不像/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 面试官问答推荐
// ---------------------------------------------------------------------------

describe('面试问答推荐', () => {
  it('能把一整段复制来的问题拆成多条', () => {
    const raw = [
      '1. 介绍一下你自己',
      '2. 为什么想加入我们？',
      '3. 讲一个你解决过的最难的技术问题',
    ].join('\n');
    expect(splitQuestions(raw)).toHaveLength(3);
  });

  it('拆分会去掉编号前缀与过短的残句', () => {
    expect(splitQuestions('1. 为什么想加入我们')[0]).toBe('为什么想加入我们');
    expect(splitQuestions('嗯\n啊\n好的')).toHaveLength(0);
  });

  it('八类问题各有各的答法结构，且结构里不含任何台词', () => {
    const kinds = [
      'behavioral',
      'technical',
      'motivation',
      'situation',
      'collaboration',
      'future',
      'pressure',
      'fit',
    ] as const;
    for (const k of kinds) {
      const bp = ANSWER_BLUEPRINTS[k];
      expect(bp.mustCover.length).toBeGreaterThanOrEqual(2);
      expect(bp.pitfall.length).toBeGreaterThan(8);
      expect(bp.followUpLikely.length).toBeGreaterThan(4);
      // 绝不能出现「你可以这样回答」这类可直接照抄的东西
      const all = [...bp.mustCover, bp.pitfall, bp.followUpLikely].join(' ');
      expect(all).not.toMatch(/你可以这样(说|答)|参考话术|示例答案|照着说/);
    }
  });

  it('分类：技术问题优先判为 technical，不被动机规则抢走', () => {
    // 「为什么用 Redis 做缓存」既像技术又像动机 —— 纯技术词优先
    expect(classifyQuestion('为什么用 Redis 做缓存')).toBe('technical');
    expect(classifyQuestion('这个架构的原理是什么')).toBe('technical');
    // 动机类必须命中 motivation，不能落进 behavioral 兜底
    // （答偏了用户发现不了：「为什么想加入我们」给一段「讲一件事」的答法是完全跑偏的）
    expect(classifyQuestion('为什么想加入我们')).toBe('motivation');
    expect(classifyQuestion('讲一个你搞砸过的项目')).toBe('pressure');
    expect(classifyQuestion('期望薪资是多少')).toBe('situation');
    expect(classifyQuestion('跟同事意见不一致怎么处理')).toBe('collaboration');
    expect(classifyQuestion('你未来三到五年的规划')).toBe('future');
  });

  it('免责声明必须在数据里，且明确否定「这是答案」', () => {
    expect(ANSWER_DISCLAIMER.headline).toContain('结构');
    // headline 本身就是否定句式：给结构、不是答案
    expect(ANSWER_DISCLAIMER.headline).toMatch(/不是|而非/);
    expect(ANSWER_DISCLAIMER.points.length).toBeGreaterThanOrEqual(4);
    // 至少一条要写明「不预测面试结果」
    expect(ANSWER_DISCLAIMER.points.join(' ')).toContain('不预测');
    // 至少一条要写明「不会替你生成答案」
    expect(ANSWER_DISCLAIMER.points.join(' ')).toContain('不会替你生成');
  });

  it('无模型也能用：本地规则给出结构与档案对接情况', async () => {
    const profile = {
      ...({} as CandidateProfile),
      id: 'p1',
      skills: [],
      evidence: [
        ev({
          id: 'evd_1',
          title: '支付网关对接',
          content: '负责对接第三方渠道，协调了两次接口联调上线。',
          skills: ['沟通表达'],
        }),
      ],
    } as unknown as CandidateProfile;

    const out = await prepareQuestions({
      profile,
      raw: '讲一次你和别人意见不一致，你怎么处理的\n你的三年规划是什么',
      gateway: null,
    });
    expect(out.items).toHaveLength(2);
    expect(out.engine).toBe('rule');
    for (const item of out.items) {
      expect(item.blueprint.mustCover.length).toBeGreaterThan(0);
      // 任何一条 advice 都不得是可直接照抄的答案
      expect(item.advice).not.toMatch(/你可以这样(说|答)|参考话术|照着说/);
    }
  });

  it('档案里没有材料时必须如实说「没有」，不能编一段鼓励话', async () => {
    const out = await prepareQuestions({
      profile: { skills: [], evidence: [] } as unknown as CandidateProfile,
      raw: '讲一个你做过的最复杂的分布式系统',
      gateway: null,
    });
    const item = out.items[0];
    expect(item.coverage.hasEvidence).toBe(false);
    expect(item.citable).toHaveLength(0);
    // 提醒应当指向「承认没做过 + 说清怎么上手」，而不是「你可以这样回答」
    expect(item.advice).toContain('承认没做过');
  });

  it('空输入返回明确提示而不是空数组', async () => {
    const out = await prepareQuestions({ profile: null, raw: '   ', gateway: null });
    expect(out.items).toHaveLength(0);
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it('可引用材料只给原文，不给改写后的说法', async () => {
    const profile = {
      skills: [],
      evidence: [
        ev({
          id: 'evd_1',
          title: '支付网关对接',
          content: '负责对接第三方渠道，协调了两次接口联调。',
          skills: ['沟通表达'],
        }),
      ],
    } as unknown as CandidateProfile;

    const out = await prepareQuestions({
      profile,
      raw: '讲一次你跟别人意见不一致时怎么处理的',
      gateway: null,
    });
    const citable = out.items[0].citable;
    if (citable.length > 0) {
      // excerpt 必须是原文的一部分，不能是系统重新组织的句子
      expect(citable[0].excerpt.length).toBeGreaterThan(0);
      expect(profile.evidence.some((e) => e.content.includes(citable[0].excerpt.slice(0, 10)))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 能力开关
// ---------------------------------------------------------------------------

describe('v0.4 能力开关', () => {
  it('三项新能力在当前版本已启用', () => {
    for (const id of ['interview.quick_choice', 'interview.prep', 'ui.level_hierarchy']) {
      expect(isEnabled(id)).toBe(true);
    }
  });

  it('v0.3 / v0.4 这批能力在当前版本确实已启用', () => {
    // 原断言是 `CURRENT_RELEASE === 'v0.2'` + 四项 assert false，
    // 目的是防止「为开修复项而抬版本、连带解锁空壳」。
    // 2026-10-08 两批都做完之后，那条代理指标就只会挡住正常的版本推进，
    // 所以换成「这些能力确实已启用」——意图不变，形式更新。
    //
    // v0.6 又往后走了两版（OCR + 证据闭环），这里跟着一起放宽到
    // 「已启用」而不是钉某个版本号 —— 钉版本号只会在下一版再次变红，
    // 而真正要防的是「解锁了却没实现」，那条由下一条断言负责。
    expect(isEnabled('report.export')).toBe(true);
    expect(isEnabled('resume.suggestion')).toBe(true);
    expect(isEnabled('match.minimum_candidate')).toBe(true);
    expect(CURRENT_RELEASE).toBe('v0.6');
  });

  it('铁律仍然没有被解锁', () => {
    expect(isEnabled('restrict.job_crawler')).toBe(false);
    expect(isEnabled('restrict.mobile_client')).toBe(false);
  });
});
