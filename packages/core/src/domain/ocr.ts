/**
 * 岗位截图 OCR（v0.3 `job.input_image`）
 * =====================================
 *
 * ── 为什么坚持「本地推理」这条路线 ──
 *
 * 候选方案有三个，逐一说明为什么排除另外两个：
 *
 * 1. **云端 OCR API**（百度 / 腾讯 / Google Vision）
 *    直接出局。截图里往往含公司名、薪资、地址、以及 HR 的私聊内容，
 *    上传即泄露 —— 而「数据只在本机」是这个产品的第一承诺，
 *    一次违约就再也回不去了。
 *
 * 2. **打包 PP-OCR / ONNX 模型进 APK**
 *    技术上可行，但中文检测+识别+方向分类三个模型合计 10MB 以上，
 *    且要为 WebView 与原生两套运行时各准备一份。收益不抵体积代价。
 *
 * 3. **ML Kit 文字识别（on-device）** ← 采用
 *    模型由 Google 以 AAR 形式打包进 APK（约 2MB），
 *    推理完全在设备上，**不发任何网络请求**。
 *    代价是拉丁字母与中文分别要装对应的模型，APK 会变大，但这是隐私的合理价格。
 *
 * ── 一条必须写在代码里的诚实说明 ──
 *
 * ML Kit 的中文模型**对招聘 App 截图上的小字识别率有限**，
 * 对截图缩放、压缩、低对比度尤其敏感。因此本模块的输出**一律要求用户核对**，
 * 且界面上必须展示「原文 + 识别结果」的对照，不允许静默替换用户输入。
 * 识别不准比识别不了更危险 —— 用户会以为那就是 JD 的全部内容。
 */

/** OCR 能识别出什么语言。分开是因为模型不同、代价也不同 */
export type OcrScript = 'chinese' | 'latin';

export const OCR_SCRIPT_LABEL: Record<OcrScript, string> = {
  chinese: '中文（含英文与数字）',
  latin: '拉丁字母',
};

export const OCR_SCRIPT_WHY: Record<OcrScript, string> = {
  chinese: '国内招聘场景以中文为主，默认用这个。模型随应用打包，离线可用。',
  /*
   * 英文这一档必须说清限制，否则用户选了它却识别不出来，
   * 而界面上没有任何提示 —— 那是最糟的一种失败。
   *
   * 为什么不带英文模型：标准版 10.4MB（含大量本项目用不到的语料），
   * 中文只要 1.6MB。为英文把 APK 撑大十倍不划算。
   */
  latin: '英文 JD 用这个。**移动端暂不可用** —— 英文识别模型有 10MB，没有随应用打包；' +
    '桌面端可用。它会尝试联网取一次模型，取不到就直接失败，不会静默降级。',
};

/** 单个识别块的位置信息。用来在界面上标出「这段文字来自图片的哪个区域」 */
export interface OcrBlock {
  id: string;
  /** 识别出的文字 */
  text: string;
  /** 置信度 0–1，来自引擎。低于 0.5 的块会在界面上标出来 */
  confidence: number;
  /** 外接矩形（像素，左上角为原点） */
  rect: { left: number; top: number; width: number; height: number };
}

export interface OcrResult {
  /** 是否成功。失败时看 reason */
  ok: boolean;
  /** 失败原因。成功时为空 */
  reason?: string;
  /** 图片字节数。用于告诉用户「这张图太大了」 */
  bytes?: number;
  width?: number;
  height?: number;
  blocks?: OcrBlock[];
  /**
   * 拼好的整段文本 —— 直接喂给 `job.input_text` 的解析链路。
   * 保留换行，因为 JD 的结构（每条要求一行）靠换行才能拆对。
   */
  text?: string;
  /** 引擎标识。写进报告，便于日后判断「这份分析是基于哪一版识别」 */
  engine?: 'mlkit-ondevice' | 'manual';
}

/**
 * 识别结果的**置信度摘要**。
 *
 * 为什么要有这个：ML Kit 对招聘截图的识别率不稳定，
 * 而用户很难逐块判断「这句是不是识错了」。
 * 把整体可信度用一个离散值说出来，用户就知道该不该仔细看。
 */
export interface OcrConfidence {
  level: 'high' | 'medium' | 'low';
  /** 平均置信度 */
  avg: number;
  /** 低置信度的块数。界面上要提示「这几行请重点核对」 */
  lowCount: number;
}

