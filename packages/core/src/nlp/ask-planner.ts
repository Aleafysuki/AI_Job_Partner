/**
 * 动态出题（v0.3）
 * ================
 *
 * 这个模块存在的原因是一句用户实测反馈：
 * 「我填写了擅长人际交往，他却开始问对人际交往这项能力的掌握程度，是属于了解、熟悉、熟练这样子的问题，我觉得不是很合适。」
 *
 * 这句反馈指出的不是「题目不够多」，而是**原来的题目模型本身有问题**：
 * 问诊被设计成固定的五层模板（自评 → 场景 → 深度 → 产出 → 边界），
 * 其中第一层对所有能力一律问「你有多熟练」。
 * 对 RAG、Redis 这类有客观分水岭的能力，这个问法尚可；
 * 对「人际交往」「沟通表达」这类没有「熟练度阶梯」的能力，它只能得到一个自我感觉，
 * 问了也是白问 —— 用户答「熟练」，系统依然不知道任何新东西。
 *
 * 因此本模块做四件事：
 *
 *   1. **按能力形状决定问什么**，而不是按固定层数。
 *      软技能不出自评题，直接问「最近一次具体发生了什么」——
 *      因为人际交往的掌握程度只能由具体事例证明，不能由形容词证明。
 *
 *   2. **优先让用户点选而不是填空**。
 *      用户填一整段话的成本极高，这是「用起来费脑子」的主要来源。
 *      所以先从档案已有证据里抽候选，点一下就完成一道题。
 *
 *   3. **每道题都自带预置选项**（v0.4）。
 *      档案里抽不出候选时（用户从没写过相关经历），仍然能从几句现成的
 *      常见情形里挑一个完成这道题 —— **连回忆都不必**。
 *      这条是为了解决「提的问题对用户来说还是太繁重」：
 *      上一轮只做了「从自己档案里抽」，但用户真正卡住的往往正是档案里没写过的部分。
 *
 *   4. **模型可用时按这个能力的真实分水岭出题**，不可用时回落到本地规则，
 *      两套都产出同一种结构，界面不需要区分。
 *
 * 刻意保留的约束：题目由模型生成，但**结论仍然由本地规则算**。
 * 模型只决定「问什么」，不决定「答完算几级」。
 */

import type { QuickChoice } from '../domain/interview';

/** 能力形状 —— 比 SkillKind 更细一档，决定「该怎么问」 */
export type AskShape =
  /** 有客观分水岭的技术能力：可以问熟练度阶梯 */
  | 'technical'
  /** 软技能：熟练度不可自证，只能问具体事例 */
  | 'behavioral'
  /** 需要考试/证书才能证明的能力 */
  | 'credential'
  /** 行业知识：问「在什么场景里、扮演什么角色」 */
  | 'domain';

export const ASK_SHAPE_LABEL: Record<AskShape, string> = {
  technical: '技术能力',
  behavioral: '行为能力',
  credential: '资质能力',
  domain: '领域知识',
};

const SOFT_MARKERS =
  /(沟通|表达|协作|团队|独立解决|学习能力|责任心|抗压|细致|严谨|时间管理|人际|社交|领导|影响|主动|自驱|耐心)/;

/** 这项能力是不是「只能靠具体事例证明」的那一类 */
export function askShapeOf(skillName: string, kindHint?: string): AskShape {
  if (kindHint === 'certificate') return 'credential';
  if (kindHint === 'domain') return 'domain';
  if (kindHint === 'soft') return 'behavioral';
  if (SOFT_MARKERS.test(skillName)) return 'behavioral';
  return 'technical';
}

/**
 * 软技能不该问「你有多熟练」。
 *
 * 这一段是替换掉原 SELF_REPORT_OPTIONS 在软技能场景的唯一入口 ——
 * 保留原来的通用阶梯给技术能力用，不删除（见 skill-questions.ts 的说明）。
 */
export const BEHAVIORAL_SCALE_OPTIONS = [
  '有，但很难举出一个说得上「我主导了」的例子',
  '有，能想起 1–2 件事，但对方不是关键角色',
  '有，我在那件事里承担了主要沟通/推动的责任',
  '有，我靠它直接决定了结果（谈成、推动落地、化解冲突）',
];

