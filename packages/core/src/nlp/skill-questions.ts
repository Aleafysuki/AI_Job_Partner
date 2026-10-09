import { SELF_REPORT_OPTIONS, type AssessLayer, type AssessQuestion, type AssessQuestionKind } from '../domain/interview';
import { newId } from '../utils/text';
import {
  BEHAVIORAL_SCALE_OPTIONS,
  askShapeOf,
  localSpecsFor,
  type AskShape,
} from './ask-planner';
import { resolveSkill, skillKindOf, type SkillKind } from './skills';

/**
 * 问诊题模板库（v0.3 起由 ask-planner.ts 承担主要出题职责）。
 *
 * 出题原则：每一题都必须能区分「看过」和「做过」。
 * 所以问的永远是具体事实（什么场景、遇到什么问题、结果是什么），
 * 而不是「你对 X 有多熟」这种只能得到形容词的问题。
 *
 * 题目按「能力形状」分类而不是按技能名分类 —— 因为问 Git 和问 Docker 的方式是一样的，
 * 但问 Git 和问「沟通能力」的方式完全不同。
 *
 * ---------------------------------------------------------------------------
 * v0.3 变更留痕（保留原实现，勿删）
 * ---------------------------------------------------------------------------
 * 原实现在本文件里保留了下面三段，用于对照与回退：
 *
 *   1. FACT_BY_FLAVOR / DEPTH_BY_FLAVOR —— 按 7 种能力形状各写一套题面；
 *   2. CURATED_DEPTH —— 14 个高频技能的定制深度题；
 *   3. buildQuestions() —— 固定五层模板（self_report → fact → depth → output → boundary）。
 *
 * 为什么要换掉：用户实测反馈指出，对「人际交往」这类能力问掌握程度等级本身就不合适。
 * 根因是那三段把「层」写死了 —— 无论什么能力，第一层一律是自评选择题。
 * 新实现在 ask-planner.ts 里按 AskShape 分流：
 *   behavioral（软技能）根本不出 self_report 题，第一题直接就是「最近发生了什么」；
 *   其余形状保留阶梯，但题面可由模型按该能力的真实分水岭重写。
 *
 * 本文件继续保留 buildQuestions() 作为**无模型时的本地出题入口**，
 * 并额外提供 attachSuggestions() 把「从档案里抽候选」接上去。
 */

export type QuestionFlavor = 'tool' | 'language' | 'tech' | 'ai' | 'method' | 'soft' | 'domain';

export const FLAVOR_LABEL: Record<QuestionFlavor, string> = {
  tool: '工具 / 平台',
  language: '编程语言',
  tech: '技术方案',
  ai: 'AI 与数据',
  method: '方法 / 流程',
  soft: '软技能',
  domain: '行业知识',
};

export function flavorOf(kind: SkillKind): QuestionFlavor {
  switch (kind) {
    case 'language': return 'language';
    case 'devops': return 'tool';
    case 'frontend':
    case 'backend':
    case 'mobile':
    case 'test': return 'tech';
    case 'ai':
    case 'agent':
    case 'data': return 'ai';
    case 'soft': return 'soft';
    case 'domain':
    case 'certificate': return 'domain';
    default: return 'method';
  }
}

interface LayerTemplate {
  layer: AssessLayer;
  kind: AssessQuestionKind;
  prompt: string;
  hint?: string;
  options?: string[];
  critical?: boolean;
}

// ---------------------------------------------------------------------------
// v0.3 变更留痕（以下三段为原 v0.2 实现，保留勿删）
// ---------------------------------------------------------------------------

const FACT_BY_FLAVOR: Record<QuestionFlavor, string> = {
  tool: '你最近一次用到「{skill}」是在什么场景？请说清：做什么事、用了它的哪部分能力。',
  language: '你用「{skill}」写过什么东西？它是干什么用的、大概多大规模。',
  tech: '你在哪个项目里用过「{skill}」这套方案？解决了什么问题。',
  ai: '你在哪个项目或任务里用过「{skill}」？输入是什么、输出是什么。',
  method: '你在哪个项目里用过「{skill}」这套方法？给谁解决了什么问题。',
  soft: '举一个具体例子：哪件事里你用到了「{skill}」？当时的情况是什么、你做了什么。',
  domain: '你在什么场景下接触过「{skill}」？这个场景里你的角色是什么。',
};

const DEPTH_BY_FLAVOR: Record<QuestionFlavor, string> = {
  tool: '使用「{skill}」时你遇到过什么问题、做过什么非默认的调整？',
  language: '用「{skill}」写的代码里，哪一处是你觉得写得最讲究的？为什么那样写？',
  tech: '「{skill}」这条链路上你做过什么优化或权衡？换一种做法会怎样？',
  ai: '「{skill}」的效果你怎么判断好不好？为此做过哪些调优？',
  method: '这套方法在执行中你做过什么调整？为什么调整？',
  soft: '这件事推进过程中最难的一步是什么？你怎么处理的？',
  domain: '这块业务里有哪些「看起来一样、实际不一样」的区别？',
};

