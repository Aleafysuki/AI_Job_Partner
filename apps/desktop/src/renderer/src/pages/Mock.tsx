import { useMemo, useState } from 'react';
import {
  ANSWER_DIMENSION_LABEL,
  DIMENSION_HEALTH_LABEL,
  DIMENSION_VERDICT_LABEL,
  HIT_RATE_LABEL,
  MOCK_DISCLAIMER,
  MOCK_KIND_LABEL,
  QUESTION_SOURCE_LABEL,
  WEAKENING_ACTION_LABEL,
  analyzeAnswer,
  buildWeakeningSuggestions,
  collectWeaknesses,
  computeMockStats,
  decideFollowUp,
  finishMockSession,
  generateMockQuestions,
  newMockSession,
  nextQuestionOf,
  newId,
  type AnswerAnalysis,
  type CandidateProfile,
  type DimensionVerdict,
  type JobRequirement,
  type MockAnswer,
  type MockQuestion,
  type MockSession,
  type MockWeakness,
  type WeakeningSuggestion,
  type AnswerFeedbackView,
  type FollowUpHook,
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
  TextArea,
  TextInput,
  cn,
} from '../components/ui';
import { useApp } from '../state/store';

/**
 * 模拟面试（v0.4：`interview.generate` / `interview.mock` /
 * `interview.analyze_answer` / `interview.weak_point_training`）
 *
 * 与 `Prep.tsx` 的关系：那边是「你出题，系统给结构」，这边是「系统出题，你答」。
 * 两者共享同一条产品立场 —— **不给可以照读的答案**，理由见 core 的文件头。
 * 区别在于这边更进一步：连第 2 轮之后问什么都不预告，
 * 因为预告了下一次追问就等于给了准备时间，而准备时间的代价是失去诊断价值。
 *
 * ⚠ 这一页在能力表里仍是 `since: 'v0.4'`（未解锁）。
 *    实装已完成，但要开它得先显式改 since —— 见 docs/ROADMAP.md 的说明。
 */

/**
 * 这一题已经答过几轮。
 *
 * 追问题的 id 带 `_fuN` 后缀（N 从 1 起），
 * 所以「这一题的追问次数」= 该前缀的题目数。
 * 有了它才能实现「最多追两下」的上限 ——
 * 而这个上限是必须的：每次都追的话，5 题会变成 20 题。
 */
function followUpCountOf(
  session: { questions: MockQuestion[] },
  baseId: string,
): number {
  const fuPrefix = `${baseId}_fu`;
  return session.questions.filter((q) => q.id.startsWith(fuPrefix)).length;
}

const VERDICT_TONE: Record<DimensionVerdict, 'success' | 'warning' | 'danger'> = {
  ok: 'success',
  partial: 'warning',
  missing: 'danger',
};

const SOURCE_TONE: Record<string, 'accent' | 'info' | 'warning' | 'neutral'> = {
  real: 'accent',
  requirement: 'info',
  gap: 'warning',
  domain: 'neutral',
};

// ---------------------------------------------------------------------------
// 单轮分析
// ---------------------------------------------------------------------------

