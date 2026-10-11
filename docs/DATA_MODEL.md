# 数据模型

产品文档第 24 节 Phase 0 指定了六个核心数据结构，实施位置如下：

| 文档命名 | 代码位置 | 说明 |
| --- | --- | --- |
| `CandidateProfile` | `domain/profile.ts` | 候选人档案 |
| `CandidateEvidence` | `domain/evidence.ts` | 证据 |
| `JobRequirement` | `domain/job.ts` | 岗位要求集合 |
| `RequirementItem` | `domain/job.ts` | 单条要求 |
| `MatchResult` / `RequirementMatch` | `domain/match.ts` | 匹配结果 |
| `AnalysisReport` | `domain/report.ts` | 聚合报告 |

另外新增了文档没点名、但实现必需的契约：
`domain/privacy.ts`（隐私报告）、`domain/ai-trace.ts`（AI 调用留痕）、`storage/index.ts`（存储契约）。
v0.2 又新增了两组：`domain/interview.ts`（问诊会话与结论）、`domain/training.ts`（训练计划与题目），
详见本文末尾的「v0.2 新增结构」。

v0.2 追加的「面试复盘」在 `domain/debrief.ts`（录音会话 + 复盘报告）与 `debrief/dimensions.ts`
（机会侧 D1–D12 + 表现侧 P1–P6 的框架定义），见本文末尾的「面试复盘」一节。

---

## 核心链路

```
Requirement ──┬──▶ Evidence ──▶ Strength ──▶ Assessment ──▶ Action
              │
              └── hardGate? ──▶ 走独立规则，模型无权放宽
```

---

## CandidateEvidence

整个系统最重要的结构。

```ts
{
  id: 'evd_xxx',
  kind: 'project' | 'work' | 'education' | 'certificate' | 'competition'
      | 'open_source' | 'metric' | 'self_claim' | 'other',
  title: 'AI Job Partner 求职分析工具',
  content: '设计并实现 Requirement → Evidence → Assessment 的匹配链路……',
  skills: ['TypeScript', 'React', 'Electron'],
  metrics: ['3 个内测群共 120 人'],
  links: ['https://github.com/example/ojp'],
  timeRange: '2024.04 ~ 至今',
  strength: 'strong',
  strengthReason: '属于项目/工作经历类证据；包含 1 项量化结果；提供可访问的链接……',
  sourceRef: { kind: 'resume', locator: '项目经历 · AI Job Partner', excerpt: '…' },
  editedByUser: false
}
```

### 强度计算（纯函数，不交给模型）

| 条件 | 分值 |
| --- | --- |
| `kind` 为 project / work | +2 |
| `kind` 为 open_source / competition / certificate | +2 |
| `kind` 为 education / metric | +1 |
| 有量化结果 | +1 |
| 有链接 | +1 |
| 有时间范围 | +1 |
| 描述不足 24 字 | −1 |
| `kind` 为 self_claim | 强制 weak，直接返回 |

分档：`score ≥ 4 → strong`，`≥ 3 → medium`，`≥ 1 → weak`，否则 `none`。

### 来源渠道对强度的封顶（v0.2）

| origin | 含义 | 允许的最高强度 |
| --- | --- | --- |
| `resume` | 简历解析 | strong |
| `manual` | 用户手工补录 | strong |
| `import` | 外部导入 | strong |
| `qa` | **能力问诊补充** | **medium** |

问诊是自述，没有外部可核对物，因此规则上封顶为「中」。
`capStrengthByOrigin()` 是唯一实现，`computeEvidenceStrength()` 与 `finalizeProfile()` 都必须走它 ——
否则每次归一化都会把封顶悄悄绕过去。想升级到「强」，只能补链接、数字、时间这类可核对载体。

`strong` 的口径是「类型 + 量化结果 + 时间范围」三者齐备 —— 能说清「什么时候做的、做出了什么数字」
的经历才算真正立得住；只有类型和量化结果的算 `medium`。
这个刻度刻意做得保守：宁可把证据判低，也不要让用户在面试追问里翻车。

用户手动把 `editedByUser` 置为 `true` 后，系统不再覆盖这条证据的强度。

---

## CandidateProfile

```ts
{
  id, schemaVersion, createdAt, updatedAt,
  basics: { displayName, targetRoles[], yearsOfExperience, educationLevel, location },
  summary,
  education: EducationItem[],
  experiences: WorkExperience[],
  projects: ProjectItem[],
  skills: SkillItem[],
  selfDescriptions: string[],
  evidence: CandidateEvidence[],
  provenSkills: string[],     // 推导字段
  unprovenSkills: string[],   // 推导字段
  learningSkills: string[],   // 推导字段
  interviewHistory: [],       // v0.3 预留
  rawText,                    // 脱敏后的原文
  privacy: PrivacyReport,
  parsedBy: 'ai' | 'rule'
}
```

三个推导字段的规则（`finalizeProfile()`）：

| 字段 | 条件 |
| --- | --- |
| `provenSkills` | 关联证据中存在 project / work / open_source / competition 类，且最大强度 ≥ medium |
| `learningSkills` | 自评等级为「了解」且不满足 `provenSkills` |
| `unprovenSkills` | 其余 —— 即「声明了但拿不出证据」 |

`basics.displayName` **不是**简历里的真实姓名，而是用户自己起的档案标签。
真实姓名在脱敏阶段就被替换为 `[姓名]`，系统里任何地方都不保存它。

---

## RequirementItem

```ts
{
  id, index: 3,
  content: '有 RAG 实际项目经验，了解向量数据库的使用与调优',
  original: '有 RAG 实际项目经验，了解向量数据库（FAISS / Milvus 任一）的使用与调优；',
  type: 'tech',
  importance: 'high',
  hardGate: false,
  keywords: ['RAG 检索增强', '向量数据库'],
  evidenceNeeded: 'project',
  sourceRef: { kind: 'jd', locator: '岗位原文第 12 行', excerpt: '…' },
  confidence: 'high',
  editedByUser: false
}
```

