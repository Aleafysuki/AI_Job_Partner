import { describe, expect, it } from 'vitest';
import {
  MAX_FOLLOW_UPS_PER_QUESTION,
  OCR_CONFIDENCE_LABEL,
  OCR_CONFIDENCE_WHY,
  OCR_LOW_CONFIDENCE,
  OCR_MAX_BYTES,
  OCR_SCRIPT_LABEL,
  OCR_SIZE_WHY,
  OCR_SCRIPT_WHY,
  assembleOcrText,
  buildAnswerFeedback,
  decideFollowUp,
  extractFollowUpHooks,
  needsManualReview,
  summarizeConfidence,
  type OcrBlock,
} from '@aijob/core';

/**
 * 两个新能力：交互式追问 + 截图 OCR 的后处理
 * =================================================
 *
 * 这批里最该用断言钉住的是**产品立场**，它们一旦破了会直接损害用户：
 *
 * 1. 追问必须带 `anchor`（引用用户原话）——
 *    没有原文的追问等于凭空编，用户会困惑「我哪句没说清」。
 * 2. 反馈只说缺什么，不给该怎么说——
 *    与 Prep、模拟面试同源。给出话术会诱导背诵。
 * 3. 追问必须能终止——
 *    每次都追的话 5 题会变 20 题，用户会放弃。
 */

const block = (partial: Partial<OcrBlock>): OcrBlock => ({
  id: 'ocr_0',
  text: '',
  confidence: 0.9,
  rect: { left: 0, top: 0, width: 100, height: 20 },
  ...partial,
});

// ---------------------------------------------------------------------------
// 1. 交互式追问
// ---------------------------------------------------------------------------

describe('交互式追问 · 从回答里抽追问点', () => {
  it('每个追问点都必须带原文 anchor', () => {
    const hooks = extractFollowUpHooks(
      '这个项目大概做了三个月，我用 Redis 做过缓存，具体数字我不太记得了',
    );
    expect(hooks.length).toBeGreaterThan(0);
    for (const h of hooks) {
      expect(h.anchor.length).toBeGreaterThan(3);
      // anchor 必须真的来自用户的回答 —— 这是硬要求
      expect(
        '这个项目大概做了三个月，我用 Redis 做过缓存，具体数字我不太记得了'.includes(h.anchor.slice(0, 5)),
      ).toBe(true);
    }
  });

  it('「大概」会被抓成模糊量词追问', () => {
    const hooks = extractFollowUpHooks('这个项目大概做了三个月，期间用 Redis 做了缓存');
    const vague = hooks.find((h) => h.kind === 'vague_quantifier');
    expect(vague).toBeDefined();
    expect(vague!.text).toContain('大概');
    // 追问要问出具体数字，而不是泛泛「详细说说」
    expect(vague!.expectedPoints.join()).toContain('数字');
  });

  it('自我怀疑会被抓成「你会怎么从零弄明白」而不是「那你打算怎么学」', () => {
    const hooks = extractFollowUpHooks('这块我不太会，当时是同事帮忙写的，我现在也没完全搞懂');
    const doubt = hooks.find((h) => h.kind === 'self_doubt');
    expect(doubt).toBeDefined();
    expect(doubt!.text).toContain('从零');
  });

  it('只说了做法没讲因果，会被问「为什么」', () => {
    const hooks = extractFollowUpHooks(
      '我在项目里加了一层缓存，接口的响应时间变快了，用户点击的时候不会卡。',
    );
    const noMech = hooks.find((h) => h.kind === 'no_mechanism');
    expect(noMech).toBeDefined();
    expect(noMech!.text).toContain('为什么');
  });

  it('回答太短时不抽追问点（没东西可追）', () => {
    expect(extractFollowUpHooks('用过')).toEqual([]);
    expect(extractFollowUpHooks('')).toEqual([]);
  });

  it('追问点里不含任何「参考话术」', () => {
    const hooks = extractFollowUpHooks('大概做过一些性能优化，用了缓存，具体不太记得了');
    const blob = JSON.stringify(hooks);
    for (const banned of ['你可以这样回答', '参考话术', '照着说', '标准答案', '建议这样说']) {
      expect(blob).not.toContain(banned);
    }
  });
});

