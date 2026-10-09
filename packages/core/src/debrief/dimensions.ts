import type { DebriefDimensionKind, DebriefPressureLevel } from '../domain/debrief';

/**
 * 面试复盘的分析框架（机器可读定义）
 * ======================================
 *
 * 移植自 `multi-dimension-fit-report` 的 `references/dimensions.json`，
 * 并针对「真实面试复盘」这个场景做了两处扩展：
 *
 *   1. 机会侧 D1–D12 保持原样 —— 面试官介绍岗位的话，和宣讲/群面里说的话
 *      是同一种材料，用它判断「这岗位实际是什么样」依然成立。
 *   2. 新增表现侧 P1–P6 —— 原框架只分析机会，不看当事人答得怎么样；
 *      而面试复盘的核心诉求恰恰包含「我哪里没答好」。
 *
 * 原文（规范版）留档在 `docs/debrief/`，本文件是它的机器可读形态。
 * 改动纪律：改这里必须同步 `docs/debrief/framework.md` 与
 * `docs/DATA_MODEL.md` 的复盘规则表，以及对应的单测断言。
 */

export interface DebriefDimensionDef {
  id: string;
  kind: DebriefDimensionKind;
  key: string;
  name: string;
  goal: string;
  /** 什么条件下这个维度才有意义（不足时置 insufficient_info） */
  appliesWhen: string;
  steps: string[];
  forbidden: string[];
  /** 该维度会用到的量表键 */
  scoreKeys: string[];
  /** 该维度会用到的清单键 */
  checklists: string[];
}

// ---------------------------------------------------------------------------
// 机会侧：D1–D12
// ---------------------------------------------------------------------------

