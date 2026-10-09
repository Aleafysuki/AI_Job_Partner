# Android 端

## 一句话

> **同一个客户端，换一个宿主。** 判断逻辑一行没动，界面一份代码两套外壳。

这份文档要回答四件事：Android 端由哪几层组成、怎么构建、与桌面端**有哪些实质差异**、
以及**哪些东西还没有被验证过**。

如果你只想构建 APK，跳到「构建」一节。

---

## 一、先说清楚：这算不算破了 v0.1 铁律

`packages/core/src/version.ts` 里有一条：

```ts
{ id: 'restrict.mobile_client', label: '移动端独立客户端',
  description: 'Android / iOS 独立客户端', since: 'future', docRef: '25', restriction: true }
```

它是文档第 25 节的「暂时不做」之一，按项目规则**不会随版本号自动解锁**。
`docs/ROADMAP.md` 里也写着「在 `since` 没改之前，任何试图绕过能力开关直接实现该功能的代码
都属于违反项目约束」。

**本次的处理方式（用户明确决策）：不动能力表。**

理由：第 25 节那一批条目的共同特征是「另起一条产品线或服务体系」——
招聘网站爬虫、职位数据库、自动投递、用户注册、在线支付、社区、企业后台。
`mobile_client` 排在其中，指的是**另做一个移动端产品**（独立的功能集合、独立的数据、
可能还要配套账号体系）。

而这次做的是**同一个客户端换一个宿主**：

- 数据仍是本机单份，不建账号，不上云（`allowBackup=false`，见下文）；
- 功能集合与桌面端**逐个对齐**，没有多一项也没有少一项；
- 判断逻辑仍全部在 `packages/core`，Android 侧一行判断都没写。

换句话说：**它不是「第二个客户端」，而是「同一份东西的第二个壳」。**
这与第 25 节要防的事不是一回事，所以能力表不需要改。

⚠ 这个解释写在 `docs/ROADMAP.md` 的对应位置。**如果以后要做的其实是「另起一个移动端产品」
（比如移动端专属功能、移动端账号与云同步），那必须先按正常流程把
`restrict.mobile_client` 的 `since` 显式改成目标版本，再动代码。**

---

## 二、分层

```
apps/desktop/src/renderer/                 ← 界面（一份，三个宿主共用）
├── styles-metro.css                       Metro 设计令牌层（只在 data-aijob-host='android' 下生效）
├── components/MetroShell.tsx              Metro 移动外壳：大色块头部 + Pivot 分页导航
├── components/nav.tsx                     导航定义与角标口径（两个外壳共用）
├── components/Layout.tsx                  桌面外壳（未改）
├── lib/platform.ts                        宿主判定：desktop / android / web
└── lib/bridge.ts                          运行时适配（未改契约，只让 describe() 说实话）

packages/core/                             ← 判断逻辑（宿主无关，本次零改动）

apps/android/                              ← Android 宿主（本次新增）
├── capacitor.config.ts                    容器配置
├── native-bridge/aijob-native-bridge.js   桥的 JS 侧：把原生 RPC 装配成 window.aijob
├── scripts/sync.mjs                       Web 产物 → Android assets
└── android/                               Capacitor 生成的 Gradle 工程
    └── app/src/main/java/com/aijob/partner/
        ├── MainActivity.java              装桥、转发系统回调、静默期不暂停 WebView
        ├── AijobBridge.java               RPC 分派 + 存储/出网/文件/麦克风/静默
        ├── AijobStore.java                SQLite（WAL）
        ├── AijobCapture.java              录音分片落盘 + 剩余空间
        ├── AijobQuiet.java                静默状态
        └── AijobQuietService.java         前台服务 + 常驻通知（安全出口）
```

`packages/core` 的 `tsconfig.json` 里 `lib` 只有 `ES2023`，越界即 typecheck 失败 ——
这条约束在 Android 端同样成立，也是「判断逻辑没被分叉」的机械证明。

### 桥为什么不用 Capacitor 的插件系统