// ---------------------------------------------------------------------------
// 本地出题：按能力形状给出题面
// ---------------------------------------------------------------------------

/**
 * 本地出题的题面规格。
 *
 * 导出原因：skill-questions.ts 与 skill-interview.ts 都要遍历它，
 * 而 `layer` 这个联合类型还被当作 Map 的键类型使用 ——
 * 不导出会被 TS 当成表达式解析（报 TS1109，很难一眼看出真因）。
 */
export interface LocalQuestionSpec {
  layer: 'self_report' | 'fact' | 'depth' | 'output' | 'boundary';
  prompt: string;
  hint?: string;
  critical?: boolean;
  /**
   * v0.4 追加：可点选的候选答案。
   *
   * 这一条是为了「减少经历消耗」而设计的 —— 用户反馈「提的问题对于用户来说还是太繁重了」。
   *
   * 关键在于这**不是普通的自评选项**：每一项都是一句已经写好的、
   * 含场景与动作的陈述。用户点一下，系统就把它当答案记录，
   * 而不需要用户自己回忆并组织语言。
   *
   * 三条约束：
   *   1. 任何一项都不得替用户编造具体经历（数字、公司名、项目名一律不许出现）；
   *   2. 必须有兜底项（「都不像 / 都不是」），否则用户会被迫选一个不准确的；
   *   3. 点选项只是快车道，界面上永远保留自由输入。
   */
  options?: QuickChoice[];
}

export type { QuickChoice };

/**
 * 「都不像」是必选项，不是可选项。
 *
 * 没有它，用户面对四个都不完全对的选项时，会选一个「最接近的」——
 * 那会往能力库里写进一条不真实的证据，比不填更糟。
 *
 * `isEscape` 与 `needsDetail` 的区别很重要：
 * 普通的 `needsDetail` 项只是「选了之后补一句」，
 * 而兜底项点下去必须**跳到输入框重写** —— 用户选它恰恰因为选项都不对。
 * 两者界面行为不同，所以标记必须区分，不能让界面去猜。
 */
export const NONE_OF_THESE: QuickChoice = {
  label: '以上都不像 —— 我自己写',
  needsDetail: true,
  isEscape: true,
};

/**
 * 技术能力：五层阶梯。
 *
 * 原 v0.2 的固定模板在这条路径上基本保留，因为它对技术能力是成立的 ——
 * 「你在哪个项目里用过它 / 踩过什么坑 / 结果是什么」对 RAG 是好问题。
 */
const TECHNICAL_SPEC: LocalQuestionSpec[] = [
  {
    layer: 'self_report',
    prompt: '关于「{skill}」，下面哪一句最接近你的实际情况？',
    hint: '先给个自评，后面几题会用来校正它。',
  },
  {
    layer: 'fact',
    prompt: '你最近一次用到「{skill}」是在什么场景？做的是什么事、用了它的哪一部分。',
    hint: '写清「对象 + 动作」就够，不用写成长文。',
    critical: true,
    options: [
      { label: '在实习或工作里用过它完成一项具体任务' },
      { label: '在课程作业或毕业设计里用过它做出一个能跑的东西' },
      { label: '自己练习过，做过小工具或练手项目' },
      { label: '只看过教程或文档，没有真正动手写过' },
      { label: '了解概念，但没有实际使用过', needsDetail: true },
      NONE_OF_THESE,
    ],
  },
  {
    layer: 'depth',
    prompt: '用「{skill}」的时候，你遇到过什么问题、做过什么非默认的调整？',
    hint: '说「踩过什么坑 / 怎么权衡」比罗列功能更有说服力。',
    options: [
      { label: '遇到过报错或异常，花时间定位到了原因并解决' },
      { label: '做过和默认写法不一样的地方，例如改了配置、换了实现方式、加了额外处理' },
      { label: '比较过两种做法，权衡之后选了其中一种' },
      { label: '遇到的问题都是照着教程/文档解决的，没有自己判断' },
      { label: '基本顺利，没遇到什么需要自己判断的地方', needsDetail: true },
      NONE_OF_THESE,
    ],
  },
  {
    layer: 'output',
    prompt: '这件事的结果是什么？有没有可以核对的东西 —— 数字、链接、能演示的交付物？',
    hint: '例如「响应从 1.2s 降到 180ms」「每天处理约 800 条」「代码仓库地址」。没有数字就把交付了什么说清楚。',
    critical: true,
    options: [
      { label: '有可访问的链接（代码仓库、线上地址、作品集）', needsDetail: true },
      { label: '有明确的量化结果，比如处理量、耗时、准确率、用户数' },
      { label: '交付了别人可以使用的东西（文档、接口、上线功能）', needsDetail: true },
      { label: '只在自己这边用过，交付对象只有自己或同学' },
      { label: '没有可核对的东西，说不清结果' },
      NONE_OF_THESE,
    ],
  },
  {
    layer: 'boundary',
    prompt: '「{skill}」里你目前还不确定、或者没深入过的部分是什么？',
    hint: '说得出边界比说「都懂」更可信。',
    options: [
      { label: '只在简单场景用过，复杂场景没试过' },
      { label: '会日常使用，但不了解底层实现' },
      { label: '用过一段时间，遇到超出经验的问题只能查资料解决' },
      { label: '基本都能自己判断，暂时说不上哪里不确定' },
      NONE_OF_THESE,
    ],
  },
];

