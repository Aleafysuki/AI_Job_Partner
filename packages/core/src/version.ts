/**
 * 版本与能力开关（capabilities）
 * ================================
 *
 * 产品文档把「暂时不做的事」分成两类，本文件把它们编码为可开关的能力表：
 *
 *  A. 路线图内的功能
 *     v0.2（已实施）：能力问诊、问诊结论转证据、能力库跨岗位保留、薄弱项训练、训练进度
 *     v0.3：岗位截图 OCR、最低候选人画像、简历修改建议、报告导出（原 v0.2 计划顺延）
 *     v0.4：面试题生成、模拟面试、回答分析、面试薄弱点回流（原 v0.3 计划顺延）
 *     → 这类能力由 `since` 字段决定，提升 CURRENT_RELEASE 即自动开启，无需改业务代码。
 *
 *  B. v0.1 铁律（文档 25 节「暂时明确不做」）
 *     → 全部标记为 `since: 'future'`，表示「不是靠版本号自动打开」，必须显式指定解除版本。
 *       新版本到来时，只需要把对应条目的 `since` 改成目标版本（例如 'v0.5'），
 *       或者把 CURRENT_RELEASE 提升到 'future' 之后的版本，能力即自动解锁。
 *
 *  C. 方向明确但未排期的（例如第三方付费课程对接）
 *     → 同样用 `since: 'future'`，但**不带** `restriction` 标记，
 *       以此和「v0.1 铁律」区分开：前者是「以后要做」，后者是「当时明确不做」。
 *
 * 这样做的目的：业务代码里所有「能不能做 X」都只问 isEnabled('X')，
 * 不再散落 if (version === '0.1') 这类硬编码判断。
 */

export const APP_NAME = 'AI Job Partner';
export const APP_VERSION = '0.4.0';
export const APP_TAGLINE = '把你的经历与目标岗位放在一起，看清我有什么、岗位要什么、我缺什么。';

/**
 * 版本序列。'future' 表示「尚未排期」，排在最后
 *
 * v0.3 的槽位说明（重要）：
 *   v0.3 这个版本号**已经被路线图占用了**（岗位截图 OCR、最低候选人画像、
 *   简历修改建议、报告导出）。这批可用性修正不能占用它 ——
 *   否则为了开修复项，就得连带解锁四个还没做的功能。
 *
 *   所以这批修正的 `since` 一律写 **v0.2**：它们是对已交付功能的修复，
 *   在当前版本就该生效。只有 APP_VERSION 从 0.2.0 升到 0.3.0，
 *   让用户知道装的是修好的那一版。
 */
export type Release = 'v0.1' | 'v0.2' | 'v0.3' | 'v0.4' | 'future';

export const RELEASE_ORDER: Release[] = ['v0.1', 'v0.2', 'v0.3', 'v0.4', 'future'];

/**
 * 当前发布版本 —— 提升这里即完成一次「版本更新」。
 *
 * 保持 'v0.2'：v0.3 的槽位留给路线图里的功能，本批修正不抢占。
 */
export const CURRENT_RELEASE: Release = 'v0.4';

export const RELEASE_LABEL: Record<Release, string> = {
  'v0.1': 'v0.1 主链路',
  // v0.2 标签在 v0.2 追加面试复盘、以及用户实测反馈后的可用性修正后扩展。
  // 原值（保留留痕，勿删）：'v0.2 能力问诊与薄弱项训练'
  'v0.2': 'v0.2 能力问诊 · 薄弱项训练 · 面试复盘 · 可用性修正',
  'v0.3': 'v0.3 岗位 OCR · 简历建议 · 报告导出',
  'v0.4': 'v0.4 面试训练与模拟',
  future: '未排期',
};

export interface CapabilityDef {
  id: string;
  label: string;
  description: string;
  /** 从哪个版本开始启用 */
  since: Release;
  /** 文档章节出处，方便回溯产品决策 */
  docRef: string;
  /** 是否为 v0.1 铁律（文档 25 节） */
  restriction?: boolean;
}

