import { useMemo, useState } from 'react';
import {
  ANSWER_DISCLAIMER,
  capabilityStatus,
  formatDateTime,
  prepareQuestions,
  splitQuestions,
  STRENGTH_LABEL,
  type CandidateProfile,
  type JobRequirement,
  type PreparedQuestion,
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
  Stat,
  StrengthBadge,
  TextArea,
  cn,
} from '../components/ui';
import { useApp } from '../state/store';

/**
 * 面试问答推荐（v0.4）
 * ===================
 *
 * 与其它页面方向相反：这里**用户出题，系统给答法**。
 *
 * 存在的理由是一句很具体的场景：用户手上已经有一批面试官可能会问的问题
 * （从招聘网站复制的、HR 微信里发的），此刻他需要的是
 * 「这句话该怎么接」，而不是「再给我十道题」。
 *
 * **这一页不生成可直接照抄的答案**，只给回答结构。
 * 理由写在 `domain/interview-prep.ts` 文件头；页面上必须把它讲清楚，
 * 否则用户会默认这里能给他一句能背的话。
 */

const KIND_TONE: Record<PreparedQuestion['kind'], 'accent' | 'info' | 'warning' | 'neutral' | 'danger' | 'success'> = {
  behavioral: 'accent',
  technical: 'info',
  motivation: 'neutral',
  situation: 'warning',
  collaboration: 'success',
  future: 'neutral',
  pressure: 'danger',
  fit: 'accent',
};

