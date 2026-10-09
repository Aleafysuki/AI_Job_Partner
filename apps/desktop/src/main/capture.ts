import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  desktopCapturer,
  globalShortcut,
  nativeImage,
  session,
  shell,
  systemPreferences,
} from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CapturePaths, CaptureSummary, MicPermissionResult, QuietModeOptions } from '../shared/ipc';

/**
 * 面试录音的宿主能力。
 * =================================
 *
 * 渲染进程能做的只有「采集音频字节」这一件事；下面这些只能由主进程完成：
 *
 *   1. **落盘** —— 页面上下文没有文件系统权限，录音分片必须经 IPC 交给主进程写；
 *   2. **内录** —— 捕获系统播放的声音（loopback）要走 `desktopCapturer` 与
 *      `setDisplayMediaRequestHandler`，而且必须显式关掉系统选择器，
 *      否则线上面试时会在共享屏幕上弹出一个「选择要共享的内容」对话框；
 *   3. **静默** —— 「面试期间不弹任何提示」意味着要控制窗口可见性、任务栏、托盘、通知，
 *      这些都是主进程的领域；
 *   4. **安全出口** —— 窗口隐藏之后，用户必须还能停掉录制。
 *      这里用托盘菜单 + 全局快捷键两条独立通道，任一可用即可。
 *
 * 一条不可让步的规则：**本模块内不出现任何 `new Notification()`**。
 * 面试进行中弹出的系统通知，是这套功能唯一真正无法挽回的失败方式。
 */

// ---------------------------------------------------------------------------
// 路径与文件名安全
// ---------------------------------------------------------------------------

/** 会话 id 由渲染层生成，但落盘前必须校验 —— 否则 `../` 就能写到数据目录外面 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const SEGMENT_FILE_RE = /^seg-\d{4,6}\.(webm|ogg|mp4|m4a|wav)$/;

function assertSessionId(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`非法的会话 id：${sessionId}`);
  return sessionId;
}

function assertSegmentFileName(fileName: string): string {
  if (!SEGMENT_FILE_RE.test(fileName)) throw new Error(`非法的音频文件名：${fileName}`);
  return fileName;
}

/** 已丢弃的录音从这里走，而不是直接 unlink —— 误删的代价比多占一点磁盘高得多 */
const DISCARD_DIR = '_discarded';
const TRASH_PREFIX = 'discarded-at-';

function recordingsRoot(): string {
  return path.join(app.getPath('userData'), 'recordings');
}

function sessionDir(sessionId: string): string {
  return path.join(recordingsRoot(), assertSessionId(sessionId));
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

export async function captureBegin(sessionId: string): Promise<CapturePaths> {
  const directory = sessionDir(sessionId);
  await fs.mkdir(directory, { recursive: true });
  return { sessionId, directory };
}

export async function captureWriteSegment(
  sessionId: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<{ bytes: number }> {
  const directory = sessionDir(sessionId);
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, assertSegmentFileName(fileName));
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await fs.writeFile(target, buffer);
  return { bytes: buffer.byteLength };
}

export async function captureReadSegment(sessionId: string, fileName: string): Promise<Uint8Array> {
  const target = path.join(sessionDir(sessionId), assertSegmentFileName(fileName));
  const buf = await fs.readFile(target);
  return new Uint8Array(buf);
}

export async function captureFinish(sessionId: string): Promise<CaptureSummary> {
  const directory = sessionDir(sessionId);
  let files: Array<{ fileName: string; bytes: number }> = [];
  try {
    const entries = await fs.readdir(directory);
    files = [];
    for (const entry of entries) {
      if (!SEGMENT_FILE_RE.test(entry)) continue;
      const stat = await fs.stat(path.join(directory, entry));
      files.push({ fileName: entry, bytes: stat.size });
    }
    files.sort((a, b) => a.fileName.localeCompare(b.fileName));
  } catch {
    files = [];
  }
  return {
    sessionId,
    directory,
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    files,
  };
}

/**
 * 丢弃一次录制的音频。
 *
 * **不是删除**：整个会话目录被移动到 `recordings/_discarded/` 下并加时间戳。
 * 原因很直接 —— 录音是不可再生的（面试不会重来），而磁盘空间是廉价的。
 * 真要彻底清掉，用户可以在文件管理器里自己删那个目录。
 */
export async function captureDiscard(sessionId: string): Promise<void> {
  const directory = sessionDir(sessionId);
  const exists = await fs
    .access(directory)
    .then(() => true)
    .catch(() => false);
  if (!exists) return;

  const discardRoot = path.join(recordingsRoot(), DISCARD_DIR);
  await fs.mkdir(discardRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(discardRoot, `${TRASH_PREFIX}${stamp}-${sessionId}`);
  await fs.rename(directory, target);
}

export async function captureOpenFolder(sessionId: string): Promise<void> {
  const directory = sessionDir(sessionId);
  await fs.mkdir(directory, { recursive: true });
  await shell.openPath(directory);
}

/** 录制前提示磁盘空间：40 分钟 opus 大约 15–20MB，低于 200MB 就提醒 */
const LOW_SPACE_BYTES = 200 * 1024 * 1024;

export async function captureFreeSpace(): Promise<{ freeBytes: number; directory: string; isLow: boolean }> {
  const directory = recordingsRoot();
  await fs.mkdir(directory, { recursive: true });
  try {
    const stats = await fs.statfs(directory);
    const freeBytes = Number(stats.bsize) * Number(stats.bavail);
    return { freeBytes, directory, isLow: freeBytes < LOW_SPACE_BYTES };
  } catch {
    return { freeBytes: -1, directory, isLow: false };
  }
}

// ---------------------------------------------------------------------------
// 媒体权限与内录
// ---------------------------------------------------------------------------

/**
 * 允许页面使用麦克风。
 *
 * Electron 默认对 `media` 权限是「询问」，但我们的宿主没有实现询问 UI ——
 * 结果就是无声地被拒。这里显式放行，并把它限制在自家页面上：
 * 只有加载本地文件或开发服务器地址的 webContents 才给权限。
 */
export function installPermissionHandlers(): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission !== 'media') {
      callback(false);
      return;
    }
    const url = webContents?.getURL() ?? '';
    const trusted =
      url.startsWith('file://') ||
      url.startsWith('devtools://') ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url) ||
      (Boolean(process.env.ELECTRON_RENDERER_URL) && url.startsWith(process.env.ELECTRON_RENDERER_URL as string));
    callback(trusted);
  });

  // 有些版本会先走 check 再走 request，两处都要放行，否则会出现"偶发拿不到麦克风"
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission !== 'media') return false;
    const url = webContents?.getURL() ?? '';
    return url.startsWith('file://') || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url);
  });
}