Capacitor 的插件要经过 `@capacitor/core` 的 JS 运行时，才能把
`window.Capacitor.Plugins.X` 变成可调用代理。那意味着渲染层要打包 Capacitor 的 JS，
桌面端与 Web 端也被迫带上一个永远用不到的运行时。

所以这里改成：**原生侧暴露一个通用 RPC 入口，JS 侧把它适配成 `window.aijob`。**

好处有三个：

1. 渲染层零新增依赖，`src/shared/ipc.ts` 的 `DesktopBridge` 契约一个字都没改
   —— 桌面端那套实现与 Android 这套实现在同一个契约下并排存在；
2. 桥的 JS 一侧是纯 JS，**在没有 Android SDK 的机器上也能真实验证**
   （见「验证」一节）；
3. 只有 Kotlin/Java 那一侧需要真机。

### 时序：为什么桥脚本必须由构建注入到 `<head>`

`lib/bridge.ts` 是在**模块求值时**读取 `window.aijob` 的（不是懒读），
所以 `window.aijob` 必须在应用主 bundle 之前就位。

`vite.web.config.ts` 在 android 模式下会往 `index.html` 的 `<head>` 末尾注入
`<script src="./aijob-native-bridge.js">`（普通脚本，解析到就执行）；
而入口是 `<script type="module">`，模块脚本默认 defer，一定后执行。
时序由这一点保证。

**如果改成运行时注入**（例如在 `onPageFinished` 里 `evaluateJavascript`），顺序就反了：
bundle 已经把 `window.aijob` 读成 `undefined`，此后整份应用都会走 localStorage 回退。
看起来一切正常，实际数据没进原生 SQLite。`apps/android/scripts/sync.mjs` 里
有一步专门的检查，就是为了拦住这种静默降级。

---

## 三、构建

### 前置

| 需要 | 版本 | 说明 |
| --- | --- | --- |
| JDK | **21** | Capacitor 8 要求（`capacitor.build.gradle` 里 sourceCompatibility = VERSION_21） |
| Android SDK | compileSdk 36 / minSdk 26 / targetSdk 36 | Android Studio 装好即可；缺的组件 AGP 会自己补 |
| Node | ≥ 20 | 与仓库其它部分一致 |

### 一条命令链

```bash
# 首次
cd apps/android && npm install        # 安装 Capacitor（本仓库是 workspaces，依赖会提升到根 node_modules）

# 每次改了界面/业务代码后
npm run android:sync                  # = web:android 构建 + 校验桥注入 + cap copy
npm run android:open                  # 用 Android Studio 打开，然后正常 Build
```

或者不用 Android Studio，直接出 debug 包：

```bash
cd apps/android/android
./gradlew assembleDebug               # 产物：app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug                # 连上设备直接装
```

`npm run android:sync` 会做三件事，**顺序不能反**，且第 1、3 步都会失败退出：

1. 检查 `dist-android/index.html` 里真的引了 `aijob-native-bridge.js`；
2. `cap copy` 把产物拷进 `android/app/src/main/assets/public`；
3. 再检查一次目标位置。

### 本机实测通过的构建方式（2026-10-06，已产出可侧载 APK）

这台机器**没有配 JDK/SDK 环境变量**，但装了 Android Studio，它自带 JDK 与 SDK，
所以命令行构建要显式指过去：

```bash
export JAVA_HOME="/d/Program Files/Android/Android Studio/jbr"    # 自带 JBR 21
export PATH="$JAVA_HOME/bin:$PATH"
cd apps/android/android && ./gradlew assembleDebug
```

| 资源 | 位置 | 说明 |
| --- | --- | --- |
| JDK 21 | `D:\Program Files\Android\Android Studio\jbr` | Android Studio 自带的 JBR。**不要用系统里那份 JDK 1.8** |
| Android SDK | `D:\Program Files\Android\Android Studio SDK` | 由 `android/local.properties` 的 `sdk.dir` 指定 |
| Gradle 8.14.3 | `~/.gradle/wrapper/dists/` | 已缓存，不必重新下载 |

