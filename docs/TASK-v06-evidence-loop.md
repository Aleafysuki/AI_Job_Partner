# 开发任务书 v0.6 —— 累积不再丢失、训练能闭环

> 状态：**待评审，未动一行代码**
> 起草：2026-10-09
> 触发：用户实测反馈「辛苦填的东西不会经过审核和能力保存，填了一遍却要求重填」

---

## 零、先说清楚这不是三个独立需求，是同一件事的两头

用户说的三件事，在代码里其实是**一条链断成两截**：

```
简历证据 ──→ 能力库 ──→ 匹配结论 ──→ 薄弱项 ──→ 训练 ──→ ？──→ 能力库（断了）
                ↑                                          │
                └────────── 问诊结论（也写进档案）←───────────┘
                        （这条也断了：写进去，但界面不承认）
```

- **「填了一遍却要求重填」** = 链头（问诊）**写进去了但没被承认**。数据在 `profile.assessments` 里躺着，推荐列表当它不存在。
- **「训练不能补证据 / 不能练到达标」** = 链尾**根本没有回写通道**。`TrainingItem` 连 `evidenceIds` 字段都没有。
- **「希望 AI 总结并填补到个人档案」** = 缺一个**审核层**：现在 AI 话音落地就直接进档案，用户没有机会说「这句不是我想表达的意思」。

所以本任务书按「先止血、再通链、最后加审核」三批走。**第一批不做完，后面两批没意义** —— 因为用户仍然会怀疑「填了会不会丢」。

---

## 一、根因调查结论（全部有代码位置，不是猜测）

### P0-1 推荐列表完全无视已问诊结果 ← **这是「要求重填」的直接原因**

`packages/core/src/engines/skill-interview.ts:826-835`

```typescript
const priority = (info.assessed ? 100 : 0) + (info.hasEvidence ? 20 : 0) + ...;
```

`assessed` 只把已问过的技能**排到末尾**（+100），**从未用于过滤**。待问诊项不足 12 个时，已问过的技能照样出现在「建议先问这些」里，且仍带可点的「开始问诊」按钮（`pages/SkillInterview.tsx:689-708`）。界面唯一的提示是一个 `已问过` 徽章——**徽章在，但按钮也在**，用户看到的是一个可点的「重新问一遍」。

**必须区分两种语义**（现有代码把它们混成一个 `assessed: boolean` 了）：

| 语义 | 含义 | 界面该给什么 |
| --- | --- | --- |
| 问过且结论有效 | 结论仍在档案里生效 | **只读展示结论** + 「补一次」「重问」 |
| 问过但结论已过时 | 岗位/时间变了，或用户想改口 | 主动提示「这里你上次答的是 X，现在要改吗」 |

### P0-2 「换一套问题」是真的把答案删了

`state/store.ts:755-759` → `replanAssess` 调用 `startAssess`，而 `startAssess`（`store.ts:719`）：

```typescript
set({ busy:'assess', assessResult: null, assessSession: null, assessMeta: null })
```

**已答的全部题目被清空**。而这个按钮就在答题页顶部（`SkillInterview.tsx:301-303`），文案「换一套问题」听起来只是换题，实际是重来。

**这是本任务书里唯一一处「用户操作导致真丢数据」的地方**，优先级最高。

### P0-3 问诊会话零持久化

`store.ts:167-174` 的 `assessSession` / `assessResult` **不在 `WorkspaceSnapshot` 里**（`packages/core/src/storage/index.ts:40-63` 只有 profiles/jobs/reports/trainingPlans/interviewSessions/debriefReports/traces/settings/ui）。

- `answerAssess`（`store.ts:761-765`）只写内存，**不调 persist**
- 只有 `finishAssess` 落盘，且只落结论
- 底层是**单表单 key 的 JSON 大字段**（`main/storage.ts:130`），所以「结构上就不可能存」——不是忘了，是没设计

**后果**：答到第 5 题关掉应用 → 前 4 题全没了。切页也丢当前题草稿（`SkillInterview.tsx:109-118` 是组件内 `useState`，`App.tsx:105` 条件卸载）。

**这一条与 P0-2 叠加，就是用户「填了一遍却要求重填」的第二重原因**：他不是没填，是填了没留住。

### P0-4 训练结果完全不回写能力库

- `TrainingItem`（`domain/training.ts:44-82`）**没有 `evidenceIds` 字段**
- `answerTrainingItem`（`engines/training-planner.ts:403-424`）只改文本和自评分，**不调 AI、不做关键词判定、只写 `trainingPlans`，不碰 profile**（`store.ts:851-859`）
- 全仓 grep `evidenceIds`：`training.ts` / `training-planner.ts` / `Training.tsx` **零命中**

