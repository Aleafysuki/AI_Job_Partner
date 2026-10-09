import { AiGateway } from '../ai/gateway';
import { MATCH_SYSTEM_PROMPT } from '../ai/prompts';
import type { AiMessage, AiTrace } from '../domain/ai-trace';
import type { Assessment, EvidenceStrength, TriLevel } from '../domain/common';
import { maxStrength } from '../domain/common';
import type { CandidateEvidence } from '../domain/evidence';
import type { JobRequirement, RequirementItem } from '../domain/job';
import type { CandidateProfile } from '../domain/profile';
import {
  emptySummary,
  summarize,
  type EvidenceHit,
  type ExplainStep,
  type MatchResult,
  type PriorityAction,
  type RequirementMatch,
} from '../domain/match';
import { textMentionsSkill } from '../nlp/skills';
import { similarity, truncate, unique } from '../utils/text';

/**
 * MatchingEngine —— 产品的核心判断层。
 *
 * 刻意不做的事：不做「关键词出现即得分」。
 * 关键词只用来「找到候选证据」，能不能判为满足取决于证据的类型与强度：
 *
 *   - 自我声明（self_claim）永远不能单独支撑「满足」，最多算「缺少证据」；
 *   - 项目 / 工作 / 开源类证据且强度 ≥ medium，才可能判为「满足」；
 *   - 硬门槛（学历 / 年限 / 证书）用独立规则判断，不允许被软性表述绕过。
 */

const REAL_EVIDENCE_KINDS: CandidateEvidence['kind'][] = ['project', 'work', 'open_source', 'competition', 'certificate'];

const DEGREE_RANK: Record<string, number> = { 博士: 4, 硕士: 3, 研究生: 3, 本科: 2, 学士: 2, 大专: 1, 专科: 1, 高中: 0, 中专: 0 };

function degreeRank(text: string): number | null {
  for (const key of Object.keys(DEGREE_RANK)) {
    if (text.includes(key)) return DEGREE_RANK[key];
  }
  return null;
}

/** 从工作经历的时间范围估算总年限 */
function estimateYears(profile: CandidateProfile): number | null {
  if (typeof profile.basics.yearsOfExperience === 'number') return profile.basics.yearsOfExperience;
  const years: number[] = [];
  for (const exp of profile.experiences) {
    if (!exp.timeRange) continue;
    const nums = exp.timeRange.match(/(?:19|20)\d{2}/g);
    if (!nums || nums.length === 0) continue;
    const start = Number(nums[0]);
    const end = exp.timeRange.includes('至今') || exp.timeRange.includes('现在') || exp.timeRange.includes('目前')
      ? new Date().getFullYear()
      : Number(nums[nums.length - 1]);
    if (end >= start) years.push(end - start);
  }
  if (years.length === 0) return null;
  return years.reduce((a, b) => a + b, 0);
}

interface EvidenceMatch {
  hits: EvidenceHit[];
  matchedSkills: string[];
  missingSkills: string[];
  /** 证据对这条要求的覆盖度 0~1 */
  coverage: number;
}

