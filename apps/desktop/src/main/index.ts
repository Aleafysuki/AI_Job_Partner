import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { desktopOcr } from './ocr';
import { APP_NAME, APP_VERSION, CURRENT_RELEASE, IMPORT_ACCEPT, type HttpRequest, type HttpResponse } from '@aijob/core';
import {
  IPC,
  type AppInfo,
  type CapturePaths,
  type CaptureSummary,
  type MicPermissionResult,
  type PickedFile,
  type QuietModeOptions,
} from '../shared/ipc';
import { createStore, type PersistentStore } from './storage';
import {
  captureBegin,
  captureDiscard,
  captureFinish,
  captureFreeSpace,
  captureOpenFolder,
  captureReadSegment,
  captureWriteSegment,
  disposeQuietMode,
  initQuietMode,
  installPermissionHandlers,
  isQuietMode,
  listScreenSources,
  registerStopHotkey,
  requestMicrophone,
  setQuietMode,
  setSystemAudioCapture,
} from './capture';

/**
 * 主进程。
 *
 * 只做四件事：开窗口、管存储、代理出网请求、处理文件系统相关的原生能力。
 * 所有业务逻辑都在 @aijob/core 里，主进程不参与任何分析判断。
 */

let mainWindow: BrowserWindow | null = null;
let store: PersistentStore | null = null;

const isDev = !app.isPackaged;

// 必须在使用 app.getPath('userData') 之前设置：
// 默认取 package.json 的 name（@aijob/desktop），会生成带 @ 和 / 的目录，既难看又容易踩路径问题。
app.setName('AI Job Partner');

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#f6f7f9',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      /**
       * 面试录音必须关掉后台节流。
       *
       * 静默模式会把主窗口隐藏起来，而 Chromium 默认会大幅限制后台窗口的定时器
       * （大约 1 次/分钟）。分段录制靠的就是定时器 —— 一旦被节流，
       * 一段 20 秒的录音会变成一分钟才切一次，甚至整场录不下来。
       */
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 外部链接一律交给系统浏览器，避免在应用内打开未知页面
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') mainWindow?.webContents.toggleDevTools();
    });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// 出网代理
// ---------------------------------------------------------------------------