- `type` 九类，对应文档第 6 节那张树；
- `hardGate` 命中即 **不可被软性描述绕过**，匹配时走独立规则；
- `confidence` 为 low 时，匹配结论更容易落到「无法判断」。

---

## RequirementMatch

```ts
{
  requirementId, content, type, importance, hardGate,
  evidence: [{ evidenceId, kind, title, content, strength, linkReason }],
  matchedSkills[], missingSkills[],
  assessment: 'matched' | 'partial' | 'lacking_evidence' | 'gap' | 'unknown',
  confidence,
  reason: '存在直接证据：AI Job Partner 求职分析工具（证据强度中）',
  action: '这条已经站得住。面试时准备好被追问细节即可',
  explain: [
    { rule: '要求解析', detail: '类型 tech，重要度 high；识别出的能力：RAG 检索增强' },
    { rule: '证据检索', detail: '命中 1 条证据：AI Job Partner（project·medium）' },
    { rule: '能力覆盖', detail: '已覆盖：RAG 检索增强' },
    { rule: '判定规则', detail: '存在项目/工作类证据且强度达到 medium 以上，能力覆盖度达标' }
  ]
}
```

### 五种结论的判定规则

| 结论 | 条件 |
| --- | --- |
| `matched` 满足 | 有 project/work/open_source/competition 类证据，最大强度 ≥ medium，且能力覆盖度 ≥ 60% |
| `partial` 部分满足 | 有真实证据，但覆盖度不足或强度偏弱 |
| `lacking_evidence` 缺少证据 | 只命中 self_claim 类证据（说过，但没有产出） |
| `gap` 明显缺口 | 完全找不到相关证据 |
| `unknown` 无法判断 | 要求过短/表述模糊、关键词识别失败、关键信息被脱敏 |

### 硬门槛的独立规则

| 类型 | 判定方式 |
| --- | --- |
| 学历 | 比较学历层级（博士 4 / 硕士 3 / 本科 2 / 大专 1），低于要求 → `gap` |
| 专业 | 与档案专业比对；档案没写专业 → `lacking_evidence` |
| 年限 | 优先取用户填写的年限，否则由工作经历时间范围累加 |
| 证书类 | 必须命中 certificate 证据；仅靠声明一律 `lacking_evidence` |

模型给出的 `matched` 在硬门槛上会被强制降级 —— `MatchingEngine` 里有一行显式拦截。

---

## AnalysisReport

给 UI 与导出用的聚合产物，**渲染无关**：

```ts
{
  headline: '你的证据能支撑大部分要求，但还有几处需要补强（部分满足：满足 5 / 部分满足 3 / …）',
  verdict: 'partial',
  profile: { id, displayName, skillCount, evidenceCount, strongEvidenceCount },
  job: { id, title, company, requirementCount, hardGateCount },
  summary: MatchSummary,
  matches: RequirementMatch[],
  priorities: PriorityAction[]{ title, why, how, requirementIds, effort },
  riskNotes: string[],
  minimumCandidate?: MinimumCandidateModel,   // v0.2 预留
  engine, usedModel, disclaimer
}
```

刻意**没有总分字段**。文档第二节明确反对「匹配度 82 分」这种表述：
`verdict` 只能是五个离散值之一，`summary` 是五个计数。

`explainWhyNot()` 把 `matches` 翻译成人类语言，回答文档第 23 节要求的那句
「我为什么不匹配」，且不引入任何新判断。

---

## WorkspaceSnapshot（本地存储单元）

```ts
{
  schemaVersion: 4,          // v0.6：3 → 4（新增 assessSessions / assessResults / staleMarks）
  savedAt, release,
  profiles: CandidateProfile[],
  jobs: JobRequirement[],
  reports: AnalysisReport[],
  trainingPlans: TrainingPlan[],               // v0.2 新增
  interviewSessions: InterviewDebriefSession[],// v0.2 追加
  debriefReports: InterviewDebriefReport[],    // v0.2 追加
  assessSessions: StoredAssessSession[],       // v0.6 新增：进行中/未完成的问诊
  assessResults: StoredAssessResult[],         // v0.6 新增：历史问诊结论（不含 updatedProfile）
  staleMarks: StaleMark[],                // v0.6 新增：用户自己标的「想重答」
  traces: AiTrace[],         // 最多保留 120 条
  settings: AiSettings,      // v0.2 追加 transcription / capture 两组子配置
  settings.review?: ReviewPreferences,   // v0.6：三个决策点的用户选择
  ui: { activeProfileId, activeJobId, onboardingCompleted, dismissedHints }
}
```

**为什么问诊会话必须进快照。** 在 v0.6 之前它只活在内存里 ——
用户答了十几分钟，关掉窗口就全没了。底层存储是单表单key 的 JSON 大字段
（`main/storage.ts:130`），所以这不是「忘了存」，而是**结构上就存不了**：
不在 `WorkspaceSnapshot` 里就没有任何机会被写下去。

`StoredAssessResult` 不存 `updatedProfile`：一份归一化后的档案可能有几百 KB，
而问诊历史只需要「结论 + 当时的等级」，before/after 对比靠 `AssessmentSnapshot` 就够。

`settings.review` 走**深合并**，与 `settings.transcription` / `settings.capture` 同一个理由：
顶层展开对新增的子对象无效。

**音频不进快照。** `InterviewDebriefSession` 里只有元数据与转写文本；
录音按 `recordings/<sessionId>/seg-0001.webm` 落在数据目录下。
一次 40 分钟的 opus 录音有十几兆，塞进 JSON/SQLite 的单个 value 会让每次 `persist` 都变成大文件重写。

`migrateSnapshot()` 是唯一的结构迁移入口：