function findEvidenceFor(requirement: RequirementItem, profile: CandidateProfile): EvidenceMatch {
  const hits: EvidenceHit[] = [];
  const requirementSkills = requirement.keywords.length > 0
    ? requirement.keywords
    : unique(profile.skills.filter((s) => textMentionsSkill(s.name, requirement.content)).map((s) => s.name));

  const matchedSkills: string[] = [];

  for (const evidence of profile.evidence) {
    const reasons: string[] = [];
    for (const skill of requirementSkills) {
      if (evidence.skills.includes(skill)) {
        matchedSkills.push(skill);
        reasons.push(`证据中标注了「${skill}」`);
      } else if (textMentionsSkill(skill, evidence.title) || textMentionsSkill(skill, evidence.content)) {
        matchedSkills.push(skill);
        reasons.push(`证据正文提到「${skill}」`);
      }
    }

    // 没有任何关键词时（例如软技能要求），退化为文本相似度
    let sim = 0;
    if (requirementSkills.length === 0) {
      sim = similarity(requirement.content, `${evidence.title} ${evidence.content}`);
      if (sim >= 0.16) reasons.push(`表述与这条要求高度相关（相似度 ${(sim * 100).toFixed(0)}%）`);
    }

    if (reasons.length === 0) continue;

    hits.push({
      evidenceId: evidence.id,
      kind: evidence.kind,
      title: evidence.title,
      content: truncate(evidence.content, 160),
      strength: evidence.strength,
      origin: evidence.origin ?? 'resume',
      linkReason: unique(reasons).join('；'),
    });
  }

  // 强证据优先，其次按证据强度排序
  hits.sort((a, b) => {
    const realA = REAL_EVIDENCE_KINDS.includes(a.kind) ? 1 : 0;
    const realB = REAL_EVIDENCE_KINDS.includes(b.kind) ? 1 : 0;
    if (realA !== realB) return realB - realA;
    const rank = (s: EvidenceStrength) => ({ none: 0, weak: 1, medium: 2, strong: 3 }[s]);
    return rank(b.strength) - rank(a.strength);
  });

  const coverage = requirementSkills.length === 0
    ? (hits.some((h) => REAL_EVIDENCE_KINDS.includes(h.kind)) ? 1 : hits.length > 0 ? 0.4 : 0)
    : matchedSkills.length / requirementSkills.length;

  const missingSkills = requirementSkills.filter((s) => !matchedSkills.includes(s));

  return { hits: hits.slice(0, 6), matchedSkills: unique(matchedSkills), missingSkills, coverage };
}

/** 专业大类。用于判断「计算机科学与技术」是否属于岗位要求的「计算机相关专业」 */
const MAJOR_FAMILIES: string[][] = [
  ['计算机', '软件', '信息', '人工智能', '数据', '网络', '电子', '通信', '自动化', '智能', '物联网', '信息安全'],
  ['市场', '营销', '广告', '传播', '新闻', '中文', '传媒', '汉语言'],
  ['经济', '金融', '会计', '财务', '国贸', '审计', '统计'],
  ['设计', '美术', '视觉', '艺术', '工业设计', '数字媒体'],
  ['教育', '师范', '心理', '教育技术'],
  ['机械', '材料', '土木', '化工', '能源', '制造'],
  ['管理', '工商', '人力资源', '行政', '物流'],
];

function majorFamily(text: string): number | null {
  for (let i = 0; i < MAJOR_FAMILIES.length; i += 1) {
    if (MAJOR_FAMILIES[i].some((term) => text.includes(term))) return i;
  }
  return null;
}

const ASSESSMENT_SEVERITY: Record<Assessment, number> = {
  matched: 0,
  partial: 1,
  unknown: 2,
  lacking_evidence: 3,
  gap: 4,
};

interface SubJudgement {
  assessment: Assessment;
  reason: string;
  action: string | null;
}