async function forwardRequest(req: HttpRequest): Promise<HttpResponse> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { ok: false, status: 0, text: '', networkError: `非法地址：${req.url}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, status: 0, text: '', networkError: `不支持的协议：${url.protocol}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs || 60_000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    const text = await res.text();
    console.log(`[http] ${req.method} ${url.host}${url.pathname} → ${res.status} (${Date.now() - started}ms)`);
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    const e = err as Error;
    const reason = e?.name === 'AbortError' ? `请求超时（>${req.timeoutMs}ms）` : e?.message || String(err);
    console.warn(`[http] 失败 ${url.host}${url.pathname}: ${reason}`);
    return { ok: false, status: 0, text: '', networkError: reason };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(IPC.storageLoad, async () => (store ? store.load() : null));
  ipcMain.handle(IPC.storageSave, async (_e, snapshot: unknown) => {
    if (!store) return;
    await store.save(snapshot);
  });
  ipcMain.handle(IPC.storageClear, async () => {
    if (!store) return;
    await store.clear();
  });
  ipcMain.handle(IPC.storageDescribe, async () => (store ? store.describe() : '不可用'));

  ipcMain.handle(IPC.httpRequest, async (_e, req: unknown) => forwardRequest(req as HttpRequest));

  ipcMain.handle(IPC.dialogOpenFile, async (): Promise<PickedFile | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择简历文件',
      properties: ['openFile'],
      filters: [
        { name: '简历文件', extensions: IMPORT_ACCEPT.split(',').map((e) => e.replace('.', '')) },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const stat = await fs.stat(filePath);
    return { path: filePath, name: path.basename(filePath), size: stat.size };
  });

  /*
   * 截图 OCR（v0.3 job.input_image）
   *
   * 选图与识别分成两个通道，和 Android 端保持同一份契约 ——
   * 渲染层不该知道两个宿主用的是不同推理引擎。
   */
  ipcMain.handle(IPC.dialogOpenImage, async (): Promise<PickedFile | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择岗位截图',
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const stat = await fs.stat(filePath);
    return { path: filePath, name: path.basename(filePath), size: stat.size };
  });

  ipcMain.handle(IPC.ocrRecognize, async (_e, payload: unknown) =>
    desktopOcr(payload as { path: string; script: 'chinese' | 'latin' }),
  );

  ipcMain.handle(IPC.fsReadBytes, async (_e, filePath: unknown): Promise<Uint8Array> => {
    const buf = await fs.readFile(String(filePath));
    return new Uint8Array(buf);
  });

  ipcMain.handle(IPC.dialogSaveText, async (_e, defaultName: unknown, content: unknown): Promise<string | null> => {
    const result = await dialog.showSaveDialog({
      title: '导出',
      defaultPath: String(defaultName),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, String(content), 'utf8');
    return result.filePath;
  });

  ipcMain.handle(IPC.shellOpenExternal, async (_e, url: unknown) => {
    const target = String(url);
    if (/^https?:/i.test(target)) await shell.openExternal(target);
  });

  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => ({
    name: APP_NAME,
    version: APP_VERSION,
    release: CURRENT_RELEASE,
    platform: process.platform,
    storageLocation: store ? store.describe() : '不可用',
    storageEngine: store ? store.engine() : '不可用',
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
  }));

  // -------------------------------------------------------------------------
  // v0.2 追加：面试录音 / 内录 / 静默模式
  // 主进程在这里只做「宿主能力」，不做任何业务判断 —— 转写与复盘都在 core 里。
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC.captureBegin, async (_e, sessionId: unknown): Promise<CapturePaths> =>
    captureBegin(String(sessionId)),
  );

  ipcMain.handle(IPC.captureWriteSegment, async (_e, sessionId: unknown, fileName: unknown, bytes: unknown) => {
    // 跨 IPC 传过来的是 Uint8Array（结构化克隆），但浏览器侧也可能给出 ArrayBuffer
    const data =
      bytes instanceof Uint8Array
        ? bytes
        : bytes instanceof ArrayBuffer
          ? new Uint8Array(bytes)
          : new Uint8Array(0);
    return captureWriteSegment(String(sessionId), String(fileName), data);
  });

  ipcMain.handle(IPC.captureReadSegment, async (_e, sessionId: unknown, fileName: unknown): Promise<Uint8Array> =>
    captureReadSegment(String(sessionId), String(fileName)),
  );

  ipcMain.handle(IPC.captureFinish, async (_e, sessionId: unknown): Promise<CaptureSummary> =>
    captureFinish(String(sessionId)),
  );

  ipcMain.handle(IPC.captureDiscard, async (_e, sessionId: unknown) => {
    await captureDiscard(String(sessionId));
  });

  ipcMain.handle(IPC.captureOpenFolder, async (_e, sessionId: unknown) => {
    await captureOpenFolder(String(sessionId));
  });

  ipcMain.handle(IPC.captureFreeSpace, async () => captureFreeSpace());

  ipcMain.handle(IPC.mediaRequestMic, async (): Promise<MicPermissionResult> => requestMicrophone());

  ipcMain.handle(IPC.mediaSystemAudio, async (_e, enabled: unknown) => setSystemAudioCapture(Boolean(enabled)));

  ipcMain.handle(IPC.mediaListSources, async () => listScreenSources());

  ipcMain.handle(IPC.quietSet, async (_e, on: unknown, options: unknown) =>
    setQuietMode(Boolean(on), (options ?? {}) as QuietModeOptions),
  );

  ipcMain.handle(IPC.quietIsOn, async () => isQuietMode());

  ipcMain.handle(IPC.hotkeySet, async (_e, _action: unknown, accelerator: unknown) =>
    registerStopHotkey(accelerator ? String(accelerator) : null),
  );

  ipcMain.handle(IPC.dialogSaveHtml, async (_e, defaultName: unknown, html: unknown): Promise<string | null> => {
    const result = await dialog.showSaveDialog({
      title: '导出面试复盘报告',
      defaultPath: String(defaultName),
      filters: [{ name: 'HTML 报告', extensions: ['html'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, String(html), 'utf8');
    return result.filePath;
  });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // 媒体权限必须在任何页面请求麦克风之前装好，否则第一次 getUserMedia 会被静默拒绝
    installPermissionHandlers();
    store = await createStore();
    registerIpc();
    createWindow();
    initQuietMode({ mainWindow: () => mainWindow, quit: () => app.quit() });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 全局快捷键与托盘不随窗口销毁，必须在退出前显式清掉，否则会泄漏到下一次启动
  app.on('will-quit', () => {
    disposeQuietMode();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
