import { isBulletLine, lines as toLines, stripBullet } from '../utils/text';

/**
 * 简历段落切分。
 *
 * 目标（文档 24. Phase 1）：不追求完美排版还原，只求把简历变成可用的结构。
 * 所以这里用「标题词典 + 条目分组」的保守策略，宁可少切，不要乱切。
 */

export type SectionId =
  | 'contact' | 'education' | 'work' | 'project'
  | 'skill' | 'self' | 'certificate' | 'award' | 'other';

export const SECTION_LABEL: Record<SectionId, string> = {
  contact: '联系方式',
  education: '教育背景',
  work: '工作经历',
  project: '项目经历',
  skill: '专业技能',
  self: '自我评价',
  certificate: '证书',
  award: '获奖荣誉',
  other: '其他',
};

const SECTION_ALIASES: Array<{ id: SectionId; terms: string[] }> = [
  { id: 'contact', terms: ['个人信息', '基本信息', '联系方式', '个人资料', '基本资料', '个人档案', 'contact', 'profile', 'personal information'] },
  { id: 'education', terms: ['教育背景', '教育经历', '教育信息', '学历信息', '学历', '求学经历', 'education', 'educational background'] },
  { id: 'work', terms: ['工作经历', '工作经验', '工作履历', '职业经历', '从业经历', '任职经历', '实习经历', '实习经验', '工作', 'work experience', 'experience', 'employment'] },
  { id: 'project', terms: ['项目经历', '项目经验', '项目介绍', '主要项目', '项目实践', '校园经历', '实践经历', '项目', 'projects', 'project experience'] },
  { id: 'skill', terms: ['专业技能', '技能特长', '技能清单', '技术栈', '技术能力', '个人技能', '掌握技能', '技能', 'skills', 'technical skills'] },
  { id: 'self', terms: ['自我评价', '个人评价', '自我介绍', '自我描述', '个人简介', '个人优势', '个人总结', 'summary', 'about me', 'self evaluation'] },
  { id: 'certificate', terms: ['证书', '资格证书', '技能证书', '认证情况', 'certificates', 'certifications'] },
  { id: 'award', terms: ['获奖情况', '荣誉奖项', '获奖经历', '奖项', '荣誉', 'awards', 'honors'] },
];

function normalizeHeading(line: string): string {
  return stripBullet(line)
    .replace(/[：:]\s*$/, '')
    .replace(/\s+/g, '')
    .replace(/^[【\[（(]|[】\]）)]$/g, '')
    .trim()
    .toLowerCase();
}

function headingId(line: string): SectionId | null {
  const raw = line.trim();
  if (!raw) return null;
  // 标题不会太长，也不会是带句子的段落
  if (raw.length > 22) return null;
  if (/[。；！？]$/.test(raw)) return null;
  const key = normalizeHeading(raw);
  if (!key) return null;
  for (const group of SECTION_ALIASES) {
    if (group.terms.some((t) => key === t.replace(/\s+/g, '').toLowerCase())) return group.id;
  }
  return null;
}

export interface ResumeSection {
  id: SectionId;
  /** 原文里的标题写法 */
  title: string;
  lines: string[];
}

export interface ResumeStructure {
  /** 标题之前的内容（通常是姓名 + 联系方式 + 求职意向） */
  head: string[];
  sections: ResumeSection[];
}

