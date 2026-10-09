import { ASSESSMENT_LABEL } from '../domain/common';
import type { PriorityAction, RequirementMatch } from '../domain/match';
import type { AnalysisReport } from '../domain/report';

/**
 * 匹配报告导出（v0.3 `report.export`）
 * ================================
 *
 * 与复盘报告导出（debrief-render.ts）是同一套约束，但**不是**同一份实现：
 * 两份报告的字段完全不同（复盘是 18 维 + 决策表，匹配是 5 结论 + 优先动作），
 * 强行抽公共渲染器会得到一个「什么都能渲染一点、什么都不太对」的东西。
 * 复用**样式常量**（escapeHtml、打印样式），不复用结构。
 *
 * 三条硬约束：
 *
 * 1. **自包含离线 HTML**：内联全部 CSS，不依赖任何 CDN。
 *    这与复盘导出同源 —— 报告会被发给面试官或存进网盘，
 *    打开时没有网络的场合比有网络的场合多。
 *
 * 2. **不提供 0–100 匹配分**。导出件最容易在传播中被简化成「他匹配度 78%」，
 *    而这个数字在原产品里就被明确否决过 —— 所以这里连一个百分数都不出现。
 *
 * 3. **免责声明必须印在正文里，不能只放在页脚**。
 *    页脚会被截图裁掉，而这份文件最常见的传播方式恰恰是截图。
 */

export interface RenderReportOptions {
  /** 副标题，例如「由本地规则引擎生成」 */
  subtitle?: string;
  /** 是否附带结构化 JSON。默认 false —— JSON 是给机器读的 */
  includeJson?: boolean;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 五种结论的展示顺序：不是按数量，是按「离录用有多远」 */
const VERDICT_ORDER: RequirementMatch['assessment'][] = ['gap', 'lacking_evidence', 'partial', 'unknown', 'matched'];

const VERDICT_TONE: Record<RequirementMatch['assessment'], string> = {
  gap: 'verdict-gap',
  lacking_evidence: 'verdict-weak',
  partial: 'verdict-partial',
  unknown: 'verdict-unknown',
  matched: 'verdict-matched',
};

export function renderMatchReportHtml(report: AnalysisReport, options: RenderReportOptions = {}): string {
  const grouped = new Map<RequirementMatch['assessment'], RequirementMatch[]>();
  for (const m of report.matches) {
    const list = grouped.get(m.assessment) ?? [];
    list.push(m);
    grouped.set(m.assessment, list);
  }

  // 概览：按 VERDICT_ORDER 排列，缺的结论也列出（0 条也是信息）
  const overview = VERDICT_ORDER.filter((v) => (grouped.get(v)?.length ?? 0) > 0)
    .map((v) => {
      const list = grouped.get(v) ?? [];
      return `<div class="ov-card ${VERDICT_TONE[v]}">
        <div class="ov-num">${list.length}</div>
        <div class="ov-label">${escapeHtml(ASSESSMENT_LABEL[v])}</div>
      </div>`;
    })
    .join('');

  const sections = VERDICT_ORDER.filter((v) => (grouped.get(v)?.length ?? 0) > 0)
    .map((v) => {
      const list = grouped.get(v) ?? [];
      const rows = list
        .map((m) => {
          // 引用证据的**原文**，不给「你具备 X 能力」这类归纳 ——
          // 归纳是系统下的判断，原文才是能被对方核对的东西。
          const evidence = m.evidence.length
            ? m.evidence
                .map((e) => `<span class="ev">${escapeHtml(e.title || e.evidenceId)}</span>`)
                .join(' ')
            : '<span class="none">没有可引用的证据</span>';
          const why = m.reason ? `<p class="why">${escapeHtml(m.reason)}</p>` : '';
          return `<tr>
            <td data-label="要求"><strong>${escapeHtml(m.requirement)}</strong>${
              m.hardGate ? ' <span class="gate">硬门槛</span>' : ''
            }</td>
            <td data-label="结论"><span class="pill ${VERDICT_TONE[v]}">${escapeHtml(ASSESSMENT_LABEL[v])}</span></td>
            <td data-label="依据">${why}${evidence}</td>
          </tr>`;
        })
        .join('');
      return `<section class="sec">
        <h2>${escapeHtml(ASSESSMENT_LABEL[v])}<span class="sec-num">${list.length} 条</span></h2>
        <div class="table-wrap"><table>
          <thead><tr><th>岗位要求</th><th>结论</th><th>依据</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </section>`;
    })
    .join('');

  const priorities =
    report.priorities.length === 0
      ? '<p class="none">没有需要优先处理的动作。</p>'
      : `<ol class="pri">${report.priorities
          .map(
            (p: PriorityAction) =>
              `<li>
                <strong>${escapeHtml(p.title)}</strong>
                <span class="effort">${escapeHtml(p.effort)}</span>
                <p class="why">${escapeHtml(p.why)}</p>
                <p class="how">${escapeHtml(p.how)}</p>
              </li>`,
          )
          .join('')}</ol>`;

  const risks =
    report.riskNotes.length === 0
      ? ''
      : `<section class="sec"><h2>可能的筛选风险</h2><ul class="risk">${report.riskNotes
          .map((r) => `<li>${escapeHtml(r)}</li>`)
          .join('')}</ul></section>`;

  const jsonBlock = options.includeJson
    ? `<section class="sec"><h2>结构化数据（JSON）</h2><pre class="json">${escapeHtml(JSON.stringify(report, null, 2))}</pre></section>`
    : '';

  const css = REPORT_CSS;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.job.title || '岗位')} · 匹配报告</title>
