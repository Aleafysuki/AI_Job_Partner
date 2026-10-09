import React, { useEffect, useMemo, useRef, useState } from 'react';
import { APP_NAME, APP_TAGLINE, APP_VERSION } from '@aijob/core';
import { NAV_GROUPS, groupOf, type NavGroup } from '../lib/navGroups';
import { nextStepFor, shouldShowNextStep } from '../lib/nextStep';
import { useApp, type Route } from '../state/store';
import { Icon, buildNav, type NavItem } from './nav';

/**
 * 局部 cn ——刻意不从 ./ui 引入。
 *
 * 原因不是洁癖：MetroShell 是外壳，在 React 挂载的第一时间就要渲染；
 * 而 ui.tsx 依赖整个 @aijob/core。把 core 拖进外壳的模块初始化链，
 * 在移动端会明显推迟首屏（实测移动端冒烟直接卡在外壳之后的那次 DOM 查询）。
 * `cn` 只有一行拼接，没必要为它引入一整条依赖链。
 */
function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * 左边缘基准（px）—— 必须与 styles-metro.css 的 `--metro-gutter` 同值。
 *
 * 为什么在 JS 里也存一份：SubTab 选中项「两端贴边」要留多少余量，
 * 这件事只在滚动计算里做得到，而两端各写一个数早晚会不一致 ——
 * 表现为标签时而顶到屏幕边、时而离边很远。
 */
const GUTTER = 18;

/**
 * SubTab 容器的横向内缩量（px）。
 *
 * 看起来多余 —— 容器已经用负 margin 拉出去、用 `scroll-padding` 限位了。
 * 但 `scroll-padding` 只影响**手势滚动**的吸附范围，**不改变内容布局**：
 * 首项的自然起点是容器的 padding box 左边缘（= 屏幕 x=0，因为有负 margin），
 * 而我们希望它落在 x = GUTTER。
 *
 * 所以这一项是「布局补偿」：程序化滚动时把它加上，
 * 手势滑动时由 scroll-padding 负责，两条路径的终点才一致。
 * 少它则首项顶到屏幕边、末项离屏幕边 18px —— 实测正是这个现象。
 */
const SUBTAB_INSET = GUTTER;

/**
 * Metro 移动外壳（Android 宿主）。
 *
 * 与桌面端外壳（components/Layout.tsx，双栏工作台）的关系：
 *   两者是**同一份页面组件的两种外框**。页面（pages/*.tsx）一行都不改，
 *   只是换掉外面这层导航与留白。这也是 docs/ARCHITECTURE.md 里
 *   「界面可以换，只有判断逻辑必须留在中间那一层」的兑现。
 *
 * Metro 的三条形态纪律（对应 styles-metro.css 的实现）：
 *   1. 头部是一整块饱和纯色，标题直接压在色块上，不用卡片包一层；
 *   2. 一级导航是横向可扫的 Pivot 页签（Windows Phone 的 Pivot 控件），
 *      不是底部 Tab —— 底部 Tab 属于 Material 语系；
 *   3. 首页给一组大色块磁贴做入口，数字即内容、整块即控件。
 *
 * 为什么 Pivot 放头部而不是固定在底部：
 *   Metro 的导航属于「页面的一部分」，随内容一起滚出视野；
 *   底部固定栏会把 8 个页签挤成图标，丢掉文字标签的可读性。
 */

/** 8 个页面在移动端的标题与副标题（比桌面端的 hint 更适合大字排版） */
const PAGE_TITLE: Record<Route, { title: string; subtitle: string }> = {
  workbench: { title: '工作台', subtitle: '你的求职能力分析与训练伙伴' },
  profile: { title: '我的能力档案', subtitle: '技能 · 证据 · 项目经历，AI 不是最终数据拥有者' },
  job: { title: '岗位分析', subtitle: '把 JD 拆成一条条可以独立判断的要求' },
  match: { title: '简历匹配', subtitle: '要求 × 证据 → 五种结论之一，不给 0–100 分' },
  interview: { title: '能力问诊', subtitle: '按你的能力实际情况出题，多数题点一下就能答' },
  training: { title: '薄弱项训练', subtitle: '只练这次匹配里真实没答上的要求' },
  prep: { title: '面试问答', subtitle: '贴面试问题 → 回答结构，不给能背的答案' },
  mock: { title: '模拟面试', subtitle: '系统出题 → 你答 → 五维分析，只说缺什么' },
  debrief: { title: '面试复盘', subtitle: '录音 · 转写 · 18 维复盘，面试之后再看' },
  settings: { title: '设置', subtitle: 'AI Provider · 隐私留痕 · 版本能力开关' },
};

