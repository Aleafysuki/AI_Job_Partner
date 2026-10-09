/**
 * 能力层级（v0.4 追加）
 * ================
 *
 * ## 为什么需要这个文件
 *
 * 用户的反馈：「多个层级的关系有点乱，整理并重新分级」。
 *
 * 排查后发现的问题不是「档位太多」，而是**同一个问题被五套刻度各答了一遍**，
 * 且五套刻度之间没有任何映射说明：
 *
 *   | 刻度 | 档数 | 它其实在回答 |
 *   | --- | --- | --- |
 *   | `SELF_LEVELS` 了解/熟悉/熟练/精通 | 5 | 你自己觉得怎么样 |
 *   | `STRENGTH_LABEL` 无/弱/中/强 | 4 | 这条经历能不能被外部核对 |
 *   | `SKILL_LEVEL_LABEL` 未验证…可讲清取舍 | 6 | 这项技能做到什么程度 |
 *   | `ASSESSMENT_LABEL` 满足…无法判断 | 5 | 岗位这条要求满足了没 |
 *   | `SELF_SCORE_LABEL` 答不上…能讲清取舍 | 4 | 这道题你答得怎么样 |
 *
 * 19 个档位标签在界面上交叉出现，用户看到「熟练 / 中 / 部分满足」时
 * 无从判断它们谁高谁低 —— 这不是文案问题，是**缺少统一的换算口径**。
 *
 * ## 本文件的解决方式
 *
 * 不改任何一套刻度的取值（那会破坏已有数据与判定规则），
 * 而是把它们**收敛到一条主线**上：能力层级 `CapabilityLevel`（4 级）。
 *
 * ```
 *   第 4 级  能交付      做过并有结果，且有可核对的载体
 *   第 3 级  能上手      在真实场景里做过，能说清做法
 *   第 2 级  了解过      接触过但拿不出产出 / 缺少证据
 *   第 1 级  待验证      只是自我声明，系统判不了
 * ```
 *
 * 其余四套刻度都退化成这条主线的**不同侧面**，并在界面上同声解释：
 * - 证据强度 = 这条证据「自己一个人能站到第几级」（不看别的东西）；
 * - 问诊等级 = 问诊这一项能力「大致到第几级」（可能被硬门槛下调，故只是大致）；
 * - 匹配结论 = 岗位这一条要求「整体到第几级」（受硬门槛、证据来源影响）；
 * - 训练自评 = 这道题「你自称到第几级」（纯自述，不参与任何判断）。
 *
 * **必须说清的一件事**：这几套刻度**不是一回事**，强行换算会丢信息。
 * 所以本文件提供的是「对照」而不是「等价」——
 * 每个映射都带 `exact` 标记，界面上必须区分「确定等价」与「大致对应」。
 */

/** 统一后的能力层级，四级 */
export type CapabilityLevel = 'L1' | 'L2' | 'L3' | 'L4';

export const CAPABILITY_LEVEL_ORDER: CapabilityLevel[] = ['L4', 'L3', 'L2', 'L1'];

export interface CapabilityLevelDef {
  id: CapabilityLevel;
  /** 一到两个字，界面上空间小的地方用这个 */
  short: string;
  /** 完整名，展开说明时用 */
  label: string;
  /** 这级的判定标准（必须可核验，不能是形容词） */
  criteria: string;
  /** 缺什么才能升到上一级 —— 这是本层级最有用的部分 */
  toNext: string;
  /** 简历上能不能写 */
  canWriteInResume: boolean;
}

export const CAPABILITY_LEVELS: Record<CapabilityLevel, CapabilityLevelDef> = {
  L4: {
    id: 'L4',
    short: '交付',
    label: '能交付',
    criteria: '做过并且有结果，而且留下了别人能核对的东西（数字、链接、交付物）',
    toNext: '已经是最高级 —— 面试时准备被追问细节与替代方案',
    canWriteInResume: true,
  },
  L3: {
    id: 'L3',
    short: '上手',
    label: '能上手',
    criteria: '在真实场景里用过，能说清具体做法，但结果或可核对载体还不够',
    toNext: '补上可核对的东西：链接、量化结果，或去问诊把它讲成一段完整叙述',
    canWriteInResume: true,
  },
  L2: {
    id: 'L2',
    short: '了解',
    label: '了解过',
    criteria: '接触过、能复述，但没有独立产出，或者说得出来却拿不出证据',
    toNext: '做一个小而完整的产出（能跑、能演示），做完再来补一条证据',
    canWriteInResume: false,
  },
  L1: {
    id: 'L1',
    short: '待验证',
    label: '待验证',
    criteria: '只有自我声明，系统判不了真假 —— 既不算会，也不算不会',
    toNext: '去问诊说清一件具体做过的事，或补一条带链接/数字的证据',
    canWriteInResume: false,
  },
};