| 版本 | 变化 | 迁移动作 |
| --- | --- | --- |
| 1 → 2 | snapshot 新增 `trainingPlans` | 缺失时补 `[]` |
| 1 → 2 | profile 新增 `assessments` / `interviewHistory` | 缺失时补 `[]` |
| 1 → 2 | evidence 新增 `origin` | 老数据一律补 `'resume'`（否则封顶规则会漏判） |
| 2 → 3 | snapshot 新增 `interviewSessions` / `debriefReports` | 缺失时补 `[]`；会话缺 `quiet` / `segments` / `turns` 时补默认值 |
| 2 → 3 | settings 新增 `transcription` / `capture` | **深合并**：顶层展开补不上嵌套对象 |
| 3 → 4 | snapshot 新增 `assessSessions` / `assessResults` / `staleMarks` | 缺失时补 `[]` |
| 3 → 4 | `AssessSession` 新增 `draft` / `replacedQuestions` | 缺失时补 `undefined` / `[]` |
| 3 → 4 | settings 新增 `review` | **深合并**，同上 |

最后一条容易踩：`{ ...empty.settings, ...data.settings }` 这种浅合并对新增的**子对象**是无效的，
老快照会得到一个 `undefined` 的 `settings.transcription`。所以设置统一走 `normalizeAiSettings()`。

迁移必须是幂等的：重复执行结果不变（有单测覆盖）。

---

## 透明性相关的结构

| 结构 | 用途 |
| --- | --- |
| `PrivacyReport.findings[]` | 用户能看到「哪些字段被拿掉了、替换成了什么、依据哪条规则」 |
| `AiTrace.sentMessages[]` | 用户能看到模型实际收到的完整 Prompt |
| `AiTrace.usedFallback / fallbackReason` | 用户能知道这次结论是模型给的还是规则给的 |
| `evidence.sourceRef` | 每条证据都能回查简历原文 |
| `match.explain[]` | 每条结论都能展开看到判定链 |

---

# v0.2 新增结构

## AssessSession（一次问答过程）

```ts
{
  id, profileId, skillName,
  jobId?, jobTitle?,              // 这次问诊是在分析哪个岗位时发起的
  questions: AssessQuestion[],    // 五层递进：自评 / 具体场景 / 使用深度 / 产出结果 / 认知边界
  answers: AssessAnswer[],
  status: 'draft' | 'completed',
  startedAt, completedAt?
}
```

`AssessQuestion.critical` 标记的是「决定能否产出证据」的关键题（具体场景题与产出题）。
会话本身只存在内存里（界面持有），收尾评估后其结论进入档案。

## SkillAssessment（问诊结论）

```ts
{
  id, profileId, skillName, skillCategory,
  jobId?, jobTitle?, sessionId,
  level: 'unverified' | 'aware' | 'practiced' | 'applied' | 'delivered' | 'expert',
  confidence: 'high' | 'medium' | 'low',
  signals: {
    specificity, depth, output, selfAwareness,   // 0-3 / 0-1，全部由规则算出
    selfReport,                                   // 自评换算 0-4
    denial                                        // 是否明确否认做过
  },
  summary, strengths[], gaps[], uncertainties[],
  producedEvidenceIds[],   // 由这次问诊产出的证据
  recommendedAction, learnNext[],
  createdAt, engine
}
```

放在 `CandidateProfile.assessments` 里，**不绑岗位** —— 这是「换岗位不丢积累」的关键。

### 等级判定（`levelFromSignals()`）

| 等级 | 条件 |
| --- | --- |
| `unverified` | 明确否认做过且自评 0；或完全没有可用信息 |
| `aware` | 只能复述概念，说不出自己用过的场景（或明确否认但自评 ≥ 1） |
| `practiced` | 说得出场景，但自评 ≤ 2 且讲不出取舍 |
| `applied` | 说得出场景与做法，但没有结果 |
| `delivered` | 做法 + 结果齐备 |
| `expert` | 做法 + 结果 + 取舍判断 |

两条额外闸门：

1. `denial ≥ 1` → 最高只能到 `aware`（用户自己说没做过，不能被场景词抬上去）。
2. `expert` 需要能力库里已有该技能的非问诊类证据，否则降为 `delivered`（单次问答给不出「多场景」）。

### 信号口径（`computeSignals()`）

- `specificity`：**出现场景词 +2**（项目 / 公司 / 团队 / 工具 / 上线 …）、含数字 +1、长度 ≥ 20 +1。
  复述概念无论多长都拿不到 2 分 —— 这是「说清了场景」的硬门槛。
- `depth`：出现踩坑/调优/权衡类词 +2，含因果词 +1，长度 ≥ 20 +1。
- `output`：量化结果 +1、链接 +1、交付物词 +1；都没有但说了结果 +1。
- `selfAwareness`：边界题有实质内容且不是「都懂」这类敷衍。
- `denial`：命中「没用过 / 没做过 / 尚未上手」这类明确否认。

## 问诊 → 证据（`deriveEvidenceFromSession()`）

产出证据的两个必要条件，任一不满足就返回 `null` 并说明原因：

1. 说清了具体场景（出现场景词）
2. 提到了自己实际做过的事（做过 / 用过 / 负责 / 实现过 …）

判定得到的 `kind`：出现公司 / 团队 / 客户类语境 → `work`，否则 → `project`。
产出证据的 `origin` 固定为 `qa`，`fromJobTitle` 记录当时的岗位。

## TrainingPlan / TrainingItem

```ts
TrainingPlan {
  id, schemaVersion, profileId, jobId, jobTitle,
  createdAt, updatedAt,
  items: TrainingItem[],
  stats: { total, todo, answered, reviewed, averageScore },
  source: { gap, lacking_evidence, partial },   // 计划里各类薄弱项的条数
  engine, suggestedNextStep
}

TrainingItem {
  id,
  type: 'concept' | 'explain' | 'compare' | 'scenario' | 'self_check',
  skillName, skillCategory,       // 'unknown' 表示没识别出具体技能
  weakness: 'gap' | 'lacking_evidence' | 'partial',
  requirementId?, requirementText?, importance,
  question, referencePoints[], followUp?,
  userAnswer?, selfScore?: 0|1|2|3,
  status: 'todo' | 'answered' | 'reviewed', updatedAt
}
```

题目类型由**薄弱原因**决定，而不是由技能决定：