const BUSY_TEXT: Record<string, string> = {
  resume: '正在解析简历…',
  job: '正在拆解岗位…',
  match: '正在匹配分析…',
};

/**
 * 枢纽磁贴：Metro 的标志性大色块。
 *
 * 只在工作台页出现，作为进入各功能页的快捷入口。
 * 用磁贴色板而不是统一的强调色，是为了让「去哪一页」这件事在视觉上可被记住
 * —— 这是 Metro 用颜色编码信息的原始意图，不是为了好看。
 */
const TILE: Array<{ route: Route; color: string; caption: string }> = [
  { route: 'profile', color: 'var(--metro-c-blue)', caption: '技能与证据' },
  { route: 'job', color: 'var(--metro-c-teal)', caption: '已分析岗位' },
  { route: 'match', color: 'var(--metro-c-green)', caption: '历史报告' },
  { route: 'interview', color: 'var(--metro-c-amber)', caption: '已问诊技能' },
  { route: 'training', color: 'var(--metro-c-purple)', caption: '当前岗位题量' },
  { route: 'prep', color: 'var(--metro-c-magenta)', caption: '贴问题得答法' },
  { route: 'debrief', color: 'var(--metro-c-blue)', caption: '复盘会话' },
];

function MetroHub({ nav }: { nav: NavItem[] }) {
  const navigate = useApp((s) => s.navigate);
  const snapshot = useApp((s) => s.snapshot);

  /**
   * 磁贴上的数字必须是「这一步做到了没有」，而不是「有多少条记录」。
   *
   * 原来的 caption 是静态描述（「技能与证据」「已分析岗位」），
   * 数字和说明对不上 —— 用户看到「技能 42」不知道是好还是坏。
   * 现在改成：数字是进度，说明是达成后的样子。
   */
  const progress = useMemo(() => {
    const profile = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0];
    const job = snapshot.jobs.find((j) => j.id === snapshot.ui.activeJobId) ?? snapshot.jobs[0];
    const report = job ? snapshot.reports.find((r) => r.job.id === job.id) : undefined;
    return {
      profile: profile ? profile.skills.length : 0,
      hasProfile: Boolean(profile),
      job: snapshot.jobs.length,
      report: report ? `${report.summary.matched}/${report.matches.length}` : '—',
      hasReport: Boolean(report),
      assessed: profile ? (profile.assessments ?? []).length : 0,
      training: job ? (snapshot.trainingPlans.find((p) => p.jobId === job.id)?.items.length ?? 0) : 0,
      prep: 0,
      sessions: (snapshot.interviewSessions ?? []).length,
    };
  }, [snapshot]);

  const tileData: Record<string, { value: string | number; caption: string }> = {
    profile: {
      value: progress.profile,
      caption: progress.hasProfile ? '项技能已归档' : '还没有档案',
    },
    job: { value: progress.job, caption: progress.job > 0 ? '个岗位已拆解' : '还没有岗位' },
    match: { value: progress.report, caption: progress.hasReport ? '条要求已判断' : '还没跑匹配' },
    interview: { value: progress.assessed, caption: progress.assessed > 0 ? '项能力已问诊' : '还没问诊' },
    training: { value: progress.training, caption: progress.training > 0 ? '道薄弱项题' : '还没生成训练' },
    // 面试问答没有「数量」—— 它是即用即走的一次性工具，
    // 显示 0 会让用户以为「还没用过 = 不可用」，所以用「0 条待处理」这种口径
    prep: { value: progress.prep, caption: '贴入问题得答法' },
    debrief: { value: progress.sessions, caption: progress.sessions > 0 ? '次面试记录' : '还没有面试记录' },
  };

  return (
    <section className="metro-hub" aria-label="功能入口">
      <h2 className="metro-hub__label">从这里进入</h2>
      <div className="metro-tiles">
        {TILE.map(({ route, color, caption }) => {
          const item = nav.find((n) => n.id === route);
          if (!item) return null;
          const data = tileData[route];
          return (
            <button
              key={route}
              type="button"
              className="metro-tile"
              style={{ '--tile-color': color } as React.CSSProperties}
              onClick={() => navigate(route)}
            >
              {/* 没有口径时显示 0 而不是「—」：同一屏里一半 0 一半横线，
                  看起来像坏的。0 在这一屏里是准确且一致的表述。 */}
              <span className="metro-tile__value">{data?.value ?? item.count ?? 0}</span>
              <span>
                <span className="metro-tile__label">{item.label}</span>
                <span className="metro-tile__caption">{data?.caption ?? caption}</span>
              </span>
            </button>
          );
        })}

        {/* 宽磁贴：放一句必须被读到的话。隐私承诺是这款产品最该先讲清的事 */}
        <button
          type="button"
          className="metro-tile metro-tile--wide"
          style={{ '--tile-color': 'var(--metro-c-slate)' } as React.CSSProperties}
          onClick={() => navigate('settings')}
        >
          <span className="metro-tile__caption" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            {APP_TAGLINE}
          </span>
          <span className="metro-tile__label" style={{ flex: 'none' }}>
            设置 ›
          </span>
        </button>
      </div>
    </section>
  );
}

