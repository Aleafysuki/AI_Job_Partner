import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  SAMPLE_INTERVIEW_TRANSCRIPT,
  SAMPLE_JD,
  analyzeJobDescription,
  buildDebriefRulesOnly,
  createDefaultAiSettings,
  createEmptyDebriefSession,
  createEmptyProfile,
  renderDebriefHtml,
  type CandidateProfile,
} from '@aijob/core';

/**
 * 示例复盘报告。
 *
 * 存在的理由：让「这个功能到底产出什么」有一个可以点开看的东西，
 * 而不是只能靠读文档想象。顺带它也是一个测试 —— 断言产物真的能落盘、
 * 体积合理、且**不含任何外链**（自包含不是口号，是可以断言的）。
 *
 * 用的是本地规则引擎（不调模型），所以任何人 clone 下来跑 `npm test`
 * 都会得到同一份示例，不受是否有 API Key 影响。
 */

const SAMPLE_FILE = 'debrief-report-sample.html';

function sampleProfile(): CandidateProfile {
  return {
    ...createEmptyProfile('示例档案'),
    id: 'sample_profile',
    summary: '做过 RAG 检索与前端开发，希望找一份能稳定做下去的技术岗。',
    selfDescriptions: ['不喜欢高强度社交，更愿意独立把一件事做完', '不接受长期无补偿加班'],
    skills: [
      {
        id: 'sk_rag',
        name: 'RAG 检索增强',
        aliases: ['检索增强生成'],
        category: 'AI',
        selfLevel: '熟练',
        evidenceIds: [],
        derivedStrength: 'medium',
      },
      {
        id: 'sk_py',
        name: 'Python',
        aliases: [],
        category: '语言',
        selfLevel: '熟练',
        evidenceIds: [],
        derivedStrength: 'medium',
      },
    ],
  };
}

describe('示例复盘报告', () => {
  it('渲染并落盘，且产物自包含', async () => {
    const session = {
      ...createEmptyDebriefSession('sample_profile', { mode: 'onsite', quiet: true }),
      id: 'sample_session',
      status: 'ready' as const,
      jobTitle: 'AI 应用开发工程师',
      manualTranscript: SAMPLE_INTERVIEW_TRANSCRIPT,
      durationMs: 42 * 60 * 1000,
      startedAt: '2026-09-28T10:00:00.000+08:00',
    };

    // 岗位也过一遍规则拆解，让 P3（岗位对齐度）有真实输入
    const { job } = await analyzeJobDescription({
      rawText: SAMPLE_JD,
      settings: createDefaultAiSettings(),
      source: 'text',
      jobTitleHint: 'AI 应用开发工程师',
    });

    const { report } = buildDebriefRulesOnly({ session, profile: sampleProfile(), job });
    const html = renderDebriefHtml(report, {
      subtitle: '示例报告 · 由内置示例面试转写生成（本地规则引擎，未调用任何模型）',
    });

    const target = path.resolve(import.meta.dirname, '..', 'samples', SAMPLE_FILE);
    await fs.writeFile(target, html, 'utf8');

    const stat = await fs.stat(target);
    expect(stat.size).toBeGreaterThan(10_000);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('id="report-data"');
    // 报告不能把脱敏掉的原始公司名又写回来
    expect(html).not.toContain('云枢科技');
    expect(report.dimensions).toHaveLength(18);
  });
});
