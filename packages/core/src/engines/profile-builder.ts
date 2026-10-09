import { AiGateway } from '../ai/gateway';
import { PROFILE_SYSTEM_PROMPT } from '../ai/prompts';
import type { AiMessage, AiTrace } from '../domain/ai-trace';
import type { EvidenceStrength, SourceRef } from '../domain/common';
import { maxStrength } from '../domain/common';
import { computeEvidenceStrength, type CandidateEvidence, type EvidenceKind } from '../domain/evidence';
import type { PrivacyReport } from '../domain/privacy';
import { cityFromFindings } from '../privacy/redactor';
import type {
  CandidateProfile,
  EducationItem,
  ProjectItem,
  SelfLevel,
  SkillItem,
  WorkExperience,
} from '../domain/profile';
import { findSkillsInText, normalizeSkillList, resolveSkill, textMentionsSkill } from '../nlp/skills';
import {
  extractLinks,
  extractMetrics,
  groupEntries,
  matchDateRange,
  sectionLines,
  splitResumeSections,
  type RawEntry,
} from '../parsers/resume-structure';
import { newId, truncate, unique } from '../utils/text';

/**
 * ProfileBuilder —— 简历 → Candidate Profile。
 *
 * 两条路径：
 *   1. 有可用模型时：模型负责「读懂非结构化文本」，产出的内容仍然要被本地规则校验、补全、打分；
 *   2. 没有模型时：本地规则引擎独立完成，保证产品在没有 API Key 的情况下也能跑完整条链路。
 *
 * 无论哪条路径，最终都要经过 finalizeProfile()：
 *   —— 它负责证据强度计算、证据与技能的关联、以及「已证明 / 待证明 / 待学习」的推导。
 *   这一步刻意不交给模型，因为它是整个产品最关键的判断刻度。
 */

export interface BuildProfileInput {
  /** 已脱敏、允许进入分析链路的文本 */
  redactedText: string;
  privacy: PrivacyReport;
  /** 仅用于本地抽取城市等字段，不会发送给模型 */
  originalText?: string;
  /** 用户自己给档案起的名字（不使用简历里的真实姓名） */
  profileLabel?: string;
  gateway?: AiGateway | null;
  onMessages?: (messages: AiMessage[]) => void;
}

export interface BuildProfileResult {
  profile: CandidateProfile;
  trace: AiTrace | null;
  warnings: string[];
  engine: 'ai' | 'rule';
}

const SCHOOL_RE = /([\u4e00-\u9fa5A-Za-z·]{2,24}(?:大学|学院|学校|职业技术学院|University|College|Academy|Institute))/i;
const DEGREE_RE = /(博士|硕士|研究生|本科|学士|大专|专科|高中|中专)/;
const MAJOR_RE = /(?:专业|主修|方向)\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z\s]{2,24})/;
const ROLE_RE = /(实习生|工程师|开发者|开发|运营|产品经理|产品|设计师|设计|分析师|研究员|助理|专员|主管|负责人|经理|顾问|讲师|教师|编辑|前端|后端|全栈|算法|测试|运维|销售|客服|总监)/;
const ORG_RE = /(公司|集团|科技|工作室|实验室|研究院|研究所|银行|医院|学校|大学|有限|事业|中心|部门|团队|传媒|网络|数据|教育|文化)/;

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

/**
 * 技能清单里常见的「分类标签」不是技能本身。
 * 例如「编程语言：Python、Java」中的「编程语言」应该被丢掉，否则档案里会出现一堆无意义的条目。
 */
const CATEGORY_LABEL_BLACKLIST = new Set([
  '编程语言', '开发语言', '语言', '脚本语言', 'ai相关', '人工智能相关', '算法相关', '模型相关',
  '工程工具', '开发工具', '工具', '常用工具', '框架', '框架与库', '类库',
  '数据处理', '数据', '数据库', '数据分析工具', '办公', '办公软件', '常用软件',
  '其他', '其他技能', '技能', '技能特长', '专业技能', '相关技能', '专业知识', '业务知识',
  '软技能', '证书', '语言能力', '外语',
]);