/**
 * 行为能力：**不出自评题**。
 *
 * 这是本模块最重要的一条规则。人际交往、沟通表达这类能力，
 * 「熟悉/熟练」这种自评既不可靠也无信息量 —— 用户说「熟练」，
 * 系统得到的结论和用户什么都没说是一样的。
 * 所以直接从具体事例切入，而且明确要求给最近的、记得清的一件。
 */
const BEHAVIORAL_SPEC: LocalQuestionSpec[] = [
  {
    layer: 'fact',
    prompt: '最近三个月里，有哪件事需要你发挥「{skill}」？当时是什么情况、你具体做了哪几个动作。',
    hint: '挑一件你还记得细节的。对方是谁、在什么场合、你说了什么或做了什么 —— 这三点比形容词有用得多。',
    critical: true,
    options: [
      { label: '工作或实习中，需要我主动去推进别人不配合的事', needsDetail: true },
      { label: '小组作业或团队项目里，负责让成员对齐进度', needsDetail: true },
      { label: '对同学/朋友/长辈解释一件他们不懂的事，让他们理解了', needsDetail: true },
      { label: '冲突或误解需要我去协调，比如两个人闹别扭', needsDetail: true },
      { label: '需要说服别人接受我的看法，但对方一开始不同意', needsDetail: true },
      NONE_OF_THESE,
    ],
  },
  {
    layer: 'depth',
    prompt: '那件事里最难的一步是什么？对方是什么反应，你是怎么处理的。',
    hint: '「对方原本不同意 / 进度卡住 / 出现了误会」这类具体卡点最有价值。',
    options: [
      { label: '对方一开始不认同，我解释了理由后改变了态度' },
      { label: '信息不对称导致的误会，我查清楚后说明了' },
      { label: '事情卡住了，因为不知道该找谁，我主动去问了' },
      { label: '对方情绪比较大，我先把事情稳下来再谈' },
      { label: '其实没什么阻力，流程比较顺', needsDetail: true },
      NONE_OF_THESE,
    ],
  },
  {
    layer: 'output',
    prompt: '最后的结果怎么样？有没有别人给过你的反馈、一个具体的变化，或者一件本来会失败的事最后没失败。',
    hint: '不用非得有数字 ——「对方后来主动来找我了」「这件事最后谈成了」也是结果。',
    critical: true,
    options: [
      { label: '事情最后成了（谈成了 / 落地了 / 按时完成了）' },
      { label: '对方后来主动又来找我，说上次那件事帮到了他' },
      { label: '原本要出问题，最后没出问题' },
      { label: '没有明确结果，但对方的态度有变化，比如更愿意配合了' },
      { label: '最后没成，原因比较复杂', needsDetail: true },
      NONE_OF_THESE,
    ],
  },
  {
    layer: 'boundary',
    prompt: '在「{skill}」上，你觉得自己目前最没底的是哪种场合？',
    hint: '例如「跟上级提反对意见」「跟不熟的人冷启动」。这一条会记进档案的「待学习」。',
    options: [
      { label: '跟不熟的人开口，冷启动比较难' },
      { label: '跟上级或资历更深的人表达不同意见' },
      { label: '涉及利益或责任分配的话题' },
      { label: '情绪激动或对方有敌意的时候' },
      { label: '临场发挥，比如被问到没准备过的问题', needsDetail: true },
      NONE_OF_THESE,
    ],
  },
];

