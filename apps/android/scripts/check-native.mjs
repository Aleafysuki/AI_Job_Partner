/**
 * Android 原生侧的静态校验（不需要 Android SDK）。
 *
 *   npm run android:check
 *
 * 为什么需要它：
 *   Java 那一半在没有 Android SDK 的机器上**完全无法编译**，
 *   而「首次构建失败」绝大多数来自四类低级错误：
 *     1. Java 括号不配对；
 *     2. 引用了不存在的资源（R.string.x / @drawable/x）；
 *     3. JS 桥发出的通道名和 Java 分派处理的通道名对不上 ——
 *        这一条最阴：不会编译失败，只会在运行时走到 default 分支报
 *        「未知的调用通道」，表现为某个功能「就是不好使」；
 *     4. XML 注释里出现了连续两个连字符 —— XML 不允许，
 *        而 CSS 自定义属性的前缀正好长这样，很容易顺手写进去。
 *   这四类都能在纯文本层面查出来，所以没有理由留给用户在 Android Studio 里发现。
 *
 * 它**不是**编译器的替代品。查不出：类型错误、API 版本不匹配、
 * 方法签名写错、import 缺失。这些都只能靠真正的构建。
 */

import { globSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const ANDROID = resolve(APP_ROOT, 'android');
const MAIN = resolve(ANDROID, 'app', 'src', 'main');
const BRIDGE_JS = resolve(APP_ROOT, 'native-bridge', 'aijob-native-bridge.js');

const problems = [];
const notes = [];

function fail(title, lines) {
  problems.push({ title, lines });
}

// ---------------------------------------------------------------------------
// 1. Java 括号平衡
// ---------------------------------------------------------------------------

function checkJavaBraces() {
  // 注意：globSync 在 Windows 上返回的路径分隔符可能是反斜杠，
  // 直接 includes('com/aijob') 会一个文件都匹配不到（曾经就是这样静默通过了一次）。
  const files = globSync('**/*.java', { cwd: MAIN })
    .map((f) => f.replaceAll('\\', '/'))
    .filter((f) => f.includes('com/aijob'));
  const bad = [];
  for (const rel of files) {
    const raw = readFileSync(resolve(MAIN, rel), 'utf8');
    /*
     * 去掉注释与字符串字面量，避免它们里面的括号干扰计数。
     *
     * 顺序必须是「先字符串、后注释」——
     * 反过来会出两类错：
     *   1. `"content://"` 里的 `//` 被当成行注释，
     *      于是**整行剩下的代码被删掉**，花括号随即不配对；
     *   2. 注释里写了个 `"` 就提前闭合了字符串匹配。
     * 这个 bug 曾让 OCR 的两个新文件误报「括号不配对」——
     * 而它们的括号其实是对的。静态检查器自己出错，比它漏报更麻烦。
     */
    const src = raw
      .replace(/"(\\.|[^"\\])*"/g, '""')
      .replace(/'(\\.|[^'\\])*'/g, "''")
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const balance = {
      '{}': (src.match(/\{/g) || []).length - (src.match(/\}/g) || []).length,
      '()': (src.match(/\(/g) || []).length - (src.match(/\)/g) || []).length,
      '[]': (src.match(/\[/g) || []).length - (src.match(/\]/g) || []).length,
    };
    if (Object.values(balance).some((v) => v !== 0)) bad.push(`${rel} ${JSON.stringify(balance)}`);
  }
  if (bad.length) fail('Java 括号不配对', bad);
  if (files.length === 0) fail('一个 Java 源文件都没找到（路径匹配写错了？）', [MAIN]);

  /*
   * 原生桥脚本的语法检查。
   *
   * 为什么必须加：2026-10-08 那次改 `aijob-native-bridge.js` 时，
   * 一个替换漏掉了 `readBytes` 的闭合 `},`，
   * 而这个错一路飘到**用户手机上**才爆 —— 冒烟里表现为
   * 「Cannot read properties of undefined」这种完全指不到源头的信息。
   *
   * 它本该被拦住：`new Function(src)` 只解析不执行，
   * 语法错会当场抛出来，且**不产生任何副作用**（不会真的注册 bridge）。
   */
  {
    const bridgeFile = resolve(APP_ROOT, '..', 'native-bridge', 'aijob-native-bridge.js');
    if (existsSync(bridgeFile)) {
      const src = readFileSync(bridgeFile, 'utf8');
      try {
        // eslint-disable-next-line no-new-func
        new Function(src);
      } catch (e) {
        fail('原生桥脚本语法错误（它跑在 WebView 里，语法错会让整个应用起不来）', [
          `${e.message}\n  文件：${bridgeFile}`,
        ]);
      }
    }
  }
  if (files.length === 0) fail('一个 Java 源文件都没找到（路径匹配写错了？）', [MAIN]);
  notes.push(`Java 文件 ${files.length} 个，括号平衡检查完成`);
}

// ---------------------------------------------------------------------------
// 2. 资源引用完整性
// ---------------------------------------------------------------------------