function judgeEducation(requirement: RequirementItem, profile: CandidateProfile): SubJudgement {
  const checks: SubJudgement[] = [];
  const profileDegreeText = profile.basics.educationLevel || profile.education.map((e) => e.degree ?? '').join(' ');

  // ---- 学历层级 ----
  const needRank = degreeRank(requirement.content);
  if (needRank !== null) {
    const hasRank = degreeRank(profileDegreeText);
    if (hasRank === null) {
      checks.push({
        assessment: 'lacking_evidence',
        reason: '档案里没有学历信息，无法判断是否达到学历要求',
        action: '在档案基本信息里补上学历（本科 / 硕士 …），这条立刻就能判断',
      });
    } else if (hasRank >= needRank) {
      checks.push({
        assessment: 'matched',
        reason: `档案学历（${profile.basics.educationLevel || '已记录'}）达到岗位要求层级`,
        action: null,
      });
    } else {
      checks.push({
        assessment: 'gap',
        reason: `岗位要求学历层级高于档案记录（档案：${profile.basics.educationLevel || '已记录'}）`,
        action: '属于客观门槛。建议优先投递学历要求匹配的岗位，不要在这类岗位上消耗精力',
      });
    }
  }

  // ---- 专业对口 ----
  if (/专业/.test(requirement.content)) {
    const majors = profile.education.map((e) => e.major).filter(Boolean) as string[];
    if (majors.length === 0) {
      checks.push({
        assessment: 'lacking_evidence',
        reason: '档案里没有填写专业，无法判断专业是否符合要求',
        action: '在教育背景里补上专业名称',
      });
    } else {
      const needFamily = majorFamily(requirement.content);
      const hasFamily = majors.map((m) => majorFamily(m)).find((f) => f !== null) ?? null;
      if (needFamily !== null && hasFamily !== null && needFamily === hasFamily) {
        checks.push({
          assessment: 'matched',
          reason: `专业方向匹配（档案：${majors.join('、')}）`,
          action: null,
        });
      } else if (needFamily !== null && hasFamily !== null) {
        checks.push({
          assessment: 'gap',
          reason: `岗位限定的专业方向与档案专业不一致（档案：${majors.join('、')}）`,
          action: '如果岗位严格限定专业，投递优先级应下调；如有辅修或相关课程可以在简历里说明',
        });
      } else {
        checks.push({
          assessment: 'unknown',
          reason: '无法判断专业是否对口，建议面试前向对方确认专业口径',
          action: '面试前确认「专业是否放宽」',
        });
      }
    }
  }

  if (checks.length === 0) {
    return {
      assessment: 'unknown',
      reason: '这条学历要求表述模糊，提取不到明确的学历或专业口径',
      action: '面试前向对方确认学历要求的具体口径',
    };
  }

  // 一条要求可能同时含学历与专业，取更严重的那个作为结论
  const worst = checks.reduce((acc, cur) =>
    ASSESSMENT_SEVERITY[cur.assessment] > ASSESSMENT_SEVERITY[acc.assessment] ? cur : acc,
  );
  const reason = checks.length === 1 ? worst.reason : checks.map((c) => c.reason).join('；');
  const action = worst.action ?? checks.find((c) => c.action)?.action ?? null;
  return { assessment: worst.assessment, reason, action };
}

function judgeExperienceYears(requirement: RequirementItem, profile: CandidateProfile): { assessment: Assessment; reason: string; action: string | null } | null {
  const need = /(\d{1,2})\s*年/.exec(requirement.content);
  if (!need) return null;
  const needYears = Number(need[1]);
  const have = estimateYears(profile);
  if (have === null) {
    return { assessment: 'lacking_evidence', reason: '简历中缺少完整的时间范围，无法计算工作年限', action: '给每段工作/项目补上起止时间' };
  }
  if (have >= needYears) {
    return { assessment: 'matched', reason: `档案中可推算的经验约 ${have} 年，达到 ${needYears} 年要求`, action: null };
  }
  return {
    assessment: 'gap',
    reason: `岗位要求 ${needYears} 年经验，档案中可推算约 ${have} 年`,
    action: '年限差距靠简历无法解决。如果实际经验被低估，先把项目时间与产出补全；否则应转向年限要求更低的岗位',
  };
}