/** 资质能力：能不能被外部核对，一句话问清 */
const CREDENTIAL_SPEC: LocalQuestionSpec[] = [
  {
    layer: 'fact',
    prompt: '「{skill}」你是怎么拿到的？考试/评审的时间、形式是什么。',
    hint: '写清「什么时候考的、考的什么」即可。',
    critical: true,
    options: [
      { label: '参加统一考试并通过了' },
      { label: '完成评审/认证并获得了资格' },
      { label: '在院校或培训机构完成课程并结业' },
      { label: '是普���教育背景的一部分（学历、专业）' },
      NONE_OF_THESE,
    ],
  },
  {
    layer: 'output',
    prompt: '有没有证书编号、成绩，或者能查到这份资质的公开入口？没有就说「没有」。',
    hint: '这一条决定它算「可核对的证据」还是只算口头声明。',
    critical: true,
    options: [
      { label: '有证书编号或查询链接', needsDetail: true },
      { label: '有成绩单或证书，但对外查不到' },
      { label: '什么都拿不到，只有证书的照片' },
      { label: '没有证书，就是一段学习经历' },
      NONE_OF_THESE,
    ],
  },
  {
    layer: 'boundary',
    prompt: '这个资质要求的知识里，有哪部分你是实际用过、哪部分只是考过？',
    hint: '面试官会顺着这条往下问。',
    options: [
      { label: '全部都实际用过' },
      { label: '大部分用过，少数部分只是考试范围里有' },
      { label: '只是考过，实际没派上用场' },
      { label: '考的时候突击学的，现在忘得差不多了' },
      NONE_OF_THESE,
    ],
  },
];

/** 领域知识：问角色和场景，而不是问掌握程度 */
const DOMAIN_SPEC: LocalQuestionSpec[] = [
  {
    layer: 'fact',
    prompt: '你在什么场景下接触过「{skill}」？你在里面是什么角色 —— 旁观、参与，还是负责一块。',
    hint: '角色比「了解程度」更能说明你实际到过什么深度。',
    critical: true,
    options: [
      { label: '负责过其中一块，并且做完了' },
      { label: '参与过，全程都在，但不是我负责' },
      { label: '做过局部工作，比如只对接过其中一个环节' },
      { label: '旁观或学习过，没有实际交付' },
      { label: '只是了解这个词指的什么', needsDetail: true },
      NONE_OF_THESE,
    ],
  },
  {
    layer: 'depth',
    prompt: '这块事情里，有哪些「看着一样、实际完全不一样」的区别？你踩过哪一个。',
    hint: '这一题筛掉的是「只看过名词」的人。',
    options: [
      { label: '踩过：当时以为是一回事，做出来才发现不是' },
      { label: '踩过：因为概念混淆导致返工' },
      { label: '知道区别，但没亲自踩过' },
      { label: '说不出来，我可能只停留在表面理解', needsDetail: true },
      NONE_OF_THESE,
    ],
  },
  {
    layer: 'output',
    prompt: '你产出的东西有没有被用过 —— 交付过、汇报过、推动过一件事？',
    hint: '哪怕只是一份文档、一次讲解。',
    critical: true,
    options: [
      { label: '交付过给别人使用' },
      { label: '汇报或讲解过，别人据此做了决定' },
      { label: '推动过一件具体的事落地' },
      { label: '产出过东西但没人用（比如作业、练习）' },
      { label: '没有产出' },
      NONE_OF_THESE,
    ],
  },
  {
    layer: 'boundary',
    prompt: '「{skill}」里你目前还不确定、或者没深入过的部分是什么？',
    options: [
      { label: '只了解常用部分，行业内的细分领域没接触过' },
      { label: '了解流程，但不知道背后的原理' },
      { label: '只在一家公司/一种场景下接触过' },
      { label: '暂时说不上哪里不确定' },
      NONE_OF_THESE,
    ],
  },
];