export function splitResumeSections(text: string): ResumeStructure {
  const all = toLines(text);
  const head: string[] = [];
  const sections: ResumeSection[] = [];
  let current: ResumeSection | null = null;

  for (const line of all) {
    const id = headingId(line);
    if (id) {
      if (current) sections.push(current);
      current = { id, title: stripBullet(line).replace(/[：:]\s*$/, ''), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else head.push(line);
  }
  if (current) sections.push(current);
  return { head, sections };
}

/** 在正文中查找某个段落的内容，找不到返回空数组 */
export function sectionLines(structure: ResumeStructure, id: SectionId): string[] {
  return structure.sections.filter((s) => s.id === id).flatMap((s) => s.lines);
}

const DATE_RANGE_RE =
  /((?:19|20)\d{2}\s*[年./-]\s*(?:0?[1-9]|1[0-2])?\s*[月./-]?)\s*(?:[-~—–至到]|to)\s*((?:19|20)\d{2}\s*[年./-]?\s*(?:0?[1-9]|1[0-2])?\s*[月./-]?|至今|现在|now|present|目前)/i;

const SINGLE_DATE_RE = /(?:19|20)\d{2}\s*[年./-]\s*(?:0?[1-9]|1[0-2])?(?:\s*[月./-])?/;

export function matchDateRange(line: string): string | undefined {
  const range = DATE_RANGE_RE.exec(line);
  if (range) return `${range[1].trim()} ~ ${range[2].trim()}`.replace(/\s+/g, ' ');
  const single = SINGLE_DATE_RE.exec(line);
  return single ? single[0].trim() : undefined;
}

export interface RawEntry {
  /** 条目标题行 */
  title: string;
  /** 该条目下的要点 */
  bullets: string[];
  /** 该条目的所有原始行 */
  lines: string[];
}

/**
 * 条目分组：
 * - 段落内存在要点符号时，非要点行视为新条目的标题，要点行归属前一个标题；
 * - 段落内完全没有要点符号时，每一行各自成为一个条目。
 */
export function groupEntries(sectionLinesArr: string[]): RawEntry[] {
  const hasBullets = sectionLinesArr.some((l) => isBulletLine(l));
  const entries: RawEntry[] = [];

  if (!hasBullets) {
    for (const line of sectionLinesArr) {
      const title = stripBullet(line);
      if (!title) continue;
      entries.push({ title, bullets: [], lines: [line] });
    }
    return entries;
  }

  let current: RawEntry | null = null;
  for (const line of sectionLinesArr) {
    if (isBulletLine(line)) {
      const content = stripBullet(line);
      if (!content) continue;
      if (!current) {
        current = { title: content, bullets: [], lines: [line] };
        entries.push(current);
      } else {
        current.bullets.push(content);
        current.lines.push(line);
      }
      continue;
    }
    current = { title: stripBullet(line), bullets: [], lines: [line] };
    entries.push(current);
  }
  return entries.filter((e) => e.title || e.bullets.length > 0);
}

const METRIC_PATTERNS: RegExp[] = [
  // 数量 + 单位（允许「约 / 余 / 多 / 左右」这类修饰）
  // 注意：这里不能用 \b? —— \b 是零宽断言，加量词在 JS 里会直接抛 "Nothing to repeat"
  new RegExp(
    '(?:约|超过|近|达到|高达|累计|日均|每天|每月)?\\s*\\d+(?:\\.\\d+)?\\s*(?:余|多|左右)?\\s*' +
      '(?:万|千|百|个月|个|条|次|人|家|元|小时|分钟|天|周|月|年|份|页|篇|款|台|倍|GB|MB|TB|ms|毫秒|秒)',
    'g',
  ),
  /\d+(?:\.\d+)?\s*[%％]/g,
  /(?:从|由)\s*\d+(?:\.\d+)?[^\n，,。；;]{0,12}(?:提升|提高到|下降到|降低|增长|减少)/g,
  /(?:准确率|转化率|留存率|通过率|覆盖率|召回率|效率|性能|响应时间|加载时间)[^\n，,。；;]{0,14}?\d+(?:\.\d+)?\s*(?:%|％|倍|毫秒|ms|s|秒|条|个)/gi,
];

export function extractMetrics(text: string): string[] {
  const found: string[] = [];
  for (const re of METRIC_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[0].trim();
      if (value.length < 2) continue;
      if (!found.includes(value)) found.push(value);
      if (found.length >= 8) return found;
    }
  }
  return found;
}

export const LINK_RE = /(?:https?:\/\/[^\s，,；;）)]+|(?:github|gitee)\.com\/[^\s，,；;）)]+)/gi;

export function extractLinks(text: string): string[] {
  const found: string[] = [];
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) {
    const value = m[0].replace(/[.。，,；;]+$/, '');
    if (!found.includes(value)) found.push(value);
  }
  return found;
}
