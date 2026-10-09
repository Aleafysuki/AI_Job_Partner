import type { CandidateEvidence } from '../domain/evidence';
import { strengthRank } from '../domain/common';
import type {
  CandidateProfile,
  EducationItem,
  ProjectItem,
  SkillItem,
  WorkExperience,
} from '../domain/profile';
import { resolveSkill } from '../nlp/skills';
import { finalizeProfile } from './profile-builder';
import { unique } from '../utils/text';

/**
 * 能力库合并（v0.2）
 * ==================
 *
 * 要解决的问题：换一个岗位往往要按新 JD 重新整理一份简历。
 * 如果每次导入都重建档案，之前积累的证据、问诊结论、待证明清单就全没了 ——
 * 用户不得不在每个岗位之间重复"证明自己会什么"。
 *
 * 所以 v0.2 起导入默认为**合并**而不是覆盖：
 *   - 技能按标准名取并集，自评等级取更高的一侧；
 *   - 证据按「类型 + 标题 + 内容前缀」去重，同一条证据取更强的版本；
 *   - 问诊结论（assessments）按技能保留最新一次；
 *   - 问诊补充的证据（origin='qa'）永远不因为换岗位而丢失。
 *
 * 合并结果会返回一份可展示的报告，让用户看到"这次新增了什么、保留了什么"，
 * 而不是静默地改掉自己的档案。
 */

export interface MergeReport {
  /** 新增的技能 */
  addedSkills: string[];
  /** 保留下来的技能（包括本次没提到但已有证据的） */
  keptSkills: string[];
  /** 自评等级被提升的技能 */
  upgradedSkills: string[];
  addedEvidence: number;
  keptEvidence: number;
  /** 因为新版本更强而被替换的证据标题 */
  upgradedEvidence: string[];
  qaEvidenceKept: number;
  addedProjects: number;
  keptProjects: number;
  addedExperiences: number;
  keptExperiences: number;
  addedEducation: number;
  keptEducation: number;
  keptAssessments: number;
  /** 一句话总结，直接给用户看 */
  summary: string;
}

const SELF_LEVEL_RANK: Record<string, number> = { 未声明: 0, 了解: 1, 熟悉: 2, 熟练: 3, 精通: 4 };

function normalizeKey(text: string): string {
  return (text ?? '').replace(/\s+/g, '').toLowerCase();
}

/** 证据去重键：同类 + 同标题 + 内容前缀。刻意比内容全等宽松，避免同一件事被写两遍。 */
export function evidenceKey(evidence: Pick<CandidateEvidence, 'kind' | 'title' | 'content'>): string {
  return `${evidence.kind}|${normalizeKey(evidence.title)}|${normalizeKey(evidence.content).slice(0, 60)}`;
}

function mergeEvidence(
  base: CandidateEvidence[],
  incoming: CandidateEvidence[],
): { evidence: CandidateEvidence[]; added: number; kept: number; upgraded: string[] } {
  const result = base.slice();
  const index = new Map(result.map((e, i) => [evidenceKey(e), i]));
  let added = 0;
  let kept = 0;
  const upgraded: string[] = [];

  for (const item of incoming) {
    const key = evidenceKey(item);
    const existingIndex = index.get(key);
    if (existingIndex === undefined) {
      index.set(key, result.length);
      result.push(item);
      added += 1;
      continue;
    }
    const existing = result[existingIndex];
    // 用户手工确认过的证据不覆盖
    if (existing.editedByUser) {
      kept += 1;
      continue;
    }
    if (strengthRank(item.strength) > strengthRank(existing.strength)) {
      result[existingIndex] = { ...item, id: existing.id, createdAt: existing.createdAt };
      upgraded.push(item.title);
    }
    kept += 1;
  }

  return { evidence: result, added, kept, upgraded: unique(upgraded) };
}

