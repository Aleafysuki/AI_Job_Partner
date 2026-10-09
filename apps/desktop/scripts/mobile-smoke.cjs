/**
 * Android 外壳（Metro 移动端）端到端冒烟测试。
 *
 * 与 ui-smoke.cjs 的关系：
 *   ui-smoke 验的是「桌面外壳 + 完整业务链路」；
 *   本脚本验的是「移动外壳 + 原生桥契约 + 完整业务链路」，复用同一套
 *   Electron 真实 Chromium 基础设施。差别只有一处：本脚本加载 `dist-android/`。
 *
 * ===========================================================================
 * 它到底在验证什么（以及不验证什么）
 * ===========================================================================
 *
 * 验证：
 *   1. 宿主判定 —— 走 lib/platform.ts 的 detect() 分支（靠注入 window.Capacitor），
 *      而不是 `?host=android` 这种显式覆盖。只测覆盖等于绕过判定逻辑本身；
 *   2. Metro 外壳与令牌层 —— 大色块、零圆角、零阴影、无横向溢出；
 *   3. **原生桥的 JS 侧**（native-bridge/aijob-native-bridge.js）——
 *      通过在 preload 里注入一个「假原生」AijobNative，让这份桥脚本真的跑起来，
 *      再逐条核对它是否把 window.aijob 装配成了 DesktopBridge 契约的形状。
 *      其中最关键的一条是 bodyBytes：Uint8Array 一旦直接进 JSON.stringify
 *      就会变成 {"0":1,…}，音频转写会安静地失败。这里有专门的断言钉住它；
 *   4. 完整业务链路在移动外壳里同样跑通（简历 → 岗位 → 匹配报告）。
 *
 * 不验证（不要把它当成的确通过了）：
 *   - Kotlin 那一半（SQLite / OkHttp / SAF / 前台服务）—— 需要真机；
 *     这里的「假原生」只按契约回话，不证明原生实现正确；
 *   - 真实录音 —— 冒烟环境没有音频输入设备；
 *   - Gradle 构建与 APK 安装 —— 本机没有 Android SDK。
 *
 * 运行（注意：这台机器的 shell 里带了 ELECTRON_RUN_AS_NODE=1，必须去掉，
 * 否则 electron 会退化成普通 Node 进程）：
 *   env -u ELECTRON_RUN_AS_NODE npm run smoke:mobile
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'dist-android', 'index.html');
const SHOTS = path.resolve(ROOT, '..', '..', 'screenshots', 'mobile');

/** 素材机型逻辑分辨率（Pixel 尺寸档），用来验移动端排版 */
const VIEWPORT = { width: 393, height: 851 };

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.setPath('userData', path.join(os.tmpdir(), `aijob-mobile-smoke-${process.pid}`));

const consoleErrors = [];
const results = {};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(win, expression, timeoutMs, label) {
  const started = Date.now();
  // 进度日志：只在开头打一次。
  // 为什么要加：这个脚本只在 finally 里输出结果，被超时 kill 时一个字都没有，
  // 定位卡点只能靠猜。打了这行之后，卡在哪一步会直接写在日志里。
  process.stderr.write(`  · 等待：${label}（最多 ${timeoutMs}ms）\n`);
  while (Date.now() - started < timeoutMs) {
    // catch：渲染进程无 GPU 时 executeJavaScript 可能以 UnknownVizError 失败。
    // 那一轮当作「还没满足」继续等，而不是让整条冒烟挂在这里。
    const ok = await win.webContents
      .executeJavaScript(
        `(() => { try { return Boolean(${expression}); } catch (e) { return false; } })()`,
      )
      .catch(() => false);
    if (ok) {
      process.stderr.write(`  ✓ ${label}\n`);
      return true;
    }
    await delay(300);
  }
  throw new Error(`等待超时：${label}`);
}

/**
 * 等两帧，让界面稳定下来再截图 / 读 DOM。
 *
 * v0.4 加超时兜底：**本机没有 GPU 加速，requestAnimationFrame 偶尔不触发**，
 * 于是 `settle()` 会一直挂着 —— 表现是「冒烟跑到一半停住，且没有任何报错」，
 * 很容易被误判成某个功能坏了。
 *
 * 超时后直接继续：截图晚一点无所谓，卡在这里才是灾难。
 * 15 秒还没拿到两帧，说明渲染本身已经出问题了，继续跑只会掩盖它。
 */
async function settle(win) {
  try {
    await Promise.race([
      win.webContents
        .executeJavaScript(
          'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 260))))',
        )
        // 必须 catch：无 GPU 时这次调用可能以 "UnknownVizError" 失败，
        // 而它冒出去会让整条冒烟报一个与真实原因无关的错
        .catch(() => 'errored'),
      delay(15_000).then(() => 'timeout'),
    ]);
  } catch {
    await delay(400);
  }
}

/**
 * 截图。
 *
 * v0.4 加超时保护：本机没有 GPU 加速，`capturePage()` 偶尔会长时间不返回，
 * 于是整条冒烟被一张截图拖死（表现为「跑到一半就超时，且没有任何报错」）。
 * 截图只是留档证据，不值得用它换掉后面所有断言 ——
 * 所以超时就跳过并记一笔，断言仍然继续跑完。
 */
async function shoot(win, name) {
  await settle(win);
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);

  // 超时后必须**吞掉**那个还在跑的 capturePage：
  // 它稍后返回时携带的错误会被 Electron 当成未捕获异常抛出，
  // 表现为一串看不懂的 "UnknownVizError"，把真正的失败原因盖掉。
  const pending = win.webContents.capturePage().catch(() => null);
  let timedOut = false;
  const guard = delay(20_000).then(() => {
    timedOut = true;
    return null;
  });

  const image = await Promise.race([pending, guard]);
  if (timedOut || !image) {
    void pending;
    shotsSkipped.push(name);
    process.stderr.write(`  ⚠ 截图超时已跳过：${name}（本机无 GPU 时的已知问题）\n`);
    return null;
  }
  fs.writeFileSync(file, image.toPNG());
  const size = fs.statSync(file).size;
  if (size < 15_000) throw new Error(`截图疑似空白：${file}（${size} bytes）`);
  return file;
}

/** 因超时被跳过的截图名。空数组 = 全部成功 */
const shotsSkipped = [];

/** 点第一个文本命中 button/a（DOM 顺序优先，因此 Pivot 页签优先于正文里的同名按钮） */
async function clickByText(win, text) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const nodes = Array.from(document.querySelectorAll('button, a'));
    const hit = nodes.find((n) => (n.textContent || '').replace(/\\s+/g, '').includes(${JSON.stringify(text)}));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`找不到按钮：${text}`);
  await delay(400);
}

