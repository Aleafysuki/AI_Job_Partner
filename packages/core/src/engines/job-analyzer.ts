import { AiGateway } from '../ai/gateway';
import { JOB_SYSTEM_PROMPT } from '../ai/prompts';
import type { AiMessage, AiTrace } from '../domain/ai-trace';
import type { TriLevel } from '../domain/common';
import type { PrivacyReport } from '../domain/privacy';
import type { EvidenceNeeded, JobRequirement, RequirementItem, RequirementType } from '../domain/job';
import { findSkillsInText, normalizeSkillList, skillKindOf } from '../nlp/skills';
import { isBulletLine, lines as toLines, newId, stripBullet, truncate, unique } from '../utils/text';

/**
 * JobAnalyzer —— JD → Job Requirement。
 *
 * 文档第六节要求每个要求都尽可能保留来源，因此每条 RequirementItem 都带 sourceRef，
 * 界面可以随时回查「这条要求出自原文哪一句」。
 */

export interface AnalyzeJobInput {
  redactedText: string;
  privacy: PrivacyReport;
  source: JobRequirement['source'];
  sourceFileName?: string;
  /** 用户手输时可能只给了一句话，此时允许补一个岗位名 */
  jobTitleHint?: string;
  gateway?: AiGateway | null;
  onMessages?: (messages: AiMessage[]) => void;
}

export interface AnalyzeJobResult {
  job: JobRequirement;
  trace: AiTrace | null;
  warnings: string[];
  engine: 'ai' | 'rule';
}

// ---------------------------------------------------------------------------
// 段落语境
// ---------------------------------------------------------------------------

interface SectionHint {
  type: RequirementType | null;
  terms: string[];
  label: string;
}

const SECTION_HINTS: SectionHint[] = [
  {
    type: 'responsibility',
    label: '岗位职责',
    terms: ['岗位职责', '工作职责', '工作内容', '职位描述', '你将负责', '主要职责', '职责描述', '你要做的事', '工作职责与内容', '职责'],
  },
  {
    type: 'must',
    label: '任职要求',
    terms: ['任职要求', '岗位要求', '职位要求', '任职资格', '我们希望你', '你需要具备', '任职条件', '基本要求', '能力要求', '招聘要求', '要求'],
  },
  {
    type: 'bonus',
    label: '加分项',
    terms: ['加分项', '加分', '优先条件', '优先考虑', '有以下经验者优先', 'nice to have', 'plus'],
  },
  { type: 'education', label: '学历要求', terms: ['学历要求', '学历'] },
  { type: 'experience', label: '经验要求', terms: ['经验要求', '工作经验要求'] },
  { type: 'implicit', label: '隐含要求', terms: ['隐含要求'] },
];

function headingType(line: string): SectionHint | null {
  const raw = stripBullet(line).replace(/[：:]\s*$/, '').replace(/\s+/g, '').trim();
  if (!raw || raw.length > 16) return null;
  for (const hint of SECTION_HINTS) {
    if (hint.terms.some((t) => raw === t.replace(/\s+/g, ''))) return hint;
  }
  return null;
}

/** JD 里与「要求」无关的行（薪资、投递方式等），不进入要求列表 */
const NOISE_RE =
  /(薪资|薪酬|工资|月薪|年薪|\d+\s*[kK]\s*[-~]|\d+\s*万|福利|五险一金|双休|弹性|投递|简历发送|邮箱|联系人|联系电话|微信|工作地点|办公地点|上班时间|到岗|base\s*地|base|公司地址|公司简介|关于我们|团队介绍|融资|规模)/i;

const HARD_GATE_RE =
  /(学历|本科|硕士|研究生|博士|大专|专科|统招|全日制|985|211|双一流|\d{1,2}\s*年(?:以上|及以上)?[^\n。；;]{0,6}(?:经验|工作)|专业(?:要求|对口|相关)|必须持有|持证|证书|户口|户籍|全职|工作地点|base)/i;

const STRONG_RE = /(必须|精通|熟练掌握|具备|要求|至少|以上|熟悉|扎实|深入)/;
const SOFT_RE = /(优先|加分|最好|更佳|有(?:相关)?经验者优先|preferred|nice to have)/;