export const OPPORTUNITY_DIMENSIONS: DebriefDimensionDef[] = [
  {
    id: 'D1',
    kind: 'opportunity',
    key: 'reality',
    name: '实态还原：这个角色到底在干什么',
    goal: '用外行能懂的话还原真实工作流程，而不是复述对方的岗位描述。',
    appliesWhen: 'always',
    steps: [
      '逐条列出对方描述的工作内容',
      '还原一个普通员工一天可能经历的流程，用箭头串成链路',
      '信息足够时，为每个环节估一个耗时区间',
      '标注哪些来自原话、哪些是推断',
    ],
    forbidden: ['复述岗位描述或招聘话术', '把对方说的当成既成事实', '用行业惯例补齐缺失环节'],
    scoreKeys: [],
    checklists: [],
  },
  {
    id: 'D2',
    kind: 'opportunity',
    key: 'requirements',
    name: '要求拆解：硬性要求与隐性要求',
    goal: '把要求拆成「可量化或明确规定的硬性条件」与「实际存在但没写出来的软性代价」。',
    appliesWhen: 'always',
    steps: [
      '逐项比对硬性要求清单，填满足 / 不满足 / 未知',
      '逐项评估隐性要求清单的要求强度 1–5',
      '把对方明说的门槛与「实际会筛人但没说」的门槛分开列',
    ],
    forbidden: [
      '把清单里出现的关键工具名、规范编号、专业概念解读成「可以学」',
      '把「不限经验 / 不限学历」当作低门槛',
    ],
    scoreKeys: ['implicit_requirement_intensity'],
    checklists: ['hard_requirements', 'implicit_requirements'],
  },
  {
    id: 'D3',
    kind: 'opportunity',
    key: 'workload_math',
    name: '工作量测算',
    goal: '把关键数量指标换算成时间，判断在正常工作日内是否物理可行。',
    appliesWhen: '文本中出现任何量化指标',
    steps: [
      '提取所有关于工作量的描述，不同发言人的说法分开记',
      '区分名义口径与实际口径',
      '按不同单位耗时做多档情景模拟',
      '算出纯处理时间与剩余时间，给可行性判断',
      '补上被忽略的时间成本：查看任务、系统切换、等待响应、处理情绪、填记录',
    ],
    forbidden: [
      '直接把数量当成累或简单',
      '忽略记录、切换、等待、情绪恢复等额外时间成本',
      '用单一档位代替多档情景',
    ],
    scoreKeys: ['quantity_pressure', 'time_pressure'],
    checklists: ['workload_time_table'],
  },
  {
    id: 'D4',
    kind: 'opportunity',
    key: 'stress',
    name: '压力画像',
    goal: '把「压力大」拆成可分别定级的压力类型，每类独立给等级和依据。',
    appliesWhen: 'always',
    steps: [
      '对 9 类压力逐项定级 低 / 中 / 高 / 信息不足',
      '每类写出判断依据所对应的证据编号',
      '压力等级汇入压力雷达图',
    ],
    forbidden: ['只给一个笼统的「压力大」结论', '等级留空（信息不足必须显式写 unknown）'],
    // 与 STRESS_TYPES 的 key 一一对应；此处内联而不是调用函数，
    // 否则模块顶层求值会撞上 STRESS_TYPES 的 TDZ
    scoreKeys: ['quantity', 'time', 'performance', 'emotion', 'monitoring', 'attention', 'communication', 'schedule', 'physical'],
    checklists: ['stress_types'],
  },
  {
    id: 'D5',
    kind: 'opportunity',
    key: 'nominal_vs_effective',
    name: '名义口径 vs 实际口径',
    goal: '指出同一个指标在两种口径下的强度差异 —— 这是最容易被话术掩盖的地方。',
    appliesWhen: '文本中出现达标类指标',
    steps: [
      '列出所有「X 个」「X 单」「X 稿」「X 个功能」类指标',
      '为每个指标写出名义口径与实际口径各自含义',
      '判断指标考核的是哪一个口径，未说明则标未知',
    ],
    forbidden: ['只列出数字不区分口径'],
    scoreKeys: [],
    checklists: ['workload_time_table'],
  },
  {
    id: 'D6',
    kind: 'opportunity',
    key: 'work_type',
    name: '工作类型判定',
    goal: '按实际工作流程判断类型，不看岗位名称。',
    appliesWhen: 'always',
    steps: ['对照工作类型分类表勾选，可多选', '解释为什么归入这些类别', '说明不属于哪些类别及原因', '给出最准确的综合描述'],
    forbidden: ['因为工作内容涉及某领域就直接贴该领域的标签', '只按岗位名称分类'],
    scoreKeys: [],
    checklists: ['work_type_taxonomy'],
  },
  {
    id: 'D7',
    kind: 'opportunity',
    key: 'personal_fit',
    name: '个体适配',
    goal: '基于当事人的条件逐项分析适配度。不给单一总分。',
    appliesWhen: '已建立能力档案',
    steps: [
      '对照 10 个适配维度逐项给 1–5 分或 null',
      '每项写出与当事人哪句话相关',
      '区分「理论上能做」与「能长期做」',
      '标出当事人心理边界被触碰的维度',
    ],
    forbidden: ['给一个总分代替逐项分析', '把当事人说「可以试试」解读成「能长期承受」', '越过当事人边界替他做取舍'],
    // 同上：与 FIT_DIMENSIONS 的 key 一一对应，内联避免 TDZ
    scoreKeys: [
      'skill',
      'communication',
      'repetition',
      'attention',
      'emotion_pressure',
      'kpi',
      'schedule',
      'physical',
      'short_term_transition',
      'long_term_value',
    ],
    checklists: ['fit_dimensions'],
  },
  {
    id: 'D8',
    kind: 'opportunity',
    key: 'sustainability',
    name: '持续性推演：能不能撑住',
    goal: '分三个时间尺度判断，区分「理论上能完成」与「可以连续完成不崩溃」。',
    appliesWhen: '已建立能力档案',
    steps: [
      '第一天：会碰到什么、心理感受、当天任务能否完成',
      '第一周：最可能出的问题、新鲜感消退后的现实冲击、需要警惕的早期信号',
      '第一个月：真正决定能否留下的因素、理论可行与持续可行之间的差距',
    ],
    forbidden: ['只判断单日可行性', '用「坚持一下就好」这类表述替代机制分析'],
    scoreKeys: ['day1', 'week1', 'month1'],
    checklists: ['sustainability_axes'],
  },
  {
    id: 'D9',
    kind: 'opportunity',
    key: 'risk_signals',
    name: '话术风险扫描',
    goal: '识别文本中的风险信号，不武断判定为骗人，而是给出多种可能解释与验证方式。',
    appliesWhen: 'always',
    steps: [
      '按风险信号库扫描文本，命中即收录',
      '每条信号给：正面理解 / 反面理解 / 其他可能',
      '写清如何验证：问什么、观察什么',
      '把不同发言人说法不一致处单独列出',
    ],
    forbidden: ['把单条话术直接定性为欺骗', '只标风险不给验证路径'],
    scoreKeys: [],
    checklists: ['risk_signal_categories'],
  },
  {
    id: 'D10',
    kind: 'opportunity',
    key: 'real_compensation',
    name: '实际回报测算',
    goal: '按可确定的信息计算单位时间回报，而不是只看月薪数字。',
    appliesWhen: '文本中出现薪酬或工时信息',
    steps: [
      '提取月薪、工作天数、每日时长、休息计入、加班、节假日补贴、社保扣除',
      '分情景 A 理想 / B 正常 / C 最差 给出单位时间回报区间',
      '写明每个情景假设了哪些条件',
    ],
    forbidden: ['用名义月薪直接下结论', '忽略午休是否计入、加班是否另计'],
    scoreKeys: [],
    checklists: ['compensation_inputs'],
  },
  {
    id: 'D11',
    kind: 'opportunity',
    key: 'questions',
    name: '还需要问清的问题',
    goal: '产出具体到可以直接复制发送的问题，用于补齐缺口和验证疑点。',
    appliesWhen: 'always',
    steps: [
      '按五类分组：工作量与 KPI / 薪酬与福利 / 时间与排班 / 环境与内容 / 组织与岗位',
      '优先覆盖信息不一致处与影响收入的因素',
      '每条标优先级，并写明要验证哪个维度',
    ],
    forbidden: ['开放式提问（如「工作环境怎么样」）', '问题无法直接复制发送'],
    scoreKeys: [],
    checklists: ['question_categories'],
  },
  {
    id: 'D12',
    kind: 'opportunity',
    key: 'decision',
    name: '情景推演与决策表',
    goal: '不给「去 / 不去」的简单结论，而是给出三种情景推演与三档条件决策表。',
    appliesWhen: 'always',
    steps: [
      '情景 A：对方描述基本可信 → 成立条件、实际会是什么样、适合什么人',
      '情景 B：描述存在明显水分 → 会出现什么、最坏情况怎么应对',
      '情景 C：当事人有特定优先需求 → 最该重点观察哪些指标、什么信号该止损',
      '填决策表三档：可以考虑 / 需要谨慎 / 明显不匹配',
    ],
    forbidden: ['替当事人宣布最终决定', '为了让报告好看而凑出推荐项', '给出多于一个的「下一步动作」'],
    scoreKeys: [],
    checklists: ['decision_tiers', 'scenario_types'],
  },
];

