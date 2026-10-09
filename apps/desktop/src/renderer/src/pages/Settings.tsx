import { useMemo, useState } from 'react';
import {
  AI_PROVIDER_LABEL,
  AI_PURPOSE_LABEL,
  APP_VERSION,
  CAPABILITIES,
  CURRENT_RELEASE,
  MODEL_PRICING,
  PROVIDER_PRESETS,
  RELEASE_LABEL,
  RELEASE_ORDER,
  TRANSCRIPTION_PRESETS,
  budgetAdvice,
  formatDateTime,
  isEnabled,
  restrictionCapabilities,
  summarizeUsage,
  topCostAdvice,
  type AiProviderId,
  type Release,
} from '@aijob/core';
import {
  Badge,
  Banner,
  Button,
  Callout,
  Card,
  CardHeader,
  Collapsible,
  Field,
  JsonBlock,
  SectionTitle,
  Select,
  TextInput,
  Toggle,
  cn,
} from '../components/ui';
import { useApp } from '../state/store';

/**
 * 设置页。承载三件事：
 *   1. AI Provider 配置（文档 22.6：可替换）
 *   2. 调用留痕查看（文档 11：透明度）
 *   3. 版本与能力开关（把产品文档 18/19/20/25 节变成可见的表）
 */
export function SettingsPage() {
  const snapshot = useApp((s) => s.snapshot);
  const runtime = useApp((s) => s.runtime);
  const updateSettings = useApp((s) => s.updateSettings);
  const testConnection = useApp((s) => s.testConnection);
  const clearAll = useApp((s) => s.clearAll);
  const exportJson = useApp((s) => s.exportJson);
  const busy = useApp((s) => s.busy);

  const settings = snapshot.settings;
  const [showKey, setShowKey] = useState(false);
  const [tab, setTab] = useState<'provider' | 'usage' | 'traces' | 'version' | 'data'>('provider');
  const [budgetInput, setBudgetInput] = useState<string>(
    settings.monthlyBudgetYuan === null || settings.monthlyBudgetYuan === undefined ? '' : String(settings.monthlyBudgetYuan),
  );

  const usage = useMemo(() => summarizeUsage(snapshot.traces), [snapshot.traces]);
  const budget = useMemo(
    () => budgetAdvice(usage, settings.monthlyBudgetYuan),
    [usage, settings.monthlyBudgetYuan],
  );
  const costHint = useMemo(() => topCostAdvice(usage), [usage]);
  const currentPricing = MODEL_PRICING.find((p) => p.match.some((m) => settings.model.toLowerCase().includes(m)));

  const byRelease = useMemo(() => {
    const map = new Map<Release, typeof CAPABILITIES>();
    for (const release of RELEASE_ORDER) {
      const list = CAPABILITIES.filter((c) => !c.restriction && c.since === release);
      if (list.length > 0) map.set(release, list);
    }
    return Array.from(map.entries());
  }, []);

  const enabled = CAPABILITIES.filter((c) => isEnabled(c.id));
  const restrictions = restrictionCapabilities();

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[19px] font-semibold text-slate-800">设置</h1>
        <p className="mt-1 text-xs text-slate-500">
          当前版本 v{APP_VERSION}（{RELEASE_LABEL[CURRENT_RELEASE]}）· 数据与模型调用全部由你控制
        </p>
      </header>

      <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1">
        {(
          [
            { id: 'provider', label: 'AI Provider' },
            { id: 'usage', label: '用量与费用' },
            { id: 'traces', label: `调用留痕 (${snapshot.traces.length})` },
            { id: 'version', label: '版本与能力' },
            { id: 'data', label: '数据与隐私' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'rounded-md px-3 py-1.5 text-[12px] transition-colors',
              tab === t.id ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ---------------- Provider ---------------- */}
      {tab === 'provider' ? (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="分析引擎"
              subtitle="默认使用内置本地规则引擎，完全离线。需要更强语义理解时再接入模型。"
            />
            <div className="space-y-4 px-5 py-4">
              <div className="grid gap-2 sm:grid-cols-3">
                {(['local', 'openai-compatible', 'ollama'] as AiProviderId[]).map((id) => (
                  <button
                    key={id}
                    onClick={() =>
                      void updateSettings({
                        providerId: id,
                        allowRemote: id === 'local' ? false : settings.allowRemote,
                      })
                    }
                    className={cn(
                      'rounded-lg border px-3 py-2.5 text-left transition-colors',
                      settings.providerId === id ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 bg-white hover:bg-slate-50',
                    )}
                  >
                    <div className="text-[12px] font-medium text-slate-800">{AI_PROVIDER_LABEL[id]}</div>
                    <div className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
                      {id === 'local' && '不联网，规则 + 技能词典，结果完全可复现'}
                      {id === 'openai-compatible' && 'DeepSeek / OpenAI / Moonshot / 智谱 / DashScope 等'}
                      {id === 'ollama' && '本机模型，数据不出机器'}
                    </div>
                  </button>
                ))}
              </div>

              {settings.providerId !== 'local' ? (
                <>
                  <div>
                    <div className="mb-1.5 text-[11px] text-slate-500">快速填充</div>
                    <div className="flex flex-wrap gap-1.5">
                      {PROVIDER_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          onClick={() => void updateSettings({ baseUrl: preset.baseUrl, model: preset.model })}
                          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="接口地址（Base URL）" hint="末尾不要带 /chat/completions，程序会自动拼接">
                      <TextInput value={settings.baseUrl} onChange={(e) => void updateSettings({ baseUrl: e.target.value })} />
                    </Field>
                    <Field label="模型名">
                      <TextInput value={settings.model} onChange={(e) => void updateSettings({ model: e.target.value })} />
                    </Field>
                  </div>

                  {settings.providerId === 'openai-compatible' ? (
                    <Field label="API Key" hint="仅保存在本机数据文件里，请求由桌面主进程发出，不会出现在页面上下文中。">
                      <div className="flex gap-2">
                        <TextInput
                          type={showKey ? 'text' : 'password'}
                          value={settings.apiKey}
                          onChange={(e) => void updateSettings({ apiKey: e.target.value })}
                          placeholder="sk-…"
                        />
                        <Button size="sm" onClick={() => setShowKey((v) => !v)}>
                          {showKey ? '隐藏' : '显示'}
                        </Button>
                      </div>
                    </Field>
                  ) : null}

                  <Field label={`温度（${settings.temperature}）`} hint="结构化任务建议 0.1–0.3，越高越发散">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.temperature}
                      onChange={(e) => void updateSettings({ temperature: Number(e.target.value) })}
                      className="w-full"
                    />
                  </Field>

                  <div className="rounded-lg border border-slate-200 px-3 py-1">
                    <Toggle
                      label="允许调用远程模型"
                      hint="关闭时所有分析都走本地规则引擎；这是唯一的出网开关。"
                      checked={settings.allowRemote}
                      onChange={(v) => void updateSettings({ allowRemote: v })}
                    />
                    <Toggle
                      label="每次发送前让我确认"
                      hint="开启后，每次调用模型前会展示脱敏后的完整内容，你可以取消，改用本地引擎。"
                      checked={settings.confirmBeforeSend}
                      onChange={(v) => void updateSettings({ confirmBeforeSend: v })}
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="primary" loading={busy === 'test'} onClick={() => void testConnection()}>
                      测试连通性
                    </Button>
                    <span className="text-[11px] text-slate-500">
                      当前请求由：{runtime?.transport ?? '未知'}
                    </span>
                  </div>
                </>
              ) : (
                <Banner tone="info" title="本地规则引擎已启用">
                  不需要任何配置。它用技能词典 + 结构化规则完成简历解析、岗位拆解与匹配判断，
                  结果完全可复现，也不会把你简历里的任何内容发到外部。
                  <br />
                  代价是：语义理解不如模型，遇到表述非常规的简历或 JD 时可能需要你手动修正解析结果。
                </Banner>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="面试录音与转写"
              subtitle="录音默认只保存在本机；转写是唯一会把音频发出去的功能，因此单独开关"
            />
            <div className="space-y-4 px-5 py-4">
              <div className="rounded-lg border border-slate-200 px-3 py-1">
                <Toggle
                  label="开启录音转写"
                  hint="关闭时只录音、不转写，转写文本由你在复盘页手工粘贴 —— 这是一条完全离线的路径。"
                  checked={settings.transcription.enabled}
                  onChange={(v) => void updateSettings({ transcription: { ...settings.transcription, enabled: v } })}
                />
                <Toggle
                  label="默认静默录制"
                  hint="面试期间不弹提示、不弹窗、不弹系统通知、不改窗口标题、窗口隐藏到托盘。"
                  checked={settings.capture.quietByDefault}
                  onChange={(v) => void updateSettings({ capture: { ...settings.capture, quietByDefault: v } })}
                />
                <Toggle
                  label="线上面试默认开启内录"
                  hint="关闭后只录麦克风，会丢掉面试官那一半对话。"
                  checked={settings.capture.systemAudioByDefault}
                  onChange={(v) => void updateSettings({ capture: { ...settings.capture, systemAudioByDefault: v } })}
                />
              </div>

              {settings.transcription.enabled ? (
                <>
                  <div>
                    <div className="mb-1.5 text-[11px] text-slate-500">快速填充</div>
                    <div className="flex flex-wrap gap-1.5">
                      {TRANSCRIPTION_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          onClick={() =>
                            void updateSettings({ transcription: { ...settings.transcription, baseUrl: preset.baseUrl, model: preset.model } })
                          }
                          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="转写接口地址" hint="留空表示复用上面填的 Base URL">
                      <TextInput
                        value={settings.transcription.baseUrl}
                        placeholder={settings.baseUrl}
                        onChange={(e) => void updateSettings({ transcription: { ...settings.transcription, baseUrl: e.target.value } })}
                      />
                    </Field>
                    <Field label="转写模型">
                      <TextInput
                        value={settings.transcription.model}
                        onChange={(e) => void updateSettings({ transcription: { ...settings.transcription, model: e.target.value } })}
                      />
                    </Field>
                  </div>

                  <Field label="转写接口 API Key" hint="留空表示复用上面填的 Key。本机地址（127.0.0.1）不需要 Key。">
                    <div className="flex gap-2">
                      <TextInput
                        type={showKey ? 'text' : 'password'}
                        value={settings.transcription.apiKey}
                        placeholder={settings.apiKey ? '（沿用上面的 Key）' : 'sk-…'}
                        onChange={(e) => void updateSettings({ transcription: { ...settings.transcription, apiKey: e.target.value } })}
                      />
                      <Button size="sm" onClick={() => setShowKey((v) => !v)}>
                        {showKey ? '隐藏' : '显示'}
                      </Button>
                    </div>
                  </Field>

                  <Banner tone="warning" title="开启转写意味着音频会被发送出去">
                    录音分片会按顺序上传到你填的这个地址。这与「只发脱敏文本」不是一个量级的数据 ——
                    好在音频里本来就包含面试官说的话，不属于你要保护的简历信息。
                    不接受这一点时，关掉这个开关，改用手工粘贴转写文本。
                  </Banner>
                </>
              ) : (
                <Banner tone="info" title="当前是「只录音，不转写」">
                  录音会按分片存在本机数据目录的 recordings/ 下。面试结束后你可以把转写文本（会议软件的字幕导出、
                  手机转写、或手工记录）粘贴到复盘页，一样能出完整报告。
                </Banner>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={`录音分片时长（${settings.capture.segmentSeconds} 秒）`} hint="越短越接近实时，但请求次数越多；建议 15–30 秒">
                  <input
                    type="range"
                    min={10}
                    max={60}
                    step={5}
                    value={settings.capture.segmentSeconds}
                    onChange={(e) => void updateSettings({ capture: { ...settings.capture, segmentSeconds: Number(e.target.value) } })}
                    className="w-full"
                  />
                </Field>
                <Field label="结束录制的全局快捷键" hint="静默模式下窗口是隐藏的，这是除托盘菜单之外的第二条安全出口。留空表示不注册。">
                  <TextInput
                    value={settings.capture.hotkey}
                    placeholder="Control+Alt+R"
                    onChange={(e) => void updateSettings({ capture: { ...settings.capture, hotkey: e.target.value } })}
                  />
                </Field>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="降级策略" subtitle="模型失败不会让分析流程中断" />
            <div className="space-y-1.5 px-5 py-4 text-[12px] leading-relaxed text-slate-600">
              <div>1. 未开启远程调用 / 没填 Key / 接口不通 → 直接用本地规则引擎，并提示原因。</div>
              <div>2. 模型返回的不是合法 JSON → 丢弃该结果，退回规则引擎，原始返回保存在留痕里可查。</div>
              <div>3. 模型给出的匹配结论与本地规则冲突时：硬门槛类以本地规则为准，模型无权放宽。</div>
              <div>4. 无论成功失败，每次调用都会写一条留痕。</div>
            </div>
          </Card>
        </div>
      ) : null}

      {/* ---------------- v0.3 追加：用量与费用 ---------------- */}
      {tab === 'usage' ? (
        <div className="space-y-4">
          {/* 第一句话就说清边界：这个数字不是账户余额。
              用户的真实余额在服务商后台，本应用拿不到 ——
              任何声称能显示「余额」的界面都在骗人。 */}
          <Banner tone="warning" title="这里显示的是本机的调用统计，不是账户余额">
            API Key 是你自己填的，服务商后台的余额、账单、套餐都不在本机，任何应用都查不到。
            下面统计的是「在这台机器上，AI Job Partner 累计调用了多少、花了大约多少钱」，
            真实扣费请到服务商后台核对。
          </Banner>

          <Card>
            <CardHeader
              title="累计用量"
              subtitle={`共 ${usage.calls} 次调用记录 · 其中 ${usage.remoteCalls} 次真的发出去了，${usage.localCalls} 次走本地规则引擎`}
            />
            <div className="px-5 py-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-slate-200 px-3 py-2.5">
                  <div className="text-[11px] text-slate-500">估算费用</div>
                  <div className="mt-1 text-[20px] font-semibold text-slate-800">
                    ¥{usage.costYuan.toFixed(4)}
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-400">
                    精确 ¥{usage.exactCostYuan.toFixed(4)} + 估算 ¥{usage.estimatedCostYuan.toFixed(4)}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 px-3 py-2.5">
                  <div className="text-[11px] text-slate-500">Token 用量</div>
                  <div className="mt-1 text-[20px] font-semibold text-slate-800">
                    {usage.totalTokens.toLocaleString()}
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-400">
                    输入 {usage.promptTokens.toLocaleString()} · 输出 {usage.completionTokens.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 px-3 py-2.5">
                  <div className="text-[11px] text-slate-500">本地消耗</div>
                  <div className="mt-1 text-[20px] font-semibold text-slate-800">
                    {usage.localTokens.toLocaleString()}
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-400">token · 不产生外部费用</div>
                </div>
                <div className="rounded-lg border border-slate-200 px-3 py-2.5">
                  <div className="text-[11px] text-slate-500">当前模型</div>
                  <div className="mt-1 truncate text-[13px] font-medium text-slate-800">{settings.model || '—'}</div>
                  <div className="mt-0.5 text-[10px] text-slate-400">
                    {currentPricing
                      ? `输入 ¥${currentPricing.inputPerMillion}/百万 · 输出 ¥${currentPricing.outputPerMillion}/百万`
                      : '未收录单价，按通义千问 plus 的量级估算'}
                  </div>
                </div>
              </div>

              {usage.estimatedCostYuan > 0 ? (
                <div className="mt-3 text-[11px] leading-relaxed text-amber-700">
                  其中 ¥{usage.estimatedCostYuan.toFixed(4)} 来自本地估算（接口没有返回 token 数）。
                  估算按「1 个汉字 ≈ 0.67 token、4 个英文字符 ≈ 1 token」折算，误差可能到 ±20%。
                  需要精确值时，以服务商后台的账单为准。
                </div>
              ) : null}

              {costHint ? (
                <div className="mt-3">
                  <Callout>{costHint}</Callout>
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="预算上限" subtitle="超过上限时这里会给出明确提示（不会自动停用，避免你以为还能用却静默失败）" />
            <div className="px-5 py-4">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="每月上限（元）" hint="留空表示不限制">
                  <TextInput
                    type="number"
                    min={0}
                    step={1}
                    className="w-[160px]"
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(e.target.value)}
                    placeholder="例如 20"
                  />
                </Field>
                <Button
                  variant="primary"
                  onClick={() => {
                    const n = Number(budgetInput);
                    void updateSettings({
                      monthlyBudgetYuan: budgetInput.trim() === '' || Number.isNaN(n) || n <= 0 ? null : n,
                    });
                  }}
                >
                  保存
                </Button>
                {settings.monthlyBudgetYuan ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setBudgetInput('');
                      void updateSettings({ monthlyBudgetYuan: null });
                    }}
                  >
                    取消上限
                  </Button>
                ) : null}
              </div>
              <div className="mt-2">
                <Banner tone={budget.level === 'over' ? 'warning' : budget.level === 'near' ? 'info' : 'info'}>
                  {budget.text}
                </Banner>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="按用途分组的花费" subtitle="看看钱花在哪个环节上 —— 通常某一类占了大部分" />
            <div className="px-5 py-4">
              {usage.byPurpose.length === 0 ? (
                <div className="text-[12px] text-slate-500">还没有调用记录。用一次分析功能后这里就有数据了。</div>
              ) : (
                <div className="space-y-2">
                  {usage.byPurpose.map((b) => (
                    <div key={b.purpose} className="rounded-lg border border-slate-200 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12px] font-medium text-slate-700">{b.label}</span>
                        <Badge tone="muted">{b.calls} 次</Badge>
                        <Badge tone="neutral">{b.totalTokens.toLocaleString()} token</Badge>
                        {b.estimatedCalls > 0 ? <Badge tone="warning">{b.estimatedCalls} 次为估算</Badge> : null}
                        <span className="flex-1" />
                        <span className="text-[12px] font-medium text-slate-800">¥{b.costYuan.toFixed(4)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="按模型分组" subtitle="换了模型之后，历史费用会按当前单价重算 —— token 数是事实，费用是推导" />
            <div className="px-5 py-4">
              {usage.byModel.length === 0 ? (
                <div className="text-[12px] text-slate-500">还没有调用记录。</div>
              ) : (
                <div className="space-y-1.5">
                  {usage.byModel.map((m) => (
                    <div key={m.model} className="flex items-center gap-2 text-[12px]">
                      <span className="flex-1 truncate text-slate-700">{m.model}</span>
                      <span className="text-slate-500">{m.calls} 次</span>
                      <span className="text-slate-500">{m.totalTokens.toLocaleString()} token</span>
                      <span className="w-[86px] text-right font-medium text-slate-800">¥{m.costYuan.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card className="border-dashed">
            <CardHeader title="单价从哪来" subtitle="改价的方式与它的局限" />
            <div className="space-y-2 px-5 py-4 text-[11px] leading-relaxed text-slate-600">
              <div>内置了 {MODEL_PRICING.length} 个常见模型的公开单价（元 / 百万 token），按模型名匹配。</div>
              <div>没匹配到时按通义千闻 plus 的量级估算，并会在卡片上标注「未收录单价」。</div>
              <div>服务端价格会变，这里的数字也可能过期。把它当作量级参考，不要当作账单。</div>
              <div>清空调用留痕会同时清掉这份统计 —— 留痕最多保留最近 120 条。</div>
            </div>
          </Card>
        </div>
      ) : null}

      {/* ---------------- 留痕 ---------------- */}
      {tab === 'traces' ? (
        <div className="space-y-4">
          <Banner tone="info" title="AI 调用留痕">
            这是文档第十一节的透明度设计：你可以逐条确认模型到底收到了什么、返回了什么、有没有被降级。
            原始 PII 在写入留痕之前就已经被脱敏，所以这里不会有真实的电话邮箱。
          </Banner>
          {snapshot.traces.length === 0 ? (
            <Card>
              <div className="px-5 py-8 text-center text-[12px] text-slate-500">还没有任何模型调用记录。</div>
            </Card>
          ) : (
            <div className="space-y-2.5">
              {snapshot.traces.map((trace) => (
                <Card key={trace.id}>
                  <div className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="accent">{AI_PURPOSE_LABEL[trace.purpose]}</Badge>
                      <Badge tone="muted">{trace.providerId === 'local' ? '本地规则' : trace.model}</Badge>
                      {trace.usedFallback ? <Badge tone="warning">已降级</Badge> : <Badge tone="success">成功</Badge>}
                      {/* v0.3：单条调用的 token 与费用，让用户能对上总账 */}
                      {trace.usage ? (
                        <Badge tone="neutral">
                          {trace.usage.totalTokens.toLocaleString()} token
                          {trace.usage.estimated ? '（估）' : ''} · ¥{trace.usage.costYuan?.toFixed(4) ?? '—'}
                        </Badge>
                      ) : null}
                      <span className="flex-1" />
                      <span className="text-[10px] text-slate-400">
                        {formatDateTime(trace.createdAt)} · {trace.durationMs}ms · 发 {trace.promptChars} 字 / 收 {trace.responseChars} 字
                      </span>
                    </div>
                    {trace.fallbackReason ? (
                      <div className="mt-1.5 text-[11px] text-amber-700">降级原因：{trace.fallbackReason}</div>
                    ) : null}
                    {trace.error ? <div className="mt-1 text-[11px] text-rose-600">错误：{trace.error}</div> : null}
                    <div className="mt-2 space-y-2">
                      <Collapsible title="实际发送给模型的内容">
                        <div className="space-y-2">
                          {trace.sentMessages.map((m, i) => (
                            <div key={`${trace.id}-m${i}`}>
                              <div className="mb-1 text-[11px] font-medium text-slate-500">
                                {m.role === 'system' ? '系统提示词' : m.role === 'user' ? '用户内容' : '助手'}
                              </div>
                              <JsonBlock value={m.content} maxHeight={200} />
                            </div>
                          ))}
                        </div>
                      </Collapsible>
                      {trace.receivedRaw ? (
                        <Collapsible title="模型返回的原文">
                          <JsonBlock value={trace.receivedRaw} maxHeight={220} />
                        </Collapsible>
                      ) : null}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* ---------------- 版本与能力 ---------------- */}
      {tab === 'version' ? (
        <div className="space-y-4">
          <Banner tone="info" title="能力开关是怎么工作的">
            产品文档里所有「能不能做 X」都被编码成一张能力表（packages/core/src/version.ts）。
            提升 CURRENT_RELEASE 即完成一次版本更新，路线图内的能力会自动解锁，业务代码里没有任何
            if (version === '0.1') 的硬编码判断。
          </Banner>

          <Card>
            <CardHeader title={`当前已启用（${enabled.length}）`} subtitle={`版本 ${RELEASE_LABEL[CURRENT_RELEASE]}`} />
            <ul className="space-y-1.5 px-5 py-4">
              {enabled.map((cap) => (
                <li key={cap.id} className="flex items-start gap-2">
                  <Badge tone="success">已启用</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-slate-700">{cap.label}</div>
                    <div className="text-[11px] leading-relaxed text-slate-500">
                      {cap.description} <span className="text-slate-400">（文档 {cap.docRef} 节）</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          {byRelease
            .filter(([release]) => !isEnabled(CAPABILITIES.find((c) => c.since === release && !c.restriction)?.id ?? ''))
            .map(([release, caps]) => (
              <Card key={release}>
                <CardHeader title={RELEASE_LABEL[release]} subtitle="尚未开放（路线图内）" />
                <ul className="space-y-1.5 px-5 py-4">
                  {caps.map((cap) => (
                    <li key={cap.id} className="flex items-start gap-2">
                      <Badge tone="muted">待开放</Badge>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium text-slate-700">{cap.label}</div>
                        <div className="text-[11px] leading-relaxed text-slate-500">{cap.description}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}

          <Card>
            <CardHeader
              title={`${RELEASE_LABEL[CURRENT_RELEASE]} 铁律：明确不做（${restrictions.length}）`}
              subtitle="来源：产品文档第二十五节。它们不是「没来得及做」，而是被明确推迟的方向。"
            />
            <div className="px-5 py-4">
              <div className="grid gap-1.5 sm:grid-cols-2">
                {restrictions.map((cap) => (
                  <div key={cap.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50/70 px-2.5 py-1.5">
                    <Badge tone="danger">不做</Badge>
                    <span className="text-[12px] text-slate-700">{cap.label}</span>
                    <span className="ml-auto text-[10px] text-slate-400">{cap.docRef} 节</span>
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <Callout>
                  这些条目在能力表里的 since 是 <span className="font-mono">future</span>，表示「不会随版本号自动打开」。
                  产品方向调整时，只需要把对应条目的 since 改成目标版本，能力即解锁 —— 不需要在业务代码里动任何开关。
                </Callout>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {/* ---------------- 数据 ---------------- */}
      {tab === 'data' ? (
        <div className="space-y-4">
          <Card>
            <CardHeader title="运行环境" />
            <div className="space-y-2 px-5 py-4 text-[12px] leading-relaxed text-slate-600">
              <div>
                <span className="text-slate-500">宿主：</span>
                {runtime?.label ?? '检测中…'}
              </div>
              <div>
                <span className="text-slate-500">存储：</span>
                <span className="whitespace-pre-wrap">{runtime?.storage ?? '检测中…'}</span>
              </div>
              <div>
                <span className="text-slate-500">出网：</span>
                {runtime?.transport ?? '检测中…'}
              </div>
              <div>
                <span className="text-slate-500">说明：</span>
                {runtime?.detail}
              </div>
              {runtime?.versions ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {Object.entries(runtime.versions).map(([k, v]) => (
                    <Badge key={k} tone="muted">
                      {k} {v}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="隐私承诺" subtitle="这一条不是文案，是结构决定的" />
            <div className="space-y-1.5 px-5 py-4 text-[12px] leading-relaxed text-slate-600">
              <div>1. 不建立账号系统，简历与岗位数据只写在本机（文档第二十五节把用户注册列为 v0.1 铁律）。</div>
              <div>2. 简历在进入任何分析链路之前先做 PII 脱敏：姓名 / 电话 / 邮箱 / 地址 / 身份证 / 社交账号。</div>
              <div>3. 档案里保存的是脱敏后的文本；原始值只在「隐私记录」页本地展示，不写入 Prompt。</div>
              <div>4. 是否调用远程模型由你决定，且可以要求每次发送前人工确认。</div>
              <div>5. 每一次模型调用都留痕，可逐条核对实际发送内容。</div>
              <div>6. 能力问诊的回答同样会进入分析链路（可能被发送给模型），因此走与简历一致的脱敏与留痕规则。</div>
              <div>7. 问诊补充的证据会标注来源（origin = qa），在报告里与简历证据区分显示，强度封顶为「中」。</div>
              <div>8. 面试录音默认只写在本机数据目录的 recordings/ 下，不上传、不联网；转写是唯一会把音频发出去的功能，需要你单独开启。</div>
              <div>9. 复盘报告在生成前会做去标识化：称呼、公司/机构名、电话邮箱等会被替换，但数字（时长、薪酬、指标数量）保留 —— 它们是判断依据。</div>
              <div>10. 删除面试记录只会删掉数据库里的记录，音频文件会保留在录音目录；「放弃本次录制」也是把文件移到 recordings/_discarded/，不做物理删除。</div>
            </div>
          </Card>

          <Card>
            <CardHeader title="数据操作" subtitle={`当前：${snapshot.profiles.length} 份档案 · ${snapshot.jobs.length} 个岗位 · ${snapshot.reports.length} 份报告`} />
            <div className="flex flex-wrap gap-2 px-5 py-4">
              <Button onClick={() => void exportJson()}>导出结构化 JSON</Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm('这会删除本机保存的全部档案、岗位、报告与调用留痕，且不可恢复。确定继续？')) void clearAll();
                }}
              >
                清空全部本地数据
              </Button>
            </div>
          </Card>

          <Callout>
            关于报告导出：把报告渲染成 PDF / Word 属于 v0.3 能力。当前提供的是「导出结构化 JSON」——
            它导出的正是内部契约的原文，任何渲染器都可以基于它生成报告。
          </Callout>
        </div>
      ) : null}
    </div>
  );
}