function mergeSkills(
  base: SkillItem[],
  incoming: SkillItem[],
): { skills: SkillItem[]; added: string[]; upgraded: string[] } {
  const skills = base.slice();
  const byName = new Map(skills.map((s, i) => [s.name, i]));
  const added: string[] = [];
  const upgraded: string[] = [];

  for (const item of incoming) {
    const name = resolveSkill(item.name)?.name ?? item.name;
    const existingIndex = byName.get(name);
    if (existingIndex === undefined) {
      byName.set(name, skills.length);
      skills.push({ ...item, name, aliases: resolveSkill(name)?.aliases ?? item.aliases });
      added.push(name);
      continue;
    }
    const existing = skills[existingIndex];
    const incomingLevel = item.selfLevel ?? '未声明';
    if ((SELF_LEVEL_RANK[incomingLevel] ?? 0) > (SELF_LEVEL_RANK[existing.selfLevel] ?? 0)) {
      skills[existingIndex] = { ...existing, selfLevel: incomingLevel };
      upgraded.push(name);
    }
  }

  return { skills, added, upgraded };
}

function mergeProjects(base: ProjectItem[], incoming: ProjectItem[]) {
  const projects = base.slice();
  const seen = new Set(projects.map((p) => normalizeKey(p.name)));
  let added = 0;
  for (const item of incoming) {
    const key = normalizeKey(item.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    projects.push(item);
    added += 1;
  }
  return { projects, added, kept: projects.length - added };
}

function mergeExperiences(base: WorkExperience[], incoming: WorkExperience[]) {
  const experiences = base.slice();
  const seen = new Set(experiences.map((e) => `${normalizeKey(e.organization)}|${normalizeKey(e.role)}`));
  let added = 0;
  for (const item of incoming) {
    const key = `${normalizeKey(item.organization)}|${normalizeKey(item.role)}`;
    if (!normalizeKey(item.organization) || seen.has(key)) continue;
    seen.add(key);
    experiences.push(item);
    added += 1;
  }
  return { experiences, added, kept: experiences.length - added };
}

function mergeEducation(base: EducationItem[], incoming: EducationItem[]) {
  const education = base.slice();
  const seen = new Set(education.map((e) => `${normalizeKey(e.school)}|${normalizeKey(e.degree ?? '')}`));
  let added = 0;
  for (const item of incoming) {
    const key = `${normalizeKey(item.school)}|${normalizeKey(item.degree ?? '')}`;
    if (!normalizeKey(item.school) || seen.has(key)) continue;
    seen.add(key);
    education.push(item);
    added += 1;
  }
  return { education, added, kept: education.length - added };
}

export interface MergeOptions {
  /** 档案名：合并时保留原有的，除非原档案还是默认值 */
  keepBaseLabel?: boolean;
}

export function mergeProfiles(
  base: CandidateProfile,
  incoming: CandidateProfile,
  options: MergeOptions = {},
): { profile: CandidateProfile; report: MergeReport } {
  const keepBaseLabel = options.keepBaseLabel !== false;

  const skillMerge = mergeSkills(base.skills, incoming.skills);
  const evidenceMerge = mergeEvidence(base.evidence, incoming.evidence);
  const projectMerge = mergeProjects(base.projects, incoming.projects);
  const experienceMerge = mergeExperiences(base.experiences, incoming.experiences);
  const educationMerge = mergeEducation(base.education, incoming.education);

  // 问诊结论按技能保留最新的一次；不因为换岗位而丢弃
  const assessmentMap = new Map((base.assessments ?? []).map((a) => [a.skillName, a]));
  for (const item of incoming.assessments ?? []) {
    const existing = assessmentMap.get(item.skillName);
    if (!existing || new Date(item.createdAt) >= new Date(existing.createdAt)) {
      assessmentMap.set(item.skillName, item);
    }
  }
  const assessments = Array.from(assessmentMap.values());

  const displayName =
    keepBaseLabel && base.basics.displayName && base.basics.displayName !== '我的档案'
      ? base.basics.displayName
      : incoming.basics.displayName || base.basics.displayName;

  const merged: CandidateProfile = {
    ...base,
    basics: {
      displayName,
      targetRoles: unique([...base.basics.targetRoles, ...incoming.basics.targetRoles]).slice(0, 8),
      yearsOfExperience: base.basics.yearsOfExperience ?? incoming.basics.yearsOfExperience ?? null,
      educationLevel: base.basics.educationLevel || incoming.basics.educationLevel,
      location: base.basics.location || incoming.basics.location,
    },
    summary: incoming.summary && incoming.summary.length > (base.summary?.length ?? 0) ? incoming.summary : base.summary,
    skills: skillMerge.skills,
    evidence: evidenceMerge.evidence,
    projects: projectMerge.projects,
    experiences: experienceMerge.experiences,
    education: educationMerge.education,
    selfDescriptions: unique([...base.selfDescriptions, ...incoming.selfDescriptions]).slice(0, 10),
    assessments,
    // 留存文本用最新导入的那份：它最接近当前求职方向
    rawText: incoming.rawText || base.rawText,
    rawSourceRef: incoming.rawText ? incoming.rawSourceRef : base.rawSourceRef,
    privacy: incoming.rawText ? incoming.privacy : base.privacy,
    parsedBy: base.parsedBy === incoming.parsedBy ? base.parsedBy : 'mixed',
    updatedAt: new Date().toISOString(),
  };

  const profile = finalizeProfile(merged);

  const qaEvidenceKept = profile.evidence.filter((e) => e.origin === 'qa').length;
  const keptSkills = profile.skills.map((s) => s.name).filter((n) => !skillMerge.added.includes(n));

  const report: MergeReport = {
    addedSkills: skillMerge.added,
    keptSkills,
    upgradedSkills: skillMerge.upgraded,
    addedEvidence: evidenceMerge.added,
    keptEvidence: evidenceMerge.kept,
    upgradedEvidence: evidenceMerge.upgraded,
    qaEvidenceKept,
    addedProjects: projectMerge.added,
    keptProjects: projectMerge.kept,
    addedExperiences: experienceMerge.added,
    keptExperiences: experienceMerge.kept,
    addedEducation: educationMerge.added,
    keptEducation: educationMerge.kept,
    keptAssessments: assessments.length,
    summary: [
      `本次新增 ${skillMerge.added.length} 项技能、${evidenceMerge.added} 条证据`,
      `保留原有 ${keptSkills.length} 项技能、${evidenceMerge.kept} 条证据`,
      qaEvidenceKept > 0 ? `其中问诊补充的证据 ${qaEvidenceKept} 条` : '',
      assessments.length > 0 ? `问诊结论 ${assessments.length} 项` : '',
    ]
      .filter(Boolean)
      .join('；'),
  };

  return { profile, report };
}

/** 判断两份档案是否明显是同一个人的（用于默认为合并而不是新建） */
export function looksLikeSameCandidate(base: CandidateProfile, incoming: CandidateProfile): boolean {
  if (base.basics.educationLevel && incoming.basics.educationLevel && base.basics.educationLevel === incoming.basics.educationLevel) {
    return true;
  }
  const baseSkills = new Set(base.skills.map((s) => s.name));
  const overlap = incoming.skills.filter((s) => baseSkills.has(s.name)).length;
  return overlap >= 3;
}

/** 供 UI 展示：本次导入有多少内容是与已有能力库重合的（重合度高就更该合并） */
export function overlapScore(base: CandidateProfile, incoming: CandidateProfile): number {
  const baseSkills = new Set(base.skills.map((s) => s.name));
  if (baseSkills.size === 0) return 0;
  const overlap = incoming.skills.filter((s) => baseSkills.has(s.name)).length;
  return Math.round((overlap / baseSkills.size) * 100) / 100;
}

/** 计算能力库里跨岗位积累的规模（用于「跨岗位保留」的可见性） */
export function libraryHighlights(profile: CandidateProfile): {
  strongEvidence: number;
  qaEvidence: number;
  assessedSkills: number;
  jobTags: string[];
} {
  const jobTags = unique(
    profile.evidence.map((e) => e.fromJobTitle).filter((t): t is string => Boolean(t && t.trim())),
  );
  return {
    strongEvidence: profile.evidence.filter((e) => e.strength === 'strong').length,
    qaEvidence: profile.evidence.filter((e) => e.origin === 'qa').length,
    assessedSkills: (profile.assessments ?? []).length,
    jobTags,
  };
}