`local.properties` 是**每台机器各写一份**的文件（正常项目里会被 `.gitignore` 排除）。
换机器时改那一行 `sdk.dir` 即可，或删掉它改用 `ANDROID_HOME` 环境变量。

**SDK 组件不用手工装**：首次构建时 AGP 自动下载了 `platforms;android-36` 与
`build-tools;35.0.0`（因为 `licenses/android-sdk-license` 已接受）。
所以「SDK 里只有 android-35 和 android-36.1」并不需要你开 SDK Manager。

🩹 **首次构建暴露的问题（没有 SDK 时不可能发现，都已修）**：

| 问题 | 现象 | 修法 |
| --- | --- | --- |
| `capacitor-android` 工程路径不存在 | Gradle 配置阶段就报 `Project directory ... does not exist`：`capacitor.settings.gradle` 指向 `apps/android/node_modules/...`，而 npm workspaces 把依赖提升到了仓库根 | 在 `android/settings.gradle` 末尾加了一段「两个位置都试」的修正（那个文件不会被 `cap sync` 覆盖） |
| `AijobBridge.java` 少了 `import android.util.Base64;` | `错误: 找不到符号 变量 Base64` | 补上 import |
| `MainActivity` 把 `onResume/onPause` 写成 `protected` | Capacitor 的 `BridgeActivity` 声明为 `public`，Java 不允许覆盖时收窄权限，直接编译失败 | 改成 `public`；并且**整个 `onPause` 覆盖都删掉了**——见下一条 |
| 那个 `onPause` 覆盖本身就是错的设计 | 它为了「静默录制时不让 WebView 被暂停」而跳过 `super.onPause()`，属于危险写法 | 翻 Capacitor 源码确认：`BridgeActivity.onPause` 只通知插件与 Cordova 兼容层，**从不暂停自己的 WebView**，全仓搜不到 `webView.onPause`/`pauseTimers`。真正会打断录音的是进程被系统回收 —— 那是前台服务的职责。原设计留痕写在 `MainActivity.java` 里 |

### 网络慢的话

Gradle 要从 Google Maven 与 Maven Central 拉 AGP、Capacitor、OkHttp。

本机实测：`dl.google.com`（Google Maven 的宿主）约 **1.5MB/s**，够快；
`repo1.maven.org` 只有约 **40KB/s**，依赖没命中缓存时会明显变慢。
要加速就在 `android/build.gradle` 的仓库列表里加国内镜像，例如
`https://maven.aliyun.com/repository/public`（实测约 1.5MB/s）。

Gradle 发行版本身在 `gradle/wrapper/gradle-wrapper.properties` 里。
**本机实测官方源 `services.gradle.org` 只有约 30KB/s，而那个包有 210MB**
（按那速度将近两小时），所以该文件已改指腾讯云镜像（实测约 18MB/s），
官方源原值以注释保留在文件里，要回退直接换回那一行。

---

## 四、契约映射

`window.aijob` 的每个方法与原生通道一一对应。**JS 侧完全不需要改任何业务代码**，
因为映射在 `native-bridge/aijob-native-bridge.js` 里一次做完了。

| `DesktopBridge`（src/shared/ipc.ts） | 原生通道 | Android 实现 |
| --- | --- | --- |
| `appInfo()` | `appInfo` | 系统版本 + SQLite 路径 + WebView 版本 |
| `storage.load/save/clear` | `storage.*` | `AijobStore`，SQLite + WAL |
| `http(request)` | `http.request` | OkHttp（`callTimeout` 取 `timeoutMs`） |
| `pickFile()` | `file.pick` | SAF `ACTION_OPEN_DOCUMENT` |
| `readBytes(path)` | `file.readBytes` | content URI 或普通路径 |
| `saveText` / `saveHtml` | `file.saveText` / `file.saveHtml` | SAF `ACTION_CREATE_DOCUMENT` |
| `openExternal(url)` | `app.openExternal` | `ACTION_VIEW` |
| `capture.*`（7 个） | `capture.*` | 应用私有目录 `files/recordings/<id>/` |
| `media.requestMic()` | `media.requestMic` | 运行时权限 + `AudioManager` 设备枚举 |
| `media.setSystemAudio()` | `media.setSystemAudio` | **恒为 false**，见下文第五条 |
| `media.listSources()` | `media.listSources` | 恒为空数组 |
| `quiet.set/isOn` | `quiet.*` | 前台服务 + 常驻通知 |
| `quiet.onStopRequested` | 事件 `quiet.stopRequested` | 通知里的「结束录制」按钮 |
| `hotkey('stop', …)` | `hotkey.set` | **恒为 false**，见下文第四条 |