export const OCR_CONFIDENCE_LABEL: Record<OcrConfidence['level'], string> = {
  high: '识别清楚，可以直接用',
  medium: '大部分清楚，少数几行请核对',
  low: '多处不确定，建议对照图片检查后再用',
};

export const OCR_CONFIDENCE_WHY: Record<OcrConfidence['level'], string> = {
  high: '截图清晰、文字较大，多数情况属于这一档。',
  medium: '常见的招聘 App 截图会落在这里 —— 字号偏小、有缩放。',
  low:
    '截图被压缩过、或者文字很小。**这种情况下强烈建议手动补充或改用粘贴文本** —— ' +
    '识别错的内容会一路影响到后面的要求拆解与匹配结论，' +
    '而你很可能根本没意识到那是识别错的。' +
    '（本项目绝不会为了补全信息去编造内容，但识别本身会出错，这两件事要分开看。）',
};

/** 低置信度阈值。低于此值的块会被单独标出 */
export const OCR_LOW_CONFIDENCE = 0.65;

export function summarizeConfidence(blocks: OcrBlock[]): OcrConfidence {
  if (blocks.length === 0) {
    return { level: 'low', avg: 0, lowCount: 0 };
  }
  const avg = blocks.reduce((s, b) => s + b.confidence, 0) / blocks.length;
  const lowCount = blocks.filter((b) => b.confidence < OCR_LOW_CONFIDENCE).length;
  // 判定不能只看均值：一张「平均 0.8 但有三行是 0.3」的截图，
  // 对用户来说与「平均 0.8 且每行都 0.8」完全不同。
  const level = avg >= 0.85 && lowCount === 0 ? 'high' : avg >= 0.7 || lowCount <= Math.max(1, blocks.length * 0.2) ? 'medium' : 'low';
  return { level, avg: Math.round(avg * 100) / 100, lowCount };
}

/**
 * 把识别块拼成整段文本。
 *
 * **按 y 坐标聚成行**而不是按返回顺序直接拼：
 * ML Kit 返回的顺序不保证是阅读顺序（尤其是手机截图，
 * 有的 SDK 会先返回底部的头像区域）。直接拼会让 JD 的条目顺序全乱，
 * 而后面的要求拆解是按顺序读���的。
 */
export function assembleOcrText(blocks: OcrBlock[], lineTolerance = 12): string {
  if (blocks.length === 0) return '';
  const sorted = [...blocks].sort((a, b) => {
    if (Math.abs(a.rect.top - b.rect.top) > lineTolerance) return a.rect.top - b.rect.top;
    return a.rect.left - b.rect.left;
  });

  const lines: Array<{ top: number; items: OcrBlock[] }> = [];
  for (const b of sorted) {
    const line = lines.find((l) => Math.abs(l.top - b.rect.top) <= lineTolerance);
    if (line) line.items.push(b);
    else lines.push({ top: b.rect.top, items: [b] });
  }
  return lines
    .map((l) => l.items.sort((a, b) => a.rect.left - b.rect.left).map((b) => b.text).join(' ').trim())
    .filter((t) => t.length > 0)
    .join('\n');
}

/** 图片大小的合理上限。
 *  为什么设上限：ML Kit 推理耗时随像素数增长，
 *  而一张 4000×3000 的招聘截图在手机上会跑十几秒，用户会以为卡死了。 */
export const OCR_MAX_BYTES = 12 * 1024 * 1024;

export const OCR_SIZE_WHY =
  '超过 12MB 的图片在手机上识别要十几秒，用户会以为卡死了。' +
  '这类图请先裁剪到只留 JD 那一屏，或改用粘贴文本。';

/**
 * OCR 结果 → 岗位解析链路的输入。
 *
 * 刻意**不自动提交**：识别结果必须经过用户确认才进解析。
 * 理由同文件头 —— 识别错的内容一路影响到匹配结论，
 * 而用户很可能根本没意识到那是识别错的。
 */
export interface OcrDraft {
  /** 识别出的整段文本，可编辑 */
  text: string;
  blocks: OcrBlock[];
  confidence: OcrConfidence;
  /** 用户是否已确认「可以拿这段文本去拆要求」 */
  confirmed: boolean;
}

/** 置信度过低时的统一提示。界面上必须出现 */
export function needsManualReview(confidence: OcrConfidence): boolean {
  return confidence.level === 'low';
}