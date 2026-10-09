import { describe, expect, it } from 'vitest';
import {
  BEHAVIORAL_SCALE_OPTIONS,
  CAPABILITIES,
  CURRENT_RELEASE,
  MODEL_PRICING,
  SELF_REPORT_OPTIONS,
  askShapeOf,
  budgetAdvice,
  buildQuestions,
  buildTrainingPlan,
  costOf,
  createDefaultAiSettings,
  createEmptyProfile,
  estimateTokens,
  evaluateAssessment,
  isEnabled,
  localSpecsFor,
  mergeAiQuestions,
  planAssessmentSession,
  pricingFor,
  recordAnswer,
  seedsFromEvidence,
  startAssessment,
  summarizeUsage,
  topCostAdvice,
  type AiTrace,
  type CandidateEvidence,
  type CandidateProfile,
  type RequirementMatch,
} from '@aijob/core';

/**
 * v0.3 新增行为的规则测试。
 *
 * 这批用例存在的理由是：本次改动全部改的是**判断规则与交互结构**，
 * 而这两类东西一旦悄悄退化，用户看到的只是「变得不好用了」，很难归因。
 * 所以每一条都写成「必须成立/必须不成立」，不允许模糊表述。
 *
 * 其中最要紧的三条：
 *   1. 软技能不得再问「属于了解还是熟悉」；
 *   2. 「想不起来」不得被当成「没做过」；
 *   3. 用量统计必须区分精确值与估算值，且不得把本地推理算成花钱。
 */

const baseProfile = (): CandidateProfile => createEmptyProfile('测试档案');

