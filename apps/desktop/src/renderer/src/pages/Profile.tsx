import { useMemo, useState } from 'react';
import {
  EVIDENCE_KIND_LABEL,
  EVIDENCE_ORIGIN_LABEL,
  PII_LABEL,
  SELF_LEVELS,
  SKILL_KIND_LABEL,
  SKILL_KIND_ORDER,
  SKILL_LEVEL_LABEL,
  formatDate,
  maskValue,
  resolveCapabilityLevel,
  resolveSkill,
  type CandidateEvidence,
  type CandidateProfile,
  type EducationItem,
  type EvidenceKind,
  type ProjectItem,
  type SelfLevel,
  type SkillItem,
  type SkillLevel,
  type WorkExperience,
} from '@aijob/core';
import {
  Badge,
  Banner,
  Button,
  Callout,
  Card,
  CardHeader,
  Chip,
  Collapsible,
  EmptyState,
  Field,
  JsonBlock,
  KindBadge,
  Modal,
  SectionTitle,
  Stat,
  StrengthBadge,
  TextArea,
  TextInput,
  cn,
} from '../components/ui';
import { OnboardingPanel } from '../components/Onboarding';
import { LevelBadge, LevelLegend } from '../components/LevelLegend';
import { useApp } from '../state/store';

/**
 * 取某项技能的问诊结论（v0.4）。
 *
 * 为什么不直接取最后一条：
 * 问诊结论可能因为改名而对不上（用户把「React.js」改成「React」）。
 * 这里按名称精确匹配，匹配不上就当作「没问过」——
 * 宁可少算一级，也不要拿一条对不上的结论去抬高层级。
 */
function assessmentOf(profile: CandidateProfile, skillName: string): SkillLevel | null {
  const hit = (profile.assessments ?? []).find((a) => a.skillName === skillName);
  return hit?.level ?? null;
}

type Tab = 'skills' | 'evidence' | 'assess' | 'projects' | 'experiences' | 'education' | 'proven' | 'privacy';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'skills', label: '技能' },
  { id: 'evidence', label: '证据' },
  { id: 'assess', label: '问诊结论' },
  { id: 'projects', label: '项目' },
  { id: 'experiences', label: '工作/实习' },
  { id: 'education', label: '教育' },
  { id: 'proven', label: '待证明 / 待学习' },
  { id: 'privacy', label: '隐私记录' },
];

const EVIDENCE_KINDS: EvidenceKind[] = [
  'project', 'work', 'education', 'certificate', 'competition', 'open_source', 'metric', 'self_claim', 'other',
];

const STRENGTHS = ['strong', 'medium', 'weak', 'none'] as const;