/**
 * 功能能力表。
 * id 命名规则：模块_动作，业务代码只引用 id。
 */
export const CAPABILITIES: CapabilityDef[] = [
  // ---------- v0.1 已实现：MVP 主链路（文档 18 节） ----------
  {
    id: 'profile.import_text',
    label: '简历导入（TXT / Markdown）',
    description: '读取纯文本简历并建立能力档案',
    since: 'v0.1',
    docRef: '24. Phase 1',
  },
  {
    id: 'profile.import_pdf',
    label: '简历导入（PDF）',
    description: '抽取 PDF 文本后建立能力档案，不追求排版还原',
    since: 'v0.1',
    docRef: '24. Phase 1',
  },
  {
    id: 'profile.import_docx',
    label: '简历导入（DOCX）',
    description: '抽取 Word 文本后建立能力档案',
    since: 'v0.1',
    docRef: '24. Phase 1',
  },
  {
    id: 'profile.import_scratch',
    label: '直接输入经历',
    description: '没有规范简历也能建档案：「我以前做过一个网站，主要负责 SEO……」',
    since: 'v0.1',
    docRef: '3. 目标用户',
  },
  {
    id: 'profile.edit',
    label: '档案可修正',
    description: 'AI 不是最终数据拥有者，所有解析结果都能改、能删、能补',
    since: 'v0.1',
    docRef: '14 / 22.4',
  },
  {
    id: 'privacy.redaction',
    label: '隐私识别与脱敏',
    description: '姓名 / 电话 / 邮箱 / 地址 / 身份证 / 社交账号在进入分析前脱敏',
    since: 'v0.1',
    docRef: '11 / 24. Phase 5',
  },
  {
    id: 'privacy.inspect_payload',
    label: '查看实际发送内容',
    description: '透明展示 AI 实际收到的 Prompt，确认没有原始 PII 外发',
    since: 'v0.1',
    docRef: '11',
  },
  {
    id: 'job.input_text',
    label: '岗位输入（文字）',
    description: '粘贴 JD 文本，或直接手输对方口头说的几条要求',
    since: 'v0.1',
    docRef: '6 / 24. Phase 2',
  },
  {
    id: 'job.parse_requirement',
    label: '岗位拆解',
    description: '把 JD 拆成必须条件 / 技术要求 / 职责 / 经验 / 学历 / 工具 / 软技能 / 加分项 / 隐含要求',
    since: 'v0.1',
    docRef: '6 / 24. Phase 2',
  },
  {
    id: 'job.edit_requirement',
    label: '岗位要求可纠正',
    description: '用户可以修改 AI 拆解出的要求与重要程度',
    since: 'v0.1',
    docRef: '22.4',
  },
  {
    id: 'match.engine',
    label: '匹配引擎',
    description: 'Requirement → Candidate Evidence → Assessment，不做关键词命中即等于满足',
    since: 'v0.1',
    docRef: '7 / 24. Phase 3',
  },
  {
    id: 'match.report',
    label: '可解释匹配报告',
    description: '输出 满足 / 部分满足 / 缺少证据 / 存在缺口 / 无法判断，并给出依据与下一步行动',
    since: 'v0.1',
    docRef: '7 / 24. Phase 4',
  },
  {
    id: 'match.explain_evidence',
    label: '依据链展示',
    description: '每条结论都能展开看到命中的证据与规则',
    since: 'v0.1',
    docRef: '22.3',
  },
  {
    id: 'ai.provider_switch',
    label: 'AI Provider 可替换',
    description: '在线 OpenAI 兼容接口 / Ollama 本地模型 / 内置离线规则引擎，业务逻辑不绑定任何一家',
    since: 'v0.1',
    docRef: '22.6',
  },
  {
    id: 'ai.trace_inspect',
    label: 'AI 调用留痕',
    description: '逐条查看每次调用的 prompt、返回、耗时、是否降级',
    since: 'v0.1',
    docRef: '11 / 22.3',
  },
  {
    id: 'storage.local',
    label: '本地数据存储',
    description: '不建立账号系统，数据默认只保存在本机',
    since: 'v0.1',
    docRef: '16 / 25',
  },
  {
    id: 'workbench.history',
    label: '最近分析记录',
    description: '工作台保留历史分析，可回看历史报告',
    since: 'v0.1',
    docRef: '13',
  },

  // ---------- v0.2（本次实施：能力问诊 / 能力库跨岗位保留 / 薄弱项训练） ----------
  {
    id: 'skill.assess',
    label: '能力问诊',
    description: '用一组递进问答快速探测某项技能的真实掌握程度：自评 → 具体场景 → 使用深度 → 产出结果 → 自我认知边界',
    since: 'v0.2',
    docRef: 'V0.2 追加需求',
  },
  {
    id: 'evidence.from_assessment',
    label: '问诊结论转为证据',
    description: '把问诊里说清楚的具体场景与产出转成一条证据补充进能力库（自述来源，强度封顶为「中」，补上链接或数字后可由用户升级）',
    since: 'v0.2',
    docRef: 'V0.2 追加需求',
  },
  {
    id: 'library.cross_job',
    label: '能力库跨岗位保留',
    description: '换岗位、重新导入简历时，已积累的技能、证据与问诊结论按去重键合并保留，不做覆盖式重建',
    since: 'v0.2',
    docRef: 'V0.2 追加需求',
  },
  {
    id: 'training.weak_point',
    label: '薄弱项训练',
    description: '从匹配结果里挑出缺口、缺少证据与部分满足项，按技能生成问答式训练题与自评要点',
    since: 'v0.2',
    docRef: 'V0.2 追加需求',
  },
  {
    id: 'training.progress',
    label: '训练进度记录',
    description: '记录每题的回答、自评分数与完成状态，训练计划保留在本地并可回看',
    since: 'v0.2',
    docRef: 'V0.2 追加需求',
  },

  // ---------- v0.3（用户实测反馈后追加） ----------
  //
  // 这一批是对已交付功能的**可用性修正**，不是新功能：
  // 同样是能力问诊，从「固定五层模板」改成「按能力形状动态出题」。
  // 所以 since 一律写 v0.2（当前版本就该生效），docRef 标为「用户实测反馈」——
  // 这样能力开关表如实反映「用户现在能用哪些」，而 v0.3 的槽位仍留给路线图里的功能。
  {
    id: 'interview.dynamic_questions',
    label: '问诊按能力动态出题',
    description: '按能力形状分成技术/行为/资质/领域四套走法：沟通协作这类软技能不再问「属于了解还是熟悉」，直接问最近发生的具体事例',
    since: 'v0.2',
    docRef: '用户实测反馈（问诊问题过于固定、对软技能问掌握程度不合适）',
  },
  {
    id: 'interview.suggestions',
    label: '问诊候选答案',
    description: '从档案里已有的证据抽出候选回答，点一下即可采纳，不必凭空回忆并组织语言；仍可自由改写',
    since: 'v0.2',
    docRef: '用户实测反馈（「问诊太费脑子」）',
  },
  {
    id: 'interview.skip_semantics',
    label: '区分「没做过」与「想不起来」',
    description: '两种跳过分别记录：前者算明确否认（等级封顶在了解概念），后者只是这题没答上，不影响判断',
    since: 'v0.2',
    docRef: '用户实测反馈',
  },
  {
    id: 'training.reference_answer',
    label: '训练参考答案',
    description: '每道训练题附一段可直接读的示例答复（结构示例，不是标准答案）；模型生成时若出现编造的经历会被程序丢弃',
    since: 'v0.2',
    docRef: '用户实测反馈（「薄弱项训练希望有参考答案」）',
  },
  {
    id: 'ai.usage_meter',
    label: '模型用量与费用统计',
    description: '按 token 记录每次调用并折算费用，设置页可查总额、按用途分组与预算上限；本地模型与降级调用不计费',
    since: 'v0.2',
    docRef: '用户实测反馈（希望有用量与计费显示）',
  },
  {
    id: 'job.show_raw_text',
    label: 'JD 原文回看与定位',
    description: '拆解结果可展开查看脱敏后的 JD 全文，并能从任意一条要求跳回原文对应片段高亮',
    since: 'v0.2',
    docRef: '用户实测反馈（「JD 拆解之后希望还能显示出原文」）',
  },
  {
    id: 'profile.bulk_edit',
    label: '档案批量增删',
    description: '技能支持批量粘贴导入（自动归一化去重）、多选批量删除；仍可单条编辑',
    since: 'v0.2',
    docRef: '用户实测反馈（「能力档案能按实际情况增删」）',
  },
  {
    id: 'ui.next_step',
    label: '常驻「下一步」引导',
    description: '按当前状态算出唯一下一步并在桌面与移动两端固定显示，替代每页各自解释的分散引导',
    since: 'v0.2',
    docRef: '用户实测反馈（「移动端视觉引导混乱」）',
  },

  // ---------- v0.3 追加：面试复盘（现场录音 + 实时转写 + 多维复盘） ----------
  //
  // 为什么放在 v0.2 而不是新开一个版本槽位：
  // 与「能力问诊」同构 —— 它们都是用户在上一版交付后追加的需求，
  // 能力表的 docRef 标注为「V0.2 追加需求」，不占用新的版本号，
  // 因此既有的版本→能力断言全部保持成立（见 tests 的「原 v0.2 计划顺延」用例）。
  {
    id: 'interview.record',
    label: '面试录音（麦克风）',
    description: '面试过程中录制自己的声音，按分片落盘；支持边录边写，意外中断不丢已录内容',
    since: 'v0.2',
    docRef: 'V0.2 追加需求（面试复盘）',
  },
  {
    id: 'interview.record_system_audio',
    label: '线上面试内录',
    description: '捕获系统播放的声音（loopback），把面试官那一半对话也录进来；不弹系统选择框',
    since: 'v0.2',
    docRef: 'V0.2 追加需求（面试复盘）',
  },
  {
    id: 'interview.transcribe',
    label: '录音实时转写',
    description: '录音分片按序送去转写，面试进行中即滚动产出文字；未配置转写服务时降级为只录音',
    since: 'v0.2',
    docRef: 'V0.2 追加需求（面试复盘）',
  },
  {
    id: 'interview.debrief',
    label: '面试复盘报告',
    description: '机会侧 12 维 + 表现侧 6 维 + 岗位适配度评定 + 三档决策表 + 唯一下一步动作',
    since: 'v0.2',
    docRef: 'V0.2 追加需求（面试复盘）',
  },
  {
    id: 'interview.debrief_export',
    label: '复盘报告导出',
    description: '导出为自包含离线 HTML（内联 CSS、原生 SVG 雷达图，不依赖任何 CDN）与结构化 JSON',
    since: 'v0.2',
    docRef: 'V0.2 追加需求（面试复盘）',
  },

  // ---------- v0.4（用户实测反馈后追加：降低问答负担 / 面试问答 / 层级收敛） ----------
  //
  // 与 v0.3 同理：这一批全是可用性改进，不是新功能方向。
  // `since` 一律写 v0.2 —— v0.3 的槽位留给路线图里的岗位 OCR / 简历建议 / 报告导出。
  {
    id: 'interview.quick_choice',
    label: '问诊预置选项（零打字作答）',
    description: '每道题自带 4-6 条常见情形，点一下即完成这道题；必带「以上都不像，我自己写」兜底项，且不得替用户编造具体经历',
    since: 'v0.2',
    docRef: '用户实测反馈（问诊仍然太繁重）',
  },
  {
    id: 'interview.prep',
    label: '面试官问答推荐',
    description: '用户贴入面试官可能会问的问题，系统归类并给出回答必须覆盖的要点、最容易踩的坑、可能的追问，以及档案里可引用的原文。只给结构，不给可直接照抄的答案',
    since: 'v0.2',
    docRef: '用户实测反馈（想做面试官问答推荐）',
  },
  {
    id: 'ui.level_hierarchy',
    label: '能力层级统一与导航分级',
    description: '把原本五套等级刻度收敛到一条四级主线（能交付/能上手/了解过/待验证），并给出精确-大致对应关系；导航按求职五个阶段分组，桌面端与移动端共用同一份定义',
    since: 'v0.2',
    docRef: '用户实测反馈（多个层级关系乱）',
  },

  // ---------- v0.3（原 v0.2 计划顺延） ----------
  {
    id: 'job.input_image',
    label: '岗位截图 OCR',
    description: '上传招聘截图 / 手机截图 / 聊天截图，OCR 后提取岗位要求',
    since: 'v0.3',
    // 实装记录（2026-10-08）：这一项曾被移到 future，因为它当时是空壳。
    // 现在双端都落地了 —— Android 用 ML Kit on-device（原生模型），
    // 桌面用 tesseract WASM（随包分发）。两者都**不联网**。
    // 详见 domain/ocr.ts 的文件头（为什么不用云端 OCR）。
    docRef: '19',
  },
  {
    id: 'match.minimum_candidate',
    label: '最低通过简历画像',
    description: '反向构建「最低可解释候选人画像」并与自己的档案对照',
    since: 'v0.3',
    docRef: '8 / 19',
  },
  {
    id: 'resume.suggestion',
    label: '简历修改建议',
    description: '针对具体岗位要求给出可落地的简历改写建议（不自动虚构经历）',
    since: 'v0.3',
    docRef: '19',
  },
  {
    id: 'report.export',
    label: '报告导出',
    description: '把结构化 JSON 渲染为 PDF / Word / Markdown 报告',
    since: 'v0.3',
    docRef: '19',
  },

  // ---------- v0.4（原 v0.3 计划顺延） ----------
  {
    id: 'interview.generate',
    label: '面试题生成',
    description: '从岗位要求、简历、真题、指定知识领域生成训练题',
    since: 'v0.4',
    docRef: '9 / 20',
  },
  {
    id: 'interview.mock',
    label: '模拟面试',
    description: '多轮追问式模拟面试',
    since: 'v0.4',
    docRef: '20',
  },
  {
    id: 'interview.analyze_answer',
    label: '回答分析',
    description: '拆解知识正确性 / 表达完整性 / 逻辑结构 / 是否答到点上 / 是否过度展开',
    since: 'v0.4',
    docRef: '10 / 20',
  },
  {
    id: 'interview.weak_point_training',
    label: '面试薄弱点回流',
    description: '把模拟面试暴露出的问题自动写回能力库的待学习列表',
    since: 'v0.4',
    docRef: '20 / 21',
  },

  // ---------- 未排期（方向明确，但不在当前路线图内） ----------
  {
    id: 'training.paid_course',
    label: '第三方付费课程对接',
    description: '把训练项接到外部课程平台，按转化结算分成。涉及商业合作与分账，属于方向性规划',
    since: 'future',
    docRef: 'V0.2 追加需求（用户明确「以后再说」）',
  },
  {
    id: 'training.knowledge_graph',
    label: '知识点图谱',
    description: '把技能、训练项、面试反馈连成知识点图谱，用于规划学习路径',
    since: 'future',
    docRef: '21',
  },

  // ---------- 文档 25 节：v0.1 铁律 ----------
  // 说明：这些不是路线图内的功能，而是被明确推迟的产品方向。
  // 想启用它们时必须显式修改 since（或提升 CURRENT_RELEASE 到更后版本），
  // 不允许在业务代码里绕过能力开关直接实现。
  { id: 'restrict.job_crawler', label: '招聘网站爬虫', description: '抓取招聘网站职位数据', since: 'future', docRef: '25', restriction: true },
  { id: 'restrict.job_database', label: '职位数据库', description: '建立并维护职位库', since: 'future', docRef: '25', restriction: true },
  { id: 'restrict.auto_apply', label: '自动投递', description: '自动投递简历', since: 'future', docRef: '25', restriction: true },
  { id: 'restrict.social_account', label: '社交账号', description: '接入社交账号体系', since: 'future', docRef: '25', restriction: true },
  { id: 'restrict.user_account', label: '用户注册', description: '注册 / 登录 / 云端账号体系', since: 'future', docRef: '25', restriction: true },
  { id: 'restrict.payment', label: '在线支付', description: '付费与订阅', since: 'future', docRef: '25', restriction: true },
  { id: 'restrict.community', label: '社区', description: '用户社区', since: 'future', docRef: '25', restriction: true },
  { id: 'restrict.enterprise_backend', label: '企业招聘后台', description: '面向招聘方的后台系统', since: 'future', docRef: '25', restriction: true },
  { id: 'restrict.auto_contact_hr', label: '自动联系 HR', description: '自动触达招聘方', since: 'future', docRef: '25', restriction: true },
  { id: 'restrict.auto_resume_rewrite', label: '全自动修改简历', description: '未经用户确认直接改写简历内容', since: 'future', docRef: '25', restriction: true },
  { id: 'restrict.full_interview_system', label: '完整面试系统', description: '端到端面试官系统（v0.3 只做训练与复盘）', since: 'future', docRef: '25', restriction: true },
  { id: 'restrict.mobile_client', label: '移动端独立客户端', description: 'Android / iOS 独立客户端', since: 'future', docRef: '25', restriction: true },
];