// ---------------------------------------------------------------------------
// 表现侧：P1–P6（本场景新增）
// ---------------------------------------------------------------------------

/**
 * 表现侧维度衡量的都是「能不能说出可核对的东西」，
 * 而不是「听起来自不自信」—— 后者无法复核，写进报告只会误导人。
 */
export const PERFORMANCE_DIMENSION_DEFS: DebriefDimensionDef[] = [
  {
    id: 'P1',
    kind: 'performance',
    key: 'structure',
    name: '回答结构',
    goal: '看回答有没有「先给结论、再给依据」的骨架，还是想到哪说到哪。',
    appliesWhen: '存在我方的回答段落',
    steps: [
      '统计有显式结构标记的回答轮数（首先/其次/第一/结论是……）',
      '检查是否出现「答完之后才回到问题本身」的绕圈',
      '把长于 200 字却没有分层标记的回答单独列出',
    ],
    forbidden: ['把口音、语速、口头禅当成减分项', '把「答得短」直接判定为答得不好'],
    scoreKeys: ['structure'],
    checklists: [],
  },
  {
    id: 'P2',
    kind: 'performance',
    key: 'specificity',
    name: '事实密度',
    goal: '回答里有多少是别人可以核对的（数字、时间、动作、交付物），多少只是形容词。',
    appliesWhen: '存在我方的回答段落',
    steps: [
      '逐轮标记是否含数字 / 时间 / 具体动作 / 交付物',
      '列出只有评价性词汇（「挺好的」「比较熟悉」）而没有事实的轮次',
      '给出事实密度（含事实轮数 ÷ 回答轮数）',
    ],
    forbidden: ['把「听起来很流畅」等同于「内容扎实」', '用行业黑话的数量充当事实'],
    scoreKeys: ['specificity'],
    checklists: [],
  },
  {
    id: 'P3',
    kind: 'performance',
    key: 'job_alignment',
    name: '岗位对齐度',
    goal: '有没有把经历和这个岗位要的东西对上，而不是讲了一个无关的完整故事。',
    appliesWhen: '已有该岗位的要求列表',
    steps: [
      '把岗位要求的关键词与我方回答做交集',
      '列出「岗位问了 / 要求了，但我在回答里没回应」的关键词',
      '检查是否出现把要求直接当结论复述（「我有很强的学习能力」）',
    ],
    forbidden: ['因为没提到关键词就判定能力不足', '把岗位名称的重复出现当成对齐'],
    scoreKeys: ['job_alignment'],
    checklists: [],
  },
  {
    id: 'P4',
    kind: 'performance',
    key: 'depth',
    name: '深度与取舍',
    goal: '能不能讲清「为什么这么做」和「当时还考虑过什么别的做法」。',
    appliesWhen: '存在我方的回答段落',
    steps: [
      '统计出现取舍 / 权衡 / 替代方案 / 原因解释的回答轮数',
      '找出只描述「做了什么」而没有「为什么」的轮次',
      '检查是否出现把结果归因于运气的表述',
    ],
    forbidden: ['把「用了很多工具」当成深度', '代替当事人编造取舍理由'],
    scoreKeys: ['depth'],
    checklists: [],
  },
  {
    id: 'P5',
    kind: 'performance',
    key: 'boundary',
    name: '认知边界',
    goal: '对不会的部分是怎么处理的 —— 承认边界是加分项，硬撑是减分项。',
    appliesWhen: '存在我方的回答段落',
    steps: [
      '统计明确承认不确定 / 没做过的回答轮数',
      '检查是否存在含糊过去、把话题转开的轮次（回避型）',
      '检查是否存在超出实际经历范围的断言（夸大型）',
    ],
    forbidden: ['把承认不会当成能力不足', '把回避判定为撒谎'],
    scoreKeys: ['boundary'],
    checklists: [],
  },
  {
    id: 'P6',
    kind: 'performance',
    key: 'interaction',
    name: '交互与主动信息获取',
    goal: '有没有答到点上、有没有展开过度，以及有没有主动问清关键信息。',
    appliesWhen: '存在我方或后段问答',
    steps: [
      '标记明显超出提问范围的回答（展开过度）',
      '标记答非所问的轮次',
      '统计我方主动提问的次数与内容，判断是否覆盖了岗位的关键未知项',
    ],
    forbidden: ['把「问题少」当成不感兴趣', '把「问得多」当成加分'],
    scoreKeys: ['interaction'],
    checklists: [],
  },
];

export const DEBRIEF_DIMENSIONS: DebriefDimensionDef[] = [
  ...OPPORTUNITY_DIMENSIONS,
  ...PERFORMANCE_DIMENSION_DEFS,
];

export function debriefDimensionDef(id: string): DebriefDimensionDef | undefined {
  return DEBRIEF_DIMENSIONS.find((d) => d.id === id);
}

