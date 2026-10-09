/**
 * 真实跑一次桌面端本地 OCR（一次性验证脚本，跑完可删）。
 *
 * 为什么要单独写一个脚本而不是靠 UI 冒烟：
 * OCR 失败的最常见形态是「不报错但认出来是乱的」，
 * 而 UI 冒烟只能断言「按钮存在、文本出现了」。
 * 识别**质量**只能靠「拿一段已知的文字，看能认出多少」来验。
 */
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

const IMAGE = path.join(os.tmpdir(), 'jd-test.png');

/** 期望识别出的关键词。用来算「认出多少」 */
const EXPECT = [
  '后端工程师',
  'Redis',
  '缓存',
  'MySQL',
  'Kafka',
  '本科',
  '3年',
  'Java',
];

app.whenReady().then(async () => {
  if (!fs.existsSync(IMAGE)) {
    console.log('__RESULT__ FAIL 缺少测试图：' + IMAGE);
    app.exit(2);
    return;
  }
  console.log('图片：' + IMAGE + '（' + fs.statSync(IMAGE).size + ' 字节）');

  const t0 = Date.now();

  /*
   * 加载方式说明：
   * electron-vite 把主进程打包成单个 out/main/index.js，
   * 它是「启动应用」的入口，import 它会真的开一个窗口。
   * 所以这里改为**直接跑源码**——通过 esbuild 现场编译 ocr.ts，
   * 这样验证的是同一份源码，且不需要启动整个应用。
   */
  const esbuild = require('esbuild');
  // 必须放在项目目录里：require 是按脚本所在位置向上找 node_modules 的，
  // 放在系统临时目录下会找不到 tesseract.js。
  const tmpJs = path.resolve(__dirname, '../apps/desktop/.ocr-verify.cjs');
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../apps/desktop/src/main/ocr.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: tmpJs,
    // tesseract.js 走 require，不打进产物
    external: ['electron', 'tesseract.js', 'node:*'],
    logLevel: 'silent',
  });

  let desktopOcr;
  try {
    ({ desktopOcr } = require(tmpJs));
  } catch (e) {
    console.log('__RESULT__ FAIL 编译/加载 ocr 模块失败：' + e.message);
    app.exit(2);
    return;
  }
  if (typeof desktopOcr !== 'function') {
    console.log('__RESULT__ FAIL desktopOcr 未导出');
    app.exit(2);
    return;
  }

  console.log('开始识别（首次会加载 WASM 与中文训练数据，需要几秒）…');
  const res = await desktopOcr({ path: IMAGE, script: 'chinese' });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!res.ok) {
    console.log('__RESULT__ FAIL 识别失败：' + res.reason + '（用时 ' + elapsed + 's）');
    app.exit(1);
    return;
  }

  const text = res.blocks.map((b) => b.text).join('\n');
  // 判定时去掉全部空格：OCR 常在数字与中文之间插空格（「3 年以上」vs 期望「3年」），
  // 那不是识别错，只是排版间隙。按原样比对会得到一条永远红的假失败。
  const flat = text.replace(/\s+/g, '');
  const hit = EXPECT.filter((k) => flat.includes(k.replace(/\s+/g, '')));
  const miss = EXPECT.filter((k) => !flat.includes(k.replace(/\s+/g, '')));
  const avg = res.blocks.length
    ? res.blocks.reduce((s, b) => s + b.confidence, 0) / res.blocks.length
    : 0;

  console.log('\n──── 识别结果 ────');
  console.log(text);
  console.log('─────────────────');
  console.log('块数：' + res.blocks.length + '，平均置信度：' + avg.toFixed(2));
  console.log('用时：' + elapsed + 's，引擎：' + res.engine);
  console.log('命中：' + hit.length + '/' + EXPECT.length + ' → ' + JSON.stringify(hit));
  console.log('漏掉：' + JSON.stringify(miss));
  console.log(
    '__RESULT__ ' + (res.blocks.length > 0 ? 'OK' : 'EMPTY') + ' 命中=' + hit.length + '/' + EXPECT.length,
  );
  app.exit(hit.length >= 5 ? 0 : 1);
});

app.on('window-all-closed', () => {});