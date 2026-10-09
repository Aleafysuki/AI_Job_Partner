/**
 * 交互式追问引擎
 * ==============
 *
 * 让「问题」从「上一个回答」里长出来，而不是预先排好一串。
 *
 * ── 为什么这件事值得单独做一个模块 ──
 *
 * 固定题单的问题：用户能预判第 3 题会问什么，于是他对着第 3 题准备，
 * 却把第 1 题答得很随意 —— 练的是「背过的题」，不是「被问住时的反应」。
 * 面试的实感恰恰在于**不知道下一题是什么**。
 *
 * 固定题单还有一个更隐蔽的坏处：用户的回答里那些「他自己没意识到的东西」
 * （比如反复用「大概」「应该是」）永远不会进入下一题，
 * 于是系统错过了唯一能让它改题的机会。
 *
 * ── 三条设计约束 ──
 *
 * 1. **追问必须指向答案里的具体位置，不是泛泛加深。**
 *    「能再详细说说吗」是无效追问 —— 它不基于任何已发生的事。
 *    有效追问长这样：「你刚才说『做过缓存优化』，具体优化了哪一项指标？」
 *
 * 2. **必须能「不追问」。** 如果每次都追，
 *    一场 5 题的面试会变成 20 题的马拉松，用户会放弃。
 *    所以要有明确的终止判据。
 *
 * 3. **不生成参考答案。** 与 `interview-prep.ts`、`engines/mock-interview.ts`
 *    同一条产品立场：给出话术会诱导背诵，而背下来的回答在下一轮就崩。
 *    反馈只说「你这里没答到」「你这里说得太快」，
 *    以及**下一题问什么**。
 */

import { findSkillsInText, textMentionsSkill } from '../nlp/skills';
import { truncate, unique } from '../utils/text';
import { newId } from '../utils/text';
import type { FollowUpHook } from '../domain/mock-interview';

// ---------------------------------------------------------------------------
// 一、从回答里抽「可追问的点」
// ---------------------------------------------------------------------------

/** 模糊量词。用户说「大概」「应该」「差不多」时，他自己也知道不确定。
 *  这一条最该追，因为它本身就是答案质量的下限信号。 */
const VAGUE_MARKERS = ['大概', '应该', '差不多', '好像', '可能是', '记不太清', '记不清', '好像吧', '大概就是'];

/** 自我怀疑。用户主动示弱时追问，能拿到比「你觉得呢」更实的东西。 */
const DOUBT_MARKERS = ['不太确定', '没太搞懂', '不太会', '不太熟', '可能不行', '怕做不好', '一般般'];

/** 未讲完。结尾是「就是」「然后」这类，说明他自己也知道没说完。 */
const UNFINISHED = /(就是|然后|反正|大概就)(?:\s*$|[，。]{1,2}\s*$)/;