| 薄弱原因 | 出题类型 | 为什么 |
| --- | --- | --- |
| `gap` | `concept` | 连经历痕迹都没有，先确认是否理解它解决什么问题 |
| `lacking_evidence` | `explain` | 说过但拿不出产出，练「把做法讲成 90 秒能说完的话」 |
| `partial` | `compare` | 沾边但不够，练面试官最爱追的取舍层 |
| 软技能类要求 | `self_check` | 准备一个真实例子 |
| 未识别出具体技能 | `self_check` | 用「怎么把这段经历讲清楚」的通用要点，不硬套某个技能品类 |

候选筛选规则 `trainingCandidates()` 由引擎与界面**共用同一份实现**，
避免出现「统计说 7 条、实际只出 3 题」的口径不一致。排除条件：已经满足 / 无法判断的要求，
以及重要度为「低」的加分项。

---

# 面试复盘（v0.2 追加）

实现位置：`domain/debrief.ts`（结构）、`debrief/dimensions.ts`（框架常量）、
`debrief/anonymize.ts`（去标识化）、`engines/debrief-engine.ts`（分析）、
`engines/debrief-render.ts`（离线 HTML）、`ai/transcription.ts`（转写客户端）。

分析框架整体移植自 `multi-dimension-fit-report`（框架规范留档在 `docs/debrief/`），
并针对「真实面试」新增了表现侧 P1–P6。跨层约定：报告结构字段只增不删，删字段必须升 `schemaVersion`。

## 链路

```
录音分片（麦克风 [+ 系统内录]）
  → 转写（OpenAI 兼容 /audio/transcriptions，可选）
  → 去标识化（称呼 / 公司名 / PII）
  → 原子事实 evidence[]        —— 一句一事实，带数字的原样保留
  → 机会侧 D1–D12 + 表现侧 P1–P6
  → 表现总评 + 岗位适配度评定
  → 综合（三档决策表 + 三种情景 + 唯一一个下一步动作）
```

## InterviewDebriefSession

```ts
{
  id, schemaVersion, profileId, jobId?, jobTitle?,
  mode: 'onsite' | 'online',
  sources: { mic: boolean; system: boolean },
  quiet: boolean,               // 静默录制：面试期间不产生任何界面提示
  status: 'recording' | 'paused' | 'transcribing' | 'ready' | 'analyzed' | 'failed',
  startedAt, endedAt?, durationMs,
  segments: CaptureSegment[],   // 音频分片元数据（字节本身在磁盘上）
  turns: TranscriptTurn[],      // 转写结果，带时间轴与说话人
  manualTranscript?,            // 无 ASR 时的降级路径：直接粘贴
  notes, transcribeError?
}
```

`CaptureSegment.index` 决定文件名 `seg-0001.webm`。
分片时长默认 20 秒 —— 浏览器侧 `MediaRecorder` 只有第一个分片带容器头，
后续分片单独解码会失败，所以每段用独立的 recorder 重新开始。

`TranscriptTurn.speaker` 在单声道录音里是**推断**出来的（提问/作答的语用特征），
不保证准确，界面必须允许人工核对 —— 标错会直接污染表现侧评分。

## 报告结构（InterviewDebriefReport）

```ts
{
  id, schemaVersion, createdAt, domain: 'interview-debrief',
  sessionId, profileId, jobId?, jobTitle?,
  meta: {
    title, mode, sources, quiet, durationMs,
    anonymized, confidence: 'high'|'medium'|'low',
    transcriptChars, speakers[], completeness: 'full'|'partial'|'fragment',
    limitations[], engine: 'rule'|'ai'|'hybrid'
  },
  evidence: DebriefEvidence[],           // 原子事实，编号 E1..En 连续
  dimensions: DebriefDimension[],        // 18 个：D1–D12 + P1–P6
  performance: InterviewPerformanceSummary,
  fit: DebriefFitAssessment,
  charts: { pressure[], fit[], performance[], workloadTime, compensation },
  synthesis: {
    oneLine, tier: 'consider'|'caution'|'mismatch'|'insufficient',
    verdictParagraph, highlights[], scenarios[3], decisionTable[3],
    nextAction, boundaryStatement
  },
  questions: DebriefQuestion[],
  disclaimer
}
```

## 维度定义

机会侧（回答「这个岗位实际是什么样」）：

| id | 名称 | 判据 |
| --- | --- | --- |
| D1 | 实态还原 | 用外行能懂的话还原真实工作链路，不复述招聘话术 |
| D2 | 要求拆解 | 14 项硬性要求逐项填「满足/不满足/未知」+ 10 项隐性要求强度 1–5 |
| D3 | 工作量测算 | 数量 × 单位耗时 → 纯处理时间与剩余时间；必须给算式 |
| D4 | 压力画像 | 9 类压力逐项定级 low / medium / high / unknown |
| D5 | 名义 vs 实际口径 | 指出「做了 N 个」与「达成 N 个」的强度差 |
| D6 | 工作类型判定 | 按实际流程分类，不看岗位名称 |
| D7 | 个体适配 | 10 个适配维度逐个 1–5 分或 null，不给总分 |
| D8 | 持续性推演 | 第一天 / 第一周 / 第一个月，区分「能做」与「能持续做」 |
| D9 | 话术风险扫描 | 命中即收录，每条必须给正面理解 + 反面理解 + 验证方式 |
| D10 | 实际回报测算 | 单位时间回报 = 实发月收入 ÷（月工作天数 × 每日净工时），三情景 |
| D11 | 待确认问题 | 按五类分组，可直接复制发送 |
| D12 | 情景与决策 | 三种情景 + 三档决策表，条件只能来自 D1–D10 |

表现侧（回答「我这次答得怎么样」）：

