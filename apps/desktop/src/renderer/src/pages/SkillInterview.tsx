import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ASSESS_LAYER_LABEL,
  SKILL_LEVEL_LABEL,
  SKILL_LEVEL_MEANING,
  SKILL_LEVEL_ORDER,
  EVIDENCE_ORIGIN_LABEL,
  estimateSessionMinutes,
  pendingSkillsFor,
  nextQuestion,
  plannedCapabilities,
  type AssessLayer,
  type SkillLevel,
} from '@aijob/core';
import {
  Badge,
  Banner,
  Button,
  Callout,
  Card,
  CardHeader,
  ComingSoonPanel,
  EmptyState,
  Field,
  Modal,
  SectionTitle,
  Stat,
  StrengthBadge,
  TextArea,
  TextInput,
  Toggle,
  cn,
} from '../components/ui';
import { OnboardingPanel } from '../components/Onboarding';
import { useApp } from '../state/store';

/**
 * 能力问诊（v0.2）
 * =================
 *
 * 场景：简历里写「熟悉 RAG」，但匹配时被判成「缺少证据」——
 * 用户知道自己做过，却不知道怎么把它变成证据。
 *
 * 这一页用一组递进问答把「掌握到什么程度」问清楚，并把答案里真正具体的部分
 * 转成一条证据补充进能力库（自述来源，强度封顶为「中」）。
 */

const SIGNAL_META: Array<{ key: 'specificity' | 'depth' | 'output' | 'selfAwareness'; label: string; max: number; hint: string }> = [
  { key: 'specificity', label: '场景具体度', max: 3, hint: '有没有说清在什么场景下用过' },
  { key: 'depth', label: '使用深度', max: 3, hint: '有没有提到踩过的坑、做过的调整' },
  { key: 'output', label: '产出与载体', max: 3, hint: '有没有结果、数字或链接' },
  { key: 'selfAwareness', label: '认知边界', max: 1, hint: '说得出自己还不确定的部分' },
];

const LEVEL_TONE: Record<SkillLevel, string> = {
  unverified: 'bg-slate-100 text-slate-600 border-slate-200',
  aware: 'bg-slate-100 text-slate-700 border-slate-200',
  practiced: 'bg-sky-50 text-sky-700 border-sky-200',
  applied: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  delivered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  expert: 'bg-emerald-100 text-emerald-800 border-emerald-300',
};

function SignalBars({ signals }: { signals: Record<string, number> }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {SIGNAL_META.map((meta) => {
        const value = signals[meta.key] ?? 0;
        return (
          <div key={meta.key} className="rounded-lg border border-slate-200 px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-slate-700">{meta.label}</span>
              <span className="text-[11px] text-slate-400">
                {value}/{meta.max}
              </span>
            </div>
            <div className="mt-1.5 flex gap-1">
              {Array.from({ length: meta.max }).map((_, i) => (
                <span
                  key={`${meta.key}-${i}`}
                  className={cn('h-1.5 flex-1 rounded-full', i < value ? 'bg-indigo-500' : 'bg-slate-200')}
                />
              ))}
            </div>
            <div className="mt-1 text-[10px] text-slate-400">{meta.hint}</div>
          </div>
        );
      })}
    </div>
  );
}

