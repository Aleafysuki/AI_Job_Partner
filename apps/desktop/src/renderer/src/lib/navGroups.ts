import type { Route } from '../state/store';

/**
 * 导航分组（v0.4）
 * ===============
 *
 * 用户反馈：「多个层级的关系有点乱，整理并重新分级」。
 *
 * 排查后发现两层混乱：
 *
 * **第一层是等级刻度**（5 套、19 个档位标签互不换算）。
 * 那部分由 `packages/core/src/domain/levels.ts` 收敛到一条主线，
 * 见该文件顶部说明。界面侧统一用 `LevelLegend` 呈现。
 *
 * **第二层是导航结构**：8 个页面平铺在一起，没有先后关系。
 * 用户看不出「应该先做哪个」—— 这也是上一轮加「下一步」条时要单独造一个
 * 判断函数的原因：导航本身没有表达流程。
 *
 * 这里的分法依据是**求职的真实顺序**，不是功能类型：
 *
 * ```
 *   准备   你有什么          档案 / 岗位
 *   ↓      （材料 + 目标）
 *   评估   你缺什么          匹配 / 问诊
 *   ↓      （差距在哪）
 *   提升   怎么补上          训练 / 面试问答 / 复盘
 *   ↓
 *   设置   引擎与数据
 * ```
 *
 * 为什么要分组而不是排顺序：平铺的 8 项在手机上要横向扫很久，
 * 而分组后用户扫一眼就知道自己在哪一段。设置单独一组且放最后 ——
 * 它不是流程的一环，是横切关注点。
 *
 * **桌面端与移动端必须共用这份定义。**
 * 分组一旦分两份，改一处必然漏另一处，两个宿主就会给出不同的结构。
 */

export interface NavGroup {
  id: string;
  /** 组名：两到四个字，手机上横向空间有限 */
  label: string;
  /** 这个阶段在做什么，界面上要显示 —— 流程感来自这里 */
  caption: string;
  items: Route[];
}

/** 页面的中文名，两端共用（避免各写一份） */
export const ROUTE_LABEL: Record<Route, string> = {
  workbench: '工作台',
  profile: '我的能力档案',
  job: '岗位分析',
  match: '简历匹配',
  interview: '能力问诊',
  training: '薄弱项训练',
  prep: '面试问答',
  mock: '模拟面试',
  debrief: '面试复盘',
  settings: '设置',
};

/**
 * 阶段划分。
 *
 * 关于「面试问答」放在提升阶段：它和「薄弱项训练」是同一类工具
 * （都是拿已知的东西练手），区别只是谁出题。
 * 而「面试复盘」是事后 —— 面试已经发生完了，所以它也在提升阶段，
 * 但语义上是「回顾」而不是「准备」，界面上靠 caption 区分。
 *
 * **为什么第一组是「总览」而不是「准备」**：
 * 工作台不属于流程的任何一环 —— 它是流程本身之外的总入口。
 * 但它**必须始终可达**，否则用户在任何一个功能页里就回不去了
 * （移动端的 Pivot 只渲染分组里的页签，漏掉它等于把它从导航里删了）。
 * 所以给它单独一组，排在最前，也让它在视觉上就���于「流程之外」。
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: '总览',
    caption: '进度 · 下一步',
    items: ['workbench'],
  },
  {
    id: 'prepare',
    label: '准备',
    caption: '你有什么 · 目标是什么',
    items: ['profile', 'job'],
  },
  {
    id: 'assess',
    label: '评估',
    caption: '差距在哪 · 缺的是什么',
    items: ['match', 'interview'],
  },
  {
    id: 'improve',
    label: '提升',
    caption: '怎么补上 · 练到什么程度',
    items: ['training', 'prep', 'mock', 'debrief'],
  },
  {
    id: 'system',
    label: '系统',
    caption: '引擎 · 数据 · 版本能力',
    items: ['settings'],
  },
];

/** 页面 → 所属阶段（UI 当前位置提示用） */
export function groupOf(route: Route): NavGroup | undefined {
  return NAV_GROUPS.find((g) => g.items.includes(route));
}

/**
 * 上一阶段 / 下一阶段。
 *
 * 放在两端外壳里做成「上一环节 / 下一环节」，
 * 是因为「下一步」条只给一个方向，而求职是有往复的 ——
 * 用户练完训练题常常要回档案补证据再重跑匹配。
 */
export function siblingsOf(route: Route): { prev?: NavGroup; next?: NavGroup } {
  const idx = NAV_GROUPS.findIndex((g) => g.items.includes(route));
  if (idx < 0) return {};
  return { prev: NAV_GROUPS[idx - 1], next: NAV_GROUPS[idx + 1] };
}
