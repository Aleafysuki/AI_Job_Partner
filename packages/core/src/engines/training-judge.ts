/**
 * 训练判定（v0.6）
 * ============
 *
 * 回答「训练要练到什么程度才算过」这个一直没被回答的问题。
 * 在此之前训练页只有两件事：填空 + 用户自己打个 0-3 分，然后**什么都没发生** ——
 * 训练结果不写回能力库，所以练完重跑匹配结论也不会变。那是假闭环。
 *
 * ── 三条必须守住的立场 ──
 *
 * 1. **判定只用可核对的信号，不评价表达。**
 *    判据是：有没有具体场景、有没有数字、有没有因果、有没有答到期望点。
 *    「条理不清」「太长」「不够简洁」**一律不参与判定** ——
 *    那些是练几次就能改的文风问题，写进跨岗位保留的技能等级里
 *    对任何岗位的判断都没有贡献（这条与 v0.4 的硬约束 19 同源）。
 *
 * 2. **不追求「答对」。** 训练题是「你做过的事」，不存在标准答案。
 *    所以判定的是「你有没有把这件事讲成可核对的样子」，不是「答案是否正确」。
 *
 * 3. **判定可以隐藏，但不会不存在。**
 *    设置页的「显示判定依据」只控制**解释的显隐**。
 *    判定永远发生 —— 关掉解释只是让它变成一个不给理由的判决，那才是真的骗人。
 *    想让用户自己判断，那就把判据摆出来。
 *
 * ── 追问直接复用 v0.5 的引擎 ──
 *
 * 不另写一套：`extractFollowUpHooks` / `decideFollowUp` 的终止条件
 * （最多 2 下 / 每题 3 轮 / 短于 40 字不追）在这里原样成立。
 * 同一组规则写两遍必然漂移。
 */

import { extractFollowUpHooks, decideFollowUp } from './interactive-followup';
import type { FollowUpHook } from '../domain/mock-interview';
import type { TrainingItem } from '../domain/training';
import { truncate } from '../utils/text';

/** 场景词：有具体场景才谈得上「有实际产出」 */
const SCENE_MARKERS =
  /(项目|工程|系统|平台|服务|业务|线上|生产|公司|团队|实习|工作|负责|上线|交付|迭代|版本)/;
/** 数字或可核对载体 */
const NUMBER_OR_REF = /(\d|％|%|倍|万|千|链接|地址|仓库|文档|链接|PR|issue)/i;
/** 因果连接：说了「做了什么」之后有没有说「所以呢」 */
const CAUSAL = /(因为|所以|因此|于是|导致|为了让|结果是|使得|这样才)/;

export type TrainingVerdict = 'passed' | 'needs_work' | 'too_short';

export interface JudgeReason {
  key: string;
  ok: boolean;
  /** 给用户看的话。措辞只描述「句子里有没有这个东西」，不评价写得好不好。 */
  text: string;
}

export interface TrainingJudgement {
  verdict: TrainingVerdict;
  /** 一句话结论：只说这道题答没答到点上，不说岗位能不能投 */
  headline: string;
  reasons: JudgeReason[];
  /** 没答到的话，接下来的追问（已带用户原话出处）。没有则为空数组。 */
  hooks: FollowUpHook[];
  /** 已经追问了几次之后判定为 needs_work —— 用户可以「先放着」 */
  exhausted: boolean;
}

/**
 * 判一道训练题。
 *
 * `expectedPoints` 优先用 item.referencePoints（自查要点），
 * 没有就用训练题自带的 expectation —— 两者都是「该覆盖哪几块」，
 * 不是一个是「标准答案」。
 */
