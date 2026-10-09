/**
 * 把 Web 产物同步进 Android 工程。
 *
 *   npm run android:sync    （等价于 npm run sync --workspace @aijob/android）
 *
 * 做三件事，顺序不能反：
 *   1. 检查 Web 产物存在，**并确认 index.html 里真的注入了原生桥脚本**；
 *   2. cap copy  —— 把 apps/desktop/dist-android 拷进 android/app/src/main/assets/public；
 *   3. 再检查一次目标位置，确认桥脚本跟着过去了。
 *
 * 为什么第 1、3 步的检查不是多余的：
 *   桥脚本没被注入时，应用**不会报错**。它会安静地把 window.aijob 读成 undefined，
 *   然后整份应用退化成 localStorage 存储 —— 界面一切正常，功能全部可用，
 *   只是数据没进原生 SQLite、导出与录音落盘也都走不通。
 *   这类「静默降级」在真机上极难发现，所以宁可在这里让它硬失败。
 *
 * 为什么不自己拷文件、而是调 cap copy：
 *   目录结构（assets/public）、capacitor.config.json 的生成、插件清单的合并
 *   都是 Capacitor 的职责，手写一份等于把它的实现细节抄进来并从此需要跟着它变。
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const WEB_DIR = resolve(APP_ROOT, '..', 'desktop', 'dist-android');
const ASSETS_DIR = resolve(APP_ROOT, 'android', 'app', 'src', 'main', 'assets', 'public');
const BRIDGE_SCRIPT = 'aijob-native-bridge.js';

const require = createRequire(import.meta.url);

/**
 * 定位 Capacitor CLI 的入口脚本。
 *
 * 为什么用模块解析而不是拼 'node_modules/@capacitor/cli/bin/capacitor'：
 * 本仓库是 npm workspaces，依赖会被**提升**到仓库根的 node_modules，
 * apps/android/node_modules 下根本没有 @capacitor/cli。
 * 拼固定路径的话在这台机器上必然失败（而且报错信息会误导成「没装依赖」）。
 * createRequire 走的是 Node 真实的解析算法，提升与否都能找到。
 */
function resolveCapCli() {
  let pkgPath;
  try {
    pkgPath = require.resolve('@capacitor/cli/package.json');
  } catch (err) {
    fail('找不到 @capacitor/cli，先在 apps/android 下执行 npm install');
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.cap;
  const bin = resolve(dirname(pkgPath), rel);
  if (!existsSync(bin)) fail(`@capacitor/cli 的入口不存在：${bin}`);
  return bin;
}

function fail(message) {
  process.stderr.write(`\n✗ ${message}\n\n`);
  process.exit(1);
}

function assertBridgeInjected(indexHtmlPath, label) {
  if (!existsSync(indexHtmlPath)) {
    fail(`找不到 ${indexHtmlPath}（${label}）`);
  }
  const html = readFileSync(indexHtmlPath, 'utf8');
  if (!html.includes(BRIDGE_SCRIPT)) {
    fail(
      [
        `${label} 的 index.html 里没有引入 ${BRIDGE_SCRIPT}。`,
        '',
        '这意味着 android 构建模式没有生效（可能用了 dist-web 或单文件产物）。',
        '正确做法：先跑 npm run web:android，它会在 <head> 最前面注入桥脚本。',
        '',
        '不要跳过这一步：桥脚本缺失时应用不会报错，只会静默退化成 localStorage，',
        '数据不进原生数据库，而界面上完全看不出来。',
      ].join('\n'),
    );
  }
}

function main() {
  process.stdout.write('· 检查 Web 产物…\n');
  assertBridgeInjected(resolve(WEB_DIR, 'index.html'), 'dist-android');

  if (!existsSync(resolve(WEB_DIR, BRIDGE_SCRIPT))) {
    fail(`dist-android 里缺少 ${BRIDGE_SCRIPT}（publicDir 没有配置对？）`);
  }

  process.stdout.write('· 同步到 Android 工程（cap copy）…\n');
  const capBin = resolveCapCli();

  try {
    execFileSync(process.execPath, [capBin, 'copy', 'android'], { cwd: APP_ROOT, stdio: 'inherit' });
  } catch (err) {
    fail(`cap copy 失败：${err.message}`);
  }

  /*
   * OCR 资源要单独补拷一遍 —— 这一步是踩出来的坑。
   *
   * `cap copy` 只搬它认识的构建产物（index.html 与 assets/ 下的 JS/CSS），
   * `tesseract/` 里的 `.traineddata.gz` 与 `worker.min.js` **会被静默跳过**，
   * 且跳过时不报错 —— 表现是 APK 装上了、点识别却报
   * 「初始化失败」或一条与「文件缺失」毫无关系的 SyntaxError。
   *
   * 所以这里显式补拷 + 断言。缺了断言，这个问题只在用户手机上才暴露。
   */
  {
    const ocrSrc = resolve(APP_ROOT, '..', 'desktop', 'dist-android', 'tesseract');
    const ocrDst = join(ASSETS_DIR, 'tesseract');
    if (!existsSync(ocrSrc)) {
      fail(
        '没有找到 dist-android/tesseract。' +
          'OCR 模型必须随应用打包才能离线识别 —— 先跑 npm run ocr:sync。',
      );
    }
    mkdirSync(ocrDst, { recursive: true });
    for (const name of readdirSync(ocrSrc)) {
      copyFileSync(resolve(ocrSrc, name), join(ocrDst, name));
    }
    const missing = ['chi_sim.traineddata.gz', 'worker.min.js'].filter(
      (n) => !existsSync(join(ocrDst, n)),
    );
    if (readdirSync(ocrDst).every((f) => !/^tesseract-core.*\.wasm\.js$/.test(f))) {
      missing.push('tesseract-core-*.wasm.js');
    }
    if (missing.length > 0) {
      fail(`OCR 资源不完整：${missing.join('、')}。先跑 npm run ocr:sync`);
    }
    process.stdout.write(`  · OCR 资源：${readdirSync(ocrDst).length} 个文件已就位（离线可用）\n`);
  }

  process.stdout.write('· 复核目标位置…\n');
  assertBridgeInjected(resolve(ASSETS_DIR, 'index.html'), 'android/app/src/main/assets/public');

  process.stdout.write('\n✓ 同步完成。接下来可以：\n');
  process.stdout.write('    npm run android:open     用 Android Studio 打开工程\n');
  process.stdout.write('    或在 android/ 下执行 ./gradlew assembleDebug 直接出 APK\n\n');
}

main();
