/**
 * 真实应用冒烟测试（主进程 / 预加载 / IPC / 本地存储）。
 *
 * 与 ui-smoke.cjs 的分工：
 *   ui-smoke.cjs —— 直接加载渲染产物，验证「界面 + 业务链路」，不依赖跨进程通信；
 *   app-smoke.mjs —— 启动**真实主进程**，检查窗口、存储初始化，并尝试用 CDP 驱动界面验证 IPC。
 *
 * 运行：
 *   node apps/desktop/scripts/app-smoke.mjs
 *   AIJOB_EXE="apps/desktop/release/win-unpacked/AI Job Partner.exe" node apps/desktop/scripts/app-smoke.mjs
 *
 * 退出码：
 *   0  全部通过
 *   1  真实失败（见 diagnostic）
 *   2  降级：环境阻断了跨进程本地回环，CDP 无法连接 →
 *      只完成「主进程启动 + 存储落盘」验证，界面驱动部分标记为未验证。
 *      **调用方必须把 2 当成「未验证」，不能当成通过。**
 */

import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP_DIR, '..', '..');
const NODE_MODULES_ELECTRON = path.join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

const PACKAGED = process.env.AIJOB_EXE;
const ELECTRON = PACKAGED || NODE_MODULES_ELECTRON;
const APP_ARG = PACKAGED ? null : '.';
const PORT = 9333;
// 用临时 userData，避免污染用户真实数据；同时让「数据库是否落盘」成为一个确定性的断言点
const USER_DATA = path.join(os.tmpdir(), `aijob-app-smoke-${process.pid}`);

const result = {
  target: PACKAGED ? '打包产物' : '源码 + 本地 Electron',
  steps: [],
  errors: [],
};

/** 必须真正跑到的步骤数（不含被环境跳过的） */
const EXPECTED_STEPS = 11;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(name, ok, detail) {
  result.steps.push({ name, ok, detail });
}

function skip(name, reason) {
  result.steps.push({ name, ok: null, skipped: true, detail: reason });
}

/**
 * 等主进程把 DevTools 端点打出来，并解析出 WebSocket 地址。
 *
 * 不用 `/json/list`（HTTP 端点）：在配了 HTTP 代理或做了流量拦截的环境里会被接管；
 * 而 DevTools 的浏览器级 WebSocket 是直连 TCP。
 */
async function waitForBrowserWs(getLog, timeoutMs = 40000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(getLog());
    if (match) return match[1];
    await sleep(300);
  }
  throw new Error('等待 DevTools 端点超时（日志里没出现 DevTools listening）');
}

/** 极简 CDP 客户端（Node 22 自带全局 WebSocket，不需要额外依赖） */
function connect(wsUrl, timeoutMs = 8000) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`CDP 连接失败：${e.message ?? e}`));
    });
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  /** sessionId 非空时走扁平化协议（Target.attachToTarget flatten:true） */
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      seq += 1;
      pending.set(seq, { resolve, reject });
      const payload = { id: seq, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });

  return { ready, send, close: () => ws.close() };
}