export function SkillInterviewPage() {
  const snapshot = useApp((s) => s.snapshot);
  const session = useApp((s) => s.assessSession);
  const result = useApp((s) => s.assessResult);
  const meta = useApp((s) => s.assessMeta);
  const startAssess = useApp((s) => s.startAssess);
  const answerAssess = useApp((s) => s.answerAssess);
  const finishAssess = useApp((s) => s.finishAssess);
  const cancelAssess = useApp((s) => s.cancelAssess);
  const replanAssess = useApp((s) => s.replanAssess);
  const navigate = useApp((s) => s.navigate);
  const busy = useApp((s) => s.busy);

  const profile = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0];
  const job = snapshot.jobs.find((j) => j.id === snapshot.ui.activeJobId) ?? snapshot.jobs[0];

  const [compact, setCompact] = useState(false);
  const [text, setText] = useState('');
  const [choiceIndex, setChoiceIndex] = useState<number | null>(null);
  /** v0.4：选中的预置选项（点一下即完成这道题） */
  const [pickedChoice, setPickedChoice] = useState<string | null>(null);
  /** v0.4：是否必须自己写（点了「都不像」或选了需要补细节的项） */
  const [needsDetail, setNeedsDetail] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manualSkill, setManualSkill] = useState('');

  const pending = useMemo(() => (profile ? pendingSkillsFor(profile, job ?? null) : []), [profile, job]);
  const current = session ? nextQuestion(session) : null;
  const answeredCount = session ? session.answers.length : 0;

  // 换题时清空作答草稿
  useEffect(() => {
    setText('');
    setChoiceIndex(null);
    setPickedChoice(null);
    setNeedsDetail(false);
  }, [current?.question.id]);

  const assessedNames = new Set((profile?.assessments ?? []).map((a) => a.skillName));
  const upcoming = plannedCapabilities().filter((c) => c.id.startsWith('interview.'));

  if (!profile) {
    return (
      <div className="space-y-4">
        <SectionTitle title="能力问诊" description="先建立能力档案，才能针对具体技能做问诊" />
        <OnboardingPanel />
      </div>
    );
  }

  // ---------------- 结果页 ----------------
  if (result) {
    const { assessment, evidence } = result;
    return (
      <div className="space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[19px] font-semibold text-slate-800">问诊结论：{assessment.skillName}</h1>
            <p className="mt-1 text-xs text-slate-500">
              基于 {session ? session.answers.length : '—'} 个回答的确定性信号得出 · 引擎 {assessment.engine === 'rule' ? '本地规则' : '模型 + 本地规则'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => cancelAssess()}>
              再问一个技能
            </Button>
            <Button size="sm" variant="primary" onClick={() => navigate('profile')}>
              查看能力档案
            </Button>
          </div>
        </header>

        <Card>
          <div className="px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className={cn('rounded-lg border px-3 py-1.5 text-[15px] font-semibold', LEVEL_TONE[assessment.level])}>
                {SKILL_LEVEL_LABEL[assessment.level]}
              </span>
              <Badge tone="muted">置信度 {assessment.confidence === 'high' ? '高' : assessment.confidence === 'medium' ? '中' : '低'}</Badge>
              {assessment.signals.selfReport <= 1 ? <Badge tone="warning">自评偏低</Badge> : null}
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-slate-700">{assessment.summary}</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-slate-500">{SKILL_LEVEL_MEANING[assessment.level]}</p>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <Card>
            <CardHeader title="信号拆解" subtitle="全部由规则算出，可复算；模型只补充措辞，不改变这些数值" />
            <div className="px-5 py-4">
              <SignalBars signals={assessment.signals as unknown as Record<string, number>} />
            </div>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader title="能站住的部分" />
              <ul className="space-y-1.5 px-5 py-4">
                {assessment.strengths.length === 0 ? (
                  <li className="text-[12px] text-slate-400">这次没有可确认的强项</li>
                ) : (
                  assessment.strengths.map((s, i) => (
                    <li key={`s${i}`} className="text-[12px] leading-relaxed text-emerald-700">
                      · {s}
                    </li>
                  ))
                )}
              </ul>
            </Card>
            <Card>
              <CardHeader title="说不清的部分" subtitle="这些就是面试官会追下去的地方" />
              <ul className="space-y-1.5 px-5 py-4">
                {assessment.gaps.length === 0 ? (
                  <li className="text-[12px] leading-relaxed text-emerald-700">
                    · 这次问诊里没有发现说不清的部分 —— 场景、做法、结果都讲到了。
                  </li>
                ) : (
                  assessment.gaps.map((g, i) => (
                    <li key={`g${i}`} className="text-[12px] leading-relaxed text-rose-700">
                      · {g}
                    </li>
                  ))
                )}
              </ul>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader title="下一步" subtitle="单一、可执行" />
          <div className="px-5 py-4">
            <Callout>{assessment.recommendedAction}</Callout>
            {assessment.uncertainties.length > 0 ? (
              <div className="mt-3">
                <div className="text-[12px] font-medium text-slate-700">你自己说还不确定的部分（已记入「待学习」）</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {assessment.uncertainties.map((u) => (
                    <Badge key={u} tone="info">
                      {u}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </Card>

        <Card className={evidence ? '' : 'border-dashed'}>
          <CardHeader
            title={evidence ? '本次问诊补充的证据' : '本次没有生成证据'}
            subtitle={evidence ? '已自动并入能力库' : '原因见下方提示'}
          />
          <div className="px-5 py-4">
            {evidence ? (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">{EVIDENCE_ORIGIN_LABEL[evidence.origin]}</Badge>
                  <StrengthBadge strength={evidence.strength} />
                  {evidence.metrics.map((m) => (
                    <Badge key={m} tone="neutral">
                      {m}
                    </Badge>
                  ))}
                  {evidence.links.map((l) => (
                    <Badge key={l} tone="info">
                      {l.length > 40 ? `${l.slice(0, 40)}…` : l}
                    </Badge>
                  ))}
                </div>
                <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">{evidence.content}</p>
                <Callout>
                  <span className="font-medium">为什么强度只到「中」：</span>
                  {evidence.strengthReason}。问诊是自述，没有外部可核对物，所以规则上封顶。
                  想升到「强」，去能力档案里给这条证据补上链接或数字 —— 补完系统会自动重算。
                </Callout>
              </div>
            ) : (
              <Banner tone="warning">{result.warnings[0] ?? '这次回答里没有可写成证据的具体内容。'}</Banner>
            )}
          </div>
        </Card>
      </div>
    );
  }

  // ---------------- 问答进行中 ----------------
  if (session) {
    const total = session.questions.length;
    const done = answeredCount;
    const percent = Math.round((done / total) * 100);
    const answeredList = session.questions
      .map((q) => ({ q, a: session.answers.find((x) => x.questionId === q.id) }))
      .filter((row) => row.a);
    const suggestions = current?.question.suggestions ?? [];
    const quickChoices = current?.question.quickChoices ?? [];

    return (
      <div className="space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[19px] font-semibold text-slate-800">能力问诊 · {session.skillName}</h1>
            <p className="mt-1 text-xs text-slate-500">
              第 {Math.min(done + 1, total)} / {total} 题 · 预计还需 {estimateSessionMinutes(session)} 分钟
              {session.jobTitle ? ` · 关联岗位：${session.jobTitle}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" loading={busy === 'assess'} onClick={() => void replanAssess()}>
              换一套问题
            </Button>
            <Button size="sm" variant="ghost" onClick={() => cancelAssess()}>
              放弃这次问诊
            </Button>
          </div>
        </header>

        {/* v0.3：如实说明「这次会怎么问、为什么这么问」。
            用户对固定套路的反感有一半来自「不知道它接下来要问什么」。 */}
        {meta ? (
          <Card className="border-indigo-100 bg-indigo-50/40">
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[11px] text-indigo-900">
              <Badge tone="accent">{meta.shapeLabel}</Badge>
              <span>
                题目{meta.origin === 'ai' ? '由模型按「' + session.skillName + '」的真实分水岭生成' : '由本地规则按能力形状生成'}
              </span>
              {meta.shape === 'behavioral' ? (
                <span className="text-indigo-700">
                  · 这类能力不问「属于了解还是熟悉」—— 熟练度只能由具体事例证明，所以直接问你最近发生了什么
                </span>
              ) : null}
              {meta.suggestionCount > 0 ? (
                <span className="text-indigo-700">· 有 {meta.suggestionCount} 条候选可以一键采纳</span>
              ) : null}
            </div>
          </Card>
        ) : null}

        {meta?.warnings.length ? (
          <Banner tone="info">{meta.warnings[0]}</Banner>
        ) : null}

        <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full bg-indigo-500 transition-all" style={{ width: `${percent}%` }} />
        </div>

        {current ? (
          <Card>
            <div className="px-5 py-4">
              <div className="flex items-center gap-2">
                <Badge tone="accent">{ASSESS_LAYER_LABEL[current.question.layer as AssessLayer]}</Badge>
                {current.question.critical ? <Badge tone="warning">关键题</Badge> : null}
                {current.question.origin === 'evidence' ? <Badge tone="success">已带出候选</Badge> : null}
              </div>
              <p className="mt-2.5 text-[15px] font-medium leading-relaxed text-slate-800">{current.question.prompt}</p>
              {current.question.hint ? <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{current.question.hint}</p> : null}

              {/* v0.3 核心改动：候选优先。
                  用户反馈「用起来太费脑子」—— 这一段就是解药：
                  先从档案里已经写过的内容抽候选，点一下就完成这道题，
                  不用凭空回忆和组织语言。仍可自由填写。 */}
              {suggestions.length > 0 ? (
                <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/50 px-3 py-2.5">
                  <div className="text-[11px] font-medium text-emerald-800">
                    从你的档案里找到这些 —— 点一下就用它，再改几个字就行
                  </div>
                  <div className="mt-1.5 space-y-1.5">
                    {suggestions.map((s) => (
                      <button
                        key={s.fromEvidenceId ?? s.label}
                        type="button"
                        onClick={() => setText(s.draft ?? s.label)}
                        className="block w-full rounded-lg border border-emerald-200 bg-white px-2.5 py-2 text-left text-[12px] leading-relaxed text-slate-700 transition-colors hover:border-emerald-400 hover:bg-emerald-50"
                      >
                        <span className="block">{s.label}</span>
                        {s.fromEvidenceTitle ? (
                          <span className="mt-0.5 block text-[10px] text-emerald-700">来自：{s.fromEvidenceTitle}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1.5 text-[10px] leading-relaxed text-emerald-800">
                    这些是从你原来写的经历里摘出来的原句，系统没有替你编造任何内容 —— 采纳后记得改成现在的事实。
                  </div>
                </div>
              ) : null}

              <div className="mt-4">
                {current.question.kind === 'choice' ? (
                  <div className="space-y-1.5">
                    {(current.question.options ?? []).map((option, index) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setChoiceIndex(index)}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-[13px] transition-colors',
                          choiceIndex === index ? 'border-indigo-300 bg-indigo-50 text-indigo-800' : 'border-slate-200 hover:bg-slate-50',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                            choiceIndex === index ? 'border-indigo-500 bg-indigo-500' : 'border-slate-300',
                          )}
                        >
                          {choiceIndex === index ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
                        </span>
                        {option}
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    {/*
                      v0.4：预置选项。这是本轮「降低负担」的核心 ——
                      点一下就算答完这道题，不需要打字，也不需要回忆和组织语言。

                      为什么放在档案候选之后而不是替代它：
                      两者的可信度不同。档案候选是你自己写过的原句（可核实），
                      预置选项是系统的常见情形（不可核实），界面上必须分开呈现、
                      不同颜色、不同的说明文字 —— 不能让用户分不清哪个是自己的经历。
                    */}
                    {quickChoices.length > 0 ? (
                      <div className="space-y-1.5">
                        <div className="text-[11px] font-medium text-slate-700">
                          {suggestions.length > 0 ? '都不像？下面这些是常见情形，点一个也算答完' : '选一个最接近的就行 —— 不需要写'}
                        </div>
                        {quickChoices.map((choice) => {
                          // isEscape（兜底项）点下去要跳输入框重写；
                          // 普通 needsDetail 项只是「选完补一句」，点击时先把该项写进 text 再聚焦。
                          // 两者行为不同，不能都用 needsDetail 判断。
                          const escape = choice.isEscape === true;
                          const picked = !escape && pickedChoice === choice.label;
                          return (
                            <button
                              key={choice.label}
                              type="button"
                              onClick={() => {
                                if (escape) {
                                  // 兜底项：不写入任何预置内容，直接跳输入框
                                  setPickedChoice(null);
                                  setText('');
                                  setNeedsDetail(true);
                                  setTimeout(() => areaRef.current?.focus(), 30);
                                  return;
                                }
                                setNeedsDetail(choice.needsDetail === true);
                                setPickedChoice(choice.label);
                                if (choice.needsDetail === true) {
                                  setText(`${choice.label}。`);
                                  setTimeout(() => areaRef.current?.focus(), 30);
                                } else {
                                  setText('');
                                }
                              }}
                              className={cn(
                                'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left text-[12.5px] leading-relaxed transition-colors',
                                picked
                                  ? 'border-indigo-400 bg-indigo-50 text-indigo-900'
                                  : escape
                                    ? 'border-dashed border-slate-300 bg-white text-slate-500 hover:border-slate-400'
                                    : 'border-slate-200 bg-white text-slate-700 hover:border-indigo-200 hover:bg-indigo-50/50',
                              )}
                            >
                              <span
                                className={cn(
                                  'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                                  picked ? 'border-indigo-500 bg-indigo-500' : 'border-slate-300',
                                )}
                              >
                                {picked ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
                              </span>
                              <span className="flex-1">
                                {choice.label}
                                {escape ? <span className="ml-1 text-[10px] text-slate-400">（选这个可以自己写）</span> : null}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    {/* 选了需要补细节的选项，或点了「都不像」时，输入框才变成必填 */}
                    <div className={cn(quickChoices.length > 0 && !needsDetail && 'mt-3')}>
                      <TextArea
                        ref={areaRef}
                        rows={quickChoices.length > 0 ? 3 : 4}
                        value={text}
                        onChange={(e) => {
                          setText(e.target.value);
                          if (e.target.value.trim()) setPickedChoice(null);
                        }}
                        placeholder={
                          suggestions.length > 0
                            ? '也可以点上面的候选，或者自己写 —— 写清「什么时候、什么事、你做了什么」就够。'
                            : quickChoices.length > 0
                              ? '可以先在上面点一个；如果都不像，就在这里写。'
                              : '不用写成长文。写清「什么时候、什么事、你做了什么」这一句就够。'
                        }
                        className={cn(needsDetail && 'border-amber-300 ring-1 ring-amber-200')}
                      />
                    </div>

                    {pickedChoice ? (
                      <div className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                        已选：{pickedChoice}。点「下一题」继续 —— 也可以在上面改。
                      </div>
                    ) : null}
                    {needsDetail ? (
                      <div className="mt-1.5 text-[10px] leading-relaxed text-amber-700">
                        这道题需要你自己写一句才能继续（上面这些都不准确时，选它就是最诚实的答案）。
                      </div>
                    ) : null}
                  </>
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  disabled={
                    current.question.kind === 'choice'
                      ? choiceIndex === null
                      : needsDetail || !pickedChoice
                        ? !text.trim()
                        : !pickedChoice && !text.trim()
                  }
                  onClick={() => {
                    // v0.4：选了预置选项就直接提交那条陈述，用户一个��不用打
                    const finalText = pickedChoice ? text.trim() ? `${pickedChoice}。${text.trim()}` : pickedChoice : text;
                    answerAssess(current.question.id, current.question.kind === 'choice' ? { choiceIndex: choiceIndex ?? 0 } : { text: finalText });
                    setText('');
                    setChoiceIndex(null);
                    setPickedChoice(null);
                    setNeedsDetail(false);
                  }}
                >
                  下一题
                </Button>
                {/* v0.3：两个跳过语义必须分开。
                    「没做过」= 明确否认，系统会把等级封顶在「了解概念」，
                    免得别处的场景词把你误判成「实际用过」；
                    「想不起来」只是这题没答上，不影响等级。
                    原实现只有一个按钮，点错了没法补救。 */}
                <Button
                  variant="ghost"
                  onClick={() => {
                    // v0.3：把输入框里已写的内容一起带上去。
                    // 用户常写「没用过，我压根没接触」再点跳过 —— 那是明确的否认信号，
                    // 丢了它会让系统按场景词把等级判高。
                    answerAssess(current.question.id, { skipped: true, skipReason: 'not_done', text });
                    setText('');
                    setChoiceIndex(null);
                    setPickedChoice(null);
                    setNeedsDetail(false);
                  }}
                >
                  这项我没做过
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    answerAssess(current.question.id, { skipped: true, skipReason: 'cant_recall', text });
                    setText('');
                    setChoiceIndex(null);
                    setPickedChoice(null);
                    setNeedsDetail(false);
                  }}
                >
                  想不起来
                </Button>
              </div>
              <div className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
                两个跳过不一样：「没做过」会被记为明确否认，等级最高只到「了解概念」，
                这样能避免系统按场景词误判成「实际用过」；「想不起来」不会影响判断。
              </div>
            </div>
          </Card>
        ) : (
          <Card>
            <div className="px-5 py-5 text-center">
              <div className="text-[13px] font-medium text-slate-700">所有问题都答完了</div>
              <p className="mt-1 text-xs text-slate-500">
                系统会按你的回答算出掌握程度，并把其中具体的部分转成一条证据补充进能力库。
              </p>
              <div className="mt-4">
                <Button variant="primary" size="lg" loading={busy === 'assess'} onClick={() => void finishAssess()}>
                  生成问诊结论
                </Button>
              </div>
            </div>
          </Card>
        )}

        {answeredList.length > 0 ? (
          <Card>
            <CardHeader title="已回答" subtitle="答得不对可以重问一次，后一次结论会覆盖前一次" />
            <div className="space-y-2 px-5 py-4">
              {answeredList.map(({ q, a }) => (
                <div key={q.id} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Badge tone="muted">{ASSESS_LAYER_LABEL[q.layer as AssessLayer]}</Badge>
                    <span className="text-[11px] text-slate-500">{q.prompt}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-700">
                    {a?.skipped
                      ? a.skipReason === 'not_done'
                        ? '（明确表示没做过）'
                        : '（想不起来 / 跳过）'
                      : q.kind === 'choice'
                        ? a?.choiceIndex !== undefined
                          ? q.options?.[a.choiceIndex]
                          : '（未选）'
                        : a?.text || '（空）'}
                  </p>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    );
  }

  // ---------------- 起始页：选择要问的技能 ----------------
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-semibold text-slate-800">能力问诊</h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">
            简历里写「熟悉 X」时，系统并不知道这是「看过文章」还是「独立交付过」。
            答几个具体问题，就能把掌握程度说清楚，并把真正具体的部分变成一条证据补充进能力库。
          </p>
        </div>
        <Button size="sm" variant="primary" onClick={() => setPickerOpen(true)}>
          自选技能问诊
        </Button>
      </header>

      {/* v0.3：把「为什么要问这些」摆在最前面。
          用户对固定套路的反感，一部分来自「不知道它到底要问什么」，
          所以这里先讲清楚：题目会按你这项能力的类型来定。 */}
      <Card className="border-indigo-100 bg-indigo-50/40">
        <div className="px-5 py-4">
          <div className="text-[13px] font-medium text-indigo-900">这次会怎么问你</div>
          <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-indigo-900">
            <li>· 题目按能力类型分开：沟通、协作、抗压这类能力<strong>不会</strong>问你「属于了解还是熟悉」，直接问最近发生过什么</li>
            <li>· 技术能力会问到你自己的分水岭：默认用法和你实际用法的差别、踩过的坑、效果怎么衡量</li>
            <li>· 会优先从你档案里已经写过的经历抽成候选，你点一下就能答，不用凭空回忆</li>
            <li>· 每题都可以跳过；「没做过」和「想不起来」是两回事，不会混在一起判</li>
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="text-[12px] font-medium text-indigo-900">
              <span className="font-medium">问诊证据的强度封顶为「中」。</span>
              它是你的自述，没有外部可核对物。想升级成「强」证据，需要补上链接或量化结果。
            </span>
          </div>
        </div>
        <div className="border-t border-indigo-100 px-5 py-3">
          <Toggle
            checked={compact}
            onChange={setCompact}
            label="精简模式"
            hint="只问最关键的 2 题（具体场景 + 结果）"
          />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div>
          <SectionTitle
            title="建议先问这些"
            description={job ? `按「${job.jobTitle}」的要求排序：岗位要、但能力库里没有对应证据的排在前面` : '没有关联岗位，按能力库里的待证明项排序'}
          />
          {pending.length === 0 ? (
            <Card>
              <EmptyState
                compact
                title="暂无可推荐的问诊项"
                description="分析一个岗位之后再回来，这里会列出「岗位要求但你没有证据」的能力。"
                action={
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => navigate('job')}>
                      去分析岗位
                    </Button>
                    <Button size="sm" onClick={() => setPickerOpen(true)}>
                      自选技能
                    </Button>
                  </div>
                }
              />
            </Card>
          ) : (
            <div className="space-y-2">
              {pending.map((item) => (
                <Card key={item.skillName}>
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium text-slate-800">{item.skillName}</span>
                        <Badge tone={item.importance === 'high' ? 'danger' : item.importance === 'medium' ? 'warning' : 'muted'}>
                          重要度 {item.importance === 'high' ? '高' : item.importance === 'medium' ? '中' : '低'}
                        </Badge>
                        {assessedNames.has(item.skillName) ? <Badge tone="accent">已问过</Badge> : null}
                        {item.requirementCount > 0 ? <Badge tone="muted">被 {item.requirementCount} 条要求提到</Badge> : null}
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{item.reason}</p>
                    </div>
<Button size="sm" variant="primary" loading={busy === 'assess'} onClick={() => void startAssess(item.skillName, compact)}>
                开始问诊
              </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="已问诊过的技能" subtitle={`${(profile.assessments ?? []).length} 项`} />
            <div className="space-y-2 px-5 py-4">
              {(profile.assessments ?? []).length === 0 ? (
                <p className="text-[12px] text-slate-500">还没有问诊记录。</p>
              ) : (
                (profile.assessments ?? []).slice(0, 10).map((a) => (
                  <div key={a.id} className="flex items-center gap-2">
                    <span className={cn('rounded border px-1.5 py-0.5 text-[10px]', LEVEL_TONE[a.level])}>
                      {SKILL_LEVEL_LABEL[a.level]}
                    </span>
                    <span className="flex-1 truncate text-[12px] text-slate-700">{a.skillName}</span>
                    {a.producedEvidenceIds.length > 0 ? <Badge tone="success">+证据</Badge> : <Badge tone="muted">无证据</Badge>}
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="问诊会问什么" subtitle="按能力类型分成四套走法，不是所有能力都问同一批问题" />
            <div className="space-y-2 px-5 py-4 text-[11px] leading-relaxed text-slate-600">
              <div className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="font-medium text-slate-700">技术能力（Python、Redis、React…）</div>
                <div>熟练度自检 → 最近一次用在哪 → 踩过什么坑 / 做过什么非默认调整 → 结果与可核对载体 → 你还不确定的部分</div>
              </div>
              <div className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="font-medium text-slate-700">行为能力（沟通、协作、抗压…）</div>
                <div>
                  <span className="text-emerald-700">不问熟练度</span> → 最近三个月哪件事需要它、当时什么情况 →
                  最难的一步与对方反应 → 结果与反馈 → 你最没底的场合
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="font-medium text-slate-700">资质能力（证书、学历…）</div>
                <div>怎么拿到的、时间与形式 → 有没有编号或可查入口 → 哪些是真用过、哪些只是考过</div>
              </div>
              <div className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="font-medium text-slate-700">领域知识（行业、业务…）</div>
                <div>在什么场景接触、是什么角色 → 有哪些「看着一样其实不一样」的区别 → 产出有没有被用过 → 还不确定什么</div>
              </div>
            </div>
          </Card>

          {upcoming.length > 0 ? (
            <ComingSoonPanel
              reason="面试相关的训练属于后续版本。当前版本先把「能力问诊」这条链路做实 —— 它也是后面模拟面试的题目来源。"
              items={upcoming.map((c) => ({ id: c.id, label: c.label, description: c.description, docRef: c.docRef, since: c.since }))}
            />
          ) : null}
        </div>
      </div>

      <Modal
        open={pickerOpen}
        title="自选技能问诊"
        subtitle="除了推荐列表，你也可以直接指定想确认的能力"
        onClose={() => setPickerOpen(false)}
        footer={<Button variant="ghost" onClick={() => setPickerOpen(false)}>关闭</Button>}
      >
        <div className="space-y-3">
          <Field label="从能力库里选">
            <div className="flex flex-wrap gap-1.5">
              {profile.skills.slice(0, 60).map((skill) => (
                <button
                  key={skill.id}
                  onClick={() => {
                    setPickerOpen(false);
                    void startAssess(skill.name, compact);
                  }}
                  className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
                >
                  {skill.name}
                </button>
              ))}
            </div>
          </Field>
          <Field label="或者直接输入技能名" hint="不在词典里的能力也可以问，只是题模板会用通用版本">
            <div className="flex gap-2">
              <TextInput value={manualSkill} onChange={(e) => setManualSkill(e.target.value)} placeholder="例如：向量数据库调优" />
              <Button
                variant="primary"
                disabled={!manualSkill.trim()}
                onClick={() => {
                  setPickerOpen(false);
                  void startAssess(manualSkill.trim(), compact);
                  setManualSkill('');
                }}
              >
                开始
              </Button>
            </div>
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {SKILL_LEVEL_ORDER.map((level) => (
              <span key={level} className={cn('rounded border px-2 py-0.5 text-[10px]', LEVEL_TONE[level])}>
                {SKILL_LEVEL_LABEL[level]}
              </span>
            ))}
          </div>
          <Stat label="问诊后会自动完成的事" value="写结论 + 补证据" hint="并重新归一化技能与证据的关联" />
        </div>
      </Modal>
    </div>
  );
}
