import { useEffect, useMemo, useState } from 'react';
import {
  DEBRIEF_MODE_LABEL,
  DEBRIEF_QUESTION_CATEGORY_LABEL,
  DEBRIEF_SESSION_STATUS_LABEL,
  DEBRIEF_TIER_LABEL,
  DEBRIEF_TOPIC_LABEL,
  DEBRIEF_DIM_STATUS_LABEL,
  PERFORMANCE_OVERALL_LABEL,
  SAMPLE_INTERVIEW_TRANSCRIPT,
  SPEAKER_LABEL,
  formatDateTime,
  isEnabled,
  radarSvg,
  summarizeAnonymize,
  type DebriefDimension,
  type DebriefMode,
  type DebriefQuestionCategory,
  type InterviewDebriefReport,
  type InterviewDebriefSession,
} from '@aijob/core';
import {
  Badge,
  Banner,
  Button,
  Callout,
  Card,
  CardHeader,
  Collapsible,
  EmptyState,
  Field,
  SectionTitle,
  Select,
  Stat,
  TextArea,
  Toggle,
  cn,
} from '../components/ui';
import { useApp } from '../state/store';

/**
 * 面试复盘页。
 *
 * 页面的信息架构跟「录制前 / 录制中 / 录制后」三段一致：
 *
 *   录制前 —— 选形态、选音源、确认合规提示（一次性）
 *   录制中 —— 界面**不需要看**，因为静默模式会把窗口藏起来；
 *             留下来的这块只在「非静默录制」时才有人看
 *   录制后 —— 转写文本可核对可修正 → 生成复盘 → 看报告 → 导出
 *
 * 一条刻意的设计：**复盘报告不在面试过程中出现**。
 * 这一页在录音状态下不显示任何分析结果，也不会在面试进行时刷新出结论。
 */

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function Radar({ title, series, note }: { title: string; series: Array<{ axis: string; value: number | null }>; note?: string }) {
  const html = useMemo(() => radarSvg({ title, series, note }), [title, series, note]);
  return <div className="[&_figure]:m-0" dangerouslySetInnerHTML={{ __html: html }} />;
}