### 二进制怎么过桥

JSON 表达不了字节数组。Electron 那边由结构化克隆代劳，这里得自己编解码，
所以 `bodyBytes` / 音频分片 / 读文件字节都走 base64。

**最容易错的一处是 `HttpRequest.bodyBytes`：** 它是一个 `Uint8Array`
（见 `packages/core/src/ai/types.ts` 的注释），直接进 `JSON.stringify` 会变成
`{"0":1,"1":2,…}` —— 原生侧收到的「音频」是一坨无意义的下标映射，转写会**安静地失败**。

所以 JS 侧先把它转成 `bodyBase64`，原生侧再解回来。冒烟测试里有一条专门的断言钉住它
（见下）。

---

## 五、与桌面端不同的地方（五条，都要让用户知道）

### 1. 静默模式**无法做到「不弹系统通知」** ⚠ 最重要的差异

产品要求：面试期间不弹提示、不弹窗、**不弹系统通知**、窗口隐藏。

Android 的硬性规定：**长时间录音必须有前台服务，前台服务必须有常驻通知。**
没有 API 能绕过。这不调和的冲突只能这样处理：

- 通知通道用 `IMPORTANCE_LOW`：不出声、不震动、不弹 heads-up，只在通知栏留一个图标；
- 通知里放「结束录制」按钮 —— 既然它必须存在，就让它承担正事：
  **它是静默模式下用户唯一能停掉录制的入口**（桌面端对应的东西是托盘菜单）；
- `POST_NOTIFICATIONS` 权限（Android 13+）被拒时，服务仍能起来但通知不可见，
  那样就变成了「在录音、但没有任何地方能停掉」—— 这是产品明确不允许的形态。
  **界面在开启静默模式前必须先确认这条权限。**

桌面端的「托盘图标 + 全局快捷键」两条安全出口，在 Android 上合并成了这一条通知。

### 2. **不做系统内录**（`setSystemAudio` 恒为 false）

Android 从 10 起有 `AudioPlaybackCapture`，但前提是**被录的那一方同意**：
目标应用可以在清单里写 `android:allowAudioPlaybackCapture="false"` 关掉。
会议类应用（线上笔试、视频面试客户端）几乎都会关掉它 —— 一个面试工具去录面试官的声音，
正是这个开关被设计出来要防的事情。

所以如实返回 `false`，让渲染层按「本平台不支持内录」降级为只录麦克风 ——
这与项目在 macOS / Linux 上处理内录是同一个套路（见 `docs/ROADMAP.md` 已知问题表），
只是原因更硬：不是缺驱动，是平台不允许。

**直接后果：Android 端做线上面试复盘时，录不到面试官那一半对话。**
表现侧（P1–P6）的部分评分维度会因此缺少依据，报告里会标为「无法判断」。
这不是实现缺陷，是平台边界。

### 3. **没有全局快捷键**（`hotkey` 恒为 false）

Android 没有这个概念。替代品就是上面那条常驻通知 —— 实际上比快捷键更好找，
因为通知就摆在用户眼前，而快捷键需要记住。

### 4. **没有「打开文件夹」**

Android 没有「打开目录」这个动作。`capture.openFolder` 的实现是：用 FileProvider
把录音目录里的**第一个文件**交给系统查看器，由用户选接收方。
行为与桌面端的 `shell.openPath` 不同，界面上要如实说明。

### 5. **关掉了系统自动备份**（`allowBackup=false`）