const CAPABILITY_MAP = new Map(CAPABILITIES.map((c) => [c.id, c]));

export type CapabilityStatus = 'enabled' | 'coming_soon';

export function releaseIndex(release: Release): number {
  const idx = RELEASE_ORDER.indexOf(release);
  return idx < 0 ? RELEASE_ORDER.length : idx;
}

/** 当前版本是否已达到某能力要求的版本 */
export function releaseReached(target: Release): boolean {
  return releaseIndex(effectiveRelease()) >= releaseIndex(target);
}

export function getCapability(id: string): CapabilityDef | undefined {
  return CAPABILITY_MAP.get(id);
}

/**
 * 唯一的开关查询入口。
 * 业务代码一律通过它判断「这个版本能不能做 X」。
 */
export function isEnabled(id: string): boolean {
  const cap = CAPABILITY_MAP.get(id);
  if (!cap) return false;
  return releaseReached(cap.since);
}

export function capabilityStatus(id: string): CapabilityStatus {
  return isEnabled(id) ? 'enabled' : 'coming_soon';
}

/** 该能力会在哪个版本提供（用于展示「Coming Soon · v0.3」） */
export function releaseLabelOf(id: string): string {
  const cap = CAPABILITY_MAP.get(id);
  if (!cap) return '';
  return RELEASE_LABEL[cap.since];
}

/** 当前版本尚未提供、但已排期的能力（默认不包含 25 节铁律） */
export function upcomingCapabilities(options: { includeRestrictions?: boolean } = {}): CapabilityDef[] {
  return CAPABILITIES.filter((c) => {
    if (isEnabled(c.id)) return false;
    if (c.restriction && !options.includeRestrictions) return false;
    return true;
  });
}

/** 已排期但当前版本未开启的能力 —— UI 用它渲染「Coming Soon」列表 */
export function plannedCapabilities(): CapabilityDef[] {
  return CAPABILITIES.filter((c) => !isEnabled(c.id) && !c.restriction);
}

/** v0.1 铁律清单 —— 设置页「已明确不做」面板用它渲染 */
export function restrictionCapabilities(): CapabilityDef[] {
  return CAPABILITIES.filter((c) => c.restriction);
}

/** 允许宿主 / 测试临时覆盖当前版本（默认不被写入，纯运行时） */
let releaseOverride: Release | null = null;
export function setReleaseOverride(release: Release | null): void {
  releaseOverride = release;
}
export function effectiveRelease(): Release {
  return releaseOverride ?? CURRENT_RELEASE;
}
