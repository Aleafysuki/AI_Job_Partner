import { createWorker, type Worker } from 'tesseract.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * 桌面端截图 OCR（job.input_image）
 * =================================
 *
 * **完全本地推理：WASM 与训练数据都从 node_modules 里读，不发任何网络请求。**
 *
 * 为什么桌面端不用 Android 那套 ML Kit：ML Kit 是 Android 专有的，
 * Windows 上没有对应实现。可选方案有三个：
 *
 *   1. 云端 API —— 出局。截图含公司名、薪资、HR 私聊，上传即泄露。
 *   2. 打包 PP-OCR ONNX + onnxruntime —— WASM 推理在 Node 里能跑，
 *      但检测+识别+方向分类三个模型合计 10MB+，且要自己写预处理。
 *   3. tesseract.js（WASM）← 采用
 *      核心 WASM 约 4MB，中文训练数据约 2MB，全部随包分发。
 *      代价是识别速度慢于原生（一张手机截图约 3–8 秒），
 *      但它是唯一能做到「双端都本地、都离线」的选择。
 *
 * ── 与 Android 端的差异（界面上必须如实告知用户）──
 *
 *   Android（ML Kit）      2–4 秒，准确率较高（原生模型）
 *   桌面（tesseract WASM） 3–8 秒，中文小字识别率明显低于 ML Kit
 *
 * 所以桌面端识别出来的文本，界面上要给更重的核对提示。
 * 这是两个宿主的真实差异，掩盖它比能力不足更糟 ——
 * 用户会以为「桌面版更好用」，然后拿一份识别错的 JD 去做决策。
 */

/**
 * 训练数据目录：本地文件路径，不走 CDN。
 *
 * 关键点：`langPath` 必须指向**包含 .traineddata.gz 的那个目录**，
 * 而 tesseract 默认会去 jsDelivr 拉 —— 离线环境下必然失败。
 * 这个组合是本机实测出来的（见 scripts/probe-tesseract.cjs）：
 *   langPath=<数据目录> + gzip:true + cacheMethod:'none'
 * 其它组合（如显式给 corePath、给 cachePath）在 7.0.0 上结果相同，
 * 但多传参数就多一处可能出错的地方，所以保持最简。
 */
function langDir(script: 'chinese' | 'latin'): string {
  /*
   * 为什么用 __dirname 而不是 import.meta.url：
   * 本文件会被编译成 CJS（electron-vite 的主进程就是 CJS），
   * 而 CJS 里的 import.meta 会被编译成 `{}`，
   * 于是 createRequire(undefined) 抛「filename must be…absolute path」。
   * 报错发生在初始化阶段，与训练数据本身无关 —— 很容易被误判成「模型没装好」。
   */
  const require = createRequire(
    typeof __dirname === 'string' ? __filename : import.meta.url,
  );
  const pkg = script === 'chinese' ? '@tesseract.js-data/chi_sim' : '@tesseract.js-data/eng';
  // npm workspaces 会把依赖提升到仓库根，所以要从 root 找起
  const pkgJson = require.resolve(`${pkg}/package.json`, { paths: [process.cwd(), path.resolve(process.cwd(), '..')] });
  const root = path.dirname(pkgJson);
  // 优先级按「识别质量」排：best_int 是最好的模型，最慢
  const versions = ['4.0.0_best_int', '4.0.0', '3.04.0'].filter((v) =>
    require('node:fs').existsSync(path.join(root, v)),
  );
  if (versions.length === 0) {
    throw new Error(
      `本地没找到 ${pkg} 的训练数据文件。` +
        '请重新执行 npm install（训练数据随包分发，不下载会导致离线识别不可用）。',
    );
  }
  return path.join(root, versions[0]);
}

let workerPromise: Promise<Worker> | null = null;

/**
 * worker 只建一次并复用。
 *
 * 原因：初始化要加载 4MB WASM + 2MB 训练数据，耗时数秒。
 * 每次识别都重建的话，用户每传一张图就要等一次初始化 ——
 * 而截图往往要传好几张（换一张角度、换一张更清晰的）。
 */
async function getWorker(script: 'chinese' | 'latin'): Promise<Worker> {
  if (workerPromise) return workerPromise;
  /*
   * 只用单一语言，不用 'chi_sim+eng'。
   * 理由（实测）：组合写法会让 tesseract 去同一个目录下找
   * 'chi_sim+eng.traineddata.gz'，那个文件不存在 → 初始化失败。
   * 而 chi_sim 本身覆盖中英数字，测试图里的 Redis / MySQL / Kafka 都认得出来。
   */
  const lang = script === 'chinese' ? 'chi_sim' : 'eng';
  const dir = langDir(script);
  workerPromise = createWorker(lang, 1, {
    // 关键：把 core 与 langPath 都指到本地文件，
    // tesseract.js 默认会去 jsDelivr 拉 —— 那在离线环境里必然失败
    langPath: dir,
    cacheMethod: 'none',
    gzip: true,
    logger: () => {},
    errorHandler: (e: unknown) => {
      // 吞掉：单张图的识别失败不该让整个进程崩掉，
      // 上面 await 的 catch 会把错误转成结构化结果返回给渲染层
      void e;
    },
  });
  return workerPromise;
}

export interface DesktopOcrPayload {
  path: string;
  script: 'chinese' | 'latin';
}

/**
 * 识别一张图片。
 *
 * 返回结构与 Android 端**完全一致** —— 渲染层不该知道两个宿主的差异，
 * 那是它要如实告知用户的文案，不是它要分支处理的技术细节。
 */
