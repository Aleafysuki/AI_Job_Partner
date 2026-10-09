/**
 * 宿主判定。
 *
 * 同一份界面代码要跑在三个宿主里，但「外壳长什么样」是宿主身份问题，不是窗口尺寸问题：
 *
 *   - `desktop`：Electron。有 `window.aijob` 原生桥，用 Windows 11 风格的双栏工作台外壳。
 *   - `android`：Capacitor WebView。用 Metro 风格的移动外壳（大色块头部 + Pivot 分页导航）。
 *   - `web`：纯浏览器。开发预览与单文件演示用，沿用桌面端外壳。
 *
 * **为什么不按视口宽度判定**：桌面窗口可以被拖窄，Android 平板可以横屏。
 * 用 `innerWidth < 768` 决定外壳，会让桌面端在拖窄窗口时突然换成移动外壳，
 * 也会让平板横屏时退回双栏 —— 这两件事都与用户预期相反。
 *
 * 为了在桌面上预览 / 冒烟测试移动端外观，支持两级显式覆盖（仅影响外壳，不影响任何业务判断）：
 *
 *   ?host=android                URL 参数，优先级最高（冒烟测试用）
 *   localStorage['aijob.host']   持久预览开关
 */

export type HostKind = 'desktop' | 'android' | 'web';

const HOSTS: HostKind[] = ['desktop', 'android', 'web'];

function readOverride(): HostKind | null {
  if (typeof window === 'undefined') return null;
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('host');
    if (fromQuery && (HOSTS as string[]).includes(fromQuery)) return fromQuery as HostKind;
    const fromStorage = window.localStorage.getItem('aijob.host');
    if (fromStorage && (HOSTS as string[]).includes(fromStorage)) return fromStorage as HostKind;
  } catch {
    /* 隐私模式 / 单文件演示下 localStorage 可能不可访问，忽略即可 */
  }
  return null;
}

function detect(): HostKind {
  if (typeof window === 'undefined') return 'web';

  const w = window as Window & {
    aijob?: unknown;
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  };

  if (w.Capacitor?.isNativePlatform?.()) {
    // 本项目当前只提供 Android 宿主。
    // 这里不把 iOS 认成 `android` —— iOS 宿主并不存在，
    // 认错了会让「不支持的能力」被错误地宣称可用。
    return w.Capacitor.getPlatform?.() === 'android' ? 'android' : 'web';
  }

  if (w.aijob) return 'desktop';
  return 'web';
}

const override = readOverride();

export const hostKind: HostKind = override ?? detect();
export const isDesktopHost: boolean = hostKind === 'desktop';
export const isAndroidHost: boolean = hostKind === 'android';
/** 外壳是否需要走移动端形态（Android 宿主，或被显式覆盖成 android 的预览） */
export const useMobileShell: boolean = hostKind === 'android';
export const hostOverridden: boolean = override !== null;

export const HOST_LABEL: Record<HostKind, string> = {
  desktop: '桌面端（Electron）',
  android: 'Android 客户端（Capacitor）',
  web: 'Web / 演示模式（浏览器）',
};

/**
 * 把宿主身份写到 <html> 上，供 CSS 令牌层选择器使用。
 *
 * 必须是 `<html>` 而不是 `<body>`：令牌层里定义了 `--metro-*` 这类供
 * `.metro-*` 使用的变量，放在 html 上可以让整棵树（含 body 背景）都吃到。
 * 在 main.tsx 渲染之前调用，避免首帧按错误宿主上色（会闪一下）。
 */
export function applyHostAttributes(): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  el.setAttribute('data-aijob-host', hostKind);
  if (hostOverridden) el.setAttribute('data-aijob-host-override', 'true');
}