export function extractFollowUpHooks(
  answerText: string,
  context: { knownSkills?: string[]; jobKeywords?: string[] } = {},
): FollowUpHook[] {
  const text = answerText.trim();
  if (text.length < 4) return [];
  const hooks: FollowUpHook[] = [];

  // ---- 1. 模糊量词 ----
  for (const m of VAGUE_MARKERS) {
    const idx = text.indexOf(m);
    if (idx < 0) continue;
    // 引用的原文要带上前后文，用户才认得出「说的是哪句」
    const start = Math.max(0, idx - 12);
    const anchor = text.slice(start, Math.min(text.length, idx + m.length + 14));
    hooks.push({
      id: newId('hook'),
      anchor,
      kind: 'vague_quantifier',
      text: `你刚才用了「${m}」。这个「${m}」具体到什么程度？比如有没有一个能说出来的数字，或者一个能确认的具体场景？`,
      intent: '模糊量词是回答质量的下限信号。它同时说明两件事：你对这件事没把握，或者你手上没有可核对的东西 —— 这两个都值得追。',
      expectedPoints: ['一个具体的数字或可确认的场景', '如果确实没有，那当时是怎么做的'],
    });
    break; // 一条回答里只抓一个模糊点，抓多了会像在审讯
  }

  // ---- 2. 自我怀疑 ----
  for (const m of DOUBT_MARKERS) {
    const idx = text.indexOf(m);
    if (idx < 0) continue;
    const anchor = text.slice(Math.max(0, idx - 12), Math.min(text.length, idx + m.length + 14));
    hooks.push({
      id: newId('hook'),
      anchor,
      kind: 'self_doubt',
      text: `你说「${m}」。那换个方向问：如果这件事必须由你来做，你会怎么从零把它弄明白？先做哪一步？`,
      intent: '用户主动示弱时，问「那你打算怎么学」不如问「你会怎么从零弄明白」—— 后者是行动，前者是态度，而面试官更关心行动。',
      expectedPoints: ['具体的第一步是什么', '怎么确认自己真的学会了'],
    });
    break;
  }

  // ---- 3. 讲完了但没说机制 ----
  // 判据：有一定长度，却没有「因为 / 原理 / 机制 / 本质」这类因果连接。
  // 这类回答「听起来对」但经不起追问 —— 面试官一定会问「为什么」。
  const hasCausal = ['因为', '原理', '机制', '本质', '原因是', '底层', '所以', '由于'].some((k) => text.includes(k));
  if (!hasCausal && text.length >= 25 && hooks.length < 2) {
    const anchor = text.slice(0, 30);
    hooks.push({
      id: newId('hook'),
      anchor,
      kind: 'no_mechanism',
      text: '你刚才说的大致是这样做的。为什么必须这么做？换个做法为什么不行？',
      intent: '「做过」和「知道为什么这样做」在面试里是两个价位。面试官听到结果后问原因，就是在测后者。',
      expectedPoints: ['为什么这个方案能解决问题', '换一种做法的代价是什么'],
    });
  }

  // ---- 4. 说了某项技能但没有可核对的证据 ----
  const skills = unique([
    ...(context.knownSkills ?? []),
    ...findSkillsInText(text).map((h) => h.def.name),
  ]).filter((s) => textMentionsSkill(text, s));
  if (skills.length > 0 && hooks.length < 3) {
    const skill = skills[0];
    hooks.push({
      id: newId('hook'),
      anchor: truncate(text.slice(0, 26), 26),
      kind: 'unbacked_claim',
      text: `你提到${skill}。能说一个具体的场景吗 —— 当时遇到什么问题、你怎么处理的、结果怎么样？`,
      intent: '只说「用过某技术」而没有场景，是简历上最常见的空话。面试官追问场景，是为了确认你真的动手过。',
      expectedPoints: ['当时的具体问题', '你做的处理', '可核对的结果'],
    });
  }

  // ---- 5. 回答没讲完 ----
  if (UNFINISHED.test(text) && hooks.length < 3) {
    hooks.push({
      id: newId('hook'),
      anchor: truncate(text.slice(-24), 24),
      kind: 'unfinished',
      text: '你刚才那句还没说完。接着说 —— 说完为止。',
      intent: '他自己意识到没讲完。这种时候让他说完，比追问有效：被打断的回答通常比主动讲完的更短。',
      expectedPoints: [],
    });
  }

  return hooks;
}

// ---------------------------------------------------------------------------
// 二、决定「追不追」
// ---------------------------------------------------------------------------

export interface FollowUpDecision {
  /** 是否追问 */
  shouldFollowUp: boolean;
  /** 选中的追问点。没追时为 undefined */
  hook?: FollowUpHook;
  /** 为什么不追 */
  reason?: string;
}

/** 追问次数上限。超过就换下一题。
 *  为什么是 2：一场 5 题的面谈，连追两下才有压力感；
 *  连追三下用户会开始敷衍，而敷衍的���答对诊断没有价值。 */
export const MAX_FOLLOW_UPS_PER_QUESTION = 2;

/** 回答太短就不追。追了也没信息 —— 他没东西可展开。 */
const MIN_LENGTH_FOR_FOLLOW_UP = 40;

export function decideFollowUp(input: {
  answerText: string;
  hooks: FollowUpHook[];
  /** 这一题已经追问过几次 */
  followUpCount: number;
  /** 这一题最多问几轮（含首问）。到达上限就必须换题 */
  maxRounds?: number;
}): FollowUpDecision {
  const { answerText, hooks, followUpCount } = input;
  const maxRounds = input.maxRounds ?? 3;

  if (hooks.length === 0) {
    return { shouldFollowUp: false, reason: '这一段没有可追问的点，换下一题' };
  }
  if (followUpCount >= MAX_FOLLOW_UPS_PER_QUESTION) {
    return { shouldFollowUp: false, reason: '已经追问过两轮，再追用户会开始敷衍' };
  }
  if (followUpCount + 1 >= maxRounds) {
    return { shouldFollowUp: false, reason: '这一题的轮次用完了' };
  }
  const len = answerText.trim().length;
  if (len < MIN_LENGTH_FOR_FOLLOW_UP) {
    return {
      shouldFollowUp: false,
      reason: `回答只有 ${len} 字，追问也展开不出东西。换下一题，用户可以在复盘里看到「这一题没答到点上」`,
    };
  }

  // 选**第一个还没追问过的**点。顺序即优先级（extractFollowUpHooks 里定的）。
  const hook = hooks[followUpCount] ?? hooks[0];
  return { shouldFollowUp: true, hook };
}

