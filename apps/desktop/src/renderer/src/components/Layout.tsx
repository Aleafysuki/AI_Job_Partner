import React from 'react';
import { APP_NAME, APP_TAGLINE, APP_VERSION } from '@aijob/core';
// `type Route` 随 NavItem / NAV 一并迁到 components/nav.tsx，本文件不再直接引用。
// 原写法留痕（勿删）：import { useApp, type Route } from '../state/store';
import { useApp } from '../state/store';
import { NAV_GROUPS, groupOf, siblingsOf } from '../lib/navGroups';
import { nextStepFor, shouldShowNextStep } from '../lib/nextStep';
import { Badge, cn } from './ui';
import { Icon, buildNav } from './nav';

/* ===========================================================================
 * 迁移留痕（勿删，确认无误后再清理）
 * ---------------------------------------------------------------------------
 * 下面这三块 —— NavItem 接口、NAV 数组、Icon 组件 —— 已原样迁到
 * components/nav.tsx，本文件改为从那里导入。
 *
 * 迁移原因：Android 端的 Pivot 分页导航（components/MetroShell.tsx）需要
 * 同一份导航定义与同一套角标口径。若各写一份，以后新增一个计数口径必然只改
 * 其中一处，两个宿主显示的数字就会不一致。
 *
 * 按项目约定保留原文而不删除。
 *
interface NavItem {
  id: Route;
  label: string;
  hint: string;
  badge?: string;
}

const NAV: NavItem[] = [
  { id: 'workbench', label: '工作台', hint: '总览与最近分析' },
  { id: 'profile', label: '我的能力档案', hint: '候选人结构化档案' },
  { id: 'job', label: '岗位分析', hint: 'JD → 可判断的要求' },
  { id: 'match', label: '简历匹配', hint: '要求 × 证据 → 结论' },
  { id: 'interview', label: '能力问诊', hint: '问答探测掌握程度' },
  { id: 'training', label: '薄弱项训练', hint: '按薄弱项出题训练' },
  { id: 'debrief', label: '面试复盘', hint: '录音 · 转写 · 复盘' },
  { id: 'settings', label: '设置', hint: 'AI Provider / 版本能力' },
];

function Icon({ id, active }: { id: Route; active: boolean }) {
  const stroke = active ? '#4f46e5' : '#94a3b8';
  const common = { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke, strokeWidth: 1.6 } as const;
  switch (id) {
    case 'workbench':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="6" height="6" rx="1.5" />
          <rect x="11" y="3" width="6" height="6" rx="1.5" />
          <rect x="3" y="11" width="6" height="6" rx="1.5" />
          <rect x="11" y="11" width="6" height="6" rx="1.5" />
        </svg>
      );
    case 'profile':
      return (
        <svg {...common}>
          <circle cx="10" cy="7" r="3.2" />
          <path d="M3.6 17c.7-3.2 3.3-4.8 6.4-4.8s5.7 1.6 6.4 4.8" strokeLinecap="round" />
        </svg>
      );
    case 'job':
      return (
        <svg {...common}>
          <rect x="3" y="5.5" width="14" height="10.5" rx="2" />
          <path d="M7.5 5.5V4.4c0-.8.6-1.4 1.4-1.4h2.2c.8 0 1.4.6 1.4 1.4v1.1" />
          <path d="M3 10.2h14" />
        </svg>
      );
    case 'match':
      return (
        <svg {...common}>
          <path d="M4 16V9M10 16V4M16 16v-5" strokeLinecap="round" />
        </svg>
      );
    case 'interview':
      return (
        <svg {...common}>
          <path d="M4 5.5h12v8H9.5L6 16.5v-3H4z" strokeLinejoin="round" />
        </svg>
      );
    case 'training':
      return (
        <svg {...common}>
          <path d="M4 5.5h5.5M4 10h5.5M4 14.5h5.5" strokeLinecap="round" />
          <path d="M12.5 10.2l2.2 2.2 3.3-3.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12.5 15.4l2.2 2.2 3.3-3.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'debrief':
      // 话筒 + 声波：一眼看出这是「录音 → 复盘」
      return (
        <svg {...common}>
          <rect x="8" y="3" width="4" height="8.5" rx="2" />
          <path d="M5.5 9.5a4.5 4.5 0 0 0 9 0" strokeLinecap="round" />
          <path d="M10 14v3M7.5 17h5" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="2.6" />
          <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.2 5.2l1.4 1.4M13.4 13.4l1.4 1.4M14.8 5.2l-1.4 1.4M6.6 13.4l-1.4 1.4" strokeLinecap="round" />
        </svg>
      );
  }
}

 * ===========================================================================
 */