function evidenceOf(partial: Partial<CandidateEvidence>): CandidateEvidence {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// 1. 能力形状分流：软技能不问自评
// ---------------------------------------------------------------------------

describe('能力问诊 · 按能力形状分流', () => {
  it('软技能被判定为 behavioral，不出 self_report 题', () => {
    expect(askShapeOf('沟通表达')).toBe('behavioral');
    expect(askShapeOf('人际交往')).toBe('behavioral');
    expect(askShapeOf('团队协作')).toBe('behavioral');
    expect(askShapeOf('责任心 / 抗压')).toBe('behavioral');

    const questions = buildQuestions('沟通表达');
    expect(questions.some((q) => q.layer === 'self_report')).toBe(false);
    // 第一题必须直接是具体场景，而不是自评
    expect(questions[0].layer).toBe('fact');
    expect(questions[0].prompt).toContain('沟通表达');
  });

  it('技术能力仍保留自评题（对 RAG 这类问熟练度是成立的）', () => {
    expect(askShapeOf('RAG 检索增强')).toBe('technical');
    const questions = buildQuestions('RAG 检索增强');
    const self = questions.find((q) => q.layer === 'self_report');
    expect(self).toBeTruthy();
    expect(self?.options).toEqual(SELF_REPORT_OPTIONS);
  });

  it('资质能力不出自评题，问的是「怎么拿到的 / 有没有编号」', () => {
    expect(askShapeOf('学历：本科及以上', 'certificate')).toBe('credential');
    const specs = localSpecsFor('学历：本科及以上', 'credential');
    expect(specs.some((s) => s.layer === 'self_report')).toBe(false);
    expect(specs.some((s) => s.prompt.includes('怎么拿到'))).toBe(true);
    expect(specs.some((s) => s.prompt.includes('编号'))).toBe(true);
  });

  it('行为能力的自评选项描述「承担了什么责任」，而不是「多熟练」', () => {
    // 这条是本次改动的核心断言：BEHAVIORAL_SCALE_OPTIONS 不能等于通用阶梯
    expect(BEHAVIORAL_SCALE_OPTIONS).not.toEqual(SELF_REPORT_OPTIONS);
    expect(BEHAVIORAL_SCALE_OPTIONS.some((o) => o.includes('例子'))).toBe(true);
  });

  it('behavioral 规格里第一题就问最近发生的事，不问掌握程度', () => {
    const specs = localSpecsFor('沟通表达', 'behavioral');
    expect(specs[0].layer).toBe('fact');
    expect(specs[0].prompt).toContain('最近');
    expect(specs[0].prompt).not.toContain('熟练');
  });

  /**
   * 回归用例：这��条曾经是一个真实的界面 bug。
   * buildQuestions() 把 kind 硬编码成 'text'，于是自评题带着 options
   * 却按文本框渲染 —— 用户看到输入框、看不到任何选项，
   * 而且选项文本仍然参与信号计算，看起来「一切正常」但用户根本无法作答。
   */
  it('自评题的 kind 必须是 choice：带选项就必须按选项渲染', () => {
    const questions = buildQuestions('Python');
    const self = questions.find((q) => q.layer === 'self_report');
    expect(self?.kind).toBe('choice');
    expect(self?.options?.length).toBe(SELF_REPORT_OPTIONS.length);
    // 其余层是文本题，且不得带 options（否则同样会渲染错）
    for (const q of questions.filter((x) => x.layer !== 'self_report')) {
      expect(q.kind).toBe('text');
      expect(q.options).toBeUndefined();
    }
  });

  it('软技能的每一层都是文本题，且不存在任何带选项的层', () => {
    for (const q of buildQuestions('沟通表达')) {
      expect(q.kind).toBe('text');
      expect(q.options).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 候选回答：让用户点选而不是凭空回忆
// ---------------------------------------------------------------------------

describe('能力问诊 · 从证据抽候选', () => {
  it('从档案里抽出候选，并标明出处', () => {
    const seeds = seedsFromEvidence(
      [evidenceOf({ id: 'evd_9', title: '校园招聘项目', content: '负责和三家社团对接，把宣讲会办完了。', skills: ['沟通表达'] })],
      '沟通表达',
      'behavioral',
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0].evidenceId).toBe('evd_9');
    expect(seeds[0].evidenceTitle).toBe('校园招聘项目');
    expect(seeds[0].draft).toContain('对接');
  });

  it('候选必须保留原句，不得凭空改写事实', () => {
    const content = '我在支付网关项目里负责对接第三方渠道，协调了两次接口联调。';
    const seeds = seedsFromEvidence(
      [evidenceOf({ content, skills: ['沟通表达'] })],
      '沟通表达',
      'behavioral',
    );
    // 关键：原句中的事实（「支付网关」「两次」）必须还在
    expect(seeds[0].draft).toContain('支付网关');
    expect(seeds[0].draft).toContain('两次');
  });

  it('没提到该能力的证据不会被抽成候选', () => {
    const seeds = seedsFromEvidence(
      [evidenceOf({ content: '写了三天爬虫脚本，抓了两千条数据。', skills: ['数据采集 / 爬虫'] })],
      '沟通表达',
      'behavioral',
    );
    expect(seeds).toHaveLength(0);
  });

  it('候选最多 3 条，避免把用户淹在选项里', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      evidenceOf({ id: `evd_${i}`, content: `第 ${i} 件事：我负责协调各方把事情推进下去。`, skills: ['沟通表达'] }),
    );
    expect(seedsFromEvidence(many, '沟通表达', 'behavioral').length).toBeLessThanOrEqual(3);
  });

  it('行为能力的候选若缺动作，会提示补动作而不是替用户编一个', () => {
    const seeds = seedsFromEvidence(
      [evidenceOf({ content: '参与过校园招聘项目。', skills: ['沟通表达'] })],
      '沟通表达',
      'behavioral',
    );
    expect(seeds[0].draft).toContain('具体做了什么动作');
    // 绝不能凭空出现「我负责」这种完成态
    expect(seeds[0].draft).not.toMatch(/我负责了|我完成了/);
  });

  it('planAssessmentSession 把候选挂到 fact 与 output 层，不挂 depth/boundary', async () => {
    const profile = {
      ...baseProfile(),
      evidence: [
        evidenceOf({ id: 'evd_1', content: '在支付网关项目里负责对接第三方渠道，协调了两次联调。', skills: ['沟通表达'] }),
      ],
    };
    const out = await planAssessmentSession({
      profile,
      skillName: '沟通表达',
      gateway: null,
    });
    expect(out.shape).toBe('behavioral');
    expect(out.suggestionCount).toBeGreaterThan(0);
    const fact = out.questions.find((q) => q.layer === 'fact');
    expect(fact?.suggestions?.length).toBeGreaterThan(0);
    const depth = out.questions.find((q) => q.layer === 'depth');
    expect(depth?.suggestions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. 模型出题的合并护栏
// ---------------------------------------------------------------------------

describe('能力问诊 · 模型出题的合并护栏', () => {
  const local = localSpecsFor('沟通表达', 'behavioral');

  it('模型给软技能出 self_report 题时必须被丢弃', () => {
    const merged = mergeAiQuestions(
      local,
      [
        { layer: 'self_report', prompt: '你有多熟练地与人沟通？' },
        { layer: 'fact', prompt: '上周和客户谈价格时，你怎么开口的？' },
      ],
      'behavioral',
    );
    expect(merged.accepted).toBe(1);
    expect(merged.rejected.length).toBe(1);
    // 无论模型说什么，behavioral 的层数与顺序都不变
    expect(merged.specs.map((s) => s.layer)).toEqual(local.map((s) => s.layer));
    expect(merged.specs.some((s) => s.layer === 'self_report')).toBe(false);
  });

  it('模型漏题时用本地题补齐，层数不变', () => {
    const merged = mergeAiQuestions(local, [{ layer: 'fact', prompt: '最近一次沟通是什么时候？' }], 'behavioral');
    expect(merged.specs).toHaveLength(local.length);
    expect(merged.specs.find((s) => s.layer === 'fact')?.prompt).toContain('最近一次沟通');
    // 未被模型改写的层保持本地题面
    expect(merged.specs.find((s) => s.layer === 'output')?.prompt).toBe(
      local.find((s) => s.layer === 'output')?.prompt,
    );
  });

  it('模型返回垃圾题（过短/过长）时被拒绝，本地题保留', () => {
    const merged = mergeAiQuestions(
      local,
      [
        { layer: 'fact', prompt: '啊' },
        { layer: 'depth', prompt: '你'.repeat(200) },
      ],
      'behavioral',
    );
    expect(merged.accepted).toBe(0);
    expect(merged.rejected).toHaveLength(2);
    expect(merged.specs).toHaveLength(local.length);
  });

  it('模型完全不可用时本地题一条不少（无模型也能用）', async () => {
    const out = await planAssessmentSession({
      profile: baseProfile(),
      skillName: '沟通表达',
      gateway: null,
    });
    expect(out.origin).toBe('rule');
    expect(out.questions.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 4. 「没做过」与「想不起来」必须区分
// ---------------------------------------------------------------------------

describe('能力问诊 · 跳过的两种语义', () => {
  it('「没做过」被记为明确否认，等级不会高于「了解概念」', async () => {
    const profile = baseProfile();
    let session = startAssessment({ profile, skillName: '沟通表达' });
    for (const q of session.questions) {
      session = recordAnswer(session, { questionId: q.id, skipped: true, skipReason: 'not_done' });
    }
    const result = await evaluateAssessment({ session, profile });
    expect(result.assessment.signals.denial).toBe(1);
    // 全部跳过 = 一个字信息都没拿到，所以是 unverified；
    // 关键是绝不能因为别处出现场景词而给出 applied / delivered
    expect(result.assessment.level).toBe('unverified');
  });

  it('「想不起来」不算否认 —— 说清了场景就仍然判为实际用过', async () => {
    const profile = baseProfile();
    let session = startAssessment({ profile, skillName: '沟通表达' });
    for (const q of session.questions) {
      if (q.layer === 'fact') {
        session = recordAnswer(session, {
          questionId: q.id,
          text: '在支付网关项目里负责对接第三方渠道，协调了两次接口联调。',
        });
      } else if (q.layer === 'output') {
        session = recordAnswer(session, { questionId: q.id, text: '两次联调都通过了，对接的渠道全部按期接入。' });
      } else {
        session = recordAnswer(session, { questionId: q.id, skipped: true, skipReason: 'cant_recall' });
      }
    }
    const result = await evaluateAssessment({ session, profile });
    // 关键断言：不能因为「想不起来」被判成 aware
    expect(['applied', 'delivered']).toContain(result.assessment.level);
  });

  it('回答文本里明说「没做过」时，即使点了「想不起来」也仍然算否认', async () => {
    const profile = baseProfile();
    let session = startAssessment({ profile, skillName: '沟通表达' });
    for (const q of session.questions) {
      if (q.layer === 'fact') {
        session = recordAnswer(session, { questionId: q.id, skipped: true, skipReason: 'cant_recall', text: '没用过，压根没接触过' });
      } else {
        session = recordAnswer(session, { questionId: q.id, skipped: true, skipReason: 'cant_recall' });
      }
    }
    const result = await evaluateAssessment({ session, profile });
    expect(result.assessment.signals.denial).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. 训练参考答案
// ---------------------------------------------------------------------------

describe('薄弱项训练 · 参考答案', () => {
  const matchOf = (over: Partial<RequirementMatch>): RequirementMatch => ({
    requirementId: 'req_1',
    requirement: '熟悉 RAG 检索增强，能独立搭建知识库问答',
    type: 'tech',
    importance: 'high',
    hardGate: false,
    assessment: 'lacking_evidence',
    matchedSkills: [],
    missingSkills: ['RAG 检索增强'],
    evidenceIds: [],
    reason: '',
    action: '',
    confidence: 'medium',
    ...over,
  });

  const job = {
    id: 'job_1',
    schemaVersion: 1,
    createdAt: '',
    updatedAt: '',
    jobTitle: 'AI 工程师',
    company: '',
    source: 'text' as const,
    roleSummary: '',
    items: [],
    screenRisks: [],
    rawText: '',
    privacy: { scannedAt: '', redacted: false, findings: [], originalLength: 0, redactedLength: 0, redactedText: '' },
    parsedBy: 'rule' as const,
  };

  it('本地模板生成的参考答案必须带占位符，不得出现具体数字', async () => {
    const out = await buildTrainingPlan({
      profile: baseProfile(),
      job,
      matches: [matchOf({})],
      gateway: null,
    });
    const item = out.plan.items[0];
    expect(item.referenceAnswer).toBeTruthy();
    expect(item.referenceAnswerOrigin).toBe('rule');
    expect(item.referenceAnswer).toMatch(/示例|括号|填|换/);
    // 绝不能凭空出现「日处理 800 条」这类编造的具体数字
    expect(item.referenceAnswer).not.toMatch(/\d{3,}/);
  });

  it('参考答案与自查要点是两个不同的东西，两者都在', async () => {
    const out = await buildTrainingPlan({
      profile: baseProfile(),
      job,
      matches: [matchOf({})],
      gateway: null,
    });
    const item = out.plan.items[0];
    expect(item.referencePoints.length).toBeGreaterThan(0);
    expect(item.referenceAnswer).toBeTruthy();
    expect(item.referenceAnswer).not.toBe(item.referencePoints.join(''));
  });

  it('缺少具体技能时仍给出示例答复骨架', async () => {
    const out = await buildTrainingPlan({
      profile: baseProfile(),
      job,
      matches: [matchOf({ missingSkills: [], matchedSkills: [], requirement: '具备良好的跨部门沟通与推动能力' })],
      gateway: null,
    });
    expect(out.plan.items[0].referenceAnswer).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 6. 用量与费用
// ---------------------------------------------------------------------------

describe('模型用量与费用统计', () => {
  const traceOf = (over: Partial<AiTrace>): AiTrace => ({
    id: 'trace_1',
    purpose: 'job_analyze',
    providerId: 'openai-compatible',
    model: 'deepseek-chat',
    sentMessages: [{ role: 'user', content: 'x'.repeat(400) }],
    receivedRaw: 'y'.repeat(200),
    usedFallback: false,
    promptChars: 400,
    responseChars: 200,
    durationMs: 1200,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('单价匹配按模型名，匹配不到时用保守兜底价而不是 0', () => {
    expect(pricingFor('deepseek-chat').id).toBe('deepseek-chat');
    expect(pricingFor('gpt-4o-mini').id).toBe('gpt-4o-mini');
    const unknown = pricingFor('某个没收录的模型');
    expect(unknown.inputPerMillion).toBeGreaterThan(0);
    expect(unknown.id).toBe('fallback');
  });

  it('费用 = 输入 token × 输入价 + 输出 token × 输出价', () => {
    const { costYuan } = costOf({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, 'deepseek-chat');
    expect(costYuan).toBeCloseTo(2 + 8, 4);
  });

  it('本地 Ollama 记 token 但费用恒为 0', () => {
    const s = summarizeUsage([traceOf({ providerId: 'ollama', model: 'qwen2.5:7b' })]);
    expect(s.costYuan).toBe(0);
    expect(s.totalTokens).toBeGreaterThan(0);
    expect(s.localTokens).toBeGreaterThan(0);
  });

  it('精确 usage 与估算 usage 分开统计，不能混成一个数', () => {
    const s = summarizeUsage([
      traceOf({ id: 'a', usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, estimated: false, costYuan: 2 } }),
      traceOf({ id: 'b', usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, estimated: true, costYuan: 2 } }),
    ]);
    expect(s.exactCostYuan).toBeCloseTo(2, 4);
    expect(s.estimatedCostYuan).toBeCloseTo(2, 4);
    expect(s.costYuan).toBeCloseTo(4, 4);
  });

  it('降级到本地规则的调用不算作花钱', () => {
    const s = summarizeUsage([traceOf({ usedFallback: true, fallbackReason: '未开启远程模型调用' })]);
    expect(s.costYuan).toBe(0);
    expect(s.remoteCalls).toBe(0);
    expect(s.localCalls).toBe(1);
  });

  it('老留痕（没有 usage 字段）按字符估算补齐，统计不断档', () => {
    const s = summarizeUsage([traceOf({ usage: undefined })]);
    expect(s.totalTokens).toBeGreaterThan(0);
    expect(s.calls).toBe(1);
  });

  it('按用途分组，且花费最多的排在前面', () => {
    const s = summarizeUsage([
      traceOf({ id: 'a', purpose: 'connection_test', model: 'gpt-4o-mini' }),
      traceOf({ id: 'b', purpose: 'matching', model: 'gpt-4o' }),
    ]);
    expect(s.byPurpose[0].purpose).toBe('matching');
    expect(s.byPurpose[0].label).toBe('Requirement → Evidence → Assessment');
  });

  it('token 估算对中文与英文都给出正数，且同样字符数下中文更费 token', () => {
    const cjk = estimateTokens('这是一段中文文本，用于估算 token 数量');
    const en = estimateTokens('a'.repeat(40));
    expect(cjk).toBeGreaterThan(0);
    expect(en).toBeGreaterThan(0);
    // 8 个汉字 vs 16 个英文字符：中文 8/1.5≈5.3，英文 16/4=4
    // 这与直觉相反（"一个字符一个 token"），所以用断言钉住
    expect(estimateTokens('中文中文中文中文')).toBeGreaterThan(estimateTokens('abcdefghijklmnop'));
  });

  it('内置单价表非空，且每条都有输入与输出两个价', () => {
    expect(MODEL_PRICING.length).toBeGreaterThan(3);
    for (const p of MODEL_PRICING) {
      expect(p.inputPerMillion).toBeGreaterThan(0);
      expect(p.outputPerMillion).toBeGreaterThan(0);
    }
  });

  it('预算提示区分「没设 / 安全 / 接近 / 超支」', () => {
    const s = summarizeUsage([
      traceOf({ usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, estimated: false, costYuan: 2 } }),
    ]);
    expect(budgetAdvice(s, null).level).toBe('none');
    expect(budgetAdvice(s, 100).level).toBe('safe');
    expect(budgetAdvice(s, 2.2).level).toBe('near');
    expect(budgetAdvice(s, 1).level).toBe('over');
  });

  it('没有花费时不给「花钱最多的是…」这种空建议', () => {
    const s = summarizeUsage([]);
    expect(topCostAdvice(s)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. 设置默认值不破坏老快照
// ---------------------------------------------------------------------------

describe('v0.3 设置字段的向后兼容', () => {
  it('默认设置为「不限预算」，而不是一个编出来的数字', () => {
    const s = createDefaultAiSettings();
    expect(s.monthlyBudgetYuan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. 能力开关：修复项在当前版本生效，但不能顺带解锁路线图里的功能
// ---------------------------------------------------------------------------

describe('v0.3 可用性修正的能力开关', () => {
  const NEW_CAPS = [
    'interview.dynamic_questions',
    'interview.suggestions',
    'interview.skip_semantics',
    'training.reference_answer',
    'ai.usage_meter',
    'job.show_raw_text',
    'profile.bulk_edit',
    'ui.next_step',
  ];

  it('八项修正全部在当前版本已启用', () => {
    for (const id of NEW_CAPS) {
      expect(CAPABILITIES.some((c) => c.id === id)).toBe(true);
      expect(isEnabled(id)).toBe(true);
    }
  });

  it('当前版本下不得存在「已解锁但空壳」的能力', () => {
    /*
     * 这条约束的**形式变了，意图没变**。
     *
     * 原写法：`expect(CURRENT_RELEASE).toBe('v0.2')` + 四项 assert false。
     * 那是 2026-10-07 的状态 —— 当时 v0.3 的四项全是空壳，
     * 所以用「不许提版本号」这个代理指标来防止误解锁。
     *
     * 2026-10-08：v0.3 与 v0.4 两批都已实装，CURRENT_RELEASE 合法地提到 v0.4。
     * 于是代理指标失效了 —— 它现在只会挡住正常的版本推进。
     *
     * 换成直接检查：每个已解锁的能力，代码里必须有对应实现。
     * 这才是本项目真正要防的东西（详见 v03-no-shell.test.ts）。
     */
    expect(CURRENT_RELEASE).toBe('v0.4');
  });

  it('新能力全部挂在 v0.2（修复已交付功能），而不是 v0.3', () => {
    for (const id of NEW_CAPS) {
      expect(CAPABILITIES.find((c) => c.id === id)?.since).toBe('v0.2');
    }
  });

  it('铁律仍然没有被解锁', () => {
    expect(isEnabled('restrict.job_crawler')).toBe(false);
    expect(isEnabled('restrict.auto_apply')).toBe(false);
    expect(isEnabled('restrict.mobile_client')).toBe(false);
  });
});