| id | 名称 | 判据 |
| --- | --- | --- |
| P1 | 回答结构 | 有显式结构标记（首先/其次/结论是）的回答占比 |
| P2 | 事实密度 | 含数字 / 时间 / 动作 / 交付物的回答占比 |
| P3 | 岗位对齐度 | 岗位要求的关键词在回答里的覆盖率（无岗位时置 insufficient_info） |
| P4 | 深度与取舍 | 讲到「为什么这么做」「还考虑过别的做法」的占比 |
| P5 | 认知边界 | 明确承认不会 = 加分；含糊绕开 = 减分 |
| P6 | 交互与信息获取 | 是否答到点上、是否主动提问 |

表现侧刻意**不评价**音色、语速、口音、自信程度与情绪表现 —— 这些无法复核，
写进报告只会让人拿去做无效对比。**承认「这块我不熟」在 P5 里是加分项，不是减分项。**

## 不可让步的规则

1. **`findings[].evidenceIds` 不得为空。** 没有证据可挂的结论一律不许写（有单测覆盖）。
   模型输出的引用编号必须先在本地校验存在性，编造的一律丢弃。
2. **证据编号只能由本地重排。** 模型返回的编号常跳号或重号，而下游全靠它做引用。
3. **证据不足写 `insufficient_info`**，把缺什么写进 `unknowns`。禁止用「一般来说」「行业惯例」补全，
   禁止用均值填充评分。雷达图里 `null` 必须留 `null`，不能用 0 伪造出一个突刺。
4. **数字不换算不取整。** 带数字的 quote 原样保留；需要换算时把依据写进 `computation.inputs`
   （例如单件耗时给的是假设值，就必须在 inputs 里标注「假设值」）。
5. **压力等级只能是 `low` / `medium` / `high` / `unknown`**，且不得留空。
6. **概率只用定性档位**（极低 / 较低 / 中等 / 较高 / 很高），不允许出现百分比。
7. **不做价值判断。** 不出现「建议去 / 别去」「应该」「值得」这类取向性表述；
   唯一下一步动作是「今天做什么」，不是「再考虑考虑」。
8. **规则是主体，模型是增强。** 每一阶段先算一份确定性结果，模型可用时覆盖对应字段；
   模型不可用时整条链路照常产出报告（`engine: 'rule'`）。

## 去标识化（`debrief/anonymize.ts`）

转写文本里没有「姓名:」这种标签，身份信息是随口说出来的，所以顺序是：

1. 机构名 → `A 公司` / `B 公司`（强后缀表，刻意不收「科技 / 网络 / 软件」这类弱后缀，
   否则「我们是做人工智能网络的」会被误伤）
2. 称呼 → `面试官`（张经理 / 李总监 / 王老师，以及「李总」这种单字后缀）
3. 兜底走 `redactPII()`：电话 / 邮箱 / 身份证 / 银行卡 / 地址 / 社交账号

**返回的 `AnonymizeReport` 里不保留任何原文。** 它只带类型、打码值与命中的规则 ——
这份报告会跟着复盘结果一起落盘、展示、导出，如果嵌了原始值，
等于把刚拿掉的东西又写进了另一份文件。（有单测覆盖这一点。）

数字不改：时长、薪酬、指标数量是判断依据，模糊化它们等于废掉报告。

## 渲染约束（`engines/debrief-render.ts`）

| 约束 | 原因 |
| --- | --- |
| 单文件 HTML，CSS 内联 | 复盘内容比简历更敏感，不该因为打开一份报告而发起任何网络请求 |
| 雷达图用原生 SVG 手绘 | 不允许 CDN，断网也要能开 |
| 完整 report JSON 内嵌在 `<script type="application/json" id="report-data">` | App 可以重新读回页面里的数据 |
| 渲染阶段不新增结论 | 所有文字都来自 report 对象 |
| 纯函数、无副作用 | 不写文件、不发请求、不改入参 |

## 与 `multi-dimension-fit-report` 的对应

| 该 Skill 的资产 | 本项目落点 |
| --- | --- |
| `references/dimensions.json` | `debrief/dimensions.ts`（转成 TS 常量，并补了规则引擎用的命中词） |
| `references/framework.md` | `docs/debrief/framework.md`（原文留档） |
| `references/prompts/stage{1,2,3}` | `ai/prompts.ts` 的三个 `DEBRIEF_*_SYSTEM_PROMPT` |
| `schemas/report.schema.json` | `domain/debrief.ts` 的 `InterviewDebriefReport` |
| `scripts/build_report.py` + `assets/report-template.html` | `engines/debrief-render.ts`（用 TS 实现，不引入 Python 依赖） |
| `scripts/validate_report.py` | 校验逻辑内建在引擎里（编号校验 / 枚举校验 / 空引用丢弃），并有单测覆盖 |

**变更纪律**：改维度时必须同步三处 —— `debrief/dimensions.ts`（机器可读）、
`docs/debrief/framework.md`（规范）、本文件的维度表，以及对应的单测断言。


---

# v0.3 可用性修正（用户实测反馈后）

这一批改的全是**判断规则与交互结构**，因此按项目约定登记在此。
来源是用户在 Android 端实际使用 v0.2 后的反馈，不是新增需求。

## 1. 能力问诊：按能力形状分流（`nlp/ask-planner.ts`）

原实现的题面来自 `skill-questions.ts` 的固定五层模板（self_report → fact → depth → output → boundary），
无论什么能力，第一层一律问「你有多熟练」。

**问题**：对「人际交往」这类能力，问「属于了解、熟悉还是熟练」只能得到自我感觉。
用户答「熟练」，系统并未多知道任何事实；用户答「了解」，系统也无法判断真假。

**新规则**：

| 能力形状 | 判定依据 | 层结构 | 自评题 |
| --- | --- | --- | --- |
| `technical` 技术 | SkillKind 非 soft/domain/certificate | 5 层 | 有（通用阶梯） |
| `behavioral` 行为 | `kind=soft` 或名称含沟通/协作/抗压等 | 4 层（无 self_report） | **无** |
| `credential` 资质 | `kind=certificate` | 3 层 | **无** |
| `domain` 领域 | `kind=domain` | 4 层 | **无** |

**硬约束（有单测钉住）**：

1. `behavioral` 永远不出 `self_report` 题 —— 即使模型强行给，也在
   `mergeAiQuestions()` 里被丢弃并记一条提示。
