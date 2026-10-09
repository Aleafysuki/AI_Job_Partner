import {
  CAPABILITY_LEVELS,
  CAPABILITY_LEVEL_ORDER,
  levelReference,
  type CapabilityLevel,
} from '@aijob/core';
import { Collapsible } from './ui';

/**
 * 等级对照（v0.4）
 * ==============
 *
 * 用户反馈：「多个层级的关系有点乱，整理并重新分级」。
 *
 * 系统里本来有五套刻度、19 个档位标签，用户看到「熟练 / 中 / 部分满足」
 * 时无从判断它们谁高谁低。核心层的修法是 `domain/levels.ts`
 * （把五套收敛到一条四级的���线）；这个组件负责**界面上把关系讲出来**。
 *
 * 设计上的两个取舍：
 *
 * 1. **默认收起**，不占版面。等级是辅助信息，用户在匹配结论页要的是结论本身。
 *    但凡出现多个等级标签的地方都要能一键展开 —— 不能让用户「找不到」。
 *
 * 2. **精确对应与大致对应必须视觉上分开**。
 *    证据强度是精确的（定义上就是「这条证据自己能站到第几级」），
 *    而匹配结论是粗的（它衡量的是「要求」不是「能力」，还��硬门槛左右）。
 *    把它们画成同一种表格等于骗人。
 */

const LEVEL_TONE: Record<CapabilityLevel, string> = {
  L4: 'border-emerald-200 bg-emerald-50',
  L3: 'border-sky-200 bg-sky-50',
  L2: 'border-amber-200 bg-amber-50',
  L1: 'border-slate-200 bg-slate-50',
};

const LEVEL_TEXT: Record<CapabilityLevel, string> = {
  L4: 'text-emerald-800',
  L3: 'text-sky-800',
  L2: 'text-amber-800',
  L1: 'text-slate-700',
};

/** 单个能力层级徽标 —— 界面上任何需要表达「到第几级」的地方都用它 */
export function LevelBadge({ level, showLabel = true }: { level: CapabilityLevel; showLabel?: boolean }) {
  const def = CAPABILITY_LEVELS[level];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${LEVEL_TONE[level]} ${LEVEL_TEXT[level]}`}
    >
      <span>{def.short}</span>
      {showLabel ? <span className="opacity-70">{def.label}</span> : null}
    </span>
  );
}

/**
 * 完整的对照表（默认收起）。
 *
 * 放在匹配报告页与档案页 —— 这两处是多套刻度同时出现的地方，
 * 也就是用户最需要这张表的地方。
 */
export function LevelLegend({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const ref = levelReference();

  return (
    <Collapsible title="这几个等级是什么关系？" defaultOpen={defaultOpen}>
      <div className="space-y-4">
        {/* 主线：四级，先讲清楚唯一的那一条 */}
        <div>
          <div className="text-[11px] font-medium text-slate-700">{ref.groups[0].title}</div>
          <div className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{ref.groups[0].what}</div>
          <div className="mt-2 space-y-1.5">
            {ref.main.map((def) => (
              <div key={def.id} className={`rounded-lg border px-3 py-2 ${LEVEL_TONE[def.id]}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-[12px] font-semibold ${LEVEL_TEXT[def.id]}`}>{def.label}</span>
                  <span className="text-[10px] opacity-70">{def.criteria}</span>
                </div>
                <div className="mt-0.5 text-[10px] leading-relaxed opacity-80">
                  怎么升上去：{def.toNext}
                  {def.canWriteInResume ? ' · 这一级可以写进简历' : ' · 这一级先别写进简历'}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 其余刻度：分组列出，并明确标注「精确」还是「大致」 */}
        {ref.groups.slice(1).map((group) => (
          <div key={group.title}>
            <div className="text-[11px] font-medium text-slate-700">{group.title}</div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{group.what}</div>
            <div className="mt-1.5 space-y-1">
              {group.rows.map((row, i) => (
                <div key={i} className="flex flex-wrap items-start gap-x-2 gap-y-0.5 text-[11px]">
                  <span className="min-w-[128px] shrink-0 text-slate-700">{row.from}</span>
                  <span className="shrink-0">→</span>
                  <span className={`shrink-0 font-medium ${LEVEL_TEXT[row.to]}`}>{row.toLabel}</span>
                  <span
                    className={`shrink-0 rounded px-1 text-[9px] ${
                      row.exact ? 'bg-slate-200 text-slate-600' : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {row.exact ? '精确对应' : '大致对应'}
                  </span>
                  {row.note ? (
                    <span className="flex-1 text-[10px] leading-relaxed text-slate-400">{row.note}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[10px] leading-relaxed text-amber-800">
          <span className="font-medium">「大致对应」不等于「等同」。</span>
          匹配结论看起来像是在说能力，但它衡量的是「岗位的某一条要求」，
          而且会被硬门槛左右 —— 学历不满足时，那条要求就是没满足，
          与你实际会不会那个技能无关。所以不能拿它直接当能力判断。
        </div>
      </div>
    </Collapsible>
  );
}

/** 供页面直接读取主线标签，避免各处重复写中文 */
export { CAPABILITY_LEVELS, CAPABILITY_LEVEL_ORDER };