function classifyType(content: string, context: RequirementType | null): RequirementType {
  if (SOFT_RE.test(content)) return 'bonus';
  if (HARD_GATE_RE.test(content)) {
    if (/(学历|本科|硕士|研究生|博士|大专|专科|统招|全日制|985|211|双一流)/.test(content)) return 'education';
    if (/(\d{1,2}\s*年|经验)/.test(content)) return 'experience';
  }

  const kinds = unique(findSkillsInText(content).map((h) => h.def.kind));
  const isSoftSkill = kinds.length > 0 && kinds.every((k) => k === 'soft');

  if (context === 'responsibility') return 'responsibility';
  if (context === 'must' || context === 'bonus' || context === 'education' || context === 'experience') {
    if (isSoftSkill) return 'soft';
    if (kinds.some((k) => k === 'certificate')) return 'education';
    if (context === 'must') {
      if (kinds.length > 0 && kinds.every((k) => k === 'office' || k === 'design' || k === 'agent' || k === 'data' || k === 'ai')) {
        // 具体软件/平台类归 tool，能力类归 tech
        const allTool = findSkillsInText(content).every((h) => h.def.isTool);
        return allTool ? 'tool' : 'tech';
      }
      return 'must';
    }
    return context;
  }

  if (isSoftSkill) return 'soft';
  const hits = findSkillsInText(content);
  if (hits.length > 0 && hits.every((h) => h.def.isTool)) return 'tool';
  if (kinds.some((k) => k === 'certificate')) return 'education';
  if (hits.length > 0) return 'tech';
  return 'must';
}

function importanceOf(content: string, type: RequirementType, hardGate: boolean): TriLevel {
  if (hardGate) return 'high';
  if (type === 'bonus') return 'low';
  if (type === 'implicit') return 'medium';
  if (STRONG_RE.test(content)) return 'high';
  if (type === 'responsibility') return 'medium';
  return 'medium';
}

function evidenceNeededOf(type: RequirementType, content: string): EvidenceNeeded {
  switch (type) {
    case 'education': return 'education';
    case 'experience': return 'work';
    case 'tech':
    case 'tool': return 'project';
    case 'must': return findSkillsInText(content).length > 0 ? 'project' : 'any';
    case 'responsibility': return 'work';
    case 'soft': return 'any';
    default: return 'any';
  }
}

/** 把一行拆成多条要求（原文常见「；」「;」「1) 2)」并列） */
function splitRequirementLine(line: string): string[] {
  const cleaned = stripBullet(line).trim();
  if (!cleaned) return [];
  if (cleaned.length <= 60) {
    return [cleaned];
  }
  const parts = cleaned
    .split(/[；;]/)
    .map((p) => p.replace(/^\s*\d{1,2}\s*[).、]\s*/, '').trim())
    .filter((p) => p.length >= 4);
  return parts.length > 1 ? parts : [cleaned];
}

/** 看起来像「要求句」而不是「岗位名」的行 —— 手动输入场景下特别容易误判 */
const REQUIREMENT_LIKE = /(需要|要求|必须|熟悉|掌握|精通|具备|负责|优先|能够|能力|经验|以及|、)/;

function extractJobTitle(text: string): string {
  const explicit = /(?:岗位名称|职位名称|招聘岗位|岗位|职位|应聘岗位)\s*[:：]\s*([^\n，,。；;|｜]{2,30})/.exec(text);
  if (explicit) return explicit[1].trim();
  const all = toLines(text);
  for (const line of all.slice(0, 6)) {
    const candidate = stripBullet(line).trim();
    if (candidate.length < 3 || candidate.length > 26) continue;
    if (NOISE_RE.test(candidate) || /[:：]/.test(candidate)) continue;
    // 「需要 Python、Agent、RAG」这种是要求，不是岗位名 —— 宁可留空，也不要吞掉一条要求
    if (REQUIREMENT_LIKE.test(candidate)) continue;
    return candidate;
  }
  return '';
}

function extractCompany(text: string): string {
  const m = /(?:公司名称|公司|企业名称|招聘方)\s*[:：]\s*([^\n，,。；;|｜]{2,30})/.exec(text);
  return m ? m[1].trim() : '';
}