export function MetroShell({ children }: { children: React.ReactNode }) {
  const route = useApp((s) => s.route);
  const navigate = useApp((s) => s.navigate);
  const snapshot = useApp((s) => s.snapshot);
  const busy = useApp((s) => s.busy);

  const nav = useMemo(() => buildNav(snapshot), [snapshot]);
  const current = PAGE_TITLE[route];
  const step = useMemo(() => nextStepFor(snapshot, route), [snapshot, route]);
  const showStep = shouldShowNextStep(step, route);

  const pivotRef = useRef<HTMLElement | null>(null);

  /* ---------------------------------------------------------------------------
   * Android 返回键
   * ---------------------------------------------------------------------------
   * WebView 里的硬件返回键默认会「网页后退」，网页没有历史记录时直接退出 App。
   * 这里为每一次页内跳转压一条历史记录，返回键就变成「退到上一个页面」，
   * 退无可退时才交给系统退出 —— 这是 Android 用户对返回键的预期行为。
   *
   * 为什么不引 Capacitor 的 App 插件监听 backButton：
   *   那会让渲染层依赖宿主 SDK。用 history 是纯 Web 能力，
   *   同一份代码在 ?host=android 的桌面预览里行为完全一致，也更容易冒烟测试。
   */
  const firstRender = useRef(true);
  const popHandled = useRef(false);

  /**
   * v0.4 第二轮：导航压缩成「阶段条 + 当前阶段页签」两行。
   *
   * `activeGroupId` 刻意**不跟随 route 自动切换**，而是允许用户先看别的阶段：
   * 如果点阶段就立刻跳走，那这个阶段条就只是个装饰；
   * 允许「先切到某阶段、看看里面有什么、再点具体页面」才是两级导航的意义。
   * 因此只有当 route 变化时才纠正它（见下面的 useEffect）。
   */
  const groupOfRoute = useMemo(() => groupOf(route), [route]);
  const [activeGroupId, setActiveGroupId] = useState<string>(groupOfRoute?.id ?? 'overview');

  /** 记住每个阶段上次停留的页面 —— 见 jumpToGroup 的注释 */
  const lastVisited = useRef<Record<string, Route>>({});

  useEffect(() => {
    if (groupOfRoute) {
      setActiveGroupId(groupOfRoute.id);
      lastVisited.current[groupOfRoute.id] = route;
    }
  }, [route, groupOfRoute]);

  const activeGroup = NAV_GROUPS.find((g) => g.id === activeGroupId);
  const activeItems = activeGroup
    ? nav.filter((n) => activeGroup.items.includes(n.id))
    : nav.filter((n) => n.id === 'workbench');

  /**
   * 切到某个阶段。
   *
   * 跳到该阶段**上次访问的页面**，而不是每次都跳第一个 ——
   * 否则从「档案」想去「面试问答」要点两次（提升→训练，再训练→面试问答）。
   * 从没去过的阶段才跳第一个。
   */
  const jumpToGroup = (group: NavGroup) => {
    setActiveGroupId(group.id);
    const items = nav.filter((n) => group.items.includes(n.id));
    if (items.length === 0) return;
    const remembered = lastVisited.current[group.id];
    const target = remembered && items.some((i) => i.id === remembered) ? remembered : items[0].id;
    navigate(target);
  };

  /**
   * 左右划切页（v0.4 第三轮）。
   *
   * 为什么要自己做手势而不是交给浏览器：Metro 的 Pivot 语义是「横向滑动翻页」，
   * 而 WebView 里没有这个原生控件。用 touch 事件实现，但要守住三条：
   *
   * 1. **只认明显的水平滑动**（位移 > 56px 且横向位移大于纵向 1.5 倍）。
   *    阈值定高一点是因为页面里到处是纵向滚动的内容区，
   *    阈值低了会把「想上下翻」误判成「想左右翻」。
   *
   * 2. **只在本阶段的页签之间翻**。跨阶段翻页不是这个手势的职责 ——
   *    用户心智里「左滑」是「这一段的下一页」，跨段属于「换阶段」，
   *    那是点 Tab 的动作。两件事混在一起会让用户不知道自己在哪。
   *
   * 3. **不劫持子元素的可横滚区域**。页面上有表格与代码块可以横向滚动，
   *    从它们身上起手不应该触发翻页 —— 所以只从内容区的非滚动目标起手，
   *    并且检查起手元素有没有可横滚的祖先。
   */
  const swipeStart = useRef<{ x: number; y: number; scrollable: boolean } | null>(null);

  const hasScrollableAncestor = (el: Element | null): boolean => {
    let node: HTMLElement | null = el as HTMLElement | null;
    while (node && node !== document.body) {
      // overflow-x 已经是 auto/scroll 且内容确实更宽 → 里面能横滑，不该翻页
      const overflowX = getComputedStyle(node).overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  };

  const onTouchStart = (event: React.TouchEvent) => {
    const t = event.touches[0];
    if (!t) return;
    swipeStart.current = {
      x: t.clientX,
      y: t.clientY,
      scrollable: hasScrollableAncestor(event.target as Element),
    };
  };

  const onTouchEnd = (event: React.TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || start.scrollable) return;
    const t = event.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    const list = activeItems.length > 0 ? activeItems : nav.filter((n) => n.id === 'workbench');
    const idx = list.findIndex((n) => n.id === route);
    if (idx < 0) return;
    // 右滑（dx > 0）看上一页，左滑看下一页 —— 与 Tab 顺序一致
    const nextIdx = dx > 0 ? idx - 1 : idx + 1;
    if (nextIdx < 0 || nextIdx >= list.length) return;
    navigate(list[nextIdx].id);
  };

  /* 让当前 Tab / Sub-Tab 滚到合适位置。
   *
   * v0.4 第五轮（用户要求）：
   *   「如果选择到的不是最左边或最右边的 SubTab，则 SubTab 标题自动居中」
   *
   * 这条规则不能用「一律居中」实现 —— 一律居中会把首尾标签也推离边缘，
   * 于是用户看不到「这一组的第一个页面叫什么」。所以分三种情况：
   *
   *   选中第 0 项   → 贴左边缘（还要留出 GUTTER，见下）
   *   选中最后一项  → 贴右边缘
   *   中间各项      → 居中
   *
   * 另外容器已去掉左右 padding（用户要求「字超出屏幕只显示一部分是 OK 的」），
   * 所以贴边时要多留一个 GUTTER 的余量，否则标签会真的顶到屏幕边上。
   */
  useEffect(() => {
    const host = pivotRef.current;
    if (!host) return;

    /**
     * 把元素滚到指定横向位置。
     *
     * `mode` 决定用什么口径：
     *   'inset' —— 贴到可视区边缘再留 SUBTAB_INSET（SubTab 用）
     *   'center' —— 居中（一级 Tab 用）
     *
     * 为什么 SubTab 不能只靠 CSS 的 scroll-padding：
     *   scroll-padding 只管手势滑动的吸附范围，不改布局，也不作用于程序化 scrollTo。
     *   实测缺了这里的补偿，首项顶到屏幕边、末项离边 18px。
     */
    const scrollIntoPlace = (
      el: HTMLElement | null,
      scroller: HTMLElement | null,
      mode: 'inset' | 'center',
    ) => {
      if (!el || !scroller) return;
      const items = Array.from(scroller.querySelectorAll<HTMLElement>(':scope > *'));
      const idx = items.indexOf(el);
      const isFirst = idx === 0;
      const isLast = idx === items.length - 1;

      /*
       * 用 rect 而不是 offsetLeft。
       *
       * offsetLeft 是**不含自身 margin** 的，而首项恰恰靠 `margin-left: gutter`
       * 对齐左边缘 —— 用 offsetLeft 算就会漏掉这一段，结果首项被推到屏幕外。
       * getBoundingClientRect 是屏幕上真实的位置，配合 scrollLeft 刚好是对的口径：
       *   rel = 元素当前屏幕 x − 容器当前屏幕 x + 已滚动距离
       *      = 元素在**可滚动内容**里的起点
       * 这个值与 margin 无关，也不用猜 offsetParent 是谁。
       */
      const rel = el.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;

      let left: number;
      if (mode === 'inset' && (isFirst || isLast)) {
        left = isFirst ? SUBTAB_INSET : rel + el.offsetWidth - scroller.clientWidth + SUBTAB_INSET;
      } else {
        left = rel - scroller.clientWidth / 2 + el.offsetWidth / 2;
      }
      // 限位：绝不允许划过头把标签名弄丢
      const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      scroller.scrollTo({ left: Math.min(Math.max(0, left), max), behavior: 'smooth' });
    };

    const activeTab = host.querySelector<HTMLElement>('.metro-tab.is-active');
    scrollIntoPlace(activeTab, activeTab?.closest<HTMLElement>('.metro-tabs') ?? null, 'center');
    const activePage = host.querySelector<HTMLElement>('.metro-pagetab.is-active');
    scrollIntoPlace(activePage, activePage?.closest<HTMLElement>('.metro-pagetabs') ?? null, 'inset');
  }, [route, activeGroupId]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      // 首次进入用 replaceState 占位，避免多出一条空白历史导致「按两次才退出」
      window.history.replaceState({ aijobRoute: route }, '');
      return;
    }
    if (popHandled.current) {
      popHandled.current = false;
      return;
    }
    window.history.pushState({ aijobRoute: route }, '');
  }, [route]);

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const target = (event.state as { aijobRoute?: Route } | null)?.aijobRoute;
      popHandled.current = true;
      navigate(target ?? 'workbench');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [navigate]);

  return (
    <div className="metro-app" data-route={route}>
      <header className="metro-header">
        <div className="metro-brand">
          <span className="metro-brand__mark">JP</span>
          <span>{APP_NAME}</span>
          <span className="metro-brand__spacer" />
          <span>v{APP_VERSION}</span>
        </div>

        {/*
          v0.4 第四轮：标题区从四层压到三层。

          原来的四层（从上到下）：
            ① 品牌行    JP · AI JOB PARTNER · v0.4.0
            ② 大标题    当前页面名（28px 轻字重）
            ③ 一级 Tab  总览/准备/评估/提升/系统（17px）
            ④ 二级 Sub-Tab  当前阶段的页面（13px + 图标 + 徽标）

          用户给的参考图是三层，关键洞察是：
          **②③ 可以合并 —— 大标题本身就是那一组的 Sub-Tab。**

          Windows Phone 的 Pivot 就是这个构造：标题与导航是同一个东西，
          点「工作台」进总览、点「我的能力档案」进准备，靠的是标题下方的下划线。
          之前我把标题当纯装饰、另起一行放 Sub-Tab，等于把同一个概念说了两遍。

          现在三层：
            ① 品牌行
            ② 一级 Tab   阶段，横向可扫，选中带实心条
            ③ 页面标题   = 当前阶段的 Sub-Tab，超大轻字重，选中带下划线

          ③ 这一行同时承担三件事：告诉你现在在哪、让你换页、显示页面图标与徽标。
          少一行的收益不只是省空间 —— 它让「页面名」这个最重要的信息终于能用到
          Metro 该给它的字号（30px），而不是挤在 13px 的副标签位里。
        */}
        <nav className="metro-tabs" ref={pivotRef} role="tablist" aria-label="求职阶段">
          {NAV_GROUPS.map((group) => {
            const groupItems = nav.filter((n) => group.items.includes(n.id));
            if (groupItems.length === 0) return null;
            const groupActive = group.id === activeGroupId;
            return (
              <button
                key={group.id}
                type="button"
                role="tab"
                aria-selected={groupActive}
                className={groupActive ? 'metro-tab is-active' : 'metro-tab'}
                onClick={() => jumpToGroup(group)}
              >
                {group.label}
              </button>
            );
          })}
        </nav>

        {/* ③ 页面标题 = 这一组的 Sub-Tab。用 <h1> 而不是 <nav> 是因为它就是 h1，
            但它同时可点 —— role="tab" 让读屏软件按标签页念，而不是当成纯标题。 */}
        <h1 className="metro-pagetabs" role="tablist" aria-label={`${activeGroup?.label ?? ''}阶段的页面`}>
          {(activeItems.length > 0 ? activeItems : nav.filter((n) => n.id === 'workbench')).map((item) => {
            const active = route === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? 'metro-pagetab is-active' : 'metro-pagetab'}
                onClick={() => navigate(item.id)}
              >
                <span className="metro-pagetab__icon">
                  <Icon id={item.id} active={active} />
                </span>
                {PAGE_TITLE[item.id].title}
                {item.badge ? <span className="metro-pagetab__badge">{item.badge}</span> : null}
              </button>
            );
          })}
        </h1>
      </header>

      {busy ? (
        <div className="metro-busy" role="status">
          <span className="metro-busy__dot" />
          {BUSY_TEXT[busy] ?? '处理中…'}
        </div>
      ) : null}

      {/*
        内容区（v0.4 第三轮）：挂上左右划手势。

        「下一步」条从 header 下方移进了这里 —— 它是「当前状态」而不是导航，
        混在导航区里会让人误以为它也是一级菜单的一部分。移进来之后它与页面内容
        一起滚走，头部只剩「标题 + Tab + Sub-Tab」三样，导航的边界变干净。
      */}
      <main
        className="metro-content"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/*
          副标题从头部移到这里（v0.4 第三轮）。
          它在头部时要占 2 行约 30px 且不提供决策信息；在内容区第一屏里
          既看得到，又不占常驻空间 —— 读过一次就不用再读了。
        */}
        <p className="metro-lede">{current.subtitle}</p>

        {showStep ? (
          <div className={`metro-next metro-next--${step.level}`} role="status">
            <div className="metro-next__body">
              <span className="metro-next__tag">下一步</span>
              <p className="metro-next__reason">{step.reason}</p>
            </div>
            <button type="button" className="metro-next__cta" onClick={() => navigate(step.route)}>
              {step.action} ›
            </button>
          </div>
        ) : null}

        {route === 'workbench' ? <MetroHub nav={nav} /> : null}
        {children}
      </main>
    </div>
  );
}