<style>${css}</style>
</head>
<body>
<header class="head">
  <div class="head-tag">能力匹配报告</div>
  <h1>${escapeHtml(report.headline)}</h1>
  <div class="head-meta">
    <span>档案：${escapeHtml(report.profile.displayName)}（${report.profile.skillCount} 技能 / ${report.profile.evidenceCount} 证据，其中 ${report.profile.strongEvidenceCount} 条可核对）</span>
    <span>岗位：${escapeHtml(report.job.title)}${report.job.company ? ` · ${escapeHtml(report.job.company)}` : ''}（${report.job.requirementCount} 条要求，其中硬门槛 ${report.job.hardGateCount} 条）</span>
    <span>结论：满足 ${report.summary.matched} · 部分满足 ${report.summary.partial} · 缺少证据 ${report.summary.lackingEvidence} · 明显缺口 ${report.summary.gap} · 无法判断 ${report.summary.unknown}</span>
    <span>生成：${escapeHtml(options.subtitle ?? (report.usedModel ? '本地规则引擎 + 模型' : '本地规则引擎'))}</span>
  </div>
</header>

<section class="warn">
  ${escapeHtml(report.disclaimer)}
</section>

<section class="sec">
  <h2>结论分布</h2>
  <div class="overview">${overview}</div>
  <p class="note">刻意不给 0–100 的匹配分：这五条是离散结论，
  合成一个数字之后，权重就成了隐藏的产品判断，用户无法反驳它。</p>
</section>

${sections}

<section class="sec">
  <h2>优先做什么</h2>
  ${priorities}
</section>

${risks}
${jsonBlock}

<footer class="foot">
  <p>本报告描述的是「你提供的证据能否支撑该岗位要求」，不代表招聘方的实际筛选结果。</p>
  <p>由 AI Job Partner 生成于本机 · 数据未上传</p>