function specFor(shape: AskShape): LocalQuestionSpec[] {
  switch (shape) {
    case 'behavioral':
      return BEHAVIORAL_SPEC;
    case 'credential':
      return CREDENTIAL_SPEC;
    case 'domain':
      return DOMAIN_SPEC;
    default:
      return TECHNICAL_SPEC;
  }
}

/** 覆盖数据里针对具体技能定制的深度题（命中时比通用题更有信息量） */
const CURATED_DEPTH: Record<string, string> = {
  Python: '用 Python 时你做过的结构或性能优化是什么？例如异步、生成器、类型标注、依赖与环境管理。',
  'RAG 检索增强': '你的 RAG 链路里：文档怎么切分、用什么做检索、召回好坏怎么评估？',
  '大语言模型应用': '调用大模型时你怎么控制输出稳定性？失败或幻觉出现时怎么兜底？',
  'Prompt Engineering': '同一个需求你会怎么迭代提示词？怎么判断改得更好还是更差？',
  'Agent 开发': '你的 Agent 怎么决定调用哪个工具？工具调用失败或多轮跑偏时怎么收敛？',
  Redis: '你用它做缓存时怎么定过期与更新策略？缓存穿透或击穿遇到过吗、怎么处理？',
  Docker: '你写的镜像和默认写法有什么不同？构建慢或体积大时怎么优化？',
  Git: '多人协作时你处理过什么棘手的冲突或历史问题？分支策略是怎么定的？',
  SQL: '你优化过哪条慢查询？为什么慢、改了什么、快了多少？',
  React: '你在 React 里做过什么性能优化？状态放哪里、为什么那样放？',
  '数据采集 / 爬虫': '目标站点反爬时你怎么处理？数据量上来后的稳定性怎么保证？',
  MySQL: '表结构和索引你是怎么设计的？为什么这样设计？',
  '模型量化/本地部署': '你在什么硬件上部署过？量化和速度、效果之间的取舍怎么定的？',
  Figma: '你交付设计稿时怎么处理开发还原度问题？组件和变量是怎么组织的？',
  '沟通表达': '举一次你让对方改变了主意的沟通 —— 你当时说了什么让对方改主意。',
  '团队协作': '举一次你和同伴意见不一致的事，最后是怎么收口的。',
  '独立解决问题': '举一次没人帮你、你自己从头定位到尾的问题 —— 你是靠什么找到那个原因的。',
};

export function localSpecsFor(skillName: string, shape: AskShape): LocalQuestionSpec[] {
  const specs = specFor(shape);
  return specs.map((spec) =>
    spec.layer === 'depth' && CURATED_DEPTH[skillName]
      ? { ...spec, prompt: CURATED_DEPTH[skillName] }
      : spec,
  );
}

// ---------------------------------------------------------------------------
// 从已有证据抽候选（把「回忆」变成「点选」）
// ---------------------------------------------------------------------------

export interface EvidenceSeed {
  evidenceId: string;
  evidenceTitle: string;
  /** 候选回答正文 */
  draft: string;
  /** 界面上展示的短标签 */
  label: string;
}

/**
 * 把档案里已有的证据改写成一条可一键采纳的候选回答。
 *
 * 为什么这是「不费脑子」的关键：用户不是从零回忆，而是**在自己已经写过的
 * 简历/项目描述里挑一句、改两个字**。认知成本从「组织语言」降到「做判断」。
 *
 * 限制：只截取原句并做轻量连接词拼接，**不允许改写事实、不允许新增内容**。
 * 这一点必须守住 —— 一旦系统开始替用户编，用户就再也分不清哪句是自己说的。
 */
export function seedsFromEvidence(
  evidence: Array<{ id: string; title: string; content: string; skills: string[] }>,
  skillName: string,
  shape: AskShape,
): EvidenceSeed[] {
  const out: EvidenceSeed[] = [];
  for (const item of evidence) {
    const mentions =
      item.skills.some((s) => s === skillName || s.includes(skillName) || skillName.includes(s)) ||
      item.content.includes(skillName);
    if (!mentions) continue;

    const firstLine = firstMeaningfulSentence(item.content);
    if (!firstLine) continue;
    if (firstLine.length < 8) continue;

    out.push({
      evidenceId: item.id,
      evidenceTitle: item.title,
      draft: shape === 'behavioral' ? ensureActions(firstLine) : firstLine,
      label: shorten(firstLine, 34),
    });
    if (out.length >= 3) break;
  }
  return out;
}