function collectDefined() {
  const defined = { string: new Set(), color: new Set(), drawable: new Set(), mipmap: new Set() };
  for (const f of globSync('res/values/*.xml', { cwd: MAIN })) {
    const src = readFileSync(resolve(MAIN, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of src.matchAll(/<string\s+name="([^"]+)"/g)) defined.string.add(m[1]);
    for (const m of src.matchAll(/<color\s+name="([^"]+)"/g)) defined.color.add(m[1]);
  }
  for (const [dir, kind] of [
    ['res/drawable', 'drawable'],
    ['res/drawable-v24', 'drawable'],
    ['res/mipmap-anydpi-v26', 'mipmap'],
  ]) {
    const abs = resolve(MAIN, dir);
    if (!existsSync(abs)) continue;
    for (const f of globSync('*', { cwd: abs })) defined[kind].add(basename(f, extname(f)));
  }
  return defined;
}

/** Capacitor / androidx 库提供的资源，本项目不该重复定义 */
const FROM_LIBRARIES = new Set(['colorPrimary', 'colorPrimaryDark', 'colorAccent']);

function checkResourceRefs() {
  const defined = collectDefined();
  const sources = [
    ...globSync('**/*.java', { cwd: MAIN }).filter((f) => f.includes('com/aijob')),
    ...globSync('res/**/*.xml', { cwd: MAIN }),
    'AndroidManifest.xml',
  ];

  const missing = [];
  for (const rel of sources) {
    // 注释里的示例文本不算引用（之前就在这里误报过一次）
    const src = readFileSync(resolve(MAIN, rel), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const refs = [
      ...[...src.matchAll(/R\.(string|drawable|color|mipmap)\.(\w+)/g)].map((m) => [m[1], m[2]]),
      ...[...src.matchAll(/@(string|drawable|color|mipmap)\/(\w+)/g)].map((m) => [m[1], m[2]]),
    ];
    for (const [kind, name] of refs) {
      if (FROM_LIBRARIES.has(name)) continue;
      if (!defined[kind]?.has(name)) missing.push(`${rel} -> ${kind}/${name}`);
    }
  }

  if (missing.length) fail('引用了未定义的 Android 资源', [...new Set(missing)]);
  notes.push(`资源引用检查完成（string ${defined.string.size} / color ${defined.color.size} / drawable ${defined.drawable.size} / mipmap ${defined.mipmap.size}）`);
}

// ---------------------------------------------------------------------------
// 3. JS 桥 ↔ Java 分派的通道一致性（最重要的一条）
// ---------------------------------------------------------------------------

function checkChannelParity() {
  if (!existsSync(BRIDGE_JS)) {
    fail('找不到桥脚本', [BRIDGE_JS]);
    return;
  }
  const js = readFileSync(BRIDGE_JS, 'utf8');
  const javaFiles = globSync('**/AijobBridge.java', { cwd: MAIN });
  if (javaFiles.length === 0) {
    fail('找不到 AijobBridge.java', [MAIN]);
    return;
  }
  const java = readFileSync(resolve(MAIN, javaFiles[0]), 'utf8');

  const jsChannels = new Set([...js.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]));
  const javaChannels = new Set([...java.matchAll(/case\s+"([^"]+)"\s*:/g)].map((m) => m[1]));

  const orphanJs = [...jsChannels].filter((c) => !javaChannels.has(c)).sort();
  const orphanJava = [...javaChannels].filter((c) => !jsChannels.has(c)).sort();

  if (orphanJs.length) {
    fail('JS 会发出但 Java 不处理的通道（运行时报「未知的调用通道」）', orphanJs);
  }
  if (orphanJava.length) {
    // 不算失败，但要提示：可能是实现了没人用的死通道
    fail('Java 实现了但 JS 从不调用的通道（可能是死代码）', orphanJava);
  }

  // 事件名在 JS 侧集中声明在 EVENTS 表里（见桥脚本注释：对不上的话
  // 静默模式下用户点「结束录制」会毫无反应，而两边代码看上去都没错）
  const eventsBlock = /var\s+EVENTS\s*=\s*\{([\s\S]*?)\}/.exec(js);
  if (!eventsBlock) {
    fail('桥脚本里找不到 EVENTS 事件名表', ['native-bridge/aijob-native-bridge.js']);
    return;
  }
  const jsEvents = new Set([...eventsBlock[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]));
  const javaEvents = new Set([...java.matchAll(/emitEvent\("([^"]+)"/g)].map((m) => m[1]));
  const eventMismatch = [...new Set([...jsEvents, ...javaEvents])]
    .filter((e) => !jsEvents.has(e) || !javaEvents.has(e))
    .sort();
  if (eventMismatch.length) {
    fail('事件通道两边对不上（quiet 模式下用户将无法停掉录音）', eventMismatch);
  }

  notes.push(`通道一致性：JS ${jsChannels.size} 个 / Java ${javaChannels.size} 个，事件 ${jsEvents.size} 个`);
}

// ---------------------------------------------------------------------------
// 4. XML 良构 + 注释里的双连字符
// ---------------------------------------------------------------------------

function checkXmlComments() {
  const files = [...globSync('**/*.xml', { cwd: MAIN }), 'AndroidManifest.xml'];
  const bad = [];
  for (const rel of files) {
    const abs = resolve(MAIN, rel);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    // 提取注释体，检查里面是否出现连续两个连字符
    for (const m of src.matchAll(/<!--([\s\S]*?)-->/g)) {
      if (m[1].includes('--')) bad.push(`${rel} -> 注释里出现连续两个连字符`);
    }
  }
  if (bad.length) {
    fail('XML 注释含非法字符序列（会导致整个文件解析失败）', [...new Set(bad)]);
  }
  notes.push(`XML 注释检查完成（${files.length} 个文件）`);
}

// ---------------------------------------------------------------------------

checkJavaBraces();
checkResourceRefs();
checkChannelParity();
checkXmlComments();

for (const line of notes) process.stdout.write(`  · ${line}\n`);

if (problems.length) {
  process.stdout.write('\n');
  for (const p of problems) {
    process.stdout.write(`✗ ${p.title}\n`);
    for (const line of p.lines) process.stdout.write(`    ${line}\n`);
  }
  process.stdout.write('\n原生侧静态校验未通过。注意：这不代表编译会失败，但以上都是真问题。\n\n');
  process.exit(1);
}

process.stdout.write('\n✓ 原生侧静态校验通过（注意：这不是编译，类型与 API 版本仍需真机构建确认）\n\n');