**后果**：训练页底部写着「练完之后：回到简历匹配重新分析一次」（`Training.tsx:341-349`，且只是纯文案无跳转按钮），但重跑匹配**结论不会有任何变化**。闭环是断的，且是**假闭环**——它给了用户一个做完必然失望的动作。

### P1-1 `nextStepFor` 无视问诊进度

`renderer/src/lib/nextStep.ts:74-99` 只看匹配报告统计，完全不读 `profile.assessments`。只要匹配没重跑，首页永远催「去做能力问诊」。

### P1-2 重复问诊产生重复证据

`skill-interview.ts:672` 是裸数组拼接，**不走 `evidenceKey`**（`profile-merge.ts:62-64`，只在 `mergeProfiles` 里用）。同一技能问 N 次 → 档案里 N 条 `title` 完全相同的 `origin:'qa'` 证据 → 虚高 `qaEvidenceCount`。

### P2 其余（不在本批，但登记）

- 删技能不删 `assessments` → 孤儿结论（`Profile.tsx:206-208`、`531`）
- 跨岗位复用结论时 `jobId` 永远停在第一次问诊的岗位（`skill-interview.ts:700-701`）——脏数据
- `Mock.tsx` 实装完成但能力开关未解锁（`nav.tsx:38-40`）
- 证据卡片三处内联重复（`Profile.tsx:576-621` / `Match.tsx:85-96` / `SkillInterview.tsx:247-269`），本批新增第四处**之前**应该先抽出来

---

## 二、必须守住的产品立场（否则这批改完会更糟）

这批改动的危险在于：**让 AI 总结用户的话，然后写进跨岗位保留的能力库**。一旦总结失真，污染的是所有岗位的判断。所以以下几条不是建议，是硬约束：

### 约束 A：AI 总结只能「整理」，不能「补写」

- 输出的每一句都必须**能在用户原话里找到出处**（沿用 v0.5 的 `anchor` 机制，`FollowUpHook.anchor`）
- **禁止**推断用户没说过的项目、指标、角色、时间
- **禁止**把用户含糊的话补成具体数字（「提升性能」→「提升 30%」是编造）
- 违反上述两条时程序必须**丢弃该字段并明说「这句我没敢替你补」**，而不是悄悄略过

> 依据：既有硬约束「简历建议绝不为『你补一个 Redis 项目』开口子」（约束 21）。本批是同一件事的另一面。

### 约束 B：训练判定沿用「只认可核对信号」

用户要求「练到可以满足要求」，那就必须有判定。但判定**不能是 AI 打分**。沿用 v0.5 追问引擎的判据口径（约束 26）：长度、是否有具体场景、是否有数字、是否有因果连接、是否答到期望点。**不评价文风，不评价表达。**

### 约束 C：训练产出的证据强度仍然封顶为「中」

`MAX_STRENGTH_BY_ORIGIN.qa = 'medium'`（`domain/evidence.ts:61-66`）。训练和问诊同源，**不能因为「练过了」就变成强证据** —— 练到会讲不等于真做过。

### 约束 D：不给「你已达标」的绿色结论，除非重跑匹配确认

系统能判定「这题答到了」，但**不能判定「这个岗位现在能投了」**。达标提示必须附带一句「重跑一次匹配看看结论有没有变」+ 一个真跳转按钮。

### 约束 E：不能替用户编造「下次说什么」

补证据的界面是让用户**写自己真实做过的事**，不是写一段话术模板。它和 `training.reference_answer`（给示例答复）必须视觉上明确区分，否则用户会照抄。

---

## 三、批次划分

### 第一批：止血（不做这批，后面都不该开始）

> 目标：**用户填的东西一定留住，且系统承认它填过**

| # | 任务 | 落点 | 完成判据 |
| --- | --- | --- | --- |
| 1-A | `pendingSkillsFor` 拆分语义：`assessed`(有效) / `stale`(过时) / `fresh`，并**过滤掉 `assessed`** | `skill-interview.ts:826-835` | 已问诊技能不再出现在可点击的推荐列表里 |
| 1-B | 「换一套问题」改为**保留已答题**，只换未答的题；若题库已无新题则明确告知 | `store.ts:719,755-759` | 点它之后 `session.answers` 不变 |
| 1-C | `assessSessions` 进 `WorkspaceSnapshot`，`answerAssess` 即时落盘 | `storage/index.ts:40-63` / `store.ts` | 答到一半关掉应用，重开能续 |
| 1-D | 切页/卸载不丢当前题草稿（草稿一并进会话） | `SkillInterview.tsx:109-118` | 答题中途切到档案页再回来，草稿还在 |
| 1-E | 问诊结论区加「重新问诊 / 改口」入口（现在结论条目**完全只读**，`Profile.tsx:648-686`） | `Profile.tsx` | 不必删技能就能重做 |
| 1-F | `nextStepFor` 读 `assessments`，已问过的技能不再被推荐 | `nextStep.ts:74-99` | 首页不再重复催 |
| 1-G | 问诊证据走去重键，不再裸拼接 | `skill-interview.ts:672` | 同一技能问 3 次只留 1 条证据 |

