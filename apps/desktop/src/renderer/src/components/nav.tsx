import React from 'react';
import type { WorkspaceSnapshot } from '@aijob/core';
import type { Route } from '../state/store';

/**
 * 导航项的唯一定义处。
 *
 * 桌面端侧边栏（components/Layout.tsx）与 Android 端的 Pivot 分页导航
 * （components/MetroShell.tsx）共用这里的 NAV 与 buildNav()。
 *
 * 为什么抽出来：两个外壳都要显示「技能数 / 岗位数 / 报告数 / 已问诊 / 训练题 / 复盘次数」，
 * 各写一份就等于同一条事实有两个落点 —— 以后加一个计数口径，必然只改一处。
 * 抽出来后 Layout.tsx 里原来的内联实现已注释留痕（见该文件）。
 */

export interface NavItem {
  id: Route;
  label: string;
  hint: string;
  /**
   * 原始计数。
   * 桌面端只用 badge（字符串，带单位）；Android 端的枢纽磁贴要把数字放大显示，
   * 所以这里同时给出裸计数，避免两处各算一次、口径漂移。
   * undefined 表示该页此刻没有可展示的计数（例如档案还没建立）。
   */
  count?: number;
  badge?: string;
}

export const NAV: NavItem[] = [
  { id: 'workbench', label: '工作台', hint: '总览与最近分析' },
  { id: 'profile', label: '我的能力档案', hint: '候选人结构化档案' },
  { id: 'job', label: '岗位分析', hint: 'JD → 可判断的要求' },
  { id: 'match', label: '简历匹配', hint: '要求 × 证据 → 结论' },
  { id: 'interview', label: '能力问诊', hint: '按你的能力实际情况出题' },
  { id: 'training', label: '薄弱项训练', hint: '按薄弱项出题训练' },
  { id: 'prep', label: '面试问答', hint: '贴面试问题 → 回答结构' },
  // v0.4 模拟面试。实装已完成，但能力开关仍锁着（since: 'v0.4'）——
  // 所以它默认不出现，详见 docs/ROADMAP.md 里关于这四项的说明。
  { id: 'mock', label: '模拟面试', hint: '系统出题 → 逐轮追问 → 五维分析' },
  { id: 'debrief', label: '面试复盘', hint: '录音 · 转写 · 复盘' },
  { id: 'settings', label: '设置', hint: 'AI Provider / 版本能力' },
];

/**
 * 把当前快照折算成带角标的导航项。
 *
 * 角标口径（与原 Layout.tsx 内联实现逐条一致，迁移时不改语义）：
 *   profile   有档案就显示技能条目数（0 也显示）
 *   job       已分析岗位数 > 0 才显示
 *   match     报告数 > 0 才显示
 *   interview 有档案且已问诊技能数 > 0 时显示「N 项已问」
 *   training  当前岗位训练题数（0 视为无）
 *   debrief   复盘会话数 > 0 时显示「N 次」
 *   settings  无计数
 */
export function buildNav(snapshot: WorkspaceSnapshot): NavItem[] {
  const profile = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0];
  const activeJob = snapshot.jobs.find((j) => j.id === snapshot.ui.activeJobId) ?? snapshot.jobs[0];
  const trainingCount = activeJob
    ? snapshot.trainingPlans.find((p) => p.jobId === activeJob.id)?.items.length
    : undefined;
  const assessedCount = profile ? (profile.assessments ?? []).length : 0;
  const sessionCount = (snapshot.interviewSessions ?? []).length;

  return NAV.map((item) => {
    switch (item.id) {
      case 'profile':
        if (!profile) return item;
        return { ...item, count: profile.skills.length, badge: String(profile.skills.length) };
      case 'job':
        return {
          ...item,
          count: snapshot.jobs.length,
          badge: snapshot.jobs.length > 0 ? String(snapshot.jobs.length) : undefined,
        };
      case 'match':
        return {
          ...item,
          count: snapshot.reports.length,
          badge: snapshot.reports.length > 0 ? String(snapshot.reports.length) : undefined,
        };
      case 'interview':
        if (!profile) return item;
        return {
          ...item,
          count: assessedCount,
          badge: assessedCount > 0 ? `${assessedCount} 项已问` : undefined,
        };
      case 'training':
        return {
          ...item,
          count: trainingCount,
          badge: trainingCount ? `${trainingCount} 题` : undefined,
        };
      case 'debrief':
        return {
          ...item,
          count: sessionCount,
          badge: sessionCount > 0 ? `${sessionCount} 次` : undefined,
        };
      default:
        // settings 等无计数项原样返回
        return item;
    }
  });
}

/**
 * 导航图标。
 *
 * 颜色走变量而不是写死十六进制：
 *   --aijob-icon-active / --aijob-icon-idle 只在 Android 令牌层里定义。
 *   桌面端取不到变量，自动回落到原来的 indigo-600 / slate-400 —— 桌面端外观零变化；
 *   Android 端取到 Metro 的强调色与白色（图标画在蓝色色块上，必须反白）。
 */
export function Icon({ id, active }: { id: Route; active: boolean }) {
  const stroke = active ? 'var(--aijob-icon-active, #4f46e5)' : 'var(--aijob-icon-idle, #94a3b8)';
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
    case 'prep':
      // 对话气泡 + 问号：一眼看出这是「问题 → 答法」
      return (
        <svg {...common}>
          <path d="M3.6 5.4h12.8v8H8.2L4.8 16v-2.6h-1.2z" strokeLinejoin="round" />
          <path d="M8.1 8.2a2 2 0 113.05 1.7c-.6.5-1.15.9-1.15 1.6" strokeLinecap="round" />
          <path d="M10 13.3v.05" strokeLinecap="round" strokeWidth={2.2} />
        </svg>
      );
    case 'mock':
      // 两个人的对话 + 中间的问号：一眼看出这是「对方在问你」
      return (
        <svg {...common}>
          <circle cx="5.4" cy="7.6" r="2.1" />
          <circle cx="10.6" cy="7.6" r="2.1" />
          <path d="M8 7.6h0" strokeLinecap="round" />
          <path d="M3.2 12.4c1.4 1.5 3.2 2.2 4.8 2.2s3.4-.7 4.8-2.2" strokeLinecap="round" />
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
          <path
            d="M10 3v2M10 15v2M3 10h2M15 10h2M5.2 5.2l1.4 1.4M13.4 13.4l1.4 1.4M14.8 5.2l-1.4 1.4M6.6 13.4l-1.4 1.4"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
