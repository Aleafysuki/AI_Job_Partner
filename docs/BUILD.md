# 构建与运行

## 环境要求

| 项目 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（实测 22.22.2） | 构建与开发 |
| 操作系统 | Windows 10/11、macOS、Linux | Electron 跨平台 |
| Rust | **不需要** | 本版用 Electron 承载；文档提到的 Tauri 属于后续换壳步骤，不影响核心代码 |

> 关于 Tauri：产品文档第 17 节把 Tauri 定位为「打包壳」。本仓库把全部业务逻辑放在
> `packages/core`，换壳只需要替换 `apps/desktop` 的宿主层，因此当前环境没有 Rust 工具链
> 也不构成阻碍。迁移路径见 `docs/ARCHITECTURE.md`。

## 安装

```bash
npm install
```

在仓库根目录执行即可（npm workspaces 会自动处理 `packages/*` 与 `apps/*`）。

### 如果安装很慢或卡住

`electron` 自身约 110 MB，另加 `electron-builder` 与 `pdfjs-dist`，国内直连 `registry.npmjs.org`
可能只有几十 KB/s。切换镜像后实测可到 260 KB/s 以上：

```bash
# 项目里已提供 .npmrc.example，需要时复制成 .npmrc 即可
cp .npmrc.example .npmrc      # Windows: copy .npmrc.example .npmrc
npm install
```

或者只对这一次安装生效：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm install --registry=https://registry.npmmirror.com
```

> `.npmrc` 是项目级配置，不影响你机器上的其他项目；不想要了直接删掉即可。

### 不想装 Electron 也能验证核心逻辑

`packages/core` 不依赖任何宿主环境，只装 `vitest` 就能跑完整链路测试：

```bash
npm install -D vitest
npm test
```

### 如果报 `esbuild` 的 `spawnSync ... EBUSY`

Windows 上偶发，通常是杀毒软件或文件占用导致 `esbuild` 的安装后校验脚本拿不到进程锁。
跳过脚本安装，再手动补一次 Electron 二进制即可：

```bash
npm install --ignore-scripts

# Windows / macOS / Linux 通用（需要先设置镜像，见上一节）
node node_modules/electron/install.js
```

`esbuild` 的可执行文件随 `@esbuild/win32-x64` 一起解压，跳过它的校验脚本不影响使用。

## 运行桌面端

```bash
npm run dev
```

`electron-vite` 会同时启动渲染进程的开发服务器与 Electron 主进程，改代码即时热更新。

## 打包

```bash
# 构建产物（不打包安装器）
npm run build

# 生成 Windows 安装包（需要 electron-builder）
npm run build:win
```

产物位置：`apps/desktop/out/`（构建输出）、`apps/desktop/release/`（安装器 / 解包目录）。

### 验证打包产物真的能跑

```bash
npm run pack:win                                  # 先出解包产物
AIJOB_EXE="apps/desktop/release/win-unpacked/AI Job Partner.exe" node apps/desktop/scripts/app-smoke.mjs
```

设置 `AIJOB_EXE` 会让冒烟脚本改为驱动**打包后的可执行文件**（而不是源码 + 本地 Electron），
从而验证 asar 内资源、preload、IPC、SQLite 在真实发布形态下同样可用。本机实测 9 项全过。

### 打包配置的两条硬性要求

- `electron` 的 devDependency 必须是**精确版本**（如 `"44.4.5"`，不能写 `^44.4.5`），
  否则 electron-builder 报 `Electron version "^44.4.5" is a range, not a fixed version`；
- `apps/desktop/package.json` 需要 `author` 字段。

### 如果打包报 `safe-delete ... Some operations were aborted`

electron-builder 每次会先删掉已存在的 `release/win-unpacked` 再重新解包。
在启用了「删除保护 / 回收站代理」的环境（部分企业安全软件、受限沙箱）里这一步会被拦，
表现为：

```
⨯ [safe-delete] 操作失败: ... Error during a `trash` operation: Unknown { description: "Some operations were aborted" }
```

两种处理方式，任选其一：

```bash
# 1) 手动把旧产物挪走（先备份，不要直接删）
mv release/win-unpacked release/_backup/win-unpacked-$(date +%H%M%S)
npm run build:win

