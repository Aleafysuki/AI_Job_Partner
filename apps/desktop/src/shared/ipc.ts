import type { HttpRequest, HttpResponse, WorkspaceSnapshot } from '@aijob/core';

/**
 * 主进程 ↔ 渲染进程的契约。
 *
 * 为什么 AI 请求要经过主进程：
 * 1. 渲染进程是浏览器环境，直连第三方 API 会被 CORS 拦掉；
 * 2. API Key 不应该出现在页面上下文里；
 * 3. 出网行为集中在主进程，便于审计与将来接入企业代理。
 *
 * v0.2 追加：面试录音 / 内录 / 静默模式。它们同样只能在主进程做：
 * - 音频分片要落盘（页面上下文没有文件系统权限）；
 * - 系统内录要走 desktopCapturer（渲染进程拿不到）；
 * - 「面试期间不弹任何提示」需要控制窗口可见性、托盘与全局快捷键，这全是主进程的事。
 */

export const IPC = {
  storageLoad: 'storage:load',
  storageSave: 'storage:save',
  storageClear: 'storage:clear',
  storageDescribe: 'storage:describe',
  httpRequest: 'http:request',
  dialogOpenFile: 'dialog:open-file',
  // 截图 OCR（v0.3 job.input_image）—— 本地推理，见 main/ocr.ts
  dialogOpenImage: 'dialog:open-image',
  ocrRecognize: 'ocr:recognize',
  fsReadBytes: 'fs:read-bytes',
  dialogSaveText: 'dialog:save-text',
  shellOpenExternal: 'shell:open-external',
  appInfo: 'app:info',
  // ---- v0.2 面试录音 ----
  captureBegin: 'capture:begin',
  captureWriteSegment: 'capture:write-segment',
  captureReadSegment: 'capture:read-segment',
  captureFinish: 'capture:finish',
  captureDiscard: 'capture:discard',
  captureOpenFolder: 'capture:open-folder',
  captureFreeSpace: 'capture:free-space',
  mediaRequestMic: 'media:request-mic',
  mediaSystemAudio: 'media:system-audio',
  mediaListSources: 'media:list-sources',
  quietSet: 'app:quiet-set',
  quietIsOn: 'app:quiet-is-on',
  hotkeySet: 'app:hotkey-set',
  dialogSaveHtml: 'dialog:save-html',
} as const;

/**
 * 主进程 → 渲染进程的事件通道。
 *
 * 只有一条：静默模式下窗口是隐藏的，用户点托盘菜单「结束录制」时，
 * 主进程自己没有能力停掉 MediaRecorder（那是页面里的对象），
 * 所以只能反过来通知页面去收尾。
 */
export const IPC_EVENTS = {
  quietStopRequested: 'quiet:stop-requested',
} as const;

export interface PickedFile {
  path: string;
  name: string;
  size: number;
}

/**
 * OCR 识别结果（v0.3 job.input_image）。
 *
 * **两个宿主共用这一份契约**，尽管底层引擎不同：
 *   Android → ML Kit（原生模型，快、准）
 *   桌面   → tesseract WASM（慢一些、中文小字弱一些）
 * `engine` 让界面能如实告知用户「现在是哪个引擎在跑」——
 * 掩盖两个宿主的差异比差异本身更糟：用户会误以为桌面版更差或更好，
 * 而不是知道「这台设备上的识别能力就是这样」。
 */
export interface OcrBlockPayload {
  id: string;
  text: string;
  /** 统一到 0–1（Android 原生就是 0–1，tesseract 是 0–100 需要换算） */
  confidence: number;
  rect: { left: number; top: number; width: number; height: number };
}

export interface OcrPayload {
  ok: boolean;
  /** 失败时为什么。成功时为空 */
  reason?: string;
  bytes?: number;
  width?: number;
  height?: number;
  blocks: OcrBlockPayload[];
  engine: 'mlkit-ondevice' | 'tesseract-wasm';
}

export interface AppInfo {
  name: string;
  version: string;
  release: string;
  platform: string;
  storageLocation: string;
  storageEngine: string;
  versions: { electron: string; node: string; chrome: string };
}

/** 录音会话在磁盘上的位置 */
export interface CapturePaths {
  sessionId: string;
  /** 会话音频目录（绝对路径） */
  directory: string;
}