describe('交互式追问 · 追不追', () => {
  const good = '这个项目大概做了三个月。我用 Redis 做缓存，因为读多写少，减少数据库压力。当时日请求量大概五万次，优化后接口 P99 从八百毫秒降到九十毫秒。';

  it('有追问点且未达上限 → 追', () => {
    const hooks = extractFollowUpHooks(good);
    const d = decideFollowUp({ answerText: good, hooks, followUpCount: 0 });
    expect(d.shouldFollowUp).toBe(true);
    expect(d.hook).toBeDefined();
  });

  it('达到上限后必须停 —— 否则 5 题会变 20 题', () => {
    const hooks = extractFollowUpHooks(good);
    const d = decideFollowUp({
      answerText: good,
      hooks,
      followUpCount: MAX_FOLLOW_UPS_PER_QUESTION,
    });
    expect(d.shouldFollowUp).toBe(false);
    expect(d.reason).toContain('敷衍');
  });

  it('轮次用完必须停', () => {
    const hooks = extractFollowUpHooks(good);
    const d = decideFollowUp({ answerText: good, hooks, followUpCount: 1, maxRounds: 2 });
    expect(d.shouldFollowUp).toBe(false);
  });

  it('回答太短不追（追了也没信息）', () => {
    const hooks = extractFollowUpHooks(good);
    const d = decideFollowUp({ answerText: '嗯', hooks, followUpCount: 0 });
    expect(d.shouldFollowUp).toBe(false);
    expect(d.reason).toContain('字');
  });

  it('没有追问点就不追', () => {
    const d = decideFollowUp({ answerText: good, hooks: [], followUpCount: 0 });
    expect(d.shouldFollowUp).toBe(false);
  });

  it('连续追问会选不同的点，不会重复问同一个', () => {
    const text =
      '这块我不太会，大概是用 Redis 做了缓存。当时遇到的问题就是慢，具体数字记不太清了。';
    const hooks = extractFollowUpHooks(text);
    expect(hooks.length).toBeGreaterThanOrEqual(2);
    const first = decideFollowUp({ answerText: text, hooks, followUpCount: 0 });
    const second = decideFollowUp({ answerText: text, hooks, followUpCount: 1 });
    expect(first.hook?.id).not.toBe(second.hook?.id);
  });
});

describe('交互式追问 · 反馈只说缺什么', () => {
  const strong =
    '我在项目里加了一层缓存，因为读多写少，减少数据库压力。当时日请求量五万次，优化后 P99 从八百毫秒降到九十毫秒。';
  const weak = '这个大概做过，用过 Redis。';

  it('好的回答给的是肯定 + 指出仍然缺的部分', () => {
    const hooks = extractFollowUpHooks(strong);
    const f = buildAnswerFeedback({ answerText: strong, hooks, usedEvidence: false });
    expect(f.strengths.length).toBeGreaterThan(0);
    // 数字与因果都给了 → 这两条不该再出现在缺什么里
    expect(f.gaps.map((g) => g.text).join()).not.toContain('没有说「为什么」');
    expect(f.gaps.map((g) => g.text).join()).not.toContain('全程没有出现一个数字');
  });

  it('弱的回答会指出缺数字、缺场景', () => {
    const hooks = extractFollowUpHooks(weak);
    const f = buildAnswerFeedback({ answerText: weak, hooks, usedEvidence: false });
    const blob = f.gaps.map((g) => g.text).join();
    expect(blob).toContain('数字');
    expect(blob).toContain('场景');
  });

  it('不评价文风 —— 只看可核对的信号', () => {
    const f = buildAnswerFeedback({
      answerText: strong,
      hooks: [],
      usedEvidence: true,
    });
    expect(f.headline).toBeTruthy();
    // 关键词：不该出现「表达」「文雅」「措辞」这类主观评价
    const blob = JSON.stringify(f);
    for (const banned of ['文雅', '措辞', '不够流畅', '语病']) {
      expect(blob).not.toContain(banned);
    }
  });

  it('反馈里绝不含「你应该这样说」类话术', () => {
    const f = buildAnswerFeedback({ answerText: weak, hooks: extractFollowUpHooks(weak), usedEvidence: false });
    const blob = JSON.stringify(f);
    for (const banned of ['你应该说', '建议这样说', '参考话术', '照着说']) {
      expect(blob).not.toContain(banned);
    }
  });

  it('没引用档案材料时明确指出', () => {
    const f = buildAnswerFeedback({
      answerText: '我在项目里做了很多优化，涉及缓存和数据库。用户反馈变好了。',
      hooks: [],
      usedEvidence: false,
    });
    expect(f.gaps.map((g) => g.text).join()).toContain('没有引用档案里的任何材料');
  });
});