export function levelRank(level: CapabilityLevel): number {
  return { L1: 1, L2: 2, L3: 3, L4: 4 }[level];
}

/** 取两级的较低者 —— 用于「证据强度只能封顶」这类规则 */
export function weakerLevel(a: CapabilityLevel, b: CapabilityLevel): CapabilityLevel {
  return levelRank(a) <= levelRank(b) ? a : b;
}

/**
 * 一条映射：某套刻度的某个档位，对应到能力层级的哪一级。
 *
 * `exact = false` 表示「大致对应」——
 * 例如问诊等级可能被硬门槛下调过（单次问诊给不出「可讲清取舍」），
 * 所以它与能力层级不是严格等价，界面上不能说「等同于」。
 */
export interface LevelMapping {
  level: CapabilityLevel;
  exact: boolean;
  /** 大致对应时说明差异来自哪里 */
  note?: string;
}

// ---------------------------------------------------------------------------
// 各刻度 → 能力层级
// ---------------------------------------------------------------------------

import type { Assessment, EvidenceStrength, TriLevel } from './common';
import type { SkillLevel } from './interview';
import type { SelfScore } from './training';

/**
 * 证据强度 → 能力层级。
 *
 * 全部 `exact = true`：证据强度本来就是「这条证据自己能站到第几级」，
 * 定义上就是精确的。
 */
export const STRENGTH_TO_LEVEL: Record<EvidenceStrength, LevelMapping> = {
  strong: { level: 'L4', exact: true },
  medium: { level: 'L3', exact: true },
  weak: { level: 'L2', exact: true },
  none: { level: 'L1', exact: true },
};

/**
 * 问诊等级 → 能力层级。
 *
 * `delivered / applied` 精确对应 L4 / L3；
 * 往下三档都是 `exact: false`：
 *   - practiced（跟做过）严格说在 L2 之上、但没到 L3；
 *   - aware（了解概念）与 L2 也不完全一样 —— 问诊的 aware 是「说不出场景」，
 *     而 L2 是「拿不出产出」，判定口径不同。
 *   - unverified 对应 L1 是准确的（系统判不了）。
 */
export const SKILL_TO_LEVEL: Record<SkillLevel, LevelMapping> = {
  expert: { level: 'L4', exact: false, note: '问诊很少给出这一档；且它可被硬门槛下调到「有产出」' },
  delivered: { level: 'L4', exact: true },
  applied: { level: 'L3', exact: true },
  practiced: { level: 'L2', exact: false, note: '比「了解过」强一点：跟着做过，但还没独立产出' },
  aware: { level: 'L2', exact: false, note: '判的是「说不出使用场景」，不完全等于「拿不出产出」' },
  unverified: { level: 'L1', exact: true },
};

/**
 * 匹配结论 → 能力层级。
 *
 * 这一套 `exact` 全为 false，而且是五套里最粗的一套，原因有两个：
 *   1. 它衡量的是「岗位这一条要求」，不是「这项能力」；
 *   2. 硬门槛类要求即使你能力够也会判 gap（学历不满足就是不满足）。
 * 界面上**不能**把它直接显示成能力层级，只能作为上下文参考。
 */
export const ASSESSMENT_TO_LEVEL: Record<Assessment, LevelMapping> = {
  matched: { level: 'L4', exact: false, note: '受硬门槛影响：能力够但学历不满足时仍是这一档之外的结论' },
  partial: { level: 'L3', exact: false, note: '只用到一部分能力，未必等于「能上手」' },
  lacking_evidence: { level: 'L2', exact: false, note: '说的是「拿不出证据」，不一定是能力不足' },
  gap: { level: 'L1', exact: false, note: '也可能是硬门槛不满足，与能力高低无关' },
  unknown: { level: 'L1', exact: false, note: '无法判断，不能当成「不会」' },
};