function judgeGeneric(
  requirement: RequirementItem,
  match: EvidenceMatch,
): { assessment: Assessment; reason: string; action: string | null; confidence: TriLevel } {
  const realHits = match.hits.filter((h) => REAL_EVIDENCE_KINDS.includes(h.kind));
  const realStrength = maxStrength(realHits.map((h) => h.strength));
  const anyStrength = maxStrength(match.hits.map((h) => h.strength));

  // 要求本身过短或过于模糊 → 无法判断
  if (requirement.content.replace(/\s/g, '').length < 5 && match.hits.length === 0) {
    return {
      assessment: 'unknown',
      reason: '这条要求太短、缺少可判断的要素',
      action: '在岗位上看到这条时，面试时可以主动确认对方具体指什么',
      confidence: 'low',
    };
  }

  if (match.hits.length === 0) {
    return {
      assessment: requirement.type === 'soft' || requirement.type === 'implicit' ? 'unknown' : 'gap',
      reason: requirement.keywords.length > 0
        ? `档案里找不到与「${requirement.keywords.join('、')}」相关的证据`
        : '档案里找不到与这条要求相关的经历',
      action: requirement.type === 'soft' || requirement.type === 'implicit'
        ? '软性要求通常在面试中体现，建议准备 1 个能说明这件事的真实例子'
        : `不要虚构。如果确实没有对应经历，优先补一个最小可交付的项目，把「${requirement.keywords[0] ?? '这块能力'}」变成可验证的产出`,
      confidence: 'high',
    };
  }

  if (realHits.length === 0) {
    return {
      assessment: 'lacking_evidence',
      reason: `你提到过相关能力，但现有支撑只有自我声明（${match.hits.map((h) => h.title).slice(0, 2).join('、')}），没有可核对的产出`,
      action: '把相关项目补进简历：写清做了什么、用了什么、产出了什么结果。一条带结果的描述就能把它从声明变成证据',
      confidence: 'high',
    };
  }

  if (match.coverage >= 0.6 && (realStrength === 'strong' || realStrength === 'medium')) {
    return {
      assessment: 'matched',
      reason: `存在直接证据：${realHits.map((h) => h.title).slice(0, 3).join('、')}（证据强度${realStrength === 'strong' ? '强' : '中'}）`,
      action: '这条已经站得住。面试时准备好被追问细节即可',
      confidence: realStrength === 'strong' ? 'high' : 'medium',
    };
  }

  if (realHits.length > 0) {
    const gaps = match.missingSkills.length > 0 ? `，但还缺 ${match.missingSkills.slice(0, 3).join('、')}` : '';
    return {
      assessment: 'partial',
      reason: `有相关经历（${realHits.map((h) => h.title).slice(0, 3).join('、')}），但覆盖度不足（${Math.round(match.coverage * 100)}%）${gaps}`,
      action: match.missingSkills.length > 0
        ? `在现成的经历里把 ${match.missingSkills.slice(0, 2).join('、')} 相关的部分写出来；如果确实没做过，如实保留缺口`
        : '把现有经历描述得更具体（场景 + 做法 + 结果），从「相关」升级到「直接支撑」',
      confidence: 'medium',
    };
  }

  return {
    assessment: 'unknown',
    reason: '证据与要求的关系不足以支撑判断',
    action: '补充更具体的项目描述可以让这条变可判断',
    confidence: 'low',
  };
}

function explainOf(requirement: RequirementItem, match: EvidenceMatch, assessment: Assessment): ExplainStep[] {
  const steps: ExplainStep[] = [
    {
      rule: '要求解析',
      detail: `类型 ${requirement.type}，重要度 ${requirement.importance}${requirement.hardGate ? '，且属于硬门槛' : ''}；识别出的能力：${requirement.keywords.length ? requirement.keywords.join('、') : '（无明确能力关键词）'}`,
    },
  ];
  steps.push({
    rule: '证据检索',
    detail: match.hits.length === 0
      ? '档案中没有检索到与该要求相关的证据'
      : `命中 ${match.hits.length} 条证据：${match.hits.map((h) => `${h.title}（${h.kind}·${h.strength}）`).join('；')}`,
  });
  if (match.matchedSkills.length > 0) {
    steps.push({ rule: '能力覆盖', detail: `已覆盖：${match.matchedSkills.join('、')}${match.missingSkills.length ? `；未覆盖：${match.missingSkills.join('、')}` : ''}` });
  }
  steps.push({
    rule: '判定规则',
    detail: {
      matched: '存在项目/工作类证据且强度达到 medium 以上，能力覆盖度达标',
      partial: '存在相关证据，但覆盖度不足或证据强度偏弱',
      lacking_evidence: '只有自我声明，缺少可核对的产出',
      gap: '档案中不存在相关证据',
      unknown: '要求表述模糊或关键信息缺失，不足以判断',
    }[assessment],
  });
  return steps;
}