export function judgeTrainingAnswer(input: {
  answer: string;
  item: Pick<TrainingItem, 'skillName' | 'referencePoints' | 'type'>;
  /** 这一题已经追问过几次 */
  followUpCount: number;
}): TrainingJudgement {
  const text = input.answer.trim();
  const len = text.length;

  // ---- 1. 太短：连话都谈不上 ----
  if (len < 30) {
    return {
      verdict: 'too_short',
      headline: `只有 ${len} 字 —— 这一题还没开始。先写清「在什么场景下做了什么」，再回来对照要点。`,
      reasons: [
        { key: 'length', ok: false, text: `这一题只有 ${len} 字。写到 30 字以上才有东西可以对照要点。` },
      ],
      hooks: [],
      exhausted: false,
    };
  }

  const reasons: JudgeReason[] = [];

  // ---- 2. 场景 ----
  const hasScene = SCENE_MARKERS.test(text);
  reasons.push({
    key: 'scene',
    ok: hasScene,
    text: hasScene ? '说清了在哪个项目 / 什么业务里做的' : '没提到具体是哪个项目或什么业务 —— 缺场景的话面试官无法追问细节',
  });

  // ---- 3. 做法与因果 ----
  const hasCausal = CAUSAL.test(text);
  reasons.push({
    key: 'causal',
    ok: hasCausal,
    text: hasCausal ? '说出了「为什么这么做」的取舍' : '只说了「做了什么」，没说「为什么这么做」—— 后者才是面试官真正在问的',
  });

  // ---- 4. 可核对载体 ----
  const hasOutput = NUMBER_OR_REF.test(text);
  reasons.push({
    key: 'output',
    ok: hasOutput,
    text: hasOutput
      ? '给出了数字或可核对的载体'
      : '没有数字、链接或交付物 —— 这一条只能停在「自述」，写进简历时撑不住',
  });

  // ---- 5. 要点覆盖 ----
  const points = input.item.referencePoints.filter((p) => p.trim());
  if (points.length > 0) {
    // 判定口径与 v0.3 一致：只用 includes 逐点判定。
    // 不叠 textMentionsSkill —— 期望点可能是「缓存淘汰策略」这类自定义短语，
    // 技能词典里根本没有，叠上会把整份要点都判成缺失。
    const missed = points.filter((p) => !text.includes(p.trim()));
    const covered = points.length - missed.length;
    reasons.push({
      key: 'points',
      ok: missed.length === 0,
      text:
        missed.length === 0
          ? `自查要点 ${points.length} 条都提到了`
          : `自查要点 ${points.length} 条里提到了 ${covered} 条，漏了：${missed.slice(0, 3).map((m) => `「${truncate(m, 20)}」`).join('、')}`,
    });
  }

  const failed = reasons.filter((r) => !r.ok);

  // ---- 全过 → 达标 ----
  if (failed.length === 0) {
    return {
      verdict: 'passed',
      headline: '这一题的要点都答到了。它只能证明「你现在能讲清」，不能证明「这个岗位能投了」—— 要确认结论，去重跑一次匹配。',
      reasons,
      hooks: [],
      exhausted: false,
    };
  }

  // ---- 没全过：看还能不能追问 ----
  const hooks = extractFollowUpHooks(text, { knownSkills: [input.item.skillName] });
  const decision = decideFollowUp({ answerText: text, hooks, followUpCount: input.followUpCount });

  return {
    verdict: 'needs_work',
    headline: `还差 ${failed.length} 处：${failed.map((f) => f.text.split(' ')[0]).join('；')}`,
    reasons,
    hooks: decision.shouldFollowUp ? hooks.slice(0, 1) : [],
    exhausted: !decision.shouldFollowUp,
  };
}

/**
 * 训练结论写进档案的说明文案。
 *
 * 刻意不写「这项能力已达标」—— 训练只能证明「讲得清」，
 * 证据强度仍然封顶为「中」（MAX_STRENGTH_BY_ORIGIN.qa），永远到不了「强」。
 * 练到会讲不等于真做过，这是本产品 v0.1 就定下的判断标准，不能在训练这里松掉。
 */
export const TRAINING_EVIDENCE_WHY =
  '这条来自你自己写的训练回答。强度仍然按「中」计算 —— 练到能讲清不等于真的做过，' +
  '想让它变成可核对的证据，得再补上数字、链接或时间。';
