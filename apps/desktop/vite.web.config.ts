import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Android 专用插件：把原生桥脚本挂到 index.html 的最前面。
 *
 * 时序是这个插件存在的唯一理由：
 *   `src/lib/bridge.ts` 在**模块求值时**就读取 window.aijob（不是懒读），
 *   而应用主 bundle 是 `type="module"`，默认 defer —— 它一定晚于 head 里的普通脚本。
 *   所以把原生桥放在 head-prepend 并以普通 <script> 引入，就能保证
 *   主 bundle 跑起来时 window.aijob 已经就位。
 *
 * 若换成运行时注入（例如在 onPageFinished 里 evaluateJavascript），
 * 顺序就反了：bundle 已经把 window.aijob 读成 undefined，此后整份应用都会
 * 走 localStorage 回退 —— 看起来能用，实际数据没进原生 SQLite。
 */
function androidNativeBridge(): Plugin {
  return {
    name: 'aijob-android-native-bridge',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { src: './aijob-native-bridge.js' },
          // 用 'head'（追加到 </head> 之前）而不是 'head-prepend'。
          //
          // 时序上两种都成立：入口是 <script type="module">，模块脚本默认 defer，
          // 一定在文档解析完之后才执行；而这里注入的是普通脚本，解析到就执行。
          // 所以无论标签先后，桥脚本都先跑 —— 这正是 lib/bridge.ts 在模块求值时
          // 读取 window.aijob 所需要的前提。
          //
          // 选 'head' 的理由是 CSP：head-prepend 会插到
          // <meta http-equiv="Content-Security-Policy"> **之前**，而 meta 形式的 CSP
          // 只约束它之后的资源 —— 插到前面等于让桥脚本落在策略之外。
          // 追加到 head 末尾既保住时序，也不用为了一个内部脚本放宽策略。
          injectTo: 'head',
        },
      ];
    },
  };
}

/**
 * Web 构建配置。
 *
 * 同一份渲染进程代码，在浏览器里跑起来就是「Web 版」——文档第十七节的开发顺序是
 * Web → Windows → Android，所以这一步不是额外的分支，而是同一条主线。
 *
 * 差异只有一处：浏览器里没有 Electron 桥，storage 退化为 localStorage，
 * HTTP 退化为直接 fetch（AI 请求可能受 CORS 限制，设置页会提示）。
 *
 *   npm run web:build    → dist-web/       常规静态站点
 *   npm run web:single   → dist-demo/      单文件 HTML，双击即可打开（用于演示与验收）
 *   npm run web:android  → dist-android/   Android 宿主用（产物拷进 apps/android 的 assets）
 *
 * 三个模式共用同一份源码与同一套别名，唯一差别是 outDir 与是否内联成单文件。
 *
 * android 模式为什么不能用单文件：
 *   单文件模式会 inlineDynamicImports，把 PDF.js 的 worker 也塞进主 chunk。
 *   WebView 里首次解析简历时会带着整个 PDF 引擎一起在启动时解析，
 *   启动时间直接变长；而 Android 的 assets 是一次性拷贝到本地的，
 *   本来就不存在「多几个文件不方便传输」的问题。
 */
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  const android = mode === 'android';
  return {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    resolve: {
      alias: {
        '@aijob/core': resolve(__dirname, '../../packages/core/src'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    // 只有 android 模式需要一个额外的静态资源目录：
    // publicDir 里的文件会被原样拷到产物根，正是原生桥脚本要去的位置。
    ...(android ? { publicDir: resolve(__dirname, '../android/native-bridge') } : {}),
    plugins: [
      react(),
      tailwindcss(),
      ...(single ? [viteSingleFile({ removeViteModuleLoader: true })] : []),
      ...(android ? [androidNativeBridge()] : []),
    ],
    build: {
      outDir: resolve(__dirname, single ? 'dist-demo' : android ? 'dist-android' : 'dist-web'),
      emptyOutDir: true,
      chunkSizeWarningLimit: 4096,
      rollupOptions: single
        ? { output: { inlineDynamicImports: true } }
        : undefined,
    },
  };
});