// ---------------------------------------------------------------------------
// 清单：硬性要求 / 隐性要求
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  key: string;
  item: string;
  point: string;
}

export const HARD_REQUIREMENT_CHECKLIST: ChecklistItem[] = [
  { key: 'daily_hours', item: '每天工作多少小时', point: '对方声称的时长 vs 排班安排' },
  { key: 'rest_days', item: '每月休息多少天', point: '不同发言人说法是否一致' },
  { key: 'fixed_shift', item: '是否固定排班', point: '班次类型、轮换频率' },
  { key: 'holiday_work', item: '是否需要节假日工作', point: '节假日安排与补偿' },
  { key: 'daily_quota', item: '每日任务或指标数量', point: '联系数、工单数、产出件数' },
  { key: 'revenue_kpi', item: '是否有业绩或创收指标', point: '回款 / 销售额要求' },
  { key: 'per_item_duration', item: '是否有单次处理时长要求', point: '通话最低时长、响应时限' },
  { key: 'success_rate', item: '是否有成功率或完成率要求', point: '接通率、转化率、通过率' },
  { key: 'qa_audit', item: '是否有质量审核或抽检', point: '质检形式、标准、是否影响收入' },
  { key: 'kpi_aggregate', item: '是否有 KPI', point: '所有量化考核汇总' },
  { key: 'penalty', item: '是否有迟到或未完成任务的处罚', point: '扣钱 / 警告 / 淘汰' },
  { key: 'overtime', item: '是否需要加班', point: '要求与补偿方式' },
  { key: 'training', item: '是否需要培训', point: '时长、是否带薪、有无绑定条件' },
  { key: 'tools', item: '是否需要使用特定系统或工具', point: '系统名称与操作复杂度' },
];

export const IMPLICIT_REQUIREMENT_CHECKLIST: ChecklistItem[] = [
  { key: 'continuous_output', item: '是否需要持续主动输出', point: '是否要求不停沟通或产出' },
  { key: 'rejection', item: '是否经常面对否定或驳回', point: '方案被拒、代码被打回、客户拒绝' },
  { key: 'negative_emotion', item: '是否需要处理负面情绪', point: '是否经常面对愤怒、质疑、投诉' },
  { key: 'persuasion', item: '是否需要说服或影响他人', point: '工作成效是否依赖改变对方意愿' },
  { key: 'fast_reaction', item: '是否需要快速反应', point: '临场应变、即时作答' },
  { key: 'sustained_attention', item: '是否需要长期保持注意力', point: '长时间连续专注' },
  { key: 'complex_memory', item: '是否需要记忆复杂流程', point: '流程、规范、话术的记忆量' },
  { key: 'multitasking', item: '是否需要多任务或多工具切换', point: '并行系统、并行事项' },
  { key: 'monitoring_tolerance', item: '是否需要承受过程监控', point: '实时查看进度、录音质检' },
  { key: 'dual_pressure', item: '是否存在数量与质量双重考核', point: '既要求快又要求好' },
];

// ---------------------------------------------------------------------------
// D4 压力画像（9 类）+ 规则引擎用的命中词
// ---------------------------------------------------------------------------

export interface StressType {
  key: string;
  label: string;
  probe: string;
  /** 规则引擎用它做证据归类；顺序即展示顺序 */
  patterns: RegExp[];
}

export const STRESS_TYPES: StressType[] = [
  {
    key: 'quantity',
    label: 'A. 数量压力',
    probe: '每天必须完成多少任务',
    patterns: [/每天.{0,6}\d+\s*(个|条|单|件|篇|次)/, /(任务量|工作量|指标|KPI|考核|配额|定额)/],
  },
  {
    key: 'time',
    label: 'B. 时间压力',
    probe: '是否存在单位时间内必须完成的要求',
    patterns: [/(小时内|当天|deadline|截止|限期|及时|限时|响应时间|秒回|多久之内)/i],
  },
  {
    key: 'performance',
    label: 'C. 业绩压力',
    probe: '是否必须完成一定金额或转化结果',
    patterns: [/(业绩|销售额|转化率|回款|签约|成单|GMV|流水|客单)/i],
  },
  {
    key: 'emotion',
    label: 'D. 情绪压力',
    probe: '是否经常面对否定、拒绝、投诉',
    patterns: [/(拒绝|投诉|被骂|指责|冲突|脾气|情绪|刁难|难缠)/],
  },
  {
    key: 'monitoring',
    label: 'E. 监控压力',
    probe: '是否被实时查看进度或录音质检',
    patterns: [/(质检|抽检|录音|监控|跟踪|日报|周报|看板|打卡|工时)/],
  },
  {
    key: 'attention',
    label: 'F. 注意力压力',
    probe: '是否需要长时间连续重复专注',
    patterns: [/(长时间|连续|专注|盯|重复|单调|枯燥|机械)/],
  },
  {
    key: 'communication',
    label: 'G. 沟通压力',
    probe: '是否需要临场解释、争辩、说服',
    patterns: [/(沟通|对接|协调|说服|谈判|汇报|跨部门|讲解|答疑)/],
  },
  {
    key: 'schedule',
    label: 'H. 排班压力',
    probe: '是否存在长期早晚班、轮班、节假日工作',
    patterns: [/(排班|轮班|倒班|加班|大小周|单休|值班|节假日|早班|晚班|996)/],
  },
  {
    key: 'physical',
    label: 'I. 身体压力',
    probe: '是否需要久坐、久站、重体力或高频移动',
    patterns: [/(久坐|久站|出差|搬运|体力|通勤|外勤|站岗|走动)/],
  },
];

