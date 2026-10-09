import { useMemo, useState } from 'react';
import {
  ASSESSMENT_LABEL,
  ASSESSMENT_ORDER,
  REQUIREMENT_TYPE_LABEL,
  explainWhyNot,
  formatDateTime,
  plannedCapabilities,
  buildMinimumCandidate,
  buildResumeAdvice,
  SUGGESTION_KIND_LABEL,
  SUGGESTION_KIND_WHY,
  matchReportFileName,
  renderMatchReportHtml,
  type Assessment,
  type RequirementMatch,
} from '@aijob/core';
import {
  AssessmentBadge,
  Badge,
  Banner,
  Button,
  Callout,
  Card,
  CardHeader,
  Chip,
  Collapsible,
  ComingSoonPanel,
  EmptyState,
  ImportanceBadge,
  KindBadge,
  SectionTitle,
  Stat,
  StrengthBadge,
  cn,
} from '../components/ui';
import { useApp } from '../state/store';
import { saveHtml } from '../lib/bridge';

/**
 * 简历匹配报告（文档第七节 / 第二十三节）。
 *
 * 这一页要能回答两个问题：
 *   「我为什么不匹配？」  → explainWhyNot + 每条要求的证据链
 *   「我接下来具体应该改什么？」 → priorities
 */

/** 四类建议的配色。与 Recommendation 类无关，只为了扫一眼能区分「改写」与「补材料」 */
const SUGGESTION_TONE: Record<string, 'accent' | 'info' | 'warning' | 'neutral' | 'danger' | 'success'> = {
  rewrite: 'accent',
  evidence_missing: 'warning',
  order: 'info',
  drop: 'neutral',
};

const ASSESSMENT_ACCENT: Record<Assessment, string> = {
  matched: 'border-l-emerald-400',
  partial: 'border-l-amber-400',
  lacking_evidence: 'border-l-sky-400',
  gap: 'border-l-rose-400',
  unknown: 'border-l-slate-300',
};

