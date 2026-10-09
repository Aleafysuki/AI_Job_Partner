import { isEnabled } from '../version';

/**
 * 文档文本抽取的契约。
 *
 * 具体实现（PDF / DOCX 解析）依赖运行环境里的库，因此放在宿主侧（渲染进程），
 * core 只定义「抽完之后长什么样」，保证将来 Android / Web 复用同一套上层逻辑。
 */

export type DocumentKind = 'txt' | 'md' | 'pdf' | 'docx' | 'unknown';

export interface ExtractedDocument {
  text: string;
  kind: DocumentKind;
  fileName: string;
  /** 抽取过程中的降级提示，例如「PDF 是扫描件，没有文字层」 */
  warnings: string[];
}

export function detectKind(fileName: string): DocumentKind {
  const lower = (fileName ?? '').toLowerCase();
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  return 'unknown';
}

const CAPABILITY_OF_KIND: Record<DocumentKind, string> = {
  txt: 'profile.import_text',
  md: 'profile.import_text',
  pdf: 'profile.import_pdf',
  docx: 'profile.import_docx',
  unknown: 'profile.import_text',
};

/** 当前版本是否允许导入这种格式（v0.1 支持 txt/md/pdf/docx，见能力表） */
export function canImport(kind: DocumentKind): boolean {
  const capId = CAPABILITY_OF_KIND[kind];
  if (!capId) return false;
  return isEnabled(capId);
}

export const IMPORT_ACCEPT = '.txt,.md,.markdown,.pdf,.docx';