/** 9 类压力的 key，顺序即雷达图轴序（供渲染与校验使用） */
export const STRESS_TYPE_KEYS: string[] = STRESS_TYPES.map((s) => s.key);

// ---------------------------------------------------------------------------
// D6 工作类型分类（16 类，补了规则引擎用的命中词）
// ---------------------------------------------------------------------------

export interface WorkType {
  key: string;
  label: string;
  trait: string;
  patterns: RegExp[];
}

export const WORK_TYPE_TAXONOMY: WorkType[] = [
  { key: 'customer_service', label: '客户服务类', trait: '以接听或回复客户咨询为主', patterns: [/(客服|接听|接待|咨询|工单|售后咨询)/] },
  { key: 'after_sales', label: '售后/运维类', trait: '处理售后问题、维护客户或系统稳定', patterns: [/(售后|运维|维护|故障|报修|上线支持)/] },
  { key: 'sales', label: '销售/商务类', trait: '以促成交易、签单、拓展客户为主', patterns: [/(销售|签单|拓客|转化|成单|商务拓展|BD)/i] },
  { key: 'collection_risk', label: '追款/风控类', trait: '以追回欠款、降低坏账风险为主', patterns: [/(催收|追款|欠款|坏账|风控|审核风险)/] },
  { key: 'complaint_pr', label: '客诉/公关类', trait: '处理投诉与危机沟通', patterns: [/(客诉|公关|危机|舆情|投诉处理)/] },
  { key: 'biz_communication', label: '商务沟通类', trait: '以谈判、合作洽谈、对外联络为主', patterns: [/(谈判|洽谈|合作|对外联络|对接客户|拜访)/] },
  { key: 'operations', label: '运营类', trait: '以内容、用户、活动运营为主', patterns: [/(运营|活动策划|用户增长|社群|内容排期)/] },
  { key: 'data_analysis', label: '数据/分析类', trait: '以数据处理、分析、报表为主', patterns: [/(数据分析|报表|统计|指标体系|取数|建模)/] },
  { key: 'audit_qc', label: '审核/质检类', trait: '以内容审核、质量检查为主', patterns: [/(审核|质检|合规检查|抽检)/] },
  { key: 'general_support', label: '综合支持类', trait: '行政、人事、财务等支持职能', patterns: [/(行政|人事|财务|报销|档案|办公)/] },
  { key: 'project_management', label: '项目管理类', trait: '以规划、进度跟踪、协调资源为主', patterns: [/(项目管理|进度|排期|协调资源|里程碑)/] },
  { key: 'engineering', label: '技术开发类', trait: '以编码开发、系统架构为主', patterns: [/(开发|编码|架构|接口|部署|代码|重构|系统设计)/] },
  { key: 'design', label: '创意设计类', trait: '以视觉设计、创意策划为主', patterns: [/(设计|视觉|创意|原型|交互稿)/] },
  { key: 'content_creation', label: '内容创作类', trait: '以文章撰写、视频制作、脚本为主', patterns: [/(撰写|稿件|文案|视频|脚本|选题)/] },
  { key: 'production', label: '生产制造类', trait: '以加工、装配、质检为主', patterns: [/(生产|装配|加工|车间|产线|工序)/] },
  { key: 'logistics', label: '物流配送类', trait: '以仓储、分拣、配送为主', patterns: [/(仓储|分拣|配送|物流|派件|干线)/] },
];

// ---------------------------------------------------------------------------
// D7 个体适配（10 维）
// ---------------------------------------------------------------------------

export interface FitDimension {
  key: string;
  label: string;
  point: string;
  /** 规则引擎判断该维度是否被这次面试触及（有证据可判）*/
  patterns: RegExp[];
  /** 当事人档案里命中这些词的偏好/边界会直接压低该维度 */
  boundaryPatterns?: RegExp[];
}

