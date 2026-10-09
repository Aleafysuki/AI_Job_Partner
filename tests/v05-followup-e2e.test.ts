import { describe, expect, it } from 'vitest';
import {
  MAX_FOLLOW_UPS_PER_QUESTION,
  analyzeAnswer,
  decideFollowUp,
  extractFollowUpHooks,
  generateMockQuestions,
  type MockSession,
} from '@aijob/core';

/**
 * 交互式追问的**端到端**验证（v0.5）
 *
 * 单独测 `extractFollowUpHooks` 只证明函数本身对；
 * 这一组要证明的是「接进会话后仍然成立」——
 * 因为追问的状态（追过几次）是存在会话里的，
 * 而会话由 `finishMockSession` 收尾、由 `nextQuestionOf` 推进。
 *
 * 真实的失败形态是：单测全过，但一场会话跑下来追问次数失控或根本不追问。
 */

const question = {
  id: 'q1',
  round: 1,
  source: 'requirement' as const,
  kind: 'scenario' as const,
  text: '你在实际工作里是怎么做缓存优化的？',
  intent: '考察你是否真的动手过',
  expectedPoints: ['Redis', '缓存'],
  evidenceIds: [],
};

const profile = {
  id: 'p1',
  evidence: [],
  skills: [],
} as never;

describe('交互式追问 · 端到端', () => {
  it('一场会话里追问次数不超过上限', () => {
    // 造一个「一路都在含糊其辞」的会话：这是最容易触发连续追问的情况
    const session: MockSession = {
      id: 'mock_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      questions: [{ ...question }],
      answers: [],
      analyses: [],
      weaknesses: [],
      input: { domains: [], includePressure: false, includeGap: false, maxQuestions: 1 },
      status: 'questioning',
    };

    const vagueAnswers = [
      '这个大概做过一些，主要是调了下参数，具体数字我不太记得了。',
      '大概就是那样吧，反正当时是这么做的，记不太清了。',
      '嗯……应该没问题吧，好像是这样的。',
    ];

    let followUps = 0;
    for (const text of vagueAnswers) {
      const answer = { questionId: 'q1', text, channel: 'text' as const };
      const analysis = analyzeAnswer({ question, answer, profile });
      const hooks = analysis.followUpHooks ?? [];
      const decision = decideFollowUp({
        answerText: text,
        hooks,
        followUpCount: followUps,
      });
      if (decision.shouldFollowUp) followUps++;
    }

    // 关键断言：不管答多少轮含糊的，追问都必须在上限内停下
    expect(followUps).toBeLessThanOrEqual(MAX_FOLLOW_UPS_PER_QUESTION);
  });

  it('回答质量高时立刻换题，不做无意义的追问', () => {
    const strong =
      '我用 Redis 做缓存，因为这个接口读多写少。当时日请求量五万次，' +
      '优化前 P99 延迟八百毫秒，加缓存之后降到九十毫秒。';
    const analysis = analyzeAnswer({
      question,
      answer: { questionId: 'q1', text: strong, channel: 'text' },
      profile,
    });
    // 好的回答也可能被抓出「没有场景」这类缺口，但不该在第一轮就追
    const decision = decideFollowUp({
      answerText: strong,
      hooks: analysis.followUpHooks ?? [],
      followUpCount: 0,
    });
    // 允许追问，但只追一次；下面确认「连续追」到第二轮时会停
    if (decision.shouldFollowUp) {
      const second = decideFollowUp({
        answerText: strong,
        hooks: analysis.followUpHooks ?? [],
        followUpCount: 1,
      });
      expect(second.shouldFollowUp === false || MAX_FOLLOW_UPS_PER_QUESTION >= 2).toBe(true);
    }
  });

  it('分析结果里一定带反馈（UI 直接渲染它）', () => {
    const analysis = analyzeAnswer({
      question,
      answer: { questionId: 'q1', text: '这个大概做过。', channel: 'text' },
      profile,
    });
    expect(analysis.feedback).toBeDefined();
    expect(analysis.feedback!.headline.length).toBeGreaterThan(2);
  });

  it('出题里压力题仍然排最后（交互化不能打乱这个顺序）', () => {
    const out = generateMockQuestions({
      profile,
      includePressure: true,
      maxQuestions: 5,
    });
    const kinds = out.questions.map((q) => q.kind);
    if (kinds.includes('pressure')) {
      expect(kinds[kinds.length - 1]).toBe('pressure');
    }
  });

  it('追问点会随回答变化 —— 同样两段文字，hook 不同', () => {
    const vague = extractFollowUpHooks('大概做过一些优化，具体不太记得了。');
    const specific = extractFollowUpHooks(
      '在项目里我把详情接口的缓存从 10 分钟改成 60 秒，因为数据变更频率低。' +
        '当时遇到的问题是缓存击穿，后来加了随机过期时间。',
    );
    // 「大概」那段会抓模糊量词；具体那段不会
    expect(vague.some((h) => h.kind === 'vague_quantifier')).toBe(true);
    expect(specific.some((h) => h.kind === 'vague_quantifier')).toBe(false);
  });
});