Capacitor 模板默认 `allowBackup="true"`。开着的话，能力档案、证据库、面试录音
会被 Android 自动备份到用户的 Google 账号云端 —— 那正好推翻
「数据只保存在本机、不上传简历」这句写在界面上、也写进产品文档第十一节的话。

代价：**换机时数据不会自动迁移。** 想改回来就把 `AndroidManifest.xml` 里那一条设回
`true`，并在这里同步说明。

---

## 六、Metro 设计语言怎么落地的

参考对象是**微软的 Metro / Modern UI**（不是 Material，也不是那个叫 Metro 的音乐播放器）。

### 手法：覆盖 Tailwind v4 的设计令牌，而不是改写页面

实测本项目 Tailwind v4 的产物里，工具类全部指向令牌：

```css
.bg-indigo-600 { background-color: var(--color-indigo-600); }
.rounded-lg    { border-radius: var(--radius-lg); }
```

所以 `styles-metro.css` 只要在 `:root[data-aijob-host='android']` 之下重定义
`--color-*` / `--radius-*`，**全部 8 个页面、5000+ 行 JSX 一行都不用动**。

唯一的例外是 `.rounded-full`（产物里是 `border-radius: 3.40282e38px` 字面量，
不经过令牌），所以它天然保持圆形 —— 开关、圆形描边不受影响，这是期望的。

去阴影用的是同一个思路：Tailwind v4 的写法是
`.shadow-sm { --tw-shadow: <值>; box-shadow: … var(--tw-shadow) }`，
把 `--tw-shadow` 置零即可，而且**不会**碰掉 `focus:ring` ——
ring 走的是同一个复合声明里的 `--tw-ring-shadow`，是另一个变量。
直接写 `box-shadow: none` 则会把键盘焦点圈一起抹掉。

### 六条视觉纪律

| 纪律 | 实现 |
| --- | --- |
| 大色块 | 头部整块 Metro Blue；枢纽磁贴用 Metro 官方磁贴色板（Blue/Teal/Green/Amber/Purple/Magenta） |
| 重排版 | 11px 放大字距的全大写标签 + 30px 字重 200 的标题 |
| 留白组织内容 | 分割线减淡到几乎看不见，靠间距分组 |
| 零修饰 | `--radius-*: 0`、`--tw-shadow: 0 0 #0000`、无渐变 |
| 内容即控件 | 磁贴整块可点，数字是内容 |
| 有情感的动效 | 0.18s `cubic-bezier(0.16,1,0.3,1)` 位移淡入；磁贴按下 scale(0.972) |

### 字体为什么不是 Segoe UI

Metro 的原配字体是 Segoe UI，但它只存在于 Windows。
Android 上最接近的同代几何无衬线体是 **Roboto**（也是 Android 的原生字体），
所以移动端字体栈是 `Roboto, "Noto Sans SC", …`。
照搬 Segoe 会得到一个「配置了但永远取不到」的字体名 —— 那是照抄字面，不是忠于精神。

### 外壳与桌面端的取舍

- 一级导航是**横向可扫的 Pivot 页签**（Windows Phone 的 Pivot 控件），
  不是底部 Tab —— 底部 Tab 属于 Material 语系；
  选中项用 3px 实心白条标记，页签会自动滚进视野；
- 返回键语义按 Android 用户的预期：压一条 history，退到上一个页面，退无可退才交给系统退出；
- 首页多了一组**枢纽磁贴**做入口，磁贴的数字直接复用 `buildNav()` 的计数
  （导航定义与角标口径抽到 `components/nav.tsx`，桌面端侧边栏与移动端 Pivot 共用一份）。

---

## 七、验证

### 本机可复现的命令

| 命令 | 覆盖 |
| --- | --- |
| `npm run android:check` | **原生侧静态校验**（不需要 Android SDK，见下） |
| `npm run typecheck` | 含 `@aijob/android`（`capacitor.config.ts`） |
| `npm test` | 核心引擎与规则，**80 项断言** |
| `npm run build` | 桌面端构建 |
| `npm run smoke:ui` | 桌面外壳 + 完整业务链路（真实 Chromium，截图） |
| `npm run web:single` | 单文件演示产物 |
| `npm run smoke:mobile` | **Android 外壳 + 原生桥契约 + 完整业务链路** |
| `npm run android:sync` | 构建 + 校验桥注入 + 拷进 Android assets |