/**
 * 开关系统内录。
 *
 * `useSystemPicker: false` 是关键：不设它，macOS 与部分 Windows 配置下
 * 会弹出系统级的「选择要共享的屏幕」对话框 —— 线上面试时那个框会出现在共享画面上。
 *
 * 平台差异（界面上要如实告知用户）：
 *   - Windows：`loopback` 直接可用，能录到扬声器输出；
 *   - macOS：需要先装虚拟音频设备（如 BlackHole），否则拿不到声音；
 *   - Linux：需要 PipeWire / PulseAudio 的 monitor 源。
 */
export function setSystemAudioCapture(enabled: boolean): boolean {
  if (!enabled) {
    session.defaultSession.setDisplayMediaRequestHandler(null);
    return true;
  }
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const primary = sources[0];
          if (!primary) {
            callback({});
            return;
          }
          callback({ video: primary, audio: 'loopback' });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
  return true;
}

export async function listScreenSources(): Promise<Array<{ id: string; name: string }>> {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    return sources.map((s) => ({ id: s.id, name: s.name }));
  } catch {
    return [];
  }
}

/**
 * 麦克风权限。
 *
 * 注意这里返回 'granted' 只代表**应用层与系统层没拦**，
 * 不代表真的能录到声音 —— 设备是否插着、是否被其他程序独占，
 * 只有渲染进程真的 getUserMedia 才知道。所以界面要把这两步分开说。
 */
export async function requestMicrophone(): Promise<MicPermissionResult> {
  try {
    if (process.platform === 'darwin') {
      const current = systemPreferences.getMediaAccessStatus('microphone');
      if (current !== 'granted') {
        const ok = await systemPreferences.askForMediaAccess('microphone');
        if (!ok) {
          return {
            status: 'denied',
            reason: '系统麦克风权限未授权。请到「系统设置 → 隐私与安全性 → 麦克风」里允许本应用。',
          };
        }
      }
    } else {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'denied') {
        return {
          status: 'denied',
          reason: 'Windows 隐私设置禁止了麦克风访问。请到「设置 → 隐私和安全性 → 麦克风」里允许桌面应用使用麦克风。',
        };
      }
    }
    return { status: 'granted', reason: '已允许使用麦克风' };
  } catch (err) {
    return { status: 'denied', reason: `申请麦克风权限失败：${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// 静默模式：面试期间不弹任何提示
// ---------------------------------------------------------------------------

/**
 * 托盘图标用代码生成，避免为一个 16px 的点引入二进制资源文件。
 * 40 行左右的常量换来「打包时不用管图标路径」，这笔账划算。
 */
const TRAY_ICON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAbElEQVR42mNgwAP83Z4KgjADKQCoQQ+I24H4KBA/heKjUDE9QpozoBr+48AguQx8mv8TiTOwOfspCQY8RfEO1H//ScTtyAYcJcOAo8hR9ZQMA56Co5hiAyj2ArUCkbJopDghUSUpUyUzkZOdAezIo0Ru0SvnAAAAAElFTkSuQmCC';
const TRAY_ICON_2X_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA3ElEQVR42s2Xyw2EMAxEc6ECKqCZvXKlgjRCBamARmjEBaCUkbXQrLSfaAmQ2EZ6FwSagTgT27mL1/jYOqYHnWt9QWhiArMyxERAuBfwTF9TeGBmiKRCCO8Md8X9SeGcEX91fcMN4W9CcZ1AfKko/mIpMlH5y3/+RMmap8b4f9VOAgYouzuwbZIQcy5kSNAAfYQV0isJM0lV/vGOQI5LG1jfg4cUDNAeTCjAqGAg7oVowYDuEqgXoZVtqB5EulGsfhiZOI7VGxITLZmJplS9LTcxmJgZzUwMp63H8ydcjDNWGJSOVgAAAABJRU5ErkJggg==';

let tray: Tray | null = null;
let quietOn = false;
let quietStopHotkey: string | null = null;

function trayImage() {
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG}`);
  image.addRepresentation({
    scaleFactor: 2,
    dataURL: `data:image/png;base64,${TRAY_ICON_2X_PNG}`,
  });
  return image;
}

