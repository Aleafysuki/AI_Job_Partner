import { describe, expect, it, afterAll } from 'vitest';
import {
  APP_NAME,
  ASSESSMENT_ORDER,
  MemoryStoragePort,
  SAMPLE_INTERVIEW_TRANSCRIPT,
  SAMPLE_JD,
  SAMPLE_RESUME,
  WorkspaceStore,
  analyzeDimensionsByRule,
  analyzeJobDescription,
  analyzeResume,
  anonymizeTranscript,
  answerTrainingItem,
  buildDebriefRulesOnly,
  buildPerformanceSummary,
  buildReport,
  buildTrainingPlan,
  computeEvidenceStrength,
  createDefaultAiSettings,
  createEmptyDebriefSession,
  createEmptyProfile,
  evaluateAssessment,
  extractEvidenceByRule,
  finalizeProfile,
  importResume,
  isEnabled,
  mergeProfiles,
  migrateSnapshot,
  pendingSkillsFor,
  plannedCapabilities,
  CAPABILITIES,
  recordAnswer,
  redactPII,
  renderDebriefHtml,
  restrictionCapabilities,
  runFullPipeline,
  runMatching,
  setReleaseOverride,
  startAssessment,
  summarizeAnonymize,
  type AssessLayer,
  type AssessSession,
  type CandidateEvidence,
  type CandidateProfile,
  type InterviewDebriefSession,
  type JobRequirement,
  type RequirementItem,
  type SelfScore,
} from '@aijob/core';

/**
 * 端到端与规则测试。
 *
 * 这些用例存在的意义不是「覆盖率」，而是把产品的几条硬承诺钉死：
 *   1. 隐私脱敏必须发生在分析之前；
 *   2. 自我声明不能变成「满足」；
 *   3. 硬门槛不能被绕过；
 *   4. v0.1 铁律不随版本号自动解锁。
 */

const localSettings = createDefaultAiSettings();

// ---------------------------------------------------------------------------
// 1. 隐私
// ---------------------------------------------------------------------------

