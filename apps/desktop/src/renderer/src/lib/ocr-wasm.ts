import type { OcrBlockPayload as OcrBlock, OcrPayload } from '@shared/ipc';

/**
 * 渲染层 OCR（v0.3 `job.input_image`）
 * ====================================
 *
 * **两个宿主跑的是同一份实现** —— 在 WebView / 渲染进程里跑 tesseract WASM。
 *
 * ── 为什么不是「每个宿主用各自的原生方案」──
 *
 * 初版走的是「Android 用 ML Kit on-device、桌面用 tesseract WASM」，
 * 实测后撤回了：ML Kit 16.x / 19.x 的 AAR 里**不含公开 API 类**
 * （TextRecognition / TextRecognizer 都不在里面，它们走 dynamite 运行时加载），
 * 于是编译直接报「找不到符号」。
 *
 * 撤回之后反而更好，理由有三：
 *   1. 两端行为一致 —— 同一份 JS、同一个模型、同一份识别质量；
 *   2. 只维护一份实现，不用两套 API 各测一遍；
 *   3. APK 不必因为 ML Kit 的 dynamite 组件额外变大。
 *
 * 代价：比原生慢，且中文小字识别率弱一些。
 * 这个代价由界面上的引擎标识承担（见 domain/ocr.ts），而不是藏起来。
 *
 * ── 为什么 wasm 与模型都能离线 ──
 *
 * tesseract.js 默认从 jsDelivr 拉 core 与训练数据 —— 离线必然失败。
 * 所以两者都要由打包流程放进 assets，这里从相对路径读：
 *   wasm  → <base>/tesseract/tesseract-core-simd-lstm.wasm.js
 *   模型  → <base>/tesseract/chi_sim.traineddata.gz
 * 路径与 apps/desktop/scripts/sync-tesseract.mjs 里的产出目录一致。
 */

/** 识别器句柄。tesseract 的 worker 很贵（要初始化 WASM + 模型），全局只建一次 */
let workerPromise: Promise<TesseractWorker> | null = null;

/** tesseract.js 的最小接口声明。不 import 它的类型是为了让 core 不依赖它 */
interface TesseractWorker {
  recognize(
    image: unknown,
    output?: unknown,
    options?: { blocks?: boolean },
  ): Promise<{
    data: {
      text?: string;
      blocks?: Array<{ paragraphs?: Array<{ lines?: TLine[] }> }>;
    };
  }>;
  terminate(): Promise<unknown>;
}

interface TLine {
  text?: string;
  confidence?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

type TesseractModule = {
  createWorker: (
    lang: string,
    oem: number,
    opts: Record<string, unknown>,
  ) => Promise<TesseractWorker>;
};

const MAX_BYTES = 12 * 1024 * 1024;

/** 资源基址。Capacitor 下 base 是 capacitor://localhost 或 file:// */
function assetBase(): string {
  const href = window.location.href;
  const m = /^(.*\/assets\/)/.exec(href);
  return m ? m[1] : new URL('.', href).href;
}

function langFile(script: 'chinese' | 'latin'): string {
  return script === 'chinese' ? 'chi_sim' : 'eng';
}

async function getWorker(script: 'chinese' | 'latin'): Promise<TesseractWorker> {
  // 同一语言复用；换语言要重建 worker（模型不同）
  const key = langFile(script);
  if (workerPromise && (workerPromise as Promise<TesseractWorker> & { __lang?: string }).__lang === key) {
    return workerPromise;
  }
  if (workerPromise) {
    const old = await workerPromise;
    await old.terminate();
    workerPromise = null;
  }

  const mod = (await import(/* @vite-ignore */ 'tesseract.js')) as unknown as TesseractModule;
  const base = assetBase();
  const langPath = `${base}tesseract`;

  /*
   * worker 必须包成 blob，理由很具体：
   *
   * tesseract.js 用 `importScripts()` 加载 worker —— 那是 **Worker 上下文**，
   * 而应用里的 JS 是 ES module。在 Worker 里 import 一个 module 脚本会报
   * `Uncaught SyntaxError: In strict mode code, functions can only be declared
   * at top level`，而这个错与「文件不存在」毫无字面关系，极难定位
   * （本轮为此花了不少时间）。
   *
   * tesseract 自己提供了 `workerBlobURL` 选项：它会把脚本包成
   * `importScripts("data:...")` 再建 Worker，避开 module 与 classic 的冲突。
   */
  const p = mod.createWorker(langFile(script), 1, {
    langPath,
    workerBlobURL: true,
    corePath: `${base}tesseract/tesseract-core-simd-lstm.wasm.js`,
    cacheMethod: 'none',
    logger: () => {},
    errorHandler: () => {
      /* 单张图识别失败不该让整个应用崩 —— 下面 await 的 catch 会转成结构化结果 */
    },
  }) as Promise<TesseractWorker> & { __lang?: string };
  p.__lang = key;
  workerPromise = p;
  return p;
}

/**
 * 去掉「中文字符之间被插入的空格」。
 *
 * tesseract 中文模型按字识别然后在字之间插空格，
 * 实测输出「后 端 工 程 师」—— 人眼能读，
 * 但下游的岗位拆解会把它当成 5 个词，切出来的要求全是碎的。
 *
 * 判据只动「中文 + 空格 + 中文」：碰英文与数字就停手 —— 那些空格是真的词边界。
 */
function tidyCjkSpacing(text: string): string {
  const CJK = /[一-龥]/;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ' && CJK.test(out[out.length - 1] ?? '') && CJK.test(text[i + 1] ?? '')) continue;
    out += ch;
  }
  return out.trim();
}

