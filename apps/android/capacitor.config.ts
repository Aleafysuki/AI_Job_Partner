import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 容器配置。
 *
 * 这里只负责「把 Web 产物装进一个受控的 Android WebView」，
 * 业务桥接不走 Capacitor 的插件系统，见 native-bridge/aijob-native-bridge.js 的说明。
 *
 * webDir 指向 Android 专用的 Web 构建产物（apps/desktop/dist-android），
 * 由 `npm run web:android` 生成。不要指到 dist-web —— 那一份的 index.html
 * 里没有注入原生桥脚本，跑起来会没有 window.aijob。
 */
const config: CapacitorConfig = {
  appId: 'com.aijob.partner',
  appName: 'AI Job Partner',
  webDir: '../desktop/dist-android',

  server: {
    /**
     * 用 https 方案而不是默认的 http。
     *
     * 为什么必须是 https：应用私有 WebView 里的 `file://` 或明文 http 源不是
     * secure context，会直接导致
     *   - crypto.subtle 不可用（转写与去标识化里的散列会炸）
     *   - Service Worker / Web Worker 受限（PDF.js 的 worker 会被拦）
     *   - localStorage 在某些机型上不持久
     * Android 的 `https://localhost` 是 Capacitor 提供的本地虚拟源，
     * 满足 secure context 的全部条件，且不出网。
     */
    androidScheme: 'https',
  },

  android: {
    /** 不允许 https 页面加载明文资源：这个应用的所有真实出网都走原生 OkHttp */
    allowMixedContent: false,
    /** 保留系统输入法行为，不要让 Capacitor 接管 */
    captureInput: false,
    /** 只在 debuggable 构建里开 WebView 调试，避免正式包留后门 */
    webContentsDebuggingEnabled: false,
    /** 面试录音期间屏幕必须保持常亮（一小时的面试），在原生侧处理 */
    backgroundColor: '#0050efff',
  },
};

export default config;