function isCategoryLabel(token: string): boolean {
  const key = token.replace(/\s+/g, '').toLowerCase();
  if (!key) return true;
  if (CATEGORY_LABEL_BLACKLIST.has(key)) return true;
  // 「AI 相关」「算法相关」这类是分类名，不是能力名
  if (key.length <= 6 && /相关$/.test(key)) return true;
  return false;
}

/**
 * 「学历：本科及以上」这类词典项描述的是背景信息，不是技能。
 * 学历已经由 basics.educationLevel 与 education[] 表达，放进技能清单只会制造噪音。
 */
function isSkillEntry(name: string): boolean {
  return !name.startsWith('学历：');
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return unique(v.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim()));
}

function pickSelfLevel(text: string, skillTerms: string[]): SelfLevel {
  const levels: SelfLevel[] = ['精通', '熟练', '熟悉', '了解'];
  for (const level of levels) {
    for (const term of skillTerms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const before = new RegExp(`${escaped}[^。；;\\n]{0,8}?${level}`);
      const after = new RegExp(`${level}[^。；;\\n]{0,8}?${escaped}`, 'i');
      if (before.test(text) || after.test(text)) return level;
    }
  }
  return '未声明';
}

function detectYearsOfExperience(text: string): number | null {
  const explicit = /(\d{1,2})\s*年(?:以上)?[^\n。;；]{0,6}?(?:工作|开发|从业|相关|项目)?经验/.exec(text);
  if (explicit) return Number(explicit[1]);
  const rangeYears = /(\d{1,2})\s*(?:-|~|～|—|至)\s*(\d{1,2})\s*年[^\n。;；]{0,6}?经验/.exec(text);
  if (rangeYears) return Number(rangeYears[1]);
  return null;
}

function detectTargetRoles(text: string): string[] {
  const re = /(?:求职意向|应聘(?:岗位|职位)?|期望(?:职位|岗位|工作)|目标岗位|意向岗位)\s*[:：]?\s*([^\n。；;]{2,40})/g;
  const roles: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const part of m[1].split(/[、,，/|｜]/)) {
      const value = part.trim();
      if (value && value.length <= 20) roles.push(value);
    }
  }
  return unique(roles);
}

function detectEducationLevel(text: string): string {
  if (/博士/.test(text)) return '博士';
  if (/硕士|研究生/.test(text)) return '硕士';
  if (/本科|学士/.test(text)) return '本科';
  if (/大专|专科/.test(text)) return '大专';
  return '';
}

function splitTitle(entry: RawEntry): { left: string; middle: string; right: string } {
  const parts = entry.title
    .split(/[|｜/·]|\s{2,}|——|--|—/)
    .map((p) => p.trim())
    .filter(Boolean);
  const dateRange = matchDateRange(entry.title);
  const cleaned = parts
    .map((p) => (dateRange && p.includes(dateRange.split('~')[0].trim()) ? '' : p))
    .map((p) => p.replace(matchDateRange(entry.title) ?? '', '').trim())
    .filter(Boolean);
  return { left: cleaned[0] ?? entry.title, middle: cleaned[1] ?? '', right: cleaned[2] ?? '' };
}

// ---------------------------------------------------------------------------
// 规则路径
// ---------------------------------------------------------------------------

