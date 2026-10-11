import { useMemo, useState } from 'react';
import {
  SELF_SCORE_OPTIONS,
  TRAINING_EVIDENCE_WHY,
  TRAINING_TYPE_LABEL,
  TRAINING_WEAKNESS_LABEL,
  formatDateTime,
  plannedCapabilities,
  trainingCandidates,
  type SelfScore,
  type TrainingItem,
  type TrainingJudgement,
} from '@aijob/core';
import {
  Badge,
  Banner,
  Button,
  Callout,
  Card,
  CardHeader,
  Collapsible,
  ComingSoonPanel,
  EmptyState,
  SectionTitle,
  Stat,
  TextArea,
  cn,
} from '../components/ui';
import { useApp } from '../state/store';

/**
 * 薄弱项训练（v0.2）
 * ===================
 *
 * 训练题不是从题库里随机抽的，而是**这次匹配里真实没答上的那几条要求**。
 * 所以它的状态和报告是联动的：练完回去重跑一次匹配，就能看到那几条结论有没有变化。
 */

const WEAKNESS_TONE: Record<TrainingItem['weakness'], 'danger' | 'info' | 'warning'> = {
  gap: 'danger',
  lacking_evidence: 'info',
  partial: 'warning',
};

const STATUS_LABEL: Record<TrainingItem['status'], string> = {
  todo: '待作答',
  answered: '已作答',
  reviewed: '已复习',
  passed: '已达标',
  parked: '先放着',
};

