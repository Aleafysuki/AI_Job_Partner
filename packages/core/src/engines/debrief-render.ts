import type {
  DebriefDimension,
  DebriefRadarSeries,
  DebriefTable,
  InterviewDebriefReport,
} from '../domain/debrief';
import {
  DEBRIEF_BASIS_LABEL,
  DEBRIEF_DIM_STATUS_LABEL,
  DEBRIEF_MODE_LABEL,
  DEBRIEF_QUESTION_CATEGORY_LABEL,
  DEBRIEF_TIER_LABEL,
  DEBRIEF_TOPIC_LABEL,
  DEBRIEF_EVIDENCE_TYPE_LABEL,
  PERFORMANCE_OVERALL_LABEL,
  SPEAKER_LABEL,
} from '../domain/debrief';

/**
 * 复盘报告 → 自包含 HTML。
 *
 * 对齐 `multi-dimension-fit-report` 的渲染约束（output-spec 第六节）：
 *
 * - **单文件**：CSS 内联、雷达图用原生 SVG 手绘、**不引用任何 CDN / 外部字体 / 远程图片**，
 *   断网也能打开 —— 面试复盘的内容比简历更敏感，不应该因为打开一份报告而发起任何网络请求；
 * - **亮色主题 + 响应式**：宽度 < 720px 时表格改成卡片式堆叠；
 * - **可机器读**：完整 report JSON 内嵌在 `<script type="application/json" id="report-data">`，
 *   App 可以重新读回页面里的数据；
 * - **无副作用**：纯函数，不发请求、不写文件、不改入参。
 *
 * 一条纪律：**渲染阶段不新增结论**。这里所有的文字都来自 report 对象，
 * 任何「要不要去」的判断都不在这一层产生。
 */

function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 内嵌 JSON 必须防 `</script>` 提前闭合 */
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 雷达图（原生 SVG，无依赖）
// ---------------------------------------------------------------------------

interface RadarOptions {
  title: string;
  series: DebriefRadarSeries[];
  /** 轴上限。压力与适配都是 5 分制 */
  max?: number;
  note?: string;
}

export function radarSvg(options: RadarOptions): string {
  const series = options.series.filter((s) => s.axis);
  if (series.length < 3) {
    return `<div class="empty-chart">数据点少于 3 个，无法绘制雷达图。</div>`;
  }
  const max = options.max ?? 5;
  const size = 320;
  const cx = size / 2;
  const cy = size / 2 + 6;
  const R = size / 2 - 62;
  const n = series.length;

  const point = (index: number, radius: number): [number, number] => {
    const angle = (-Math.PI / 2) + (index * 2 * Math.PI) / n;
    return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
  };

  const rings = [0.2, 0.4, 0.6, 0.8, 1].map((ratio) => {
    const pts = series
      .map((_, i) => point(i, R * ratio))
      .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' ');
    return `<polygon points="${pts}" fill="none" stroke="#e2e8f0" stroke-width="1" />`;
  });

  const spokes = series
    .map((_, i) => {
      const [x, y] = point(i, R);
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1" />`;
    })
    .join('');

  // null 表示「证据不足」—— 该轴不参与连线，避免用 0 伪造出一个突刺
  const known = series.map((s, i) => ({ ...s, i })).filter((s) => typeof s.value === 'number' && (s.value as number) > 0);
  const dataPolygon =
    known.length >= 3
      ? `<polygon points="${known
          .map((s) => {
            const [x, y] = point(s.i, (R * Math.min(max, s.value as number)) / max);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ')}" fill="rgba(79,70,229,0.18)" stroke="#4f46e5" stroke-width="2" />`
      : '';

  const dots = known
    .map((s) => {
      const [x, y] = point(s.i, (R * Math.min(max, s.value as number)) / max);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#4f46e5" />`;
    })
    .join('');

  const labels = series
    .map((s, i) => {
      const [x, y] = point(i, R + 20);
      const anchor = Math.abs(x - cx) < 12 ? 'middle' : x > cx ? 'start' : 'end';
      const value = typeof s.value === 'number' ? String(s.value) : '—';
      return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${anchor}" font-size="10" fill="${
        typeof s.value === 'number' ? '#475569' : '#94a3b8'
      }">${escapeHtml(s.axis)} ${value}</text>`;
    })
    .join('');

  return `<figure class="chart">
  <figcaption>${escapeHtml(options.title)}</figcaption>
  <svg viewBox="0 0 ${size} ${size + 16}" width="100%" role="img" aria-label="${escapeHtml(options.title)}">
    <g>${rings}${spokes}${dataPolygon}${dots}${labels}</g>
  </svg>
  ${options.note ? `<p class="chart-note">${escapeHtml(options.note)}</p>` : ''}
</figure>`;
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