/** 从岗位要求推断「原文没写、但客观需要」的隐含能力 */
function deriveImplicitRequirements(text: string, items: RequirementItem[]): RequirementItem[] {
  const out: RequirementItem[] = [];
  const skills = unique(items.flatMap((i) => i.keywords));
  const kinds = unique(skills.map((s) => skillKindOf(s)));

  const add = (content: string, needed: EvidenceNeeded, why: string) => {
    out.push({
      id: newId('req'),
      index: 0,
      content,
      original: why,
      type: 'implicit',
      importance: 'medium',
      hardGate: false,
      keywords: [],
      evidenceNeeded: needed,
      sourceRef: { kind: 'ai', locator: '由岗位内容推断', excerpt: truncate(why, 120) },
      confidence: 'low',
      editedByUser: false,
    });
  };

  if (kinds.includes('ai') || kinds.includes('agent')) {
    add(
      '能够跟上快速变化的模型与框架版本（AI 领域工具半年即换代）',
      'project',
      `岗位提到 ${skills.filter((s) => ['ai', 'agent'].includes(skillKindOf(s))).slice(0, 4).join('、')}`,
    );
  }
  if (kinds.includes('language') && kinds.includes('frontend') && kinds.includes('backend')) {
    add('能够独立负责一个模块从开发到上线的完整交付', 'project', '岗位同时要求前端与后端能力，通常是少人小团队');
  }
  if (/(创业|初创|小团队|从 0 到 1|从0到1|0-1|新业务|探索)/.test(text)) {
    add('缺少成熟流程与明确需求时能自我推进', 'work', '岗位描述中出现「从 0 到 1 / 小团队」类表述');
  }
  if (kinds.includes('data') || /(数据|指标|复盘|报告)/.test(text)) {
    add('具备用数据说明工作结果的习惯', 'project', '岗位描述多次出现数据/指标相关表述');
  }
  if (/(跨部门|对接|协作|沟通|客户|业务方)/.test(text)) {
    add('能把非技术方的需求翻译成可执行的方案', 'work', '岗位描述涉及跨部门或客户对接');
  }
  if (/(英文|英语|文档|paper|论文|海外|国际化)/i.test(text)) {
    add('能够直接阅读英文文档与技术资料', 'any', '岗位描述提到英文资料 / 海外业务');
  }

  return out;
}

function deriveScreenRisks(items: RequirementItem[], text: string): string[] {
  const risks: string[] = [];
  const hardGates = items.filter((i) => i.hardGate);
  if (hardGates.length > 0) {
    risks.push(
      `存在 ${hardGates.length} 条硬门槛（${unique(hardGates.map((i) => i.content)).slice(0, 3).join('；')}），这类条件通常在简历初筛阶段直接过滤，不建议靠软性描述规避。`,
    );
  }
  if (/(985|211|双一流|统招|全日制)/.test(text)) {
    risks.push('岗位对院校/学历形式有明确限定，若不符合，投递优先级应下调。');
  }
  if (/(3\s*年|三年|5\s*年|五年)[^\n]{0,8}(以上)?[^\n]{0,6}经验/.test(text)) {
    risks.push('岗位要求较长的连续工作经验，实习/应届背景在这类岗位上通常处于劣势。');
  }
  const highSkills = unique(items.filter((i) => i.importance === 'high').flatMap((i) => i.keywords));
  if (highSkills.length >= 6) {
    risks.push(`高重要度要求多达 ${highSkills.length} 项，说明该岗位期望候选人能力面较宽，简历需要重排优先级而不是全部平铺。`);
  }
  return risks;
}

// ---------------------------------------------------------------------------
// 规则路径
// ---------------------------------------------------------------------------