function DimensionCard({ dim }: { dim: DebriefDimension }) {
  const tone = dim.status === 'ok' ? 'success' : dim.status === 'partial' ? 'warning' : 'muted';
  return (
    <Card>
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{dim.id}</Badge>
          <span className="flex-1 text-[13px] font-medium text-slate-800">{dim.name}</span>
          <Badge tone={tone}>{DEBRIEF_DIM_STATUS_LABEL[dim.status]}</Badge>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-slate-700">{dim.verdictLine}</p>

        {dim.findings.length > 0 ? (
          <div className="mt-2 space-y-1">
            {dim.findings.map((f, i) => (
              <div key={`${dim.id}-f${i}`} className="flex gap-2 text-[12px] leading-relaxed text-slate-600">
                <Badge tone={f.basis === 'stated' ? 'success' : 'muted'} className="mt-0.5 shrink-0">
                  {f.basis === 'stated' ? '原话' : '推断'}
                </Badge>
                <span className="flex-1">
                  {f.text}
                  <span className="ml-1 font-mono text-[10px] text-slate-400">{f.evidenceIds.join(' ')}</span>
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {dim.computation ? (
          <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2">
            <div className="font-mono text-[11px] text-slate-500">{dim.computation.formula}</div>
            <div className="mt-1 font-mono text-[11px] text-slate-500">
              输入 {JSON.stringify(dim.computation.inputs)}
            </div>
            <div className="font-mono text-[11px] text-slate-500">结果 {JSON.stringify(dim.computation.result)}</div>
            <div className="mt-1 text-[11px] leading-relaxed text-slate-600">{dim.computation.verdict}</div>
          </div>
        ) : null}

        {dim.unknowns.length > 0 ? (
          <div className="mt-2">
            <div className="text-[10px] font-medium text-slate-400">未知项</div>
            <ul className="mt-0.5 space-y-0.5">
              {dim.unknowns.map((u, i) => (
                <li key={`${dim.id}-u${i}`} className="text-[11px] leading-relaxed text-slate-500">
                  · {u}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {dim.questions.length > 0 ? (
          <Collapsible title={`这一维度产生的问题（${dim.questions.length}）`}>
            <ul className="space-y-1">
              {dim.questions.map((q, i) => (
                <li key={`${dim.id}-q${i}`} className="flex gap-2 text-[12px] leading-relaxed text-slate-600">
                  <Badge tone={q.priority === 'high' ? 'danger' : q.priority === 'medium' ? 'warning' : 'muted'} className="mt-0.5 shrink-0">
                    {q.priority}
                  </Badge>
                  <span className="flex-1">{q.text}</span>
                </li>
              ))}
            </ul>
          </Collapsible>
        ) : null}
      </div>
    </Card>
  );
}

function ReportView({ report }: { report: InterviewDebriefReport }) {
  const opportunity = report.dimensions.filter((d) => d.kind === 'opportunity');
  const performance = report.dimensions.filter((d) => d.kind === 'performance');
  const grouped = new Map<DebriefQuestionCategory, typeof report.questions>();
  for (const q of report.questions) {
    const list = grouped.get(q.category) ?? [];
    list.push(q);
    grouped.set(q.category, list);
  }

  const tierTone = report.synthesis.tier === 'consider' ? 'success' : report.synthesis.tier === 'mismatch' ? 'danger' : report.synthesis.tier === 'caution' ? 'warning' : 'muted';

  return (
    <div className="space-y-4">
      {/* 先结论 */}
      <Card>
        <CardHeader
          title="先结论"
          subtitle={`${DEBRIEF_MODE_LABEL[report.meta.mode]} · ${formatDuration(report.meta.durationMs)} · ${report.meta.transcriptChars} 字转写 · ${report.evidence.length} 条事实 · 置信度 ${report.meta.confidence}`}
          action={<Badge tone={tierTone}>{DEBRIEF_TIER_LABEL[report.synthesis.tier]}</Badge>}
        />
        <div className="space-y-3 px-5 py-4">
          <p className="text-[15px] font-semibold leading-relaxed text-slate-800">{report.synthesis.oneLine}</p>
          <p className="text-[12px] leading-relaxed text-slate-600">{report.synthesis.verdictParagraph}</p>
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/70 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold text-indigo-700">下一步（只有这一件）</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-indigo-900">{report.synthesis.nextAction}</div>
          </div>
          {report.synthesis.highlights.length > 0 ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-slate-500">一处速览</div>
              <ul className="space-y-1">
                {report.synthesis.highlights.map((h, i) => (
                  <li key={`h${i}`} className="text-[12px] leading-relaxed text-slate-600">
                    · {h.text} <span className="font-mono text-[10px] text-slate-400">{h.evidenceIds.join(' ')}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Card>

      {/* 可视化 */}
      <Card>
        <CardHeader title="可视化" subtitle="「—」表示材料里没有依据。空轴不参与连线，不用 0 分伪造。" />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
          <Radar title="压力来源分布" series={report.charts.pressure} />
          <Radar title="个体适配度" series={report.charts.fit} />
          <Radar title="面试表现" series={report.charts.performance} />
        </div>
        {report.charts.workloadTime ? (
          <div className="border-t border-slate-100 px-5 py-3">
            <div className="text-[12px] font-medium text-slate-700">工作量时间测算</div>
            <div className="mt-1 font-mono text-[11px] text-slate-500">{report.charts.workloadTime.formula}</div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="border-b border-slate-100 py-1 pr-3 font-medium">单件耗时</th>
                    <th className="border-b border-slate-100 py-1 pr-3 font-medium">纯处理</th>
                    <th className="border-b border-slate-100 py-1 pr-3 font-medium">剩余</th>
                    <th className="border-b border-slate-100 py-1 font-medium">可行性</th>
                  </tr>
                </thead>
                <tbody>
                  {report.charts.workloadTime.rows.map((row, i) => (
                    <tr key={`wt${i}`} className="text-slate-600">
                      <td className="border-b border-slate-50 py-1 pr-3">{String(row.perItemSeconds ?? '—')} 秒</td>
                      <td className="border-b border-slate-50 py-1 pr-3">{String(row.pureMinutes ?? '—')} 分</td>
                      <td className="border-b border-slate-50 py-1 pr-3">{String(row.remainingMinutes ?? '—')} 分</td>
                      <td className="border-b border-slate-50 py-1">{String(row.feasibility ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{report.charts.workloadTime.verdict}</p>
          </div>
        ) : null}
        {report.charts.compensation ? (
          <div className="border-t border-slate-100 px-5 py-3">
            <div className="text-[12px] font-medium text-slate-700">单位时间回报测算</div>
            <div className="mt-1 font-mono text-[11px] text-slate-500">{report.charts.compensation.formula}</div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="border-b border-slate-100 py-1 pr-3 font-medium">情景</th>
                    <th className="border-b border-slate-100 py-1 pr-3 font-medium">月收入</th>
                    <th className="border-b border-slate-100 py-1 pr-3 font-medium">月工作天数</th>
                    <th className="border-b border-slate-100 py-1 pr-3 font-medium">每日时长</th>
                    <th className="border-b border-slate-100 py-1 font-medium">元/小时</th>
                  </tr>
                </thead>
                <tbody>
                  {report.charts.compensation.rows.map((row, i) => (
                    <tr key={`cp${i}`} className="text-slate-600">
                      <td className="border-b border-slate-50 py-1 pr-3">{String(row.scenario ?? '—')}</td>
                      <td className="border-b border-slate-50 py-1 pr-3">{String(row.monthlyIncome ?? '—')}</td>
                      <td className="border-b border-slate-50 py-1 pr-3">{String(row.workDays ?? '—')}</td>
                      <td className="border-b border-slate-50 py-1 pr-3">{String(row.dailyHours ?? '—')}</td>
                      <td className="border-b border-slate-50 py-1">{String(row.hourly ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{report.charts.compensation.verdict}</p>
          </div>
        ) : null}
      </Card>

      {/* 面试表现 */}
      <Card>
        <CardHeader
          title="面试表现"
          subtitle="只看「能不能说出可核对的东西」，不评价音色、语速、口音与自信程度"
          action={<Badge tone="accent">{PERFORMANCE_OVERALL_LABEL[report.performance.overall]}</Badge>}
        />
        <div className="space-y-3 px-5 py-4">
          <div className="grid gap-2 sm:grid-cols-3">
            <Stat label="回答段数" value={report.performance.answerTurns} />
            <Stat label="含可核对事实" value={report.performance.factBackedTurns} hint="有数字 / 时间 / 动作 / 交付物" />
            <Stat label="只有评价性表述" value={report.performance.vagueTurns} />
          </div>
          {report.performance.strengths.length > 0 ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-emerald-700">站得住的部分</div>
              <ul className="space-y-0.5">
                {report.performance.strengths.map((s, i) => (
                  <li key={`st${i}`} className="text-[12px] leading-relaxed text-slate-600">
                    · {s}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {report.performance.weaknesses.length > 0 ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-amber-700">可以更好的部分</div>
              <ul className="space-y-0.5">
                {report.performance.weaknesses.map((s, i) => (
                  <li key={`wk${i}`} className="text-[12px] leading-relaxed text-slate-600">
                    · {s}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {report.performance.improvable.length > 0 ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-indigo-700">怎么改</div>
              <ul className="space-y-1">
                {report.performance.improvable.map((item, i) => (
                  <li key={`im${i}`} className="text-[12px] leading-relaxed text-slate-600">
                    <span className="font-medium text-slate-700">{item.point}</span>：{item.howTo}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Card>

      {/* 岗位适配度 */}
      <Card>
        <CardHeader
          title="岗位适配度"
          subtitle={report.fit.basedOn === 'match_report' ? '在已有匹配报告基础上叠加面试信息' : '只依据这场面试谈到的事实'}
          action={<Badge tone={report.fit.status === 'ok' ? 'success' : report.fit.status === 'partial' ? 'warning' : 'muted'}>{DEBRIEF_DIM_STATUS_LABEL[report.fit.status]}</Badge>}
        />
        <div className="space-y-3 px-5 py-4">
          <p className="text-[12px] leading-relaxed text-slate-600">{report.fit.summary}</p>
          {report.fit.items.length > 0 ? (
            <div className="space-y-1.5">
              {report.fit.items.map((item) => (
                <div key={item.key} className="flex items-start gap-3 rounded-lg border border-slate-200 px-3 py-2">
                  <div className="w-[104px] shrink-0 text-[12px] text-slate-700">{item.label}</div>
                  <div className="w-14 shrink-0 text-center text-[13px] font-semibold text-slate-800">
                    {item.score === null ? '—' : `${item.score}/5`}
                  </div>
                  <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-slate-500">
                    {item.reason}
                    {item.touchedBoundary ? <Badge tone="danger" className="ml-1">触碰边界</Badge> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {report.fit.boundaryHits.length > 0 ? (
            <Banner tone="warning" title="命中你写下的偏好边界">
              有 {report.fit.boundaryHits.length} 项与你档案里的偏好冲突：{report.fit.boundaryHits.join('、')}。报告只做提示，取舍由你决定。
            </Banner>
          ) : null}
        </div>
      </Card>

      {/* 维度明细 */}
      <div>
        <SectionTitle title="机会侧：这个岗位实际是什么样" description="D1–D12，每条结论都挂着原始事实编号" />
        <div className="space-y-2">
          {opportunity.map((d) => (
            <DimensionCard key={d.id} dim={d} />
          ))}
        </div>
      </div>

      <div>
        <SectionTitle title="表现侧：我这次答得怎么样" description="P1–P6，只看可核对的内容，不看表达风格" />
        <div className="space-y-2">
          {performance.map((d) => (
            <DimensionCard key={d.id} dim={d} />
          ))}
        </div>
      </div>

      {/* 问题清单 */}
      {report.questions.length > 0 ? (
        <Card>
          <CardHeader title={`还需要问清的问题（${report.questions.length}）`} subtitle="可以直接复制发给对方；标了优先级的先问" />
          <div className="space-y-3 px-5 py-4">
            {[...grouped.entries()].map(([category, list]) => (
              <div key={category}>
                <div className="mb-1 text-[11px] font-semibold text-indigo-700">{DEBRIEF_QUESTION_CATEGORY_LABEL[category]}</div>
                <ul className="space-y-1">
                  {list.map((q, i) => (
                    <li key={`q-${category}-${i}`} className="flex gap-2 text-[12px] leading-relaxed text-slate-600">
                      <Badge tone={q.priority === 'high' ? 'danger' : q.priority === 'medium' ? 'warning' : 'muted'} className="mt-0.5 shrink-0">
                        {q.priority}
                      </Badge>
                      <span className="flex-1">{q.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* 决策表与情景 */}
      <Card>
        <CardHeader title="三档决策表" subtitle="条件只能来自上面 D1–D10 的结论，不新造" />
        <div className="space-y-2 px-5 py-4">
          {report.synthesis.decisionTable.map((tier) => (
            <div key={tier.key} className="rounded-lg border border-slate-200 px-3 py-2">
              <div className="text-[12px] font-medium text-slate-700">{tier.label}</div>
              {tier.conditions.length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {tier.conditions.map((c, i) => (
                    <li key={`${tier.key}-${i}`} className="text-[11px] leading-relaxed text-slate-500">
                      · {c}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-0.5 text-[11px] text-slate-400">没有命中这一档的条件</div>
              )}
            </div>
          ))}
        </div>
        {report.synthesis.scenarios.length > 0 ? (
          <div className="border-t border-slate-100 px-5 py-4">
            <div className="mb-2 text-[12px] font-medium text-slate-700">三种情景推演</div>
            <div className="space-y-2">
              {report.synthesis.scenarios.map((s) => (
                <div key={s.key} className="rounded-lg bg-slate-50 px-3 py-2">
                  <div className="text-[12px] font-medium text-slate-700">
                    情景 {s.key} · {s.label}
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {s.points.map((p, i) => (
                      <li key={`${s.key}-p${i}`} className="text-[11px] leading-relaxed text-slate-600">
                        <span className="font-medium">{p.field}：</span>
                        {p.text}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      {/* 局限与附录 */}
      {report.meta.limitations.length > 0 ? (
        <Card>
          <CardHeader title="这份报告的局限" subtitle="如实列出，避免把「没说」读成「没有」" />
          <ul className="space-y-1 px-5 py-4">
            {report.meta.limitations.map((l, i) => (
              <li key={`lim${i}`} className="text-[12px] leading-relaxed text-slate-600">
                · {l}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title={`附录：证据索引（${report.evidence.length}）`} subtitle="报告里所有结论都只能来自这里，编号与正文一一对应" />
        <div className="px-5 py-4">
          {report.evidence.length === 0 ? (
            <div className="text-[12px] text-slate-500">没有抽出可用事实。</div>
          ) : (
            <Collapsible title="展开证据表" defaultOpen={false}>
              <div className="max-h-[420px] space-y-1 overflow-y-auto">
                {report.evidence.map((e) => (
                  <div key={e.id} className="flex gap-2 text-[11px] leading-relaxed">
                    <span className="w-8 shrink-0 font-mono text-indigo-600">{e.id}</span>
                    <span className="w-14 shrink-0 text-slate-500">{SPEAKER_LABEL[e.speaker]}</span>
                    <span className="w-16 shrink-0 text-slate-400">{DEBRIEF_TOPIC_LABEL[e.topic]}</span>
                    <span className={cn('flex-1', e.consistency === 'conflicting' ? 'text-amber-700' : 'text-slate-600')}>
                      {e.quote}
                      {e.consistency === 'conflicting' ? '（与其他说法不一致）' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </Collapsible>
          )}
        </div>
      </Card>

      <Callout>{report.disclaimer}</Callout>
      <p className="text-center text-[11px] leading-relaxed text-slate-400">{report.synthesis.boundaryStatement}</p>
    </div>
  );
}

function SessionPanel({ session }: { session: InterviewDebriefSession }) {
  const updateTranscriptText = useApp((s) => s.updateTranscriptText);
  const updateDebriefNotes = useApp((s) => s.updateDebriefNotes);
  const openCaptureFolder = useApp((s) => s.openCaptureFolder);
  const [draft, setDraft] = useState(session.manualTranscript ?? '');
  const [notesDraft, setNotesDraft] = useState(session.notes ?? '');

  useEffect(() => {
    setDraft(session.manualTranscript ?? '');
    setNotesDraft(session.notes ?? '');
  }, [session.id, session.manualTranscript, session.notes]);

  const totalBytes = session.segments.reduce((n, s) => n + s.bytes, 0);

  return (
    <Card>
      <CardHeader
        title="这次面试的记录"
        subtitle={`${DEBRIEF_MODE_LABEL[session.mode]} · ${formatDateTime(session.startedAt)} · ${DEBRIEF_SESSION_STATUS_LABEL[session.status]}`}
        action={
          <Button size="sm" onClick={() => void openCaptureFolder()}>
            打开录音目录
          </Button>
        }
      />
      <div className="space-y-3 px-5 py-4">
        <div className="grid gap-2 sm:grid-cols-4">
          <Stat label="时长" value={formatDuration(session.durationMs)} />
          <Stat label="音频分片" value={session.segments.length} hint={formatBytes(totalBytes)} />
          <Stat label="转写段落" value={session.turns.length} />
          <Stat
            label="音源"
            value={session.sources.system ? '麦克风 + 内录' : '仅麦克风'}
            hint={session.quiet ? '静默录制' : '普通录制'}
          />
        </div>

        {session.transcribeError ? (
          <Banner tone="warning" title="有分片转写失败">
            {session.transcribeError} —— 录音文件本身是完整的，可以在录音目录里找到。
          </Banner>
        ) : null}

        {session.turns.length > 0 ? (
          <div>
            <div className="mb-1 text-[11px] font-medium text-slate-500">转写结果（按时间轴）</div>
            <div className="max-h-[280px] space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              {session.turns.map((t) => (
                <div key={t.id} className="flex gap-2 text-[12px] leading-relaxed">
                  <span className="w-10 shrink-0 font-mono text-[10px] text-slate-400">{formatDuration(t.startOffsetMs)}</span>
                  <span className="w-12 shrink-0 text-slate-500">{SPEAKER_LABEL[t.speaker]}</span>
                  <span className="flex-1 text-slate-700">{t.text}</span>
                </div>
              ))}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
              说话人是按提问 / 作答的语用特征推断的，不一定准。标错了会连带影响表现侧评分，需要的话可以改成手工粘贴模式重新校正。
            </p>
          </div>
        ) : (
          <Field
            label="转写文本"
            hint="可以直接粘贴任何来源的转写（会议软件自带的字幕导出、手机转写、手工记录）。用【面试方】【我】标注说话人会显著提升分析质量。"
          >
            <TextArea
              rows={10}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (draft !== (session.manualTranscript ?? '')) void updateTranscriptText(session.id, draft);
              }}
              placeholder={'【面试方】你好，先介绍一下这个岗位……\n【我】我之前做过……'}
            />
          </Field>
        )}

        <Field label="我的备注" hint="面试官几次打断、当时的状态、临时提到的信息 —— 这些不进分析，但复盘时很有用">
          <TextArea
            rows={2}
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            onBlur={() => {
              if (notesDraft !== (session.notes ?? '')) void updateDebriefNotes(session.id, notesDraft);
            }}
          />
        </Field>
      </div>
    </Card>
  );
}

export function DebriefPage() {
  const snapshot = useApp((s) => s.snapshot);
  const session = useApp((s) => s.debriefSession);
  const report = useApp((s) => s.debriefReport);
  const anonymizeReport = useApp((s) => s.lastAnonymizeReport);
  const recorderState = useApp((s) => s.recorderState);
  const elapsed = useApp((s) => s.recorderElapsedMs);
  const transcribeProgress = useApp((s) => s.transcribeProgress);
  const captureEnv = useApp((s) => s.captureEnv);
  const resolvedSources = useApp((s) => s.resolvedSources);
  const micDeviceId = useApp((s) => s.micDeviceId);
  const busy = useApp((s) => s.busy);

  const refreshCaptureEnvironment = useApp((s) => s.refreshCaptureEnvironment);
  const setMicDevice = useApp((s) => s.setMicDevice);
  const startInterviewCapture = useApp((s) => s.startInterviewCapture);
  const pauseInterviewCapture = useApp((s) => s.pauseInterviewCapture);
  const resumeInterviewCapture = useApp((s) => s.resumeInterviewCapture);
  const stopInterviewCapture = useApp((s) => s.stopInterviewCapture);
  const discardInterviewCapture = useApp((s) => s.discardInterviewCapture);
  const importTranscriptText = useApp((s) => s.importTranscriptText);
  const selectDebriefSession = useApp((s) => s.selectDebriefSession);
  const deleteDebriefSession = useApp((s) => s.deleteDebriefSession);
  const runDebrief = useApp((s) => s.runDebrief);
  const exportDebriefHtml = useApp((s) => s.exportDebriefHtml);
  const exportDebriefJson = useApp((s) => s.exportDebriefJson);
  const loadSampleDebrief = useApp((s) => s.loadSampleDebrief);

  const [mode, setMode] = useState<DebriefMode>('onsite');
  const [useSystemAudio, setUseSystemAudio] = useState(true);
  const [quiet, setQuiet] = useState(true);
  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);

  useEffect(() => {
    if (!captureEnv.checked) void refreshCaptureEnvironment();
  }, [captureEnv.checked, refreshCaptureEnvironment]);

  // stopping 也算「录制中」：引擎正在收尾并等待最后一段落盘，界面不该切回起始页
  const recording =
    recorderState === 'recording' ||
    recorderState === 'paused' ||
    recorderState === 'starting' ||
    recorderState === 'stopping';
  const sessions = snapshot.interviewSessions;
  const hasProfile = snapshot.profiles.length > 0;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[19px] font-semibold text-slate-800">面试复盘</h1>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          面试时录音并同步转写，结束后把「这个岗位实际是什么样」「我答得怎么样」「适不适配」整理成一份可复核的报告。
          <br />
          <span className="text-slate-400">
            转写与录音只落盘；<b className="font-medium text-slate-500">面试进行中不会出现任何提示，也不会产出任何分析结论</b> ——
            这个工具用在面试之后，不用在面试当中。
          </span>
        </p>
      </header>

      {!hasProfile ? (
        <Banner tone="warning" title="还没有能力档案">
          复盘报告里的「岗位适配度」需要和你的能力档案对照。可以先到「我的能力档案」导入一份简历，或者只做面试表现复盘。
        </Banner>
      ) : null}

      {!captureEnv.supported ? (
        <Banner tone="info" title="当前是浏览器 / 演示模式">
          {captureEnv.unsupportedReason} 你仍然可以用「粘贴转写文本」这条路走完整个复盘流程。
        </Banner>
      ) : null}

      {/* ---------------- 录制中 ---------------- */}
      {recording ? (
        <Card className="border-indigo-200">
          <CardHeader
            title={quiet ? '正在静默录制' : '正在录制'}
            subtitle={
              quiet
                ? '窗口已隐藏、未注册任何提示。结束方式：托盘图标菜单，或全局快捷键。'
                : '面试期间不会弹任何提示；转写结果会在结束后统一展示。'
            }
            action={
              <div className="flex gap-2">
                {recorderState === 'paused' ? (
                  <Button size="sm" onClick={resumeInterviewCapture}>
                    继续
                  </Button>
                ) : (
                  <Button size="sm" onClick={pauseInterviewCapture} disabled={recorderState !== 'recording'}>
                    暂停
                  </Button>
                )}
                <Button size="sm" variant="primary" loading={recorderState === 'stopping'} onClick={() => void stopInterviewCapture()}>
                  结束录制
                </Button>
              </div>
            }
          />
          <div className="space-y-3 px-5 py-4">
            <div className="flex items-center gap-4">
              <div className="font-mono text-2xl font-semibold tabular-nums text-slate-800">{formatDuration(elapsed)}</div>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <span className={cn('inline-block h-2 w-2 rounded-full', recorderState === 'recording' ? 'animate-pulse bg-rose-500' : 'bg-slate-300')} />
                {recorderState === 'recording' ? '录音中' : recorderState === 'paused' ? '已暂停' : '准备中'}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Stat label="已保存分片" value={transcribeProgress.total} />
              <Stat label="已转写" value={transcribeProgress.done} hint={transcribeProgress.failed > 0 ? `${transcribeProgress.failed} 段失败` : undefined} />
              <Stat label="音源" value={resolvedSources ? `${resolvedSources.mic ? '麦克风' : ''}${resolvedSources.system ? ' + 内录' : ''}` : '检测中'} />
            </div>
            {resolvedSources?.note ? <Banner tone="warning">{resolvedSources.note}</Banner> : null}
            <Banner tone="info">
              录音正在按分片写入本机。即使现在关掉应用，已经录到的部分也在录音目录里。
            </Banner>
          </div>
        </Card>
      ) : null}

      {/* ---------------- 录制前 ---------------- */}
      {!recording ? (
        <Card>
          <CardHeader
            title="开始一次面试录制"
            subtitle="面对面只录麦克风；线上面试建议同时开内录，否则会丢掉面试官那一半对话"
            action={
              <Button size="sm" variant="ghost" onClick={() => void loadSampleDebrief()} loading={busy === 'debrief'}>
                载入示例转写
              </Button>
            }
          />
          <div className="space-y-4 px-5 py-4">
            {!captureEnv.supported ? (
              <EmptyState
                compact
                title="这个宿主不支持录音"
                description="浏览器 / 演示模式下没有文件系统权限，也没有系统内录。请使用桌面端，或改用下面的「粘贴转写文本」。"
              />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="面试形态">
                    <Select
                      value={mode}
                      onChange={(e) => setMode(e.target.value as DebriefMode)}
                      options={[
                        { value: 'onsite', label: '面对面（只录麦克风）' },
                        { value: 'online', label: '线上（麦克风 + 内录）' },
                      ]}
                    />
                  </Field>
                  <Field label="麦克风设备" hint={captureEnv.microphones.length === 0 ? '还没有检测到设备（首次需要先授权）' : undefined}>
                    <Select
                      value={micDeviceId}
                      onChange={(e) => setMicDevice(e.target.value)}
                      options={[{ value: '', label: '系统默认设备' }, ...captureEnv.microphones.map((d) => ({ value: d.deviceId, label: d.label }))]}
                    />
                  </Field>
                  <Field label="磁盘空间" hint={captureEnv.directory || undefined}>
                    <div className={cn('rounded-lg border px-2.5 py-1.5 text-[13px]', captureEnv.lowSpace ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-300 text-slate-700')}>
                      {captureEnv.freeBytes < 0 ? '未知' : formatBytes(captureEnv.freeBytes)}
                    </div>
                  </Field>
                </div>

                <div className="rounded-lg border border-slate-200 px-3 py-1">
                  <Toggle
                    label="同时录制系统声音（内录）"
                    hint={`${captureEnv.systemAudioHint} 线上会议时打开，才能录到面试官的声音。`}
                    checked={mode === 'online' && useSystemAudio}
                    onChange={setUseSystemAudio}
                  />
                  <Toggle
                    label="静默录制（推荐）"
                    hint="开启后：窗口隐藏、不弹任何提示、不弹系统通知；结束时用托盘菜单或全局快捷键。这是防止面试官看到界面上多出东西的唯一可靠方式。"
                    checked={quiet}
                    onChange={setQuiet}
                  />
                </div>

                <Callout>
                  开始之前请确认：你所在地区与场景允许你对这场对话录音；这份录音只用于你自己的复盘，不对外传播。
                  本功能全程离线保存，不会把音频上传到任何地方（除非你另外开启了「录音转写」并配置了接口）。
                </Callout>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={() => void startInterviewCapture({ mode, sources: { mic: true, system: mode === 'online' && useSystemAudio }, quiet })}
                  >
                    开始录制
                  </Button>
                  <span className="text-[11px] text-slate-500">
                    {quiet ? '静默模式下用托盘菜单或 Ctrl+Alt+R 结束录制' : '录制期间界面不会出现提示'}
                  </span>
                </div>
              </>
            )}

            <div className="border-t border-slate-100 pt-3">
              <button
                onClick={() => setShowPaste((v) => !v)}
                className="text-[12px] text-indigo-600 transition hover:text-indigo-700"
              >
                {showPaste ? '收起' : '没有录音？直接粘贴转写文本 →'}
              </button>
              {showPaste ? (
                <div className="mt-2 space-y-2">
                  <TextArea
                    rows={6}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder={'【面试方】你好，先介绍一下这个岗位……\n【我】我之前做过……'}
                  />
                  <div className="flex gap-2">
                    <Button
                      onClick={() => {
                        if (!pasteText.trim()) return;
                        void importTranscriptText(pasteText, { mode, quiet });
                        setPasteText('');
                        setShowPaste(false);
                      }}
                    >
                      导入并准备复盘
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setPasteText(SAMPLE_INTERVIEW_TRANSCRIPT);
                      }}
                    >
                      填入示例文本
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      {/* ---------------- 会话选择 ---------------- */}
      {sessions.length > 0 ? (
        <Card>
          <CardHeader title={`面试记录（${sessions.length}）`} subtitle="复盘报告是按「一次面试」组织的" />
          <div className="space-y-1.5 px-5 py-4">
            {sessions.slice(0, 12).map((s) => {
              const active = session?.id === s.id;
              const hasReport = snapshot.debriefReports.some((r) => r.sessionId === s.id);
              return (
                <div
                  key={s.id}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors',
                    active ? 'border-indigo-200 bg-indigo-50/60' : 'border-slate-200 hover:bg-slate-50',
                  )}
                >
                  <button className="min-w-0 flex-1 text-left" onClick={() => selectDebriefSession(s.id)}>
                    <div className="truncate text-[12px] font-medium text-slate-700">
                      {s.jobTitle || '未关联岗位'} · {DEBRIEF_MODE_LABEL[s.mode]}
                    </div>
                    <div className="mt-0.5 text-[10px] text-slate-400">
                      {formatDateTime(s.startedAt)} · {formatDuration(s.durationMs)} · {s.segments.length} 段 · {s.turns.length} 条转写
                      {s.manualTranscript ? ` · ${s.manualTranscript.length} 字` : ''}
                    </div>
                  </button>
                  {hasReport ? <Badge tone="success">已复盘</Badge> : <Badge tone="muted">{DEBRIEF_SESSION_STATUS_LABEL[s.status]}</Badge>}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (confirm('删除这条面试记录？录音文件会保留在录音目录里，不会被删除。')) void deleteDebriefSession(s.id);
                    }}
                  >
                    删除
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {/* ---------------- 会话详情 + 复盘入口 ---------------- */}
      {session ? (
        <>
          <SessionPanel session={session} />

          <Card>
            <CardHeader
              title="生成复盘报告"
              subtitle="机会侧 12 维 + 表现侧 6 维 + 岗位适配度 + 三档决策表 + 一个下一步动作"
            />
            <div className="flex flex-wrap items-center gap-3 px-5 py-4">
              <Button variant="primary" loading={busy === 'debrief'} onClick={() => void runDebrief(session.id)}>
                {report ? '重新生成复盘报告' : '生成复盘报告'}
              </Button>
              {report ? (
                <>
                  <Button onClick={() => void exportDebriefHtml()}>导出离线 HTML</Button>
                  <Button onClick={() => void exportDebriefJson()}>导出结构化 JSON</Button>
                </>
              ) : null}
              {!isEnabled('interview.debrief') ? (
                <span className="text-[11px] text-amber-700">当前版本未开放面试复盘</span>
              ) : null}
            </div>
            {anonymizeReport ? (
              <div className="border-t border-slate-100 px-5 py-3">
                <div className="text-[11px] font-medium text-slate-500">进入分析前的去标识化</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{summarizeAnonymize(anonymizeReport)}</div>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                  姓名、称呼与公司名在送入分析前会被替换；报告里保留数字（时长、薪酬、指标数量），因为它们是判断依据。
                </p>
              </div>
            ) : null}
          </Card>

          {busy === 'debrief' ? (
            <Card>
              <div className="px-5 py-8 text-center text-[12px] text-slate-500">正在按「证据 → 维度 → 综合」三步分析，请稍候…</div>
            </Card>
          ) : report ? (
            <ReportView report={report} />
          ) : (
            <Card>
              <EmptyState
                compact
                title="还没有复盘报告"
                description="确认上面的转写文本没有问题之后，点「生成复盘报告」。报告只使用转写里出现过的话，推不出来的部分会明确写成「证据不足」。"
              />
            </Card>
          )}
        </>
      ) : null}

      {/* ---------------- 一次都没有时 ---------------- */}
      {!session && !recording ? (
        <Card>
          <EmptyState
            title="还没有任何面试记录"
            description="面试结束后回来，把录音或转写文本导入，就能拿到一份可复核的复盘报告。也可以先点「载入示例转写」看看报告长什么样。"
            action={
              <Button variant="primary" onClick={() => void loadSampleDebrief()} loading={busy === 'debrief'}>
                载入示例转写并复盘
              </Button>
            }
          />
        </Card>
      ) : null}

      <Card className="border-dashed">
        <div className="px-5 py-4">
          <div className="text-[12px] font-medium text-slate-700">这套功能刻意不做的事</div>
          <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-slate-500">
            <li>· 不做实时提示：面试进行中不会给任何「该怎么答」的建议。这个工具用在面试之后，不用在面试当中。</li>
            <li>· 不做说话人分离：单声道录音里谁在说话是推断的，可能出错，需要你自己核对。</li>
            <li>· 不预测面试结果：报告不声称「这样答就能过」，也不评价面试官。</li>
            <li>· 不替你决定去不去：报告只把做决定所需的信息整理清楚，取舍由你。</li>
          </ul>
        </div>
      </Card>
    </div>
  );
}