function TrainingCard({
  item,
  draft,
  judgement,
  showJudgeReason,
  onDraft,
  onSave,
  onReview,
  onJudge,
  onSubmitEvidence,
  onPark,
  onResume,
}: {
  item: TrainingItem;
  draft: string;
  judgement?: TrainingJudgement;
  showJudgeReason: boolean;
  onDraft: (value: string) => void;
  onSave: (patch: { userAnswer?: string; selfScore?: SelfScore }) => void;
  onReview: () => void;
  onJudge: () => void;
  onSubmitEvidence: () => void;
  onPark: () => void;
  onResume: () => void;
}) {
  const [score, setScore] = useState<SelfScore | undefined>(item.selfScore);
  const dirty = draft !== (item.userAnswer ?? '') || score !== item.selfScore;
  const evidenceCount = item.evidenceIds?.length ?? 0;

  return (
    <Card>
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={WEAKNESS_TONE[item.weakness]}>{TRAINING_WEAKNESS_LABEL[item.weakness]}</Badge>
          <Badge tone="muted">{TRAINING_TYPE_LABEL[item.type]}</Badge>
          <Badge tone="neutral">{item.skillName}</Badge>
          <Badge tone={item.importance === 'high' ? 'danger' : item.importance === 'medium' ? 'warning' : 'muted'}>
            重要度 {item.importance === 'high' ? '高' : item.importance === 'medium' ? '中' : '低'}
          </Badge>
          {item.skillCategory === 'unknown' ? <Badge tone="warning">未识别到具体技能</Badge> : null}
          {evidenceCount > 0 ? <Badge tone="info">已补进档案 {evidenceCount} 条</Badge> : null}
          <span className="flex-1" />
          <Badge
            tone={
              item.status === 'passed'
                ? 'success'
                : item.status === 'reviewed'
                  ? 'success'
                  : item.status === 'parked'
                    ? 'warning'
                    : item.status === 'answered'
                      ? 'accent'
                      : 'muted'
            }
          >
            {STATUS_LABEL[item.status]}
          </Badge>
        </div>

        <p className="mt-2 text-[13px] font-medium leading-relaxed text-slate-800">{item.question}</p>
        {item.requirementText ? (
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">来自要求：{item.requirementText}</p>
        ) : null}

        <div className="mt-3">
          <TextArea
            rows={3}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            placeholder="先口述一遍，再把你实际说出来的内容写进来 —— 写不出完整句子说明这题还没过。"
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-500">自评：</span>
          {SELF_SCORE_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setScore(option.value)}
              className={cn(
                'rounded-md border px-2 py-1 text-[11px] transition-colors',
                score === option.value ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              {option.value} · {option.label}
            </button>
          ))}
          <span className="flex-1" />
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => onSave({ userAnswer: draft, selfScore: score })}>
            保存
          </Button>
          {item.status !== 'reviewed' && item.status !== 'passed' ? (
            <Button size="sm" variant="ghost" onClick={onReview}>
              标记已复习
            </Button>
          ) : null}
        </div>

        {/* v0.6 追加：判定 + 补证据 + 先放着。
            这三件事是训练闭环的另一半 ——
            在此之前训练结果完全不进能力库，用户练完重跑匹配看不到任何变化。*/}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2.5">
          <Button size="sm" disabled={!draft.trim()} onClick={onJudge}>
            判定是否答到
          </Button>
          <Button size="sm" disabled={!draft.trim() || evidenceCount > 0} onClick={onSubmitEvidence}>
            {evidenceCount > 0 ? '已补进档案' : '把这段经历补进档案'}
          </Button>
          <span className="flex-1" />
          {item.status === 'parked' ? (
            <Button size="sm" variant="ghost" onClick={onResume}>
              回来继续
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onPark}>
              先放着
            </Button>
          )}
        </div>

        {judgement ? (
          <div
            className={cn(
              'mt-2 rounded-lg border px-3 py-2',
              judgement.verdict === 'passed'
                ? 'border-emerald-200 bg-emerald-50'
                : judgement.verdict === 'too_short'
                  ? 'border-slate-200 bg-slate-50'
                  : 'border-amber-200 bg-amber-50',
            )}
          >
            <div
              className={cn(
                'text-[12px] font-medium leading-relaxed',
                judgement.verdict === 'passed' ? 'text-emerald-900' : 'text-amber-900',
              )}
            >
              {judgement.headline}
            </div>
            {/* 设置页可以关掉判据展示，但判定本身照常发生 ——
                藏起来的是解释，不是判定。 */}
            {showJudgeReason ? (
              <ul className="mt-1.5 space-y-0.5">
                {judgement.reasons.map((reason) => (
                  <li key={reason.key} className="flex gap-1.5 text-[11px] leading-relaxed text-slate-600">
                    <span className={cn('mt-0.5 shrink-0', reason.ok ? 'text-emerald-600' : 'text-amber-600')}>
                      {reason.ok ? '有' : '缺'}
                    </span>
                    <span>{reason.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-1 text-[11px] text-slate-500">
                判定依据已隐藏（可在设置页打开）。判定本身照常发生 —— 隐藏的是解释，不是判定。
              </div>
            )}
            {judgement.hooks.length > 0 ? (
              <div className="mt-2 rounded-md border border-amber-200 bg-white px-3 py-2">
                <div className="text-[11px] font-medium text-amber-900">接下来可以顺着这句往下答</div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-700">{judgement.hooks[0].text}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                  为什么问这个：{judgement.hooks[0].intent}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {item.lastJudgeHeadline && !judgement ? (
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">上次判定：{item.lastJudgeHeadline}</p>
        ) : null}

        {item.parked ? (
          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[11px] leading-relaxed text-slate-600">
              已标记「先放着」：{item.parked.reason}。你写的答案一个字都没删，随时可以回来继续。
            </div>
          </div>
        ) : null}

        <div className="mt-2 space-y-2">
          {/* v0.3 追加：参考答案。
              顺序刻意是「先看要点 → 自己答 → 再看示例答复」：
              看过示例再答，用户会照抄，那就练不到「自己组织」这一步了。 */}
          <Collapsible title={`自查要点（${item.referencePoints.length} 条）`} defaultOpen={item.status === 'todo'}>
            <ul className="space-y-1">
              {item.referencePoints.map((point, i) => (
                <li key={`${item.id}-p${i}`} className="text-[11px] leading-relaxed text-slate-600">
                  · {point}
                </li>
              ))}
            </ul>
          </Collapsible>

          {item.referenceAnswer ? (
            <Collapsible
              title="参考答案（示例 · 不是标准答案）"
              right={
                <span className="text-[10px] text-slate-400">
                  {item.referenceAnswerOrigin === 'ai' ? '模型生成' : '本地模板'}
                </span>
              }
            >
              <div className="space-y-2">
                <pre className="whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-700">
                  {item.referenceAnswer}
                </pre>
                <div className="text-[11px] leading-relaxed text-amber-700">
                  这是一段示例答复，看的是**结构**不是内容。括号里必须换成你自己的真实情况 ——
                  直接照抄会变成编造经历，那比不练更糟。
                </div>
              </div>
            </Collapsible>
          ) : null}

          {item.followUp ? (
            <Collapsible title="面试官大概率会接着问">
              <p className="text-[11px] leading-relaxed text-slate-600">{item.followUp}</p>
            </Collapsible>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export function TrainingPage() {
  const snapshot = useApp((s) => s.snapshot);
  const navigate = useApp((s) => s.navigate);
  const generateTraining = useApp((s) => s.generateTraining);
  const updateTrainingItem = useApp((s) => s.updateTrainingItem);
  const judgeTraining = useApp((s) => s.judgeTraining);
  const submitTrainingEvidence = useApp((s) => s.submitTrainingEvidence);
  const parkTraining = useApp((s) => s.parkTraining);
  const trainingJudge = useApp((s) => s.trainingJudge);
  const deleteTrainingPlan = useApp((s) => s.deleteTrainingPlan);
  const busy = useApp((s) => s.busy);

  // v0.6：三个决策点之一 —— 判定依据显不显示。在设置页改，这里只读。
  const showJudgeReason = (snapshot.settings as { review?: { showJudgeReason?: boolean } }).review?.showJudgeReason ?? true;

  const profile = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0];
  const job = snapshot.jobs.find((j) => j.id === snapshot.ui.activeJobId) ?? snapshot.jobs[0];
  const report = job ? snapshot.reports.find((r) => r.job.id === job.id) : undefined;
  const plan = job ? snapshot.trainingPlans.find((p) => p.jobId === job.id) : undefined;

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const upcoming = plannedCapabilities().filter((c) => c.since === 'v0.4' || c.id === 'training.paid_course');

  // 用引擎里的同一份筛选规则统计，避免「统计说 7 条、实际只出 3 题」的口径不一致
  const candidates = useMemo(() => (report ? trainingCandidates(report.matches) : []), [report]);
  const unmetTotal = report ? report.summary.gap + report.summary.lackingEvidence + report.summary.partial : 0;

  if (!profile || !job) {
    return (
      <div className="space-y-4">
        <SectionTitle title="薄弱项训练" description="训练题来自匹配分析的结果，所以需要先有档案和一个岗位" />
        <Card>
          <EmptyState
            title={!profile ? '还没有能力档案' : '还没有分析过岗位'}
            description={!profile ? '先建立能力档案，再分析一个岗位，就能针对薄弱项出题。' : '先在岗位分析里粘贴一份 JD。'}
            action={
              <Button variant="primary" onClick={() => navigate(!profile ? 'profile' : 'job')}>
                {!profile ? '去建立档案' : '去分析岗位'}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-semibold text-slate-800">薄弱项训练</h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">
            题目只来自这次匹配里真实没答上的要求：能力缺口出概念题、缺少证据出「讲清楚」题、证据不足出对比取舍题。
            练完回报告里重跑一次匹配，就能看到那几条结论有没有变化。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" loading={busy === 'training'} onClick={() => void generateTraining()}>
            {plan ? '重新生成训练计划' : '生成训练计划'}
          </Button>
          {plan ? (
            <Button size="sm" variant="danger" onClick={() => void deleteTrainingPlan(plan.id)}>
              删除计划
            </Button>
          ) : null}
        </div>
      </header>

      <Card>
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-[1.4fr_repeat(3,minmax(0,1fr))]">
          <div>
            <div className="text-[11px] text-slate-500">当前岗位</div>
            <div className="mt-1 text-[14px] font-medium text-slate-800">{job.jobTitle}</div>
            <div className="mt-1 text-[11px] text-slate-500">
              {report ? `匹配报告生成于 ${formatDateTime(report.createdAt)}` : '还没有这个岗位的匹配报告'}
            </div>
            {!report ? (
              <div className="mt-2">
                <Button size="sm" variant="primary" onClick={() => navigate('match')}>
                  先跑一次匹配
                </Button>
              </div>
            ) : null}
          </div>
          <Stat
            label="题库来源"
            value={report ? `${candidates.length} 条可训练` : '—'}
            hint={report ? `未满足共 ${unmetTotal} 条，低优先级加分项不计入` : undefined}
          />
          <Stat label="训练题" value={plan ? plan.items.length : '—'} hint={plan ? `${plan.stats.reviewed} 题已复习` : undefined} />
          <Stat
            label="自评均分"
            value={plan?.stats.averageScore ?? '—'}
            hint={plan ? `满分 3 · ${plan.stats.answered + plan.stats.reviewed} 题已作答` : undefined}
          />
        </div>
        {plan ? (
          <div className="border-t border-slate-100 px-5 py-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <span>计划生成于 {formatDateTime(plan.createdAt)}</span>
              <span className="text-slate-300">|</span>
              <span>引擎：{plan.engine === 'rule' ? '本地知识库' : '模型 + 本地知识库'}</span>
              <span className="text-slate-300">|</span>
              <Badge tone="danger">能力缺口 {plan.source.gap}</Badge>
              <Badge tone="info">缺少证据 {plan.source.lacking_evidence}</Badge>
              <Badge tone="warning">证据不足 {plan.source.partial}</Badge>
            </div>
          </div>
        ) : null}
      </Card>

      {plan ? (
        <>
          <Callout>{plan.suggestedNextStep}</Callout>
          <div>
            <SectionTitle title={`训练题（${plan.items.length}）`} description="按优先级排序：缺口 > 缺少证据 > 证据不足" />
            <div className="space-y-2.5">
              {plan.items.map((item) => (
                <TrainingCard
                  key={item.id}
                  item={item}
                  draft={drafts[item.id] ?? item.userAnswer ?? ''}
                  judgement={trainingJudge[item.id]}
                  showJudgeReason={showJudgeReason}
                  onDraft={(value) => setDrafts((prev) => ({ ...prev, [item.id]: value }))}
                  onSave={(patch) => void updateTrainingItem(item.id, patch)}
                  onReview={() => void updateTrainingItem(item.id, { markReviewed: true })}
                  onJudge={() => void judgeTraining(item.id)}
                  onSubmitEvidence={() => void submitTrainingEvidence(item.id)}
                  onPark={() => void parkTraining(item.id, '暂时不想再练了')}
                  onResume={() => void updateTrainingItem(item.id, { followUpCount: item.followUpCount ?? 0 })}
                />
              ))}
            </div>
          </div>
        </>
      ) : (
        <Card>
          <EmptyState
            title="还没有训练计划"
            description={
              report
                ? `当前岗位有 ${unmetTotal} 条要求没有完全满足，其中 ${candidates.length} 条值得专项训练（低优先级的加分项不计入），点上面的按钮按这些要求出题。`
                : '先对这个岗位跑一次匹配分析，训练题需要基于匹配结果生成。'
            }
            action={
              <Button variant="primary" loading={busy === 'training'} disabled={!report} onClick={() => void generateTraining()}>
                生成训练计划
              </Button>
            }
          />
        </Card>
      )}

      <Card className="border-dashed">
        <CardHeader title="训练题的边界" subtitle="这一页做什么、不做什么，写清楚避免误解" />
        <div className="space-y-2 px-5 py-4 text-[12px] leading-relaxed text-slate-600">
          <div className="flex gap-2">
            <Badge tone="success">做</Badge>
            <span className="flex-1">
              按你这次没答上的要求出题，附自查要点与常见追问；自评分数记录下来用于回看进度。
            </span>
          </div>
          <div className="flex gap-2">
            <Badge tone="success">做</Badge>
            <span className="flex-1">
              判定「有没有答到点」—— 只看四件可核对的事：有没有说清场景、有没有讲出为什么这么做、
              有没有数字或可核对载体、有没有覆盖自查要点。<b>不评价表达</b>：
              条理不清、篇幅太长这些是练几次就能改的，写进能力库对任何岗位的判断都没有贡献。
            </span>
          </div>
          <div className="flex gap-2">
            <Badge tone="success">做</Badge>
            <span className="flex-1">把你写的这段经历补进能力库（只挂在这道题对应的技能上），这样匹配结论才会因为「练过」而变化。</span>
          </div>
          <div className="flex gap-2">
            <Badge tone="danger">不做</Badge>
            <span className="flex-1">
              不判断你的回答<b>对不对</b> —— 训练题是「你做过的事」，不存在标准答案。
              判定问的是「你有没有把它讲成可核对的样子」，不是「答案是否正确」。
            </span>
          </div>
          <div className="flex gap-2">
            <Badge tone="danger">不做</Badge>
            <span className="flex-1">不会因为「练到达标」就告诉你这个岗位可以投了 —— 那需要重跑一次匹配才能确认。</span>
          </div>
          <div className="flex gap-2">
            <Badge tone="warning">关于强度</Badge>
            <span className="flex-1">{TRAINING_EVIDENCE_WHY}</span>
          </div>
        </div>
      </Card>

      {upcoming.length > 0 ? (
        <div>
          <SectionTitle title="后续会接入" description="这些能力当前版本仍未开放，界面上不会给会失败的入口" />
          <ComingSoonPanel
            reason="模拟面试与回答分析需要面试反馈这类真实信号，排在能力问诊之后；第三方课程涉及商业合作与分账，属于方向性规划。"
            items={upcoming.map((c) => ({ id: c.id, label: c.label, description: c.description, docRef: c.docRef, since: c.since }))}
          />
        </div>
      ) : null}

      {plan ? (
        <Banner tone="info">
          判定通过的题可以把经历补进能力库；补完之后回到「简历匹配」重新分析一次，
          被判为「缺少证据」的那几条应该会跟着变化 —— 这就是训练是否有效的判断方式。
          <span className="ml-1 inline-block">
            <Button size="sm" onClick={() => navigate('match')}>
              去重新分析
            </Button>
          </span>
        </Banner>
      ) : null}
    </div>
  );
}