/**
 * 把匹配结果汇总成「接下来该改什么」。
 *
 * 分两轮：
 *   第一轮只看高重要度要求和硬门槛 —— 这是必须优先处理的；
 *   第一轮为空时（说明岗位的高重要度要求都已经站得住）退到第二轮，
 *   把中重要度的未满足项也纳入，保证报告不会在没有结论可给的时候直接给出空列表。
 *   低重要度的加分项不进入清单，避免制造噪音。
 */
function buildPriorities(matches: RequirementMatch[]): PriorityAction[] {
  const make = (pool: RequirementMatch[]): PriorityAction[] => {
    const priorities: PriorityAction[] = [];

    const lack = pool.filter((m) => m.assessment === 'lacking_evidence');
    if (lack.length > 0) {
      priorities.push({
        title: `把已有经历补成证据（${lack.length} 条）`,
        why: '这些要求你已经提到过，但没有可核对的产出。这是投入产出比最高的改动——不需要新增能力，只需要把做过的事写清楚。',
        how: '对每条要求，从项目里找出对应的部分，按「场景 → 你做了什么 → 用什么方法 → 可量化的结果」重写一句话。没有数字就先写清交付物。',
        requirementIds: lack.map((m) => m.requirementId),
        effort: 'low',
      });
    }

    const gaps = pool.filter((m) => m.assessment === 'gap' && !m.hardGate);
    if (gaps.length > 0) {
      priorities.push({
        title: `补齐能力缺口（${gaps.length} 条）`,
        why: '这些能力在你的所有经历里都找不到痕迹，靠改写简历解决不了。',
        how: '挑其中 1–2 项做一个小而完整的产出（能跑、能演示、能讲清取舍），再写进档案。不要同时补 5 项，也不要虚构经历。',
        requirementIds: gaps.map((m) => m.requirementId),
        effort: 'high',
      });
    }

    const partial = pool.filter((m) => m.assessment === 'partial');
    if (partial.length > 0) {
      priorities.push({
        title: `把「相关」升级成「直接」（${partial.length} 条）`,
        why: '你已经沾边，但 HR 在初筛时更容易被直接对得上的描述说服。',
        how: '在现有经历里突出与岗位完全对应的部分，把无关细节压缩，让最强的那部分排在前面。',
        requirementIds: partial.map((m) => m.requirementId),
        effort: 'medium',
      });
    }

    const hardFail = pool.filter((m) => m.hardGate && m.assessment === 'gap');
    if (hardFail.length > 0) {
      priorities.push({
        title: `确认硬门槛是否可协商（${hardFail.length} 条）`,
        why: '硬门槛通常在简历初筛阶段直接过滤，改简历无法绕过。',
        how: '先通过内推、招聘方沟通等方式确认是否接受例外；如果明确不放松，把精力转到其他岗位。',
        requirementIds: hardFail.map((m) => m.requirementId),
        effort: 'low',
      });
    }

    const unknown = pool.filter((m) => m.assessment === 'unknown');
    if (unknown.length >= 2) {
      priorities.push({
        title: `确认这几条要求的实际口径（${unknown.length} 条）`,
        why: '这些要求原文表述模糊，系统无法判断你是否满足。猜错的成本高于问一句。',
        how: '整理成一句问题清单，在沟通或面试时直接问对方这几条具体指什么，再回来修正岗位拆解结果。',
        requirementIds: unknown.map((m) => m.requirementId),
        effort: 'low',
      });
    }

    return priorities;
  };

  const important = make(matches.filter((m) => m.importance === 'high' || m.hardGate));
  if (important.length > 0) return important.slice(0, 4);
  return make(matches.filter((m) => m.importance !== 'low')).slice(0, 4);
}