2. 层数与顺序由本地规格决定，模型只能改题面（`prompt` / `hint`），不能增删层。
3. 模型返回的题过短（<6 字）或过长（>120 字）一律丢弃，用本地题兜底。
4. 模型完全不可用时，本地题一条不少 —— 没有模型也能完整走完问诊。

## 2. `AssessmentSignals` 新增 `selfReportAsked`

`levelFromSignals()` 里有一条「自评不高且讲不出取舍 → 跟做过」的分支。
软技能不出自评题，若把「没问」当成「自评 = 0」，用户会被凭空压低一档。

因此必须能区分「没问自评」与「答了最低档」。这是 `selfReportAsked` 存在的唯一理由。

## 3. 跳过的两种语义（`AssessAnswer.skipReason`）

| 值 | 含义 | 对 `denial` 信号 | 后果 |
| --- | --- | --- | --- |
| `not_done` | 用户明确说没做过 | 记 1 | 等级最高 `aware` |
| `cant_recall` | 只是想不起来 | 不记 | 不影响等级判定 |

原实现只有一个 `skipped: true`，两种语义混在一起。误判成「没做过」会让认真做过的事
被判成「只是了解概念」，这个错误代价很高，所以 UI 上拆成两个按钮。

**另一条修正**：跳过的题如果带了文本（例如用户写「没用过，我压根没接触」），
该文本**必须参与否认判定**。原实现把 skipped 题的文本整个丢掉，导致明确否认被漏判。

## 4. 候选回答（`AssessQuestion.suggestions`）

从档案已有证据里抽候选，用户点一下即采纳。

**三条不可越过的线**：

1. 只截取原句并做轻量拼接，**不改写事实、不新增内容** ——
   一旦系统开始替用户编，用户就再也分不清哪句是自己说的。
2. `behavioral` 形状的候选若缺动作词，补的是**提示**（「请补一句：你具体做了什么动作」），
   不是硬编一个动作。
3. 只挂到 `fact` 与 `output` 层（产出证据的必要条件），不挂 `depth` / `boundary` ——
   深度和边界只能用户自己想。

## 5. 训练参考答案（`TrainingItem.referenceAnswer`）

与 `referencePoints` 是两个不同的东西：

| 字段 | 时机 | 内容 |
| --- | --- | --- |
| `referencePoints` | 答之前 | 要覆盖哪几块（要点清单） |
| `referenceAnswer` | 答之后 | 一段可直接读的示例答复（看结构） |

**本地模板的硬约束**：每句都带占位符，绝不写具体数字、公司名、项目名。

**模型生成时的过滤**（`isSafeReferenceAnswer()`）：出现第一人称完成态
（「我负责了」「我上线了」）或具体数字且无免责标记 → 丢弃并改用本地模板。
理由：模型很容易顺手写出一句具体经历，那不是参考答案，那是替用户虚构简历。

## 6. 模型用量与费用（`domain/usage.ts`）

| 口径 | 规则 |
| --- | --- |
| token 优先用接口返回的 `usage`；没有则本地估算，`estimated = true` |
| 费用 = `输入 token × 输入单价 + 输出 token × 输出单价` |
| **降级调用（`usedFallback`）费用恒为 0** | 请求没发出去就没有账单 |
| 本地 Ollama / 本地规则引擎不计费，但 token 数照样记录 | 消耗的是用户的算力与时间 |
| 精确费用与估算费用分开统计，不混成一个数 | 混算会得到「看起来精确、实际不可信」的总数 |

**本应用查不到账户余额。** API Key 由用户自己填写，服务商后台的余额、账单、套餐都不在本机。
界面必须如实说明这一点，不能显示任何声称是「余额」的数字。

单价存的是 token 数（事实），费用在读取时按当前单价重算（推导）——
这样改了单价历史费用会一起变，不会出现新旧口径混在一张表里。

## 7. JD 原文回看（`job.show_raw_text`）

`JobRequirement.rawText` 一直保存着脱敏后的 JD 全文，v0.2 只是没在界面上展示。
现在支持展开查看、复制，以及从任意一条要求跳回原文对应片段高亮。

**渲染注意**：高亮用「切成三段纯文本 + `<mark>`」实现，不用 `dangerouslySetInnerHTML` ——
原文可能含 `<`、`&`，拼字符串有注入面。

## 8. 档案批量增删（`profile.bulk_edit`）

- 批量粘贴导入：按 `[\n、,，;；|]` 切分，逐项走 `resolveSkill()` 归一化
  （「React.js」会并到「React」，否则档案里会同时出现两条同一个技能）
- 已存在的项不重复添加，只补别名
- 多选批量删除：会同时删掉只关联被删技能的证据，并明确告知删了几条

## 9. 常驻「下一步」引导（`ui.next_step`）

`nextStepFor(snapshot, route)` 按「阻塞程度」算出唯一下一步，桌面端与移动端共用同一份实现。

`level = 'done'` 时**不显示**引导条 —— 一直给「建议做 X」会让用户觉得这个产品在不停推销功能。

## 变更纪律（重申）

本批改动涉及多条判断规则，已同步：
`packages/core/src/nlp/ask-planner.ts`（机器可读的实现）、
本文件的规则表、`tests/v03-ux-rules.test.ts`（37 条断言）。
改这批规则时三处必须一起改。

**特别注意**：`CURRENT_RELEASE` 仍为 `v0.2`。这批修正的 `since` 一律写 `v0.2`，
**不能**为开修复项而提升 `CURRENT_RELEASE` —— v0.3 的槽位留给路线图里的
岗位 OCR / 简历建议 / 报告导出四项，提升版本号会连带解锁它们。已有单测钉住这一点。

---

# v0.4：降低问答负担 / 面试问答推荐 / 等级收敛与导航分级

用户实测反馈三条：问答仍然太繁重、想做面试官问答推荐、多个层级关系乱。

## 1. 能力层级：五套刻度收敛到一条主线（`domain/levels.ts`）