**第一批不做 UI 美化。** 它是修 bug，不是做新界面。

---

### 第二批：AI 总结 + 用户审核 → 写进档案

> 目标：满足「把回答交由 AI 总结并填补到个人档案」，但**用户有否决权**

流程（**每一步都停下来等用户**）：

```
原始回答（含档案候选与预置选项拼装后的全文）
   ↓ ① AI 结构化（带 anchor，可丢弃字段）
候选补充说明  ← 这一屏必须展示「你原话 ↔ 整理后」逐条对照
   ↓ ② 用户逐条确认 / 改写 / 删除
最终写入档案
   ↓ ③ 展示 before/after 差异（当前完全没有，EvaluateOutput 里也没有旧等级）
```

| # | 任务 | 落点 | 说明 |
| --- | --- | --- | --- |
| 2-A | `summarizeAnswer()` 引擎：结构化 + 每字段带 `anchor` + 可丢弃 | 新建 `engines/answer-summary.ts` | 约束 A 必须有单测钉住 |
| 2-B | `EvaluateOutput` 增加 `before` 快照，才能做差异视图 | `engines/skill-interview.ts` | 现在无法回答「这次问诊改了什么」 |
| 2-C | 审核界面：逐条对照 + 改写 + 删除 + 全部拒绝 | `SkillInterview.tsx` 结论页 | 「全部拒绝」必须是**正常选项**，不是隐藏出口 |
| 2-D | 存档 `origin: 'qa'`，强度封顶「中」 | 复用 `MAX_STRENGTH_BY_ORIGIN` | 约束 C |
| 2-E | 差异视图组件（当前不存在，见 P2） | 新建 `components/DiffView.tsx` | 档案页技能行现在只有 10px 灰字说来源 |

**1-B/1-C 是 2 的前置**：审核界面要能跨会话恢复，依赖会话持久化。

---

### 第三批：训练补证据 + 练到达标

> 目标：让「练过」真的变成「档案里的东西」

#### 3-A 训练题补证据

| 项 | 设计 |
| --- | --- |
| 入口 | 训练题页新增「把这段经历补进档案」按钮（`Training.tsx`） |
| 交互 | 从 `userAnswer` 预填，用户可改；**必须能整体取消** |
| 落点 | 产出 `CandidateEvidence`，`origin: 'qa'`，挂 `skills` |
| 关键 | `TrainingItem` 加 `evidenceIds: string[]`（对齐 `SkillAssessment.producedEvidenceIds`） |
| 边界 | 只能补**这条训练题对应技能**的证据，不能顺手改别的技能 |
| 理由文案 | 必须说清「这会写进能力库，之后所有岗位的判断都会用上」 |

#### 3-B 达标判定（练到满足要求）

状态机现状是单向 `todo → answered → reviewed`（`training.ts:80`），**没有回退也没有达标**。改为：

```
todo ──答──→ answered ──判定──→ passed / needs_work
                                  │
                                  └──needs_work ──追问（最多2 下）──→ 再答
                                                          │
                                                          └──仍不过 → 标记「这题先放着」+ 说明下一步
```

| # | 任务 | 说明 |
| --- | --- | --- |
| 3-B1 | `judgeTrainingAnswer()` 引擎，判据只用可核对信号 | 约束 B：不评价文风 |
| 3-B2 | 追问点必须带 `anchor`（用户原话） | 直接复用 v0.5 `extractFollowUpHooks`，不要另写一套 |
| 3-B3 | 终止条件：最多 2 下追问 / 每题 3 轮 / 短于 40 字不追 | 与模拟面试同一组常量，抽出来共用 |
| 3-B4 | 「先放着」的题保留在档案里并标注原因 | 不能因为没练过就删掉用户的答案 |
| 3-B5 | 达标后**不给绿色求职结论**，只提示重跑匹配 + 真跳转 | 约束 D |

#### 3-C 闭环接通