function buildRiskNotes(matches: RequirementMatch[], job: JobRequirement): string[] {
  const notes: string[] = [];
  const unknown = matches.filter((m) => m.assessment === 'unknown');
  if (unknown.length > 0) {
    notes.push(`有 ${unknown.length} 条要求被判为「无法判断」，通常是因为岗位原文表述模糊，或相关信息在脱敏后被移除。`);
  }
  const noEvidence = matches.filter((m) => m.assessment === 'gap' && m.hardGate);
  if (noEvidence.length > 0) {
    notes.push('结论中包含硬门槛不满足的情况，这类结论只反映你提供的信息，实际情况可能因内部推荐、岗位紧急度等因素不同。');
  }
  if (job.screenRisks.length > 0) {
    notes.push(...job.screenRisks);
  }
  return unique(notes).slice(0, 6);
}

// ---------------------------------------------------------------------------
// AI 结果合并
// ---------------------------------------------------------------------------

interface AiMatchPayload {
  matches?: Array<{
    requirementIndex?: number;
    assessment?: string;
    matchedSkills?: string[];
    missingSkills?: string[];
    evidenceIds?: string[];
    reason?: string;
    action?: string | null;
    confidence?: string;
  }>;
  riskNotes?: string[];
}

const VALID_ASSESSMENTS: Assessment[] = ['matched', 'partial', 'lacking_evidence', 'gap', 'unknown'];

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export interface MatchInput {
  profile: CandidateProfile;
  job: JobRequirement;
  gateway?: AiGateway | null;
  onMessages?: (messages: AiMessage[]) => void;
}

export interface MatchOutput {
  result: MatchResult;
  trace: AiTrace | null;
  engine: 'rule' | 'ai' | 'hybrid';
  warnings: string[];
}