**问题**：系统里原本有五套等级刻度、19 个档位标签，交叉出现在界面上：

| 刻度 | 档数 | 它在回答什么 |
| --- | --- | --- |
| `SELF_LEVELS` 了解/熟悉/熟练/精通 | 5 | 你自己觉得怎么样 |
| `STRENGTH_LABEL` 无/弱/中/强 | 4 | 这条经历能不能被外部核对 |
| `SKILL_LEVEL_LABEL` 未验证…可讲清取舍 | 6 | 这项技能做到什么程度 |
| `ASSESSMENT_LABEL` 满足…无法判断 | 5 | 岗位这条要求满足了没 |
| `SELF_SCORE_LABEL` 答不上…能讲清取舍 | 4 | 这道题你答得怎么样 |

用户看到「熟练 / 中 / 部分满足」时无从判断谁高谁低 —— 不是文案问题，是缺统一换算口径。

**做法**：不改任何一套刻度的取值（会破坏已有数据与判定规则），而是收敛到一条主线：

```
L4 能交付  做过并有结果，且留下别人能核对的东西
L3 能上手  在真实场景里用过，能说清做法
L2 了解过  接触过但拿不出产出
L1 待验证  只有自我声明，系统判不了
```

**硬约束**：

1. 每个映射都带 `exact` 标记。证据强度全部 `exact = true`（定义上就是精确的）；
   **匹配结论全部 `exact = false`** —— 它衡量的是「要求」不是「能力」，
   而且会被硬门槛左右（学历不满足时那条要求就是没满足，与会不会那个技能无关）。
   把它们画成同一张表等于骗用户。
2. `resolveCapabilityLevel(evidenceMax, assessed)` 取**两者较低者**。
   立场是「宁可低估，也不要让用户以为已经够了」——
   证据可能只覆盖一件事却标了高强度，问诊可能被用户高估。
3. 必须给出 `why`，不能只给结论。

## 2. 问诊零打字（`QuickChoice`）

用户反馈「提的问题对于用户来说还是太繁重了」。上一轮只做了「从自己档案里抽候选」，
但用户真正卡住的往往正是**档案里没写过的部分** —— 那部分仍然要用户自己想。

**做法**：每道题都自带 4–6 条预置选项，点一下即完成这道题。

**三条不可越过的约束**：

1. 任何一项都不得含具体结果指标（`/\d+\s*%/`）或疑似具体公司名。
   项目里的量级描述（「600 多份」）允许，结果数据不允许。
2. **必须带 `isEscape` 兜底项**（「以上都不像 —— 我自己写」）。
   强制用户从几个都不对的选项里挑一个，会往能力库里写进假信息，比不填更糟。
3. `isEscape` 与 `needsDetail` 必须分开：
   普通 `needsDetail` 项是「选了补一句」，兜底项是「跳到输入框重写」。
   两者界面行为不同，界面不该去猜。

与 `suggestions`（来自用户自己写过的档案，可核实）是**不同的东西**，
界面上必须分开呈现、不同颜色、不同说明文字。

实测：Redis 5 题全部零打字完成（冒烟断言 `neededTyping: 0`）。

## 3. 面试官问答推荐（`domain/interview-prep.ts` + `engines/interview-prep.ts`）

**方向与其它功能相反**：用户出题，系统给答法。
存在理由是用户手上已经有一批面试官可能会问的问题，此刻需要的是「这句话怎么接」。

**核心设计约束：给结构，不给台词。**

一旦系统生成可直接照抄的答案，用户就会去背它，而背下来的答案在追问下必然崩掉
—— 那时候工具反而帮了倒忙。所以：

- 输出「必须覆盖哪几点」「最容易踩的坑」「对方大概率接着问什么」
- **不输出任何「你可以这样回答」** —— prompt 里明令禁止，代码里有断言钉住
- 可引用证据只给**原文与出处**，不给改写后的说法
- 免责声明硬编码在数据里（`ANSWER_DISCLAIMER`），不写在页面文案上 ——
  页面文案容易被后续改动覆盖，而免责是产品立场的一部分

分类顺序即优先级（排错会直接导致答偏，而用户发现不了）：
纯技术词 > 动机（要求「为什么 + 特定动词」）> 压力 > 匹配 > 现状 > 协作 > 规划 > 行为。
全部不命中时，**用技能词典兜底** ——「为什么用 Redis 做缓存」这类既无技术词也无动机词的问题，
纯正则会漏到 behavioral 兜底并给出一段完全跑偏的答法。

## 4. 导航按求职阶段分组（两端共用 `lib/navGroups.ts`）

```
总览   进度 · 下一步          工作台
准备   你有什么 · 目标是什么   档案 / 岗位
评估   差距在哪 · 缺的是什么   匹配 / 问诊
提升   怎么补上 · 练到什么程度 训练 / 面试问答 / 复盘
系统   引擎 · 数据 · 版本能力  设置
```

**两条不能省的规则**：

1. **桌面端与移动端必须共用同一份定义。** 分成两份必然只改一处，两个宿主就会给出不同结构。
2. **工作台必须始终可达。** 它不在流程的任何一环，但如果漏掉它，
   用户在任意功能页里就回不去了 —— 移动端 Pivot 只渲染分组内的页签。

`.metro-app` 必须 `overflow-x: hidden`：分组后每组内部仍是横向可扫的页签行，
宽度必然超出 393px，不裁剪会让整个页面（连头部色块）都能左右拖动。

---

# v0.6：证据闭环的规则（`engines/skill-interview.ts` / `engines/answer-summary.ts` / `engines/training-judge.ts`）

这一批改的不是新功能，是**一个假闭环**。用户填了问诊、练了训练，但两者都不进能力库，
于是匹配结论永远不变，而界面上写着「练完去重跑匹配」。用户照做，发现什么都没变 ——
观感就变成「我填的东西不算数，要我重填」。

## 1. 三态：`fresh` / `assessed` / `stale`

`pendingSkillsFor()` 返回的每一项都带 `state`：

