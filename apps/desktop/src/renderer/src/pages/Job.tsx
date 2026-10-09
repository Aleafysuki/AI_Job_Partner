import React, { useMemo, useState } from 'react';
import {
  EVIDENCE_NEEDED_LABEL,
  REQUIREMENT_TYPE_LABEL,
  REQUIREMENT_TYPE_ORDER,
  formatDateTime,
  plannedCapabilities,
  type EvidenceNeeded,
  type JobRequirement,
  type RequirementItem,
  type RequirementType,
  type TriLevel,
} from '@aijob/core';
import {
  OCR_CONFIDENCE_LABEL,
  OCR_CONFIDENCE_WHY,
  OCR_LOW_CONFIDENCE,
  OCR_SCRIPT_LABEL,
  OCR_SCRIPT_WHY,
  OCR_SIZE_WHY,
  assembleOcrText,
  needsManualReview,
  summarizeConfidence,
  type OcrBlock,
  type OcrConfidence,
  type OcrScript,
} from '@aijob/core';
import { ocrRecognize, pickImage } from '../lib/bridge';
import {
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
  Field,
  ImportanceBadge,
  Modal,
  SectionTitle,
  Stat,
  TextArea,
  TextInput,
  cn,
} from '../components/ui';
import { useApp } from '../state/store';

type InputMode = 'paste' | 'manual';

const emptyRequirement = (): RequirementItem => ({
  id: '',
  index: 0,
  content: '',
  original: '',
  type: 'must',
  importance: 'medium',
  hardGate: false,
  keywords: [],
  evidenceNeeded: 'any',
  sourceRef: { kind: 'user', locator: '用户手动添加', excerpt: '' },
  confidence: 'high',
  editedByUser: true,
});

/**
 * 岗位分析（文档第六节）。
 *
 * 三种输入方式：文字 / 图片 / 手动。图片 OCR 属于 v0.2，这里按能力开关显示为 Coming Soon，
 * 而不是"假装能上传然后失败"。
 */
/**
 * 在原文里找到第一处匹配并包上高亮标记。
 *
 * 返回 React 片段而不是 HTML 字符串 —— 原文可能含 `<`、`&` 等字符，
 * 拼字符串再 dangerouslySetInnerHTML 会有注入面。切分成三段纯文本即可。
 */
function highlightFirst(raw: string, needle: string): React.ReactNode {
  const target = (needle ?? '').trim();
  if (!target) return raw;
  const idx = raw.indexOf(target);
  if (idx < 0) return raw;
  return (
    <>
      {raw.slice(0, idx)}
      <mark className="rounded bg-amber-200 px-0.5 text-slate-900">{raw.slice(idx, idx + target.length)}</mark>
      {raw.slice(idx + target.length)}
    </>
  );
}