interface QuietDeps {
  mainWindow: () => BrowserWindow | null;
  quit: () => void;
}

let deps: QuietDeps | null = null;

export function initQuietMode(dependencies: QuietDeps): void {
  deps = dependencies;
}

function requestStopFromRenderer(): void {
  const win = deps?.mainWindow();
  win?.webContents.send('quiet:stop-requested');
}

function ensureTray(): void {
  if (tray) return;
  tray = new Tray(trayImage());
  tray.setToolTip('AI Job Partner · 正在静默录制');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示应用界面（录制继续）',
        click: () => {
          // 只看一眼，不影响录制，也不退出静默 —— 静默的核心是「不弹提示」，
          // 而不是「窗口必须消失」；用户自己决定要不要最小化。
          const win = deps?.mainWindow();
          win?.show();
          win?.focus();
        },
      },
      {
        label: '结束本次录制并回到应用',
        click: () => {
          requestStopFromRenderer();
          setQuietMode(false);
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => deps?.quit() },
    ]),
  );
  tray.on('click', () => {
    // 点一下就回应用，但不结束录制 —— 用户可能只是想看一眼时间
    const win = deps?.mainWindow();
    win?.show();
    win?.focus();
  });
}

function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

export function isQuietMode(): boolean {
  return quietOn;
}

export function registerStopHotkey(accelerator: string | null): boolean {
  if (quietStopHotkey) {
    globalShortcut.unregister(quietStopHotkey);
    quietStopHotkey = null;
  }
  if (!accelerator) return true;
  try {
    const ok = globalShortcut.register(accelerator, () => {
      requestStopFromRenderer();
      setQuietMode(false);
    });
    if (ok) quietStopHotkey = accelerator;
    return ok;
  } catch {
    return false;
  }
}

/**
 * 进入 / 退出静默模式。
 *
 * 「静默」= 面试进行中不出现任何提示。具体由三部分构成：
 *   1. 渲染层不再弹 toast / 模态 / 对话框（由界面层遵守，见 store 的 quiet 分支）；
 *   2. 主进程不弹系统通知（本模块根本没有 Notification 的引用）；
 *   3. 可选地把窗口藏起来 + 从任务栏移除，并常驻一个托盘图标作为安全出口。
 *
 * 退出静默时把窗口恢复出来，并注销快捷键 —— 快捷键不注销会泄漏到下次启动。
 */
export function setQuietMode(on: boolean, options: QuietModeOptions = {}): boolean {
  const win = deps?.mainWindow() ?? null;
  quietOn = on;

  if (on) {
    if (options.showTray !== false) ensureTray();
    if (options.hotkey !== undefined) {
      const ok = registerStopHotkey(options.hotkey || null);
      if (!ok) console.warn(`[quiet] 全局快捷键 ${options.hotkey} 注册失败，请改用托盘菜单结束录制`);
    }
    if (options.hideWindow !== false && win && !win.isDestroyed()) {
      win.setSkipTaskbar(true);
      win.hide();
    }
    if (process.platform === 'darwin') app.dock?.hide();
    return true;
  }

  destroyTray();
  registerStopHotkey(null);
  if (win && !win.isDestroyed()) {
    win.setSkipTaskbar(false);
    win.show();
    win.focus();
  }
  if (process.platform === 'darwin') app.dock?.show();
  return false;
}

/** 应用退出前务必清干净，否则快捷键会泄漏到下一次启动 */
export function disposeQuietMode(): void {
  destroyTray();
  registerStopHotkey(null);
}
