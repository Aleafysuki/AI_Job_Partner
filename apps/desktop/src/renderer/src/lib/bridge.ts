import { FetchTransport, type HttpTransport, type WorkspaceSnapshot, type StoragePort } from '@aijob/core';
import type {
  AppInfo,
  CapturePaths,
  CaptureSummary,
  DesktopBridge,
  MicPermissionResult,
  OcrPayload,
  PickedFile,
  QuietModeOptions,
} from '@shared/ipc';
import { HOST_LABEL, hostKind, isAndroidHost } from './platform';
import { recognizeImage } from './ocr-wasm';

/**
 * 运行时适配层。
 *
 * 同一份界面代码要能跑在三个宿主里：
 *   - Electron：有 window.aijob 原生桥，存储走 SQLite 文件，AI 请求走主进程；
 *   - Android（Capacitor WebView）：**同样提供 window.aijob 这套契约**，
 *     只是背后换成了原生 SQLite / OkHttp / SAF / AudioRecord。
 *     这样做的目的是让本文件下面的三组实现一行都不用改 ——
 *     渲染层根本看不出自己站在哪个宿主的桥上。
 *   - 浏览器（Web 版 / 演示版）：没有桥，存储退化到 localStorage，AI 请求直接用 fetch。
 *
 * 界面层只依赖这里导出的抽象，不关心自己跑在哪。
 *
 * 唯一的例外是 `describe()` 这类**给人看的字符串**：它们必须说实话，
 * 所以按 hostKind 分支（见下方各 describe 实现）。
 */

function getBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { aijob?: DesktopBridge }).aijob;
}

export const desktop: DesktopBridge | undefined = getBridge();
export const isDesktop: boolean = Boolean(desktop);

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

const LS_KEY = 'aijob.workspace.v1';

const browserStoragePort: StoragePort = {
  async load(): Promise<WorkspaceSnapshot | null> {
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      return raw ? (JSON.parse(raw) as WorkspaceSnapshot) : null;
    } catch {
      return null;
    }
  },
  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    window.localStorage.setItem(LS_KEY, JSON.stringify(snapshot));
  },
  async clear(): Promise<void> {
    window.localStorage.removeItem(LS_KEY);
  },
  describe(): string {
    return '浏览器 localStorage（Web / 演示模式，数据只保存在当前浏览器）';
  },
};

export const storagePort: StoragePort = desktop
  ? {
      load: () => desktop.storage.load(),
      save: (snapshot) => desktop.storage.save(snapshot),
      clear: () => desktop.storage.clear(),
      describe: () =>
        isAndroidHost
          ? 'Android 本地 SQLite 数据库（应用私有目录，不联网、不建账号）'
          : '桌面端本地数据文件（不联网、不建账号）',
    }
  : browserStoragePort;

// ---------------------------------------------------------------------------
// 出网
// ---------------------------------------------------------------------------

export const transport: HttpTransport = desktop
  ? {
      describe: () =>
        isAndroidHost
          ? '由 Android 原生网络栈（OkHttp）发起请求（不受同源策略限制，API Key 不进入页面）'
          : '由桌面主进程发起请求（不受浏览器同源策略限制，API Key 不进入页面）',
      request: (req) => desktop.http(req),
    }
  : new FetchTransport();

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

export interface PickedBytes {
  name: string;
  bytes: Uint8Array;
}

/**
 * 选择一张图片用于本地 OCR（v0.3 job.input_image）。
 *
 * 与 pickFile 的区别：只接受图片，且**不读回字节** ——
 * 识别在各自的宿主里做（桌面主进程跑 WASM，Android 侧跑 ML Kit），
 * 渲染层只负责把路径传下去。
 */
export async function pickImage(): Promise<PickedFile | null> {
  if (desktop) return desktop.pickImage();
  return null;
}

/**
 * 本地 OCR。
 *
 * 两个宿主实现同一份契约但用不同引擎（都**不联网**）：
 *   Android → ML Kit on-device（约 2MB AAR，模型在 APK 里）
 *   桌面   → tesseract WASM（随 npm 包分发，本地文件）
 *
 * 浏览器预览（既不是桌面也不是 Android）**不支持**：
 * 那条路只能走云端 API，而云端会泄露截图内容 ——
 * 与「数据只在本机」冲突，所以宁可不给功能。
 */
