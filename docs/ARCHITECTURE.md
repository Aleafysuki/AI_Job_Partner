# 架构

## 一句话

> 界面可以换、模型可以换、存储可以换，**只有判断逻辑必须留在中间那一层。**

## 分层

```
apps/desktop/                       ← 宿主层（可替换）
├── src/main/        Electron 主进程：窗口 / 存储 / 出网代理 / 文件系统
│                    + capture.ts：录音落盘 · 系统内录 · 静默模式 · 托盘 · 全局快捷键
├── src/preload/     唯一的 IPC 白名单通道
└── src/renderer/    React + TypeScript + Tailwind 界面
        │
        ├── lib/bridge.ts    运行时适配（桌面 vs 浏览器）
        ├── lib/extract.ts   TXT / PDF / DOCX 文本抽取
        ├── lib/recorder.ts  分段录制 · 多路混音（麦克风 + 系统内录）
        ├── state/store.ts   调度层：只负责调用 core，不含业务判断
        └── pages/ components/ 纯展示

packages/core/                      ← 核心业务层（宿主无关，纯 TypeScript）
├── domain/      核心数据结构（含面试复盘会话与报告）
├── privacy/     PII 识别与脱敏
├── debrief/     面试复盘框架：维度定义 / 清单 / 风险信号 / 转写去标识化
├── nlp/         技能词典 / 归一化 / 问诊题库 / 训练知识要点
├── parsers/     简历段落切分、JD 行级结构
├── ai/          Provider / Transport / Prompt / 留痕 / 语音转写
├── engines/     六条引擎 + 编排 + 能力库合并 + 面试复盘
├── storage/     StoragePort 契约与快照
└── version.ts   版本 → 能力开关
```

`packages/core` 里没有任何 `node:*`、`electron`、`document`、`window`。
`packages/core/tsconfig.json` 的 `lib` 只给 `ES2023`，所以一旦越界，`npm run typecheck` 会直接失败。

### engines 目录（v0.2 后）

| 文件 | 职责 |
| --- | --- |
| `profile-builder.ts` | 简历 → CandidateProfile（规则 + 模型两条路径，统一经 `finalizeProfile` 收尾） |
| `job-analyzer.ts` | JD → JobRequirement |
| `matching-engine.ts` | Requirement → Evidence → Assessment |
| `report-builder.ts` | 匹配结果 → AnalysisReport + `explainWhyNot()` |
| `profile-merge.ts` | **v0.2**：能力库跨岗位合并（技能 / 证据 / 问诊结论的非覆盖式合并） |
| `skill-interview.ts` | **v0.2**：出题、信号计算、等级判定、答案转证据 |
| `training-planner.ts` | **v0.2**：按匹配结果生成训练计划与作答进度 |
| `debrief-engine.ts` | **v0.2 追加**：面试录音转写 → 原子事实 → 18 维 → 适配度 → 决策 |
| `debrief-render.ts` | **v0.2 追加**：复盘报告 → 自包含离线 HTML（原生 SVG 雷达图，不引 CDN） |
| `minimum-candidate.ts` | v0.3 预留 |
| `pipeline.ts` | 编排入口：单步调用与整链路调用 |

## 数据流

```
简历文件 ──extract──▶ 原始文本
                       │
                       ▼
                 redactPII()            ← 隐私在这一步被剥离，之后再也拿不到
                       │
                脱敏文本 + PrivacyReport
                       │
                       ▼
              ProfileBuilder ──▶ CandidateProfile（可编辑）
                       │                  │
JD 文本 ──redactPII──▶ JobAnalyzer ──▶ JobRequirement（可编辑）
                                          │
                                          ▼
                                   MatchingEngine
                             Requirement → Evidence → Assessment
                                          │
                                          ▼
                                    ReportBuilder
                                          │
                                          ▼
                                  AnalysisReport（结构化 JSON）
                                          │
                                          ▼
                                       UI 渲染
```

面试复盘是第二条链路，与主链路不交叉：

```
 microphone ─┐
             ├─▶ 混音 ─▶ MediaRecorder（每 N 秒一段）─▶ 主进程落盘 recordings/<id>/
 系统 loopback ┘                                              │
                                                              ▼
                                              TranscriptionClient（可选，可离线）
                                                              │
                                                              ▼
                                              anonymizeTranscript()   ← 称呼 / 公司名 / PII
                                                              │
                                                              ▼
                                        extractEvidenceByRule() ──▶ E1..En 原子事实
                                                              │
                                                              ▼
                                        D1–D12 机会侧 + P1–P6 表现侧
                                                              │
                                          ┌───────────────────┴───────────────────┐
                                          ▼                                       ▼
                                  InterviewPerformanceSummary          DebriefFitAssessment
                                          │                         （对照 CandidateProfile）
                                          └───────────────────┬───────────────────┘
                                                              ▼
                                    synthesis：三档决策表 + 三种情景 + 唯一下一步
                                                              │
                                                              ▼
                                   InterviewDebriefReport ──▶ UI / 离线 HTML / JSON
```

