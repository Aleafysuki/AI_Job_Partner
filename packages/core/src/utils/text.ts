/**
 * 通用工具：ID、时间、文本处理
 *
 * 约束：core 包必须是「宿主无关」的纯 TypeScript。
 * 不允许 import node:* / electron / 任何 DOM API（crypto 走 globalThis 兼容层）。
 */

/** 生成带前缀的稳定 ID。优先使用平台 crypto，缺失时回退到时间戳 + 计数器。 */
let fallbackSeq = 0;
export function newId(prefix: string): string {
  const cryptoObj = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return `${prefix}_${cryptoObj.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
  fallbackSeq += 1;
  return `${prefix}_${Date.now().toString(36)}${fallbackSeq.toString(36).padStart(3, '0')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatDateTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

export function truncate(text: string, max = 120): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function uniqueBy<T, K>(items: T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function compact<T>(items: (T | null | undefined | false)[]): T[] {
  return items.filter(Boolean) as T[];
}

/** 全文去除不可见字符、统一换行、压缩空白行 */
export function normalizeText(raw: string): string {
  return (raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function lines(raw: string): string[] {
  return normalizeText(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

const BULLET_PREFIX = /^\s*(?:[-–—•·*※◆■□○●▪‣»>]|\(?\d{1,2}[).、]|[①-⑳]|[一二三四五六七八九十]{1,2}[、.)])\s*/;

export function stripBullet(line: string): string {
  return line.replace(BULLET_PREFIX, '').trim();
}

export function isBulletLine(line: string): boolean {
  return BULLET_PREFIX.test(line.trim());
}

/** 是否包含中日韩文字 */
export function hasCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

const STOP_WORDS = new Set([
  '的', '了', '和', '与', '及', '或', '在', '是', '有', '对', '被', '把', '为', '等', '并', '能', '会', '可',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'with', 'on', 'is', 'are', 'be', 'as', 'at', 'by',
]);

/** 简易分词：英文按非字母数字切分，中文按字 + 二字滑窗，用于相似度与关键词统计 */
export function tokenize(text: string): string[] {
  const lower = (text ?? '').toLowerCase();
  const out: string[] = [];
  const latin = lower.match(/[a-z][a-z0-9+#.\-_]{1,}/g) ?? [];
  for (const t of latin) {
    const clean = t.replace(/[.\-_]+$/, '');
    if (clean.length >= 2 && !STOP_WORDS.has(clean)) out.push(clean);
  }
  const cjkRuns = lower.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length; i += 1) {
      if (i + 2 <= run.length) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

/** Jaccard 相似度，0~1 */
export function similarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