export async function ocrRecognize(req: {
  path: string;
  script: 'chinese' | 'latin';
}): Promise<OcrPayload> {
  /*
   * 渲染层 OCR，两个宿主走同一条路（WebView / 渲染进程里跑 tesseract WASM）。
   *
   * 初版这里是「Android 走 ML Kit、桌面走 WASM」，实测后撤回了 ——
   * 理由见 apps/android/android/app/build.gradle 里那段撤回记录。
   *
   * 所以现在只需要从宿主拿**字节**：两个宿主都已有 file.readBytes。
   */
  if (!desktop) {
    return {
      ok: false,
      reason:
        '这个环境没有原生桥，无法读取本地图片。' +
        '桌面端与 Android 端都可以用本地 OCR，两者都不上传图片。',
      blocks: [],
      engine: 'tesseract-wasm',
    };
  }
  try {
    const bytes = await desktop.readBytes(req.path);
    return await recognizeImage(bytes, req.script);
  } catch (e) {
    return {
      ok: false,
      reason: '读取图片失败：' + (e as Error).message,
      blocks: [],
      engine: 'tesseract-wasm',
    };
  }
}

/** 选择简历文件。桌面端用系统文件对话框，浏览器端用 <input type="file"> */
export async function pickFile(): Promise<PickedBytes | null> {
  if (desktop) {
    const picked = await desktop.pickFile();
    if (!picked) return null;
    const bytes = await desktop.readBytes(picked.path);
    return { name: picked.name, bytes };
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.md,.markdown,.pdf,.docx';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const buffer = reader.result as ArrayBuffer;
        resolve({ name: file.name, bytes: new Uint8Array(buffer) });
      };
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(file);
    };
    input.click();
  });
}

/** 导出文本（v0.1 用于导出结构化 JSON，便于用户自己留存） */
export async function saveText(defaultName: string, content: string): Promise<string | null> {
  if (desktop) return desktop.saveText(defaultName, content);
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(url);
  return defaultName;
}

// ---------------------------------------------------------------------------
// 面试录音 / 内录 / 静默模式（v0.2 追加）
//
// 桌面端这三件事全在主进程做（文件权限、desktopCapturer、窗口与托盘）。
// 浏览器 / 演示模式下的策略很明确：**如实声明不支持**，而不是假装成功 ——
// 录制是「错过就没了」的事情，让用户误以为在录是这套功能里最糟的失败方式。
//
// 唯一在两种宿主下都可用的是「手工粘贴转写文本 → 生成复盘报告」，
// 那是最短可用路径，也是冒烟测试覆盖的那条。
// ---------------------------------------------------------------------------

export interface CapturePort {
  supported: boolean;
  begin(sessionId: string): Promise<CapturePaths>;
  writeSegment(sessionId: string, fileName: string, bytes: Uint8Array): Promise<{ bytes: number }>;
  readSegment(sessionId: string, fileName: string): Promise<Uint8Array>;
  finish(sessionId: string): Promise<CaptureSummary>;
  discard(sessionId: string): Promise<void>;
  openFolder(sessionId: string): Promise<void>;
  freeSpace(): Promise<{ freeBytes: number; directory: string; isLow: boolean }>;
}

export interface MediaPort {
  requestMic(): Promise<MicPermissionResult>;
  setSystemAudio(enabled: boolean): Promise<boolean>;
  listSources(): Promise<Array<{ id: string; name: string }>>;
}

export interface QuietPort {
  set(on: boolean, options?: QuietModeOptions): Promise<boolean>;
  isOn(): Promise<boolean>;
  onStopRequested(handler: () => void): () => void;
}

const unsupportedCapture: CapturePort = {
  supported: false,
  async begin() {
    throw new Error('浏览器 / 演示模式不支持录音落盘，请使用桌面端');
  },
  async writeSegment() {
    throw new Error('浏览器 / 演示模式不支持录音落盘，请使用桌面端');
  },
  async readSegment() {
    throw new Error('浏览器 / 演示模式不支持读取录音');
  },
  async finish(sessionId) {
    return { sessionId, directory: '（浏览器模式无录音目录）', fileCount: 0, totalBytes: 0, files: [] };
  },
  async discard() {
    /* 无文件可弃 */
  },
  async openFolder() {
    /* 无目录可开 */
  },
  async freeSpace() {
    return { freeBytes: -1, directory: '（浏览器模式）', isLow: false };
  },
};

