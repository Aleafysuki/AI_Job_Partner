import { ASSESSMENT_LABEL } from '../domain/common';
import type { Assessment } from '../domain/common';
import type { CandidateProfile } from '../domain/profile';
import type { RequirementMatch } from '../domain/match';
import type { EvidenceHit } from '../domain/match';

/**
 * 简历修改建议（v0.3 `resume.suggestion`）
 * ======================================
 *
 * **只针对具体岗位**，不给通用模板。
 *
 * 为什么不给模板：网上已经有大量「简历怎么写」的通用建议，
 * 再产出一份没有信息量的清单只会稀释用户的注意力。
 * 真正有用的只有一件事 —— 「针对**这一个岗位**，你这份简历的具体哪几行
 * 会让面试官划过去」。
 *
 * ── 四条硬约束 ──
 *
 * 1. **绝不虚构经历。** 建议只能是「把你已有的事写成另一种说法」，
 *    绝不能是「建议你补一个 Redis 项目」。后者是替用户编造，
 *    而编造出来的内容在面试的第二个问题就会崩。
 *    所以每条建议都必须指向**用户已经写过的东西**。
 *
 * 2. **给出可直接用的句子，但要标出它是从哪句话改来的。**
 *    给了改写句却不说出处，用户会以为是凭空建议；
 *    给了出处，用户能自己判断「我本来想表达的是不是这个意思」。
 *
 * 3. **不评价用户的经历够不够。** 这与铁律 `restrict.auto_resume_rewrite`
 *    （全自动修改简历）是同一件事的两端：产品可以帮你把话说清楚，
 *    但不能替你决定说什么、以及该不该去争取某个岗位。
 *
 * 4. **按「面试官会不会在这里划走」排序**，而不是按结论的严重程度。
 *    一条 `gap` 但排在简历最末尾，杀伤力远小于一条 `partial`
 *    出现在第一行自我介绍里。
 */

export type SuggestionKind = 'rewrite' | 'evidence_missing' | 'order' | 'drop';

export const SUGGESTION_KIND_LABEL: Record<SuggestionKind, string> = {
  rewrite: '换个说法',
  evidence_missing: '把已有的事补进这一段',
  order: '换个位置',
  drop: '考虑删掉',
};

export const SUGGESTION_KIND_WHY: Record<SuggestionKind, string> = {
  rewrite: '你说的是同一件事，但用词没对上岗位的关键词，搜简历的人扫不到。',
  evidence_missing: '这一段已有内容，但没提到这条要求对应的能力。没有新造经历，只是把你做过的事挪到了正确的地方。',
  order: '这一条在简历里的位置不够靠前，而它恰好是这条要求对应的部分。',
  drop: '这一段与会面无关，占了本该给相关内容的位置。',
};

/** 一条建议 */
export interface ResumeSuggestion {
  kind: SuggestionKind;
  /** 关联到哪条岗位要求 */
  requirementId: string;
  /** 要求原文 —— 用户要能核对系统在说什么 */
  requirementText: string;
  /** 这一条对应的结论 */
  assessment: Assessment;
  /** 建议做什么 */
  suggestion: string;
  /**
   * **用户已有的那一句**（原文）。
   * 必须是原文，不是归纳 —— 只有原文才能被用户核对。
   * `null` 表示没有可改写的原句（这时 suggestion 只能是「补证据」类）。
   */
  fromQuote?: string;
  /** 建议的句子。有原句时才有意义 */
  toQuote?: string;
  /** 建议改在哪一段 */
  where: '开头' | '技能段' | '项目段' | '经历段';
  /** 严重度。只影响排序，不给分数 */
  severity: 'high' | 'medium' | 'low';
}

export interface ResumeAdvice {
  suggestions: ResumeSuggestion[];
  /** 一句话说明这批建议的依据 */
  basis: string;
  /** 明确不做的事 */
  disclaimer: string;
}

export const RESUME_ADVICE_DISCLAIMER =
  '这里只建议「把你已经做过的事说得更清楚」，不会替你编造任何经历，' +
  '也不会替你决定该不该投这个岗位。要不要改、改到什么程度，由你判断。';

/**
 * 把用户自己的话改写成更贴岗位的表述。
 *
 * 关键约束：**只在原句里换词，不加新信息**。
 * 实现上体现为「原句中已有的词」与「要求里的词」之间的对齐，
 * 而不是生成新句子 —— 后者必然引入原句里没有的信息。
 */
function rewriteFromQuote(quote: string, requirement: RequirementMatch): { to: string; ok: boolean } {
  const keywords = requirement.matchedSkills.length > 0 ? requirement.matchedSkills : [];

  // 找到原句里最长的一段，确认它在讲一件具体的事
  if (quote.trim().length < 8) return { to: quote, ok: false };

  if (keywords.length === 0) {
    // 没有已匹配的技能名可换 —— 这时不该改写，只该提示「这条没提到」
    return { to: quote, ok: false };
  }

  // 已经提到了关键词就不必改写
  const hasKeyword = keywords.some((k) => quote.toLowerCase().includes(k.toLowerCase()));
  if (hasKeyword) return { to: quote, ok: false };

  // 在原句开头加一个「限定语」，把这件事挂到关键词上。
  // 这样做的理由：简历扫读时关键词匹配是硬指标，而
  // 「做过 Redis」比「做过一个缓存相关的项目」更容易被匹配到。
  const anchor = keywords[0];
  const prefix = `涉及${anchor}：`;
  return { to: prefix + quote.replace(/^[，。、\s]*/, ''), ok: true };
}