export async function runMatching(input: MatchInput): Promise<MatchOutput> {
  const { profile, job } = input;
  const warnings: string[] = [];

  if (profile.evidence.length === 0) {
    warnings.push('当前档案里没有任何证据，匹配结果会整体偏向「缺少证据」，建议先补充项目经历');
  }

  const matches: RequirementMatch[] = [];
  for (const requirement of job.items) {
    const match = findEvidenceFor(requirement, profile);

    let judged: { assessment: Assessment; reason: string; action: string | null; confidence?: TriLevel };

    if (requirement.hardGate) {
      if (requirement.type === 'education') {
        judged = judgeEducation(requirement, profile);
      } else if (requirement.type === 'experience') {
        const years = judgeExperienceYears(requirement, profile);
        judged = years ?? judgeGeneric(requirement, match);
      } else {
        const certificateHit = match.hits.find((h) => h.kind === 'certificate');
        if (certificateHit) {
          judged = { assessment: 'matched', reason: `档案中存在对应证书/资格证据：${certificateHit.title}`, action: null };
        } else {
          judged = judgeGeneric(requirement, match);
          if (judged.assessment === 'matched') {
            judged = { ...judged, assessment: 'lacking_evidence', reason: `${judged.reason}；但这条属于硬门槛，仅有声明不足以支撑`, action: '补充可核对的证书或资格证明' };
          }
        }
      }
    } else {
      judged = judgeGeneric(requirement, match);
    }

    matches.push({
      id: `match_${requirement.id}`,
      requirementId: requirement.id,
      requirement: requirement.content,
      original: requirement.original,
      type: requirement.type,
      importance: requirement.importance,
      hardGate: requirement.hardGate,
      evidence: match.hits,
      matchedSkills: match.matchedSkills,
      missingSkills: match.missingSkills,
      assessment: judged.assessment,
      confidence: judged.confidence ?? (requirement.confidence === 'low' ? 'low' : 'medium'),
      reason: judged.reason,
      action: judged.action,
      explain: explainOf(requirement, match, judged.assessment),
    });
  }

  let trace: AiTrace | null = null;
  let engine: 'rule' | 'ai' | 'hybrid' = 'rule';

  const gateway = input.gateway;
  if (gateway?.active && job.items.length > 0) {
    const evidenceDigest = profile.evidence.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      content: truncate(e.content, 300),
      skills: e.skills,
      strength: e.strength,
    }));
    const messages: AiMessage[] = [
      { role: 'system', content: MATCH_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          '【岗位要求】',
          ...job.items.map((i) => `#${i.index} [${i.type}/${i.importance}${i.hardGate ? '/硬门槛' : ''}] ${i.content}`),
          '',
          '【候选人证据】',
          ...evidenceDigest.map((e) => `- id=${e.id} kind=${e.kind} strength=${e.strength} title=${e.title} :: ${e.content}`),
          '',
          '请对每一条要求输出判断，evidenceIds 只能引用上面出现过的 id。',
        ].join('\n'),
      },
    ];
    input.onMessages?.(messages);
    const run = await gateway.runJson<AiMatchPayload>('matching', messages, { maxTokens: 6144 });
    trace = run.trace;

    if (run.value?.matches?.length) {
      let applied = 0;
      for (const aiMatch of run.value.matches) {
        const idx = typeof aiMatch.requirementIndex === 'number' ? aiMatch.requirementIndex : -1;
        const target = matches.find((m, i) => (idx > 0 ? i === idx - 1 : false));
        if (!target) continue;
        const assessment = typeof aiMatch.assessment === 'string' && VALID_ASSESSMENTS.includes(aiMatch.assessment as Assessment)
          ? (aiMatch.assessment as Assessment)
          : null;
        if (!assessment) continue;
        // 硬门槛以本地规则为准，模型不得放宽
        if (target.hardGate && assessment === 'matched' && target.assessment !== 'matched') continue;

        const citedIds = Array.isArray(aiMatch.evidenceIds)
          ? aiMatch.evidenceIds.filter((id): id is string => typeof id === 'string' && profile.evidence.some((e) => e.id === id))
          : [];
        const evidence = citedIds.length > 0
          ? target.evidence.filter((h) => citedIds.includes(h.evidenceId))
          : target.evidence;

        target.assessment = assessment;
        target.evidence = evidence.length > 0 ? evidence : target.evidence;
        target.reason = typeof aiMatch.reason === 'string' && aiMatch.reason.trim() ? aiMatch.reason.trim() : target.reason;
        target.action = aiMatch.action === null ? null : (typeof aiMatch.action === 'string' && aiMatch.action.trim() ? aiMatch.action.trim() : target.action);
        target.confidence = (typeof aiMatch.confidence === 'string' && ['high', 'medium', 'low'].includes(aiMatch.confidence)
          ? aiMatch.confidence
          : target.confidence) as TriLevel;
        target.explain = [
          ...target.explain.filter((s) => s.rule !== '判定规则'),
          { rule: '模型复核', detail: `模型给出 ${assessment}（置信度 ${target.confidence}），证据引用 ${citedIds.length} 条` },
        ];
        applied += 1;
      }
      if (applied > 0) engine = 'hybrid';
      else warnings.push('模型返回的匹配结果无法与本地要求对应，已全部使用本地规则判定');
      if (run.value.riskNotes?.length) {
        warnings.push(...run.value.riskNotes.filter((r): r is string => typeof r === 'string' && r.trim().length > 0));
      }
    } else if (run.error) {
      warnings.push(`模型匹配不可用，已使用本地规则引擎：${run.error}`);
    }
  }

  const summary = summarize(matches);
  const result: MatchResult = {
    id: `match_${Date.now().toString(36)}`,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    profileId: profile.id,
    profileUpdatedAt: profile.updatedAt,
    jobId: job.id,
    matches,
    summary: summary ?? emptySummary(),
    priorities: buildPriorities(matches),
    riskNotes: buildRiskNotes(matches, job),
    engine,
    usedModel: engine !== 'rule',
  };

  return { result, trace, engine, warnings: unique(warnings) };
}