function PreparedCard({ item }: { item: PreparedQuestion }) {
  const noEvidence = !item.coverage.hasEvidence;

  return (
    <Card className={noEvidence ? 'border-amber-200' : ''}>
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={KIND_TONE[item.kind]}>{item.kindLabel}</Badge>
          <span className="flex-1" />
          {noEvidence ? <Badge tone="warning">档案里没有材料</Badge> : <Badge tone="success">档案里可引用</Badge>}
        </div>

        <p className="mt-2 text-[13px] font-medium leading-relaxed text-slate-800">{item.text}</p>

        <div className="mt-2.5">
          <Callout>{item.coverage.note}</Callout>
        </div>

        <div className="mt-2.5">
          <div className="text-[11px] font-medium text-slate-700">这个回答必须覆盖</div>
          <ul className="mt-1 space-y-1">
            {item.blueprint.mustCover.map((point, i) => (
              <li key={i} className="text-[12px] leading-relaxed text-slate-600">
                · {point}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-2.5 space-y-2">
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
            <div className="text-[11px] font-medium text-amber-800">最容易踩的坑</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-amber-800">{item.blueprint.pitfall}</div>
          </div>

          <div className="text-[11px] leading-relaxed text-slate-500">
            <span className="font-medium text-slate-600">对方大概率接着问：</span>
            {item.blueprint.followUpLikely}
          </div>

          {item.citable.length > 0 ? (
            <Collapsible title={`档案里可能引用的（${item.citable.length} 条）`} defaultOpen={false}>
              <div className="space-y-2">
                {item.citable.map((c) => (
                  <div key={c.evidenceId} className="rounded-lg border border-slate-200 px-2.5 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-medium text-slate-700">{c.title}</span>
                      <StrengthBadge strength={c.strength} />
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-600">{c.excerpt}</p>
                  </div>
                ))}
                <div className="text-[10px] leading-relaxed text-slate-400">
                  这些只是「可能相关」，而且这里显示的是原文而不是话术 ——
                  直接照着念，面试官追问两句就会露馅。作用是帮你想起来「我确实干过这件事」。
                </div>
              </div>
            </Collapsible>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export function PrepPage() {
  const snapshot = useApp((s) => s.snapshot);
  const busy = useApp((s) => s.busy);

  const [raw, setRaw] = useState('');
  const [result, setResult] = useState<{
    items: PreparedQuestion[];
    engine: string;
    warnings: string[];
    at: string;
  } | null>(null);
  const [error, setError] = useState('');

  const profile = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0];
  const job = snapshot.jobs.find((j) => j.id === snapshot.ui.activeJobId) ?? snapshot.jobs[0];

  // 实时预览拆了几条 —— 用户粘贴一大段时，需要立刻知道会处理成几条
  const preview = useMemo(() => splitQuestions(raw).length, [raw]);

  const run = async () => {
    setError('');
    if (!raw.trim()) {
      setError('请先粘贴面试官可能会问的问题');
      return;
    }
    try {
      const out = await prepareQuestions({
        profile: profile ?? null,
        job: job ?? null,
        raw,
        gateway: null,
      });
      setResult({ items: out.items, engine: out.engine, warnings: out.warnings, at: new Date().toISOString() });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const withoutEvidence = result ? result.items.filter((i) => !i.coverage.hasEvidence).length : 0;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-semibold text-slate-800">面试问答推荐</h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">
            把你手头的面试问题贴进来 —— 从招聘网站复制的、HR 发你的都行。
            系统告诉你每个问题属于哪一类、回答必须覆盖哪几点、档案里有什么能引用的。
          </p>
        </div>
      </header>

      {/*
        免责声明放在最上面而不是页脚。
        理由：用户是带着「能不能给我一句能背的话」进来的，
        这个期待必须在第一屏就打断 —— 放到页脚就等于默认他可以先抱错误期待。
      */}
      <Banner tone="warning" title={ANSWER_DISCLAIMER.headline}>
        <ul className="mt-1 space-y-0.5">
          {ANSWER_DISCLAIMER.points.map((p, i) => (
            <li key={i}>· {p}</li>
          ))}
        </ul>
      </Banner>

      {!profile ? (
        <Banner tone="info" title="还没有能力档案">
          这一页能告诉你「档案里有没有材料可引用」，所以建议先建一份档案。
          没档案也能用 —— 只是每一题都会显示「档案里没有材料」。
        </Banner>
      ) : null}

      <Card>
        <CardHeader
          title="贴入面试问题"
          subtitle="可以一次贴一整段，系统会按条拆开。整句复制招聘网站的「面试会问什么」就行。"
        />
        <div className="px-5 py-4">
          <Field
            label="面试官可能会问的问题"
            hint={
              preview > 0
                ? `识别出 ${preview} 条问题${job ? ` · 当前岗位：${job.jobTitle}` : ''}`
                : '每行一条，或直接粘一整段'
            }
          >
            <TextArea
              rows={7}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={'介绍一下你自己\n为什么想加入我们\n讲一个你解决过的最难的技术问题\n你期望的薪资是多少？\n跟同事意见不一致的时候你怎么处理？'}
            />
          </Field>

          {error ? <div className="mt-2 text-[12px] text-rose-600">{error}</div> : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={!raw.trim()} loading={busy === 'prep'} onClick={() => void run()}>
              生成回答结构建议
            </Button>
            {result ? (
              <span className="text-[11px] text-slate-500">
                上次结果生成于 {formatDateTime(result.at)} · {result.items.length} 条问题
              </span>
            ) : null}
          </div>
        </div>
      </Card>

      {result ? (
        <>
          <Card>
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-[1.4fr_repeat(3,minmax(0,1fr))]">
              <div>
                <div className="text-[11px] text-slate-500">这一批问题</div>
                <div className="mt-1 text-[14px] font-medium text-slate-800">
                  {result.items.length} 条 · 按类别归好
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  引擎：{result.engine === 'rule' ? '本地规则' : '模型 + 本地规则'}
                </div>
              </div>
              <Stat label="档案可引用" value={result.items.length - withoutEvidence} hint={`${withoutEvidence} 条没有材料`} />
              <Stat label="档案可引用率" value={`${Math.round(((result.items.length - withoutEvidence) / Math.max(1, result.items.length)) * 100)}%`} hint="越低说明越要提前准备" />
              <Stat
                label="最需要准备"
                value={withoutEvidence > 0 ? withoutEvidence : '—'}
                hint={withoutEvidence > 0 ? '条问题在档案里找不到材料' : '全部都能引到证据'}
              />
            </div>
          </Card>

          {result.warnings.map((w, i) => (
            <Banner key={i} tone="info">
              {w}
            </Banner>
          ))}

          {withoutEvidence > 0 ? (
            <Banner tone="warning" title={`有 ${withoutEvidence} 条问题在你的档案里找不到能引用的东西`}>
              这不是坏消息 —— 提前知道比面试时被问住强。
              这几题的准备重点是「承认没做过，但说清你会怎么上手」，
              硬凑一个不相关的例子反而危险。
            </Banner>
          ) : null}

          <div>
            <SectionTitle
              title={`回答结构建议（${result.items.length}）`}
              description="每条只给结构与可引用材料，不给可直接照说的答案"
            />
            <div className="space-y-2.5">
              {result.items.map((item) => (
                <PreparedCard key={item.id} item={item} />
              ))}
            </div>
          </div>
        </>
      ) : (
        <Card>
          <EmptyState
            title="还没有生成过"
            description="上面贴入面试问题后点按钮。系统只给回答必须覆盖的要点与档案里可引用的材料 —— 内容仍然要你自己填。"
          />
        </Card>
      )}

      <Card className="border-dashed">
        <CardHeader title="这一页不做什么" subtitle="写清楚避免误解" />
        <div className="space-y-2 px-5 py-4 text-[12px] leading-relaxed text-slate-600">
          <div className="flex gap-2">
            <Badge tone="success">做</Badge>
            <span className="flex-1">
              归类问题、指出每类回答必须覆盖的结构、标出最容易踩的坑与可能的追问、
              把你档案里相关的原文找出来给你看。
            </span>
          </div>
          <div className="flex gap-2">
            <Badge tone="danger">不做</Badge>
            <span className="flex-1">
              不生成可直接照读的答案。理由很实际：背下来的答案在追问下会崩，
              而那时你甚至不知道它是从哪来的。
            </span>
          </div>
          <div className="flex gap-2">
            <Badge tone="warning">注意</Badge>
            <span className="flex-1">
              「档案里没有材料」只说明你的档案没写过，不等于你没经历过 ——
              经历可能没写进简历，或者属于另一类能力。这时要自己想，工具帮不上。
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}