/**
 * 判断一段证据属于简历的哪一段。
 *
 * 按 `origin` 而不是按 kind —— origin 说的是「这段话从哪来」，
 * 而简历的段落结构正是按来源分的（简历上的经历 → 经历段，
 * 问诊补的 → 技能段）。
 */
function whereOf(evidence: EvidenceHit): ResumeSuggestion['where'] {
  if (evidence.origin === 'import') return '项目段';
  if (evidence.origin === 'qa') return '技能段';
  if (evidence.origin === 'resume') return '项目段';
  return '经历段';
}

export function buildResumeAdvice(input: {
  profile: CandidateProfile;
  job: { id: string; title: string };
  matches: RequirementMatch[];
}): ResumeAdvice {
  const { matches } = input;

  // 只处理「未满足」的要求。已满足的没有必要改简历 ——
  // 用户的时间有限，改动应该全部花在缺口上。
  const gaps = matches.filter((m) => m.assessment !== 'matched');

  if (gaps.length === 0) {
    return {
      suggestions: [],
      basis: '按当前这个岗位的结论，你档案里已有的证据能逐条对应上，没有需要改的地方。',
      disclaimer: RESUME_ADVICE_DISCLAIMER,
    };
  }

  const suggestions: ResumeSuggestion[] = [];

  for (const m of gaps) {
    // ---- 优先级 1：能把已有内容挪到这条要求上 ----
    const reusable = m.evidence.length > 0 ? m.evidence : [];
    if (reusable.length > 0) {
      const first = reusable[0];
      const { to, ok } = rewriteFromQuote(first.content, m);
      if (ok) {
        suggestions.push({
          kind: 'rewrite',
          requirementId: m.requirementId,
          requirementText: m.requirement,
          assessment: m.assessment,
          suggestion: `你已经写过这件事，但那句话里没有出现「${
            (m.matchedSkills.length > 0 ? m.matchedSkills : m.missingSkills).slice(0, 2).join('、') || '岗位关键词'
          }」。把它写进原句里，简历扫读时才匹配得到。`,
          fromQuote: first.content,
          toQuote: to,
          where: whereOf(first),
          severity: m.hardGate ? 'high' : m.assessment === 'gap' ? 'high' : 'medium',
        });
        continue;
      }
    }

    // ---- 优先级 2：档案里确实没有任何相关证据 ----
    // 这里**绝不能**建议「补一个项目」——
    // 那是替用户编造，而编造的内容在面试第二个问题就会崩。
    // 只能说「你已有的哪段经历可以跟这条挂上」，或者明确说「这条只能你自己判断」。
    suggestions.push({
      kind: 'evidence_missing',
      requirementId: m.requirementId,
      requirementText: m.requirement,
      assessment: m.assessment,
      suggestion:
        m.assessment === 'gap'
          ? '档案里没有任何材料能对应到这一条。如果这条确实是硬要求，只有两个选择：' +
            '把真实相关的经历补进档案，或者不投。**不要为了凑上去编一段经历** —— ' +
            '编出来的东西在面试的第一个追问下就会崩。'
          : '档案里没有直接对应的材料。先看看你其它经历里有没有能挂上这条的' +
            '（系统无法替你判断，这需要你自己回想），确实有就补进档案；没有就不要写在简历里。',
      where: '项目段',
      severity: m.assessment === 'gap' || m.hardGate ? 'high' : 'medium',
    });
  }

  // ---- 排序：严重度优先，同严重度按岗位要求顺序 ----
  const sevRank: Record<ResumeSuggestion['severity'], number> = { high: 0, medium: 1, low: 2 };
  const order = new Map(matches.map((m, i) => [m.requirementId, i]));
  suggestions.sort(
    (a, b) =>
      sevRank[a.severity] - sevRank[b.severity] ||
      (order.get(a.requirementId) ?? 99) - (order.get(b.requirementId) ?? 99),
  );

  const gapCount = gaps.filter((m) => m.assessment === 'gap').length;
  const weakCount = gaps.filter((m) => m.assessment === 'lacking_evidence').length;
  const partialCount = gaps.filter((m) => m.assessment === 'partial').length;

  const basisParts = [
    gapCount > 0 ? `${gapCount} 条明显缺口` : '',
    weakCount > 0 ? `${weakCount} 条缺少证据` : '',
    partialCount > 0 ? `${partialCount} 条没讲到位` : '',
  ].filter(Boolean);

  return {
    suggestions,
    basis: `针对${input.job.title}这一份简历：${basisParts.join('、')}。建议按顺序改，前面的改动收益最大。`,
    disclaimer: RESUME_ADVICE_DISCLAIMER,
  };
}

export { ASSESSMENT_LABEL };