function firstMeaningfulSentence(text: string): string {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    // 跳过「场景：xxx」这类本系统自己加的前缀标签行，它不是用户自己写的描述
    if (/^(场景|做法与遇到的问题|结果|要点|说明)[:：]/.test(line)) {
      const stripped = line.replace(/^(场景|做法与遇到的问题|结果|要点|说明)[:：]\s*/, '');
      if (stripped.length >= 8) return shorten(stripped, 160);
      continue;
    }
    if (line.length >= 8) return shorten(line, 160);
  }
  return '';
}

/**
 * 行为能力的候选答案需要显式的「动作」才算数。
 *
 * 本地规则判定「说清了做法」需要看到做过什么（做过/负责/推动/协调…）。
 * 如果候选里只有「参与了某项目」这种没有动作的句子，采纳后依然判不出深度，
 * 那这个候选反而会误导用户以为答完了 —— 所以在这里补一个提示而不是硬编动作。
 */
function ensureActions(sentence: string): string {
  if (/(做过|负责|推动|协调|主导|组织|处理|解决|安排|对接|带过|完成)/.test(sentence)) return sentence;
  return `${sentence}（请补一句：你在这件事里具体做了什么动作）`;
}

function shorten(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// 模型出题
// ---------------------------------------------------------------------------

export interface PlannedQuestion {
  layer: LocalQuestionSpec['layer'];
  prompt: string;
  hint?: string;
  critical?: boolean;
}

export interface PlanQuestionsInput {
  skillName: string;
  shape: AskShape;
  /** 已有的该技能证据摘要，给模型当上下文，避免它重复问档案里已有的事 */
  knownFacts: string[];
  jobTitle?: string;
}

export interface PlanQuestionsOutput {
  specs: PlannedQuestion[];
  /** 出题来源，界面要如实展示 */
  origin: 'ai' | 'rule';
  warnings: string[];
}

/**
 * 把模型返回的题目并入本地规格。
 *
 * 为什么要「并入」而不是直接用模型的：
 *   - 层级（layer）是本地状态机的输入，模型改不了；
 *   - soft 技能不得出现自评题，这条是硬约束；
 *   - 模型漏题时必须用本地题补齐，不能让用户少答一题就得结论。
 */
export function mergeAiQuestions(
  local: LocalQuestionSpec[],
  aiQuestions: PlannedQuestion[] | undefined,
  shape: AskShape,
): { specs: LocalQuestionSpec[]; accepted: number; rejected: string[] } {
  const rejected: string[] = [];
  if (!aiQuestions || aiQuestions.length === 0) {
    return { specs: local, accepted: 0, rejected };
  }

  const byLayer = new Map<LocalQuestionSpec['layer'], LocalQuestionSpec>();
  for (const spec of local) byLayer.set(spec.layer, spec);

  let accepted = 0;
  for (const q of aiQuestions) {
    if (!q || typeof q.prompt !== 'string' || !q.prompt.trim()) continue;
    // 顺序有讲究：先判 behavioral + self_report，再判层是否存在。
    // 反过来的话，「软技能本来就没有自评层」会被当成「未知层」提前 continue，
    // 用户就看不到「模型给软技能出了自评题」这条提示 —— 而那正是需要被告知的事。
    if (shape === 'behavioral' && q.layer === 'self_report') {
      rejected.push('模型给行为能力出了自评题（掌握程度题），已丢弃 —— 这类能力只能问具体事例');
      continue;
    }
    if (!byLayer.has(q.layer)) continue;
    if (q.prompt.trim().length < 6 || q.prompt.trim().length > 120) {
      rejected.push('题目长度不合理，已丢弃');
      continue;
    }
    const base = byLayer.get(q.layer) as LocalQuestionSpec;
    byLayer.set(q.layer, { ...base, prompt: q.prompt.trim(), hint: q.hint?.trim() || base.hint });
    accepted += 1;
  }

  return { specs: local.map((spec) => byLayer.get(spec.layer) ?? spec), accepted, rejected };
}