/**
 * 高频技能的定制深度题（已迁至 ask-planner.ts 的 CURATED_DEPTH，此处保留原值留痕）。
 */
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
  '数据采集 / 爬虫': '目标站点反爬时你怎么处理？数据量上来后的稳定性怎么保证。',
  MySQL: '表结构和索引你是怎么设计的？为什么这样设计？',
  '模型量化/本地部署': '你在什么硬件上部署过？量化和速度、效果之间的取舍怎么定的？',
  Figma: '你交付设计稿时怎么处理开发还原度问题？组件和变量是怎么组织的。',
};

// 原 v0.2 的五层模板，同样保留留痕（新的分流逻辑在 ask-planner.ts）
const OUTPUT_TEMPLATE: LayerTemplate = {
  layer: 'output',
  kind: 'text',
  prompt: '这件事的结果是什么？有没有可以核对的东西 —— 数字、链接、可演示的交付物？',
  hint: '例如「每天处理约 800 条」「响应从 1.2s 降到 180ms」「GitHub 地址」。没有数字就把交付了什么写清楚。',
  critical: true,
};

const BOUNDARY_TEMPLATE: LayerTemplate = {
  layer: 'boundary',
  kind: 'text',
  prompt: '「{skill}」里你目前还不确定、或者没深入过的部分是什么？',
  hint: '说得出边界比说「都懂」更可信。这一条也会被写进档案的「待学习」。',
};

// ---------------------------------------------------------------------------
// v0.3 新实现
// ---------------------------------------------------------------------------

export interface BuildQuestionsOptions {
  /** 精简模式：只问自评 + 场景 + 产出（适合「快一点」的场景） */
  compact?: boolean;
  /** 由上层（ask-planner 的合并结果）传入的题面，覆盖本地默认值 */
  overrides?: Record<string, string>;
  /** 出题来源，如实展示给用户 */
  origin?: AssessQuestion['origin'];
}

/**
 * 本地出题（无模型时的路径，也是模型出题失败后的兜底）。
 *
 * 与原 v0.2 的关键差异：**软技能不出自评题**。
 * 这一条是硬规则，不是一个可选优化 —— 对「人际交往」问「属于了解还是熟悉」
 * 只能得到自我感觉，不会让系统多知道任何关于用户的事实。
 */
export function buildQuestions(skillName: string, options: BuildQuestionsOptions = {}): AssessQuestion[] {
  const def = resolveSkill(skillName);
  const kind: SkillKind = def?.kind ?? skillKindOf(skillName);
  const canonical = def?.name ?? skillName;
  const shape: AskShape = askShapeOf(canonical, kind);

  let specs = localSpecsFor(canonical, shape);

  if (options.compact) {
    // 精简模式保留最关键的两层：具体场景 + 结果
    const keep: AssessLayer[] = shape === 'behavioral' ? ['fact', 'output'] : ['self_report', 'fact', 'output'];
    specs = specs.filter((s) => keep.includes(s.layer));
  }

  return specs.map((spec) => ({
    id: newId('q'),
    skillName: canonical,
    layer: spec.layer,
    // v0.3 修正（真 bug）：这里原本硬编码成 'text'，
    // 于是 self_report 题带着 options 却按文本框渲染 —— 用户看到输入框、看不到选项。
    // kind 必须由「这题有没有选项」决定，不能写死。
    kind: spec.layer === 'self_report' ? ('choice' as const) : ('text' as const),
    prompt: (options.overrides?.[spec.layer] ?? spec.prompt).replace(/\{skill\}/g, canonical),
    hint: spec.hint,
    // 行为能力的「熟练度阶梯」不是通用 SELF_REPORT_OPTIONS，而是专门写的四档
    options: spec.layer === 'self_report' ? selfOptionsFor(shape) : undefined,
    // v0.4：可点选的候选回答。用户在这一点一下就完成这道题，不需要自己组织语言。
    // kind 仍然是 'text' —— 选项只是快车道，自由输入永远保留。
    quickChoices: spec.options,
    critical: spec.critical,
    origin: options.origin ?? 'rule',
  }));
}

/** 不同能力形状的自评选项不一样 —— 软技能的档位描述的是「承担了什么责任」，不是「多熟练」 */
function selfOptionsFor(shape: AskShape): string[] {
  return shape === 'behavioral' ? [...BEHAVIORAL_SCALE_OPTIONS] : [...SELF_REPORT_OPTIONS];
}

/** 一次问诊的题量（用于 UI 预估耗时） */
export function estimateMinutes(questions: AssessQuestion[]): number {
  const textQuestions = questions.filter((q) => q.kind === 'text').length;
  return Math.max(1, Math.round(textQuestions * 0.8 + 0.5));
}