function tableBlock(title: string, table: DebriefTable | null, columns: Array<{ key: string; label: string }>): string {
  if (!table || table.rows.length === 0) return '';
  const head = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
  const body = table.rows
    .map(
      (row) =>
        `<tr>${columns
          .map((c) => `<td data-label="${escapeHtml(c.label)}">${escapeHtml(row[c.key] ?? '—')}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<section class="block">
  <h3>${escapeHtml(title)}</h3>
  <p class="formula">${escapeHtml(table.formula)}</p>
  <div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
  ${table.verdict ? `<p class="verdict">${escapeHtml(table.verdict)}</p>` : ''}
</section>`;
}

// ---------------------------------------------------------------------------
// 维度小节
// ---------------------------------------------------------------------------

function dimensionSection(dim: DebriefDimension, index: Map<string, string>): string {
  const findings = dim.findings
    .map(
      (f) =>
        `<li><span class="basis basis-${f.basis}">[${escapeHtml(DEBRIEF_BASIS_LABEL[f.basis])}]</span> ${escapeHtml(
          f.text,
        )} <span class="refs">${f.evidenceIds.map((id) => escapeHtml(index.get(id) ?? id)).join(', ')}</span></li>`,
    )
    .join('');
  const unknowns = dim.unknowns.length
    ? `<div class="sub"><span class="sub-title">未知项</span><ul>${dim.unknowns.map((u) => `<li>${escapeHtml(u)}</li>`).join('')}</ul></div>`
    : '';
  const comp = dim.computation
    ? `<div class="sub"><span class="sub-title">测算</span>
        <p class="formula">${escapeHtml(dim.computation.formula)}</p>
        <p class="formula">输入：${escapeHtml(JSON.stringify(dim.computation.inputs))}</p>
        <p class="formula">结果：${escapeHtml(JSON.stringify(dim.computation.result))}</p>
        <p class="verdict">${escapeHtml(dim.computation.verdict)}</p></div>`
    : '';
  const questions = dim.questions.length
    ? `<div class="sub"><span class="sub-title">这一维度产生的问题</span><ul>${dim.questions
        .map((q) => `<li><span class="pri pri-${q.priority}">${escapeHtml(q.priority)}</span> ${escapeHtml(q.text)}</li>`)
        .join('')}</ul></div>`
    : '';

  return `<article class="dim ${dim.status}">
  <header>
    <span class="dim-id">${escapeHtml(dim.id)}</span>
    <h3>${escapeHtml(dim.name)}</h3>
    <span class="status status-${dim.status}">${escapeHtml(DEBRIEF_DIM_STATUS_LABEL[dim.status])}</span>
  </header>
  <p class="lead">${escapeHtml(dim.verdictLine)}</p>
  ${findings ? `<div class="sub"><span class="sub-title">依据</span><ul>${findings}</ul></div>` : ''}
  ${comp}
  ${unknowns}
  ${questions}
</article>`;
}

// ---------------------------------------------------------------------------
// 主渲染
// ---------------------------------------------------------------------------

const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f5f6f8;color:#1e293b;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:32px 20px 64px}
.cover{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:26px 28px;margin-bottom:18px}
.cover h1{margin:0 0 6px;font-size:22px;letter-spacing:.2px}
.cover .meta{display:flex;flex-wrap:wrap;gap:6px 16px;color:#64748b;font-size:12px;margin-top:10px}
.tag{display:inline-block;padding:1px 8px;border-radius:6px;border:1px solid #e2e8f0;background:#f8fafc;font-size:11px;color:#475569}
.tag.warn{border-color:#fcd34d;background:#fffbeb;color:#92400e}
.tag.bad{border-color:#fda4af;background:#fff1f2;color:#9f1239}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:22px 26px;margin-bottom:16px}
h2{font-size:16px;margin:0 0 12px}
h3{font-size:14px;margin:0 0 8px}
.one-line{font-size:17px;font-weight:600;margin:0 0 10px;line-height:1.6}
.tier{display:inline-block;padding:3px 10px;border-radius:8px;font-size:12px;font-weight:600;margin-bottom:10px}
.tier-consider{background:#ecfdf5;color:#047857;border:1px solid #a7f3d0}
.tier-caution{background:#fffbeb;color:#b45309;border:1px solid #fcd34d}
.tier-mismatch{background:#fff1f2;color:#be123c;border:1px solid #fda4af}
.tier-insufficient{background:#f8fafc;color:#475569;border:1px solid #e2e8f0}
.next-action{margin-top:14px;padding:12px 14px;border-radius:10px;background:#eef2ff;border:1px solid #c7d2fe;color:#312e81}
.next-action b{display:block;font-size:12px;margin-bottom:3px;opacity:.75}
ul{margin:6px 0;padding-left:20px}
li{margin:4px 0}
.basis{font-size:11px;padding:0 5px;border-radius:4px;background:#f1f5f9;color:#475569;white-space:nowrap}
.basis-stated{background:#ecfdf5;color:#047857}
.basis-inferred{background:#f1f5f9;color:#475569}
.refs{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#94a3b8}
.block{margin:20px 0}
.formula{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#475569;margin:4px 0}
.verdict{margin:8px 0 0;color:#334155}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin:8px 0}
th,td{border:1px solid #e2e8f0;padding:6px 9px;text-align:left}
th{background:#f8fafc;color:#475569;font-weight:600}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.chart{margin:0;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px}
.chart figcaption{font-size:13px;font-weight:600;margin-bottom:4px}
.chart-note{font-size:11px;color:#94a3b8;margin:4px 0 0}
.empty-chart{font-size:12px;color:#94a3b8;padding:20px;text-align:center}
.dim{background:#fff;border:1px solid #e2e8f0;border-left:3px solid #cbd5e1;border-radius:12px;padding:16px 20px;margin-bottom:12px}
.dim.ok{border-left-color:#34d399}
.dim.partial{border-left-color:#fbbf24}
.dim.insufficient_info{border-left-color:#cbd5e1;background:#fcfcfd}
.dim header{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.dim header h3{margin:0;flex:1}
.dim-id{font-family:ui-monospace,monospace;font-size:12px;color:#4f46e5;font-weight:700}
.status{font-size:11px;padding:1px 7px;border-radius:6px;border:1px solid #e2e8f0;color:#475569;background:#f8fafc}
.status-ok{border-color:#a7f3d0;background:#ecfdf5;color:#047857}
.status-partial{border-color:#fcd34d;background:#fffbeb;color:#b45309}
.lead{margin:0 0 8px;color:#334155}
.sub{margin:8px 0}
.sub-title{display:block;font-size:11px;font-weight:600;color:#64748b;letter-spacing:.4px;margin-bottom:2px}
.pri{font-size:10px;padding:0 5px;border-radius:4px;background:#f1f5f9;color:#475569}
.pri-high{background:#fff1f2;color:#be123c}
.pri-medium{background:#fffbeb;color:#b45309}
.qgroup{margin:12px 0}
.qgroup h3{color:#4f46e5}
.footer{color:#64748b;font-size:12px;text-align:center;margin-top:24px;line-height:1.8}
.notice{background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:10px;padding:10px 14px;font-size:12px;margin-bottom:16px}
@media (max-width:720px){
  .wrap{padding:16px 12px 40px}
  .card,.cover{padding:16px 16px;border-radius:10px}
  table,thead,tbody,tr,td,th{display:block;width:100%}
  thead{display:none}
  tr{border:1px solid #e2e8f0;border-radius:8px;margin-bottom:8px;padding:6px}
  td{border:none;padding:3px 6px}
  td::before{content:attr(data-label) "：";color:#64748b;font-size:11px}
}
`;

export interface RenderDebriefOptions {
  /** 报告标题下方的副标题，例如「由录音转写 + 本地规则引擎生成」 */
  subtitle?: string;
}

export function renderDebriefHtml(report: InterviewDebriefReport, options: RenderDebriefOptions = {}): string {
  const index = new Map(report.evidence.map((e) => [e.id, e.quote.slice(0, 18)]));
  const opportunity = report.dimensions.filter((d) => d.kind === 'opportunity');
  const performance = report.dimensions.filter((d) => d.kind === 'performance');

  const highlights = report.synthesis.highlights
    .map(
      (h) =>
        `<li>${escapeHtml(h.text)} <span class="refs">${h.evidenceIds.map((id) => escapeHtml(index.get(id) ?? id)).join(', ')}</span></li>`,
    )
    .join('');

  const grouped = new Map<string, typeof report.questions>();
  for (const q of report.questions) {
    const list = grouped.get(q.category) ?? [];
    list.push(q);
    grouped.set(q.category, list);
  }
  const questionGroups = [...grouped.entries()]
    .map(
      ([category, list]) =>
        `<div class="qgroup"><h3>${escapeHtml(DEBRIEF_QUESTION_CATEGORY_LABEL[category as keyof typeof DEBRIEF_QUESTION_CATEGORY_LABEL] ?? category)}</h3><ul>${list
          .map(
            (q) =>
              `<li><span class="pri pri-${q.priority}">${escapeHtml(q.priority)}</span> ${escapeHtml(q.text)}</li>`,
          )
          .join('')}</ul></div>`,
    )
    .join('');

  const decisionTable = `<div class="table-wrap"><table><thead><tr><th>分类</th><th>触发条件</th></tr></thead><tbody>${report.synthesis.decisionTable
    .map(
      (tier) =>
        `<tr><td data-label="分类">${escapeHtml(tier.label)}</td><td data-label="触发条件">${
          tier.conditions.length > 0 ? tier.conditions.map((c) => escapeHtml(c)).join('<br>') : '—'
        }</td></tr>`,
    )
    .join('')}</tbody></table></div>`;

  const scenarios = report.synthesis.scenarios
    .map(
      (s) =>
        `<div class="qgroup"><h3>情景 ${escapeHtml(s.key)} · ${escapeHtml(s.label)}</h3><ul>${s.points
          .map((p) => `<li><b>${escapeHtml(p.field)}：</b>${escapeHtml(p.text)}</li>`)
          .join('')}</ul></div>`,
    )
    .join('');

  const evidenceTable = `<div class="table-wrap"><table><thead><tr>
      <th>编号</th><th>原话</th><th>说话人</th><th>类型</th><th>主题</th><th>一致性</th>
    </tr></thead><tbody>${report.evidence
      .map(
        (e) =>
          `<tr><td data-label="编号">${escapeHtml(e.id)}</td><td data-label="原话">${escapeHtml(e.quote)}</td><td data-label="说话人">${escapeHtml(
            SPEAKER_LABEL[e.speaker],
          )}</td><td data-label="类型">${escapeHtml(DEBRIEF_EVIDENCE_TYPE_LABEL[e.type])}</td><td data-label="主题">${escapeHtml(
            DEBRIEF_TOPIC_LABEL[e.topic],
          )}</td><td data-label="一致性">${e.consistency === 'conflicting' ? '与其他说法不一致' : '—'}</td></tr>`,
      )
      .join('')}</tbody></table></div>`;

  const performanceSummary = report.performance;
  const fit = report.fit;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(report.meta.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">

  <section class="cover">
    <h1>${escapeHtml(report.meta.title)}</h1>
    <p class="sub" style="margin:0;color:#475569">${escapeHtml(options.subtitle ?? '由面试录音转写推导，只使用录音里出现过的话')}</p>
    <div class="meta">
      <span class="tag">${escapeHtml(DEBRIEF_MODE_LABEL[report.meta.mode])}</span>
      <span class="tag">时长 ${escapeHtml(formatDuration(report.meta.durationMs))}</span>
      <span class="tag">${escapeHtml(formatDate(report.createdAt))}</span>
      <span class="tag">转写 ${report.meta.transcriptChars} 字 · 事实 ${report.evidence.length} 条</span>
      <span class="tag">置信度 ${escapeHtml(report.meta.confidence)}</span>
      <span class="tag">分析引擎 ${
        report.meta.engine === 'ai' ? '模型 + 本地规则' : report.meta.engine === 'hybrid' ? '模型与规则混合' : '本地规则'
      }</span>
      <span class="tag ${report.meta.quiet ? 'warn' : ''}">${report.meta.quiet ? '静默录制' : '普通录制'}</span>
    </div>
  </section>

  ${
    report.meta.anonymized
      ? ''
      : '<div class="notice">这份报告没有做去标识化，可能包含真实姓名与公司名，请谨慎分享。</div>'
  }

  <section class="card">
    <h2>先结论</h2>
    <p class="one-line">${escapeHtml(report.synthesis.oneLine)}</p>
    <span class="tier tier-${report.synthesis.tier}">${escapeHtml(DEBRIEF_TIER_LABEL[report.synthesis.tier])}</span>
    <p>${escapeHtml(report.synthesis.verdictParagraph)}</p>
    <div class="next-action"><b>下一步（只有这一件）</b>${escapeHtml(report.synthesis.nextAction)}</div>
  </section>

  ${
    highlights
      ? `<section class="card"><h2>一处速览</h2><ul>${highlights}</ul></section>`
      : ''
  }

  <section class="card">
    <h2>可视化</h2>
    <div class="charts">
      ${radarSvg({ title: '压力来源分布', series: report.charts.pressure, note: '「—」表示材料里没有依据；空轴不参与连线，不用 0 伪造。' })}
      ${radarSvg({ title: '个体适配度', series: report.charts.fit })}
      ${radarSvg({ title: '面试表现', series: report.charts.performance })}
    </div>
    ${tableBlock(
      '工作量时间测算',
      report.charts.workloadTime,
      [
        { key: 'perItemSeconds', label: '单件耗时（秒）' },
        { key: 'pureMinutes', label: '纯处理（分钟）' },
        { key: 'remainingMinutes', label: '剩余（分钟）' },
        { key: 'feasibility', label: '可行性' },
      ],
    )}
    ${tableBlock(
      '单位时间回报测算',
      report.charts.compensation,
      [
        { key: 'scenario', label: '情景' },
        { key: 'monthlyIncome', label: '月收入' },
        { key: 'workDays', label: '月工作天数' },
        { key: 'dailyHours', label: '每日时长' },
        { key: 'hourly', label: '元/小时' },
      ],
    )}
  </section>

  <section class="card">
    <h2>面试表现</h2>
    <p class="lead">${escapeHtml(PERFORMANCE_OVERALL_LABEL[performanceSummary.overall])}</p>
    <p class="formula">回答 ${performanceSummary.answerTurns} 段 · 含可核对事实 ${performanceSummary.factBackedTurns} 段 · 只有评价性表述 ${
      performanceSummary.vagueTurns
    } 段</p>
    ${
      performanceSummary.strengths.length
        ? `<div class="sub"><span class="sub-title">站得住的部分</span><ul>${performanceSummary.strengths
            .map((s) => `<li>${escapeHtml(s)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
    ${
      performanceSummary.weaknesses.length
        ? `<div class="sub"><span class="sub-title">可以更好的部分</span><ul>${performanceSummary.weaknesses
            .map((w) => `<li>${escapeHtml(w)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
    ${
      performanceSummary.improvable.length
        ? `<div class="sub"><span class="sub-title">怎么改</span><ul>${performanceSummary.improvable
            .map((i) => `<li><b>${escapeHtml(i.point)}</b>：${escapeHtml(i.howTo)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
  </section>

  <section class="card">
    <h2>岗位适配度</h2>
    <p class="lead">${escapeHtml(fit.summary)}</p>
    ${
      fit.items.length
        ? `<div class="table-wrap"><table><thead><tr><th>适配维度</th><th>评分</th><th>依据</th></tr></thead><tbody>${fit.items
            .map(
              (i) =>
                `<tr><td data-label="适配维度">${escapeHtml(i.label)}${i.touchedBoundary ? ' <span class="tag bad">触碰边界</span>' : ''}</td><td data-label="评分">${
                  i.score ?? '—'
                }/5</td><td data-label="依据">${escapeHtml(i.reason)}</td></tr>`,
            )
            .join('')}</tbody></table></div>`
        : ''
    }
    ${
      fit.boundaryHits.length
        ? `<div class="notice">有 ${fit.boundaryHits.length} 项命中了你写下的偏好 / 边界：${escapeHtml(fit.boundaryHits.join('、'))}。报告只做提示，取舍由你决定。</div>`
        : ''
    }
  </section>

  <section class="card">
    <h2>机会侧：这个岗位实际是什么样</h2>
    ${opportunity.map((d) => dimensionSection(d, index)).join('')}
  </section>

  <section class="card">
    <h2>表现侧：我这次答得怎么样</h2>
    ${performance.map((d) => dimensionSection(d, index)).join('')}
  </section>

  ${
    questionGroups
      ? `<section class="card"><h2>还需要问清的问题</h2>${questionGroups}</section>`
      : ''
  }

  <section class="card">
    <h2>三档决策表</h2>
    ${decisionTable}
    ${scenarios ? `<div style="margin-top:16px"><h2>三种情景推演</h2>${scenarios}</div>` : ''}
  </section>

  ${
    report.meta.limitations.length
      ? `<section class="card"><h2>这份报告的局限</h2><ul>${report.meta.limitations
          .map((l) => `<li>${escapeHtml(l)}</li>`)
          .join('')}</ul></section>`
      : ''
  }

  <section class="card">
    <h2>附录：证据索引</h2>
    <p class="sub" style="color:#64748b">下面是报告里引用过的全部原子事实。所有结论都只能来自这里。</p>
    ${report.evidence.length ? evidenceTable : '<p class="empty-chart">没有抽出可用事实。</p>'}
  </section>

  <p class="footer">${escapeHtml(report.disclaimer)}<br>${escapeHtml(report.synthesis.boundaryStatement)}</p>
</div>
<script type="application/json" id="report-data">${safeJsonForScript(report)}</script>
</body>
</html>`;
}

/** 报告文件名：带日期与岗位，方便归档 */
export function debriefHtmlFileName(report: InterviewDebriefReport): string {
  const date = report.createdAt.slice(0, 10);
  const title = (report.jobTitle ?? '面试复盘').replace(/[\\/:*?"<>|\s]+/g, '-');
  return `面试复盘-${title}-${date}.html`;
}