/**
 * 训练自评 → 能力层级。
 *
 * **这一套最重要的提醒**：它是纯自述，不参与任何判断。
 * 一道题自评「能讲清取舍」不会让你在匹配报告里变成「满足」。
 */
export const SELFSCORE_TO_LEVEL: Record<SelfScore, LevelMapping> = {
  3: { level: 'L4', exact: false, note: '纯自评，不会改变匹配结论' },
  2: { level: 'L3', exact: false, note: '纯自评，不会改变匹配结论' },
  1: { level: 'L2', exact: false, note: '纯自评，不会改变匹配结论' },
  0: { level: 'L1', exact: false, note: '纯自评，不会改变匹配结论' },
};

// ---------------------------------------------------------------------------
// 界面对照
// ---------------------------------------------------------------------------

/** 一行对照：某个刻度的档位 ↔ 能力层级 */
export interface LevelRow {
  /** 原刻度的档位文字 */
  from: string;
  /** 对应到能力层级 */
  to: CapabilityLevel;
  toLabel: string;
  exact: boolean;
  note?: string;
}

/**
 * 「这几个标签什么关系」的一页说明 —— 用户反馈里最实际的那个问题。
 *
 * 界面上任何出现多个等级标签的地方都应该能展开看到这张表，
 * 因为用户的困惑不是「看不懂某个词」，而是「不知道它们怎么比」。
 */
export function levelReference(): {
  main: CapabilityLevelDef[];
  groups: Array<{ title: string; what: string; rows: LevelRow[] }>;
} {
  return {
    main: CAPABILITY_LEVEL_ORDER.map((id) => CAPABILITY_LEVELS[id]),
    groups: [
      {
        title: '能力层级：唯一的主线',
        what: '整个系统只用这一条刻度回答「你到底会到什么程度」。其余刻度都是它的侧面。',
        rows: CAPABILITY_LEVEL_ORDER.map((id) => {
          const def = CAPABILITY_LEVELS[id];
          return { from: `${def.short}（${def.label}）`, to: id, toLabel: def.label, exact: true, note: def.criteria };
        }),
      },
      {
        title: '证据强度：这条证据自己能站到第几级',
        what: '只看这一条证据，不看别的东西。同一个人可以同时有 L4 和 L2 的两条证据。',
        rows: (['strong', 'medium', 'weak', 'none'] as EvidenceStrength[]).map((s) => ({
          from: STRENGTH_TEXT[s],
          to: STRENGTH_TO_LEVEL[s].level,
          toLabel: CAPABILITY_LEVELS[STRENGTH_TO_LEVEL[s].level].label,
          exact: true,
        })),
      },
      {
        title: '问诊等级：这项能力大致到第几级',
        what: '和主线接近，但会被硬门槛下调 —— 单次问诊给不出最高那一档。',
        rows: (['expert', 'delivered', 'applied', 'practiced', 'aware', 'unverified'] as SkillLevel[]).map((s) => ({
          from: SKILL_TEXT[s],
          to: SKILL_TO_LEVEL[s].level,
          toLabel: CAPABILITY_LEVELS[SKILL_TO_LEVEL[s].level].label,
          exact: SKILL_TO_LEVEL[s].exact,
          note: SKILL_TO_LEVEL[s].note,
        })),
      },
      {
        title: '匹配结论：岗位这条要求整体到第几级',
        what: '最粗的一套，因为它衡量的是「要求」不是「能力」，而且会被硬门槛左右。',
        rows: (['matched', 'partial', 'lacking_evidence', 'gap', 'unknown'] as Assessment[]).map((a) => ({
          from: ASSESSMENT_TEXT[a],
          to: ASSESSMENT_TO_LEVEL[a].level,
          toLabel: CAPABILITY_LEVELS[ASSESSMENT_TO_LEVEL[a].level].label,
          exact: ASSESSMENT_TO_LEVEL[a].exact,
          note: ASSESSMENT_TO_LEVEL[a].note,
        })),
      },
      {
        title: '训练自评：这道题你自称到第几级',
        what: '纯自述。它不会改变任何其它结论。',
        rows: ([3, 2, 1, 0] as SelfScore[]).map((s) => ({
          from: SELFSCORE_TEXT[s],
          to: SELFSCORE_TO_LEVEL[s].level,
          toLabel: CAPABILITY_LEVELS[SELFSCORE_TO_LEVEL[s].level].label,
          exact: false,
          note: SELFSCORE_TO_LEVEL[s].note,
        })),
      },
    ],
  };
}