# 2) 本次换一个输出目录，绕开旧产物
npx electron-builder --win -c.directories.output=release-installer
```

正常桌面环境不会遇到这个问题。

## 运行 Web 版

```bash
npm run web:dev        # 浏览器开发模式
npm run web:build      # 常规静态站点 → apps/desktop/dist-web/
npm run web:single     # 单文件 HTML → apps/desktop/dist-demo/index.html
```

同一份渲染进程代码在浏览器里运行时会自动切换运行时适配：

| 能力 | 桌面端 | Web / 演示模式 |
| --- | --- | --- |
| 数据存储 | SQLite 文件（`userData/data/`） | `localStorage` |
| AI 请求出口 | Electron 主进程（不受 CORS 限制） | 浏览器 fetch（可能被跨域拦截） |
| 文件选择 | 系统文件对话框 | `<input type="file">` |
| 导出 | 系统保存对话框 | 浏览器下载 |

## 类型检查

```bash
npm run typecheck
```

分别检查 `@aijob/core`、宿主层（main/preload）与渲染层，三者的 lib 配置有意不同：
core 不引入 DOM 类型，一旦有人不小心在核心逻辑里调用浏览器 API，这一步就会报错。

## 测试

```bash
npm test
```

79 项断言。以真实感样例数据跑完整链路（简历 → 档案 → JD → 要求 → 匹配 → 报告），并钉住关键规则：

- 只有自我声明、没有产出的能力不能判为「满足」
- 软性要求找不到证据时是「无法判断」而不是「缺口」
- 硬门槛（学历 / 专业 / 年限）不满足时判为缺口
- 证据强度分档口径稳定
- 整体结论只由高重要度要求决定，加分项缺口不会拉低结论
- 隐私脱敏确实发生在分析之前
- v0.1 铁律不会随版本号自动解锁

面试复盘（v0.2 追加）额外钉住：

- 去标识化报告里**不保留任何原文**（只留类型、打码值与命中规则）
- 每条 `finding` 都挂着真实存在的证据编号；没有证据可挂的结论不许写
- 没有当事人档案时 D7 明确写「证据不足」，而不是猜一个分数
- 压力等级只能是四档枚举，信息不足是 `unknown` 而不是 0
- 风险信号命中时必须同时给出正面理解与验证方式
- 导出的 HTML **无任何 http(s) 外链**、内嵌完整 report JSON、关键章节齐全
- 快照迁移（v2 → v3）幂等，且深合并补出新设置子对象
- 删除岗位不会连带删掉面试记录

## UI 端到端冒烟（在真实 Chromium 里点一遍）

```bash
npm run build      # 先出构建产物
npm run smoke:ui   # 渲染层：界面 + 业务链路（含问诊 / 训练 / 面试复盘）
npm run smoke:app  # 桌面端整体：主进程 + preload + IPC + SQLite
```

两个脚本分工不同：

| 脚本 | 覆盖范围 | 说明 |
| --- | --- | --- |
| `smoke:ui` | 渲染层 | 用项目自带 Electron 加载 `out/renderer/index.html`，自动走完「载入示例 → 解析简历 → 拆解岗位 → 匹配 → 校验报告 → 能力问诊（逐题作答 → 结论 → 证据封顶）→ 薄弱项训练（生成计划 → 作答自评 → 进度）→ 面试复盘（导入转写 → 18 维报告 → 校验脱敏生效）」，逐页截图到 `screenshots/`（17 张） |
| `smoke:app` | 桌面端整体 | 启动**真实主进程**（窗口 + preload + IPC + SQLite），通过 Chrome DevTools Protocol 驱动界面，并验证数据真的落盘（含面试会话与复盘报告） |

两者都不需要额外安装 Playwright / Chromium，因此不会引入几百兆的额外下载。

> **录音与内录没有被自动验证。** 冒烟环境没有音频输入设备，
> 而「假装录上了」比「没验证」更糟 —— 所以脚本只覆盖
> 「转写文本 → 复盘报告」这条不依赖硬件的路径。录音需要在一台真有麦克风的机器上人工过一遍。

### `smoke:app` 的退出码与降级

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部通过（`verified: "full"`） |
| `2` | **降级**：环境阻断了跨进程本地回环，CDP 连不上 → 只完成「主进程启动 + 存储落盘」，其余标记为跳过（`verified: "partial"`） |
| `1` | 真实失败（看 `diagnostic`） |

> 退出码 2 **必须当成「未验证」而不是通过**。脚本刻意把它和 0 分开，
> 就是为了避免「步骤为空也算全绿」这类假阴性（`[].every()` 恒为 true，这是验证脚本最容易犯的错）。

`smoke:app` 还做了两件事：

- 用 `--user-data-dir=<临时目录>` 启动，**不污染用户的真实数据**，同时让「SQLite 建库落盘」成为确定性断言点；
- 从子进程日志里解析 DevTools 的 WebSocket 地址，而不是走 `/json/list` HTTP 端点 ——
  后者在配了 HTTP 代理或做了流量拦截的环境里会被接管。

实际输出示例（本机实测，12 项全过）：

```
主进程启动并开放调试端点            ok
主进程初始化本地存储（SQLite 落盘）  ok  ...\data\ai-job-partner.db（12288 bytes）
主进程存活                        ok
渲染进程页面目标可见               ok  file:///.../out/renderer/index.html
preload 原生桥注入                 ok  {isDesktop: true}
IPC appInfo（存储引擎 / 路径）      ok  version 0.2.0 / SQLite
界面挂载                          ok
点击「载入示例数据」                ok
完整链路产出报告                   ok  20 条要求 / 满足 6 / 缺证据 2 / 缺口 3
从存储读回快照                     ok  profiles=1, jobs=1, schemaVersion=3
面试复盘链路产出报告                ok
面试会话与复盘报告已落盘             ok  interviewSessions=1, debriefReports=1, 维度=18
```

> 在无 GPU 的受限环境（容器、部分沙箱）里，两个脚本都已主动关闭硬件加速；
> 正常桌面环境不需要这个处理。

## 调试录音与转写

录音这条链路上有四个地方只有真机能验证，出问题时按这个顺序看：

| 现象 | 先看哪里 |
| --- | --- |
| 点「开始录制」报「权限被拒绝」 | 系统隐私设置里的麦克风开关（Windows：设置 → 隐私和安全性 → 麦克风；macOS：系统设置 → 隐私与安全性 → 麦克风）。主进程 `requestMicrophone()` 会把原因原样返回给界面 |
| 录出来了，但没有转写 | 设置页「开启录音转写」是否打开、接口地址与 Key 是否填了。主进程控制台会打 `[http] POST <host>/audio/transcriptions → 4xx` |
| 线上会议只录到自己 | 内录没开或没拿到。Windows 上 `loopback` 直接可用；macOS 需要先装 BlackHole 之类的虚拟声卡；Linux 需要 PipeWire / PulseAudio 的 monitor 源。拿不到时界面会显示「内录未开启」并降级为只录麦克风 |
| 静默录制后找不到窗口 | 托盘图标（菜单里有「显示应用界面（录制继续）」与「结束本次录制并回到应用」），或按设置里的全局快捷键 |

录音文件在数据目录的 `recordings/<sessionId>/` 下，可以在复盘页点「打开录音目录」直接打开。
界面上的「放弃本次录制」不会物理删除，而是把整个目录移到 `recordings/_discarded/`。

想在不进面试页面的情况下单独试麦克风，可以在设置页把转写关掉、只录音，
录 20 秒后到录音目录里播一下那个 `seg-0001.webm` —— 这一步能把「采集」和「转写」两个问题分开。

## 调试 AI 调用

设置页 →「调用留痕」可以看到每次模型请求的完整 prompt、原始返回、耗时与降级原因。
出网日志也会打到主进程控制台（`[http] POST api.deepseek.com/v1 → 200 (1240ms)`）。