**两条链路共用的东西**：`redactPII()`（去标识化的兜底规则）、
`HttpTransport`（截图与转写都走主进程出网）、`AiGateway` 的留痕与降级纪律。

## 三条引擎，一个降级链

| 层 | 实现 | 触发条件 |
| --- | --- | --- |
| 1 | 模型（OpenAI 兼容 / Ollama） | 设置里开启远程调用且凭据可用 |
| 2 | 本地规则引擎 | 未开启 / 未配置 / 调用失败 / 返回非法 JSON |
| 3 | 用户手工修正 | 界面上任何解析结果都可以直接改 |

关键点：**降级不是异常路径，而是默认路径。** 没有 API Key 的用户拿到的是完整功能，
只是语义理解弱一些；有 Key 的用户拿到的是「模型负责读懂，规则负责把关」。

## 为什么 AI 请求走主进程

1. 渲染进程是浏览器环境，直连 `api.deepseek.com` 会被 CORS 拦掉；
2. API Key 不应该出现在页面上下文中（虽然 contextIsolation 已经隔离，但少一处暴露面就少一处）；
3. 出网行为集中在一处，便于日志审计、便于将来接企业代理。

对应实现：`ai/types.ts` 里的 `HttpTransport` 接口有两个实现 ——
渲染进程里的 `FetchTransport`（浏览器版）与走 IPC 的 `desktop.http`（桌面版）。

## 为什么证据强度不由模型决定

`computeEvidenceStrength()` 是一个纯函数，只吃「证据类型 + 是否有量化结果 + 是否有链接 + 是否有时间范围 + 描述长度」。
模型只负责「把简历读懂、提取出证据」，**打分留给本地规则**。

理由：模型对「强 / 中 / 弱」的尺度不稳定，同一个项目两次调用可能给出不同强度。
而强度是整套判断的刻度，刻度必须可复现、可解释、可被用户校验。

## 问诊证据为什么封顶为「中」（v0.2）

能力问诊会把用户的回答转成证据，但强度**最高只能到「中」**，且这一限制在
`computeEvidenceStrength()` 与 `finalizeProfile()` 两处都生效。

理由：证据强度衡量的是「这条经历能不能被外部核对」。问诊是自述，没有外部载体。
一旦允许它产出「强」证据，产品就等于自己废掉了 v0.1 立下的判断标准 ——
用户只要把问题答得漂亮，任何技能都会变成「满足」。

设计上留了一条正向出口：补上链接、数字、时间后，系统会自动把它重算成「强」。
所以规则不是堵死，而是「要么给可核对的载体，要么诚实承认这是自述」。

同理还有两条闸门：单次问诊给不出 `expert`（多场景使用无法从一次问答里得到），
用户明确否认做过时等级最高只能到 `aware`（`denial` 信号）。

## 跨岗位保留为什么放在「合并」而不是「独立的能力库」

看似更干净的做法是引入一个独立的 `SkillLedger`，但那样会产生两份可能不一致的状态：
档案里的技能与账本里的技能谁为准？

所以 v0.2 的选择是：**能力库就是主档案，导入默认合并**。
`mergeProfiles()` 按稳定的去重键合并（证据键 = 类型 + 标题 + 内容前缀），
自评等级取更高的一侧，问诊结论按技能保留最新一次，并且返回一份可展示的合并报告 ——
让用户看到「新增了什么、保留了什么」，而不是静默地改掉自己的档案。

去重键刻意的宽松（内容只取前 60 字）是为了让「同一件事换个说法写」也能识别，
代价是可能误合并；这个取舍写在 `docs/ROADMAP.md` 的已知问题里。

## 面试复盘的四条架构取舍（v0.2 追加）

**一、音频字节不进快照。**
`WorkspaceSnapshot` 里只放会话元数据与转写文本，录音按
`recordings/<sessionId>/seg-0001.webm` 落在数据目录下。
一次 40 分钟的 opus 录音有十几兆，塞进 SQLite 的单个 value 会让每次 `persist`
（录一次面试要发生几十次）都变成一次大文件重写。