function MatchCard({ match, defaultOpen }: { match: RequirementMatch; defaultOpen: boolean }) {
  return (
    <Card className={cn('border-l-[3px]', ASSESSMENT_ACCENT[match.assessment])}>
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <AssessmentBadge assessment={match.assessment} />
          <Badge tone="muted">{REQUIREMENT_TYPE_LABEL[match.type]}</Badge>
          <ImportanceBadge importance={match.importance} />
          {match.hardGate ? <Badge tone="danger">硬门槛</Badge> : null}
          <Badge tone="muted">置信度 {match.confidence === 'high' ? '高' : match.confidence === 'medium' ? '中' : '低'}</Badge>
        </div>

        <p className="mt-2 text-[13px] font-medium leading-relaxed text-slate-800">{match.requirement}</p>

        <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2">
          <div className="text-[11px] font-medium text-slate-500">判断依据</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-slate-700">{match.reason}</p>
        </div>

        {match.evidence.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            {match.evidence.map((hit) => (
              <div key={hit.evidenceId} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-medium text-slate-700">{hit.title}</span>
                  <KindBadge kind={hit.kind} />
                  <StrengthBadge strength={hit.strength} />
                  {hit.origin === 'qa' ? <Badge tone="info">能力问诊补充</Badge> : null}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{hit.linkReason}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{hit.content}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 text-[11px] text-slate-400">这条要求没有检索到任何支撑证据</div>
        )}

        {match.matchedSkills.length > 0 || match.missingSkills.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {match.matchedSkills.map((s) => (
              <Chip key={`m-${s}`}>{s}</Chip>
            ))}
            {match.missingSkills.map((s) => (
              <Badge key={`x-${s}`} tone="warning">
                缺 {s}
              </Badge>
            ))}
          </div>
        ) : null}

        {match.action ? (
          <div className="mt-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2">
            <div className="text-[11px] font-medium text-indigo-700">下一步</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-indigo-900">{match.action}</p>
          </div>
        ) : null}

        <div className="mt-2">
          <Collapsible title="完整判定链与原文出处" defaultOpen={defaultOpen}>
            <div className="space-y-1.5">
              {match.explain.map((step, i) => (
                <div key={`${match.id}-e${i}`} className="text-[11px] leading-relaxed text-slate-600">
                  <span className="font-medium text-slate-700">{step.rule}：</span>
                  {step.detail}
                </div>
              ))}
              <div className="text-[11px] leading-relaxed text-slate-500">
                <span className="font-medium text-slate-700">岗位原文：</span>
                {match.original || '（无）'}
              </div>
            </div>
          </Collapsible>
        </div>
      </div>
    </Card>
  );
}

export function MatchPage() {
  const snapshot = useApp((s) => s.snapshot);
  const navigate = useApp((s) => s.navigate);
  const runMatch = useApp((s) => s.runMatch);
  const exportJson = useApp((s) => s.exportJson);
  const busy = useApp((s) => s.busy);

  const [filter, setFilter] = useState<'all' | Assessment>('all');
  const [reportId, setReportId] = useState<string | null>(null);

  const report = snapshot.reports.find((r) => r.id === reportId) ?? snapshot.reports[0];
  const profile = snapshot.profiles.find((p) => p.id === (report?.profile.id ?? snapshot.ui.activeProfileId)) ?? snapshot.profiles[0];
  const job = snapshot.jobs.find((j) => j.id === report?.job.id) ?? snapshot.jobs[0];

  const whyNot = useMemo(() => (report && profile ? explainWhyNot(profile, report) : []), [report, profile]);
  const filtered = useMemo(() => {
    if (!report) return [];
    return filter === 'all' ? report.matches : report.matches.filter((m) => m.assessment === filter);
  }, [report, filter]);

  // v0.3 的三项已实装（2026-10-08）：最低画像 / 简历建议 / 报告导出。
  const assessmentsMap = useMemo(
    () => new Map<string, Assessment>((report?.matches ?? []).map((m) => [m.requirementId, m.assessment])),
    [report],
  );
  const minimum = useMemo(
    () =>
      report && job && profile
        ? buildMinimumCandidate({ profile, job, assessments: assessmentsMap })
        : { supported: false as const, reason: '需要一份档案和一个岗位。' },
    [report, job, profile, assessmentsMap],
  );
  const resumeAdvice = useMemo(
    () =>
      report && job
        ? buildResumeAdvice({ profile, job: { id: job.id, title: job.jobTitle }, matches: report.matches })
        : null,
    [report, job],
  );
  const exportReport = async () => {
    if (!report) return;
    // saveHtml 已经封装了「桌面端走保存对话框 / 浏览器端直接下载」两条路径，
    // 所以这里不要自己再判一次桥 —— 早先那版把降级逻辑抄了一遍，
    // 结果两处行为不一致（这里少考虑了 aijob 存在但 saveHtml 缺失的情况）。
    const html = renderMatchReportHtml(report, {
      subtitle: profile?.basics?.displayName ? `针对「${profile.basics.displayName}」` : undefined,
    });
    await saveHtml(matchReportFileName(report), html);
  };

  // 只剩 OCR 这一项没实装（需要本地推理模型）
  const v03 = plannedCapabilities().filter((c) => c.since === 'future');
  const weakCount = report ? report.summary.gap + report.summary.lackingEvidence + report.summary.partial : 0;

  if (!report) {
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-[19px] font-semibold text-slate-800">简历匹配</h1>
          <p className="mt-1 text-xs text-slate-500">Candidate Profile × Job Requirement → 可解释结论</p>
        </header>
        <Card>
          <EmptyState
            title="还没有分析报告"
            description="准备好能力档案和至少一个岗位之后，点下面的按钮开始匹配分析。"
            action={
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => void runMatch()} loading={busy === 'match'}>
                  开始匹配分析
                </Button>
                <Button onClick={() => navigate('profile')}>去检查档案</Button>
              </div>
            }
          />
        </Card>
      </div>
    );
  }

  const stale = Boolean(profile && report.profile.id === profile.id && new Date(profile.updatedAt) > new Date(report.createdAt));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold text-slate-800">匹配分析报告</h1>
          <p className="mt-1 text-xs text-slate-500">
            {report.job.title}
            {report.job.company ? ` · ${report.job.company}` : ''} · 生成于 {formatDateTime(report.createdAt)} ·{' '}
            {report.usedModel ? `引擎：${report.engine}（已调用模型）` : '引擎：本地规则（未调用模型）'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" loading={busy === 'match'} onClick={() => void runMatch()}>
            重新分析
          </Button>
          <Button size="sm" onClick={() => void exportJson()}>
            导出结构化 JSON
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate('job')}>
            查看岗位拆解
          </Button>
        </div>
      </header>

      {snapshot.reports.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          历史报告：
          {snapshot.reports.slice(0, 6).map((r) => (
            <button
              key={r.id}
              onClick={() => setReportId(r.id)}
              className={cn(
                'rounded-md border px-2 py-0.5 transition-colors',
                r.id === report.id ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white hover:bg-slate-50',
              )}
            >
              {r.job.title} · {formatDateTime(r.createdAt).slice(5, 16)}
            </button>
          ))}
        </div>
      ) : null}

      <Card>
        <div className="px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <AssessmentBadge assessment={report.verdict} className="px-2 py-1 text-[12px]" />
            <p className="flex-1 text-[13px] leading-relaxed text-slate-700">{report.headline}</p>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="要求总数" value={report.summary.total} />
            <Stat label={ASSESSMENT_LABEL.matched} value={report.summary.matched} />
            <Stat label={ASSESSMENT_LABEL.partial} value={report.summary.partial} />
            <Stat label={ASSESSMENT_LABEL.lacking_evidence} value={report.summary.lackingEvidence} />
            <Stat label={ASSESSMENT_LABEL.gap} value={report.summary.gap} />
            <Stat label={ASSESSMENT_LABEL.unknown} value={report.summary.unknown} />
          </div>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-100">
            {(
              [
                ['matched', 'bg-emerald-400'],
                ['partial', 'bg-amber-400'],
                ['lacking_evidence', 'bg-sky-400'],
                ['gap', 'bg-rose-400'],
                ['unknown', 'bg-slate-300'],
              ] as Array<[Assessment, string]>
            ).map(([key, color]) => {
              const value =
                key === 'matched' ? report.summary.matched
                  : key === 'partial' ? report.summary.partial
                    : key === 'lacking_evidence' ? report.summary.lackingEvidence
                      : key === 'gap' ? report.summary.gap
                        : report.summary.unknown;
              if (!value) return null;
              return <div key={key} className={color} style={{ width: `${(value / Math.max(report.summary.total, 1)) * 100}%` }} />;
            })}
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            刻意不给出 0–100 的匹配分：分数无法解释，也容易制造虚假的精确感。下面是每条要求的具体依据。
          </p>
        </div>
      </Card>

      {stale ? (
        <Banner tone="warning" title="档案已更新">
          这份报告是在档案修改之前生成的，结论可能已经过期。建议重新分析。
        </Banner>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader title="我为什么是现在这个判断" subtitle="直接由匹配结果翻译而来，不新增任何判断" />
          <ul className="space-y-2 px-5 py-4">
            {whyNot.map((reason, i) => (
              <li key={`why-${i}`} className="text-[12px] leading-relaxed text-slate-700">
                · {reason}
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="接下来应该改什么" subtitle="按投入产出比排序" />
          <div className="space-y-2.5 px-5 py-4">
            {report.priorities.length === 0 ? (
              <p className="text-[12px] text-slate-500">没有发现需要立刻补强的结构性缺口。</p>
            ) : (
              report.priorities.map((p, i) => (
                <div key={`pri-${i}`} className="rounded-lg border border-slate-200 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-semibold text-white">
                      {i + 1}
                    </span>
                    <span className="text-[12px] font-medium text-slate-800">{p.title}</span>
                    <Badge tone={p.effort === 'low' ? 'success' : p.effort === 'medium' ? 'warning' : 'danger'}>
                      成本 {p.effort === 'low' ? '低' : p.effort === 'medium' ? '中' : '高'}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">{p.why}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-indigo-900">{p.how}</p>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <div>
        <SectionTitle
          title={`匹配明细（${filtered.length} / ${report.matches.length}）`}
          description="每条结论都能展开看到判定规则、命中的证据和岗位原文"
        />
        <div className="mb-3 flex flex-wrap gap-1.5">
          <button
            onClick={() => setFilter('all')}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[11px] transition-colors',
              filter === 'all' ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
            )}
          >
            全部 {report.matches.length}
          </button>
          {ASSESSMENT_ORDER.map((a) => {
            const count = report.matches.filter((m) => m.assessment === a).length;
            if (count === 0) return null;
            return (
              <button
                key={a}
                onClick={() => setFilter(a)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[11px] transition-colors',
                  filter === a ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                )}
              >
                {ASSESSMENT_LABEL[a]} {count}
              </button>
            );
          })}
        </div>
        <div className="space-y-2.5">
          {filtered.map((match) => (
            <MatchCard key={match.id} match={match} defaultOpen={match.assessment === 'lacking_evidence' || match.assessment === 'partial'} />
          ))}
        </div>
      </div>

      {report.riskNotes.length > 0 ? (
        <Card>
          <CardHeader title="风险与限制" subtitle="这些因素会影响结论，但不改变上面的事实判断" />
          <ul className="space-y-1.5 px-5 py-4">
            {report.riskNotes.map((note, i) => (
              <li key={`risk-${i}`} className="text-[12px] leading-relaxed text-slate-600">
                · {note}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {weakCount > 0 ? (
        <Card className="border-indigo-100 bg-indigo-50/40">
          <CardHeader title="这份报告接下来能直接做什么" subtitle="两条路径，都基于上面这些结论，不需要你重新整理材料" />
          <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
            <div className="rounded-lg border border-white bg-white px-4 py-3">
              <div className="flex items-center gap-2">
                <Badge tone="info">能力问诊</Badge>
                <span className="text-[12px] font-medium text-slate-800">
                  {report.summary.lackingEvidence > 0
                    ? `有 ${report.summary.lackingEvidence} 条你提到过、但拿不出产出`
                    : '确认「熟悉 X」到底到什么程度'}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                答几个具体问题就能把掌握程度说清楚，说到的具体部分会变成证据补进能力库（自述来源，强度封顶为「中」，补上链接或数字后自动升级）。
              </p>
              <div className="mt-2">
                <Button size="sm" variant="primary" onClick={() => navigate('interview')}>
                  去做能力问诊
                </Button>
              </div>
            </div>
            <div className="rounded-lg border border-white bg-white px-4 py-3">
              <div className="flex items-center gap-2">
                <Badge tone="warning">薄弱项训练</Badge>
                <span className="text-[12px] font-medium text-slate-800">有 {weakCount} 条要求没有完全满足</span>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                按这些要求生成问答式训练题（附带自查要点与常见追问），练完回来重跑一次匹配，就能看到结论有没有变化。
              </p>
              <div className="mt-2">
                <Button size="sm" onClick={() => navigate('training')}>
                  去生成训练计划
                </Button>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {/*
        v0.3 实装的三个功能（2026-10-08）。
        原来这一整块是 `ComingSoonPanel`，下面只留 OCR 一项 ——
        它需要本地推理模型，本机无 GPU 跑不动，所以仍是空壳。
      */}
      {minimum.supported && minimum.model ? (
        <div>
          <SectionTitle
            title="最低还差什么"
            description="只列「不补就够不上」的部分，不含加分项"
          />
          <Card>
            {minimum.model.buckets.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-slate-600">{minimum.model.note}</p>
            ) : (
              <>
                {minimum.model.buckets.map((b) => (
                  <div key={b.group} className="mb-4 last:mb-0">
                    <div className="mb-1.5 flex items-baseline gap-2">
                      <h4 className="text-[13px] font-semibold text-slate-800">{b.group}</h4>
                      <span className="text-[11px] text-slate-400">{b.items.length} 项</span>
                    </div>
                    <ul className="flex flex-col gap-1.5">
                      {b.items.map((it, i) => (
                        <li key={i} className="text-[12.5px] leading-relaxed text-slate-600">
                          {it}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <p className="mt-3 border-t border-slate-100 pt-3 text-[12px] leading-relaxed whitespace-pre-line text-slate-500">
                  {minimum.model.note}
                </p>
              </>
            )}
          </Card>
        </div>
      ) : null}

      {resumeAdvice && resumeAdvice.suggestions.length > 0 ? (
        <div>
          <SectionTitle title="简历可以怎么改" description={resumeAdvice.basis} />
          {resumeAdvice.suggestions.map((s, i) => (
            <Card key={`${s.requirementId}-${i}`} className="mb-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SUGGESTION_TONE[s.kind]}>{SUGGESTION_KIND_LABEL[s.kind]}</Badge>
                <span className="text-[11.5px] text-slate-400">改在{s.where}</span>
                <AssessmentBadge assessment={s.assessment} />
              </div>
              <p className="mt-2 text-[12px] text-slate-500">针对这条要求：{s.requirementText}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-slate-700">{s.suggestion}</p>
              {s.fromQuote ? (
                <div className="mt-2.5 rounded-md bg-slate-50 px-3 py-2.5">
                  <div className="text-[11.5px] text-slate-400">你原来写的</div>
                  <div className="mt-0.5 text-[12.5px] leading-relaxed text-slate-600">{s.fromQuote}</div>
                  {s.toQuote && s.toQuote !== s.fromQuote ? (
                    <>
                      <div className="mt-2 text-[11.5px] text-slate-400">建议改成</div>
                      <div className="mt-0.5 text-[12.5px] leading-relaxed text-slate-800">{s.toQuote}</div>
                    </>
                  ) : null}
                </div>
              ) : null}
              <p className="mt-2 text-[11.5px] leading-relaxed text-slate-400">{SUGGESTION_KIND_WHY[s.kind]}</p>
            </Card>
          ))}
          <Banner tone="warning" title="先看清楚这条">
            {resumeAdvice.disclaimer}
          </Banner>
        </div>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-[13px] font-semibold text-slate-800">导出这份报告</h3>
            <p className="mt-0.5 text-[12px] leading-relaxed text-slate-500">
              导出一个自包含的 HTML 文件：不依赖网络，双击就能打开，可以直接发给对方或存进网盘。
              里面有完整的逐条结论与依据链。
            </p>
          </div>
          <Button variant="primary" onClick={exportReport} disabled={!report}>
            导出 HTML
          </Button>
        </div>
      </Card>

      {v03.length > 0 ? (
        <div>
          <SectionTitle title="还没做的能力" description="这些已经登记在路线图里，但当前版本没有实现" />
          <ComingSoonPanel
            reason="以下能力尚未实装。它们不会出现在上面的功能区里，避免出现「点了没反应」的入口。"
            items={v03.map((c) => ({ id: c.id, label: c.label, description: c.description, docRef: c.docRef, since: c.since }))}
          />
        </div>
      ) : null}

      <Card className="border-dashed">
        <div className="px-5 py-4">
          <Callout>{report.disclaimer}</Callout>
          <div className="mt-2 text-[11px] text-slate-400">
            当前结论由 {report.usedModel ? '模型 + 本地规则' : '本地规则引擎'} 生成
            {job ? `，岗位共 ${report.job.requirementCount} 条要求（其中硬门槛 ${report.job.hardGateCount} 条）` : ''}。
          </div>
        </div>
      </Card>
    </div>
  );
}