function AnalysisBlock({ analysis }: { analysis: AnswerAnalysis }) {
  return (
    <div className="mock-analysis">
      <SectionTitle title="这一轮的分析" />

      {/* 五维结论。刻意不给总分 —— 与「不提供 0–100 匹配分」同源：
          五个维度合成一个分，权重就变成了隐藏的产品判断，用户无法反驳。 */}
      <ul className="mock-dims">
        {analysis.findings.map((f) => (
          <li key={f.dimension} className={cn('mock-dim', `is-${f.verdict}`)}>
            <span className="mock-dim__name">{ANSWER_DIMENSION_LABEL[f.dimension]}</span>
            <Badge tone={VERDICT_TONE[f.verdict]}>{DIMENSION_VERDICT_LABEL[f.verdict]}</Badge>
            {f.gap ? <p className="mock-dim__gap">{f.gap}</p> : null}
            {f.quotedFromAnswer ? (
              <p className="mock-dim__quote">
                你说的：<q>{f.quotedFromAnswer}</q>
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {/* 追问预告：给的是「对方接下来会问什么」，不是「你应该怎么答」。
          有追问预告而不给答法，用户才有动力自己想。 */}
      {analysis.likelyFollowUps.length > 0 ? (
        <div className="mock-followups">
          <h4 className="text-[12px] font-semibold text-slate-700">接下来可能会被追问</h4>
          <ul>
            {analysis.likelyFollowUps.map((f, i) => (
              <li key={`${f}-${i}`}>{f}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {analysis.usedEvidence ? (
        <Callout className="mock-evidence">
          <strong>你引用到了自己档案里的材料</strong>
          <ul>
            {analysis.evidenceQuotes.map((q) => (
              <li key={q.evidenceId}>
                <q>{q.quote}</q>
                <span className="text-[12px] leading-relaxed text-slate-500"> —— {q.source}</span>
              </li>
            ))}
          </ul>
          <p className="text-[12px] leading-relaxed text-slate-500">这些是你的真实经历，说的时候不用犹豫。</p>
        </Callout>
      ) : (
        <p className="mock-no-evidence">
          这一轮你没有引用档案里的任何材料。如果这里面有你真做过的事，值得说一句 ——
          面试官只有听到具体做了什么，才能判断你是不是真的会。
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 薄弱点回流
// ---------------------------------------------------------------------------

function WeakeningBlock({
  weaknesses,
  profile,
  job,
}: {
  weaknesses: MockWeakness[];
  profile: CandidateProfile | null;
  job: JobRequirement | null;
}) {
  const suggestions = useMemo<WeakeningSuggestion[]>(
    () =>
      weaknesses.length > 0
        ? buildWeakeningSuggestions({
            // profile 是 nullable（还没建档案时），而引擎要求非空 → 显式过滤
            profile: (profile ?? { evidences: [] }) as unknown as CandidateProfile,
            weaknesses,
          })
        : [],
    [weaknesses, profile, job],
  );

  if (weaknesses.length === 0) {
    return (
      <EmptyState
        title="这一场没有发现明显薄弱点"
        description="这不代表你答得好 —— 也可能是题目太浅。多带几道真题来会更有诊断价值。"
      />
    );
  }

  return (
    <div className="mock-weakenings">
      <SectionTitle title="这场暴露出来的问题" />
      <p className="text-[12px] leading-relaxed text-slate-500">
        只收了「知识」与「答到点」两类。表达习惯（结构、篇幅）不进这里 ——
        那是练几次就能改的，写进能力库对任何岗位的判断都没有贡献。
      </p>

      {suggestions.map((s, i) => (
        <Card key={`${s.weakness.gap}-${i}`}>
          <CardHeader
            title={s.weakness.gap}
            subtitle={WEAKENING_ACTION_LABEL[s.action]}
          />
          <p>{s.why}</p>
          {s.weakness.evidenceQuotes.length > 0 ? (
            <Collapsible title="你说的原话">
              <ul>
                {s.weakness.evidenceQuotes.map((q, qi) => (
                  <li key={qi}>
                    <q>{q}</q>
                  </li>
                ))}
              </ul>
            </Collapsible>
          ) : null}
        </Card>
      ))}

      <Callout>
        这些问题会留在你的档案里，<strong>换岗位也还在</strong>。
        下次做匹配或问诊时，它们会影响判断。不想留着就删掉 —— 但先想清楚再删。
      </Callout>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export default function MockInterviewPage() {
  const snapshot = useApp((s) => s.snapshot);
  const route = useApp((s) => s.route);
  const navigate = useApp((s) => s.navigate);

  const profile: CandidateProfile | null = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0] ?? null;
  const job: JobRequirement | null = snapshot.jobs.find((j) => j.id === snapshot.ui.activeJobId) ?? snapshot.jobs[0] ?? null;

  // ---- 配置态 ----
  const [realQuestions, setRealQuestions] = useState('');
  const [realRound, setRealRound] = useState('');
  const [domains, setDomains] = useState('');
  const [includePressure, setIncludePressure] = useState(true);
  const [includeGap, setIncludeGap] = useState(true);
  const [maxQuestions, setMaxQuestions] = useState(4);

  // ---- 进行态 ----
  const [session, setSession] = useState<MockSession | null>(null);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<'setup' | 'session' | 'review'>('setup');

  /*
   * 交互式追问的状态（v0.5）。
   *
   * 为什么要独立存而不是从 session 里推：
   *   `feedback` 是「刚答完这一轮的反馈」，答完就展示、点继续就消失；
   *   `pendingHook` 是「下一步要问的追问」。
   * 两者都只活一轮，推导反而要在渲染时重跑一遍判定 ——
   * 而判定有「追过几次」这种状态，重跑会得到不同结果。
   */
  const [feedback, setFeedback] = useState<AnswerFeedbackView | null>(null);
  const [pendingHook, setPendingHook] = useState<FollowUpHook | null>(null);

  const stats = useMemo(() => (session ? computeMockStats(session) : null), [session]);
  const current = session ? nextQuestionOf(session) : undefined;

  const start = () => {
    const generated = generateMockQuestions({
      profile,
      job,
      realQuestions,
      realQuestionRefs: realQuestions
        .split('\n')
        .map((t) => t.trim())
        .filter((t) => t.length > 3)
        .map(() => (realRound.trim() ? { round: realRound.trim() } : {})),
      domains: domains
        .split(/[,，、\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
      includePressure,
      includeGap,
      maxQuestions,
    });

    if (generated.questions.length === 0) {
      return;
    }
    const s = newMockSession({
      jobTitle: job?.jobTitle,
      domains: domains.split(/[,，、\s]+/).filter(Boolean),
      includePressure,
      includeGap,
      maxQuestions,
    });
    s.questions = generated.questions;
    setSession(s);
    setView('session');
    setDraft('');
  };

  /**
   * 答完一题之后。
   *
   * v0.5 的关键改动：**不再直接跳下一题**。
   * 先算出「这一答有哪些可追问的点」，然后由 decideFollowUp 决定
   * 是继续追同一题，还是换下一题。
   *
   * 为什么不预告下一轮会问什么（追问的正文）：
   *   预告了就等于给了准备时间，而准备时间的代价是失去诊断价值。
   *   所以界面上只出现**当前**这轮的反馈，追问出现在用户点「继续」之后。
   */
  const submit = () => {
    if (!session || !current || draft.trim().length === 0) return;
    const answer: MockAnswer = {
      questionId: current.id,
      text: draft.trim(),
      channel: 'text',
    };
    const analysis = analyzeAnswer({ question: current, answer, profile });

    const hooks = analysis.followUpHooks ?? [];
    const followUpCount = session.answers.filter((a) => a.questionId === current.id).length;
    const decision = decideFollowUp({
      answerText: answer.text,
      hooks,
      followUpCount,
    });

    setSession({
      ...session,
      answers: [...session.answers, answer],
      analyses: [...session.analyses, analysis],
    });
    setFeedback(analysis.feedback ?? null);
    setPendingHook(decision.shouldFollowUp ? decision.hook ?? null : null);
    setDraft('');
  };

  /** 追问：把当前题目的 round +1，并记一个「这是追问」的标记 */
  const askFollowUp = () => {
    if (!session || !current || !pendingHook) return;
    const followUp: MockQuestion = {
      ...current,
      id: newId('mock'),
      round: current.round,
      // 标记为追问：界面上要显示「这是对上一答的追问」
      kind: current.kind,
      text: pendingHook.text,
      intent: pendingHook.intent,
      expectedPoints: pendingHook.expectedPoints,
      evidenceIds: current.evidenceIds,
      source: current.source,
      probes: current.probes,
      // 用一个特殊的 id 前缀标识追问，复盘时好分组
      requirementId: current.requirementId,
    };
    // 追问题的 id 带 _fu 后缀，recalc 时据此判断轮次
    followUp.id = `${current.id}_fu${followUpCountOf(session, current.id) + 1}`;
    setSession({ ...session, questions: [...session.questions, followUp] });
    setFeedback(null);
    setPendingHook(null);
  };

  /** 跳过追问，直接进下一题 */
  const skipFollowUp = () => {
    setPendingHook(null);
    setFeedback(null);
  };

  /** 确认看完了反馈，进下一题 */
  const clearFeedback = () => {
    setFeedback(null);
    setPendingHook(null);
  };

  const finish = () => {
    if (!session) return;
    setSession(finishMockSession(session));
    setView('review');
  };

  // -------------------------------------------------------------------------
  // 配置态
  // -------------------------------------------------------------------------
  if (view === 'setup') {
    return (
      <div className="page">
        <SectionTitle title="模拟面试" />

        <Banner tone="info" title="先说清楚这一页不做什么">
          {MOCK_DISCLAIMER}
        </Banner>

        <Callout className="text-[12px] leading-relaxed text-slate-500">
          训练页给参考答案，是因为训练题有客观对错，联合索引是什么就是什么。
          这一页不给 —— 模拟面试考的是表达，背下来的表达在第三轮追问下会崩。
          这里只告诉你「缺什么」，怎么补由你自己决定。
        </Callout>

        <Card>
          <CardHeader title="题从哪来" subtitle="最多会出多少题，由你定" />
          <Field
            label="粘贴真题（可选）"
            hint="一行一题。从招聘网站或 HR 那里拿到的题最贴近真实考场"
          >
            <TextArea
              value={realQuestions}
              onChange={(e) => setRealQuestions(e.target.value)}
              placeholder={'介绍一下你自己\n讲一个你做过的最有挑战的项目\n为什么想来我们'}
              rows={5}
            />
          </Field>
          <Field label="真题出处（可选）" hint="「一面」「HR 面」之类。填了会标在这批题上">
            <TextInput value={realRound} onChange={(e) => setRealRound(e.target.value)} placeholder="一面" />
          </Field>
          <Field label="指定领域（可选）" hint="用逗号分隔。例如「数据库, 消息队列」">
            <TextInput value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="Redis, 分布式一致性" />
          </Field>
        </Card>

        <Card>
          <CardHeader title="出题设置" />
          <Field label="题目数量">
            <TextInput
              type="number"
              min={1}
              max={8}
              value={maxQuestions}
              onChange={(e) => setMaxQuestions(Number(e.target.value) || 4)}
            />
          </Field>
          <label className="mock-check">
            <input type="checkbox" checked={includeGap} onChange={(e) => setIncludeGap(e.target.checked)} />
            <span>
              <strong>针对你档案里没有证据的地方出题</strong>
              <span className="text-[12px] leading-relaxed text-slate-500">
                这一类最有价值 —— 你答不出来的往往不是不会，而是从没写下来过。
              </span>
            </span>
          </label>
          <label className="mock-check">
            <input
              type="checkbox"
              checked={includePressure}
              onChange={(e) => setIncludePressure(e.target.checked)}
            />
            <span>
              <strong>包含压力题</strong>
              <span className="text-[12px] leading-relaxed text-slate-500">
                会问「如果这条数据是错的，你的结论会怎么变」。压力题一定排在最后。
              </span>
            </span>
          </label>
        </Card>

        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="primary" onClick={start} disabled={!profile && !job && !realQuestions.trim() && !domains.trim()}>
            开始模拟面试
          </Button>
          {!profile && !job ? (
            <span className="text-[12px] leading-relaxed text-slate-500">
              没有档案也没有岗位时只能按指定领域出题。建议先{' '}
              <button className="link" onClick={() => navigate('profile')}>
                建一份档案
              </button>
              。
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // 复盘态
  // -------------------------------------------------------------------------
  if (view === 'review' && session && stats) {
    return (
      <div className="page">
        <SectionTitle title="这场面试的结果" />

        <Card>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="答了" value={`${stats.answeredCount} / ${stats.questionCount}`} />
            <Stat label="答到点" value={HIT_RATE_LABEL[stats.hitRate]} />
            <Stat label="表达" value={DIMENSION_HEALTH_LABEL[stats.dimensionHealth]} />
            <Stat label="发现薄弱点" value={stats.weaknessCount} />
          </div>
        </Card>

        <SectionTitle title="逐轮回顾" />
        {session.questions.map((q, i) => {
          const answer = session.answers.find((a) => a.questionId === q.id);
          const analysis = session.analyses.find((a) => a.questionId === q.id);
          if (!answer || !analysis) return null;
          return (
            <Collapsible key={q.id} title={`第 ${i + 1} 题 · ${q.text}`} defaultOpen={i === 0}>
              <p className="text-[12px] leading-relaxed text-slate-500">
                {QUESTION_SOURCE_LABEL[q.source]} · {MOCK_KIND_LABEL[q.kind]}
                {q.sourceRef?.round ? ` · ${q.sourceRef.round}` : ''}
              </p>
              <p className="mock-why">
                <strong>对方想看什么：</strong>
                {q.intent}
              </p>
              <h4 className="text-[12px] font-semibold text-slate-700">你的回答</h4>
              <p className="mock-answer-text">{answer.text}</p>
              <AnalysisBlock analysis={analysis} />
            </Collapsible>
          );
        })}

        <SectionTitle title="回流到能力库" />
        <WeakeningBlock weaknesses={session.weaknesses} profile={profile} job={job} />

        <div className="flex items-center gap-2 flex-wrap">
          <Button onClick={() => setView('setup')}>再来一场</Button>
          <Button variant="ghost" onClick={() => navigate(route === 'mock' ? 'workbench' : route)}>
            结束
          </Button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // 进行态
  // -------------------------------------------------------------------------
  if (!session || !current || !stats) {
    return (
      <div className="page">
        <EmptyState title="没有进行中的模拟面试" />
        <Button onClick={() => setView('setup')}>去出题</Button>
      </div>
    );
  }

  const lastAnalysis = session.analyses[session.analyses.length - 1];

  return (
    <div className="page">
      <div className="mock-progress">
        <span className="text-[12px] leading-relaxed text-slate-500">
          第 {current.round} 题 / 共 {session.questions.length} 题
        </span>
        <div className="mock-progress__bar" role="progressbar" aria-valuenow={current.round} aria-valuemax={session.questions.length}>
          <div style={{ width: `${(current.round / session.questions.length) * 100}%` }} />
        </div>
      </div>

      <Card>
        <CardHeader
          title={current.text}
          subtitle={`${MOCK_KIND_LABEL[current.kind]}${current.sourceRef?.round ? ` · ${current.sourceRef.round}` : ''}`}
          action={
            <Badge tone={SOURCE_TONE[current.source] ?? 'neutral'}>{QUESTION_SOURCE_LABEL[current.source]}</Badge>
          }
        />
        <p className="mock-why">
          <strong>对方想看什么：</strong>
          {current.intent}
        </p>
      </Card>

      <Field
        label="你的回答"
            hint="按你面试时真的会说的话写 —— 写成书面语会失真"
      >
        <TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={7}
          placeholder="用你自己的话说一遍。不用组织语言，说得磕巴也没关系 —— 磕巴的地方往往就是你要练的地方。"
        />
      </Field>

      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="primary" onClick={submit} disabled={draft.trim().length === 0}>
          答完，看分析
        </Button>
        <Button variant="ghost" onClick={finish}>
          中止这场
        </Button>
      </div>

      {/*
        答完之后的反馈（v0.5）。
        它出现在**提交之前的位置**，而不是跳到下一题之后 ——
        因为反馈是这个决定的基础：看完反馈再决定要不要继续答。

        界面上只说「缺什么」与「好在哪」，不给「你应该这样说」。
      */}
      {feedback ? (
        <Card className="mock-feedback">
          <div className="mock-feedback__head">{feedback.headline}</div>

          {feedback.gaps.length > 0 ? (
            <ul className="mock-feedback__list">
              {feedback.gaps.map((g, i) => (
                <li key={i}>
                  {g.text}
                  {g.anchor ? (
                    <span className="mock-feedback__anchor">
                      你说的：<q>{g.anchor}</q>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-slate-600">这一轮没有明显的缺口。</p>
          )}

          {feedback.strengths.length > 0 ? (
            <div className="mock-feedback__good">
              {feedback.strengths.map((s, i) => (
                <span key={i} className="mock-feedback__chip">
                  {s}
                </span>
              ))}
            </div>
          ) : null}

          {/* 追问正文在这里才出现 —— 提前显示等于给了准备时间 */}
          {pendingHook ? (
            <div className="mock-followup">
              <div className="mock-followup__tag">接下来可能被追问</div>
              <p className="mock-followup__text">{pendingHook.text}</p>
              <p className="mock-followup__why">
                <strong>为什么问这个：</strong>
                {pendingHook.intent}
              </p>
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <Button variant="primary" onClick={askFollowUp}>
                  继续答这一题
                </Button>
                <Button variant="ghost" onClick={skipFollowUp}>
                  先跳过这题
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <Button variant="primary" onClick={clearFeedback}>
                下一题
              </Button>
            </div>
          )}
        </Card>
      ) : null}

      {lastAnalysis ? (
        <Collapsible title="上一轮的分析" defaultOpen={false}>
          <AnalysisBlock analysis={lastAnalysis} />
        </Collapsible>
      ) : null}

      <Callout className="text-[12px] leading-relaxed text-slate-500">{MOCK_DISCLAIMER}</Callout>
    </div>
  );
}