function buildByRules(input: AnalyzeJobInput): { job: JobRequirement; warnings: string[] } {
  const text = input.redactedText;
  const warnings: string[] = [];
  const allLines = toLines(text);

  const jobTitle = input.jobTitleHint?.trim() || extractJobTitle(text);
  const company = extractCompany(text);
  // 岗位标题行不算「要求」；标题常带后缀（如「（校招/1-3 年）」），所以做前缀匹配
  const titleStem = jobTitle.replace(/[（(].*?[)）]/g, '').trim();
  const isTitleLine = (line: string): boolean => {
    if (line === jobTitle) return true;
    if (!titleStem) return false;
    return line.startsWith(titleStem) && line.length <= titleStem.length + 16;
  };

  const items: RequirementItem[] = [];
  let context: RequirementType | null = null;
  let index = 0;

  for (const rawLine of allLines) {
    const hint = headingType(rawLine);
    if (hint) {
      context = hint.type;
      continue;
    }
    const cleanedFull = stripBullet(rawLine);
    if (cleanedFull.length < 4) continue;
    if (NOISE_RE.test(cleanedFull)) continue;
    // 标题行本身不算要求
    if (isTitleLine(cleanedFull)) continue;

    for (const content of splitRequirementLine(rawLine)) {
      if (content.length < 4) continue;
      if (content.length > 200) continue;
      // 纯标题式短句且没有动词，跳过
      if (content.length < 6 && !isBulletLine(rawLine)) continue;

      const hardGate = HARD_GATE_RE.test(content);
      const type = classifyType(content, context);
      const keywords = normalizeSkillList(findSkillsInText(content).map((h) => h.def.name));
      index += 1;
      items.push({
        id: newId('req'),
        index,
        content: truncate(content.replace(/\s+/g, ' '), 160),
        original: content,
        type,
        importance: importanceOf(content, type, hardGate),
        hardGate,
        keywords,
        evidenceNeeded: evidenceNeededOf(type, content),
        sourceRef: {
          kind: 'jd',
          locator: `岗位原文第 ${allLines.indexOf(rawLine) + 1} 行`,
          excerpt: truncate(rawLine, 140),
        },
        confidence: keywords.length > 0 ? 'high' : 'medium',
        editedByUser: false,
      });
    }
  }

  for (const implicit of deriveImplicitRequirements(text, items)) {
    index += 1;
    items.push({ ...implicit, index });
  }

  if (items.length === 0) {
    warnings.push('没有从这段文字里拆出任何要求，请确认粘贴的是岗位描述而不是其他内容');
  }
  const noKeyword = items.filter((i) => i.keywords.length === 0).length;
  if (noKeyword > items.length * 0.6 && items.length > 3) {
    warnings.push('多数要求未能识别出具体能力关键词，匹配结果会偏保守（可能判为「无法判断」）');
  }

  const now = new Date().toISOString();
  const job: JobRequirement = {
    id: newId('job'),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    jobTitle,
    company,
    source: input.source,
    sourceFileName: input.sourceFileName,
    roleSummary: buildRoleSummary(jobTitle, items),
    items,
    screenRisks: deriveScreenRisks(items, text),
    rawText: text,
    privacy: input.privacy,
    parsedBy: 'rule',
  };

  return { job, warnings };
}

function buildRoleSummary(jobTitle: string, items: RequirementItem[]): string {
  const duties = items.filter((i) => i.type === 'responsibility').slice(0, 2).map((i) => truncate(i.content, 40));
  if (duties.length === 0) return `${jobTitle}，共拆解出 ${items.length} 条要求。`;
  return `${jobTitle}：${duties.join('；')}`;
}

// ---------------------------------------------------------------------------
// AI 结果校验
// ---------------------------------------------------------------------------

interface AiJobPayload {
  jobTitle?: string;
  company?: string;
  roleSummary?: string;
  items?: Array<Record<string, unknown>>;
  screenRisks?: string[];
}

const VALID_TYPES: RequirementType[] = ['must', 'tech', 'responsibility', 'experience', 'education', 'tool', 'soft', 'bonus', 'implicit'];
const VALID_NEEDED: EvidenceNeeded[] = ['project', 'work', 'education', 'certificate', 'portfolio', 'any'];

