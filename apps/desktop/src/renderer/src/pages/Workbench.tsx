import { useState } from 'react';
import {
  APP_NAME,
  ASSESSMENT_LABEL,
  formatDateTime,
  plannedCapabilities,
  profileStats,
  RELEASE_LABEL,
} from '@aijob/core';
import { Badge, Banner, Button, Card, CardHeader, EmptyState, Field, Modal, SectionTitle, Stat, TextArea } from '../components/ui';
import { OnboardingPanel } from '../components/Onboarding';
import { useApp } from '../state/store';

/**
 * 工作台首页（文档第十三节）。
 *
 * 刻意不做成招聘网站的样子：这里是「个人工作台」，
 * 只有两件事可做 —— 维护自己的能力档案，或者分析一个新岗位。
 */
export function Workbench() {
  const snapshot = useApp((s) => s.snapshot);
  const navigate = useApp((s) => s.navigate);
  const analyzeJobText = useApp((s) => s.analyzeJobText);
  const ws = useApp((s) => s.ws);
  const busy = useApp((s) => s.busy);

  const [jdOpen, setJdOpen] = useState(false);
  const [jdText, setJdText] = useState('');
  const [jdTitle, setJdTitle] = useState('');

  const profile = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0];
  const stats = profileStats(profile ?? null);
  const recent = snapshot.reports.slice(0, 6);
  const activeJob = snapshot.jobs.find((j) => j.id === snapshot.ui.activeJobId) ?? snapshot.jobs[0];
  const trainingPlan = activeJob ? snapshot.trainingPlans.find((p) => p.jobId === activeJob.id) : undefined;
  const upcoming = plannedCapabilities().filter((c) => c.since === 'v0.3' || c.since === 'v0.4').slice(0, 4);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[20px] font-semibold text-slate-800">{APP_NAME}</h1>
        <p className="mt-1 text-[13px] text-slate-500">你的求职能力分析与训练伙伴</p>
      </header>

      {!profile ? <OnboardingPanel /> : null}

      {profile ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="我的能力档案"
              subtitle={profile.summary || '候选人的结构化档案'}
              action={
                <Button size="sm" onClick={() => navigate('profile')}>
                  查看我的档案
                </Button>
              }
            />
            <div className="px-5 py-4">
              <div className="grid grid-cols-3 gap-2.5">
                <Stat label="技能" value={stats.skillCount} hint={`${stats.provenCount} 项有证据`} />
                <Stat label="项目" value={stats.projectCount} hint={`${stats.experienceCount} 段经历`} />
                <Stat label="证据" value={stats.evidenceCount} hint={`${stats.strongEvidenceCount} 条强证据`} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {profile.basics.targetRoles.slice(0, 3).map((role) => (
                  <Badge key={role} tone="accent">
                    {role}
                  </Badge>
                ))}
                {profile.basics.educationLevel ? <Badge tone="muted">{profile.basics.educationLevel}</Badge> : null}
                {stats.unprovenCount > 0 ? <Badge tone="warning">{stats.unprovenCount} 项待证明</Badge> : null}
              </div>
              {stats.unprovenCount > 0 ? (
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                  已有 {stats.evidenceCount} 条证据，其中 {stats.unprovenCount} 项能力目前只有自我声明。
                  这些能力在匹配时会判为「缺少证据」——把对应的项目写清楚就能补上。
                </p>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="分析一个岗位"
              subtitle="粘贴 JD 文字，或手动输入对方的要求"
              action={
                <Button size="sm" variant="primary" loading={busy === 'job'} onClick={() => setJdOpen(true)}>
                  开始分析
                </Button>
              }
            />
            <div className="px-5 py-4">
              <p className="text-[12px] leading-relaxed text-slate-500">
                岗位会被拆成一条条可独立判断的要求：必须条件、技术要求、职责、经验、学历、工具、软技能、加分项，以及原文没写但客观需要的隐含要求。
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {snapshot.jobs.slice(0, 4).map((job) => (
                  <Badge key={job.id} tone="neutral">
                    {job.jobTitle} · {job.items.length} 条
                  </Badge>
                ))}
              </div>
              <div className="mt-3 space-y-1.5 text-[11px] text-slate-500">
                <div className="flex items-center gap-2">
                  <Badge tone="muted">v0.3</Badge>
                  岗位截图 OCR —— 上传招聘截图自动提取要求
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="muted">v0.3</Badge>
                  最低通过简历画像 —— 反向推导岗位的真实门槛
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="能力问诊"
              subtitle="用几个具体问题，把「熟悉 X」问成可以证实的结论"
              action={
                <Button size="sm" onClick={() => navigate('interview')}>
                  去问诊
                </Button>
              }
            />
            <div className="px-5 py-4">
              <div className="grid grid-cols-2 gap-2.5">
                <Stat label="已问诊技能" value={stats.assessedCount} hint={`档案里共 ${stats.skillCount} 项技能`} />
                <Stat label="问诊补充的证据" value={stats.qaEvidenceCount} hint="自述来源，强度封顶为「中」" />
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                问诊会问五层：自评 → 具体场景 → 使用深度 → 产出结果 → 认知边界。
                说到的具体部分会自动写成一条证据补进能力库；光说概念不会生成证据。
              </p>
              {stats.unprovenCount > 0 ? (
                <p className="mt-2 text-[11px] leading-relaxed text-amber-700">
                  还有 {stats.unprovenCount} 项能力目前只有自我声明 —— 这正是问诊最该先处理的部分。
                </p>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="薄弱项训练"
              subtitle="按这次没答上的要求出题，练完回报告看结论有没有变"
              action={
                <Button size="sm" onClick={() => navigate('training')}>
                  去训练
                </Button>
              }
            />
            <div className="px-5 py-4">
              {activeJob ? (
                <>
                  <div className="grid grid-cols-2 gap-2.5">
                    <Stat
                      label="当前岗位"
                      value={trainingPlan ? `${trainingPlan.items.length} 题` : '未生成'}
                      hint={activeJob.jobTitle}
                    />
                    <Stat
                      label="自评均分"
                      value={trainingPlan?.stats.averageScore ?? '—'}
                      hint={trainingPlan ? `满分 3 · 已作答 ${trainingPlan.stats.answered + trainingPlan.stats.reviewed} 题` : '生成计划后开始记录'}
                    />
                  </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                    题目只来自匹配分析里真实没答上的要求：能力缺口出概念题、缺少证据出「讲清楚」题、证据不足出对比取舍题。
                  </p>
                </>
              ) : (
                <p className="text-[12px] leading-relaxed text-slate-500">
                  先分析一个岗位，训练题会按那个岗位的匹配结果生成 —— 不会练与岗位无关的东西。
                </p>
              )}
            </div>
          </Card>
        </div>
      ) : null}

      <div>
        <SectionTitle
          title="最近分析"
          description={`共 ${snapshot.reports.length} 份报告，全部保存在本机`}
          right={snapshot.reports.length > 0 ? <Button size="sm" variant="ghost" onClick={() => navigate('match')}>查看最新报告</Button> : undefined}
        />
        <Card>
          {recent.length === 0 ? (
            <EmptyState
              compact
              title="还没有分析记录"
              description="建立档案之后分析一个岗位，这里会出现历史报告。"
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {recent.map((report) => (
                <li key={report.id} className="flex items-center gap-4 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-slate-800">{report.job.title}</span>
                      {report.job.company ? <span className="text-[11px] text-slate-400">{report.job.company}</span> : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                      <span>匹配分析 · {formatDateTime(report.createdAt)}</span>
                      <span className="text-slate-300">|</span>
                      <span>要求 {report.summary.total} 条</span>
                      <span className="text-emerald-600">满足 {report.summary.matched}</span>
                      <span className="text-sky-600">缺证据 {report.summary.lackingEvidence}</span>
                      <span className="text-rose-600">缺口 {report.summary.gap}</span>
                      <span className="text-slate-300">|</span>
                      <span>{report.usedModel ? `已用模型（${report.engine}）` : '本地规则引擎'}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="sm" onClick={() => navigate('match')}>
                      查看
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void ws?.deleteReport(report.id);
                      }}
                    >
                      删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div>
        <SectionTitle title="接下来会有的能力" description="按产品文档的版本节奏开放；当前版本的能力开关可在设置页查看" />
        <div className="grid gap-2 sm:grid-cols-2">
          {upcoming.map((cap) => (
            <div key={cap.id} className="rounded-lg border border-dashed border-slate-300 bg-white px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <Badge tone="muted">{RELEASE_LABEL[cap.since]}</Badge>
                <span className="text-[12px] font-medium text-slate-700">{cap.label}</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{cap.description}</p>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <Banner tone="neutral">
            当前版本的判定结论只有五种：{ASSESSMENT_LABEL.matched} / {ASSESSMENT_LABEL.partial} / {ASSESSMENT_LABEL.lacking_evidence} /{' '}
            {ASSESSMENT_LABEL.gap} / {ASSESSMENT_LABEL.unknown} —— 不提供 0–100 的匹配分数。
          </Banner>
        </div>
      </div>

      <Modal
        open={jdOpen}
        title="粘贴岗位描述"
        subtitle="整段粘进来即可，包括职责和任职要求；也可以只写对方口头说的几条。"
        onClose={() => setJdOpen(false)}
        width="max-w-3xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setJdOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!jdText.trim()}
              loading={busy === 'job'}
              onClick={() => {
                setJdOpen(false);
                void analyzeJobText(jdText, { titleHint: jdTitle || undefined });
                setJdText('');
                setJdTitle('');
              }}
            >
              开始分析
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="岗位名称（可选，留空则从原文推断）">
            <TextArea rows={1} value={jdTitle} onChange={(e) => setJdTitle(e.target.value)} />
          </Field>
          <Field label="岗位描述">
            <TextArea rows={16} value={jdText} onChange={(e) => setJdText(e.target.value)} placeholder={'岗位职责\n1. …\n\n任职要求\n1. …'} />
          </Field>
          <Banner tone="info">分析完成后会自动用当前档案跑一次匹配 —— 这是文档里那条「3 分钟走完整个流程」的路径。</Banner>
        </div>
      </Modal>
    </div>
  );
}