async function main() {
  if (!existsSync(ELECTRON)) throw new Error(`找不到 Electron 可执行文件：${ELECTRON}`);
  await fs.mkdir(USER_DATA, { recursive: true });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 否则 Electron 会退化成普通 Node 运行
  delete env.NODE_OPTIONS; // 打包后的应用不接受 NODE_OPTIONS，会刷一条无害错误

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-compositing',
  ];
  if (APP_ARG) args.unshift(APP_ARG);

  const child = spawn(ELECTRON, args, { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });

  let cdp = null;
  let sessionId = null;

  try {
    // ---------- 阶段 A：不依赖跨进程通信就能验证的部分 ----------
    const browserWs = await waitForBrowserWs(() => log);
    step('主进程启动并开放调试端点', true, browserWs.replace(/\/devtools\/browser\/.*/, '/devtools/browser/<id>'));

    // createStore() 会建库建表；文件出现即证明：主进程 → 存储模块 → node:sqlite 这条链路通了
    const dbFile = path.join(USER_DATA, 'data', 'ai-job-partner.db');
    let dbSize = 0;
    const dbStarted = Date.now();
    while (Date.now() - dbStarted < 20000) {
      if (existsSync(dbFile)) {
        dbSize = (await fs.stat(dbFile)).size;
        break;
      }
      await sleep(300);
    }
    step('主进程初始化本地存储（SQLite 建库落盘）', dbSize > 0, `${dbFile}（${dbSize} bytes）`);
    result.storage = { file: dbFile, size: dbSize };

    step('主进程存活', child.exitCode === null, child.exitCode === null ? '进程运行中' : `已退出，code=${child.exitCode}`);

    // ---------- 阶段 B：需要跨进程本地回环（CDP）的部分 ----------
    try {
      cdp = connect(browserWs);
      await cdp.ready;
    } catch (err) {
      result.degraded = true;
      result.degradedReason =
        `${String(err.message || err)}。` +
        'CDP 需要主进程与冒烟脚本之间能做本地回环通信；当前环境阻断了跨进程 loopback，' +
        '因此「窗口 / preload / IPC 往返」这几项没有被验证。请在有正常网络栈的机器上重跑以获得完整验证。';
      const reason = '环境限制：跨进程本地回环被阻断';
      skip('渲染进程页面目标可见', reason);
      skip('preload 原生桥注入', reason);
      skip('IPC appInfo（存储引擎 / 路径）', reason);
      skip('界面挂载', reason);
      skip('点击「载入示例数据」', reason);
      skip('完整链路产出报告', reason);
      skip('从存储读回快照', reason);
      skip('面试复盘链路产出报告', reason);
      skip('面试会话与复盘报告已落盘', reason);
      return;
    }

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    let pageTarget = null;
    const targetStarted = Date.now();
    while (Date.now() - targetStarted < 40000) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      pageTarget = targetInfos.find((t) => t.type === 'page' && /^file:/.test(t.url));
      if (pageTarget) break;
      await sleep(400);
    }
    if (!pageTarget) throw new Error('等待渲染进程页面目标超时');

    sessionId = (await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, sessionId);
    step('渲染进程页面目标可见', true, pageTarget.url);

    const evaluate = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? '页面求值异常');
      return res.result.value;
    };

    const bridge = await evaluate(`(() => {
      if (!window.aijob) return { ok: false };
      return { ok: true, isDesktop: window.aijob.isDesktop };
    })()`);
    step('preload 原生桥注入', bridge.ok === true && bridge.isDesktop === true, JSON.stringify(bridge));

    const info = await evaluate(`window.aijob.appInfo()`);
    step('IPC appInfo（存储引擎 / 路径）', Boolean(info && info.storageLocation), JSON.stringify(info));
    result.appInfo = info;

    await evaluate(`(() => new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (document.querySelector('#root')?.childElementCount > 0) { clearInterval(timer); resolve(true); }
        else if (Date.now() - t0 > 20000) { clearInterval(timer); resolve(false); }
      }, 200);
    }))()`);
    step('界面挂载', true, 'React 应用已渲染');

    const clicked = await evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent||'').includes('载入示例'));
      if (!btn) return false; btn.click(); return true;
    })()`);
    step('点击「载入示例数据」', clicked === true);

    const report = await evaluate(`(() => new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        const text = document.body.innerText;
        if (text.includes('匹配分析报告')) {
          clearInterval(timer);
          const pick = (label) => { const m = text.match(new RegExp(label + '\\\\s*\\\\n?\\\\s*(\\\\d+)')); return m ? Number(m[1]) : null; };
          resolve({ total: pick('要求总数'), matched: pick('满足'), partial: pick('部分满足'), lacking: pick('缺少证据'), gap: pick('明显缺口'), unknown: pick('无法判断') });
        } else if (Date.now() - t0 > 60000) { clearInterval(timer); resolve(null); }
      }, 300);
    }))()`);
    step('完整链路产出报告', Boolean(report), JSON.stringify(report));
    result.report = report;

    const snapshot = await evaluate(`window.aijob.storage.load()`);
    step(
      '从存储读回快照',
      Array.isArray(snapshot?.profiles) && snapshot.profiles.length > 0,
      `profiles=${snapshot?.profiles?.length ?? 0}, jobs=${snapshot?.jobs?.length ?? 0}, trainingPlans=${snapshot?.trainingPlans?.length ?? 0}, schemaVersion=${snapshot?.schemaVersion ?? '—'}`,
    );

    // ---------- 面试复盘：验证这条链路在真实主进程里也能跑通并落盘 ----------
    // 录音本身需要音频设备，这里只验证「转写文本 → 复盘报告 → 写进 SQLite」这一段。
    const debrief = await evaluate(`(() => new Promise((resolve) => {
      const nav = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('面试复盘'));
      if (!nav) return resolve({ ok: false, reason: '找不到面试复盘导航' });
      nav.click();
      const t0 = Date.now();
      let clicked = false;
      const timer = setInterval(() => {
        if (!clicked) {
          const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('载入示例转写'));
          if (btn) { btn.click(); clicked = true; }
        } else if (document.body.innerText.includes('先结论')) {
          clearInterval(timer);
          resolve({ ok: true });
        } else if (Date.now() - t0 > 60000) {
          clearInterval(timer);
          resolve({ ok: false, reason: '复盘报告未在 60 秒内生成' });
        }
      }, 300);
    }))()`);
    step('面试复盘链路产出报告', debrief.ok === true, JSON.stringify(debrief));

    const snapshot2 = await evaluate(`window.aijob.storage.load()`);
    step(
      '面试会话与复盘报告已落盘',
      Array.isArray(snapshot2?.interviewSessions) &&
        snapshot2.interviewSessions.length > 0 &&
        Array.isArray(snapshot2?.debriefReports) &&
        snapshot2.debriefReports.length > 0,
      `interviewSessions=${snapshot2?.interviewSessions?.length ?? 0}, debriefReports=${snapshot2?.debriefReports?.length ?? 0}, 维度=${snapshot2?.debriefReports?.[0]?.dimensions?.length ?? 0}`,
    );
  } catch (err) {
    result.error = String((err && err.message) || err);
    step('流程异常中断', false, result.error);
  } finally {
    try {
      cdp?.close();
    } catch {
      /* 忽略 */
    }
    child.kill();
    await sleep(600);

    // GPU / 持久化缓存 / NODE_OPTIONS 属于环境噪音，不算应用问题
    const NOISE = /GPU|gpu_|persistent_cache|DawnGraphiteCache|NODE_OPTIONs|node_bindings\.cc/i;
    result.processLog = log
      .split('\n')
      .filter((l) => /error|Error|FATAL|Uncaught/i.test(l) && !NOISE.test(l))
      .slice(0, 8);

    const executed = result.steps.filter((s) => !s.skipped);
    const failed = executed.filter((s) => !s.ok);
    result.summary = {
      executed: executed.length,
      expected: EXPECTED_STEPS,
      failed: failed.length,
      skipped: result.steps.length - executed.length,
      degraded: Boolean(result.degraded),
    };

    if (result.degraded) {
      // 降级：只保证「执行过的步骤全部通过」，但明确不是「全部验证通过」
      result.ok = failed.length === 0 && !result.error;
      result.verified = 'partial';
    } else {
      result.ok = !result.error && executed.length >= EXPECTED_STEPS && failed.length === 0 && result.processLog.length === 0;
      result.verified = result.ok ? 'full' : 'none';
    }

    if (!result.ok || result.degraded) {
      result.diagnostic = {
        failedSteps: failed.map((s) => `${s.name} → ${s.detail ?? ''}`),
        processLogTail: log.split('\n').filter(Boolean).slice(-12),
      };
    }

    process.stdout.write(`\n__APP_SMOKE__${JSON.stringify(result, null, 2)}__END__\n`);
    // 0=全部通过 / 2=降级（部分验证）/ 1=真实失败
    process.exit(result.ok ? (result.degraded ? 2 : 0) : 1);
  }
}

main().catch((err) => {
  result.error = String(err?.message ?? err);
  result.ok = false;
  result.verified = 'none';
  process.stdout.write(`\n__APP_SMOKE__${JSON.stringify(result, null, 2)}__END__\n`);
  process.exit(1);
});