export const FIT_DIMENSIONS: FitDimension[] = [
  {
    key: 'skill',
    label: '① 技能适配度',
    point: '现有技能与该角色要求的重合度',
    patterns: [/(技术|技能|工具|系统|专业|熟练|掌握)/],
  },
  {
    key: 'communication',
    label: '② 沟通适配度',
    point: '所需的沟通量与强度',
    patterns: [/(沟通|对接|协调|汇报|电话|会议)/],
    // 「不做电销 / 地推 / 强社交销售」是典型的心理边界：命中时该维度不得给 4 分以上
    boundaryPatterns: [/(不(喜欢|想|愿意|擅长)|讨厌|受不了|避免|拒绝).{0,12}(社交|沟通|对接|电话|销售|地推|客户|会议)/, /(不做|别让我做).{0,8}(电销|地推|销售|客服)/],
  },
  {
    key: 'repetition',
    label: '③ 重复劳动适配度',
    point: '工作重复性与个人耐受度',
    patterns: [/(重复|日常|流程化|标准动作|批量)/],
    boundaryPatterns: [/(不(喜欢|想|愿意)|讨厌|受不了).{0,12}(重复|机械|枯燥|单调|流水线)/],
  },
  {
    key: 'attention',
    label: '④ 注意力适配度',
    point: '注意力要求与个人习惯是否相合',
    patterns: [/(专注|长时间|盯|细致|耐心)/],
    boundaryPatterns: [/(坐不住|容易分心|专注不下来|不擅长长时间)/],
  },
  {
    key: 'emotion_pressure',
    label: '⑤ 情绪压力适配度',
    point: '情绪消耗与个人承受力',
    patterns: [/(拒绝|投诉|冲突|情绪|压力)/],
    boundaryPatterns: [/(不(想|喜欢|愿意)|受不了|承受不了).{0,12}(被拒|拒绝|投诉|情绪|冲突|指责|压力)/],
  },
  {
    key: 'kpi',
    label: '⑥ KPI 适配度',
    point: '量化考核压力与个人工作风格',
    patterns: [/(KPI|指标|考核|业绩|达标)/i],
    boundaryPatterns: [/(不(喜欢|想|愿意)|受不了|抗拒).{0,12}(KPI|指标|考核|业绩|被追|达标)/i],
  },
  {
    key: 'schedule',
    label: '⑦ 排班适配度',
    point: '排班方式与个人生活安排',
    patterns: [/(排班|加班|单休|大小周|节假日|作息)/],
    boundaryPatterns: [/(不(接受|想|能)|不愿意|拒绝).{0,12}(加班|排班|轮班|倒班|大小周|单休|值班|通勤)/],
  },
  {
    key: 'physical',
    label: '⑧ 身体劳动适配度',
    point: '身体要求与个人体能',
    patterns: [/(久坐|久站|出差|通勤|体力|外勤)/],
    boundaryPatterns: [/(不(接受|想|能)|不愿意).{0,12}(出差|久站|体力|外勤|高强度)/],
  },
  {
    key: 'short_term_transition',
    label: '⑨ 短期过渡适配度',
    point: '作为短期过渡工作的整体适配',
    patterns: [],
  },
  {
    key: 'long_term_value',
    label: '⑩ 长期发展价值',
    point: '技能积累与可迁移性',
    patterns: [/(成长|学习|发展|晋升|积累|空间)/],
  },
];

/** 10 个适配维度的 key，顺序即雷达图轴序 */
export const FIT_DIMENSION_KEYS: string[] = FIT_DIMENSIONS.map((d) => d.key);

// ---------------------------------------------------------------------------
// D8 持续性推演的 5 条区分轴
// ---------------------------------------------------------------------------

export const SUSTAINABILITY_AXES: Array<{ key: string; label: string; theoretical: string; sustained: string }> = [
  { key: 'energy', label: '体力/精力', theoretical: '某一天咬牙能撑住', sustained: '连续 22 天都能保持基本状态' },
  { key: 'emotion', label: '情绪', theoretical: '偶尔面对负面情绪能处理', sustained: '每天面对负面情绪不会持续积压' },
  { key: 'psych', label: '心理压力', theoretical: '知道目标后觉得应该能完成', sustained: '不需要每天靠意志力硬扛' },
  { key: 'body', label: '身体反应', theoretical: '没有明显身体不适', sustained: '不会出现失眠、头痛、持续性疲劳' },
  { key: 'satisfaction', label: '工作满意度', theoretical: '不讨厌这份工作', sustained: '对工作内容不产生强烈抵触' },
];

// ---------------------------------------------------------------------------
// D9 话术风险信号库（12 类）
// ---------------------------------------------------------------------------

export interface RiskSignal {
  key: string;
  label: string;
  patterns: RegExp[];
  /** 正面理解 —— 必须给，否则就成了「单条话术定性为欺骗」 */
  positive: string;
  /** 反面理解 */
  negative: string;
  /** 要怎么验证：问什么 / 观察什么 */
  verify: string;
}

