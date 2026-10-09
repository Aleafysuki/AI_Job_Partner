import { CURRENT_RELEASE, RELEASE_LABEL, plannedCapabilities } from '@aijob/core';
import { Badge, Banner, Callout, Card, CardHeader, ComingSoonPanel, SectionTitle } from '../components/ui';
import { useApp } from '../state/store';

/**
 * AI 模拟面试（文档第九节 / 第十节 / 第二十节）—— v0.3 能力。
 *
 * 这里刻意不放"假的输入框"。当前版本的选择是：把还没做的部分
 * 明确标成未开放，而不是给一个会失败的入口。
 * 同时把已经预留的数据结构（CandidateProfile.interviewHistory）说明清楚，
 * 让后续版本的接入点可见。
 */
export function InterviewPage() {
  const snapshot = useApp((s) => s.snapshot);
  const interviewCaps = plannedCapabilities().filter((c) => c.id.startsWith('interview.'));
  const profile = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0];

  const flow = [
    { step: '面试题来源', detail: '岗位要求 + 你的简历 + 你主动输入的真题 + 你指定的知识领域 + 上次面试的错误' },
    { step: '追问梯度', detail: '基础 → 进阶 → 项目 → 追问 → 压力追问，逐层加压而不是随机出题' },
    { step: '回答分析', detail: '知识正确性 / 表达完整性 / 逻辑结构 / 是否答到点上 / 是否过度展开 / 是否存在无法证明的经历' },
    { step: '薄弱点沉淀', detail: '把暴露出的问题写回能力档案，成为下一次匹配时「待证明」的依据' },
  ];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[19px] font-semibold text-slate-800">面试训练</h1>
        <p className="mt-1 text-xs text-slate-500">面试题生成 · 模拟面试 · 回答分析 · 薄弱点训练</p>
      </header>

      <ComingSoonPanel
        reason="面试训练属于 v0.3 范围（产品文档第二十节）。当前版本先保证「简历 → 岗位 → 匹配 → 报告」这条主链路成立，面试系统建立在这条链路的结论之上。"
        items={interviewCaps.map((c) => ({ id: c.id, label: c.label, description: c.description, docRef: c.docRef, since: c.since }))}
      />

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader title="规划中的训练流程" subtitle="来源：产品文档第九、十节" />
          <ol className="space-y-3 px-5 py-4">
            {flow.map((item, i) => (
              <li key={item.step} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600">
                  {i + 1}
                </span>
                <div>
                  <div className="text-[12px] font-medium text-slate-800">{item.step}</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{item.detail}</div>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="已经为它预留的数据结构" subtitle="解锁版本时不需要改核心模型" />
            <div className="space-y-2 px-5 py-4 text-[11px] leading-relaxed text-slate-600">
              <div className="flex items-start gap-2">
                <Badge tone="accent">CandidateProfile.interviewHistory</Badge>
                <span className="flex-1">面试记录：公司 / 岗位 / 问题 / 回答 / 反馈 / 薄弱点</span>
              </div>
              <div className="flex items-start gap-2">
                <Badge tone="accent">CandidateProfile.learningSkills</Badge>
                <span className="flex-1">待学习能力，面试暴露的缺口会回流到这里</span>
              </div>
              <div className="flex items-start gap-2">
                <Badge tone="accent">AnalysisReport.matches[].action</Badge>
                <span className="flex-1">匹配结论里的「下一步」，会直接变成训练题目的来源</span>
              </div>
              <Callout>
                线索：面试训练的题目来源之一就是「匹配时判为缺少证据的那几条要求」——
                这正是当前版本已经能产出的东西。
              </Callout>
            </div>
          </Card>

          <Card>
            <CardHeader title="当前可以拿到的替代方案" />
            <div className="space-y-2 px-5 py-4 text-[12px] leading-relaxed text-slate-600">
              {profile ? (
                <>
                  <p>
                    你的档案里目前有 {profile.evidence.length} 条证据、{profile.unprovenSkills.length} 项「待证明」能力。
                  </p>
                  <p className="text-slate-500">
                    在报告页展开任意一条结论，可以看到「判定逻辑」——那已经是一套可用的自查清单：
                    按「定义 → 原理 → 示例 → 使用场景」的顺序，把被判为缺少证据的要求讲一遍，就能覆盖大部分基础面试题。
                  </p>
                </>
              ) : (
                <p>建立能力档案并跑一次匹配分析后，这里会给出针对你当前缺口的自查建议。</p>
              )}
              <Banner tone="neutral">
                当前版本：{RELEASE_LABEL[CURRENT_RELEASE]}。面试训练不在此版本的铁律禁用清单内，只是排在 v0.3，
                具体时间取决于主链路是否稳定。
              </Banner>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