// ---------------------------------------------------------------------------
// 三、反馈：告诉用户「刚才那一答哪里有问题」
// ---------------------------------------------------------------------------

/**
 * 对一个回答的反馈。
 *
 * **只说缺什么，不给该怎么说。**
 * 这是本模块最核心的一条 —— 与 Prep、模拟面试完全一致。
 */
export interface AnswerFeedback {
  /** 一句话结论，不给分数 */
  headline: string;
  /** 具体缺什么。每条都要能在用户的原话里找到依据 */
  gaps: Array<{
    text: string;
    /** 依据：引用原文。引用不出来的不给 */
    anchor?: string;
  }>;
  /** 这次答得好的地方（如果有）。
   *  只挑优点会失真，但一个反馈里全是批评会让用户不想继续 —— 所以要真找。 */
  strengths: string[];
  /** 下一轮会问什么。**提前告知是刻意的**：追问的存在是为了看反应，
   *  而用户需要知道下一轮的存在才知道这一轮可以停。 */
  nextQuestionPreview?: string;
}

/**
 * 生成反馈。
 *
 * 判据尽量用「可核对」的信号，而不是风格评价：
 *   长度、是否有因果连接、是否提到具体数字、是否提到具体场景。
 * 风格（用词文雅与否）不问 —— 那是主观的，且与面试表现无关。
 */
export function buildAnswerFeedback(input: {
  answerText: string;
  hooks: FollowUpHook[];
  expectedPoints?: string[];
  usedEvidence: boolean;
}): AnswerFeedback {
  const text = input.answerText.trim();
  const gaps: AnswerFeedback['gaps'] = [];
  const strengths: string[] = [];

  const hasNumber = /\d/.test(text);
  const hasCausal = ['因为', '原理', '机制', '本质', '原因是', '所以', '由于'].some((k) => text.includes(k));
  const hasScenario = ['当时', '场景', '遇到', '问题', '情况', '项目里', '线上'].some((k) => text.includes(k));

  // ---- 缺什么 ----
  if (text.length < 30) {
    gaps.push({
      text: '这一段太短，面试官会以为你没说完就直接打断。至少说清「做了什么」和「遇到什么问题」。',
    });
  }
  if (!hasCausal && text.length >= 30) {
    gaps.push({
      text: '没有说「为什么」。面试官听到做法之后的下一句一定是「为什么这么做」，这一句不准备，现场就会卡。',
      anchor: textMentionsSkill(text, '做法') ? undefined : truncate(text.slice(0, 24), 24),
    });
  }
  if (!hasNumber) {
    gaps.push({
      text: '全程没有出现一个数字。没有数字的回答无法被核对 —— 面试官只能选择「信」或「不信」，而他通常会往不信那边倒。',
    });
  }
  if (!hasScenario) {
    gaps.push({ text: '没有具体的场景。「做过」和「在某个具体情况下处理过」在面试官那里是两个价钱。' });
  }
  /*
   * 「没有引用档案材料」只在**回答里提到了具体技能**时才提示。
   *
   * 之前无条件提示，理由是「只要没引用就提醒」——
   * 但用户完全可能在一个不该引用档案的问题上作答
   * （比如「介绍一下你自己」），那时候提醒是噪音。
   *
   * 判据：提到了 skill 词典里的词，却没有可核对的证据支撑 → 才提示。
   */
  const mentionsSkill = findSkillsInText(text).length > 0;
  if (mentionsSkill && !input.usedEvidence) {
    gaps.push({
      text: '你提到了具体技术，但这一轮没有引用档案里的任何材料。如果档案里有相关经历，说出来会比空讲更有说服力。',
    });
  }

  // ---- 好在哪（真找，找不到就不写）----
  if (hasNumber) strengths.push('给了可核对的数字 —— 这是面试官最看重的一类信息。');
  if (hasCausal) strengths.push('讲了「为什么」，不只是「做了什么」。');
  if (hasScenario) strengths.push('有具体场景，不是空谈。');

  // ---- 一句话结论 ----
  let headline: string;
  if (text.length === 0) {
    headline = '这一轮没有作答';
  } else if (gaps.length === 0) {
    headline = '这一轮答到位了';
  } else if (gaps.length <= 2) {
    headline = '方向对，但还没说透';
  } else {
    headline = '这一轮说得比较急 —— 面试官大概已经打断过了';
  }

  return { headline, gaps, strengths };
}

export type { FollowUpHook };
export { truncate };