export function JobPage() {
  const snapshot = useApp((s) => s.snapshot);
  const analyzeJobText = useApp((s) => s.analyzeJobText);
  const updateJob = useApp((s) => s.updateJob);
  const deleteJob = useApp((s) => s.deleteJob);
  const runMatch = useApp((s) => s.runMatch);
  const navigate = useApp((s) => s.navigate);
  const busy = useApp((s) => s.busy);

  const job = snapshot.jobs.find((j) => j.id === snapshot.ui.activeJobId) ?? snapshot.jobs[0];
  const profile = snapshot.profiles.find((p) => p.id === snapshot.ui.activeProfileId) ?? snapshot.profiles[0];

  const [inputOpen, setInputOpen] = useState(false);
  const [mode, setMode] = useState<InputMode>('paste');
  const [text, setText] = useState('');
  const [titleHint, setTitleHint] = useState('');
  const [filter, setFilter] = useState<'all' | RequirementType>('all');
  const [editing, setEditing] = useState<RequirementItem | null>(null);
  /** v0.3：JD 原文面板展开状态 */
  const [rawOpen, setRawOpen] = useState(false);
  /** v0.3：原文里被定位的片段（从某条要求的「在原文中定位」跳进来） */
  const [rawHighlight, setRawHighlight] = useState<string | null>(null);

  /*
   * 截图 OCR（v0.3 job.input_image）
   *
   * `ocrDraft` 存的是**识别结果 + 置信度**，不是最终文本 ——
   * 因为用户需要在看到置信度的前提下决定信不信。
   */
  const [ocrScript, setOcrScript] = useState<OcrScript>('chinese');
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrEngine, setOcrEngine] = useState<'mlkit-ondevice' | 'tesseract-wasm' | null>(null);
  const [ocrDraft, setOcrDraft] = useState<{
    blocks: OcrBlock[];
    lowBlocks: OcrBlock[];
    confidence: OcrConfidence;
  } | null>(null);

  /** 选图 → 本地识别 → 结果填进文本框（不自动提交） */
  const runOcr = async () => {
    setOcrError(null);
    setOcrDraft(null);
    try {
      const picked = await pickImage();
      if (!picked) return; // 用户取消是正常路径
      setOcrBusy(true);
      const res = await ocrRecognize({ path: picked.path, script: ocrScript });
      if (!res.ok) {
        setOcrError(res.reason ?? '识别失败');
        return;
      }
      // 统一到 core 的块结构（两个宿主的字段完全一致，只是引擎不同）
      const blocks: OcrBlock[] = res.blocks.map((b) => ({
        id: b.id,
        text: b.text,
        confidence: b.confidence,
        rect: b.rect,
      }));
      const confidence = summarizeConfidence(blocks);
      const assembled = assembleOcrText(blocks);
      if (assembled.trim().length === 0) {
        setOcrError('没有从这张图里认出任何文字。可能图片太糊，或者内容不是文字截图。');
        return;
      }
      setOcrEngine(res.engine);
      setOcrDraft({
        blocks,
        lowBlocks: blocks.filter((b) => b.confidence < OCR_LOW_CONFIDENCE),
        confidence,
      });
      // 填进文本框而不是直接提交 —— 用户要能看到并改掉错字
      setText((prev) => (prev.trim() ? `${prev.trim()}\n${assembled}` : assembled));
      setMode('paste');
    } catch (e) {
      setOcrError((e as Error).message || '识别失败');
    } finally {
      setOcrBusy(false);
    }
  };

  /**
   * 从某条要求跳到 JD 原文里的对应片段。
   *
   * 为什么必须做这个：拆解之后用户最常见的疑问是「它凭什么把这句话拆成一条硬门槛」。
   * 只看归一化后的 content 看不出来，必须能回到原文那一段。
   */
  const locateInRaw = (item: RequirementItem) => {
    setRawOpen(true);
    setRawHighlight(item.original || item.content);
    requestAnimationFrame(() => {
      document.getElementById('job-raw-text')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };

  const copyRaw = async () => {
    if (!job?.rawText) return;
    try {
      await navigator.clipboard.writeText(job.rawText);
      setCopiedRaw(true);
      setTimeout(() => setCopiedRaw(false), 2000);
    } catch {
      setCopiedRaw(false);
    }
  };

  const [copiedRaw, setCopiedRaw] = useState(false);

  /*
   * v0.5 实装记录：下面这行已经用不上了 ——
   * OCR 从 ComingSoonPanel 变成了上面那块真正的入口。
   * 按项目约定（设计变更不简单删除原代码）保留注释痕迹。
   *
   *   const ocrCapability = plannedCapabilities().filter((c) => c.id === 'job.input_image');
   */
  const ocrCapability = plannedCapabilities().filter((c) => c.id === 'job.input_image');
  void ocrCapability;

  const grouped = useMemo(() => {
    if (!job) return [];
    const items = filter === 'all' ? job.items : job.items.filter((i) => i.type === filter);
    return REQUIREMENT_TYPE_ORDER.filter((t) => items.some((i) => i.type === t)).map((t) => ({
      type: t,
      items: items.filter((i) => i.type === t),
    }));
  }, [job, filter]);

  const submit = () => {
    setInputOpen(false);
    void analyzeJobText(text, { titleHint: titleHint || undefined, source: mode === 'manual' ? 'manual' : 'text' });
    setText('');
    setTitleHint('');
  };

  const patch = (next: Partial<JobRequirement>) => {
    if (job) void updateJob({ ...job, ...next });
  };

  const saveRequirement = () => {
    if (!job || !editing) return;
    const exists = job.items.some((i) => i.id === editing.id);
    const item = { ...editing, id: editing.id || `req_manual_${Date.now().toString(36)}`, editedByUser: true };
    patch({ items: exists ? job.items.map((i) => (i.id === item.id ? item : i)) : [...job.items, item] });
    setEditing(null);
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-semibold text-slate-800">岗位分析</h1>
          <p className="mt-1 text-xs text-slate-500">
            把 JD 拆成一条条可独立判断的要求，每条都保留原文出处 —— 后面所有结论都指向这里
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setMode('paste');
              setInputOpen(true);
            }}
          >
            粘贴新岗位
          </Button>
          {job ? (
            <Button size="sm" onClick={() => void runMatch()} loading={busy === 'match'} disabled={!profile}>
              开始匹配分析
            </Button>
          ) : null}
          {job ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                if (confirm('删除这个岗位以及它对应的分析报告？')) void deleteJob(job.id);
              }}
            >
              删除岗位
            </Button>
          ) : null}
        </div>
      </header>

      {!job ? (
        <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
          <Card>
            <CardHeader title="输入一个岗位" subtitle="支持直接粘贴 JD，也可以只手输对方口头说的几条要求" />
            <div className="px-5 py-4">
              <div className="mb-3 flex gap-1 rounded-lg border border-slate-200 p-1">
                {(
                  [
                    { id: 'paste' as InputMode, label: '粘贴 JD 文本' },
                    { id: 'manual' as InputMode, label: '手动输入几条要求' },
                  ]
                ).map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setMode(m.id)}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-[12px] transition-colors',
                      mode === m.id ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100',
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <Field label="岗位名称（可选）">
                <TextInput value={titleHint} onChange={(e) => setTitleHint(e.target.value)} placeholder="留空则从原文推断" />
              </Field>
              <div className="mt-3">
                <Field
                  label={mode === 'paste' ? '岗位描述' : '对方告诉你的要求'}
                  hint={mode === 'manual' ? '例如：需要 Python、Agent、RAG，最好做过知识库问答' : undefined}
                >
                  <TextArea
                    rows={mode === 'paste' ? 16 : 8}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={mode === 'paste' ? '岗位职责\n1. …\n\n任职要求\n1. …' : '需要 Python、Agent、RAG'}
                  />
                </Field>
              </div>
              <div className="mt-3">
                <Button variant="primary" disabled={!text.trim()} loading={busy === 'job'} onClick={submit}>
                  开始拆解
                </Button>
              </div>
            </div>
          </Card>

          <div className="space-y-4">
            {/*
              截图 OCR（v0.3 job.input_image）
              ==========================
              识别结果**必须经用户确认**才进解析 —— 见 domain/ocr.ts 的文件头：
              识别不准比识别不了更危险，用户很可能根本没意识到那是识别错的。

              这里用「填进上面的文本框 + 展示置信度」的方式，
              而不是直接提交 —— 用户能看到文字并随手改掉错字。
            */}
            <Card>
              <CardHeader
                title="从截图识别"
                subtitle="本地推理，图片不会上传到任何服务器"
              />
              <div className="space-y-3 px-5 py-4">
                <Field label="识别语言" hint={OCR_SCRIPT_WHY[ocrScript]}>
                  <div className="flex gap-1 rounded-lg border border-slate-200 p-1">
                    {(['chinese', 'latin'] as const).map((sc) => (
                      <button
                        key={sc}
                        onClick={() => setOcrScript(sc)}
                        className={cn(
                          'rounded-md px-3 py-1.5 text-[12px] transition-colors',
                          ocrScript === sc ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100',
                        )}
                      >
                        {OCR_SCRIPT_LABEL[sc]}
                      </button>
                    ))}
                  </div>
                </Field>

                <Button variant="secondary" onClick={runOcr} loading={ocrBusy}>
                  选择截图并识别
                </Button>

                <p className="text-[11.5px] leading-relaxed text-slate-500">
                  {OCR_SIZE_WHY}
                </p>

                {ocrError ? (
                  <Banner tone="danger" title="识别失败">
                    {ocrError}
                  </Banner>
                ) : null}

                {ocrDraft ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge tone={ocrDraft.confidence.level === 'high' ? 'success' : ocrDraft.confidence.level === 'medium' ? 'warning' : 'danger'}>
                        {OCR_CONFIDENCE_LABEL[ocrDraft.confidence.level]}
                      </Badge>
                      <span className="text-[11px] text-slate-500">
                        {ocrDraft.blocks.length} 行 · 平均置信度 {ocrDraft.confidence.avg}
                        {ocrDraft.confidence.lowCount > 0 ? ` · ${ocrDraft.confidence.lowCount} 行待核对` : ''}
                      </span>
                      {ocrEngine ? (
                        <span className="text-[11px] text-slate-400">
                          {ocrEngine === 'mlkit-ondevice' ? '本机原生模型' : '本机 WASM 模型'}
                        </span>
                      ) : null}
                    </div>

                    {needsManualReview(ocrDraft.confidence) ? (
                      <Banner tone="warning" title="这份识别不建议直接用">
                        {OCR_CONFIDENCE_WHY.low}
                      </Banner>
                    ) : null}

                    <p className="mb-1.5 text-[11.5px] text-slate-500">
                      识别结果已填进上面的文本框，**请对照截图检查一遍**再点「开始拆解」。
                    </p>

                    {ocrDraft.lowBlocks.length > 0 ? (
                      <Collapsible title={`这几行不太确定（${ocrDraft.lowBlocks.length} 行）`}>
                        <ul className="space-y-1">
                          {ocrDraft.lowBlocks.map((b) => (
                            <li key={b.id} className="text-[12px] text-slate-600">
                              <q>{b.text}</q>
                              <span className="text-[11px] text-slate-400">
                                {' '}
                                置信度 {(b.confidence * 100).toFixed(0)}%
                              </span>
                            </li>
                          ))}
                        </ul>
                      </Collapsible>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Card>
            <Card>
              <CardHeader title="拆解标准" subtitle="每条要求都会被归类并标注来源" />
              <div className="space-y-1.5 px-5 py-4 text-[11px] leading-relaxed text-slate-600">
                {REQUIREMENT_TYPE_ORDER.map((t) => (
                  <div key={t} className="flex gap-2">
                    <Badge tone="muted">{REQUIREMENT_TYPE_LABEL[t]}</Badge>
                    <span className="flex-1">
                      {t === 'must' && '原文明确写「必须 / 要求」的条件'}
                      {t === 'tech' && '具体技术能力，例如熟悉 RAG 检索链路'}
                      {t === 'responsibility' && '日常要做什么，用于判断岗位真实工作内容'}
                      {t === 'experience' && '年限与经历要求，属于硬门槛'}
                      {t === 'education' && '学历与专业要求，属于硬门槛'}
                      {t === 'tool' && '具体软件/平台，例如 Dify、Figma'}
                      {t === 'soft' && '沟通、自驱、抗压等软性要求'}
                      {t === 'implicit' && '原文没写、但由岗位内容推断出的客观需要'}
                      {t === 'bonus' && '优先/加分项，权重较低'}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <>
          <Card>
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-[1.5fr_repeat(3,minmax(0,1fr))]">
              <div>
                <div className="text-[11px] text-slate-500">岗位名称</div>
                <TextInput className="mt-1" value={job.jobTitle} onChange={(e) => patch({ jobTitle: e.target.value })} />
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-[11px] text-slate-500">公司</div>
                    <TextInput className="mt-1" value={job.company} onChange={(e) => patch({ company: e.target.value })} />
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500">来源</div>
                    <div className="mt-1 flex h-[30px] items-center gap-1.5">
                      <Badge tone="neutral">{job.source === 'manual' ? '手动输入' : job.source === 'image' ? '图片 OCR' : '文本粘贴'}</Badge>
                      {job.sourceFileName ? <span className="truncate text-[10px] text-slate-400">{job.sourceFileName}</span> : null}
                    </div>
                  </div>
                </div>
              </div>
              <Stat label="要求条数" value={job.items.length} hint={`高重要度 ${job.items.filter((i) => i.importance === 'high').length}`} />
              <Stat label="硬门槛" value={job.items.filter((i) => i.hardGate).length} hint="无法靠简历改写绕过" />
              <Stat label="分析时间" value={formatDateTime(job.updatedAt).slice(5)} hint={job.parsedBy === 'ai' ? '模型 + 本地校准' : '本地规则引擎'} />
            </div>
            {job.roleSummary ? (
              <div className="border-t border-slate-100 px-5 py-3 text-[12px] leading-relaxed text-slate-600">
                <span className="font-medium text-slate-700">岗位定位：</span>
                {job.roleSummary}
              </div>
            ) : null}
          </Card>

          {job.screenRisks.length > 0 ? (
            <Card>
              <CardHeader title="可能的筛选风险" subtitle="这些是岗位原文里已经暴露出来的门槛信号" />
              <ul className="space-y-1.5 px-5 py-4">
                {job.screenRisks.map((risk, i) => (
                  <li key={`${i}-${risk.slice(0, 10)}`} className="text-[12px] leading-relaxed text-slate-600">
                    · {risk}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {/* v0.3 追加：JD 原文。
              拆解结果一律可回溯到原文 —— 这是「AI 不是最终数据拥有者」的前提：
              用户必须能看到「系统据以判断的原文到底是什么」。 */}
          <Card className={rawOpen ? '' : 'border-dashed'}>
            <CardHeader
              title="JD 原文"
              subtitle={
                job.rawText
                  ? `脱敏后共 ${job.rawText.length} 字 · 所有拆解结论都来自这里`
                  : '这个岗位是手动输入的，没有原文'
              }
              action={
                job.rawText ? (
                  <div className="flex gap-1.5">
                    <Button size="sm" onClick={copyRaw}>
                      {copiedRaw ? '已复制' : '复制原文'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRawOpen((v) => !v)}>
                      {rawOpen ? '收起' : '展开'}
                    </Button>
                  </div>
                ) : null
              }
            />
            {rawOpen && job.rawText ? (
              <div className="px-5 py-4">
                {rawHighlight ? (
                  <div className="mb-2 flex items-center gap-2 text-[11px] text-amber-700">
                    <span>已定位到下方高亮片段 —— 它对应你刚才点的那条要求</span>
                    <Button size="sm" variant="ghost" onClick={() => setRawHighlight(null)}>
                      取消定位
                    </Button>
                  </div>
                ) : null}
                <pre
                  id="job-raw-text"
                  className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[12px] leading-relaxed text-slate-700"
                >
                  {rawHighlight
                    ? highlightFirst(job.rawText, rawHighlight)
                    : job.rawText}
                </pre>
                <div className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  这里显示的是已经过脱敏处理的文本（公司名、人名等已按脱敏规则处理）。
                  原文里的每一段都对应下方的一条或多条要求。
                </div>
              </div>
            ) : null}
          </Card>

          <div>
            <SectionTitle
              title={`岗位要求（${job.items.length}）`}
              description="点任意一条可以修改内容、类型、重要程度与关键词 —— AI 拆错了就应该能改"
              right={
                <Button size="sm" onClick={() => setEditing(emptyRequirement())}>
                  手动添加一条
                </Button>
              }
            />

            <div className="mb-3 flex flex-wrap gap-1.5">
              <button
                onClick={() => setFilter('all')}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[11px] transition-colors',
                  filter === 'all' ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                )}
              >
                全部 {job.items.length}
              </button>
              {REQUIREMENT_TYPE_ORDER.filter((t) => job.items.some((i) => i.type === t)).map((t) => (
                <button
                  key={t}
                  onClick={() => setFilter(t)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-[11px] transition-colors',
                    filter === t ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                  )}
                >
                  {REQUIREMENT_TYPE_LABEL[t]} {job.items.filter((i) => i.type === t).length}
                </button>
              ))}
            </div>

            {grouped.length === 0 ? (
              <Card>
                <EmptyState compact title="没有符合筛选条件的要求" />
              </Card>
            ) : (
              <div className="space-y-4">
                {grouped.map((group) => (
                  <div key={group.type}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="text-[12px] font-medium text-slate-700">{REQUIREMENT_TYPE_LABEL[group.type]}</span>
                      <span className="text-[11px] text-slate-400">{group.items.length} 条</span>
                    </div>
                    <div className="space-y-2">
                      {group.items.map((item) => (
                        <Card key={item.id}>
                          <div className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge tone="muted">#{String(item.index).padStart(2, '0')}</Badge>
                              <ImportanceBadge importance={item.importance} />
                              {item.hardGate ? <Badge tone="danger">硬门槛</Badge> : null}
                              <Badge tone="neutral">需要证据：{EVIDENCE_NEEDED_LABEL[item.evidenceNeeded]}</Badge>
                              <span className="flex-1" />
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => locateInRaw(item)}
                                title="在 JD 原文里高亮这段"
                              >
                                定位原文
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditing({ ...item })}>
                                编辑
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => patch({ items: job.items.filter((i) => i.id !== item.id) })}
                              >
                                删除
                              </Button>
                            </div>
                            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-800">{item.content}</p>
                            {item.keywords.length > 0 ? (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {item.keywords.map((k) => (
                                  <Chip key={k}>{k}</Chip>
                                ))}
                              </div>
                            ) : (
                              <div className="mt-2 text-[11px] text-amber-600">
                                未识别出具体能力关键词，匹配时会偏保守（可能判为「无法判断」），建议手动补关键词。
                              </div>
                            )}
                            <div className="mt-2">
                              <Collapsible title="来源" right={<span className="text-[10px] text-slate-400">{item.sourceRef.locator}</span>}>
                                <div className="text-[11px] leading-relaxed text-slate-600">{item.sourceRef.excerpt || '（无原文片段）'}</div>
                              </Collapsible>
                            </div>
                          </div>
                        </Card>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {!profile ? (
            <Banner tone="warning" title="还没有能力档案">
              岗位已经拆解完成。要得到匹配结论，需要先建立能力档案。
              <div className="mt-2">
                <Button size="sm" variant="primary" onClick={() => navigate('profile')}>
                  去建立档案
                </Button>
              </div>
            </Banner>
          ) : null}
        </>
      )}

      {/* 输入弹窗 */}
      <Modal
        open={inputOpen}
        title={mode === 'paste' ? '粘贴岗位描述' : '手动输入岗位要求'}
        subtitle={mode === 'paste' ? '整段粘贴即可，包含职责与任职要求' : '只知道几条要求也可以，系统会按条拆解'}
        onClose={() => setInputOpen(false)}
        width="max-w-3xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setInputOpen(false)}>
              取消
            </Button>
            <Button variant="primary" disabled={!text.trim()} loading={busy === 'job'} onClick={submit}>
              开始拆解
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex gap-1 rounded-lg border border-slate-200 p-1">
            {(
              [
                { id: 'paste' as InputMode, label: '粘贴 JD 文本' },
                { id: 'manual' as InputMode, label: '手动输入几条要求' },
              ]
            ).map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[12px] transition-colors',
                  mode === m.id ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <Field label="岗位名称（可选）">
            <TextInput value={titleHint} onChange={(e) => setTitleHint(e.target.value)} />
          </Field>
          <Field label={mode === 'paste' ? '岗位描述' : '对方告诉你的要求'}>
            <TextArea rows={14} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        </div>
      </Modal>

      {/* 要求编辑弹窗 */}
      <Modal
        open={Boolean(editing)}
        title={job?.items.some((i) => i.id === editing?.id) ? '编辑岗位要求' : '新增岗位要求'}
        subtitle="修改后会立即影响匹配结论，所以改完建议重新跑一次匹配"
        onClose={() => setEditing(null)}
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button variant="primary" onClick={saveRequirement}>
              保存
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="space-y-3">
            <Field label="要求内容（一句话，可独立判断真假）">
              <TextArea rows={2} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="类型">
                <select
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[13px]"
                  value={editing.type}
                  onChange={(e) => setEditing({ ...editing, type: e.target.value as RequirementType })}
                >
                  {REQUIREMENT_TYPE_ORDER.map((t) => (
                    <option key={t} value={t}>
                      {REQUIREMENT_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="重要程度">
                <select
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[13px]"
                  value={editing.importance}
                  onChange={(e) => setEditing({ ...editing, importance: e.target.value as TriLevel })}
                >
                  <option value="high">高</option>
                  <option value="medium">中</option>
                  <option value="low">低</option>
                </select>
              </Field>
              <Field label="需要的证据类型">
                <select
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[13px]"
                  value={editing.evidenceNeeded}
                  onChange={(e) => setEditing({ ...editing, evidenceNeeded: e.target.value as EvidenceNeeded })}
                >
                  {(Object.keys(EVIDENCE_NEEDED_LABEL) as EvidenceNeeded[]).map((k) => (
                    <option key={k} value={k}>
                      {EVIDENCE_NEEDED_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="能力关键词（每行一条，尽量用标准名，例如 Python / RAG 检索增强）">
              <TextArea
                rows={3}
                value={editing.keywords.join('\n')}
                onChange={(e) => setEditing({ ...editing, keywords: e.target.value.split('\n').map((t) => t.trim()).filter(Boolean) })}
              />
            </Field>
            <Field label="岗位原文片段">
              <TextArea rows={2} value={editing.original} onChange={(e) => setEditing({ ...editing, original: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-[12px] text-slate-600">
              <input type="checkbox" checked={editing.hardGate} onChange={(e) => setEditing({ ...editing, hardGate: e.target.checked })} />
              属于硬门槛（学历 / 年限 / 证书 / 地点 —— 不允许用软性描述通过）
            </label>
            <Callout>
              硬门槛在匹配时由独立规则判断，模型无法把它放宽为「满足」。如果你误标了，会出现不符合直觉的结论。
            </Callout>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