跑 `smoke:ui` / `smoke:mobile` 时注意：这台机器的 shell 里带了
`ELECTRON_RUN_AS_NODE=1`，必须去掉，否则 Electron 会退化成普通 Node：
`env -u ELECTRON_RUN_AS_NODE npm run smoke:mobile`。

> ⚠ **一条环境限制**：本环境对「单次操作里删太多文件」有保护，超过阈值即失败：
> `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":N,"threshold":80,"scope":"turn"}`。
> 实测触发规律是**按单次工具调用计数**：
> 在同一条命令里连续跑两个构建，第二个起会在 `[vite:prepare-out-dir]` 失败（EXIT=1）；
> 一次把多个目录传给 `rm -rf` 也会被拦。
> 更麻烦的是 `emptyOutDir` 可能把产物清到一半，让后续冒烟跑在残缺产物上，
> 报出 `Cannot read properties of undefined (reading 'isDesktop')` 这种莫名其妙的错。
>
> **规避：一个调用只跑一个构建**（每条验证命令单独发一次）。
> **这不是项目缺陷，是环境限制** —— 排查构建失败时先看是不是撞了这个闸门。

### `android:check` 查什么

因为 Java 那一半在没有 Android SDK 的机器上完全无法编译，所以能查的都查了。
它检查四类「首次构建失败」的高频原因，全部在纯文本层面可判定：

1. **Java 括号不配对**（去掉注释与字符串字面量后计数）；
2. **引用了不存在的资源**（`R.string.x` / `@drawable/x` 是否真的有定义）；
3. **JS 桥发出的通道名与 Java 分派处理的通道名对不上** —— 这一条最阴：
   不会编译失败，只会在运行时走到 `default` 分支报「未知的调用通道」，
   表现为某个功能「就是不好使」。顺带也查**事件通道**（`quiet.stopRequested`），
   对不上的后果是静默模式下用户点「结束录制」毫无反应；
4. **XML 注释里出现连续两个连字符** —— XML 不允许，而 CSS 自定义属性的前缀
   正好长这样，非常容易顺手写进去，报错行号还指向注释那一行。

它**不是**编译器的替代品。查不出：类型错误、API 版本不匹配、方法签名写错、
import 缺失。这些都只能靠真正的构建。

> 这个脚本做过反向验证：把 JS 侧的事件名故意改错，它会失败；
> 还原后通过。一个从来不会失败的自检等于没有自检。

### `smoke:mobile` 到底验证了什么

它用真实 Chromium 以 393×851 的移动视口跑两趟：

**第一趟（完整 Android 宿主）**
1. **宿主判定**：通过 preload 注入 `window.Capacitor`，走 `lib/platform.ts` 的
   `detect()` 分支 —— 而不是 `?host=android` 这种显式覆盖。
   只测显式覆盖等于绕过判定逻辑本身，测了个假；
2. **原生桥契约**：在 preload 里注入一个「假原生」`AijobNative`，
   让 `aijob-native-bridge.js` 真的跑起来，再逐条核对它是否把 `window.aijob`
   装配成了 `DesktopBridge` 的形状（每个方法、每个子方法都在）；
3. **`bodyBytes` 的序列化**：直接调 `aijob.http({ bodyBytes: Uint8Array([1,2,3,4,5]) })`，
   断言原生侧收到的是 base64 字符串、长度 8、且**解回来正好是 `[1,2,3,4,5]`**，
   而不是 `{"0":1,…}` 那种下标对象；
4. **`base64 → Uint8Array`**：`readBytes` 解回来必须是 `[1,2,3,4,5]`；
5. **事件链路**：`quiet.onStopRequested` 订阅 → 触发 `quiet.stopRequested` →
   回调恰好被调用一次 → 退订后再触发不再回调；