**二、分段录制，而不是录一整个文件。**
浏览器侧 `MediaRecorder` 的 `start(timeslice)` 只有第一个分片带容器头，
后续分片单独拿去解码会失败 —— 而分片要直接送去做转写。
所以每 20 秒用一个**新的** recorder 重新开始：代价是段间有几十毫秒缝隙，
换来的是「每一段都能独立解码与上传」。

**三、「静默」必须是主进程的能力。**
「面试期间不弹任何提示」拆开是四件事：不弹渲染层的 toast（界面层遵守）、
不弹系统通知、窗口可隐藏且从任务栏移除、以及**用户必须还能停掉录制**。
后三件只有主进程做得到，而第四件如果不做，「不弹提示」就变成了「无法停止」。
所以静默模式下会有托盘图标与全局快捷键两条独立的安全出口 ——
它们的存在理由是「可控」，不是「提示」。

**四、转写与对话模型是两套设置。**
它们要发的东西完全不同：对话发的是**脱敏后的文本**，转写发的是**音频本身**。
共用一个开关意味着「想用模型分析就必须接受上传录音」，这不对。
所以 `AiSettings.transcription` 独立于 `allowRemote`，可以「开文本、关音频」，
完全离线时还有第三条路：手工粘贴转写文本。

## 版本 → 能力开关

`packages/core/src/version.ts` 把产品文档里所有「能不能做 X」编码成一张表：

```ts
{ id: 'interview.generate', since: 'v0.3', docRef: '20' }
{ id: 'restrict.job_crawler', since: 'future', docRef: '25', restriction: true }
```

- 业务代码只调用 `isEnabled('interview.generate')`，没有 `if (version === '0.1')`；
- 提升 `CURRENT_RELEASE` 即完成一次版本更新，路线图内的能力自动解锁；
- 文档第二十五节那批「暂时不做」的条目 `since` 固定为 `future`，**不会**随版本号自动打开，
  必须显式指定解除版本 —— 这正是「v0.1 铁律」在代码里的形态。

## 换壳路径（Electron → Tauri / 移动端）

因为业务逻辑全在 `packages/core`，换壳只需要重写 `apps/desktop`：

| 需求 | 需要改的地方 |
| --- | --- |
| 换 Tauri | 用 Rust 命令替换 `src/main/*.ts` 里的能力：读存储、写存储、发 HTTP、读写文件、**音频分片落盘 + 内录 + 静默模式** |
| 换 Android | 同上，`StoragePort` 换成 SQLite（Android）/ Room，`HttpTransport` 换成 OkHttp |
| 换 Web 后端 | `StoragePort` 换成 REST 客户端；渲染层代码零改动 |

需要重写的只有 `HttpTransport` / `StoragePort` / 文件读写这三个契约的实现，
`packages/core` 一行都不用动。

`recorder.ts` 与 `capture.ts` 的接口是照着「宿主可能要换」设计的：
渲染层只依赖 `CapturePort` / `MediaPort` / `QuietPort` 三个抽象（`lib/bridge.ts`），
浏览器模式下它们退化成「如实声明不支持」的实现 ——
所以同一份界面代码在 Web 上也能跑，只是录音相关的入口会变成一句说明。
面试复盘的**分析部分完全在 `core` 里**，与宿主无关：
换到任何平台，只要能把音频或转写文本喂进 `buildInterviewDebrief()`，报告就是一样的。

## 已知取舍

| 取舍 | 原因 | 后续 |
| --- | --- | --- |
| 本地存储优先 `node:sqlite`，拿不到时退化为 JSON 文件 | 避免原生模块编译，保证「克隆即可运行」 | 加同步服务时把 `StoragePort` 换成远端实现 |
| PDF 只取文字层，不做 OCR | OCR 排在 v0.3 | 接入 OCR 时只需扩展 `lib/extract.ts` |
| 报告导出只给结构化 JSON | 「报告导出」排在 v0.3 | `AnalysisReport` 已经是渲染无关的契约 |
| 渲染进程用自研的极简路由 | 只有一个侧边栏、八个页面，引入 router 得不偿失 | 页面数量上去后换成 react-router |
| 录音分片各自独立，段间有几十毫秒缝隙 | 换取「每段都能独立解码与上传」（见上文第二条取舍） | 需要无缝时改用可拼接的容器（如 WAV），代价是体积 |
| 说话人靠语用特征推断，不做 diarization | 绝大多数 OpenAI 兼容转写接口不返回 speaker；本地分离模型体积与算力代价都不小 | 双声道采集（麦克风 / 内录各占一声道）是更干净的解法 |
| 复盘不做实时输出 | 面试进行中给答案提示属于另一个产品，且会改变这套工具的性质 | 不做 |
| 复盘只做单场 | 横向比较需要另一套数据结构（跨会话聚合） | 后续版本 |