| state | 含义 | 是否出现在待办列表 |
| --- | --- | --- |
| `fresh` | 没问过 | 是 |
| `assessed` | 问过，且结论仍然有效 | **否** —— 由 `assessedSkillsFor()` 只读展示 |
| `stale` | 问过，但已过时，可重答并显示上次等级 | 是 |

**v0.6 之前 `assessed` 只当排序权重**，所以已问诊的技能照旧列在待办里，
用户看到的仍是一个可点的「开始问诊」—— 这就是「填了一遍却要求重填」的直接来源。

`staleReason` 由 `assessFreshness()` 判定，优先级从上到下：

| 条件 | 是否过时 | 为什么 |
| --- | --- | --- |
| 用户手动标了 `staleMarks` | **是**（任何策略下） | 用户自己说上次答得不准，这是最强的一条信号 |
| `stalePolicy === 'never'` | 否 | 用户选了「永不过时」 |
| 这个岗位不再要求它 | 是 | 要求变了，答案的作用域也变了 |
| `stalePolicy === 'by_change_and_age'` 且超过 `staleAfterDays` | 是 | 默认 90 天 |
| 默认（`by_change`） | 否 | 只在岗位要求变化或用户主动标记时过时 |

`stalePolicy` / `staleAfterDays` 存在 `settings.review`，**由用户在设置页自决**。
这三个决策点（过时口径 / 审核布局 / 判据显隐）没有一条是「哪种都对」，它们是价值取舍，
开发替用户选等于替用户表态。

## 2. 「换一套问题」不能清空已答的

`replanQuestions()` 只换**未答**的题，已答的原样保留，被换掉的题进 `replacedQuestions`。

v0.6 之前 UI 上的文案是「换一套问题」，实现却是调 `startAssess` 重开一个会话，
于是**已答的全部被清空**。这是全项目唯一一处「点一个看起来无害的按钮就丢用户劳动」的地方，
而它恰好在答题页顶部最容易点到。全部答完时返回 `null`，界面必须明确说「换不了」，
不能悄悄返回一个空会话。

## 3. AI 整理的每个字段必须带 `anchor`

`AnswerSummary` 的每个字段（`headline` / `scenario` / `approach` / `outcome`）都有 `anchor`，
且必须是用户原话的**连续子串**。`anchorIsReal()` 程序校验，对不上就丢弃并把原因写进 `dropped[]`
给用户看，绝不静默失败。

判定口径是**去空白后子串匹配**：多打几个空格不算「没说过」，
但**换标点不算**（原话用逗号、anchor 用句号，即使语义一样也判为对不上）。
这是刻意的偏严方向：宁可丢掉一条整理结果让用户自己补，也不要放进一条
用户点开原话发现字面不符的条目 —— 那比不给更糟，它会让用户以为系统在编内容。

`summaryToEvidence()` 的三条硬要求：
`origin: 'qa'`（强度封顶「中」）→ `sourceRef.excerpt` 存**用户确认过的 anchor**
而不是模型的改写 → 用户改写过的字段 `editedByUser: true`（`finalizeProfile` 跳过它的强度重算）。

## 4. 训练判定只看四件可核对的事

`judgeTrainingAnswer()` 的判据只有四项：

| 判据 | 口径 |
| --- | --- |
| 场景 | 出现项目/系统/业务/线上等场景词 |
| 因果 | 出现「因为/所以/因此/为了/结果」等连接 |
| 数字载体 | 有数字、百分比、倍、链接、仓库、文档、PR |
| 要点覆盖 | `referencePoints` 逐条 `includes` |

**表达类问题（条理不清 / 篇幅过长）一律不参与判定** —— 那些是练几次就能改的文风问题，
写进跨岗位保留的技能等级里对任何岗位的判断都没有贡献（与 v0.4 硬约束 19 同源）。

「有没有答到点」只能用 `includes`，**不能叠 `textMentionsSkill`** ——
后者只认技能词典内的词，期望点可能是「缓存淘汰策略」这类自定义短语，
叠上它会把整份期望点都判成缺失。

`passed` 的结论文案必须写清边界：**「它只能证明你现在能讲清，不能证明这个岗位能投了」**。
判定可以隐藏（设置页开关只控制判据显隐），但判定永远发生 ——
关掉解释只是让它变成一个不给理由的判决，那才是真的骗人。

## 5. 训练与问诊的证据一律封顶「中」

`TrainingItem.evidenceIds` 是这个产品真闭环的关键：在它出现之前，
`TrainingItem` 与能力库之间没有任何连接，练完的答案只是一段文本，匹配结论永远不会变。

训练补的证据 `origin: 'qa'` → 强度封顶「中」。理由写在 `TRAINING_EVIDENCE_WHY`：
**练到能讲清不等于真的做过**。用户补上链接或数字后规则会重算，但封顶依然生效 ——
自述永远无法自证。

## 6. 重新生成训练计划要搬走旧答案

`carryOverAnswers()` 的匹配键是 `(skillName, weakness)`，**不是题目 id** ——
重新生成时题目 id 是新分配的，按 id 匹配会一条都对不上，等于没搬。
`parkTrainingItem()` 只标状态与原因，**答案一个字都不删**。

## 7. before 快照必须在写入之前取

`SkillAssessment` 是**覆盖式**写入的（去重键 `skillName`，后一次覆盖前一次），
所以评估完成之后再回头查，旧等级已经找不回来了。`EvaluateOutput.before`
必须在并入能力库之前取，否则界面上没法回答「这次问诊到底改了什么」。

## 8. 问诊证据必须按去重键合并

`mergeQaEvidence()` 复用 `profile-merge.ts` 的 `evidenceKey`
（`kind | 归一化标题 | 内容前 60 字`）。合并时**保留旧那条的 id** ——
它被技能的 `evidenceIds` 引用着，换 id 会让引用失效。

v0.6 之前这里是裸数组拼接，「同一个技能问三次」会在档案里留下三条一模一样的证据。
这不只是难看：档案页的「N 条证据」会被撑大，匹配引擎也会把它们当成三条独立支撑。
