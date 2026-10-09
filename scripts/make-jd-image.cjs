/**
 * 生成一张 JD 测试图，用于真实验证本地 OCR（一次性脚本）。
 *
 * 为什么不用 Python/PowerShell 生成：本机没有 PIL，
 * 而 PowerShell 的 Add-Type 被安全策略拦了。
 * Electron 的原生 Canvas 不需要额外依赖，且它本来就在。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/make-jd-image.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(require('node:os').tmpdir(), 'jd-test.png');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; background:#fff; font: 22px/1.9 "Microsoft YaHei", sans-serif; color:#000; padding:16px 24px; width:760px; }
</style></head><body>
  <div>后端工程师（Java）</div>
  <div>岗位职责：</div>
  <div>1、负责电商平台核心服务开发</div>
  <div>2、使用 Redis 做缓存与分布式锁</div>
  <div>任职要求：</div>
  <div>本科及以上，3年以上 Java 开发经验</div>
  <div>熟悉 MySQL、Redis、Kafka</div>
</body></html>`;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 820, height: 420, show: false });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
  // 等字体与布局稳定
  await new Promise((r) => setTimeout(r, 900));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log(`__RESULT__ ${OUT} ${fs.statSync(OUT).size} bytes`);
  app.exit(0);
});