6. **Metro 令牌**：强调色 `#0050ef`、`--radius-lg/xl = 0px`、字体栈含 Roboto、
   磁贴圆角 0、阴影复合声明全透明、**每一页横向溢出都是 0**；
7. **完整业务链路**：载入示例 → 简历 → 岗位 → 匹配报告（20 条要求）跑通，
   且结论仍只有五个离散值、页面明说不给 0–100 分；
8. **设置页如实报告**：宿主显示「Android 客户端」、存储显示 SQLite、
   版本显示 Android 14 + WebView，而**不**显示 Electron；
9. 枢纽磁贴跳转、Pivot 逐页走一遍、返回键回退；
10. 全程零控制台错误。

**第二趟（`window.aijob` 缺失的异常情况）**
确认应用会如实退化为 localStorage（数据确实落在 `aijob.workspace.v1`），
业务链路照样跑通，而不是白屏或假装写成功。

产物：`screenshots/mobile/*.png`（10 张）。

### ⚠ 还没有被验证的部分（不要当成已通过）

| 未验证 | 为什么 | 怎么补 |
| --- | --- | --- |
| **App 在真机上能否正常启动** | 本机没有连接设备；AVD 里没有系统镜像（要另下约 1.5GB），而且这台机器没有 GPU 加速，软件渲染下模拟器基本跑不动 | 侧载到手机跑一遍 —— 这是当前唯一的未知项 |
| **SQLite 实际落盘/读回** | 需要真机 | 手机上建立档案后杀掉 App 再打开，看数据是否还在 |
| **SAF 文件选择器** | 需要真机 | 真机上走一遍「上传简历」 |
| **真实录音** | 冒烟环境没有音频输入设备 | 真机上走一遍面试复盘 |
| **前台服务与常驻通知** | 需要真机 | 真机上开静默模式，确认通知可见、「结束录制」按钮有效 |
| **`file_paths.xml` 的 FileProvider 授权** | 需要真机 | 真机上点「打开录音目录」 |

**结论**（截至 2026-10-06）：

- UI、桥的 JS 一侧、完整业务链路 —— **已在本机用真实 Chromium 验证**；
- Java 原生一侧 —— **已通过真实 Gradle 编译并成功打出 debug APK**
  （`assembleDebug` 成功，产物已用 aapt / apksigner / zipalign 核验）；
- 唯一剩下的未知项是**运行期行为**，那只能在真机上做。

---

## 八、已知问题与后续

| 问题 | 影响 | 计划 |
| --- | --- | --- |
| 原生侧**只编译过，没运行过** | 可能在启动或首次调用原生桥时崩溃（编译通过不等于跑得起来） | 侧载到真机跑一遍；这是目前唯一的未知项 |
| 没有签名用的正式密钥 | 当前是 debug 包（Android Debug 证书），可以侧载但不能上架，也不能覆盖安装到别人的正式包上 | 要长期用就生成自己的 keystore 并配 `signingConfigs` |
| 文件选择器用的是 `startActivityForResult` | 这个 API 已过时（编译时会有 deprecation 提示），但功能正常 | 后续可换成 `ActivityResultLauncher`；不影响当前使用 |
| 不做系统内录 | 线上面试录不到面试官那一半 | 平台边界，不做。可选方案是引导用户用免提外放，让麦克风间接录到 |
| 静默模式必有常驻通知 | 与产品的「不弹系统通知」相悖 | 平台强制，只能压到最低可见度并让它承担「结束录制」 |
| 手机不适合做长时间面试录制 | 屏幕常亮、耗电、误触 | 产品上应明确建议：面试复盘优先用桌面端；Android 端适合会后补录与查看 |
| 移动端页面沿用桌面端的排版 | 8 个页面是双栏时代的布局，窄屏下只是被令牌层拉直 | 若要更好，需按页重排（工作台磁贴化、报告页卡片化） |
| 平板横屏未做适配 | 仍是单列窄版 | 后续可加断点 |
| `apps/android/_deprecated/` 里留着模板位图 | 无害，但占体积 | 确认新图标在各机型正常后可删 |