function buildByRules(input: BuildProfileInput): { profile: CandidateProfile; warnings: string[] } {
  const text = input.redactedText;
  const warnings: string[] = [];
  const structure = splitResumeSections(text);
  const now = new Date().toISOString();
  const sourceRef: SourceRef = { kind: 'resume', locator: '简历原文', excerpt: truncate(text, 160) };

  // ---- 基础信息 ----
  const location = input.originalText
    ? cityFromFindings(input.privacy.findings, input.originalText)
    : undefined;
  const basics = {
    displayName: input.profileLabel?.trim() || '我的档案',
    targetRoles: detectTargetRoles(text),
    yearsOfExperience: detectYearsOfExperience(text),
    educationLevel: detectEducationLevel(text),
    location: location ?? '',
  };

  // ---- 教育 ----
  const educationEntries = groupEntries(sectionLines(structure, 'education'));
  const education: EducationItem[] = educationEntries.map((entry) => {
    const blob = entry.lines.join(' ');
    const school = SCHOOL_RE.exec(blob)?.[1] ?? entry.title;
    const degree = DEGREE_RE.exec(blob)?.[1] ?? '';
    const major = MAJOR_RE.exec(blob)?.[1]?.trim() ?? '';
    return {
      id: newId('edu'),
      school,
      major,
      degree,
      timeRange: matchDateRange(blob),
      highlights: entry.bullets,
    };
  });
  if (educationEntries.length === 0) warnings.push('未识别到「教育背景」段落，档案里没有学历记录');

  // ---- 工作经历 ----
  const workEntries = groupEntries(sectionLines(structure, 'work'));
  const experiences: WorkExperience[] = workEntries.map((entry) => {
    const parts = splitTitle(entry);
    const roleCandidate = [parts.middle, parts.left, parts.right].find((p) => p && ROLE_RE.test(p)) ?? '';
    const orgCandidate = [parts.left, parts.middle, parts.right].find((p) => p && ORG_RE.test(p)) ?? parts.left;
    const blob = [entry.title, ...entry.bullets].join('\n');
    return {
      id: newId('exp'),
      organization: orgCandidate || entry.title,
      role: roleCandidate,
      timeRange: matchDateRange(entry.title),
      description: truncate(blob, 400),
      achievements: entry.bullets,
      skills: findSkillsInText(blob).map((h) => h.def.name),
    };
  });
  if (workEntries.length === 0) warnings.push('未识别到「工作/实习经历」段落');

  // ---- 项目 ----
  const projectEntries = groupEntries(sectionLines(structure, 'project'));
  const projects: ProjectItem[] = projectEntries
    .filter((entry) => entry.bullets.length > 0 || entry.title.length >= 4)
    .map((entry) => {
      const parts = splitTitle(entry);
      const blob = [entry.title, ...entry.bullets].join('\n');
      const links = extractLinks(blob);
      return {
        id: newId('prj'),
        name: parts.left.replace(matchDateRange(entry.title) ?? '', '').trim() || entry.title,
        role: ROLE_RE.test(parts.middle) ? parts.middle : '',
        timeRange: matchDateRange(entry.title),
        description: truncate(blob, 400),
        highlights: entry.bullets,
        skills: findSkillsInText(blob).map((h) => h.def.name),
        links,
      };
    });
  if (projectEntries.length === 0) {
    warnings.push('未识别到「项目经历」段落 —— 这是证据最容易缺失的部分，建议手动补充');
  }

  // ---- 技能 ----
  const skillSectionText = sectionLines(structure, 'skill').join('\n');
  const declaredRaw: string[] = [];
  for (const line of skillSectionText.split(/\n/)) {
    const cleaned = line.replace(/^[\s\-–—•·*※◆■□○●▪‣»>]+/, '').trim();
    if (!cleaned) continue;
    for (const token of cleaned.split(/[、,，/|｜;；:：]+|\s{2,}/)) {
      const value = token
        .replace(/^(熟练|精通|熟悉|了解|掌握|会用|使用|具备|有)/, '')
        .replace(/[（(].*?[)）]/g, '')
        .trim();
      if (value && value.length <= 24 && !isCategoryLabel(value)) declaredRaw.push(value);
    }
  }
  const foundNames = findSkillsInText(text).map((h) => h.def.name);
  const skillNames = normalizeSkillList([...declaredRaw, ...foundNames]).filter(isSkillEntry);

  const skills: SkillItem[] = skillNames.map((name) => {
    const def = resolveSkill(name);
    const terms = def ? [def.name, ...def.aliases] : [name];
    return {
      id: newId('skl'),
      name,
      aliases: def?.aliases ?? [],
      category: def?.kind ?? 'domain',
      selfLevel: skillSectionText ? pickSelfLevel(text, terms) : pickSelfLevel(text, terms),
      evidenceIds: [],
      derivedStrength: 'none' as EvidenceStrength,
    };
  });
  if (skills.length === 0) warnings.push('没有识别到任何技能关键词');

  // ---- 自我描述 ----
  const selfDescriptions = groupEntries(sectionLines(structure, 'self'))
    .map((e) => [e.title, ...e.bullets].join(' ').trim())
    .filter(Boolean);

  // ---- 证据 ----
  const evidence: CandidateEvidence[] = [];
  const pushEvidence = (
    item: Omit<CandidateEvidence, 'id' | 'createdAt' | 'updatedAt' | 'strength' | 'strengthReason' | 'editedByUser' | 'origin'>,
  ) => {
    const computed = computeEvidenceStrength({
      kind: item.kind,
      content: item.content,
      metrics: item.metrics,
      links: item.links,
      hasTimeRange: Boolean(item.timeRange),
      origin: 'resume',
    });
    evidence.push({
      ...item,
      id: newId('evd'),
      origin: 'resume',
      strength: computed.strength,
      strengthReason: computed.reason,
      editedByUser: false,
      createdAt: now,
      updatedAt: now,
    });
  };

  for (const project of projects) {
    const blob = [project.description, ...project.highlights].join(' ');
    pushEvidence({
      kind: 'project',
      title: project.name,
      content: blob,
      skills: project.skills,
      metrics: extractMetrics(blob),
      links: project.links,
      timeRange: project.timeRange,
      sourceRef: { kind: 'resume', locator: `项目经历 · ${project.name}`, excerpt: truncate(blob, 120) },
    });
  }

  for (const exp of experiences) {
    const blob = [exp.description, ...exp.achievements].join(' ');
    pushEvidence({
      kind: 'work',
      title: `${exp.organization}${exp.role ? ` · ${exp.role}` : ''}`,
      content: blob,
      skills: exp.skills,
      metrics: extractMetrics(blob),
      links: extractLinks(blob),
      timeRange: exp.timeRange,
      sourceRef: { kind: 'resume', locator: `工作经历 · ${exp.organization}`, excerpt: truncate(blob, 120) },
    });
  }

  for (const edu of education) {
    const blob = [edu.school, edu.major, edu.degree, ...edu.highlights].filter(Boolean).join(' · ');
    pushEvidence({
      kind: 'education',
      title: `${edu.school}${edu.degree ? ` · ${edu.degree}` : ''}`,
      content: blob,
      skills: edu.degree ? normalizeSkillList([edu.degree]) : [],
      metrics: extractMetrics(blob),
      links: [],
      timeRange: edu.timeRange,
      sourceRef: { kind: 'resume', locator: '教育背景', excerpt: truncate(blob, 120) },
    });
  }

  for (const line of sectionLines(structure, 'certificate')) {
    const content = line.replace(/^[\s\-–—•·*]+/, '').trim();
    if (!content) continue;
    pushEvidence({
      kind: 'certificate',
      title: truncate(content, 40),
      content,
      skills: findSkillsInText(content).map((h) => h.def.name),
      metrics: [],
      links: extractLinks(content),
      sourceRef: { kind: 'resume', locator: '证书', excerpt: truncate(content, 120) },
    });
  }

  for (const line of sectionLines(structure, 'award')) {
    const content = line.replace(/^[\s\S]*?[•·\-–—]\s*/, '').trim() || line.trim();
    if (!content) continue;
    pushEvidence({
      kind: 'competition',
      title: truncate(content, 40),
      content,
      skills: findSkillsInText(content).map((h) => h.def.name),
      metrics: extractMetrics(content),
      links: extractLinks(content),
      sourceRef: { kind: 'resume', locator: '获奖荣誉', excerpt: truncate(content, 120) },
    });
  }

  // 有自评等级但完全没有项目/工作证据支撑的技能 → 生成自我声明证据
  for (const skill of skills) {
    const hasSupport = evidence.some(
      (e) => (e.kind === 'project' || e.kind === 'work' || e.kind === 'open_source') &&
        (e.skills.includes(skill.name) || textMentionsSkill(skill.name, e.content)),
    );
    if (!hasSupport) {
      pushEvidence({
        kind: 'self_claim',
        title: `${skill.name} · 自我声明`,
        content: `简历中${skill.selfLevel === '未声明' ? '仅提及' : `声明「${skill.selfLevel}」`}${skill.name}，但未找到对应的项目、作品或工作产出。`,
        skills: [skill.name],
        metrics: [],
        links: [],
        sourceRef: { kind: 'resume', locator: '技能清单', excerpt: truncate(skillSectionText, 120) },
      });
    }
  }

  const profile: CandidateProfile = {
    id: newId('profile'),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    basics,
    summary: buildRuleSummary(basics, skills.length, projects.length, experiences.length),
    education,
    experiences,
    projects,
    skills,
    selfDescriptions,
    evidence,
    provenSkills: [],
    unprovenSkills: [],
    learningSkills: [],
    interviewHistory: [],
    assessments: [],
    rawText: text,
    rawSourceRef: sourceRef,
    privacy: input.privacy,
    parsedBy: 'rule',
  };

  return { profile, warnings };
}

