import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  IPC_EVENTS,
  type CapturePaths,
  type CaptureSummary,
  type DesktopBridge,
  type MicPermissionResult,
  type PickedFile,
  type OcrPayload,
  type AppInfo,
  type QuietModeOptions,
} from '../shared/ipc';
import type { HttpRequest, HttpResponse, WorkspaceSnapshot } from '@aijob/core';

/**
 * 预加载脚本 —— 唯一的渲染进程 ↔ 主进程通道。
 * 只暴露白名单方法，不把 ipcRenderer 本身交给页面。
 */

const bridge: DesktopBridge = {
  isDesktop: true,
  appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  storage: {
    load: () => ipcRenderer.invoke(IPC.storageLoad) as Promise<WorkspaceSnapshot | null>,
    save: (snapshot: WorkspaceSnapshot) => ipcRenderer.invoke(IPC.storageSave, snapshot) as Promise<void>,
    clear: () => ipcRenderer.invoke(IPC.storageClear) as Promise<void>,
  },
  http: (request: HttpRequest) => ipcRenderer.invoke(IPC.httpRequest, request) as Promise<HttpResponse>,
  pickFile: () => ipcRenderer.invoke(IPC.dialogOpenFile) as Promise<PickedFile | null>,
  readBytes: (path: string) => ipcRenderer.invoke(IPC.fsReadBytes, path) as Promise<Uint8Array>,
  /** 选一张图片用于本地 OCR（v0.3 job.input_image） */
  pickImage: () => ipcRenderer.invoke(IPC.dialogOpenImage) as Promise<PickedFile | null>,
  /** 本地推理识别。绝不联网 —— 见 main/ocr.ts 的文件头 */
  ocrRecognize: (req: { path: string; script: 'chinese' | 'latin' }) =>
    ipcRenderer.invoke(IPC.ocrRecognize, req) as Promise<OcrPayload>,
  saveText: (defaultName: string, content: string) =>
    ipcRenderer.invoke(IPC.dialogSaveText, defaultName, content) as Promise<string | null>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.shellOpenExternal, url) as Promise<void>,

  // ---- v0.2 面试录音 ----
  capture: {
    begin: (sessionId: string) => ipcRenderer.invoke(IPC.captureBegin, sessionId) as Promise<CapturePaths>,
    writeSegment: (sessionId: string, fileName: string, bytes: Uint8Array) =>
      ipcRenderer.invoke(IPC.captureWriteSegment, sessionId, fileName, bytes) as Promise<{ bytes: number }>,
    readSegment: (sessionId: string, fileName: string) =>
      ipcRenderer.invoke(IPC.captureReadSegment, sessionId, fileName) as Promise<Uint8Array>,
    finish: (sessionId: string) => ipcRenderer.invoke(IPC.captureFinish, sessionId) as Promise<CaptureSummary>,
    discard: (sessionId: string) => ipcRenderer.invoke(IPC.captureDiscard, sessionId) as Promise<void>,
    openFolder: (sessionId: string) => ipcRenderer.invoke(IPC.captureOpenFolder, sessionId) as Promise<void>,
    freeSpace: () =>
      ipcRenderer.invoke(IPC.captureFreeSpace) as Promise<{ freeBytes: number; directory: string; isLow: boolean }>,
  },

  media: {
    requestMic: () => ipcRenderer.invoke(IPC.mediaRequestMic) as Promise<MicPermissionResult>,
    setSystemAudio: (enabled: boolean) => ipcRenderer.invoke(IPC.mediaSystemAudio, enabled) as Promise<boolean>,
    listSources: () => ipcRenderer.invoke(IPC.mediaListSources) as Promise<Array<{ id: string; name: string }>>,
  },

  quiet: {
    set: (on: boolean, options?: QuietModeOptions) =>
      ipcRenderer.invoke(IPC.quietSet, on, options) as Promise<boolean>,
    isOn: () => ipcRenderer.invoke(IPC.quietIsOn) as Promise<boolean>,
    /**
     * 静默模式下窗口是隐藏的，用户只能通过托盘菜单要求结束录制；
     * 主进程拿到这个意图后反过来通知页面，由页面负责停掉 MediaRecorder 并落盘。
     */
    onStopRequested: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on(IPC_EVENTS.quietStopRequested, listener);
      return () => ipcRenderer.removeListener(IPC_EVENTS.quietStopRequested, listener);
    },
  },

  hotkey: (action: 'stop', accelerator: string | null) =>
    ipcRenderer.invoke(IPC.hotkeySet, action, accelerator) as Promise<boolean>,

  saveHtml: (defaultName: string, html: string) =>
    ipcRenderer.invoke(IPC.dialogSaveHtml, defaultName, html) as Promise<string | null>,
};

contextBridge.exposeInMainWorld('aijob', bridge);