export async function desktopOcr(payload: DesktopOcrPayload): Promise<{
  ok: boolean;
  reason?: string;
  bytes?: number;
  width?: number;
  height?: number;
  blocks: Array<{
    id: string;
    text: string;
    confidence: number;
    rect: { left: number; top: number; width: number; height: number };
  }>;
  engine: 'tesseract-wasm' | 'mlkit-ondevice';
}> {
  const MAX = 12 * 1024 * 1024;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(payload.path));
  } catch (e) {
    return {
      ok: false,
      reason: `读取图片失败：${(e as Error).message}`,
      blocks: [],
      engine: 'tesseract-wasm',
    };
  }

  if (bytes.length === 0) {
    return { ok: false, reason: '图片是空的', blocks: [], engine: 'tesseract-wasm' };
  }
  if (bytes.length > MAX) {
    return {
      ok: false,
      reason: '图片超过 12MB。请裁剪到只留 JD 那一屏，或改用粘贴文本。',
      blocks: [],
      engine: 'tesseract-wasm',
    };
  }

  let worker: Worker;
  try {
    worker = await getWorker(payload.script);
  } catch (e) {
    return {
      ok: false,
      reason: `本机 OCR 初始化失败：${(e as Error).message}`,
      blocks: [],
      engine: 'tesseract-wasm',
    };
  }

  try {
    const res = await worker.recognize(Buffer.from(bytes));
    // tesseract 的 block 层级是 page → paragraph → line → word，
    // 但 word 级太碎（一个中文词会被拆成几个），
    // 所以取 **line** 级：它大致对应「屏幕上的一行」。
    // 显式标注类型：res.data 的类型在 tesseract 7 里是可选链友好的，
    // 但中间层不给类型就全是隐式 any，typecheck 会拦
    type TLine = { text?: string; confidence?: number; bbox?: { x0: number; y0: number; x1: number; y1: number } };
    const pages = (res.data.blocks ?? []) as Array<{ paragraphs?: Array<{ lines?: TLine[] }> }>;
    const lines: TLine[] = pages.flatMap((pg) =>
      (pg.paragraphs ?? []).flatMap((para) => para.lines ?? []),
    );
    const blocks = lines
      .map((l: TLine, i: number) => ({
        id: `ocr_${i}`,
        text: tidyCjkSpacing(l.text ?? ''),
        // tesseract 的 confidence 是 0–100，ML Kit 是 0–1 —— 统一到 0–1
        confidence: typeof l.confidence === 'number' ? l.confidence / 100 : 0.5,
        rect: {
          left: Math.round(l.bbox?.x0 ?? 0),
          top: Math.round(l.bbox?.y0 ?? 0),
          width: Math.round((l.bbox?.x1 ?? 0) - (l.bbox?.x0 ?? 0)),
          height: Math.round((l.bbox?.y1 ?? 0) - (l.bbox?.y0 ?? 0)),
        },
      }))
      .filter((b) => b.text.length > 0);

    /*
     * 兜底：万一层级结构拿不到（不同 tesseract 版本行为有差异），
     * 至少把整段文本按行拆开返回 —— 没有置信度与坐标，
     * 但好过让用户看到「识别成功但什么都没有」。
     * 界面上的置信度摘要会因此偏保守（显示为低），这正是期望的行为。
     */
    const finalBlocks = blocks.length
      ? blocks
      : (res.data.text ?? '')
          .split('\n')
          .map((t) => tidyCjkSpacing(t))
          .filter((t) => t.length > 0)
          .map((t, i) => ({
            id: `ocr_${i}`,
            text: t,
            confidence: 0.5,
            rect: { left: 0, top: 0, width: 0, height: 0 },
          }));

    return {
      ok: true,
      bytes: bytes.length,
      width: 0,
      height: 0,
      blocks: finalBlocks,
      engine: 'tesseract-wasm',
    };
  } catch (e) {
    return {
      ok: false,
      reason: `识别失败：${(e as Error).message}`,
      blocks: [],
      engine: 'tesseract-wasm',
    };
  }
}

/**
 * 去掉「中文字符之间被插入的空格」。
 *
 * 这是 tesseract 中文模型的固有行为：它按字识别，然后**在每个字之间插空格**。
 * 实测输出「后 端 工 程 师」——人眼能读，但下游的岗位拆解会把它当成
 * 5 个词，切出来的要求全是碎的。
 *
 * 判据只动「中文 + 空格 + 中文」这一种模式：
 *   「后 端 工 程 师」→ 后端工程师   （要合并）
 *   「使用 Redis 做」→ 使用 Redis 做  （不动：空格是真实分隔）
 *   「3 年以上」      → 3 年以上     （不动：数字两侧的空格有意义）
 * 碰英文与数字就停手 —— 那些空格是真的词边界。
 */
function tidyCjkSpacing(text: string): string {
  const CJK = /[\u4e00-\u9fa5]/;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (
      ch === ' ' &&
      CJK.test(out[out.length - 1] ?? '') &&
      CJK.test(text[i + 1] ?? '')
    ) {
      continue; // 跳过这个空格
    }
    out += ch;
  }
  return out.trim();
}

/** 释放 worker。应用退出前调用，避免进程挂住 */
export async function disposeOcr(): Promise<void> {
  if (!workerPromise) return;
  const w = await workerPromise;
  await w.terminate();
  workerPromise = null;
}

/** 给「运行环境」页用：报告 OCR 是否真的能离线跑 */
export function ocrCapability(): { available: boolean; detail: string } {
  try {
    const dir = langDir('chinese');
    return {
      available: true,
      detail: `本地推理就绪（${path.basename(dir)}），不上传任何数据`,
    };
  } catch (e) {
    return { available: false, detail: (e as Error).message };
  }
}

export { createHash };