- 训练计划重建时**不删旧答案**（现在 `store.ts:835-838` 直接 `deleteTrainingPlan`）——**这又是一个会丢用户劳动的地方**
- 达标记录回写 `profile.assessments`（作为一次低强度问诊，标记 `engine: 'training'`）
- 补的证据与问诊证据**同样走去重键**，不虚高计数

---

## 四、明确不做（防止范围蔓延）

| 不做 | 理由 |
| --- | --- |
| 不做训练题的自动打分/AI 评分 | 约束 B |
| 不让 AI 推断用户没说过的经历 | 约束 A |
| 不为「重新问诊」清空已答内容 | 就是这次要修的 bug |
| 不引入云端存储来「防丢」 | 数据只在本机是产品承诺 |
| 不改 `CURRENT_RELEASE` | 按约束 16，版本号只解锁「真的做了的」。这一批做完后是否升 v0.6，取决于 `Mock` 解锁与否 |

---

## 五、验收清单

**必须补的单测**（放 `tests/`，与规则表同源）：

1. 点「换一套问题」后 `session.answers` 不变（钉死 1-B）
2. `summarizeAnswer` 输出的每个字段都有 `anchor`，且 anchor 确实出现在原话里（约束 A）
3. 模型返回无 anchor 的字段 → 被丢弃且记录原因
4. 同一技能重复问诊 → `evidence.length` 不增长（1-G）
5. `pendingSkillsFor` 对已问诊技能不返回可点击项（1-A）
6. 训练补证据产出 `origin:'qa'` 且 `strength === 'medium'`，即使自评满分（约束 C）
7. 训练计划重建后旧答案仍在（3-C）
8. 判定引擎对「短于 40 字」「复述概念」「含具体场景+数字」三档给出不同结果（约束 B）

**必须补的冒烟断言**：

- 桌面 + 移动双端：`smoke:ui` / `smoke:mobile` 走完「问诊 → 审核 → 档案可见」
- 移动端审核界面的对照视图不溢出（393px 宽度，两栏对照必然超）
- 训练页新增入口在 Metro 下可点

**六条命令全绿**：`typecheck` / `test` / `build` / `smoke:ui` / `smoke:app` / `web:single`，Android 再加 `android:sync` / `android:check` / `smoke:mobile`。

> 注意 `smoke:app` 退出码 **2 表示环境受限，要当成「未验证」**。
> 移动端跑之前必须 `env -u ELECTRON_RUN_AS_NODE`。

---

## 六、风险与已知不确定

| 风险 | 缓解 |
| --- | --- |
| `assessSessions` 进快照会让快照体积上涨（录音/训练文本都在里面） | 会话只存文本，音频本来就不进快照（约束）；加体积断言 |
| 会话落盘时机太频繁会卡（每答一题写一次） | 节流：切页时写 + 答题间隔 >2s 写 |
| AI 总结会诱发「一键全通过」的懒习惯 | 默认全部**待确认**，不给批量通过；「全部拒绝」要在同一层级 |
| 训练判定被当成权威结论，掩盖真实差距 | 判定文案只说「这题答到了」，不说「这个岗位能投了」 |
| `stale` 判定标准（多久算过时？） | **需决策**：我倾向不用时间，用「档案/岗位是否变化」+ 用户手动标记。见下方待确认 |

---

## 七、待确认的三个决策点

1. **`stale` 怎么判？** 时间维度（3 个月）简单但武断；我建议改成「岗位 JD 变了 / 用户手动标为想改口 / 结论里点了『已过时』」，不引入时间。
2. **第二批的审核界面，一屏展示全部条目还是分页？** 条目数取决于 AI 拆分粒度，可能有 3–8 条。移动端 393px 下一屏放不下 8 组对照。
3. **训练题的达标判定要不要让用户能看到判据？** 我倾向能看到（「这句里没有具体场景」），但这等于承认系统在打分，需确认是否与训练页现有立场冲突。

---

## 附：调查依据的文件清单

**引擎层**：`packages/core/src/engines/skill-interview.ts`、`profile-builder.ts`、`profile-merge.ts`、`training-planner.ts`、`pipeline.ts`、`interactive-followup.ts`
**领域层**：`packages/core/src/domain/{interview,profile,evidence,training,mock-interview,levels}.ts`
**存储**：`packages/core/src/storage/index.ts`、`apps/desktop/src/main/storage.ts`
**状态**：`apps/desktop/src/renderer/src/state/store.ts`、`lib/nextStep.ts`
**界面**：`pages/{SkillInterview,Training,Profile,Match,Mock}.tsx`、`components/{ui,LevelLegend}.tsx`