/**
 * 把 OCR 的 WASM 与训练数据放进 WebView 的 assets（v0.3 job.input_image）。
 *
 * ── 为什么必须这一步 ──
 * tesseract.js 默认从 jsDelivr 拉 core 与 `*.traineddata.gz`。
 * 应用的承诺是「数据只在本机、不联网」，而 APK 里如果只有渲染层代码、
 * 没有模型文件，那么第一次点「识别」就会去联网下载 —— 承诺当场破掉。
 *
 * 产出目录（两端一致）：
 *   assets/tesseract/tesseract-core-simd-lstm.wasm.js
 *   assets/tesseract/chi_sim.traineddata.gz
 *   assets/tesseract/eng.traineddata.gz
 *
 * 桌面端不需要这一步：那边直接读 node_modules 的绝对路径。
 */
import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 本脚本在 apps/desktop/scripts/ 下，所以仓库根要上溯三级
const ROOT = resolve(HERE, '../../..');

/*
 * 放在 `dist-android` 而不是 `assets/public` —— 这是踩过的坑。
 *
 * `cap copy` 会**整体替换** assets/public，所以直接写进 assets 的文件
 * 会在下一次 android:sync 时消失（表现为「第一次构建有模型、第二次就没了」）。
 * 正确的位置是构建产物目录：cap copy 会把它带进 assets。
 */
const TARGETS = [
  {
    dest: join(ROOT, 'apps/desktop/dist-android/tesseract'),
    label: 'Android 构建产物',
  },
  {
    /** 桌面端的 vite public 目录（让 dev / 预览也能用） */
    dest: join(ROOT, 'apps/desktop/public/tesseract'),
    label: '桌面 public',
  },
];

/** 需要复制的文件：core 的 wasm 壳 + 两份模型 */
function collect() {
  const out = [];

  // 1. tesseract 的 worker 脚本与 WASM core。
  //    只取 lstm 版本 —— 老的 legacy 引擎本项目用不到，带进去只会给 APK 增重。
  const coreDir = join(ROOT, 'node_modules/tesseract.js-core');
  if (!existsSync(coreDir)) {
    throw new Error('缺少 tesseract.js-core —— 请先 npm install');
  }
  /*
   * 只取两个 core 变体，不是全部。
   *
   * 包里一共五个（simd / relaxedsimd / 无 SIMD × legacy / lstm）。
   * 少带一个就会在部分设备上加载失败 —— 但全带要多占约 7MB APK，
   * 而 legacy 引擎本项目根本不用（只走 LSTM）。
   * 于是保留：simd（现代设备，最快）+ 无 SIMD（老设备兜底）。
   */
  const WANTED = [/^tesseract-core-simd-lstm\.wasm\.js$/, /^tesseract-core-lstm\.wasm\.js$/];
  for (const name of readdirSync(coreDir)) {
    if (WANTED.some((re) => re.test(name))) {
      out.push({ from: join(coreDir, name), name });
    }
  }
  if (out.length === 0) {
    throw new Error(`在 ${coreDir} 里没有找到 lstm 版 core —— 版本可能变了`);
  }

  /*
   * 训练数据：**只带中文**。
   *
   * 中文 best_int 是 1.6MB，英文标准版是 10.4MB ——
   * 后者包含大量本项目用不到的语料，为它把 APK 撑大十倍不划算。
   *
   * 代价：英文 JD 在离线环境下识别不了。
   * 处理方式：界面上的语言切换里，「拉丁字母」这一档会明确写出
   * 「需要在桌面端用，或联网下载一次模型」——
   * 宁可说清楚做不到，也不让它静默失败。
   */
  const langs = [{ pkg: '@tesseract.js-data/chi_sim', version: '4.0.0_best_int' }];
  for (const { pkg, version } of langs) {
    const dir = join(ROOT, 'node_modules', pkg, version);
    if (!existsSync(dir)) {
      throw new Error(`缺少 ${pkg}/${version} —— 请先 npm install`);
    }
    const file = readdirSync(dir).find((f) => f.endsWith('.traineddata.gz'));
    if (!file) {
      throw new Error(`${dir} 里没有 *.traineddata.gz`);
    }
    out.push({ from: join(dir, file), name: file });
  }

  /*
   * 3. worker 脚本。
   *
   * **漏了它会报一个完全看不懂的错**：
   * `Uncaught SyntaxError: In strict mode code, functions can only be declared
   * at top level or inside a block.`
   * —— tesseract 的 worker 是一份独立脚本，被当成 ES module 加载时就炸。
   * 而这个错跟「worker 文件不存在」毫无字面关系，本轮为此排查了很久。
   * 所以下面有断言：产物目录里必须同时有这几类文件。
   */
  const workerSrc = join(ROOT, 'node_modules/tesseract.js/dist/worker.min.js');
  if (!existsSync(workerSrc)) {
    throw new Error('缺少 tesseract.js/dist/worker.min.js —— 请先 npm install');
  }
  out.push({ from: workerSrc, name: 'worker.min.js' });

  return out;
}

const files = collect();
let total = 0;

for (const t of TARGETS) {
  mkdirSync(t.dest, { recursive: true });
  for (const f of files) {
    const to = join(t.dest, f.name);
    // 已经是最新就跳过 —— gradle 会按时间戳决定要不要重打包，
    // 无条件复制会让每次 sync 都触发一次完整重编
    if (existsSync(to) && statSync(to).size === statSync(f.from).size) continue;
    copyFileSync(f.from, to);
    total += 1;
  }
  const mb = files.reduce((s, f) => s + statSync(f.from).size, 0) / 1048576;
  console.log(`  · ${t.label}：${files.length} 个文件（${mb.toFixed(1)} MB）→ ${t.dest}`);
}

// 构建期断言：四类文件缺一不可。
// 少任何一个都会在运行时以「语法错误」或「取不到模型」的形式爆掉，
// 而那时候 APK 已经装到用户手机上了。
const REQUIRED = ['chi_sim.traineddata.gz', 'worker.min.js'];
for (const t of TARGETS) {
  const missing = REQUIRED.filter((n) => !existsSync(join(t.dest, n)));
  const cores = readdirSync(t.dest).filter((f) => /^tesseract-core.*\.wasm\.js$/.test(f));
  if (cores.length === 0) missing.push('tesseract-core-*.wasm.js');
  if (missing.length > 0) {
    throw new Error(`${t.dest} 缺少：${missing.join('、')}\n` +
      '这几个文件缺了会在用户手机上才报错，现在必须拦住。');
  }
}

console.log(
  `OCR 资源就绪${total > 0 ? `（复制 ${total} 个）` : '（无变化）'}。` +
    '不联网即可识别 —— 这一点是产品的第一承诺，不能靠运行时下载。',
);
/*
 * 顺序提醒（写在文件末尾，因为这是最容易踩的地方）：
 *   1. npm run build:web:android   ← 产出 dist-android
 *   2. node scripts/sync-tesseract  ← 把模型塞进 dist-android
 *   3. npm run android:sync        ← cap copy 把它带进 assets
 * 少跑第 2 步的话，APK 里就没有模型，识别会在运行时报「初始化失败」。
 */