// ---------------------------------------------------------------------------
// 2. 截图 OCR 的后处理
// ---------------------------------------------------------------------------

describe('截图 OCR · 文本拼接', () => {
  it('按 y 坐标聚成行，而不是按返回顺序', () => {
    // 故意让返回顺序与阅读顺序不一致：ML Kit 在手机截图上会先返回底部区域
    const blocks = [
      block({ id: 'b3', text: '任职要求', rect: { left: 0, top: 200, width: 80, height: 20 } }),
      block({ id: 'b1', text: '后端工程师', rect: { left: 0, top: 0, width: 120, height: 22 } }),
      block({ id: 'b2', text: '岗位职责', rect: { left: 0, top: 100, width: 80, height: 22 } }),
    ];
    const text = assembleOcrText(blocks);
    const lines = text.split('\n');
    expect(lines[0]).toContain('后端工程师');
    expect(lines[1]).toContain('岗位职责');
    expect(lines[2]).toContain('任职要求');
  });

  it('同一行内按 x 从左到右', () => {
    const blocks = [
      block({ id: 'r', text: '熟悉 Redis', rect: { left: 200, top: 10, width: 100, height: 20 } }),
      block({ id: 'l', text: '3年以上 Java', rect: { left: 0, top: 12, width: 100, height: 20 } }),
    ];
    const text = assembleOcrText(blocks);
    expect(text.indexOf('3年以上')).toBeLessThan(text.indexOf('熟悉 Redis'));
  });

  it('空输入返回空串', () => {
    expect(assembleOcrText([])).toBe('');
  });
});

describe('截图 OCR · 置信度摘要', () => {
  it('全部清晰 → high', () => {
    const c = summarizeConfidence([
      block({ confidence: 0.95 }),
      block({ confidence: 0.92 }),
    ]);
    expect(c.level).toBe('high');
    expect(needsManualReview(c)).toBe(false);
  });

  it('均值高但有几行很低 → 不能判 high', () => {
    // 这是本模块最重要的一条：一张「平均 0.85 但有三行是 0.3」的截图，
    // 对用户来说与「每行都 0.85」完全不同。
    const c = summarizeConfidence([
      block({ confidence: 0.9 }),
      block({ confidence: 0.9 }),
      block({ confidence: 0.9 }),
      block({ confidence: 0.3 }),
      block({ confidence: 0.28 }),
    ]);
    expect(c.level).not.toBe('high');
    expect(c.lowCount).toBe(2);
  });

  it('大量低置信度 → low，并要求人工核对', () => {
    const c = summarizeConfidence([
      block({ confidence: 0.3 }),
      block({ confidence: 0.4 }),
      block({ confidence: 0.2 }),
      block({ confidence: 0.35 }),
    ]);
    expect(c.level).toBe('low');
    expect(needsManualReview(c)).toBe(true);
    expect(OCR_CONFIDENCE_WHY.low).toContain('编造');
  });

  it('无块 → low（不能因为「没有可疑的」就判高）', () => {
    const c = summarizeConfidence([]);
    expect(c.level).toBe('low');
  });

  it('每个档位都有对应的中文说明', () => {
    for (const k of ['high', 'medium', 'low'] as const) {
      expect(OCR_CONFIDENCE_LABEL[k].length).toBeGreaterThan(3);
    }
  });
});

describe('截图 OCR · 参数与承诺', () => {
  it('有大小上限，且说清了为什么', () => {
    expect(OCR_MAX_BYTES).toBeGreaterThan(1024 * 1024);
    expect(OCR_SIZE_WHY).toContain('12MB');
  });

  it('两种语言都有说明，且默认是中文', () => {
    expect(OCR_SCRIPT_LABEL.chinese).toContain('中文');
    expect(OCR_SCRIPT_WHY.chinese.length).toBeGreaterThan(5);
    expect(OCR_SCRIPT_LABEL.latin).toBeTruthy();
  });

  it('低置信度阈值落在 0.6–0.7 —— 太低会放过明显错的字', () => {
    expect(OCR_LOW_CONFIDENCE).toBeGreaterThanOrEqual(0.6);
    expect(OCR_LOW_CONFIDENCE).toBeLessThanOrEqual(0.7);
  });
});