</footer>
</body>
</html>`;
}

export function matchReportFileName(report: AnalysisReport): string {
  const job = (report.job.title || '岗位').replace(/[\\/:*?"<>|]/g, '_');
  const date = report.createdAt.slice(0, 10);
  return `匹配报告-${job}-${date}.html`;
}

/**
 * 打印样式。
 *
 * 单独拎成常量是因为它比正文样式长得多，且**只有这一份** ——
 * 复盘导出的样式结构不同，硬合并会得到一堆互相覆盖的选择器。
 */
const REPORT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px 20px 60px;
  font: 15px/1.7 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #1e293b;
  background: #f8fafc;
}
.head { margin-bottom: 20px; }
.head-tag {
  display: inline-block; padding: 2px 9px; border-radius: 999px;
  background: #2563eb; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: .08em;
}
.head h1 { margin: 10px 0 0; font-size: 26px; line-height: 1.3; font-weight: 700; }
.head-meta { margin-top: 10px; display: flex; flex-direction: column; gap: 3px; font-size: 12.5px; color: #64748b; }
.warn {
  padding: 12px 14px; border-radius: 8px; font-size: 13px; line-height: 1.7;
  background: #fffbeb; border: 1px solid #fde68a; color: #78350f; margin-bottom: 22px;
}
.sec { margin-bottom: 24px; }
.sec h2 {
  margin: 0 0 10px; font-size: 16px; font-weight: 700;
  padding-bottom: 6px; border-bottom: 1px solid #e2e8f0;
}
.sec-num { margin-left: 8px; font-size: 12px; font-weight: 400; color: #94a3b8; }
.overview { display: flex; flex-wrap: wrap; gap: 8px; }
.ov-card {
  flex: 1 1 110px; padding: 12px; border-radius: 8px;
  background: #fff; border: 1px solid #e2e8f0; border-top-width: 3px;
}
.ov-num { font-size: 24px; font-weight: 700; line-height: 1.1; }
.ov-label { margin-top: 4px; font-size: 12px; color: #64748b; }
.verdict-gap { border-top-color: #dc2626; }
.verdict-weak { border-top-color: #d97706; }
.verdict-partial { border-top-color: #ca8a04; }
.verdict-unknown { border-top-color: #94a3b8; }
.verdict-matched { border-top-color: #16a34a; }
.table-wrap { overflow-x: auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
th { background: #f8fafc; font-size: 12px; font-weight: 600; color: #64748b; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
.pill {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; color: #fff; white-space: nowrap;
}
.pill.verdict-gap { background: #dc2626; }
.pill.verdict-weak { background: #d97706; }
.pill.verdict-partial { background: #ca8a04; }
.pill.verdict-unknown { background: #94a3b8; }
.pill.verdict-matched { background: #16a34a; }
.why { margin: 0 0 4px; color: #475569; }
.ev {
  display: inline-block; margin: 1px 3px 1px 0; padding: 0 6px;
  border-radius: 4px; background: #eff6ff; color: #1d4ed8; font-size: 11px;
}
.gate {
  display: inline-block; margin-left: 5px; padding: 0 5px; border-radius: 3px;
  background: #fee2e2; color: #991b1b; font-size: 10.5px; font-weight: 600;
}
.effort { margin-left: 7px; font-size: 11px; color: #94a3b8; }
.how { margin: 3px 0 0; font-size: 12.5px; color: #475569; }
.none { color: #94a3b8; font-style: italic; }
.pri { margin: 0; padding-left: 1.3rem; }
.pri li { margin-bottom: 7px; }
.risk { margin: 0; padding-left: 1.3rem; }
.risk li { margin-bottom: 5px; color: #475569; }
.note { margin: 10px 0 0; font-size: 12px; color: #94a3b8; line-height: 1.7; }
.json {
  max-height: 340px; overflow: auto; padding: 12px; border-radius: 8px;
  background: #0f172a; color: #e2e8f0; font-size: 11.5px; line-height: 1.6;
}
.foot {
  margin-top: 30px; padding-top: 14px; border-top: 1px solid #e2e8f0;
  font-size: 12px; color: #94a3b8; line-height: 1.7;
}
.foot p { margin: 0 0 3px; }
@media print {
  body { background: #fff; padding: 0; font-size: 12px; }
  .sec { break-inside: avoid; page-break-inside: avoid; }
  .table-wrap { overflow: visible; }
}
@media (max-width: 560px) {
  body { padding: 16px 12px 40px; }
  .head h1 { font-size: 21px; }
  /* 窄屏下表格转成键值对 —— 横向滚动的表在手机上等于读不了 */
  th { display: none; }
  td { display: block; border-bottom: 1px solid #e2e8f0; }
  td::before {
    content: attr(data-label); display: block; margin-bottom: 2px;
    font-size: 11px; font-weight: 600; color: #94a3b8;
  }
}
`;