export const RISK_SIGNALS: RiskSignal[] = [
  {
    key: 'hedge_words',
    label: '模糊限定词',
    patterns: [/平均|大概|预估|正常情况下|差不多|基本上|一般来说|通常/],
    positive: '对方在描述一个波动区间，而不是承诺一个固定值',
    negative: '模糊词后面往往藏着比字面更高的实际要求',
    verify: '追问：这个「平均」是怎么算出来的？最好的一天和最差的一天分别是多少？',
  },
  {
    key: 'no_pressure_claim',
    label: '否认压力型',
    patterns: [/没有(业绩|销售|任务)?压力|不(需要|用)?加班|很轻松|不会有压力|没那么多事/],
    positive: '岗位确实处于业务平稳期',
    negative: '压力转嫁给了「自愿」「配合」这类不写进合同的表述',
    verify: '追问：上一个做这个岗位的人，通常几点下班？最近三个月有人离职吗？',
  },
  {
    key: 'personal_ability',
    label: '归因个人型',
    patterns: [/看个人(能力|努力|情况)|主要看个人|新人(前期)?会有人带|靠自己|因人而异/],
    positive: '确实存在不同的成长速度',
    negative: '把「没有配套支持」说成了「给你发挥空间」',
    verify: '追问：带我的人是谁、他有多少时间带我？有没有书面的上手流程？',
  },
  {
    key: 'base_task_claim',
    label: '基础任务型',
    patterns: [/完成基础(任务|量)(即可|就行)|做完(就|即可)(可以|能)|把基本(的)?做好/],
    positive: '确实不追求超额',
    negative: '「基础」没有量化，实际标准可能由主管随时调整',
    verify: '追问：基础任务具体是哪几项、每天多少量、谁来判定完成没完成？',
  },
  {
    key: 'salary_range',
    label: '宽幅薪资型',
    patterns: [/上不封顶|不封顶|底薪?\s*\d{3,6}\s*[-~到至]\s*\d{3,6}|\d{4,6}\s*[-~到至]\s*\d{4,6}/],
    positive: '确实存在靠业绩上浮的空间',
    negative: '区间下端是保底、上端是理想值，两者对应的工作强度完全不同',
    verify: '追问：这个区间的下限和上限分别对应什么条件？书面写进合同的是哪一部分？',
  },
  {
    key: 'flexible_time_claim',
    label: '弹性时间型',
    patterns: [/(做完|忙完)(就|可以)(自由|自己)安排|时间(比较|很)灵活|弹性(工作|上班)/],
    positive: '确实不强制坐班',
    negative: '「弹性」常常是单向的：可以晚来，但要交完活才能走',
    verify: '追问：核心协作时段是几点到几点？昨天这个岗位的人是几点走的？',
  },
  {
    key: 'preemptive_denial',
    label: '预先否认型',
    patterns: [/并不是|不是那种|我们不(是|做)(那种)?|不存在的/],
    positive: '对方在主动澄清外界的误解',
    negative: '主动否认的内容，往往正是这个岗位最容易被抱怨的地方',
    verify: '追问：那具体是什么样？能举一个上周发生过的例子吗？',
  },
  {
    key: 'inconsistency',
    label: '说法不一致型',
    patterns: [],
    positive: '可能是不同角色的视角差异',
    negative: '同一个事实出现两种说法时，需要以更保守的那个来估',
    verify: '把两份说法分别复述一遍，请对方解释差异来自哪里。',
  },
  {
    key: 'conditional_promise',
    label: '条件承诺型',
    patterns: [/如果.{0,24}(就|可以|能)|只要.{0,16}(就|可以)/],
    positive: '确实是按结果给回报的机制',
    negative: '条件是对方单方面定义的，「表现好」通常没有客观标准',
    verify: '追问：这个条件由谁判定、多久评一次、上一次有几个人满足？',
  },
  {
    key: 'evasion',
    label: '回避具体型',
    patterns: [/(看情况|再说|到时候|这个不好说|差不多吧|你来了就知道)/],
    positive: '确实受很多变量影响，难以提前给出',
    negative: '具体的、可验证的信息被绕开了',
    verify: '换一种问法再问一次同一个点，看回答是否仍然没有信息量。',
  },
  {
    key: 'growth_over_content',
    label: '只谈成长型',
    patterns: [/(成长|空间大|机会多|平台好|能学到|锻炼人)/],
    positive: '岗位确实能带来经验积累',
    negative: '用「成长」替代了实际工作内容与回报的说明',
    verify: '追问：这份工作每天具体在做什么？三个月后我会比现在多会什么？',
  },
  {
    key: 'culture_wrapping',
    label: '文化包装型',
    patterns: [/(狼性|奋斗者|拼搏|公司就是家|抗压能力(要)?强|能吃苦|all\s*in)/i],
    positive: '团队凝聚力强、目标一致',
    negative: '这类词常被用来为无补偿的超时工作做铺垫',
    verify: '追问：加班是怎么算的？上个月团队平均加班多少小时？',
  },
];

// ---------------------------------------------------------------------------
// D10 回报测算输入项
// ---------------------------------------------------------------------------

export const COMPENSATION_INPUTS: ChecklistItem[] = [
  { key: 'salary', item: '月薪', point: '底薪、绩效范围、综合到手' },
  { key: 'work_days', item: '工作天数', point: '月休天数' },
  { key: 'daily_hours', item: '每天工作时长', point: '班次时长、是否含午休' },
  { key: 'break_included', item: '是否包含休息时间', point: '午休时长、自由支配时间' },
  { key: 'overtime', item: '加班', point: '是否需要加班、加班费计算方式' },
  { key: 'holiday_pay', item: '节假日补贴', point: '节假日工资计算方式' },
  { key: 'social_insurance', item: '社保扣除', point: '五险一金个人承担部分' },
];

/** 工作日按 8 小时计 —— 测算表的基准，也是「物理可行」的判断依据 */
export const WORKDAY_MINUTES = 480;

// ---------------------------------------------------------------------------
// D12 决策表与情景
// ---------------------------------------------------------------------------

export const DECISION_TIERS: Array<{ key: 'consider' | 'caution' | 'mismatch'; label: string; rule: string }> = [
  { key: 'consider', label: '可以考虑', rule: '哪些条件满足时，可以进入下一步' },
  { key: 'caution', label: '需要谨慎', rule: '哪些条件出现时，需要先验证再决定' },
  { key: 'mismatch', label: '明显不匹配', rule: '哪些条件出现时，说明这条路不值得投入' },
];

