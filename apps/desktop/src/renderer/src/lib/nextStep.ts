import type { WorkspaceSnapshot } from '@aijob/core';
import type { Route } from '../state/store';

/**
 * 全局「下一步」引导（v0.3）
 * ========================
 *
 * 用户反馈：「移动端的 APP 里面，视觉引导有一些混乱」。
 *
 * 这条反馈指向的不是一个样式问题，而是**每一页都在解释自己，却没有一��告诉你现在该干什么**。
 * 现在的结构：每页都有一个 h1 + 一段描述 + 若干张卡片，全都长得一样，
 * 用户打开 App 看到的是八个并列的功能入口，不知道第一步点哪里。
 *
 * 这份表把「当前状态 → 唯一下一步」集中成一个函数，桌面端和移动端共用。
 * 集中在一处的原因和 nav.tsx 一样：这是同一条事实，复制两份必然口径漂移。
 */

export interface NextStep {
  /** 一句话说清现在缺什么 */
  reason: string;
  /** 按钮上的字，必须是一个动作 */
  action: string;
  route: Route;
  /** 没数据时降级到哪一页 */
  fallback?: Route;
  /** 紧急程度：urgent = 什么都做不了；normal = 可以继续但会缺东西 */
  level: 'urgent' | 'normal' | 'done';
}

/**
 * 按当前工作区状态算出唯一下一步。
 *
 * 顺序是有意的，按「阻塞程度」排：
 * 没有档案 → 什么都做不了（urgent）
 * 有档案没岗位 → 分析岗位
 * 有岗位没报告 → 跑匹配，这是整条链路里唯一能看到「差在哪」的环节
 * 有报告有缺口 → 去问诊或训练
 * 都没有明显缺口 → 什么都不用做（done），不要硬造一个任务
 *
 * 最后一条同样重要：一直给「建议做 X」会让用户觉得这个产品不停在推销功能。
 */
export function nextStepFor(snapshot: WorkspaceSnapshot, current: Route): NextStep {
  const profile = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0];
  const job = snapshot.jobs.find((j) => j.id === snapshot.ui.activeJobId) ?? snapshot.jobs[0];
  const report = job ? snapshot.reports.find((r) => r.job.id === job.id) : undefined;

  if (!profile) {
    return {
      reason: '还没有能力档案 —— 这是整条链路的第一步，没有它后面每一步都算不出来。',
      action: '建立能力档案',
      route: 'profile',
      level: 'urgent',
    };
  }

  if (!job) {
    return {
      reason: '档案已就绪。现在需要分析一个岗位，才能知道「岗位要什么、你缺什么」。',
      action: '分析岗位',
      route: 'job',
      level: 'urgent',
    };
  }

  if (!report) {
    return {
      reason: '岗位已拆解。跑一次匹配，就能看到每一条要求你是满足、部分满足还是缺证据。',
      action: '跑匹配分析',
      route: 'match',
      level: 'urgent',
    };
  }

  const unmet = report.summary.gap + report.summary.lackingEvidence + report.summary.partial;
  if (unmet === 0) {
    return {
      reason: `「${job.jobTitle}」的 ${report.matches.length} 条要求都有明确结论，没有明显缺口。`,
      action: '换个岗位分析',
      route: 'job',
      level: 'done',
    };
  }

  const lackEvidence = report.summary.lackingEvidence + report.summary.partial;
  if (lackEvidence >= report.summary.gap) {
    return {
      reason: `有 ${unmet} 条要求没完全满足，其中 ${lackEvidence} 条是「说得出但拿不出证据」—— 这一类最快能补上。`,
      action: '去做能力问诊',
      route: 'interview',
      level: 'normal',
    };
  }

  return {
    reason: `有 ${report.summary.gap} 条要求在你的档案里完全找不到痕迹，属于真实的能力缺口。`,
    action: '看薄弱项训练',
    route: 'training',
    level: 'normal',
  };
}

/** 是否应该把引导条显示出来（已经完成全部链路时收起来，不硬推） */
export function shouldShowNextStep(step: NextStep, current: Route): boolean {
  if (step.level === 'done') return false;
  // 已经在目标页时不重复提示
  return step.route !== current;
}