export interface CaptureSummary {
  sessionId: string;
  directory: string;
  fileCount: number;
  totalBytes: number;
  files: Array<{ fileName: string; bytes: number }>;
}

export interface MicPermissionResult {
  /** granted = 可录音；denied = 用户或系统拒绝；unavailable = 没有可用输入设备 */
  status: 'granted' | 'denied' | 'unavailable';
  /** 人类可读的原因，直接展示给用户 */
  reason: string;
  devices?: Array<{ deviceId: string; label: string }>;
}

export interface QuietModeOptions {
  /** 是否显示托盘图标（静默模式下唯一的「安全出口」） */
  showTray?: boolean;
  /** 是否同时隐藏主窗口并从任务栏移除 */
  hideWindow?: boolean;
  /** 同时注册的全局快捷键；空字符串表示不注册 */
  hotkey?: string;
}

export interface DesktopBridge {
  /** 是否存在原生桥（浏览器演示模式下为 undefined） */
  readonly isDesktop: true;
  appInfo(): Promise<AppInfo>;
  storage: {
    load(): Promise<WorkspaceSnapshot | null>;
    save(snapshot: WorkspaceSnapshot): Promise<void>;
    clear(): Promise<void>;
  };
  http(request: HttpRequest): Promise<HttpResponse>;
  pickFile(): Promise<PickedFile | null>;
  readBytes(path: string): Promise<Uint8Array>;

  /**
   * v0.3 截图 OCR（job.input_image）—— **本地推理，不联网**。
   *
   * 两个宿主实现同一份契约但用不同引擎：
   *   Android → ML Kit on-device（原生模型）
   *   桌面   → tesseract WASM（随包分发，4MB WASM + 2MB 中文数据）
   * 之所以不统一引擎：ML Kit 是 Android 专有的；
   * 统一到 WASM 会让手机上的识别率掉一截，而手机才是主战场。
   */
  pickImage(): Promise<PickedFile | null>;
  ocrRecognize(req: { path: string; script: 'chinese' | 'latin' }): Promise<OcrPayload>;
  saveText(defaultName: string, content: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;

  /** v0.2：录音与内录 */
  capture: {
    /** 准备一次录制的落盘目录 */
    begin(sessionId: string): Promise<CapturePaths>;
    /** 写一段音频。返回实际写入字节数 */
    writeSegment(sessionId: string, fileName: string, bytes: Uint8Array): Promise<{ bytes: number }>;
    /** 读回一段音频（回放用） */
    readSegment(sessionId: string, fileName: string): Promise<Uint8Array>;
    /** 收尾并返回目录摘要 */
    finish(sessionId: string): Promise<CaptureSummary>;
    /** 删除整个会话的音频（需要用户显式确认） */
    discard(sessionId: string): Promise<void>;
    /** 在系统文件管理器里打开音频目录 */
    openFolder(sessionId: string): Promise<void>;
    /** 数据目录剩余空间，录制前提示用 */
    freeSpace(): Promise<{ freeBytes: number; directory: string; isLow: boolean }>;
  };

  media: {
    /** 申请麦克风。主进程据此设置媒体权限，并检查设备是否可用 */
    requestMic(): Promise<MicPermissionResult>;
    /**
     * 开关系统内录（loopback）。
     * 打开后 `getDisplayMedia({video:true,audio:true})` 会由主进程自动选择屏幕源，
     * **不弹任何系统选择框**。
     */
    setSystemAudio(enabled: boolean): Promise<boolean>;
    /** 可内录的屏幕源列表（用于界面展示「正在录制第 N 块屏幕」） */
    listSources(): Promise<Array<{ id: string; name: string }>>;
  };

  /** v0.2：静默模式 —— 面试期间不弹任何提示 */
  quiet: {
    set(on: boolean, options?: QuietModeOptions): Promise<boolean>;
    isOn(): Promise<boolean>;
    /** 订阅「托盘菜单要求结束录制」。返回取消订阅函数 */
    onStopRequested(handler: () => void): () => void;
  };

  /** 全局快捷键（Electron accelerator 语法）。传 null 注销 */
  hotkey(action: 'stop', accelerator: string | null): Promise<boolean>;

  saveHtml(defaultName: string, html: string): Promise<string | null>;
}

declare global {
  interface Window {
    aijob?: DesktopBridge;
  }
}