export const SCENARIO_TYPES: Array<{ key: 'A' | 'B' | 'C'; label: string; fields: string[] }> = [
  { key: 'A', label: '对方描述基本可信', fields: ['成立条件', '实际会是什么样', '适合什么人'] },
  { key: 'B', label: '描述存在明显水分', fields: ['会出现什么', '最坏情况', '如何应对'] },
  { key: 'C', label: '我有特定的优先需求', fields: ['最该重点观察的指标', '判断是否止损的信号'] },
];

// ---------------------------------------------------------------------------
// 表现侧规则引擎用的词表
// ---------------------------------------------------------------------------

/** P1 结构标记 */
export const STRUCTURE_MARKERS: RegExp[] = [
  /(首先|其次|然后|最后|第一|第二|第三|一是|二是|三是|分[两三四]点|总的来说|结论是|简单说)/,
];

/** P2 事实信号：数字 + 单位、时间点、交付动作 */
export const FACT_PATTERNS: RegExp[] = [
  /\d+(\.\d+)?\s*(%|％|个|条|人|天|周|月|年|次|小时|分钟|秒|万|亿|元|页|份|版|台|套|倍|k|K|w|W|万)/,
  /(\d{4}\s*年|去年|前年|上个月|上周|本季度|Q[1-4]|第[一二三四]季度)/i,
  /(上线|交付|发布|落地|部署|提交|产出|交付物|验收|结项|交付给)/,
];

/** P2 减分信号：只有评价性词汇，没有可核对内容 */
export const VAGUE_PATTERNS: RegExp[] = [
  /(挺好的|还不错|比较熟悉|比较了解|会一点|基本都|应该可以|大概了解|略懂|都知道一点)/,
];

/** P4 深度信号 */
export const DEPTH_PATTERNS: RegExp[] = [
  /(取舍|权衡|替代方案|对比过|方案[ABC]|备选|改成|优化|because|因为|原因是|踩坑|踩过坑|调优|重构|评估过|考虑过|为什么不)/i,
];

/** P5 边界信号（承认不会 = 加分） */
export const BOUNDARY_PATTERNS: RegExp[] = [
  /(不确定|没深入|不太了解|没做过|没接触过|还没|不清楚|说不准|可能有错|需要再确认|这是我的盲区|没想过这个)/,
];

/** P5 回避信号（含糊过去） */
export const EVASION_PATTERNS: RegExp[] = [
  /(这个不太好说|看情况|都可以|到时候再说|不太记得|一般般|反正就是)/,
];

/** P6 过度展开的信号（辅助判断，不单独定性） */
export const OVEREXPAND_MARKERS: RegExp[] = [/^(另外|顺便|还有一点|补充一下|说到这个)/];

/** 我方提问的标记（P6 主动信息获取） */
export const CANDIDATE_QUESTION_PATTERNS: RegExp[] = [
  /[?？]\s*$/,
  /(请问|想了解一下|想问一下|能不能介绍|大概是什么|具体是)/,
];

/** 说话人推断：面试方的问句特征 */
export const INTERVIEWER_PATTERNS: RegExp[] = [
  /(请你|你能|你有没有|你觉?得|你会|介绍一下|说一下|举个例子|为什么|怎么看|如何|能不能讲|你之前|你们公司)/,
  /(我们(这边|公司)|这个岗位|入职后|试用期|薪资|待遇|到岗|面试)/,
];

// ---------------------------------------------------------------------------
// 工作量测算表（D3 用；按每日 8 小时连续处理）
// ---------------------------------------------------------------------------

/**
 * 按 170 项/日标定的时间表。换其他日指标数量时按同比例缩放 ——
 * 缩放依据必须写进 `computation.inputs`，不许直接换数字。
 */
export const WORKLOAD_TIME_BASELINE_QUOTA = 170;

export const WORKLOAD_TIME_TABLE: Array<{
  perItemSeconds: number;
  pureMinutes: number;
  remainingMinutes: number | null;
  feasibility: string;
}> = [
  { perItemSeconds: 30, pureMinutes: 85, remainingMinutes: 365, feasibility: '轻松完成' },
  { perItemSeconds: 60, pureMinutes: 170, remainingMinutes: 280, feasibility: '可以完成' },
  { perItemSeconds: 120, pureMinutes: 340, remainingMinutes: 110, feasibility: '紧张但可行' },
  { perItemSeconds: 180, pureMinutes: 510, remainingMinutes: null, feasibility: '不可能完成' },
];

function scaleMinutes(base: number, quota: number): number {
  return Math.round((base * quota) / WORKLOAD_TIME_BASELINE_QUOTA);
}

/** 按实际日指标数量缩放整张表 */
export function workloadTimeTable(quota: number): Array<Record<string, number | string | null>> {
  const safe = quota > 0 ? quota : WORKLOAD_TIME_BASELINE_QUOTA;
  return WORKLOAD_TIME_TABLE.map((row) => {
    const pure = scaleMinutes(row.pureMinutes, safe);
    const remaining = WORKDAY_MINUTES - pure;
    return {
      perItemSeconds: row.perItemSeconds,
      pureMinutes: pure,
      remainingMinutes: remaining,
      feasibility: remaining <= 0 ? '不可能完成' : row.feasibility,
    };
  });
}

/** 压力等级的定级顺序，供排序与展示使用 */
export const PRESSURE_ORDER: DebriefPressureLevel[] = ['high', 'medium', 'low', 'unknown'];