const emptyEvidence = (): CandidateEvidence => ({
  id: '',
  kind: 'project',
  title: '',
  content: '',
  skills: [],
  metrics: [],
  links: [],
  timeRange: '',
  strength: 'medium',
  strengthReason: '手动录入，强度由系统按内容规则重算',
  origin: 'manual',
  sourceRef: { kind: 'user', locator: '用户手动录入', excerpt: '' },
  editedByUser: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/**
 * 我的能力档案（文档第五节 / 第十四节）。
 *
 * 这一页的核心立场：AI 不是最终数据拥有者。
 * 解析结果全部可改、可删、可补 —— 技能、证据、项目、经历都能直接编辑，
 * 还提供结构化 JSON 的原始视图，避免 AI 出错后用户只能被动接受。
 */
export function ProfilePage() {
  const snapshot = useApp((s) => s.snapshot);
  const updateProfile = useApp((s) => s.updateProfile);
  const deleteProfile = useApp((s) => s.deleteProfile);
  const reparseProfile = useApp((s) => s.reparseProfile);
  const exportJson = useApp((s) => s.exportJson);
  const busy = useApp((s) => s.busy);
  const lastMergeReport = useApp((s) => s.lastMergeReport);
  const dismissMergeReport = useApp((s) => s.dismissMergeReport);
  const navigate = useApp((s) => s.navigate);

  const profile = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0];
  const [tab, setTab] = useState<Tab>('skills');
  const [evidenceDraft, setEvidenceDraft] = useState<CandidateEvidence | null>(null);
  const [entryDraft, setEntryDraft] = useState<{ kind: 'project' | 'experience' | 'education'; value: unknown } | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');
  /** v0.3：批量粘贴导入技能的输入区 */
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  /** v0.3：批量删除模式下被勾选的技能名 */
  const [pickedSkills, setPickedSkills] = useState<string[]>([]);

  /**
   * 批量粘贴 → 技能列表。
   *
   * 用户反馈「能力档案如果可以按照个人实际情况来进行增删就更好了」。
   * 单条添加确实存在，但真实场景是「我有十几项技能要补」，
   * 一条条加要点二十几次 —— 所以这里支持一次性粘贴。
   *
   * 归一化走 resolveSkill：用户写「React.js」会并到「React」，
   * 否则档案里会同时出现两条同一个技能，匹配时按去重键合并，界面上却看着像两项。
   */
  const importSkills = (raw: string) => {
    const lines = raw
      .split(/[\n、,，;；|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    const existing = new Set(profile?.skills.map((s) => s.name) ?? []);
    const added: SkillItem[] = [];
    const merged: SkillItem[] = [];

    for (const line of lines) {
      const def = resolveSkill(line);
      const name = def?.name ?? line;
      if (existing.has(name)) {
        // 已经存在的：补一次别名，让后续文本里的不同写法也能命中
        const target = profile!.skills.find((s) => s.name === name)!;
        const aliases = Array.from(new Set([...target.aliases, ...(def?.aliases ?? []), line !== name ? line : ''].filter(Boolean)));
        if (aliases.length > target.aliases.length) {
          merged.push({ ...target, aliases });
        }
        continue;
      }
      existing.add(name);
      added.push({
        id: `skl_manual_${Date.now().toString(36)}_${added.length}`,
        name,
        aliases: def?.aliases ?? [],
        category: def?.kind ?? 'domain',
        selfLevel: '未声明',
        evidenceIds: [],
        derivedStrength: 'none',
      });
    }

    if (!profile) return;
    const skills = [
      ...profile.skills.map((s) => merged.find((m) => m.id === s.id) ?? s),
      ...added,
    ];
    void updateProfile({ ...profile, skills });
    setBulkText('');
    setBulkOpen(false);
    setImportReport(
      added.length > 0
        ? `已添加 ${added.length} 项技能${merged.length > 0 ? `，并为 ${merged.length} 项补了别名` : ''}`
        : merged.length > 0
          ? `已为 ${merged.length} 项已有技能补上别名（没有重复添加）`
          : '这些技能档案里已经有了，没有重复添加',
    );
  };

  const [importReport, setImportReport] = useState('');

  const removePickedSkills = () => {
    if (!profile || pickedSkills.length === 0) return;
    const names = new Set(pickedSkills);
    const removedEvidence = profile.evidence.filter((e) => e.skills.some((s) => names.has(s)));
    const ambiguous = removedEvidence.filter((e) => e.skills.some((s) => !names.has(s)));
    const message =
      `将删除 ${pickedSkills.length} 项技能。` +
      (removedEvidence.length > 0
        ? `有 ${removedEvidence.length} 条相关证据会被一起删除。`
        : '没有关联证据会被删除。') +
      (ambiguous.length > 0 ? `（另有 ${ambiguous.length} 条证据还关联了其他技能，会保留）` : '');
    if (!window.confirm(message)) return;
    const skills = profile.skills.filter((s) => !names.has(s.name));
    const evidence = profile.evidence.filter((e) => !e.skills.some((s) => names.has(s)));
    void updateProfile({ ...profile, skills, evidence });
    setPickedSkills([]);
  };

  const groupedSkills = useMemo(() => {
    if (!profile) return [];
    const map = new Map<string, SkillItem[]>();
    for (const skill of profile.skills) {
      const kind = resolveSkill(skill.name)?.kind ?? 'domain';
      const list = map.get(kind) ?? [];
      list.push(skill);
      map.set(kind, list);
    }
    return SKILL_KIND_ORDER.filter((k) => map.has(k)).map((k) => ({ kind: k, skills: map.get(k) as SkillItem[] }));
  }, [profile]);

  if (!profile) {
    return (
      <div className="space-y-4">
        <SectionTitle title="我的能力档案" description="还没有档案，先建立一份" />
        <OnboardingPanel />
      </div>
    );
  }

  const patch = (next: Partial<CandidateProfile>) => {
    void updateProfile({ ...profile, ...next });
  };

  const saveEvidence = () => {
    if (!evidenceDraft) return;
    const draft = {
      ...evidenceDraft,
      updatedAt: new Date().toISOString(),
      editedByUser: true,
      strengthReason: evidenceDraft.strengthReason || '用户手动设定',
    };
    const exists = profile.evidence.some((e) => e.id === draft.id);
    const evidence = exists
      ? profile.evidence.map((e) => (e.id === draft.id ? draft : e))
      : [...profile.evidence, { ...draft, id: draft.id || `evd_manual_${Date.now().toString(36)}` }];
    patch({ evidence });
    setEvidenceDraft(null);
  };

  const noEvidenceSkills = profile.skills.filter((s) => s.evidenceIds.length === 0);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-semibold text-slate-800">我的能力档案</h1>
          <p className="mt-1 text-xs text-slate-500">
            更新于 {formatDate(profile.updatedAt)} · 解析方式：{profile.parsedBy === 'ai' ? '模型 + 本地规则校准' : '本地规则引擎'} · 共{' '}
            {snapshot.profiles.length} 份档案
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={busy === 'resume'} onClick={() => void reparseProfile()}>
            用留存文本重新解析
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setJsonText(JSON.stringify(profile, null, 2));
              setJsonError('');
              setJsonOpen(true);
            }}
          >
            编辑结构化 JSON
          </Button>
          <Button size="sm" onClick={() => void exportJson()}>
            导出 JSON
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              if (confirm('删除这份档案？报告里引用的证据会同时失效。')) void deleteProfile(profile.id);
            }}
          >
            删除档案
          </Button>
        </div>
      </header>

      {lastMergeReport ? (
        <Banner
          tone="success"
          title="本次导入已并入现有能力库（跨岗位保留）"
          action={
            <button onClick={dismissMergeReport} className="text-[11px] text-emerald-700 underline-offset-2 hover:underline">
              知道了
            </button>
          }
        >          <div>{lastMergeReport.summary}。</div>
          <div className="mt-1 space-y-0.5">
            {lastMergeReport.addedSkills.length > 0 ? <div>新增技能：{lastMergeReport.addedSkills.slice(0, 10).join('、')}</div> : null}
            {lastMergeReport.upgradedSkills.length > 0 ? <div>等级提升：{lastMergeReport.upgradedSkills.slice(0, 10).join('、')}</div> : null}
            {lastMergeReport.upgradedEvidence.length > 0 ? <div>证据更新：{lastMergeReport.upgradedEvidence.slice(0, 6).join('、')}</div> : null}
            {lastMergeReport.qaEvidenceKept > 0 ? <div>问诊补充的证据保留了 {lastMergeReport.qaEvidenceKept} 条</div> : null}
          </div>
        </Banner>
      ) : null}

      <Card>
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-[1.4fr_repeat(3,minmax(0,1fr))]">
          <div>
            <div className="text-[11px] text-slate-500">档案名称（只存在本机）</div>
            <TextInput
              className="mt-1"
              value={profile.basics.displayName}
              onChange={(e) => patch({ basics: { ...profile.basics, displayName: e.target.value } })}
            />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <div className="text-[11px] text-slate-500">学历</div>
                <TextInput
                  className="mt-1"
                  placeholder="本科 / 硕士 …"
                  value={profile.basics.educationLevel ?? ''}
                  onChange={(e) => patch({ basics: { ...profile.basics, educationLevel: e.target.value } })}
                />
              </div>
              <div>
                <div className="text-[11px] text-slate-500">所在城市</div>
                <TextInput
                  className="mt-1"
                  placeholder="杭州"
                  value={profile.basics.location ?? ''}
                  onChange={(e) => patch({ basics: { ...profile.basics, location: e.target.value } })}
                />
              </div>
            </div>
            <div className="mt-2">
              <div className="text-[11px] text-slate-500">目标岗位（逗号分隔）</div>
              <TextInput
                className="mt-1"
                value={profile.basics.targetRoles.join('、')}
                onChange={(e) =>
                  patch({ basics: { ...profile.basics, targetRoles: e.target.value.split(/[、,，/]/).map((t) => t.trim()).filter(Boolean) } })
                }
              />
            </div>
          </div>
          <Stat label="技能" value={profile.skills.length} />
          <Stat label="证据" value={profile.evidence.length} hint={`${profile.evidence.filter((e) => e.strength === 'strong').length} 强`} />
          <Stat label="有待证明" value={profile.unprovenSkills.length} hint={profile.learningSkills.length > 0 ? `${profile.learningSkills.length} 项待学习` : undefined} />
        </div>
        {profile.summary ? (
          <div className="border-t border-slate-100 px-5 py-3 text-[12px] leading-relaxed text-slate-600">{profile.summary}</div>
        ) : null}
        {/* v0.4：等级对照放在统计卡下方。
            这一页是「自评 / 证据强度 / 问诊等级」三套刻度同时出现的地方，
            用户困惑最集中 —— 对照表必须在这里一键可展开。 */}
        <div className="border-t border-slate-100 px-5 py-2.5">
          <LevelLegend />
        </div>
      </Card>

      <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {TABS.map((t) => {
          const count =
            t.id === 'skills' ? profile.skills.length
              : t.id === 'evidence' ? profile.evidence.length
                : t.id === 'assess' ? (profile.assessments ?? []).length
                  : t.id === 'projects' ? profile.projects.length
                    : t.id === 'experiences' ? profile.experiences.length
                      : t.id === 'education' ? profile.education.length
                        : t.id === 'proven' ? profile.unprovenSkills.length + profile.learningSkills.length
                          : profile.privacy.findings.length;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12px] transition-colors',
                tab === t.id ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {t.label}
              <span className={cn('ml-1.5 text-[10px]', tab === t.id ? 'text-slate-300' : 'text-slate-400')}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* ---------------- 技能 ---------------- */}
      {tab === 'skills' ? (
        <Card>
          <CardHeader
            title="技能清单"
            subtitle="自我声明等级只作参考；能不能算「已具备」取决于有没有对应证据"
            action={
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    patch({
                      skills: [
                        ...profile.skills,
                        {
                          id: `skl_manual_${Date.now().toString(36)}`,
                          name: '新技能',
                          aliases: [],
                          category: 'domain',
                          selfLevel: '未声明',
                          evidenceIds: [],
                          derivedStrength: 'none',
                        },
                      ],
                    })
                  }
                >
                  添加一项
                </Button>
                {/* v0.3：批量粘贴。真实场景是「我还有十几项要补」，一条条加要点二十几次 */}
                <Button size="sm" onClick={() => setBulkOpen(true)}>
                  批量粘贴
                </Button>
                <Button
                  size="sm"
                  variant={pickedSkills.length > 0 ? 'danger' : 'ghost'}
                  disabled={pickedSkills.length === 0}
                  onClick={removePickedSkills}
                >
                  删除选中（{pickedSkills.length}）
                </Button>
              </div>
            }
          />
          {importReport ? (
            <div className="px-5 pt-3">
              <Callout>{importReport}</Callout>
            </div>
          ) : null}
          {pickedSkills.length > 0 ? (
            <div className="px-5 pt-3">
              <Callout>
                已选中 {pickedSkills.length} 项（{pickedSkills.slice(0, 5).join('、')}
                {pickedSkills.length > 5 ? '…' : ''}）。点上方「删除选中」执行；再点一次条目可取消选择。
              </Callout>
            </div>
          ) : null}
          <div className="px-5 py-4">
            {profile.skills.length === 0 ? (
              <EmptyState compact title="没有识别到技能" description="可以手动添加，或者回到上一步用更完整的简历文本重新解析。" />
            ) : (
              <div className="space-y-4">
                {groupedSkills.map((group) => (
                  <div key={group.kind}>
                    <div className="mb-1.5 text-[11px] font-medium text-slate-500">{SKILL_KIND_LABEL[group.kind]}</div>
                    <div className="space-y-1.5">
                      {group.skills.map((skill) => {
                        const idx = profile.skills.findIndex((s) => s.id === skill.id);
                        const update = (next: Partial<SkillItem>) => {
                          const skills = profile.skills.slice();
                          skills[idx] = { ...skill, ...next };
                          patch({ skills });
                        };
                        // v0.4：算出这项技能的最终能力层级。
                        // 原来这里并排显示「声明：熟练」与「证据：中」，
                        // 用户无从判断两者什么关系 —— 现在合成一个层级标签。
                        const levelInfo = resolveCapabilityLevel(skill.derivedStrength, assessmentOf(profile, skill.name));
                        return (
                          <div key={skill.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-2">
                            {/* v0.3：批量选择。手机上一次只能点一项，
                                十几项技能删起来就是十几趟来回 —— 这是「不好用」的直接来源 */}
                            <label className="flex items-center gap-1 text-[11px] text-slate-500">
                              <input
                                type="checkbox"
                                checked={pickedSkills.includes(skill.name)}
                                onChange={() =>
                                  setPickedSkills((prev) =>
                                    prev.includes(skill.name)
                                      ? prev.filter((n) => n !== skill.name)
                                      : [...prev, skill.name],
                                  )
                                }
                              />
                              选
                            </label>
                            <TextInput
                              className="w-[190px]"
                              value={skill.name}
                              onChange={(e) => update({ name: e.target.value })}
                            />
                            <select
                              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-[12px]"
                              value={skill.selfLevel}
                              onChange={(e) => update({ selfLevel: e.target.value as SelfLevel })}
                            >
                              {SELF_LEVELS.map((l) => (
                                <option key={l} value={l}>
                                  声明：{l}
                                </option>
                              ))}
                            </select>
                            {/*
                              v0.4：原来这里是 <StrengthBadge>（一个「弱/中/强」标签）。
                              现在换成能力层级标签 —— 因为这一行里同时出现
                              「声明：熟练」「证据：中」两个刻度时，用户没法比较它们，
                              而它们本来就不是一回事（一个是自述，一个能不能被外部核对）。

                              层级标签的取法见 resolveCapabilityLevel()：
                              取「证据能支撑到哪」与「问诊说达到哪」的较低者 ——
                              宁可低估，也不要让用户以为已经够了。
                            */}
                            <LevelBadge level={levelInfo.level} />
                            <Badge tone={skill.evidenceIds.length > 0 ? 'accent' : 'muted'}>
                              {skill.evidenceIds.length} 条证据
                            </Badge>
                            <span
                              className="text-[10px] leading-relaxed text-slate-400"
                              title={levelInfo.why}
                            >
                              {levelInfo.why}
                            </span>
                            <span className="flex-1" />
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => patch({ skills: profile.skills.filter((s) => s.id !== skill.id) })}
                            >
                              删除
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {noEvidenceSkills.length > 0 ? (
              <div className="mt-4">
                <Callout>
                  有 {noEvidenceSkills.length} 项技能没有关联任何证据（{noEvidenceSkills.slice(0, 6).map((s) => s.name).join('、')}
                  ）。匹配时这些会被判为「缺少证据」，而不是「满足」——这是刻意的。
                </Callout>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* ---------------- 证据 ---------------- */}
      {tab === 'evidence' ? (
        <div className="space-y-4">
          <Banner tone="info" title="证据是整个系统的核心概念">
            系统区分「自我声明」和「可核对的产出」。项目、工作、开源、竞赛、证书类证据才可能支撑「满足」；
            「自我声明」永远只会得到「缺少证据」。你可以修正强度，但请保持诚实 —— 虚构的经历会在面试追问里露出来。
          </Banner>
          <SectionTitle
            title={`证据清单（${profile.evidence.length}）`}
            right={
              <Button size="sm" variant="primary" onClick={() => setEvidenceDraft(emptyEvidence())}>
                补一条证据
              </Button>
            }
          />
          {profile.evidence.length === 0 ? (
            <Card>
              <EmptyState compact title="还没有任何证据" description="没有证据时，几乎所有要求都会判为「缺少证据」，建议先补项目类证据。" />
            </Card>
          ) : (
            <div className="space-y-2.5">
              {profile.evidence.map((evidence) => (
                <Card key={evidence.id}>
                  <div className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-slate-800">{evidence.title}</span>
                      <KindBadge kind={evidence.kind} />
                      <StrengthBadge strength={evidence.strength} />
                      <Badge tone={evidence.origin === 'qa' ? 'info' : 'muted'}>{EVIDENCE_ORIGIN_LABEL[evidence.origin]}</Badge>
                      {evidence.fromJobTitle ? <Badge tone="muted">来自 {evidence.fromJobTitle}</Badge> : null}
                      {evidence.editedByUser ? <Badge tone="muted">已人工确认</Badge> : null}
                      <span className="flex-1" />
                      <Button size="sm" variant="ghost" onClick={() => setEvidenceDraft({ ...evidence })}>
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => patch({ evidence: profile.evidence.filter((e) => e.id !== evidence.id) })}
                      >
                        删除
                      </Button>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">{evidence.content}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {evidence.timeRange ? <Badge tone="neutral">{evidence.timeRange}</Badge> : null}
                      {evidence.metrics.map((m) => (
                        <Chip key={m}>{m}</Chip>
                      ))}
                      {evidence.links.map((l) => (
                        <Badge key={l} tone="info">
                          {l.length > 40 ? `${l.slice(0, 40)}…` : l}
                        </Badge>
                      ))}
                      {evidence.skills.map((s) => (
                        <Chip key={s}>{s}</Chip>
                      ))}
                    </div>
                    <Collapsible title="强度判定依据与来源" right={<Badge tone="muted">{evidence.sourceRef.locator}</Badge>}>
                      <div className="space-y-1.5 text-[11px] leading-relaxed text-slate-600">
                        <div>强度理由：{evidence.strengthReason}</div>
                        <div>来源片段：{evidence.sourceRef.excerpt || '（无）'}</div>
                      </div>
                    </Collapsible>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* ---------------- 问诊结论（v0.2） ---------------- */}
      {tab === 'assess' ? (
        <div className="space-y-3">
          <Banner tone="info" title="问诊结论属于你本人，不属于某个岗位">
            换岗位不会丢掉这些结论 —— 它们是「你掌握到什么程度」的记录。
            问诊补充的证据强度封顶为「中」（自述来源），补上链接或数字后系统会自动重算。
          </Banner>
          {(profile.assessments ?? []).length === 0 ? (
            <Card>
              <EmptyState
                compact
                title="还没有问诊记录"
                description="简历里「熟悉 X」这类描述，系统无法判断是看过还是做过。用问诊把它问清楚，顺便补上一条证据。"
                action={
                  <Button size="sm" variant="primary" onClick={() => navigate('interview')}>
                    去做能力问诊
                  </Button>
                }
              />
            </Card>
          ) : (
            (profile.assessments ?? []).map((item) => (
              <Card key={item.id}>
                <div className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-slate-800">{item.skillName}</span>
                    <Badge tone="accent">{SKILL_LEVEL_LABEL[item.level]}</Badge>
                    <Badge tone="muted">置信度 {item.confidence === 'high' ? '高' : item.confidence === 'medium' ? '中' : '低'}</Badge>
                    {item.jobTitle ? <Badge tone="muted">问于 {item.jobTitle}</Badge> : null}
                    <span className="flex-1" />
                    <span className="text-[10px] text-slate-400">{formatDate(item.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-slate-600">{item.summary}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone="muted">场景 {item.signals.specificity}/3</Badge>
                    <Badge tone="muted">深度 {item.signals.depth}/3</Badge>
                    <Badge tone="muted">产出 {item.signals.output}/3</Badge>
                    <Badge tone="muted">边界 {item.signals.selfAwareness}/1</Badge>
                    {item.producedEvidenceIds.length > 0 ? <Badge tone="success">补充了证据</Badge> : <Badge tone="muted">未产出证据</Badge>}
                  </div>
                  <div className="mt-2 space-y-2">
                    <Collapsible title="下一步与缺口" defaultOpen={item.gaps.length > 0}>
                      <div className="space-y-1.5">
                        <div className="text-[11px] leading-relaxed text-indigo-900">{item.recommendedAction}</div>
                        {item.gaps.map((g, i) => (
                          <div key={`gap-${i}`} className="text-[11px] leading-relaxed text-rose-700">
                            · {g}
                          </div>
                        ))}
                        {item.uncertainties.length > 0 ? (
                          <div className="text-[11px] leading-relaxed text-slate-500">
                            自认还不确定：{item.uncertainties.join('、')}
                          </div>
                        ) : null}
                      </div>
                    </Collapsible>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      ) : null}

      {/* ---------------- 项目 ---------------- */}
      {tab === 'projects' ? (
        <div className="space-y-3">
          <SectionTitle
            title={`项目经历（${profile.projects.length}）`}
            description="项目是最容易转化成强证据的经历类型"
            right={
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  setEntryDraft({
                    kind: 'project',
                    value: { id: '', name: '', role: '', timeRange: '', description: '', highlights: [], skills: [], links: [] } as ProjectItem,
                  })
                }
              >
                添加项目
              </Button>
            }
          />
          {profile.projects.length === 0 ? (
            <Card>
              <EmptyState compact title="没有识别到项目经历" description="如果有做过的项目，手动补进来效果最好——这是最容易变成强证据的部分。" />
            </Card>
          ) : (
            profile.projects.map((project) => (
              <Card key={project.id}>
                <div className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-slate-800">{project.name}</span>
                    {project.role ? <Badge tone="neutral">{project.role}</Badge> : null}
                    {project.timeRange ? <Badge tone="muted">{project.timeRange}</Badge> : null}
                    <span className="flex-1" />
                    <Button size="sm" variant="ghost" onClick={() => setEntryDraft({ kind: 'project', value: { ...project } })}>
                      编辑
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => patch({ projects: profile.projects.filter((p) => p.id !== project.id) })}>
                      删除
                    </Button>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">{project.description}</p>
                  {project.highlights.length > 0 ? (
                    <ul className="mt-2 space-y-0.5">
                      {project.highlights.map((h, i) => (
                        <li key={`${project.id}-h${i}`} className="text-[11px] leading-relaxed text-slate-500">
                          · {h}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {project.skills.map((s) => (
                      <Chip key={s}>{s}</Chip>
                    ))}
                    {project.links.map((l) => (
                      <Badge key={l} tone="info">
                        {l}
                      </Badge>
                    ))}
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      ) : null}

      {/* ---------------- 工作/实习 ---------------- */}
      {tab === 'experiences' ? (
        <div className="space-y-3">
          <SectionTitle
            title={`工作 / 实习经历（${profile.experiences.length}）`}
            description="年度经验与「是否有真实工作产出」的判断会读这里"
            right={
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  setEntryDraft({
                    kind: 'experience',
                    value: { id: '', organization: '', role: '', timeRange: '', description: '', achievements: [], skills: [] } as WorkExperience,
                  })
                }
              >
                添加经历
              </Button>
            }
          />
          {profile.experiences.length === 0 ? (
            <Card>
              <EmptyState compact title="没有识别到工作经历" description="如果是应届生或只有实习，把实习写进来同样有效。" />
            </Card>
          ) : (
            profile.experiences.map((exp) => (
              <Card key={exp.id}>
                <div className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-slate-800">{exp.organization}</span>
                    {exp.role ? <Badge tone="accent">{exp.role}</Badge> : null}
                    {exp.timeRange ? <Badge tone="muted">{exp.timeRange}</Badge> : null}
                    <span className="flex-1" />
                    <Button size="sm" variant="ghost" onClick={() => setEntryDraft({ kind: 'experience', value: { ...exp } })}>
                      编辑
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => patch({ experiences: profile.experiences.filter((e) => e.id !== exp.id) })}>
                      删除
                    </Button>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">{exp.description}</p>
                  {exp.achievements.length > 0 ? (
                    <ul className="mt-2 space-y-0.5">
                      {exp.achievements.map((a, i) => (
                        <li key={`${exp.id}-a${i}`} className="text-[11px] leading-relaxed text-slate-500">
                          · {a}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </Card>
            ))
          )}
        </div>
      ) : null}

      {/* ---------------- 教育 ---------------- */}
      {tab === 'education' ? (
        <div className="space-y-3">
          <SectionTitle
            title={`教育背景（${profile.education.length}）`}
            description="学历是硬门槛，填错会导致整条要求判错"
            right={
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  setEntryDraft({ kind: 'education', value: { id: '', school: '', major: '', degree: '', timeRange: '', highlights: [] } as EducationItem })
                }
              >
                添加教育经历
              </Button>
            }
          />
          {profile.education.length === 0 ? (
            <Card>
              <Banner tone="warning">
                档案里没有学历信息，学历类要求会一律判为「缺少证据」。请在右上角「学历」字段或这里补齐。
              </Banner>
            </Card>
          ) : (
            profile.education.map((edu) => (
              <Card key={edu.id}>
                <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                  <span className="text-[13px] font-medium text-slate-800">{edu.school}</span>
                  {edu.degree ? <Badge tone="accent">{edu.degree}</Badge> : null}
                  {edu.major ? <Badge tone="neutral">{edu.major}</Badge> : null}
                  {edu.timeRange ? <Badge tone="muted">{edu.timeRange}</Badge> : null}
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setEntryDraft({ kind: 'education', value: { ...edu } })}>
                    编辑
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => patch({ education: profile.education.filter((e) => e.id !== edu.id) })}>
                    删除
                  </Button>
                </div>
              </Card>
            ))
          )}
        </div>
      ) : null}

      {/* ---------------- 待证明 / 待学习 ---------------- */}
      {tab === 'proven' ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader title={`已具备（有证据）`} subtitle={`${profile.provenSkills.length} 项`} />
            <div className="flex flex-wrap gap-1.5 px-4 py-3">
              {profile.provenSkills.length === 0 ? (
                <span className="text-[12px] text-slate-400">暂时没有能被证据支撑的能力</span>
              ) : (
                profile.provenSkills.map((s) => (
                  <Badge key={s} tone="success">
                    {s}
                  </Badge>
                ))
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="待证明" subtitle="声明了但找不到证据——投入产出比最高的补强对象" />
            <div className="flex flex-wrap gap-1.5 px-4 py-3">
              {profile.unprovenSkills.length === 0 ? (
                <span className="text-[12px] text-slate-400">没有待证明的能力</span>
              ) : (
                profile.unprovenSkills.map((s) => (
                  <Badge key={s} tone="warning">
                    {s}
                  </Badge>
                ))
              )}
            </div>
            {profile.unprovenSkills.length > 0 ? (
              <div className="border-t border-slate-100 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
                做法：从已有经历里找出用过它的那一段，按「场景 → 我做了什么 → 用什么方法 → 结果」写一句话补进证据。
                不需要新增能力，通常半小时能补完 3–5 项。
                <div className="mt-2">
                  <Button size="sm" variant="primary" onClick={() => navigate('interview')}>
                    用能力问诊补（会自动写成证据）
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>
          <Card>
            <CardHeader title="待学习" subtitle="自评为「了解」且没有证据的能力" />
            <div className="flex flex-wrap gap-1.5 px-4 py-3">
              {profile.learningSkills.length === 0 ? (
                <span className="text-[12px] text-slate-400">没有标记为待学习的能力</span>
              ) : (
                profile.learningSkills.map((s) => (
                  <Badge key={s} tone="info">
                    {s}
                  </Badge>
                ))
              )}
            </div>
            <div className="border-t border-slate-100 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
              建议挑其中 1–2 项做一个小而完整的产出，而不是同时铺开 5 项。
            </div>
          </Card>
        </div>
      ) : null}

      {/* ---------------- 隐私记录 ---------------- */}
      {tab === 'privacy' ? (
        <Card>
          <CardHeader
            title="隐私处理记录"
            subtitle={`扫描于 ${formatDate(profile.privacy.scannedAt)} · 原文 ${profile.privacy.originalLength} 字 → 脱敏后 ${profile.privacy.redactedLength} 字`}
          />
          <div className="px-5 py-4">
            {profile.privacy.findings.length === 0 ? (
              <EmptyState compact title="没有识别到敏感信息" description="如果简历里确实有电话邮箱，建议检查一下格式是否标准。" />
            ) : (
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-[12px]">
                  <thead className="bg-slate-50 text-left text-[11px] text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">类型</th>
                      <th className="px-3 py-2 font-medium">原文</th>
                      <th className="px-3 py-2 font-medium">替换为</th>
                      <th className="px-3 py-2 font-medium">位置</th>
                      <th className="px-3 py-2 font-medium">识别规则</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {profile.privacy.findings.map((f) => (
                      <tr key={f.id}>
                        <td className="px-3 py-2">{f.label}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{f.masked}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-indigo-600">{f.placeholder}</td>
                        <td className="px-3 py-2 text-slate-500">第 {f.line} 行</td>
                        <td className="px-3 py-2 text-slate-500">{f.rule}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-3 space-y-2">
              <Callout>
                原始值只在这一页本地展示，不写入任何 Prompt。真正进入分析链路的是下面这段脱敏文本 ——
                它同时也是「查看 AI 实际发送内容」里能看到的东西。
              </Callout>
              <Collapsible title="查看脱敏后的文本（进入分析链路的内容）">
                <JsonBlock value={profile.rawText} maxHeight={280} />
              </Collapsible>
              <Collapsible title="PII 类型对照">
                <div className="text-[11px] leading-relaxed text-slate-600">
                  {Object.entries(PII_LABEL).map(([k, v]) => (
                    <div key={k}>
                      {v} → {k}
                    </div>
                  ))}
                  <div className="mt-1 text-slate-400">示例：{maskValue('phone', '13800138000')}</div>
                </div>
              </Collapsible>
            </div>
          </div>
        </Card>
      ) : null}

      {/* ---------------- 证据编辑弹窗 ---------------- */}
      {evidenceDraft ? (
        <Modal
          open
          title={profile.evidence.some((e) => e.id === evidenceDraft.id) ? '编辑证据' : '新增证据'}
          subtitle="证据的强度会按内容自动重算；手动设为「已人工确认」后系统不再覆盖你的设定。"
          onClose={() => setEvidenceDraft(null)}
          width="max-w-3xl"
          footer={
            <>
              <Button variant="ghost" onClick={() => setEvidenceDraft(null)}>
                取消
              </Button>
              <Button variant="primary" onClick={saveEvidence}>
                保存
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="标题">
                <TextInput value={evidenceDraft.title} onChange={(e) => setEvidenceDraft({ ...evidenceDraft, title: e.target.value })} />
              </Field>
              <Field label="类型" hint="project / work / open_source / competition / certificate 才可能支撑「满足」">
                <select
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[13px]"
                  value={evidenceDraft.kind}
                  onChange={(e) => setEvidenceDraft({ ...evidenceDraft, kind: e.target.value as EvidenceKind })}
                >
                  {EVIDENCE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {EVIDENCE_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="内容" hint="写清做了什么 + 用什么方法 + 结果。有数字就写数字。">
              <TextArea rows={4} value={evidenceDraft.content} onChange={(e) => setEvidenceDraft({ ...evidenceDraft, content: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="时间范围">
                <TextInput value={evidenceDraft.timeRange ?? ''} onChange={(e) => setEvidenceDraft({ ...evidenceDraft, timeRange: e.target.value })} />
              </Field>
              <Field label="强度（手动设定）">
                <select
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[13px]"
                  value={evidenceDraft.strength}
                  onChange={(e) => setEvidenceDraft({ ...evidenceDraft, strength: e.target.value as CandidateEvidence['strength'] })}
                >
                  {STRENGTHS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="量化结果（每行一条）">
              <TextArea
                rows={3}
                value={evidenceDraft.metrics.join('\n')}
                onChange={(e) => setEvidenceDraft({ ...evidenceDraft, metrics: e.target.value.split('\n').map((t) => t.trim()).filter(Boolean) })}
              />
            </Field>
            <Field label="支撑的能力（每行一条）">
              <TextArea
                rows={3}
                value={evidenceDraft.skills.join('\n')}
                onChange={(e) => setEvidenceDraft({ ...evidenceDraft, skills: e.target.value.split('\n').map((t) => t.trim()).filter(Boolean) })}
              />
            </Field>
            <Field label="可验证链接（每行一条）">
              <TextArea
                rows={2}
                value={evidenceDraft.links.join('\n')}
                onChange={(e) => setEvidenceDraft({ ...evidenceDraft, links: e.target.value.split('\n').map((t) => t.trim()).filter(Boolean) })}
              />
            </Field>
            <label className="flex items-center gap-2 text-[12px] text-slate-600">
              <input
                type="checkbox"
                checked={evidenceDraft.editedByUser}
                onChange={(e) => setEvidenceDraft({ ...evidenceDraft, editedByUser: e.target.checked })}
              />
              标记为「已人工确认」（系统不再自动覆盖这条证据的强度）
            </label>
          </div>
        </Modal>
      ) : null}

      {/* ---------------- 项目/经历/教育编辑弹窗 ---------------- */}
      {entryDraft ? (
        <EntryEditor
          kind={entryDraft.kind}
          value={entryDraft.value as Record<string, unknown>}
          onClose={() => setEntryDraft(null)}
          onSave={(value) => {
            if (entryDraft.kind === 'project') {
              const item = value as unknown as ProjectItem;
              const exists = profile.projects.some((p) => p.id === item.id);
              const next = item.id || `prj_manual_${Date.now().toString(36)}`;
              patch({
                projects: exists
                  ? profile.projects.map((p) => (p.id === item.id ? { ...item, id: next } : p))
                  : [...profile.projects, { ...item, id: next }],
              });
            } else if (entryDraft.kind === 'experience') {
              const item = value as unknown as WorkExperience;
              const exists = profile.experiences.some((p) => p.id === item.id);
              const next = item.id || `exp_manual_${Date.now().toString(36)}`;
              patch({
                experiences: exists
                  ? profile.experiences.map((p) => (p.id === item.id ? { ...item, id: next } : p))
                  : [...profile.experiences, { ...item, id: next }],
              });
            } else {
              const item = value as unknown as EducationItem;
              const exists = profile.education.some((p) => p.id === item.id);
              const next = item.id || `edu_manual_${Date.now().toString(36)}`;
              patch({
                education: exists
                  ? profile.education.map((p) => (p.id === item.id ? { ...item, id: next } : p))
                  : [...profile.education, { ...item, id: next }],
              });
            }
            setEntryDraft(null);
          }}
        />
      ) : null}

      {/* ---------------- v0.3：批量粘贴技能 ---------------- */}
      <Modal
        open={bulkOpen}
        title="批量添加技能"
        subtitle="从简历里复制技能名，用顿号 / 逗号 / 换行分隔，一次全部导入"
        onClose={() => setBulkOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkOpen(false)}>
              取消
            </Button>
            <Button variant="primary" disabled={!bulkText.trim()} onClick={() => importSkills(bulkText)}>
              导入
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field
            label="技能名列表"
            hint="例：Python、React.js、RAG 检索增强、沟通表达"
          >
            <TextArea
              rows={7}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={'Python、React.js\nRAG 检索增强\n沟通表达'}
            />
          </Field>
          <Callout>
            能对上技能词典的会自动归一化（React.js → React），已存在的不会重复添加，
            只会补上别名。没有收录的会按原名保留，仍可用于问诊和匹配。
          </Callout>
        </div>
      </Modal>

      {/* ---------------- 结构化 JSON 编辑 ---------------- */}
      <Modal
        open={jsonOpen}
        title="编辑结构化 JSON"
        subtitle="这是内部契约的原文（文档第十五节）。保存后会重新归一化技能关联与证据强度。"
        onClose={() => setJsonOpen(false)}
        width="max-w-4xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setJsonOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                try {
                  const parsed = JSON.parse(jsonText) as CandidateProfile;
                  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.skills)) {
                    setJsonError('结构不对：至少需要包含 skills / evidence 数组');
                    return;
                  }
                  void updateProfile({ ...profile, ...parsed, id: profile.id });
                  setJsonOpen(false);
                } catch (err) {
                  setJsonError(`JSON 解析失败：${(err as Error).message}`);
                }
              }}
            >
              保存并重新归一化
            </Button>
          </>
        }
      >
        {jsonError ? (
          <div className="mb-3">
            <Banner tone="danger">{jsonError}</Banner>
          </div>
        ) : null}
        <TextArea rows={24} className="font-mono text-[11px]" value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 通用条目编辑器
// ---------------------------------------------------------------------------

const ENTRY_FIELDS = {
  project: [
    { key: 'name', label: '项目名称' },
    { key: 'role', label: '担任角色' },
    { key: 'timeRange', label: '时间范围' },
  ],
  experience: [
    { key: 'organization', label: '公司/组织' },
    { key: 'role', label: '职位' },
    { key: 'timeRange', label: '时间范围' },
  ],
  education: [
    { key: 'school', label: '学校' },
    { key: 'major', label: '专业' },
    { key: 'degree', label: '学历' },
    { key: 'timeRange', label: '时间范围' },
  ],
} as const;

const ENTRY_LIST_FIELDS = {
  project: [
    { key: 'highlights', label: '要点（每行一条）' },
    { key: 'skills', label: '涉及能力（每行一条）' },
    { key: 'links', label: '链接（每行一条）' },
  ],
  experience: [
    { key: 'achievements', label: '成果要点（每行一条）' },
    { key: 'skills', label: '涉及能力（每行一条）' },
  ],
  education: [{ key: 'highlights', label: '补充说明（每行一条）' }],
} as const;

function EntryEditor({
  kind,
  value,
  onClose,
  onSave,
}: {
  kind: 'project' | 'experience' | 'education';
  value: Record<string, unknown>;
  onClose: () => void;
  onSave: (value: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...value });
  const title = kind === 'project' ? '项目经历' : kind === 'experience' ? '工作/实习经历' : '教育背景';

  return (
    <Modal
      open
      title={`编辑${title}`}
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={() => onSave(draft)}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {ENTRY_FIELDS[kind].map((field) => (
            <Field key={field.key} label={field.label}>
              <TextInput
                value={String(draft[field.key] ?? '')}
                onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        <Field label="描述">
          <TextArea rows={4} value={String(draft.description ?? '')} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </Field>
        {ENTRY_LIST_FIELDS[kind].map((field) => {
          const list = Array.isArray(draft[field.key]) ? (draft[field.key] as string[]) : [];
          return (
            <Field key={field.key} label={field.label}>
              <TextArea
                rows={3}
                value={list.join('\n')}
                onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value.split('\n').map((t) => t.trim()).filter(Boolean) })}
              />
            </Field>
          );
        })}
      </div>
    </Modal>
  );
}