// 这里的文字常量刻意不复用各 domain 的 LABEL ——
// 它们服务于「对照表」这个场景，需要的是「用户最可能搜的字」，
// 而不是界面各处在用的标签。两者不一致时界面要同时给出两者。
const STRENGTH_TEXT: Record<EvidenceStrength, string> = {
  strong: '强证据',
  medium: '中证据',
  weak: '弱证据',
  none: '无证据',
};

const SKILL_TEXT: Record<SkillLevel, string> = {
  expert: '可讲清取舍',
  delivered: '有产出',
  applied: '实际用过',
  practiced: '跟做过',
  aware: '了解概念',
  unverified: '未验证',
};

const ASSESSMENT_TEXT: Record<Assessment, string> = {
  matched: '满足',
  partial: '部分满足',
  lacking_evidence: '缺少证据',
  gap: '明显缺口',
  unknown: '无法判断',
};

const SELFSCORE_TEXT: Record<0 | 1 | 2 | 3, string> = {
  3: '3 · 能讲清取舍与结果',
  2: '2 · 能说清做法',
  1: '1 · 只能说出概念',
  0: '0 · 完全答不上来',
};

// ---------------------------------------------------------------------------
// 给界面用的合并取值
// ---------------------------------------------------------------------------

/**
 * 某项技能的**最终层级**：取「证据能证明到哪」与「问诊说达到哪」的较低者。
 *
 * 为什么取较低者：两条来源都可能偏高 ——
 * 证据可能只覆盖一件事却标了高强度，问诊可能被用户高估。
 * 取低者的立场是「宁可低估，不要让用户以为已经够了」。
 *
 * @param evidenceMax 这项技能名下所有证据里的最强强度（'none' 表示没有）
 * @param assessed 问诊给出的等级（null 表示没问过）
 */
export function resolveCapabilityLevel(
  evidenceMax: EvidenceStrength,
  assessed: SkillLevel | null,
): { level: CapabilityLevel; why: string } {
  const fromEvidence = STRENGTH_TO_LEVEL[evidenceMax].level;
  if (!assessed) {
    return {
      level: fromEvidence,
      why:
        evidenceMax === 'none'
          ? '没有关联证据，也还没问过 —— 系统只能按你的自我声明记为「待验证」'
          : `按现有证据判断：最强的一条是「${STRENGTH_TEXT[evidenceMax]}」`,
    };
  }
  const fromAsk = SKILL_TO_LEVEL[assessed].level;
  const final = weakerLevel(fromEvidence, fromAsk);
  const sameAsEvidence = final === fromEvidence;
  return {
    level: final,
    why:
      final === fromAsk && fromAsk !== fromEvidence
        ? `问诊说你到了「${SKILL_TEXT[assessed]}」，但现有证据只能支撑「${CAPABILITY_LEVELS[fromEvidence].label}」，取较低的那个`
        : sameAsEvidence
          ? `现有证据能支撑到「${CAPABILITY_LEVELS[fromEvidence].label}」`
          : `问诊结论与证据一致：${CAPABILITY_LEVELS[final].label}`,
  };
}

/** 置信度 → 层级（用于把高/中/低翻译成主线语言） */
export function confidenceLevel(c: TriLevel): CapabilityLevel {
  return c === 'high' ? 'L3' : c === 'medium' ? 'L2' : 'L1';
}

/**
 * 从一条证据算出它支持的能力层级（1-4 的数值形式）。
 *
 * 之所以额外提供数值版本：排序时需要直接比较大小，
 * 而 `levelRank()` 要在热路径上反复调用，包一层能省掉对象查表。
 */
export function capabilityLevelOfEvidence(e: { strength: EvidenceStrength }): number {
  return levelRank(STRENGTH_TO_LEVEL[e.strength].level);
}