function coerceAiJob(payload: AiJobPayload, input: AnalyzeJobInput): JobRequirement {
  const now = new Date().toISOString();
  const text = input.redactedText;

  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items: RequirementItem[] = [];

  rawItems.forEach((raw, i) => {
    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (!content) return;
    const typeRaw = typeof raw.type === 'string' ? raw.type : 'must';
    const type = (VALID_TYPES.includes(typeRaw as RequirementType) ? typeRaw : 'must') as RequirementType;
    const importanceRaw = typeof raw.importance === 'string' ? raw.importance : 'medium';
    const importance = (['high', 'medium', 'low'].includes(importanceRaw) ? importanceRaw : 'medium') as TriLevel;
    const original = typeof raw.original === 'string' && raw.original.trim() ? raw.original.trim() : content;
    const keywords = normalizeSkillList(
      Array.isArray(raw.keywords) ? raw.keywords.filter((k): k is string => typeof k === 'string') : [],
    );
    const neededRaw = typeof raw.evidenceNeeded === 'string' ? raw.evidenceNeeded : 'any';
    const evidenceNeeded = (VALID_NEEDED.includes(neededRaw as EvidenceNeeded) ? neededRaw : 'any') as EvidenceNeeded;
    const hardGate = raw.hardGate === true || type === 'education' || type === 'experience';

    items.push({
      id: newId('req'),
      index: i + 1,
      content: truncate(content.replace(/\s+/g, ' '), 160),
      original,
      type,
      importance: hardGate ? 'high' : importance,
      hardGate,
      // 模型给的 keywords 与本地词典取并集，避免模型漏掉能匹配上的能力名
      keywords: normalizeSkillList([...keywords, ...findSkillsInText(content).map((h) => h.def.name)]),
      evidenceNeeded,
      sourceRef: { kind: 'jd', locator: `岗位原文（模型拆解 #${i + 1}）`, excerpt: truncate(original, 140) },
      confidence: keywords.length > 0 ? 'high' : 'medium',
      editedByUser: false,
    });
  });

  return {
    id: newId('job'),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    jobTitle: (typeof payload.jobTitle === 'string' && payload.jobTitle.trim()) || extractJobTitle(text),
    company: (typeof payload.company === 'string' ? payload.company.trim() : '') || extractCompany(text),
    source: input.source,
    sourceFileName: input.sourceFileName,
    roleSummary: (typeof payload.roleSummary === 'string' ? payload.roleSummary.trim() : '') || buildRoleSummary(extractJobTitle(text), items),
    items,
    screenRisks: Array.isArray(payload.screenRisks)
      ? payload.screenRisks.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : deriveScreenRisks(items, text),
    rawText: text,
    privacy: input.privacy,
    parsedBy: 'ai',
  };
}

/** 收尾：重排序号、去重 */
export function finalizeJob(job: JobRequirement): JobRequirement {
  const seen = new Set<string>();
  const items: RequirementItem[] = [];
  for (const item of job.items) {
    const key = item.content.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ ...item, index: items.length + 1, keywords: normalizeSkillList(item.keywords) });
  }
  return {
    ...job,
    items,
    jobTitle: job.jobTitle.trim() || '未命名岗位',
    updatedAt: new Date().toISOString(),
  };
}

export async function analyzeJob(input: AnalyzeJobInput): Promise<AnalyzeJobResult> {
  const ruleResult = buildByRules(input);
  const gateway = input.gateway;

  if (gateway?.active) {
    const messages: AiMessage[] = [
      { role: 'system', content: JOB_SYSTEM_PROMPT },
      { role: 'user', content: `以下是岗位描述（已脱敏）：\n\n${input.redactedText}` },
    ];
    input.onMessages?.(messages);
    const run = await gateway.runJson<AiJobPayload>('job_analyze', messages, { maxTokens: 4096 });
    if (run.value && Array.isArray(run.value.items) && run.value.items.length > 0) {
      return {
        job: finalizeJob(coerceAiJob(run.value, input)),
        trace: run.trace,
        warnings: ruleResult.warnings,
        engine: 'ai',
      };
    }
    const warnings = [...ruleResult.warnings];
    if (run.error) warnings.push(`模型解析不可用，已使用本地规则引擎：${run.error}`);
    return { job: finalizeJob(ruleResult.job), trace: run.trace, warnings, engine: 'rule' };
  }

  return { job: finalizeJob(ruleResult.job), trace: null, warnings: ruleResult.warnings, engine: 'rule' };
}