function buildRuleSummary(
  basics: CandidateProfile['basics'],
  skillCount: number,
  projectCount: number,
  experienceCount: number,
): string {
  const bits: string[] = [];
  if (basics.educationLevel) bits.push(`${basics.educationLevel}学历`);
  if (experienceCount > 0) bits.push(`${experienceCount} 段工作/实习经历`);
  if (projectCount > 0) bits.push(`${projectCount} 个项目`);
  if (skillCount > 0) bits.push(`${skillCount} 项技能`);
  return bits.length ? `由简历解析得到：${bits.join('，')}。` : '简历解析完成，但未提取到结构化条目。';
}

// ---------------------------------------------------------------------------
// AI 结果校验与合并
// ---------------------------------------------------------------------------

interface AiProfilePayload {
  basics?: Record<string, unknown>;
  summary?: string;
  education?: Array<Record<string, unknown>>;
  experiences?: Array<Record<string, unknown>>;
  projects?: Array<Record<string, unknown>>;
  skills?: Array<Record<string, unknown>>;
  selfDescriptions?: string[];
  evidence?: Array<Record<string, unknown>>;
}

const VALID_KINDS: EvidenceKind[] = [
  'project', 'work', 'education', 'certificate', 'competition', 'open_source', 'metric', 'self_claim', 'other',
];

