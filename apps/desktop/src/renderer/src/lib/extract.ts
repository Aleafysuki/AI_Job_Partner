import { detectKind, type DocumentKind, type ExtractedDocument } from '@aijob/core';
import { pickFile } from './bridge';

/**
 * 文档文本抽取（文档 24. Phase 1：TXT / PDF / DOCX）。
 *
 * 放在渲染进程而不是主进程：渲染进程本身就是 Chromium，
 * pdfjs 与 mammoth 在这里可以正常跑，将来 Web 版也不需要改。
 * 抽取失败时永远返回可用结果 + 警告，而不是抛异常打断流程。
 */

const decoder = new TextDecoder('utf-8');

async function fromTxt(name: string, bytes: Uint8Array): Promise<ExtractedDocument> {
  let text = decoder.decode(bytes);
  // UTF-8 解出来满是替换字符时，尝试 GBK（国内简历常见）
  const bad = (text.match(/\uFFFD/g) ?? []).length;
  if (bad > text.length * 0.02) {
    try {
      const gbk = new TextDecoder('gbk');
      text = gbk.decode(bytes);
    } catch {
      /* 浏览器不支持 gbk 时保持原样 */
    }
  }
  return { text, kind: 'txt', fileName: name, warnings: [] };
}

async function fromDocx(name: string, bytes: Uint8Array): Promise<ExtractedDocument> {
  try {
    const mammoth = await import('mammoth');
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    const warnings: string[] = [];
    if (!result.value.trim()) warnings.push('DOCX 里没有解析出文字，可能是纯图片排版');
    if (result.messages?.length) {
      warnings.push(`Word 解析提示：${result.messages.slice(0, 2).map((m) => m.message).join('；')}`);
    }
    return { text: result.value, kind: 'docx', fileName: name, warnings };
  } catch (err) {
    return {
      text: '',
      kind: 'docx',
      fileName: name,
      warnings: [`DOCX 解析失败（${(err as Error).message}），请另存为 TXT 或直接粘贴文本`],
    };
  }
}

async function fromPdf(name: string, bytes: Uint8Array): Promise<ExtractedDocument> {
  try {
    const pdfjs = await import('pdfjs-dist');
    try {
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    } catch {
      /* 取不到 worker 时 pdfjs 会退回主线程，速度慢但可用 */
    }
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const chunks: string[] = [];
    const max = Math.min(doc.numPages, 20);
    for (let i = 1; i <= max; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s{2,}/g, ' ');
      chunks.push(line);
    }
    const text = chunks.join('\n');
    const warnings: string[] = [];
    if (text.replace(/\s/g, '').length < 120) {
      warnings.push('PDF 里几乎没有文字层（可能是扫描件/图片导出），v0.1 暂不支持 OCR，请改用 TXT 或直接粘贴文本');
    }
    if (doc.numPages > max) warnings.push(`PDF 共 ${doc.numPages} 页，只解析了前 ${max} 页`);
    return { text, kind: 'pdf', fileName: name, warnings };
  } catch (err) {
    return {
      text: '',
      kind: 'pdf',
      fileName: name,
      warnings: [`PDF 解析失败（${(err as Error).message}），请另存为 TXT 或直接粘贴文本`],
    };
  }
}

export async function extractText(name: string, bytes: Uint8Array): Promise<ExtractedDocument> {
  const kind: DocumentKind = detectKind(name);
  switch (kind) {
    case 'pdf': return fromPdf(name, bytes);
    case 'docx': return fromDocx(name, bytes);
    case 'txt':
    case 'md': return fromTxt(name, bytes);
    default:
      return {
        text: decoder.decode(bytes),
        kind: 'unknown',
        fileName: name,
        warnings: ['未知文件类型，已按纯文本读取'],
      };
  }
}

/** 选择文件 → 抽取文本，一步到位 */
export async function pickAndExtract(): Promise<ExtractedDocument | null> {
  const picked = await pickFile();
  if (!picked) return null;
  return extractText(picked.name, picked.bytes);
}