---

## 九、侧载到手机

### 产物

```
apps/android/release/AI-Job-Partner-0.2.0-debug.apk        ← 交付用的这份（5.2MB）
apps/android/android/app/build/outputs/apk/debug/app-debug.apk   ← Gradle 的原始输出
```

两份内容相同（md5 一致）。重新构建后要再复制一次：

```bash
cp apps/android/android/app/build/outputs/apk/debug/app-debug.apk \
   apps/android/release/AI-Job-Partner-0.2.0-debug.apk
```

已核验的清单信息：

| 项 | 值 |
| --- | --- |
| 包名 | `com.aijob.partner` |
| 版本 | versionName `0.2.0`，versionCode `2` |
| SDK | minSdk **26**（Android 8.0）/ targetSdk **36** / compileSdk 36 |
| 签名 | Android Debug 证书（可直接侧载） |
| 权限 | INTERNET · RECORD_AUDIO · FOREGROUND_SERVICE · FOREGROUND_SERVICE_MICROPHONE · FOREGROUND_SERVICE_DATA_SYNC · POST_NOTIFICATIONS |
| `allowBackup` | **false**（隐私承诺，见第五节第 5 条） |

### 三种侧载方式

**A. 数据线 + adb（推荐，能看日志）**

```bash
ADB="/d/Program Files/Android/Android Studio SDK/platform-tools/adb.exe"
"$ADB" devices                                    # 手机上要先开开发者选项 + USB 调试
"$ADB" install -r apps/android/release/AI-Job-Partner-0.2.0-debug.apk

# 装完看有没有崩
"$ADB" logcat -c && "$ADB" shell am start -n com.aijob.partner/.MainActivity
"$ADB" logcat | grep -iE "aijob|AndroidRuntime|chromium|Capacitor"
```

**B. 直接把 APK 传到手机**（微信/网盘/U 盘都行），在手机上点开安装。
需要在系统设置里允许「安装未知来源应用」。

**C. Android Studio**

用 `npm run android:open` 打开工程，插上手机后点 Run。

### 装上之后建议先验这几件事

按「最容易出问题 → 最不容易」排序：

1. **能起来吗** —— 桌面出现蓝色的四格方块图标，点开是**蓝色头部 + 大字标题**的 Metro 界面。
   如果闪退，用方式 A 抓 `AndroidRuntime` 的堆栈。
2. **数据存下来了吗** —— 点「载入示例数据，先看效果」，等匹配报告出来后**杀掉 App 再打开**，
   数据应该还在（这验的是原生 SQLite 与 `window.aijob` 桥是否真的接上了；
   如果桥没接上，界面照常能用，但数据会落到 localStorage，且设置页的「运行环境」会显示错）。
3. **设置页的自述对不对** —— 进「设置 → 数据与隐私 → 运行环境」，
   应该显示 `Android 客户端（Capacitor）`、存储是 `Android SQLite`、版本是 `Android 14 + WebView …`。
   **这是判断原生桥有没有生效最直接的一处。**
4. **上传简历** —— 点「我的能力档案 → 导入」，确认系统文件选择器能打开、能选中 PDF/DOCX/TXT。
5. **面试复盘录音** —— 右下角「面试复盘」。会依次要求两个权限：
   - `RECORD_AUDIO`（录音）—— 拒绝的话录制不可用，但手工粘贴转写文本那条路仍然可用；
   - `POST_NOTIFICATIONS`（Android 13+，通知）—— **静默模式依赖它**：
     拒绝的话前台服务仍会启动，但常驻通知不可见，那就变成了「在录音、却没有任何地方能停掉」。
     所以**开静默模式之前先确认这条权限已允许**。
6. **「打开录音目录」** —— 需要真机验证 FileProvider 授权配得对不对。

### 已知会与桌面端不同

侧载前请先读第五节的五条平台差异，特别是前两条：
**静默模式必然显示一条常驻通知**（Android 强制），以及
**录不到面试官那一半声音**（系统内录被平台限制）。这两条不是 bug，是平台边界。