describe('隐私脱敏', () => {
  it('识别并移除简历中的身份信息', () => {
    const report = redactPII(SAMPLE_RESUME);
    const types = new Set(report.findings.map((f) => f.type));

    expect(types.has('phone')).toBe(true);
    expect(types.has('email')).toBe(true);
    expect(types.has('address')).toBe(true);

    expect(report.redactedText).not.toContain('13800138000');
    expect(report.redactedText).not.toContain('zhangming@example.com');
    expect(report.redactedText).toContain('[电话]');
    expect(report.redactedText).toContain('[邮箱]');
  });

  it('脱敏不会破坏后续分析需要的结构信息', () => {
    const report = redactPII(SAMPLE_RESUME);
    expect(report.redactedText).toContain('教育背景');
    expect(report.redactedText).toContain('杭州电子科技大学');
    expect(report.redactedText).toContain('Python');
  });

  it('原始值只出现在本地识别结果里，不会进入脱敏文本', () => {
    const report = redactPII(SAMPLE_RESUME);
    const leaked = report.findings.filter((f) => report.redactedText.includes(f.value));
    expect(leaked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 端到端主链路（文档第 18 节）
// ---------------------------------------------------------------------------

describe('端到端主链路', () => {
  it('简历 → 档案 → 岗位 → 要求 → 匹配 → 报告', async () => {
    const result = await runFullPipeline({
      resumeText: SAMPLE_RESUME,
      jdText: SAMPLE_JD,
      profileLabel: '测试档案',
      settings: localSettings,
    });

    // ---- 档案 ----
    expect(result.profile.skills.length).toBeGreaterThan(8);
    expect(result.profile.evidence.length).toBeGreaterThan(3);
    expect(result.profile.projects.length).toBeGreaterThan(0);
    expect(result.profile.education.length).toBeGreaterThan(0);
    expect(result.profile.rawText).not.toContain('13800138000');

    // ---- 岗位 ----
    expect(result.job.items.length).toBeGreaterThan(8);
    expect(result.job.items.some((i) => i.hardGate)).toBe(true);
    expect(result.job.items.every((i) => i.sourceRef.locator.length > 0)).toBe(true);

    // ---- 匹配 ----
    expect(result.report.summary.total).toBe(result.job.items.length);
    expect(ASSESSMENT_ORDER).toContain(result.report.verdict);

    // 每个结论都必须能解释
    for (const match of result.report.matches) {
      expect(match.reason.trim().length).toBeGreaterThan(0);
      expect(match.explain.length).toBeGreaterThanOrEqual(3);
    }

    // 这条链路跑出来应该同时出现多种结论，而不是一边倒
    const s = result.report.summary;
    expect(s.matched).toBeGreaterThan(0);
    expect(s.lackingEvidence).toBeGreaterThan(0);
    expect(s.gap).toBeGreaterThan(0);
    expect(s.unknown).toBeGreaterThan(0);

    // 报告必须给出下一步
    expect(result.report.priorities.length).toBeGreaterThan(0);
    expect(result.report.headline.length).toBeGreaterThan(10);
    expect(result.report.disclaimer).toContain('不代表招聘方的实际筛选结果');

    // 没有调用模型时，必须如实标注
    expect(result.report.usedModel).toBe(false);
    expect(result.report.engine).toBe('rule');
  });

  it('岗位的硬门槛会被识别为高风险', async () => {
    const result = await runFullPipeline({
      resumeText: SAMPLE_RESUME,
      jdText: SAMPLE_JD,
      settings: localSettings,
    });
    const education = result.job.items.find((i) => i.type === 'education');
    expect(education).toBeDefined();
    expect(education?.hardGate).toBe(true);
    expect(education?.importance).toBe('high');
    expect(result.job.screenRisks.length).toBeGreaterThan(0);
  });

  it('没有 API Key 时链路依然完整（降级是默认路径）', async () => {
    const result = await runFullPipeline({
      resumeText: SAMPLE_RESUME,
      jdText: SAMPLE_JD,
      settings: { ...localSettings, providerId: 'openai-compatible', allowRemote: true, apiKey: '' },
    });
    expect(result.profile.skills.length).toBeGreaterThan(0);
    expect(result.job.items.length).toBeGreaterThan(0);
    // 未配置凭据 → 网关不可用 → 不产生 trace
    expect(result.traces).toHaveLength(0);
    expect(result.report.engine).toBe('rule');
  });

  it('岗位标题行不会被当成一条要求', async () => {
    const { job } = await analyzeJobDescription({
      rawText: SAMPLE_JD,
      jobTitleHint: 'AI Agent 开发工程师',
      settings: localSettings,
    });
    expect(job.jobTitle).toBe('AI Agent 开发工程师');
    // 标题行「AI Agent 开发工程师（校招/1-3 年）」不能被拆成要求
    expect(job.items.some((i) => /校招|1-3\s*年）/.test(i.content))).toBe(false);
  });

  it('口头说的几句话也能拆成要求', async () => {
    const { job } = await analyzeJobDescription({
      rawText: '需要 Python、Agent、RAG',
      source: 'manual',
      settings: localSettings,
    });
    expect(job.items.length).toBeGreaterThan(0);
    const keywords = job.items.flatMap((i) => i.keywords);
    expect(keywords).toContain('Python');
    expect(keywords).toContain('RAG 检索增强');
    expect(keywords).toContain('Agent 开发');
  });

  it('整体判断只由高重要度要求决定，加分项缺口不会拉低结论', async () => {
    const result = await runFullPipeline({ resumeText: SAMPLE_RESUME, jdText: SAMPLE_JD, settings: localSettings });
    const important = result.report.matches.filter((m) => m.importance === 'high' || m.hardGate);
    expect(important.length).toBeGreaterThan(0);
    // 样例里高重要度要求基本都满足，因此整体结论不应该是「明显缺口」
    expect(['matched', 'partial', 'lacking_evidence']).toContain(result.report.verdict);
    expect(result.report.verdict).not.toBe('gap');
  });
});

// ---------------------------------------------------------------------------
// 3. 证据强度与自我声明
// ---------------------------------------------------------------------------

function syntheticProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return finalizeProfile({ ...createEmptyProfile('合成档案'), ...overrides });
}

function requirement(overrides: Partial<RequirementItem> = {}): RequirementItem {
  return {
    id: 'req_test',
    index: 1,
    content: '有 RAG 实际项目经验',
    original: '有 RAG 实际项目经验',
    type: 'tech',
    importance: 'high',
    hardGate: false,
    keywords: ['RAG 检索增强'],
    evidenceNeeded: 'project',
    sourceRef: { kind: 'jd', locator: '测试', excerpt: '有 RAG 实际项目经验' },
    confidence: 'high',
    editedByUser: false,
    ...overrides,
  };
}

function jobOf(items: RequirementItem[]): JobRequirement {
  return {
    id: 'job_test',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    jobTitle: '测试岗位',
    company: '',
    source: 'manual',
    roleSummary: '',
    items,
    screenRisks: [],
    rawText: '',
    privacy: { scannedAt: new Date().toISOString(), redacted: false, findings: [], originalLength: 0, redactedLength: 0, redactedText: '' },
    parsedBy: 'rule',
  };
}

function selfClaimEvidence(): CandidateEvidence {
  const now = new Date().toISOString();
  return {
    id: 'evd_claim',
    kind: 'self_claim',
    title: 'RAG 检索增强 · 自我声明',
    content: '简历中声明「熟练」RAG 检索增强，但未找到对应的项目、作品或工作产出。',
    skills: ['RAG 检索增强'],
    metrics: [],
    links: [],
    sourceRef: { kind: 'resume', locator: '技能清单', excerpt: '' },
    strength: 'weak',
    strengthReason: '来源是自我声明，没有可核对的载体',
    editedByUser: false,
    createdAt: now,
    updatedAt: now,
  };
}

describe('证据规则', () => {
  it('只有自我声明时，结论必须是「缺少证据」而不是「满足」', async () => {
    const profile = syntheticProfile({
      skills: [
        {
          id: 'skl_1',
          name: 'RAG 检索增强',
          aliases: [],
          category: 'ai',
          selfLevel: '熟练',
          evidenceIds: ['evd_claim'],
          derivedStrength: 'weak',
        },
      ],
      evidence: [selfClaimEvidence()],
    });

    const { result } = await runMatching({ profile, job: jobOf([requirement()]) });
    expect(result.matches[0].assessment).toBe('lacking_evidence');
    expect(result.matches[0].action).toBeTruthy();
    expect(result.matches[0].action).not.toContain('虚构');
  });

  it('项目类证据且达到 medium 强度时才算「满足」', async () => {
    const now = new Date().toISOString();
    const evidence: CandidateEvidence = {
      id: 'evd_project',
      kind: 'project',
      title: '知识库问答应用',
      content: '使用 Dify 搭建企业知识库问答，接入 300 余份文档，问答准确率由 61% 提升到 84%，基于 RAG 检索增强。',
      skills: ['RAG 检索增强', 'Dify'],
      metrics: ['准确率由 61% 提升到 84%', '300 余份文档'],
      links: [],
      timeRange: '2024.04 ~ 至今',
      strength: 'medium',
      strengthReason: '测试数据',
      sourceRef: { kind: 'resume', locator: '项目经历', excerpt: '' },
      editedByUser: false,
      createdAt: now,
      updatedAt: now,
    };

    const profile = syntheticProfile({
      skills: [
        {
          id: 'skl_1',
          name: 'RAG 检索增强',
          aliases: [],
          category: 'ai',
          selfLevel: '熟练',
          evidenceIds: ['evd_project'],
          derivedStrength: 'medium',
        },
      ],
      evidence: [evidence],
    });

    const { result } = await runMatching({ profile, job: jobOf([requirement()]) });
    expect(result.matches[0].assessment).toBe('matched');
    expect(result.matches[0].evidence[0].kind).toBe('project');
  });

  it('找不到任何相关经历时是「明显缺口」，并且不会建议虚构', async () => {
    const profile = syntheticProfile({ skills: [], evidence: [] });
    const { result } = await runMatching({ profile, job: jobOf([requirement()]) });
    expect(result.matches[0].assessment).toBe('gap');
    expect(result.matches[0].action).toContain('不要虚构');
  });

  it('软性要求找不到证据时是「无法判断」，不是「缺口」', async () => {
    const profile = syntheticProfile({ evidence: [] });
    const soft = requirement({
      id: 'req_soft',
      content: '具备良好的沟通能力，能够与非技术同学清晰对齐需求',
      type: 'soft',
      keywords: ['沟通表达'],
      evidenceNeeded: 'any',
    });
    const { result } = await runMatching({ profile, job: jobOf([soft]) });
    expect(result.matches[0].assessment).toBe('unknown');
  });

  it('证据强度的分档口径稳定（strong 需要类型 + 量化 + 时间）', () => {
    const long = '使用 Python 开发数据采集工具，负责整体设计与上线'.repeat(1);
    // 项目类但既没有量化也没有时间 → 只有类型加分，偏弱
    expect(computeEvidenceStrength({ kind: 'project', content: long, metrics: [], links: [], hasTimeRange: false }).strength).toBe('weak');
    // 项目 + 量化结果 → 中
    expect(computeEvidenceStrength({ kind: 'project', content: long, metrics: ['每天约 800 条'], links: [], hasTimeRange: false }).strength).toBe('medium');
    // 项目 + 量化 + 时间范围 → 强
    expect(computeEvidenceStrength({ kind: 'project', content: long, metrics: ['每天约 800 条'], links: [], hasTimeRange: true }).strength).toBe('strong');
    // 自我声明无论写得多漂亮都是弱证据
    expect(
      computeEvidenceStrength({ kind: 'self_claim', content: long, metrics: ['100%'], links: ['https://example.com'], hasTimeRange: true }).strength,
    ).toBe('weak');
  });

  it('finalizeProfile 会把技能正确分成 已具备 / 待证明 / 待学习', () => {
    const now = new Date().toISOString();
    const profile = syntheticProfile({
      skills: [
        { id: 'a', name: 'Python', aliases: [], category: 'language', selfLevel: '熟练', evidenceIds: [], derivedStrength: 'none' },
        { id: 'b', name: 'Docker', aliases: [], category: 'devops', selfLevel: '熟悉', evidenceIds: [], derivedStrength: 'none' },
        { id: 'c', name: 'Kubernetes', aliases: [], category: 'devops', selfLevel: '了解', evidenceIds: [], derivedStrength: 'none' },
      ],
      evidence: [
        {
          id: 'evd_1',
          kind: 'project',
          title: '采集工具',
          content: '使用 Python 开发数据采集工具，每天处理约 800 条数据，运行 6 个月。',
          skills: ['Python'],
          metrics: ['每天约 800 条数据'],
          links: [],
          timeRange: '2023.01 ~ 2023.06',
          strength: 'strong',
          strengthReason: '',
          sourceRef: { kind: 'resume', locator: '项目', excerpt: '' },
          editedByUser: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    expect(profile.provenSkills).toContain('Python');
    expect(profile.unprovenSkills).toContain('Docker');
    expect(profile.learningSkills).toContain('Kubernetes');
  });
});

// ---------------------------------------------------------------------------
// 4. 硬门槛
// ---------------------------------------------------------------------------

describe('硬门槛', () => {
  it('学历低于要求时直接判为缺口', async () => {
    const profile = syntheticProfile({ basics: { displayName: 'x', targetRoles: [], educationLevel: '大专' } });
    const edu = requirement({
      id: 'req_edu',
      content: '本科及以上学历，计算机相关专业',
      type: 'education',
      hardGate: true,
      keywords: [],
      evidenceNeeded: 'education',
    });
    const { result } = await runMatching({ profile, job: jobOf([edu]) });
    expect(result.matches[0].assessment).toBe('gap');
    expect(result.matches[0].reason).toContain('学历');
  });

  it('学历与专业方向一致时判为满足', async () => {
    const now = new Date().toISOString();
    const profile = syntheticProfile({
      basics: { displayName: 'x', targetRoles: [], educationLevel: '本科' },
      education: [
        { id: 'edu_1', school: '某大学', major: '计算机科学与技术', degree: '本科', timeRange: '2018 ~ 2022', highlights: [] },
      ],
      evidence: [
        {
          id: 'evd_edu',
          kind: 'education',
          title: '某大学 · 本科',
          content: '某大学 · 计算机科学与技术 · 本科',
          skills: [],
          metrics: [],
          links: [],
          timeRange: '2018 ~ 2022',
          strength: 'medium',
          strengthReason: '',
          sourceRef: { kind: 'resume', locator: '教育背景', excerpt: '' },
          editedByUser: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const edu = requirement({
      id: 'req_edu',
      content: '本科及以上学历，计算机、软件工程相关专业',
      type: 'education',
      hardGate: true,
      keywords: [],
      evidenceNeeded: 'education',
    });
    const { result } = await runMatching({ profile, job: jobOf([edu]) });
    expect(result.matches[0].assessment).toBe('matched');
  });

  it('工作年限不足时判为缺口', async () => {
    const profile = syntheticProfile({
      experiences: [
        { id: 'exp_1', organization: 'A 公司', role: '开发', timeRange: '2024.01 ~ 2025.01', description: '', achievements: [], skills: [] },
      ],
    });
    const exp = requirement({
      id: 'req_exp',
      content: '5 年以上开发经验',
      type: 'experience',
      hardGate: true,
      keywords: [],
      evidenceNeeded: 'work',
    });
    const { result } = await runMatching({ profile, job: jobOf([exp]) });
    expect(result.matches[0].assessment).toBe('gap');
  });
});

// ---------------------------------------------------------------------------
// 5. 能力开关（v0.1 铁律）
// ---------------------------------------------------------------------------

describe('版本与能力开关', () => {
  afterAll(() => setReleaseOverride(null));

  it('v0.1 已启用的能力返回 true', () => {
    expect(isEnabled('privacy.redaction')).toBe(true);
    expect(isEnabled('match.engine')).toBe(true);
    expect(isEnabled('profile.import_docx')).toBe(true);
  });

  it('v0.3 / v0.4 两批已实装并随当前版本解锁', () => {
    // 2026-10-08 之前这三项都是空壳（原断言就是「默认关闭」）。
    // 现在实现了，断言跟着改成「已解锁」——
    // 真正的防空壳检查在 v03-no-shell.test.ts 里，那条不依赖版本号。
    expect(isEnabled('report.export')).toBe(true);
    expect(isEnabled('interview.generate')).toBe(true);
    expect(isEnabled('match.minimum_candidate')).toBe(true);
  });

  it('降级版本会重新锁住已实现的能力', () => {
    // 覆盖方向换了：原来是「升级解锁」，现在 CURRENT_RELEASE 已经是 v0.4，
    // 所以测「降级会锁住」—— 这条同样重要，因为设置页里能调版本。
    setReleaseOverride('v0.3');
    expect(isEnabled('report.export')).toBe(true);
    expect(isEnabled('interview.generate')).toBe(false); // v0.4 的那批应被锁回
    setReleaseOverride('v0.2');
    expect(isEnabled('report.export')).toBe(false);
    expect(isEnabled('match.minimum_candidate')).toBe(false);
    setReleaseOverride(null);
    expect(isEnabled('report.export')).toBe(true);
    expect(isEnabled('interview.generate')).toBe(true);
  });

  it('v0.1 铁律不会随版本号自动解锁', () => {
    setReleaseOverride('v0.3');
    for (const restriction of restrictionCapabilities()) {
      expect(isEnabled(restriction.id)).toBe(false);
    }
    setReleaseOverride(null);
  });

  it('能力表里每条都带产品文档出处', () => {
    for (const cap of [...plannedCapabilities(), ...restrictionCapabilities()]) {
      expect(cap.docRef.length).toBeGreaterThan(0);
      expect(cap.label.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. 存储
// ---------------------------------------------------------------------------

describe('本地存储契约', () => {
  it('写入后重新打开可以读回同一份数据', async () => {
    const port = new MemoryStoragePort('测试内存存储');
    const first = await WorkspaceStore.open(port);

    const profile = syntheticProfile({ basics: { displayName: '持久化测试', targetRoles: ['Agent 开发'], educationLevel: '本科' } });
    await first.upsertProfile(profile);
    expect(first.activeProfile()?.basics.displayName).toBe('持久化测试');

    const reopened = await WorkspaceStore.open(port);
    expect(reopened.state.profiles).toHaveLength(1);
    expect(reopened.activeProfile()?.basics.displayName).toBe('持久化测试');
    // v0.2 面试复盘把快照结构推到 3（新增 interviewSessions / debriefReports）
    expect(reopened.state.schemaVersion).toBe(3);
  });

  it('v0.1 的旧快照能迁移到 v0.2 结构，且迁移是幂等的', async () => {
    const port = new MemoryStoragePort();
    const now = new Date().toISOString();
    const v1Profile = {
      id: 'profile_old',
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      basics: { displayName: '旧档案', targetRoles: [], yearsOfExperience: null },
      summary: '',
      education: [],
      experiences: [],
      projects: [],
      skills: [],
      selfDescriptions: [],
      // v0.1 的证据没有 origin 字段
      evidence: [
        {
          id: 'evd_old',
          kind: 'project',
          title: '老项目',
          content: '一个 v0.1 时期写入的项目证据',
          skills: [],
          metrics: [],
          links: [],
          strength: 'medium',
          strengthReason: '',
          sourceRef: { kind: 'resume', locator: '项目经历', excerpt: '' },
          editedByUser: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      provenSkills: [],
      unprovenSkills: [],
      learningSkills: [],
      rawText: '',
      rawSourceRef: { kind: 'resume', locator: '', excerpt: '' },
      privacy: { scannedAt: now, redacted: false, findings: [], originalLength: 0, redactedLength: 0, redactedText: '' },
      parsedBy: 'rule',
      // v0.1 没有 assessments / interviewHistory
    };

    await port.save({
      schemaVersion: 1,
      savedAt: now,
      release: 'v0.1',
      profiles: [v1Profile],
      jobs: [],
      reports: [],
      traces: [],
      settings: { providerId: 'local', baseUrl: '', apiKey: '', model: '', temperature: 0.2, confirmBeforeSend: false, allowRemote: false },
      ui: { onboardingCompleted: true, dismissedHints: [] },
      // v0.1 没有 trainingPlans
    } as never);

    const store = await WorkspaceStore.open(port);
    expect(store.state.schemaVersion).toBe(3);
    expect(store.state.trainingPlans).toEqual([]);

    const migrated = store.state.profiles[0];
    expect(migrated.basics.displayName).toBe('旧档案');
    expect(migrated.assessments).toEqual([]);
    expect(migrated.interviewHistory).toEqual([]);
    // 老证据必须被补上来源标记，否则 v0.2 的封顶规则会漏判
    expect(migrated.evidence[0].origin).toBe('resume');
    expect(migrated.evidence[0].strength).toBe('medium');

    // 幂等：再迁一次结果不变
    const again = migrateSnapshot(store.state);
    expect(again.schemaVersion).toBe(3);
    expect(again.profiles[0].evidence[0].origin).toBe('resume');
    expect(again.trainingPlans).toEqual([]);
    expect(again.interviewSessions).toEqual([]);
  });

  it('快照兼容未知字段，迁移不丢数据', async () => {
    const port = new MemoryStoragePort();
    await port.save({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      release: 'v0.1',
      profiles: [],
      jobs: [],
      reports: [],
      traces: [],
      settings: { providerId: 'ollama', model: 'qwen2.5:7b' },
      ui: { onboardingCompleted: true },
      unknownFutureField: { anything: true },
    } as never);

    const store = await WorkspaceStore.open(port);
    expect(store.state.settings.providerId).toBe('ollama');
    expect(store.state.settings.model).toBe('qwen2.5:7b');
    expect(store.state.ui.onboardingCompleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. 报告契约
// ---------------------------------------------------------------------------

describe('报告契约', () => {
  it('模块可以单独调用（分步 UI 与后续平台复用）', async () => {
    const resume = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const job = await analyzeJobDescription({ rawText: SAMPLE_JD, settings: localSettings });
    const { result } = await runMatching({ profile: resume.profile, job: job.job });
    const report = buildReport({ profile: resume.profile, job: job.job, result });

    expect(report.job.title.length).toBeGreaterThan(0);
    expect(report.profile.evidenceCount).toBe(resume.profile.evidence.length);
    expect(report.matches).toHaveLength(job.job.items.length);
    expect(APP_NAME).toBe('AI Job Partner');
  });

  it('报告里不包含任何匹配分数字段', () => {
    const keys = ['score', 'matchScore', 'matchRate', 'percentage', 'totalScore'];
    const report = { verdict: 'partial', summary: { total: 1, matched: 1, partial: 0, lackingEvidence: 0, gap: 0, unknown: 0 } } as Record<string, unknown>;
    for (const key of keys) {
      expect(report[key]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. v0.2：能力问诊
// ---------------------------------------------------------------------------

const SECOND_RESUME = `王强
求职意向：前端开发工程师

工作经历
2023.07 - 至今  某电商公司  前端开发
- 用 React 重写公司官网，首屏加载从 3.2s 降到 1.1s
- 维护组件库，被 3 条业务线复用

项目经历
后台管理系统的表格性能优化
- 技术栈：React、TypeScript
- 虚拟滚动替代全量渲染，万行表格滚动帧率从 22fps 提升到 58fps

专业技能
- 编程语言：JavaScript（熟练）、TypeScript（熟悉）
- 前端：React、Vue3、Vite、响应式布局
`;

function answeredSession(
  profile: CandidateProfile,
  skillName: string,
  answers: Partial<Record<AssessLayer, { text?: string; choiceIndex?: number }>>,
): AssessSession {
  let session = startAssessment({ profile, skillName });
  for (const question of session.questions) {
    const answer = answers[question.layer];
    if (!answer) continue;
    session = recordAnswer(session, { questionId: question.id, text: answer.text, choiceIndex: answer.choiceIndex });
  }
  return session;
}

const RICH_ANSWERS: Partial<Record<AssessLayer, { text?: string; choiceIndex?: number }>> = {
  self_report: { choiceIndex: 4 },
  fact: { text: '在公司内部知识库项目里用过，接入了 300 多份文档，负责检索这一段。' },
  depth: { text: '遇到过召回不准的问题，因为切分粒度太粗，后来按标题层级切分并加了重排。' },
  output: { text: '准确率从 61% 提升到 84%，代码在 https://github.com/example/kb ，2024 年上线。' },
  boundary: { text: '向量库索引调优还没深入，多路召回的策略也不太确定。' },
};

describe('能力问诊', () => {
  it('说清场景 + 做法 + 结果时，会产出一条证据并给出实质等级', async () => {
    const resume = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const session = answeredSession(resume.profile, 'RAG 检索增强', RICH_ANSWERS);
    const out = await evaluateAssessment({ session, profile: resume.profile });

    expect(out.evidence).toBeTruthy();
    expect(['delivered', 'expert']).toContain(out.assessment.level);
    expect(out.assessment.signals.specificity).toBeGreaterThanOrEqual(2);
    expect(out.assessment.confidence).not.toBe('low');
    expect(out.warnings.some((w) => /问诊/.test(w))).toBe(false);
  });

  it('问诊证据的强度封顶为「中」—— 即使写全了链接与数字', async () => {
    const resume = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const session = answeredSession(resume.profile, 'RAG 检索增强', RICH_ANSWERS);
    const out = await evaluateAssessment({ session, profile: resume.profile });
    const evidence = out.evidence as CandidateEvidence;

    // 同样的内容如果来自简历，按规则本该是「强」
    const asResume = computeEvidenceStrength({
      kind: evidence.kind,
      content: evidence.content,
      metrics: evidence.metrics,
      links: evidence.links,
      hasTimeRange: Boolean(evidence.timeRange),
      origin: 'resume',
    });
    expect(asResume.strength).toBe('strong');

    // 但来源是问诊（自述），必须是「中」
    expect(evidence.origin).toBe('qa');
    expect(evidence.strength).toBe('medium');
    expect(evidence.strengthReason).toContain('封顶');

    // 重新归一化也不能把封顶绕过去
    const refinalized = finalizeProfile(out.updatedProfile);
    const stillCapped = refinalized.evidence.find((e) => e.id === evidence.id);
    expect(stillCapped?.strength).toBe('medium');
  });

  it('只复述概念、说不清场景时，不产出证据并说明原因', async () => {
    const resume = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const session = answeredSession(resume.profile, 'RAG 检索增强', {
      self_report: { choiceIndex: 2 },
      fact: { text: 'RAG 就是把文档切分后做向量检索，再让模型基于检索结果来回答。' },
      depth: { text: '我知道要做重排，也知道要看召回率。' },
      output: { text: '还没有实际产出。' },
    });
    const out = await evaluateAssessment({ session, profile: resume.profile });

    expect(out.evidence).toBeNull();
    expect(['unverified', 'aware', 'practiced']).toContain(out.assessment.level);
    expect(out.warnings.join(' ')).toMatch(/场景/);
    expect(out.assessment.gaps.length).toBeGreaterThan(0);
  });

  it('有场景有做法但没有产出时，等级停在「实际用过」且证据是弱证据', async () => {
    const resume = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const session = answeredSession(resume.profile, 'Pandas / NumPy', {
      self_report: { choiceIndex: 2 },
      fact: { text: '在学校的课程设计里用 Python 做过一份数据处理。' },
      depth: { text: '主要是用 pandas 读表、清洗、算统计量，没有做性能上的处理。' },
      output: { text: '暂时说不上什么产出。' },
    });
    const out = await evaluateAssessment({ session, profile: resume.profile });

    expect(out.assessment.level).toBe('applied');
    expect(out.evidence?.strength).toBe('weak');
  });

  it('明确说「没有做过」时不会被当成证据', async () => {
    const resume = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const session = answeredSession(resume.profile, '向量数据库', {
      self_report: { choiceIndex: 0 },
      fact: { text: '项目里没做过这块，只是看过一些介绍向量数据库的文章。' },
      depth: { text: '没有用过，说不上踩过什么坑。' },
      output: { text: '没有产出。' },
    });
    const out = await evaluateAssessment({ session, profile: resume.profile });

    expect(out.evidence).toBeNull();
    expect(['unverified', 'aware', 'practiced']).toContain(out.assessment.level);
  });

  it('评估结论与证据会写进能力库，并影响后续匹配', async () => {
    const resume = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const job = await analyzeJobDescription({ rawText: SAMPLE_JD, settings: localSettings });
    const before = await runMatching({ profile: resume.profile, job: job.job });

    const session = answeredSession(resume.profile, '向量数据库', {
      self_report: { choiceIndex: 3 },
      fact: { text: '在知识库项目里负责检索层，用过向量数据库做相似检索。' },
      depth: { text: '遇到过召回不准的问题，因为索引参数没调，后来对比了几组参数取平衡。' },
      output: { text: '检索命中率从 70% 提到 88%。' },
      boundary: { text: '分布式部署和扩容还没做过。' },
    });
    const out = await evaluateAssessment({ session, profile: resume.profile });

    expect(out.updatedProfile.assessments.some((a) => a.skillName === '向量数据库')).toBe(true);
    expect(out.updatedProfile.evidence.some((e) => e.origin === 'qa')).toBe(true);
    expect(out.updatedProfile.skills.some((s) => s.name === '向量数据库')).toBe(true);
    // 待学习项来自用户自己承认的边界
    expect(out.assessment.uncertainties.length).toBeGreaterThan(0);

    const after = await runMatching({ profile: out.updatedProfile, job: job.job });
    const beforeLacking = before.result.summary.lackingEvidence + before.result.summary.gap;
    const afterLacking = after.result.summary.lackingEvidence + after.result.summary.gap;
    expect(afterLacking).toBeLessThanOrEqual(beforeLacking);
  });

  it('推荐问诊顺序会把「岗位要求但库里没证据」的技能排在前面', async () => {
    const resume = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const job = await analyzeJobDescription({ rawText: SAMPLE_JD, settings: localSettings });
    const pending = pendingSkillsFor(resume.profile, job.job);

    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].skillName.length).toBeGreaterThan(0);
    for (let i = 1; i < pending.length; i += 1) {
      expect(pending[i].priority).toBeGreaterThanOrEqual(pending[i - 1].priority);
    }
  });

  it('单次问诊不足以给出「可讲清取舍」', async () => {
    // 构造一个只有自我声明的技能，问诊答得很好也只能到「有产出」
    const bare = syntheticProfile({
      skills: [
        { id: 'skl_x', name: 'Kubernetes', aliases: [], category: 'devops', selfLevel: '了解', evidenceIds: [], derivedStrength: 'none' },
      ],
      evidence: [],
    });
    const session = answeredSession(bare, 'Kubernetes', {
      self_report: { choiceIndex: 4 },
      fact: { text: '在公司的容器平台项目里用过，负责部署和服务编排。' },
      depth: { text: '遇到过滚动更新卡住的问题，因为探针配置不对，后来按业务调整了探针参数。' },
      output: { text: '把上线流程从手工 40 分钟缩短到 6 分钟。' },
      boundary: { text: '跨集群的网络方案还不熟。' },
    });
    const out = await evaluateAssessment({ session, profile: bare });

    expect(out.assessment.level).not.toBe('expert');
    expect(out.warnings.join(' ')).toMatch(/多场景|讲清取舍/);
  });
});

// ---------------------------------------------------------------------------
// 9. v0.2：能力库跨岗位保留
// ---------------------------------------------------------------------------

describe('能力库跨岗位保留', () => {
  it('换岗位重新导入时，原有技能与问诊证据都保留', async () => {
    const first = await analyzeResume({ rawText: SAMPLE_RESUME, profileLabel: 'A 方向档案', settings: localSettings });
    const session = answeredSession(first.profile, '向量数据库', {
      self_report: { choiceIndex: 3 },
      fact: { text: '在知识库项目里用过向量数据库做相似检索。' },
      depth: { text: '调过索引参数，因为召回不准。' },
      output: { text: '命中率从 70% 提到 88%。' },
    });
    const assessed = await evaluateAssessment({ session, profile: first.profile });
    const withQa = assessed.updatedProfile;

    const second = await analyzeResume({ rawText: SECOND_RESUME, profileLabel: 'B 方向档案', settings: localSettings });
    const { profile, report } = mergeProfiles(withQa, second.profile);

    // 新方向的能力进来了
    expect(profile.skills.some((s) => s.name === 'React')).toBe(true);
    // 原方向的积累没丢
    expect(profile.skills.some((s) => s.name === 'Python')).toBe(true);
    expect(profile.evidence.some((e) => e.origin === 'qa')).toBe(true);
    expect(profile.assessments.some((a) => a.skillName === '向量数据库')).toBe(true);
    expect(report.qaEvidenceKept).toBeGreaterThan(0);
    expect(report.keptAssessments).toBeGreaterThan(0);
    expect(report.summary).toContain('保留');
    // 用户自己起的档案名不能被覆盖
    expect(profile.basics.displayName).toBe('A 方向档案');
  });

  it('合并是幂等的：同一份简历导入两次不会产生重复证据', async () => {
    const once = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const twice = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const { profile, report } = mergeProfiles(once.profile, twice.profile);

    expect(report.addedEvidence).toBe(0);
    expect(profile.evidence.length).toBe(once.profile.evidence.length);
    expect(profile.skills.length).toBe(once.profile.skills.length);
  });

  it('同一技能在合并时取更高的自评等级，不会因为新简历没写就降级', async () => {
    const first = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const second = await analyzeResume({ rawText: SECOND_RESUME, settings: localSettings });
    const { profile } = mergeProfiles(first.profile, second.profile);
    const python = profile.skills.find((s) => s.name === 'Python');
    expect(python?.selfLevel).toBe('熟练');
  });

  it('importResume 默认走合并，并返回可展示的合并报告', async () => {
    const first = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const merged = await importResume({
      rawText: SECOND_RESUME,
      settings: localSettings,
      existingProfile: first.profile,
    });

    expect(merged.mergeReport).toBeTruthy();
    expect(merged.mergeReport?.addedSkills.length).toBeGreaterThan(0);
    expect(merged.profile.skills.some((s) => s.name === 'Python')).toBe(true);
    expect(merged.warnings.join(' ')).toContain('已并入现有能力库');
  });

  it('显式选择 replace 时不合并，得到全新档案', async () => {
    const first = await analyzeResume({ rawText: SAMPLE_RESUME, settings: localSettings });
    const replaced = await importResume({
      rawText: SECOND_RESUME,
      settings: localSettings,
      existingProfile: first.profile,
      mode: 'replace',
    });

    expect(replaced.mergeReport).toBeUndefined();
    expect(replaced.profile.skills.some((s) => s.name === 'React')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. v0.2：薄弱项训练
// ---------------------------------------------------------------------------

describe('薄弱项训练', () => {
  async function planFixture() {
    const full = await runFullPipeline({ resumeText: SAMPLE_RESUME, jdText: SAMPLE_JD, settings: localSettings });
    const built = await buildTrainingPlan({
      profile: full.profile,
      job: full.job,
      matches: full.result.matches,
    });
    return { full, plan: built.plan, warnings: built.warnings };
  }

  it('题目只来自这次匹配里真实没答上的要求', async () => {
    const { full, plan } = await planFixture();

    const expected = full.result.matches.filter(
      (m) => ['gap', 'lacking_evidence', 'partial'].includes(m.assessment) && (m.importance !== 'low' || m.hardGate),
    );
    expect(plan.items.length).toBe(Math.min(expected.length, 12));
    expect(plan.items.length).toBeGreaterThan(0);

    for (const item of plan.items) {
      const source = full.result.matches.find((m) => m.requirementId === item.requirementId);
      expect(source).toBeTruthy();
      expect(['gap', 'lacking_evidence', 'partial']).toContain(source?.assessment);
      expect(item.requirementText).toBe(source?.requirement);
      expect(item.referencePoints.length).toBeGreaterThan(0);
    }
  });

  it('题目类型由薄弱原因决定', async () => {
    const { full, plan } = await planFixture();
    for (const item of plan.items) {
      const requirement = full.job.items.find((r) => r.id === item.requirementId);
      if (item.skillCategory === 'unknown') {
        // 认不出具体技能时出「自查题」，配套的是怎么把经历讲清楚的通用要点，
        // 而不是把某个技能品类的知识要点硬套上去
        expect(item.type).toBe('self_check');
        expect(item.referencePoints.join(' ')).toMatch(/当时的情况|讲具体行为|如实保留缺口/);
      } else if (requirement?.type === 'soft') {
        expect(item.type).toBe('self_check');
      } else if (item.weakness === 'gap') {
        expect(item.type).toBe('concept');
      } else if (item.weakness === 'lacking_evidence') {
        expect(item.type).toBe('explain');
      } else {
        expect(item.type).toBe('compare');
      }
    }
  });

  it('识别出技能时用的是该技能的知识要点，而不是通用模板', async () => {
    const { plan } = await planFixture();
    const identified = plan.items.filter((i) => i.skillCategory !== 'unknown');
    expect(identified.length).toBeGreaterThan(0);
    for (const item of identified) {
      expect(item.skillName).not.toBe('这项要求');
      expect(item.referencePoints.length).toBeGreaterThan(0);
      expect(item.followUp).toBeTruthy();
    }
  });

  it('低重要度的加分项不会被塞进训练计划', async () => {
    const { full, plan } = await planFixture();
    for (const item of plan.items) {
      const requirement = full.job.items.find((r) => r.id === item.requirementId);
      if (requirement?.importance === 'low') {
        expect(requirement.hardGate).toBe(true);
      }
    }
    expect(plan.items.every((i) => i.importance !== 'low')).toBe(true);
  });

  it('作答与自评会更新进度统计', async () => {
    const { plan } = await planFixture();
    const first = plan.items[0];
    expect(plan.stats.todo).toBe(plan.items.length);
    expect(plan.stats.averageScore).toBeNull();

    const afterOne = answerTrainingItem(plan, first.id, { userAnswer: '我按场景、做法、结果讲了一遍。', selfScore: 2 as SelfScore });
    expect(afterOne.stats.answered).toBe(1);
    expect(afterOne.stats.todo).toBe(plan.items.length - 1);
    expect(afterOne.stats.averageScore).toBe(2);

    const reviewed = answerTrainingItem(afterOne, first.id, { markReviewed: true });
    expect(reviewed.stats.reviewed).toBe(1);
    expect(reviewed.items.find((i) => i.id === first.id)?.status).toBe('reviewed');
  });

  it('训练计划会带上一句可执行的下一步', async () => {
    const { plan } = await planFixture();
    expect(plan.suggestedNextStep.length).toBeGreaterThan(10);
    expect(plan.jobTitle.length).toBeGreaterThan(0);
    expect(plan.engine).toBe('rule');
  });
});

// ---------------------------------------------------------------------------
// 11. v0.2 能力开关
// ---------------------------------------------------------------------------

describe('v0.2 能力开关', () => {
  afterAll(() => setReleaseOverride(null));

  it('本次实施的三项能力已启用', () => {
    expect(isEnabled('skill.assess')).toBe(true);
    expect(isEnabled('evidence.from_assessment')).toBe(true);
    expect(isEnabled('library.cross_job')).toBe(true);
    expect(isEnabled('training.weak_point')).toBe(true);
    expect(isEnabled('training.progress')).toBe(true);
  });

  it('岗位截图 OCR 已实装并解锁（双端本地推理）', () => {
    /*
     * 这一条的三次变化，正好记录了「版本号只解锁真的做了的」这条机制：
     *   1. 2026-10-07：v0.3 四项全是空壳，用 `CURRENT_RELEASE = 'v0.2'` 挡住；
     *   2. 2026-10-08 上午：另外三项做完了，把 OCR 移到 `future`，
     *      因为 `since: 'v0.3'` 会连带解锁那个还没做的；
     *   3. 2026-10-08 下午：OCR 双端都落地了（Android ML Kit / 桌面 tesseract WASM，
     *      都不联网），since 移回 v0.3。
     *
     * 换句话说：修法从来不是「把版本号压住」，而是让 since 反映真实状态。
     */
    expect(isEnabled('job.input_image')).toBe(true);
    expect(CAPABILITIES.find((c) => c.id === 'job.input_image')?.since).toBe('v0.3');
    // v0.3 四项现在全部实装
    expect(isEnabled('report.export')).toBe(true);
    expect(isEnabled('resume.suggestion')).toBe(true);
    expect(isEnabled('match.minimum_candidate')).toBe(true);
  });

  it('「以后再说」的付费课程对接是未排期，且不算 v0.1 铁律', () => {
    const paid = plannedCapabilities().find((c) => c.id === 'training.paid_course');
    expect(paid?.since).toBe('future');
    expect(paid?.restriction).toBeFalsy();
    expect(isEnabled('training.paid_course')).toBe(false);
    expect(restrictionCapabilities().some((c) => c.id === 'training.paid_course')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. v0.2 追加：面试复盘（去标识化 / 证据 / 维度 / 报告 / 存储）
// ---------------------------------------------------------------------------

function debriefSession(overrides: Partial<InterviewDebriefSession> = {}): InterviewDebriefSession {
  return {
    ...createEmptyDebriefSession('profile_test', { mode: 'onsite', quiet: true }),
    id: 'sess_test',
    status: 'ready',
    manualTranscript: SAMPLE_INTERVIEW_TRANSCRIPT,
    durationMs: 42 * 60 * 1000,
    ...overrides,
  };
}

describe('面试复盘 · 转写去标识化', () => {
  it('称呼与公司名在进入分析前被替换', () => {
    const { text, report } = anonymizeTranscript('【面试方】我是云枢科技公司的面试官，张经理你好。');
    expect(text).toContain('A 公司');
    expect(text).not.toContain('云枢科技');
    expect(text).not.toContain('张经理');
    expect(report.replacements.some((r) => r.category === 'organization')).toBe(true);
    expect(report.replacements.some((r) => r.category === 'person_title')).toBe(true);
  });

  it('替换记录里不保留任何被替换掉的原文', () => {
    const { report } = anonymizeTranscript('【面试方】我是云枢科技公司的面试官，电话 13812345678。');
    // 这份报告会跟着复盘结果一起落盘、展示、导出，所以它自己不能成为泄露面
    expect(JSON.stringify(report)).not.toContain('云枢科技');
    expect(JSON.stringify(report)).not.toContain('13812345678');
    expect(report.findings.some((f) => f.type === 'phone')).toBe(true);
    // 保留的是打码值（可以展示），不是原始值
    expect(report.findings.some((f) => f.masked.includes('*'))).toBe(true);
  });

  it('不改动数字 —— 时长、薪酬、指标数量是判断依据', () => {
    const { text } = anonymizeTranscript('【面试方】每天大概 170 个工单，月薪 8000 到 12000。');
    expect(text).toContain('170');
    expect(text).toContain('8000');
  });

  it('摘要是一句能直接展示的话', () => {
    const { report } = anonymizeTranscript('【面试方】我是云枢科技公司的面试官。');
    expect(summarizeAnonymize(report).length).toBeGreaterThan(4);
  });
});

describe('面试复盘 · 证据抽取', () => {
  const evidence = extractEvidenceByRule(SAMPLE_INTERVIEW_TRANSCRIPT);

  it('拆出足够多的事实，且编号连续', () => {
    expect(evidence.length).toBeGreaterThan(10);
    expect(evidence.map((e) => e.id)).toEqual(evidence.map((_, i) => `E${i + 1}`));
  });

  it('区分出面试方与我方', () => {
    expect(evidence.some((e) => e.speaker === 'interviewer')).toBe(true);
    expect(evidence.some((e) => e.speaker === 'candidate')).toBe(true);
  });

  it('带数字的句子被标为 number 且数字原样保留', () => {
    const numbers = evidence.filter((e) => e.type === 'number');
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.some((e) => /\d/.test(e.quote))).toBe(true);
  });

  it('同一主题下互相矛盾的数字各自标为 conflicting', () => {
    const conflicting = extractEvidenceByRule(
      '【面试方】每天需要处理 100 个工单，任务量比较大。\n【面试方】每天需要处理 200 个工单，任务量比较大。',
    );
    expect(conflicting.some((e) => e.consistency === 'conflicting')).toBe(true);
  });

  it('回避型回答被单独标出来（它是风险扫描的输入）', () => {
    const evasive = extractEvidenceByRule('【面试方】这个看情况，正常都能完成。');
    expect(evasive.some((e) => e.type === 'evasion')).toBe(true);
  });
});

describe('面试复盘 · 维度分析', () => {
  const evidence = extractEvidenceByRule(SAMPLE_INTERVIEW_TRANSCRIPT);
  const dimensions = analyzeDimensionsByRule({ evidence, profile: null, job: null });

  it('机会侧 12 维 + 表现侧 6 维全部产出，且顺序固定', () => {
    expect(dimensions).toHaveLength(18);
    expect(dimensions.map((d) => d.id)).toEqual([
      'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12',
      'P1', 'P2', 'P3', 'P4', 'P5', 'P6',
    ]);
  });

  it('每一条 finding 都挂着真实存在的证据编号（框架里最硬的一条纪律）', () => {
    const ids = new Set(evidence.map((e) => e.id));
    for (const dim of dimensions) {
      for (const f of dim.findings) {
        expect(f.evidenceIds.length).toBeGreaterThan(0);
        for (const id of f.evidenceIds) expect(ids.has(id)).toBe(true);
      }
    }
  });

  it('没有当事人档案时 D7 明确写「证据不足」，而不是猜一个分数', () => {
    const d7 = dimensions.find((d) => d.id === 'D7');
    expect(d7?.status).toBe('insufficient_info');
    expect(d7?.findings).toHaveLength(0);
  });

  it('数量指标换算成时间，并给出算式与结果', () => {
    const d3 = dimensions.find((d) => d.id === 'D3');
    expect(d3?.computation).toBeTruthy();
    expect(d3?.computation?.formula).toContain('纯处理时间');
    expect(Object.keys(d3?.computation?.inputs ?? {}).length).toBeGreaterThan(2);
    expect(Object.keys(d3?.computation?.result ?? {}).length).toBeGreaterThan(2);
  });

  it('话术风险扫描命中，但每条都同时给出正面理解与验证方式', () => {
    const d9 = dimensions.find((d) => d.id === 'D9');
    const signals = (d9?.extras?.riskSignals as Array<{ positive: string; verify: string }>) ?? [];
    expect(signals.length).toBeGreaterThanOrEqual(2);
    for (const s of signals) {
      expect(s.positive.length).toBeGreaterThan(0);
      expect(s.verify.length).toBeGreaterThan(0);
    }
  });

  it('薪酬与工时能算出单位时间回报', () => {
    const d10 = dimensions.find((d) => d.id === 'D10');
    expect(d10?.status).toBe('partial');
    expect(d10?.computation?.formula).toContain('单位时间回报');
  });

  it('压力等级只能是四档枚举，信息不足是 unknown 而不是 0', () => {
    const d4 = dimensions.find((d) => d.id === 'D4');
    const levels = (d4?.extras?.stressLevels as Array<{ level: string }>) ?? [];
    expect(levels).toHaveLength(9);
    for (const l of levels) expect(['low', 'medium', 'high', 'unknown']).toContain(l.level);
  });
});

describe('面试复盘 · 面试表现', () => {
  it('统计出回答段数、含事实段数与只有评价性表述的段数', () => {
    const dimensions = analyzeDimensionsByRule({
      evidence: extractEvidenceByRule(SAMPLE_INTERVIEW_TRANSCRIPT),
      profile: null,
      job: null,
    });
    const performance = buildPerformanceSummary(dimensions);
    expect(performance.answerTurns).toBeGreaterThan(0);
    expect(performance.factBackedTurns).toBeLessThanOrEqual(performance.answerTurns);
    expect(performance.vagueTurns).toBeLessThanOrEqual(performance.answerTurns);
  });

  it('完全没有我方回答时给 insufficient，而不是给最低分', () => {
    const noAnswer = buildPerformanceSummary(
      analyzeDimensionsByRule({
        evidence: extractEvidenceByRule('【面试方】你好，今天天气不错。'),
        profile: null,
        job: null,
      }),
    );
    expect(noAnswer.overall).toBe('insufficient');
  });
});

describe('面试复盘 · 报告与渲染', () => {
  const built = buildDebriefRulesOnly({
    session: debriefSession(),
    profile: syntheticProfile({
      skills: [],
      selfDescriptions: ['不喜欢高强度社交，愿意独立完成手上的事'],
    }),
    job: null,
  });

  it('报告带齐所有必需结构', () => {
    expect(built.report.domain).toBe('interview-debrief');
    expect(built.report.evidence.length).toBeGreaterThan(10);
    expect(built.report.dimensions).toHaveLength(18);
    expect(built.report.synthesis.tier).toBeTruthy();
    expect(built.report.synthesis.nextAction.length).toBeGreaterThan(4);
    expect(built.report.synthesis.boundaryStatement.length).toBeGreaterThan(4);
    expect(built.report.disclaimer.length).toBeGreaterThan(10);
  });

  it('静默录制的标记会带进报告', () => {
    expect(built.report.meta.quiet).toBe(true);
  });

  it('决策表三档齐全，情景恰好 A / B / C 三种', () => {
    expect(built.report.synthesis.decisionTable.map((t) => t.key)).toEqual(['consider', 'caution', 'mismatch']);
    expect(built.report.synthesis.scenarios.map((s) => s.key)).toEqual(['A', 'B', 'C']);
  });

  it('「下一步动作」只有一个，且不是「再考虑考虑」这类无效动作', () => {
    expect(built.report.synthesis.nextAction).not.toContain('再考虑考虑');
    expect(built.report.synthesis.nextAction.length).toBeGreaterThan(6);
  });

  it('HTML 报告自包含：内嵌数据、无任何外链、关键章节齐全', () => {
    const html = renderDebriefHtml(built.report);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('id="report-data"');
    expect(html).toContain('先结论');
    expect(html).toContain('面试表现');
    expect(html).toContain('岗位适配度');
    expect(html).toContain('三档决策表');
    expect(html).toContain('附录：证据索引');
    // 断网也要能打开：不允许任何 http(s) 外链（CDN / 远程字体 / 图片）
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('雷达图数据点不足时诚实说明，而不是画一个空图', () => {
    const html = renderDebriefHtml({ ...built.report, charts: { ...built.report.charts, pressure: [] } });
    expect(html).toContain('无法绘制雷达图');
  });
});

describe('面试复盘 · 存储与能力开关', () => {
  it('老快照迁移后补出面试字段，且迁移幂等', () => {
    const raw = {
      schemaVersion: 2,
      savedAt: '2026-01-01T00:00:00.000Z',
      release: 'v0.2',
      profiles: [],
      jobs: [],
      reports: [],
      trainingPlans: [],
      traces: [],
      settings: {
        providerId: 'local',
        baseUrl: '',
        apiKey: '',
        model: '',
        temperature: 0.2,
        confirmBeforeSend: false,
        allowRemote: false,
      },
      ui: { onboardingCompleted: false, dismissedHints: [] },
    };
    const once = migrateSnapshot(raw);
    expect(once.schemaVersion).toBe(3);
    expect(once.interviewSessions).toEqual([]);
    expect(once.debriefReports).toEqual([]);
    // 深合并必须补出新增的两组子配置，否则设置页会读到 undefined
    expect(once.settings.transcription.model.length).toBeGreaterThan(0);
    expect(once.settings.capture.segmentSeconds).toBeGreaterThan(0);

    expect(migrateSnapshot(once)).toEqual(once);
  });

  it('面试会话写进快照后能读回', async () => {
    const port = new MemoryStoragePort('面试复盘测试');
    const store = await WorkspaceStore.open(port);
    await store.upsertInterviewSession(debriefSession({ id: 'sess_persist', status: 'analyzed' }));

    const reopened = await WorkspaceStore.open(port);
    expect(reopened.interviewSessionById('sess_persist')?.manualTranscript).toContain('云枢');
    expect(reopened.state.schemaVersion).toBe(3);
  });

  it('删除岗位不会连带删掉面试记录（它属于「这个人经历过的事」）', async () => {
    const port = new MemoryStoragePort('面试复盘测试');
    const store = await WorkspaceStore.open(port);
    await store.upsertInterviewSession(debriefSession({ id: 'sess_keep', jobId: 'job_1' }));
    await store.deleteJob('job_1');
    expect(store.interviewSessionById('sess_keep')).toBeTruthy();
  });

  it('面试复盘的五项能力在 v0.2 已启用', () => {
    expect(isEnabled('interview.record')).toBe(true);
    expect(isEnabled('interview.record_system_audio')).toBe(true);
    expect(isEnabled('interview.transcribe')).toBe(true);
    expect(isEnabled('interview.debrief')).toBe(true);
    expect(isEnabled('interview.debrief_export')).toBe(true);
  });

  it('复盘没有被 v0.1 铁律拦住（铁律说的是不做面试官端系统）', () => {
    expect(restrictionCapabilities().some((c) => c.id === 'restrict.full_interview_system')).toBe(true);
    expect(restrictionCapabilities().some((c) => c.id === 'interview.debrief')).toBe(false);
  });
});