export const capturePort: CapturePort = desktop
  ? {
      supported: true,
      begin: (sessionId) => desktop.capture.begin(sessionId),
      writeSegment: (sessionId, fileName, bytes) => desktop.capture.writeSegment(sessionId, fileName, bytes),
      readSegment: (sessionId, fileName) => desktop.capture.readSegment(sessionId, fileName),
      finish: (sessionId) => desktop.capture.finish(sessionId),
      discard: (sessionId) => desktop.capture.discard(sessionId),
      openFolder: (sessionId) => desktop.capture.openFolder(sessionId),
      freeSpace: () => desktop.capture.freeSpace(),
    }
  : unsupportedCapture;

export const mediaPort: MediaPort = desktop
  ? {
      requestMic: () => desktop.media.requestMic(),
      setSystemAudio: (enabled) => desktop.media.setSystemAudio(enabled),
      listSources: () => desktop.media.listSources(),
    }
  : {
      async requestMic() {
        return { status: 'unavailable', reason: '浏览器 / 演示模式不支持桌面内录，麦克风权限由浏览器自行管理' };
      },
      async setSystemAudio() {
        return false;
      },
      async listSources() {
        return [];
      },
    };

/** 浏览器模式下静默开关只是记账：不弹提示这件事由界面层遵守 */
let browserQuiet = false;

export const quietPort: QuietPort = desktop
  ? {
      set: (on, options) => desktop.quiet.set(on, options),
      isOn: () => desktop.quiet.isOn(),
      onStopRequested: (handler) => desktop.quiet.onStopRequested(handler),
    }
  : {
      async set(on) {
        browserQuiet = on;
        return on;
      },
      async isOn() {
        return browserQuiet;
      },
      onStopRequested() {
        return () => undefined;
      },
    };

export async function setStopHotkey(accelerator: string | null): Promise<boolean> {
  if (!desktop) return false;
  return desktop.hotkey('stop', accelerator);
}

/** 导出复盘 HTML。桌面端走保存对话框，浏览器端直接下载 */
export async function saveHtml(defaultName: string, html: string): Promise<string | null> {
  if (desktop) return desktop.saveHtml(defaultName, html);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(url);
  return defaultName;
}

// ---------------------------------------------------------------------------
// 运行环境信息
// ---------------------------------------------------------------------------

export interface RuntimeInfo {
  isDesktop: boolean;
  label: string;
  detail: string;
  storage: string;
  transport: string;
  versions?: Record<string, string>;
}

export async function runtimeInfo(): Promise<RuntimeInfo> {
  const base: RuntimeInfo = {
    isDesktop,
    label: HOST_LABEL[hostKind],
    detail: isAndroidHost
      ? '数据保存在手机本机，不建立账号，不上传简历；录音文件落在应用私有目录'
      : isDesktop
        ? '数据保存在本机，不建立账号，不上传简历'
        : '数据保存在当前浏览器 localStorage；AI 请求直接由浏览器发出，可能受跨域限制',
    storage: storagePort.describe(),
    transport: transport.describe(),
  };

  if (!desktop) return base;

  try {
    const info: AppInfo = await desktop.appInfo();
    return {
      ...base,
      storage: `${info.storageEngine}\n${info.storageLocation}`,
      // 桌面端报 Electron / Node / Chromium 三件套；Android 宿主没有前两者，
      // 如实换成系统版本与 WebView 版本。
      // 把 Android 上的 Node 显示成「—」比编一个版本号诚实 —— 设置页里
      // 那一栏的作用就是让用户核对「我到底跑在什么上面」。
      versions: isAndroidHost
        ? { Android: info.platform, WebView: info.versions.chrome }
        : { Electron: info.versions.electron, Node: info.versions.node, Chromium: info.versions.chrome },
    };
  } catch {
    return base;
  }
}