/**
 * 识别一张图片。
 *
 * @param bytes  图片字节。**不放进 URL** —— 一张 4MB 的图编成 data URL
 *               会撑爆 WebView 的消息通道，而且 tesseract 能直接吃 Uint8Array。
 */
export async function recognizeImage(
  bytes: Uint8Array,
  script: 'chinese' | 'latin',
): Promise<OcrPayload> {
  if (bytes.length === 0) {
    return { ok: false, reason: '图片是空的', blocks: [], engine: 'tesseract-wasm' };
  }
  if (bytes.length > MAX_BYTES) {
    return {
      ok: false,
      reason: '图片超过 12MB。请裁剪到只留 JD 那一屏，或改用粘贴文本。',
      blocks: [],
      engine: 'tesseract-wasm',
    };
  }

  let worker: TesseractWorker;
  try {
    worker = await getWorker(script);
  } catch (e) {
    return {
      ok: false,
      reason:
        '本机 OCR 初始化失败：' +
        (e as Error).message +
        '（模型文件不在应用里时会出现这个。重装应用通常能解决。）',
      blocks: [],
      engine: 'tesseract-wasm',
    };
  }

  try {
    // blocks: true 不能省 —— 默认不返回层级结构，
    // 而我们需要每行的置信度与包围盒（没有包围盒就没法在原图上标位置）
    const res = await worker.recognize(bytes, {}, { blocks: true });
    const lines: TLine[] = (res.data.blocks ?? [])
      .flatMap((pg) => (pg.paragraphs ?? []).flatMap((para) => para.lines ?? []));

    let blocks: OcrBlock[] = lines
      .map((l, i) => ({
        id: `ocr_${i}`,
        text: tidyCjkSpacing(l.text ?? ''),
        // tesseract 是 0–100，统一到 0–1
        confidence: typeof l.confidence === 'number' ? l.confidence / 100 : 0.5,
        rect: {
          left: Math.round(l.bbox?.x0 ?? 0),
          top: Math.round(l.bbox?.y0 ?? 0),
          width: Math.round((l.bbox?.x1 ?? 0) - (l.bbox?.x0 ?? 0)),
          height: Math.round((l.bbox?.y1 ?? 0) - (l.bbox?.y0 ?? 0)),
        },
      }))
      .filter((b) => b.text.length > 0);

    // 兜底：层级结构拿不到时，至少按行拆开返回
    if (blocks.length === 0) {
      blocks = (res.data.text ?? '')
        .split('\n')
        .map((t) => tidyCjkSpacing(t))
        .filter((t) => t.length > 0)
        .map((t, i) => ({
          id: `ocr_${i}`,
          text: t,
          confidence: 0.5,
          rect: { left: 0, top: 0, width: 0, height: 0 },
        }));
    }

    return {
      ok: true,
      bytes: bytes.length,
      width: 0,
      height: 0,
      blocks,
      engine: 'tesseract-wasm',
    };
  } catch (e) {
    return {
      ok: false,
      reason: '识别失败：' + (e as Error).message,
      blocks: [],
      engine: 'tesseract-wasm',
    };
  }
}

/** 释放识别器。应用退出前调用 */
export async function disposeOcr(): Promise<void> {
  if (!workerPromise) return;
  const w = await workerPromise;
  await w.terminate();
  workerPromise = null;
}