export function Layout({ children }: { children: React.ReactNode }) {
  const route = useApp((s) => s.route);
  const navigate = useApp((s) => s.navigate);
  const snapshot = useApp((s) => s.snapshot);
  const busy = useApp((s) => s.busy);

  /* 角标口径改由 components/nav.tsx 的 buildNav() 统一计算，
   * 与 Android 端 Pivot 导航共用。原内联实现注释留痕（口径逐条一致）：
   *
  const profile = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0];
  const activeJob = snapshot.jobs.find((j) => j.id === snapshot.ui.activeJobId) ?? snapshot.jobs[0];
  const trainingCount = activeJob ? snapshot.trainingPlans.find((p) => p.jobId === activeJob.id)?.items.length : undefined;

  const nav = NAV.map((item) => {
    if (item.id === 'profile' && profile) {
      return { ...item, badge: String(profile.skills.length) };
    }
    if (item.id === 'job') {
      return { ...item, badge: snapshot.jobs.length > 0 ? String(snapshot.jobs.length) : undefined };
    }
    if (item.id === 'match') {
      return { ...item, badge: snapshot.reports.length > 0 ? String(snapshot.reports.length) : undefined };
    }
    if (item.id === 'interview' && profile) {
      const assessed = (profile.assessments ?? []).length;
      return { ...item, badge: assessed > 0 ? `${assessed} 项已问` : undefined };
    }
    if (item.id === 'training') {
      return { ...item, badge: trainingCount ? `${trainingCount} 题` : undefined };
    }
    if (item.id === 'debrief') {
      const sessions = snapshot.interviewSessions ?? [];
      return { ...item, badge: sessions.length > 0 ? `${sessions.length} 次` : undefined };
    }
    return item;
  });
   */
  const nav = buildNav(snapshot);

  return (
    <div className="flex h-full">
      <aside className="flex w-[236px] shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="px-4 pb-3 pt-5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-xs font-bold text-white">
              JP
            </span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-slate-800">{APP_NAME}</div>
              <div className="text-[10px] text-slate-400">v{APP_VERSION}</div>
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{APP_TAGLINE}</p>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-2">
          {/*
            v0.4：导航按求职阶段分组（准备 → 评估 → 提升 → 系统）。
            分组定义在 lib/navGroups.ts，与 Android 端 Pivot 共用同一份 ——
            分成两份必然只改一处，两个宿主就会给出不同的结构。
          */}
          {NAV_GROUPS.map((group) => {
            const items = nav.filter((item) => group.items.includes(item.id));
            if (items.length === 0) return null;
            return (
              <div key={group.id} className="mb-3">
                <div className="px-2.5 pb-1 pt-2">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[10px] font-semibold tracking-[0.12em] text-slate-400">
                      {group.label}
                    </span>
                    <span className="truncate text-[10px] text-slate-300">{group.caption}</span>
                  </div>
                </div>
                <div className="space-y-0.5">
                  {items.map((item) => {
                    const active = route === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => navigate(item.id)}
                        className={cn(
                          'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                          active ? 'bg-indigo-50' : 'hover:bg-slate-50',
                        )}
                      >
                        <Icon id={item.id} active={active} />
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              'block truncate text-[13px]',
                              active ? 'font-medium text-indigo-700' : 'text-slate-700',
                            )}
                          >
                            {item.label}
                          </span>
                          <span className="block truncate text-[10px] text-slate-400">{item.hint}</span>
                        </span>
                        {item.badge ? (
                          <Badge tone={active ? 'accent' : 'muted'} className="shrink-0">
                            {item.badge}
                          </Badge>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="border-t border-slate-100 px-3 py-3">
          {busy ? (
            <div className="mb-2 flex items-center gap-2 rounded-md bg-indigo-50 px-2.5 py-1.5 text-[11px] text-indigo-700">
              <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
              {busy === 'resume' ? '正在解析简历…' : busy === 'job' ? '正在拆解岗位…' : busy === 'match' ? '正在匹配分析…' : '处理中…'}
            </div>
          ) : null}
          <div className="text-[10px] leading-relaxed text-slate-400">
            数据默认保存在本机，不建立账号。
            <br />
            简历在进入分析前会先做隐私脱敏。
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {/*
          顶部条（v0.4）：当前位置 + 唯一下一步。
          加面包屑是为了回答「我现在在哪一段」——
          分组导航解决了入口的顺序感，但进去之后就看不到了。
          nextStepFor 与 MetroShell 用同一个函数，两个宿主不会给出互相矛盾的建议。
        */}
        {(() => {
          const step = nextStepFor(snapshot, route);
          const group = groupOf(route);
          const sib = siblingsOf(route);
          return (
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-7 py-2.5">
              {group ? (
                <div className="flex items-center gap-1.5 text-[12px]">
                  <span className="text-slate-400">当前阶段</span>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] font-medium text-white">
                    {group.label}
                  </span>
                  <span className="text-slate-400">{group.caption}</span>
                </div>
              ) : (
                <div className="text-[12px] text-slate-400">总览</div>
              )}

              {/* 阶段之间可以往复 —— 练完训练题常常要回档案补证据再重跑匹配 */}
              {sib.prev || sib.next ? (
                <div className="flex items-center gap-1.5">
                  {sib.prev ? (
                    <button
                      onClick={() => navigate(sib.prev!.items[0])}
                      className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:bg-slate-100"
                    >
                      ← {sib.prev.label}
                    </button>
                  ) : null}
                  {sib.next ? (
                    <button
                      onClick={() => navigate(sib.next!.items[0])}
                      className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:bg-slate-100"
                    >
                      {sib.next.label} →
                    </button>
                  ) : null}
                </div>
              ) : null}

              <span className="flex-1" />

              {shouldShowNextStep(step, route) ? (
                <div className="flex items-center gap-2.5">
                  <span className="rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    下一步
                  </span>
                  <span className="max-w-[420px] text-[12px] leading-relaxed text-indigo-900">{step.reason}</span>
                  <button
                    onClick={() => navigate(step.route)}
                    className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-indigo-700"
                  >
                    {step.action} ›
                  </button>
                </div>
              ) : null}
            </div>
          );
        })()}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1080px] px-7 py-6">{children}</div>
        </div>
      </main>
    </div>
  );
}