function coerceAiProfile(payload: AiProfilePayload, input: BuildProfileInput): CandidateProfile {
  const now = new Date().toISOString();
  const text = input.redactedText;

  const education: EducationItem[] = (payload.education ?? []).map((e) => ({
    id: newId('edu'),
    school: asString(e.school),
    major: asString(e.major),
    degree: asString(e.degree),
    timeRange: asString(e.timeRange) || undefined,
    highlights: asStringArray(e.highlights),
  }));

  const experiences: WorkExperience[] = (payload.experiences ?? []).map((e) => ({
    id: newId('exp'),
    organization: asString(e.organization),
    role: asString(e.role),
    timeRange: asString(e.timeRange) || undefined,
    description: asString(e.description),
    achievements: asStringArray(e.achievements),
    skills: normalizeSkillList(asStringArray(e.skills)),
  }));

  const projects: ProjectItem[] = (payload.projects ?? []).map((e) => ({
    id: newId('prj'),
    name: asString(e.name, '未命名项目'),
    role: asString(e.role) || undefined,
    timeRange: asString(e.timeRange) || undefined,
    description: asString(e.description),
    highlights: asStringArray(e.highlights),
    skills: normalizeSkillList(asStringArray(e.skills)),
    links: asStringArray(e.links),
  }));

  const rawSkills = asStringArray((payload.skills ?? []).map((s) => asString(s.name)));
  const ruleFound = findSkillsInText(text).map((h) => h.def.name);
  const skillNames = normalizeSkillList([...rawSkills, ...ruleFound]).filter(isSkillEntry);

  const skills: SkillItem[] = skillNames.map((name) => {
    const aiEntry = (payload.skills ?? []).find((s) => asString(s.name) === name);
    const def = resolveSkill(name);
    const terms = def ? [def.name, ...def.aliases] : [name];
    const aiLevel = asString(aiEntry?.selfLevel);
    const selfLevel = (['了解', '熟悉', '熟练', '精通'].includes(aiLevel)
      ? aiLevel
      : pickSelfLevel(text, terms)) as SelfLevel;
    return {
      id: newId('skl'),
      name,
      aliases: def?.aliases ?? [],
      category: def?.kind ?? 'domain',
      selfLevel: selfLevel || '未声明',
      evidenceIds: [],
      derivedStrength: 'none' as EvidenceStrength,
    };
  });

  const evidence: CandidateEvidence[] = (payload.evidence ?? []).map((e) => {
    const kind = VALID_KINDS.includes(asString(e.kind) as EvidenceKind)
      ? (asString(e.kind) as EvidenceKind)
      : 'other';
    const content = asString(e.content);
    const metrics = asStringArray(e.metrics);
    const links = asStringArray(e.links);
    const timeRange = asString(e.timeRange) || undefined;
    const computed = computeEvidenceStrength({
      kind,
      content,
      metrics,
      links,
      hasTimeRange: Boolean(timeRange),
      origin: 'resume',
    });
    return {
      id: newId('evd'),
      kind,
      title: asString(e.title, truncate(content, 24)),
      content,
      skills: normalizeSkillList(asStringArray(e.skills)),
      metrics,
      links,
      timeRange,
      origin: 'resume' as const,
      strength: computed.strength,
      strengthReason: computed.reason,
      sourceRef: {
        kind: 'ai' as const,
        locator: '模型从简历中提取',
        excerpt: truncate(content, 120),
      },
      editedByUser: false,
      createdAt: now,
      updatedAt: now,
    };
  });

  // 模型可能漏掉项目证据，这里用规则结果兜底补足
  const coveredTitles = new Set(evidence.map((e) => e.title));
  for (const project of projects) {
    if (coveredTitles.has(project.name)) continue;
    const blob = [project.description, ...project.highlights].join(' ');
    if (!blob.trim()) continue;
    const computed = computeEvidenceStrength({
      kind: 'project',
      content: blob,
      metrics: extractMetrics(blob),
      links: project.links,
      hasTimeRange: Boolean(project.timeRange),
      origin: 'resume',
    });
    evidence.push({
      id: newId('evd'),
      kind: 'project',
      title: project.name,
      content: blob,
      skills: project.skills,
      metrics: extractMetrics(blob),
      links: project.links,
      timeRange: project.timeRange,
      origin: 'resume',
      strength: computed.strength,
      strengthReason: computed.reason,
      sourceRef: { kind: 'resume', locator: `项目经历 · ${project.name}`, excerpt: truncate(blob, 120) },
      editedByUser: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  const basicsRaw = payload.basics ?? {};
  const yearsRaw = basicsRaw.yearsOfExperience;
  const location = input.originalText
    ? cityFromFindings(input.privacy.findings, input.originalText)
    : undefined;

  return {
    id: newId('profile'),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    basics: {
      displayName: input.profileLabel?.trim() || '我的档案',
      targetRoles: asStringArray(basicsRaw.targetRoles).slice(0, 6),
      yearsOfExperience: typeof yearsRaw === 'number' ? yearsRaw : null,
      educationLevel: asString(basicsRaw.educationLevel) || detectEducationLevel(text),
      location: asString(basicsRaw.location) || location || '',
    },
    summary: asString(payload.summary) || buildRuleSummary(
      { displayName: '', targetRoles: [], educationLevel: detectEducationLevel(text) },
      skills.length,
      projects.length,
      experiences.length,
    ),
    education,
    experiences,
    projects,
    skills,
    selfDescriptions: asStringArray(payload.selfDescriptions),
    evidence,
    provenSkills: [],
    unprovenSkills: [],
    learningSkills: [],
    interviewHistory: [],
    assessments: [],
    rawText: text,
    rawSourceRef: { kind: 'resume', locator: '简历原文', excerpt: truncate(text, 160) },
    privacy: input.privacy,
    parsedBy: 'ai',
  };
}

// ---------------------------------------------------------------------------
// 统一后处理
// ---------------------------------------------------------------------------

/**
 * 收尾处理 —— 无论数据来自模型还是规则，都必须过这一步。
 * 用户手工修正数据后也应该调用它，保证强度刻度与技能关联始终自洽。
 */
export function finalizeProfile(profile: CandidateProfile): CandidateProfile {
  // 1) 证据强度：用户手动改过的证据保留用户设定
  //    注意必须带上 origin —— 问诊证据（origin='qa'）的强度封顶规则要在这里同样生效，
  //    否则每次归一化都会把封顶悄悄绕过去。
  const evidence = profile.evidence.map((e) => {
    if (e.editedByUser) return e;
    const computed = computeEvidenceStrength({
      kind: e.kind,
      content: e.content,
      metrics: e.metrics,
      links: e.links,
      hasTimeRange: Boolean(e.timeRange),
      origin: e.origin ?? 'resume',
    });
    return { ...e, strength: computed.strength, strengthReason: computed.reason };
  });

  // 2) 技能 ↔ 证据 双向关联（既看技能标签，也看证据正文是否提及该能力）
  const skills = profile.skills.map((skill) => {
    const evidenceIds = evidence
      .filter((e) => e.skills.includes(skill.name) || textMentionsSkill(skill.name, e.content) || textMentionsSkill(skill.name, e.title))
      .map((e) => e.id);
    const strengths = evidenceIds
      .map((id) => evidence.find((e) => e.id === id))
      .filter(Boolean)
      .map((e) => (e as CandidateEvidence).strength);
    return {
      ...skill,
      evidenceIds,
      derivedStrength: maxStrength(strengths),
    };
  });

  // 3) 三分类推导
  const provenSkills: string[] = [];
  const unprovenSkills: string[] = [];
  const learningSkills: string[] = [];
  for (const skill of skills) {
    const strongEnough = skill.derivedStrength === 'strong' || skill.derivedStrength === 'medium';
    const hasRealEvidence = skill.evidenceIds.some((id) => {
      const e = evidence.find((x) => x.id === id);
      return e && (e.kind === 'project' || e.kind === 'work' || e.kind === 'open_source' || e.kind === 'competition');
    });
    if (strongEnough && hasRealEvidence) provenSkills.push(skill.name);
    else if (skill.selfLevel === '了解') learningSkills.push(skill.name);
    else unprovenSkills.push(skill.name);
  }

  return {
    ...profile,
    evidence,
    skills,
    provenSkills: unique(provenSkills),
    unprovenSkills: unique(unprovenSkills),
    learningSkills: unique(learningSkills),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export async function buildProfile(input: BuildProfileInput): Promise<BuildProfileResult> {
  const ruleResult = buildByRules(input);
  const gateway = input.gateway;

  if (gateway?.active) {
    const messages: AiMessage[] = [
      { role: 'system', content: PROFILE_SYSTEM_PROMPT },
      { role: 'user', content: `以下是简历文本（已脱敏）：\n\n${input.redactedText}` },
    ];
    input.onMessages?.(messages);
    const run = await gateway.runJson<AiProfilePayload>('profile_build', messages, { maxTokens: 4096 });
    if (run.value) {
      const profile = finalizeProfile(coerceAiProfile(run.value, input));
      const warnings = [...ruleResult.warnings];
      if (profile.evidence.length === 0) {
        warnings.push('模型没有提取到任何证据，已回落到规则解析结果');
        return { profile: finalizeProfile(ruleResult.profile), trace: run.trace, warnings, engine: 'rule' };
      }
      return { profile, trace: run.trace, warnings, engine: 'ai' };
    }
    // 模型失败 → 用规则结果，但把原因带回给界面
    const warnings = [...ruleResult.warnings];
    if (run.error) warnings.push(`模型解析不可用，已使用本地规则引擎：${run.error}`);
    return { profile: finalizeProfile(ruleResult.profile), trace: run.trace, warnings, engine: 'rule' };
  }

  return { profile: finalizeProfile(ruleResult.profile), trace: null, warnings: ruleResult.warnings, engine: 'rule' };
}