/**
 * 按文字点击 Pivot 页签。
 *
 * v0.4 改法：原来先 `tabIndex()` 算出全局下标、再用 `clickSelector(sel, idx)` 点。
 * 导航分组之后页签变成嵌套结构（.metro-pivot__section > .metro-pagetabs > button），
 * 多一层下标换算就多一个能出错的环节 —— 而且分组后下标含义变了，
 * 「第 7 个页签」已经不是原来那个页面了。
 *
 * 直接按文字找并点击：意图明确，且与页签在 DOM 里的位置无关。
 */
/**
 * 点某个页签。
 *
 * v0.4 第二轮起，页签行**只显示当前阶段**的页面 ——
 * 所以跨阶段找页签时必须先切阶段，否则「点面试问答」会失败
 * （它在「提升」组，而当前停在「准备」组）。
 *
 * 阶段切到之后仍然要等它跳转，否则第二次点击会落在还没切换完的页签行上。
 */
async function clickPivot(win, label) {
  const direct = await win.webContents.executeJavaScript(`(() => {
    const hit = Array.from(document.querySelectorAll('.metro-pagetab'))
      .find((n) => (n.textContent || '').includes(${JSON.stringify(label)}));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  if (!direct) {
    // 页签不在当前阶段 —— 先把阶段切过去
    const stageLabel = STAGE_BY_ITEM[label];
    const switched = await win.webContents.executeJavaScript(`(() => {
      const btn = Array.from(document.querySelectorAll('.metro-tab'))
        .find((b) => (b.textContent || '').trim() === ${JSON.stringify(stageLabel)});
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!switched) {
      throw new Error(`Pivot 里找不到页签「${label}」，且切不到阶段「${stageLabel ?? '未映射'}」`);
    }
    await delay(420);
    const second = await win.webContents.executeJavaScript(`(() => {
      const hit = Array.from(document.querySelectorAll('.metro-pagetab'))
        .find((n) => (n.textContent || '').includes(${JSON.stringify(label)}));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    if (!second) throw new Error(`切到阶段后仍找不到页签：${label}`);
  }
  await delay(320);
}

/**
 * 页面 label → 阶段 label 的映射。
 *
 * 刻意不 import lib/navGroups.ts：这个脚本是 .cjs，跑在 Electron 主进程里，
 * import 渲染层的 TS 模块要额外配 loader，不值得为它多一个依赖。
 * 代价是这份表与 navGroups.ts 要手工保持一致 —— 下面有断言兜着。
 */
const STAGE_BY_ITEM = {
  工作台: '总览',
  我的能力档案: '准备',
  岗位分析: '准备',
  简历匹配: '评估',
  能力问诊: '评估',
  薄弱项训练: '提升',
  面试问答: '提升',
  面试复盘: '提升',
  设置: '系统',
};

async function clickSelector(win, selector, index = 0) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const nodes = document.querySelectorAll(${JSON.stringify(selector)});
    const hit = nodes[${index}];
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`找不到元素：${selector} #${index}`);
  await delay(320);
}

/**
 * 生成 preload：模拟 Capacitor 运行时，并按需注入「假原生」AijobNative。
 *
 * 关于 withNative 的两个取值：
 *   true  —— 模拟真实 Android 宿主：window.aijob 会被原生桥脚本装配出来，
 *            应用走原生存储路径（这里是内存里的桩），并顺带验证桥的序列化行为；
 *   false —— 模拟「装了壳但桥没挂上」的异常情况，用来确认应用会如实退化到
 *            localStorage，而不是崩溃或假装成功。
 */
function writePreload(withNative) {
  const file = path.join(os.tmpdir(), `aijob-mobile-preload-${withNative ? 'native' : 'plain'}-${process.pid}.cjs`);
  const nativeStub = `
// ---------------------------------------------------------------------------
// 假原生：只按 DesktopBridge 契约回话，不实现任何真实能力。
// 它的作用是让 aijob-native-bridge.js 真的跑起来，从而验证桥的 JS 一侧。
// ---------------------------------------------------------------------------
var aijobDb = {};
var aijobQuiet = false;

function aijobReply(callId, ok, data) {
  setTimeout(function () {
    if (typeof window.__aijobResolve === 'function') {
      window.__aijobResolve(callId, ok, data === undefined ? null : JSON.stringify(data));
    }
  }, 0);
}

window.AijobNative = {
  invoke: function (callId, channel, payloadJson) {
    var p = {};
    try { p = JSON.parse(payloadJson || '{}'); } catch (e) { /* 保持空对象 */ }

    switch (channel) {
      case 'appInfo':
        aijobReply(callId, true, {
          name: 'AI Job Partner',
          version: '0.2.0',
          release: 'v0.2',
          platform: 'Android 14（API 34）',
          storageLocation: '/data/user/0/com.aijob.partner/files/aijob.db',
          storageEngine: 'Android SQLite（WAL，应用私有目录）',
          versions: { electron: '\\u2014', node: '\\u2014', chrome: '999.0.0.smoke' },
        });
        break;

      case 'storage.load':
        aijobReply(callId, true, Object.prototype.hasOwnProperty.call(aijobDb, 'workspace') ? aijobDb.workspace : null);
        break;
      case 'storage.save':
        aijobDb.workspace = p.snapshot;
        aijobReply(callId, true, null);
        break;
      case 'storage.clear':
        delete aijobDb.workspace;
        aijobReply(callId, true, null);
        break;

      case 'http.request':
        // 关键探针：记录原生侧究竟收到了什么。
        // 如果桥没把 Uint8Array 转成 base64，这里会看到一个下标对象。
        window.__httpProbe = {
          url: p.request && p.request.url,
          method: p.request && p.request.method,
          bodyBase64Type: typeof (p.request && p.request.bodyBase64),
          bodyBase64Length: ((p.request && p.request.bodyBase64) || '').length,
          // 把 base64 解回来，确认字节原样到达（不是长度对、内容错）
          decoded: (function () {
            try {
              var raw = atob((p.request && p.request.bodyBase64) || '');
              var out = [];
              for (var i = 0; i < raw.length; i += 1) out.push(raw.charCodeAt(i));
              return out;
            } catch (e) {
              return null;
            }
          })(),
          bodyField: p.request && p.request.body,
        };
        aijobReply(callId, true, { ok: false, status: 0, text: '', networkError: '冒烟桩：不真的出网' });
        break;

      case 'file.readBytes':
        // 固定返回 'AQIDBAU='（即 [1,2,3,4,5]），用来验证 base64 -> Uint8Array 的解码
        aijobReply(callId, true, { base64: 'AQIDBAU=' });
        break;

      case 'capture.begin':
        aijobReply(callId, true, { sessionId: p.sessionId, directory: '/data/user/0/com.aijob.partner/files/recordings/' + p.sessionId });
        break;
      case 'capture.writeSegment':
        aijobReply(callId, true, { bytes: p.base64 ? p.base64.length : 0 });
        break;
      case 'capture.finish':
        aijobReply(callId, true, { sessionId: p.sessionId, directory: '/data/user/0/com.aijob.partner/files/recordings/' + p.sessionId, fileCount: 0, totalBytes: 0, files: [] });
        break;
      case 'capture.freeSpace':
        aijobReply(callId, true, { freeBytes: 8589934592, directory: '/data/user/0/com.aijob.partner/files/recordings', isLow: false });
        break;
      case 'capture.discard':
      case 'capture.openFolder':
        aijobReply(callId, true, null);
        break;

      case 'media.requestMic':
        aijobReply(callId, true, { status: 'granted', reason: '冒烟桩：已授权', devices: [{ deviceId: 'input-0', label: '内置麦克风' }] });
        break;
      case 'media.setSystemAudio':
        // 与 Kotlin 侧的真实行为一致：Android 上不支持系统内录
        aijobReply(callId, true, false);
        break;
      case 'media.listSources':
        aijobReply(callId, true, []);
        break;

      case 'quiet.set':
        aijobQuiet = Boolean(p.on);
        aijobReply(callId, true, aijobQuiet);
        break;
      case 'quiet.isOn':
        aijobReply(callId, true, aijobQuiet);
        break;

      case 'hotkey.set':
        aijobReply(callId, true, false);
        break;

      default:
        aijobReply(callId, false, { message: '冒烟桩未实现的通道：' + channel });
    }
  },
};
`;

  fs.writeFileSync(
    file,
    `// 模拟 Capacitor 运行时的两个最小标识。
// lib/platform.ts 只读这两个方法，所以只注入它们：
//   isNativePlatform() —— 是否跑在原生容器里
//   getPlatform()      —— 哪个平台
// 刻意不注入 Capacitor.Plugins：本项目不用 Capacitor 的插件系统，
// 业务桥走的是 window.aijob（见 apps/android/native-bridge/）。
window.Capacitor = {
  isNativePlatform: () => true,
  getPlatform: () => 'android',
};

${withNative ? nativeStub : '// 本次运行刻意不注入 AijobNative：验证「外壳在、桥没挂上」时的退化行为。'}
`,
    'utf8',
  );
  return file;
}

const SET_TEXT_HELPER = `
  const __setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
`;

async function createWindow(preloadPath, title, backgroundColor) {
  const win = new BrowserWindow({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    useContentSize: true,
    show: true,
    title,
    backgroundColor,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, preload: preloadPath },
  });

  win.webContents.on('console-message', (event) => {
    const level = event && typeof event === 'object' ? event.level : undefined;
    const message = event && typeof event === 'object' ? event.message : String(event);
    if (level === 'error' || level === 3 || /error/i.test(String(level))) {
      // 把出错脚本的来源一起记下来：只记 message 的话，
      // 「Uncaught SyntaxError」这类错无法定位到是哪个文件加载失败。
      const src = event && typeof event === 'object' && event.sourceId ? ` @ ${event.sourceId.split('/').pop()}:${event.lineNumber}` : '';
      consoleErrors.push(`${String(message)}${src}`);
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    consoleErrors.push(`渲染进程崩溃：${JSON.stringify(details)}`);
  });

  return win;
}

/** Pivot 页签在 DOM 里的下标（按可见文本定位，避免硬编码顺序） */
// 原实现保留留痕（勿删）：先算全局下标、再用 clickSelector(sel, idx) 点。
// v0.4 起导航按阶段分组，页签变成嵌套结构，多一层下标换算就多一个出错点，
// 所以调用方已改为 clickPivot(win, label) 直接按文字点击。
// async function tabIndex(win, label) {
//   const idx = await win.webContents.executeJavaScript(`(() => {
//     const items = Array.from(document.querySelectorAll('.metro-pagetab'));
//     return items.findIndex((n) => (n.textContent || '').includes(${JSON.stringify(label)}));
//   })()`);
//   if (idx < 0) throw new Error(`Pivot 里找不到页签：${label}`);
//   return idx;
// }

/**
 * 第二趟：外壳在、原生桥没挂上。
 * 用来确认应用如实退化为 localStorage，而不是白屏、崩溃或假装写成功。
 */
async function checkNoBridgeFallback() {
  const win = await createWindow(writePreload(false), 'AI Job Partner · 无原生桥退化检查', '#0050ef');
  try {
    await win.loadFile(RENDERER);
    await waitFor(win, `document.querySelector('.metro-app') !== null`, 20000, 'Metro 外壳挂载（无桥）');

    const info = await win.webContents.executeJavaScript(`(() => ({
      bridgeAbsent: typeof window.aijob === 'undefined',
      bridgeReadyFlag: window.__aijobBridgeReady === true,
      shellPresent: Boolean(document.querySelector('.metro-app')),
      host: document.documentElement.getAttribute('data-aijob-host'),
      storagePortLabel: null,
    }))()`);

    // 走一次「载入示例数据」，确认没有原生桥时业务仍可用（数据落 localStorage）
    await clickByText(win, '载入示例数据');
    await waitFor(win, `document.body.innerText.includes('匹配分析报告')`, 60000, '无原生桥下的匹配报告');
    info.reportRendered = true;
    info.usedLocalStorage = await win.webContents.executeJavaScript(
      `window.localStorage.getItem('aijob.workspace.v1') !== null`,
    );
    results.noBridgeFallback = info;
  } finally {
    win.destroy();
  }
}

async function main() {
  if (!fs.existsSync(RENDERER)) {
    throw new Error(`找不到 Android 构建产物 ${RENDERER}，请先执行 npm run web:android`);
  }

  // ---------------------------------------------------------------------------
  // 第一趟：完整 Android 宿主（外壳 + 原生桥）
  // ---------------------------------------------------------------------------
  const win = await createWindow(writePreload(true), 'AI Job Partner · Android 外壳冒烟测试', '#0050ef');
  await win.loadFile(RENDERER);
  await waitFor(win, `document.querySelector('#root') && document.querySelector('#root').childElementCount > 0`, 20000, 'React 应用挂载');
  await win.webContents.executeJavaScript('window.localStorage.clear()');
  await win.webContents.executeJavaScript('location.reload()');
  await delay(900);

  // 1) 宿主判定与外壳切换
  await waitFor(win, `document.querySelector('.metro-app') !== null`, 15000, 'Metro 外壳挂载');

  results.host = await win.webContents.executeJavaScript(`(() => ({
    dataAttr: document.documentElement.getAttribute('data-aijob-host'),
    capacitorSeen: Boolean(window.Capacitor && window.Capacitor.isNativePlatform()),
    nativeBridgePresent: typeof window.aijob === 'object' && window.aijob !== null,
    bridgeReadyFlag: window.__aijobBridgeReady === true,
    metroShellPresent: Boolean(document.querySelector('.metro-app')),
    desktopSidebarAbsent: document.querySelector('aside') === null,
    pivotItemCount: document.querySelectorAll('.metro-pagetab').length,
    activeTab: (document.querySelector('.metro-pagetab.is-active') || {}).textContent || null,
    pageTitle: (document.querySelector('.metro-pagetab.is-active') || {}).textContent || null,
    tileCount: document.querySelectorAll('.metro-tile').length,
    viewport: window.innerWidth + 'x' + window.innerHeight,
  }))()`);

  results.shotHome = await shoot(win, '01-工作台-移动端');
  process.stderr.write('  ✓ 步骤：首页截图\n');

  // ---------------------------------------------------------------------------
  // 2) 原生桥契约（对 native-bridge/aijob-native-bridge.js 的逐条核对）
  // ---------------------------------------------------------------------------
  process.stderr.write('  · 步骤：开始检查原生桥契约\n');
  results.bridgeContract = await win.webContents.executeJavaScript(`(async () => {
    const bridge = window.aijob;
    const shape = {
      isDesktop: bridge.isDesktop,
      // 与 src/shared/ipc.ts 的 DesktopBridge 逐字段对齐
      hasAppInfo: typeof bridge.appInfo === 'function',
      hasStorage: bridge.storage && typeof bridge.storage.load === 'function'
        && typeof bridge.storage.save === 'function' && typeof bridge.storage.clear === 'function',
      hasHttp: typeof bridge.http === 'function',
      hasPickFile: typeof bridge.pickFile === 'function',
      hasReadBytes: typeof bridge.readBytes === 'function',
      hasSaveText: typeof bridge.saveText === 'function',
      hasOpenExternal: typeof bridge.openExternal === 'function',
      hasSaveHtml: typeof bridge.saveHtml === 'function',
      hasHotkey: typeof bridge.hotkey === 'function',
      captureMethods: bridge.capture
        ? ['begin', 'writeSegment', 'readSegment', 'finish', 'discard', 'openFolder', 'freeSpace']
            .filter((m) => typeof bridge.capture[m] !== 'function')
        : 'missing',
      mediaMethods: bridge.media
        ? ['requestMic', 'setSystemAudio', 'listSources'].filter((m) => typeof bridge.media[m] !== 'function')
        : 'missing',
      quietMethods: bridge.quiet
        ? ['set', 'isOn', 'onStopRequested'].filter((m) => typeof bridge.quiet[m] !== 'function')
        : 'missing',
    };

    const appInfo = await bridge.appInfo();

    // ---- 关键断言：bodyBytes 的序列化 ----
    // Uint8Array 直接进 JSON.stringify 会变成 {"0":1,…}，
    // 那样原生侧收到的「音频」是一坨无意义的下标映射，转写会安静地失败。
    await bridge.http({
      url: 'https://example.invalid/v1/audio/transcriptions',
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      bodyBytes: new Uint8Array([1, 2, 3, 4, 5]),
      timeoutMs: 1000,
    });
    const probe = window.__httpProbe || {};

    // ---- base64 -> Uint8Array ----
    const bytes = await bridge.readBytes('content://smoke/1');

    // ---- quiet.onStopRequested 的事件链路 ----
    let stopFired = 0;
    const off = bridge.quiet.onStopRequested(() => { stopFired += 1; });
    window.__aijobEvent('quiet.stopRequested', '{}');
    await new Promise((r) => setTimeout(r, 30));
    const firedOnce = stopFired === 1;
    off();
    window.__aijobEvent('quiet.stopRequested', '{}');
    await new Promise((r) => setTimeout(r, 30));
    const unsubscribed = stopFired === 1;

    // ---- 二进制往返 ----
    const roundTrip = await bridge.capture.begin('smoke-session');

    return {
      shape,
      appInfo: {
        platform: appInfo.platform,
        storageEngine: appInfo.storageEngine,
        chromium: appInfo.versions.chrome,
      },
      bodyBytesIsBase64: probe.bodyBase64Type === 'string',
      bodyBytesLength: probe.bodyBase64Length,
      bodyBytesDecoded: probe.decoded,
      bodyBytesNotIndexObject: probe.bodyField === null,
      readBytesDecoded: Array.from(bytes),
      stopFiredOnce: firedOnce,
      stopUnsubscribedCleanly: unsubscribed,
      captureBeginDirectory: roundTrip && roundTrip.directory,
    };
  })()`);

  // ---------------------------------------------------------------------------
  // 3) Metro 令牌是否真的生效
  // ---------------------------------------------------------------------------
  results.tokens = await win.webContents.executeJavaScript(`(() => {
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const btn = document.querySelector('.metro-tile') || document.querySelector('button');
    const card = document.querySelector("[class*='shadow-']");
    return {
      accent: root.getPropertyValue('--color-indigo-600').trim(),
      radiusLg: root.getPropertyValue('--radius-lg').trim(),
      radiusXl: root.getPropertyValue('--radius-xl').trim(),
      fontFamily: body.fontFamily,
      tileBorderRadius: btn ? getComputedStyle(btn).borderRadius : null,
      tileBackground: btn ? getComputedStyle(btn).backgroundColor : null,
      // 阴影必须被清零：要么 none，要么复合声明里全部透明
      shadowProbe: card ? getComputedStyle(card).boxShadow : null,
      // 整页不应出现横向溢出（移动端最容易在这里翻车）
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);

  // ---------------------------------------------------------------------------
  // 4) 完整业务链路必须在移动外壳里同样跑通
  // ---------------------------------------------------------------------------
  await waitFor(win, `document.body.innerText.includes('先告诉我一些关于你的事情')`, 15000, '首次使用引导');
  await clickByText(win, '载入示例数据');
  await waitFor(win, `document.body.innerText.includes('匹配分析报告')`, 60000, '匹配报告生成');
  await delay(600);

  results.report = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    const pick = (label) => {
      const m = text.match(new RegExp(label + '\\\\s*\\\\n?\\\\s*(\\\\d+)'));
      return m ? Number(m[1]) : null;
    };
    return {
      total: pick('要求总数'),
      matched: pick('满足'),
      partial: pick('部分满足'),
      lacking: pick('缺少证据'),
      gap: pick('明显缺口'),
      unknown: pick('无法判断'),
      hasPriority: text.includes('接下来应该改什么'),
      hasWhyNot: text.includes('我为什么是现在这个判断'),
      // 铁律：结论只能是五个离散值。报告页必须明说不给 0–100 分，
      // 且页面上不能出现「匹配得分：87」这类伪精确表述。
      hasFiveVerdicts: ['满足', '部分满足', '缺少证据', '明显缺口', '无法判断'].every((v) => text.includes(v)),
      statesNoNumericScore: text.includes('0–100 的匹配分'),
      noPseudoPrecision: !/(匹配|综合)(得分|分数|评分)\\s*[:：]?\\s*\\d/.test(text),
      // 数据是否真的走了原生存储通道（而不是悄悄退化成 localStorage）
      wroteToNativeStore: window.__aijobBridgeReady === true,
    };
  })()`);
  results.shotReport = await shoot(win, '02-匹配报告-移动端');

  // ---------------------------------------------------------------------------
  // 5) Pivot 逐页走一遍
  // ---------------------------------------------------------------------------
  const WALK = [
    // v0.4：工作台单独排第一 —— 它在「总览」组里，
    // 必须在遍历功能页之前先确认总入口可达，否则用户进去就回不来了。
    ['工作台', '工作台', '01b-工作台-移动端'],
    ['我的能力档案', '技能清单', '03-我的能力档案'],
    ['岗位分析', '岗位要求', '04-岗位拆解'],
    ['能力问诊', '建议先问这些', '05-能力问诊'],
    ['薄弱项训练', '生成训练计划', '06-薄弱项训练'],
    // v0.4 新增页面：必须一起走，手机上少一个入口就等于功能不存在
    ['面试问答', '面试问答推荐', '09-面试问答'],
    ['面试复盘', '面试复盘', '07-面试复盘'],
    ['设置', '分析引擎', '08-设置'],
  ];

  /**
   * v0.4 第二轮：验证导航已压缩成「阶段条 + 当前阶段页签」。
   *
   * 用户反馈「选项卡占了大半屏」—— 上一版把 5 个阶段全部展开，
   * 每组一行标题 + 一行页签，851px 屏上导航吃掉约 44%。
   * 现在是三行（阶段条 / 阶段说明 / 页签条），高度约为原来的 1/4。
   *
   * 所以这里既要断言「阶段还在」（分级的目的没丢），
   * 也要断言「高度受控」（这是本轮的核心诉求，必须能回归）。
   */
  results.navGroups = await win.webContents.executeJavaScript(`(() => {
    const tabs = Array.from(document.querySelectorAll('.metro-tab'));
    const subtabs = Array.from(document.querySelectorAll('.metro-pagetab'));
    const pivot = document.querySelector('.metro-tabs');
    const pagetabs = document.querySelector('.metro-pagetabs');
    const header = document.querySelector('.metro-header');
    const navHeight = (() => {
      // 一级 Tab + 页面标题（兼 Sub-Tab）两行的合计高度
      const a = pivot ? pivot.getBoundingClientRect().height : 0;
      const b = pagetabs ? pagetabs.getBoundingClientRect().height : 0;
      return a + b;
    })();
    // 层级数：品牌行 / 一级 Tab / 页面标题，三层。多一层就说明又退回去了。
    const headerChildren = header
      ? Array.from(header.children).filter((c) => c.getBoundingClientRect().height > 0)
      : [];
    return {
      tabCount: tabs.length,
      labels: tabs.map((s) => (s.textContent || '').trim()),
      hasOverview: tabs.some((s) => (s.textContent || '').trim() === '总览'),
      hasPrepare: tabs.some((s) => (s.textContent || '').trim() === '准备'),
      hasAssess: tabs.some((s) => (s.textContent || '').trim() === '评估'),
      hasImprove: tabs.some((s) => (s.textContent || '').trim() === '提升'),
      hasSystem: tabs.some((s) => (s.textContent || '').trim() === '系统'),
      activeTab: (document.querySelector('.metro-tab.is-active') || {}).textContent || null,
      subtabs: subtabs.map((s) => (s.textContent || '').trim()),
      // 头部整体高度（含 brand + 标题 + 两行导航）
      headerLayers: headerChildren.length,
      headerKinds: headerChildren.map((c) =>
        c.classList.contains('metro-brand') ? 'brand'
        : c.classList.contains('metro-tabs') ? 'tabs'
        : c.classList.contains('metro-pagetabs') ? 'pagetabs'
        : c.tagName.toLowerCase()),
      headerHeight: header ? Math.round(header.getBoundingClientRect().height) : 0,
      pageTitleFontSize: (() => {
        const el = document.querySelector('.metro-pagetab.is-active');
        return el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : 0;
      })(),
      // 未选中页面名的字号：必须明显小于选中项，否则这一行会变成一堵字墙，
      // 反而指示不了「我在哪一页」——用户反馈过的层级混乱会在这里重现。
      inactiveTitleFontSize: (() => {
        const el = document.querySelector('.metro-pagetab:not(.is-active)');
        return el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : null;
      })(),
      activeTitleWeight: (() => {
        const el = document.querySelector('.metro-pagetab.is-active');
        return el ? Math.round(parseFloat(getComputedStyle(el).fontWeight)) : 0;
      })(),
      // 整栏换色：读伪元素的底色（真正着色的是 ::before）
      subtabBandColor: (() => {
        const el = document.querySelector('.metro-pagetabs');
        if (!el) return null;
        const c = getComputedStyle(el, '::before').backgroundColor;
        return c && c !== 'rgba(0, 0, 0, 0)' ? c : null;
      })(),
      accentColor: (() => {
        const el = document.querySelector('.metro-header');
        return el ? getComputedStyle(el).backgroundColor : null;
      })(),
      // 左边缘对齐：四层的第一个可见像素的屏幕横坐标
      leftEdges: (() => {
        const brand = document.querySelector('.metro-brand__mark');
        const tabs = document.querySelector('.metro-tabs .metro-tab');
        const pages = document.querySelector('.metro-pagetabs .metro-pagetab');
        const content = document.querySelector('.metro-content');
        const x = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          // 横向滚动的容器要加上 scrollLeft 才是文档坐标；
          // 首项的 margin 保证它此刻就在可视左边缘，直接用 rect.left 即可
          return Math.round(r.left);
        };
        return {
          brand: x(brand),
          tabs: x(tabs),
          pagetabs: x(pages),
          // 内容区自身有 padding，取它的 padding 左值而不是 rect.left
          content: content ? Math.round(parseFloat(getComputedStyle(content).paddingLeft)) : null,
        };
      })(),
      // 选中 SubTab 的横向位置（验证「两端贴边、中间居中」）
      subtabActivePos: (() => {
        const box = document.querySelector('.metro-pagetabs');
        const all = box ? Array.from(box.querySelectorAll('.metro-pagetab')) : [];
        const cur = box ? box.querySelector('.metro-pagetab.is-active') : null;
        if (!box || !cur || all.length === 0) return {};
        const br = box.getBoundingClientRect();
        const cr = cur.getBoundingClientRect();
        return {
          index: all.indexOf(cur),
          total: all.length,
          left: Math.round(cr.left - br.left),
          rightGap: Math.round(br.right - cr.right),
          centerOffset: Math.round((cr.left + cr.right) / 2 - (br.left + br.right) / 2),
        };
      })(),
      navHeight: Math.round(navHeight),
      navRatio: navHeight / window.innerHeight,
      headerRatio: (header ? header.getBoundingClientRect().height : 0) / window.innerHeight,
      noOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0,
    };
  })()`);
  // 页面说明已移进内容区（v0.4 第三轮），不在导航区里查

  results.walk = [];
  for (const [tab, expect, shotName] of WALK) {
    await clickPivot(win, tab);
    await waitFor(win, `document.body.innerText.includes(${JSON.stringify(expect)})`, 20000, `${tab} 页`);
    await settle(win);
    const info = await win.webContents.executeJavaScript(`(() => ({
      activeTab: (document.querySelector('.metro-pagetab.is-active') || {}).textContent || null,
      title: (document.querySelector('.metro-pagetab.is-active') || {}).textContent || null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))()`);
    await shoot(win, `${shotName}-移动端`);
    results.walk.push({ tab, ...info });
  }

  // 设置页 →「数据与隐私」里的「运行环境」必须如实报告 Android + SQLite，
  // 而不是把宿主说成桌面端（这正是平台差异最容易漏掉的地方：文案说错不会报错，
  // 但用户会据此以为数据存在别处）
  await clickByText(win, '数据与隐私');
  await waitFor(win, `document.body.innerText.includes('运行环境')`, 10000, '运行环境面板');
  await settle(win);
  await shoot(win, '08b-设置-运行环境-移动端');
  results.settingsEnvironment = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    return {
      saysAndroidHost: text.includes('Android 客户端'),
      saysAndroidPlatform: text.includes('Android 14'),
      saysSqlite: /SQLite/i.test(text),
      saysWebViewVersion: text.includes('WebView 999.0.0.smoke'),
      // 不该出现的：把 Android 宿主说成 Electron / 把存储说成本地数据文件
      wronglySaysElectronHost: text.includes('桌面端（Electron）'),
      wronglySaysDesktopFile: text.includes('桌面端本地数据文件'),
    };
  })()`);

  /* ---------------------------------------------------------------------------
   * SubTab 横向位置规则（v0.4 第五轮）
   * ---------------------------------------------------------------------------
   * 要求：「选中的不是最左或最右的 SubTab 就自动居中」，两端则贴边。
   *
   * 必须在「提升」阶段测（它有 3 个页签）—— 之前停在「评估」只有 2 个，
   * 两项布局下永远测不到「末项贴边」与「中间项居中」这两条。
   */
  await clickPivot(win, '薄弱项训练');
  await waitFor(win, `document.body.innerText.includes('生成训练计划')`, 20000, '训练页（位置规则）');
  await delay(700);

  const readPos = () => win.webContents.executeJavaScript(`(() => {
    const box = document.querySelector('.metro-pagetabs');
    const all = box ? Array.from(box.querySelectorAll('.metro-pagetab')) : [];
    const cur = box ? box.querySelector('.metro-pagetab.is-active') : null;
    if (!box || !cur || all.length === 0) return {};
    const br = box.getBoundingClientRect();
    const cr = cur.getBoundingClientRect();
    return {
      index: all.indexOf(cur),
      total: all.length,
      label: (cur.textContent || '').trim(),
      left: Math.round(cr.left - br.left),
      rightGap: Math.round(br.right - cr.right),
      centerOffset: Math.round((cr.left + cr.right) / 2 - (br.left + br.right) / 2),
      // 容器几何：排查「贴边/居中」是否真的生效时必需
      boxWidth: box.clientWidth,
      boxScrollWidth: box.scrollWidth,
      boxScrollLeft: Math.round(box.scrollLeft),
      curWidth: Math.round(cr.width),
    };
  })()`);

  // 依次选中第 0 / 1 / 2 项，逐项记录位置
  results.subtabPosition = [];
  for (const want of ['薄弱项训练', '面试问答', '面试复盘']) {
    await clickPivot(win, want);
    // 等选中态真的落在这个标签上，而不是「点击发出去了」。
    // 注意：waitFor 会把表达式包成 Boolean(...)，
    // 所以这里不能写「取不到就退回空对象」这种含 || 的式子
    // （优先级会把它整体吞进去），必须先把取值结果取出来再比较。
    //
    // 另一个坑：这段注释里绝对不能出现反引号 —— 它在模板字符串内部，
    // 会提前闭合模板，导致后面整段脚本被当成字符串。
    await waitFor(
      win,
      `(() => { const t = document.querySelector('.metro-pagetab.is-active'); return t ? (t.textContent || '').trim().startsWith(${JSON.stringify(want)}) : false; })()`,
      10000,
      `选中 ${want}`,
    );
    await delay(700); // 等 smooth scroll 结束再读位置
    results.subtabPosition.push(await readPos());
  }

  /* ---------------------------------------------------------------------------
   * 左右划切页（v0.4 第三轮新增，必须真实验证）
   * ---------------------------------------------------------------------------
   * 用 CDP 的 Input.dispatchTouchEvent 派发真实 touch 事件 ——
   * 页面里没有可点的按钮能触发它，只能靠手势本身。
   *
   * 三条都要验，因为「左右划」最容易出的错是**该划的不划、不该划的乱划**：
   *   ① 明确左滑 → 切到本阶段下一页
   *   ② 明确右滑 → 回到上一页
   *   ③ 小幅位移（不足阈值）→ 不切页（否则正常滚动内容会误触发）
   */
  // 用 CDP 直接派发 touch 序列（sendInputEvent 不支持 touch，必须走这个）
  const swipe = async (dx, y) => {
    const client = win.webContents.debugger;
    if (!client.isAttached()) client.attach('1.3');
    const send = (type, x) =>
      client.sendCommand('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 6, radiusY: 6, force: 1 }],
      });
    const startX = 200;
    await send('touchStart', startX);
    // 分三步移动，模拟真实手指轨迹（一次性跳过去可能不产生 touchmove）
    for (const step of [0.3, 0.6, 1]) {
      await send('touchMove', startX + dx * step);
    }
    await send('touchEnd', startX + dx);
    await delay(420);
  };

  // 先确保停在「提升」阶段（它有 3 个页面，够划）
  await clickPivot(win, '薄弱项训练');
  await waitFor(win, `document.body.innerText.includes('生成训练计划')`, 20000, '训练页（划动起点）');
  const before = await win.webContents.executeJavaScript(
    "document.querySelector('.metro-pagetab.is-active')?.innerText || ''",
  );

  await swipe(-120, 500); // 左滑 → 下一子页
  const afterLeft = await win.webContents.executeJavaScript(
    "document.querySelector('.metro-pagetab.is-active')?.innerText || ''",
  );
  await swipe(120, 500); // 右滑 → 上一子页
  const afterRight = await win.webContents.executeJavaScript(
    "document.querySelector('.metro-pagetab.is-active')?.innerText || ''",
  );
  // 30px 位移 < 56px 阈值 → 不应触发
  await swipe(-30, 500);
  const afterSmall = await win.webContents.executeJavaScript(
    "document.querySelector('.metro-pagetab.is-active')?.innerText || ''",
  );

  results.swipe = {
    before,
    afterLeft,
    afterRight,
    afterSmall,
    leftSwiped: before !== afterLeft,
    rightSwipedBack: afterLeft !== afterRight,
    smallSwipeIgnored: afterRight === afterSmall,
  };

  // ---------------------------------------------------------------------------
  // 6) 枢纽磁贴与返回键
  // ---------------------------------------------------------------------------
  // v0.4：必须用 clickPivot(win, '工作台')，不能用 clickSelector(sel, 0)。
  // 导航按阶段分组之后，页签下标 0 变成了「我的能力档案」——
  // 工作台不在任何阶段里（它是总览，不是流程的一环），
  // 所以「点第 0 个页签回工作台」这种写法会静默点到别的页面上去。
  await clickPivot(win, '工作台');
  await waitFor(win, `document.querySelectorAll('.metro-tile').length > 0`, 10000, '枢纽磁贴');
  await clickSelector(win, '.metro-tile', 0);
  await waitFor(win, `document.body.innerText.includes('技能清单')`, 10000, '磁贴跳转');
  results.tileNavigation = await win.webContents.executeJavaScript(`(() => ({
    title: (document.querySelector('.metro-pagetab.is-active') || {}).textContent || null,
    tilesOnlyOnWorkbench: document.querySelectorAll('.metro-tile').length === 0,
  }))()`);

  await win.webContents.executeJavaScript('window.history.back()');
  await delay(600);
  results.backNavigation = await win.webContents.executeJavaScript(`(() => ({
    title: (document.querySelector('.metro-pagetab.is-active') || {}).textContent || null,
    activeTab: (document.querySelector('.metro-pagetab.is-active') || {}).textContent || null,
    historyLength: window.history.length,
  }))()`);
  await settle(win);
  await shoot(win, '09-返回键-回到工作台');

  win.destroy();

  // ---------------------------------------------------------------------------
  // 第二趟：外壳在、原生桥没挂上
  // ---------------------------------------------------------------------------
  await checkNoBridgeFallback();

  results.consoleErrors = consoleErrors;
  results.rendererErrors = consoleErrors.filter((m) => /Warning|Error|Uncaught|Unhandled/i.test(m)).slice(0, 10);
  // 截图被跳过的清单：必须如实报出来，不能因为「断言全过」就当截图也拍到了
  results.shotsSkipped = shotsSkipped.slice();

  /* --- v0.4：导航分组必须在真机宽度下成立 --- */
  const ng = results.navGroups || {};
  results.v04Failures = [];
  const v04Failures = results.v04Failures;
  for (const [key, label] of [
    ['hasOverview', '总览'],
    ['hasPrepare', '准备'],
    ['hasAssess', '评估'],
    ['hasImprove', '提升'],
    ['hasSystem', '系统'],
  ]) {
    if (ng[key] !== true) v04Failures.push(`移动端 Tab 缺少「${label}」（实际：${JSON.stringify(ng.labels)}）`);
  }
  if (ng.noOverflow !== true) v04Failures.push('导航分组后出现横向溢出');
  if (!ng.activeTab) v04Failures.push('当前所在 Tab 没有点亮');
  // Sub-Tab 只显示当前阶段的页面
  if ((ng.subtabs || []).length > 4) {
    v04Failures.push(`Sub-Tab 显示了 ${ng.subtabs.length} 项（应为当前阶段的少数几项）`);
  }

  /* v0.4 第三轮：高度收紧。
   * 历史数据（同一台机器、同一视口）：
   *   10 行全展开 ≈ 44% → 3 行胶囊版 106px ≈ 12.4% → 现在 Tab+SubTab
   * 上限压到 0.11：两行导航 36 + 40 = 76px / 851px ≈ 8.9%，
   * 留一点余量给字体缩放。改回胶囊或全展开都会红。 */
  if (!(ng.navRatio > 0)) v04Failures.push('导航高度未取到，无法回归高度上限');
  else if (ng.navRatio > 0.115) {
    v04Failures.push(
      `导航占视口 ${(ng.navRatio * 100).toFixed(1)}%（${ng.navHeight}px / 上限 11.5%）—— 导航仍过重`,
    );
  }
  // 头部整体（品牌 + Tab + 页面标题）不该超过 20%
  if (ng.headerRatio > 0.20) {
    v04Failures.push(`头部整体占视口 ${(ng.headerRatio * 100).toFixed(0)}%（上限 20%）`);
  }
  // 形态断言：不能再用胶囊/药丸分类按钮
  if (ng.tabCount !== 5) v04Failures.push(`一级 Tab 数量为 ${ng.tabCount}（应为 5 个阶段）`);

  /* v0.4 第四轮：标题区必须恰好三层（品牌行 / 一级 Tab / 页面标题）。
   * 四层时代是「品牌 + 大标题 + Tab + Sub-Tab」—— 用户指出标题与 Sub-Tab
   * 讲的是同一件事，合并后页面名终于能用上 Metro 该给它的 30px 字号。 */
  if (ng.headerLayers !== 3) {
    v04Failures.push(`标题区层数为 ${ng.headerLayers}（应为 3：品牌行 / 一级 Tab / 页面标题），实际=${JSON.stringify(ng.headerKinds)}`);
  }
  const kinds = ng.headerKinds || [];
  if (!kinds.includes('brand')) v04Failures.push('标题区缺少品牌行');
  if (!kinds.includes('tabs')) v04Failures.push('标题区缺少一级 Tab');
  if (!kinds.includes('pagetabs')) v04Failures.push('标题区缺少「页面标题 = Sub-Tab」那一行');
  /* v0.4 第五轮：字号统一，选中只靠加粗。
   * 第四轮那两条（选中项 ≥26px、未选中 ≤ 选中 × 75%）与本轮要求直接冲突，
   * 所以它们是被**替换**掉的，不是放宽 —— 用户明确要求「字号统一」。
   */
  const titleSize = ng.pageTitleFontSize || 0;
  const inactiveSize = ng.inactiveTitleFontSize;
  if (!(titleSize >= 18)) {
    v04Failures.push(`页面标题字号仅 ${titleSize}px（太小，可读性不足）`);
  }
  if (inactiveSize != null && inactiveSize !== titleSize) {
    v04Failures.push(
      `选中 ${titleSize}px 与未选中 ${inactiveSize}px 字号不一致 —— 本轮要求字号统一`,
    );
  }
  // 选中项必须靠字重区分，而不是别的
  const activeWeight = ng.activeTitleWeight || 0;
  if (!(activeWeight >= 600)) {
    v04Failures.push(`选中项字重仅 ${activeWeight}（应 ≥600，靠加粗区分选中）`);
  }
  // 整栏换色区分层级：SubTab 的底色必须与一级 Tab 不同
  if (ng.subtabBandColor === ng.accentColor) {
    v04Failures.push('SubTab 底色与一级 Tab 相同 —— 层级没有靠颜色区分');
  }
  // 左边缘统一：四层的左边距必须落在同一处（容差 1px 是取整误差）
  const lefts = ng.leftEdges || {};
  const ref = lefts.brand;
  if (typeof ref === 'number') {
    for (const [name, v] of [['tabs', lefts.tabs], ['pagetabs', lefts.pagetabs], ['content', lefts.content]]) {
      if (typeof v !== 'number') {
        v04Failures.push(`取不到 ${name} 的左边缘`);
      } else if (Math.abs(v - ref) > 1) {
        v04Failures.push(`${name} 左边缘 ${v}px 与品牌行 ${ref}px 不对齐`);
      }
    }
  } else {
    v04Failures.push('取不到品牌行左边缘');
  }
  /* SubTab 横向位置规则：两端贴边、中间居中。
   * 「贴边」基准是容器可视区的左右端，不是 x=0 —— 首项本来就该离屏幕
   * 左边缘一个 gutter（那是左边缘对齐要求的一部分）。 */
  /* SubTab 横向位置规则：两端贴边、中间居中。
   *
   * 判据要分「能滚」与「不能滚」两种情况 ——
   * 实测「提升」组三个标签在 393px 下 scrollWidth 只比 clientWidth 大 5px，
   * 也就是**几乎不溢出**，此时没有任何滚动空间，「居中」在物理上无从谈起。
   * 硬套居中判据会得到一条永远红的假断言。
   *
   * 正确的判据：
   *   不溢出 → 只要求首项贴左、末项贴右（这已经是左边缘对齐的一部分）
   *   可滚动 → 才额外要求中间项居中
   */
  const posList = results.subtabPosition || [];
  if (posList.length !== 3) {
    v04Failures.push(`SubTab 位置规则采样不足（${posList.length}/3）`);
  } else {
    const first = posList[0];
    const scrollable = first && first.boxScrollWidth - first.boxWidth > 8;

    /* 「贴边」的基准是 gutter（18px），不是 x=0。
     *
     * 这一点我一开始搞错过：首项实测 left=18，我按「贴边应为 0」判，于是报失败 ——
     * 但那 18px 恰恰是**左边缘对齐**要的结果（与品牌行、页内内容齐平）。
     * SubTab 容器用负 margin 拉出去是为了让色带满宽，标签本身仍要缩回 gutter，
     * 否则整页的左边缘就散了。所以判据统一用 gutter。
     */
    const GUTTER_PX = 18;
    for (const pos of posList) {
      if (!pos.total || pos.total !== 3) continue;
      // 首项：缩回 gutter（左边缘对齐的一部分，任何情况下都要成立）
      if (pos.index === 0 && Math.abs(pos.left - GUTTER_PX) > 1) {
        v04Failures.push(
          `首个 SubTab（${pos.label}）左端 ${pos.left}px，未对齐 gutter ${GUTTER_PX}px`,
        );
      }
      // 末项：能滚时右端也缩回 gutter（限位的另一头）
      if (scrollable && pos.index === pos.total - 1 && Math.abs(pos.rightGap - GUTTER_PX) > 1) {
        v04Failures.push(
          `末个 SubTab（${pos.label}）右端留 ${pos.rightGap}px，未对齐 gutter ${GUTTER_PX}px`,
        );
      }
      if (scrollable && pos.index > 0 && pos.index < pos.total - 1
          && Math.abs(pos.centerOffset) > 2) {
        v04Failures.push(`中间 SubTab（${pos.label}）未居中，偏离 ${pos.centerOffset}px`);
      }
    }

    // 限位：滚过头会把标签名推出屏幕，这是用户明确要防的
    const last = posList[posList.length - 1];
    if (last && last.boxScrollLeft < 0) {
      v04Failures.push(`容器滚到了负偏移（${last.boxScrollLeft}px），标签会被推出左边缘`);
    }
  }

  /* 左右划切页：三条都要过。
   * 「该划的不划」与「不该划的乱划」是同一类错误的两个方向 ——
   * 后者更糟：它会让用户在任何想上下滚动的地方误触发换页。 */
  const sw = results.swipe || {};
  if (sw.leftSwiped !== true) {
    v04Failures.push(`左滑没有切到下一子页（${sw.before} → ${sw.afterLeft}）`);
  }
  if (sw.rightSwipedBack !== true) {
    v04Failures.push(`右滑没有回到上一子页（${sw.afterLeft} → ${sw.afterRight}）`);
  }
  if (sw.smallSwipeIgnored !== true) {
    v04Failures.push(
      `小于阈值的滑动（30px）仍然触发了换页（${sw.afterRight} → ${sw.afterSmall}）—— 会与纵向滚动打架`,
    );
  }

  if (v04Failures.length > 0) throw new Error(`v0.4 断言未通过：\n  - ${v04Failures.join('\n  - ')}`);
}

app.whenReady().then(async () => {
  try {
    await main();
    results.ok = true;
  } catch (err) {
    results.ok = false;
    results.error = String(err && err.message ? err.message : err);
    results.consoleErrors = consoleErrors;
  } finally {
    finished = true;
    process.stdout.write(`\n__SMOKE_RESULT__${JSON.stringify(results, null, 2)}__END__\n`);
    setTimeout(() => app.exit(results.ok ? 0 : 1), 200);
  }
});

/**
 * 运行期间不允许「窗口全关就退出」。
 *
 * 本脚本会跑两趟：第一趟（有原生桥）结束后会 destroy 掉窗口，
 * 第二趟（无原生桥退化检查）才创建新窗口。
 * Electron 的默认行为是窗口全关就 app.quit()，那样第二趟永远起不来
 * —— 表现为 ERR_FAILED (-2) loading index.html，看起来像构建产物坏了，
 * 实际是进程已经在退出路上。
 */
let finished = false;
app.on('window-all-closed', () => {
  if (finished) app.quit();
});
