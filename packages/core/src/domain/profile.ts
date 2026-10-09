import type { EvidenceStrength, SourceRef } from './common';
import type { CandidateEvidence } from './evidence';
import type { PrivacyReport } from './privacy';
import type { SkillAssessment } from './interview';

/**
 * Candidate Profile —— 系统内部的第一类核心数据。
 *
 * 文档第四节明确：简历不是唯一数据源，Profile 描述的是「这个人是什么样的候选人」。
 * 因此 Profile 由 教育 / 工作 / 项目 / 技能 / 证据 五个可独立增删的部分组成，
 * 且每一条都允许用户直接修改。
 */

export interface EducationItem {
  id: string;
  school: string;
  major?: string;
  degree?: string;
  timeRange?: string;
  highlights: string[];
  evidenceId?: string;
}

export interface WorkExperience {
  id: string;
  organization: string;
  role: string;
  timeRange?: string;
  description: string;
  achievements: string[];
  skills: string[];
  evidenceId?: string;
}

export interface ProjectItem {
  id: string;
  name: string;
  role?: string;
  timeRange?: string;
  description: string;
  highlights: string[];
  skills: string[];
  links: string[];
  evidenceId?: string;
}

/** 用户自评等级。系统不会直接采信，只作为「声明」，需要证据加持 */
export type SelfLevel = '了解' | '熟悉' | '熟练' | '精通' | '未声明';

export const SELF_LEVELS: SelfLevel[] = ['了解', '熟悉', '熟练', '精通', '未声明'];

export interface SkillItem {
  id: string;
  /** 归一化后的技能名（技能词典中的标准名） */
  name: string;
  /** 简历/JD 中出现的其他写法 */
  aliases: string[];
  category: string;
  /** 用户自己声明的等级 —— 属于 Self Claim */
  selfLevel: SelfLevel;
  /** 支撑该技能的候选证据 */
  evidenceIds: string[];
  /** 由证据推导出的实际强度（系统判断，用户可修正） */
  derivedStrength: EvidenceStrength;
  note?: string;
}

export interface CandidateBasics {
  displayName: string;
  targetRoles: string[];
  yearsOfExperience?: number | null;
  educationLevel?: string;
  location?: string;
}

/** v0.3 面试训练的数据容器 —— v0.1 只保留结构，不实现流程 */
export interface InterviewRecord {
  id: string;
  company?: string;
  role?: string;
  date?: string;
  questions: Array<{ id: string; question: string; answer?: string; feedback?: string }>;
  weakPoints: string[];
}

export type ParseOrigin = 'ai' | 'rule' | 'mixed';

export interface CandidateProfile {
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;

  basics: CandidateBasics;
  summary: string;

  education: EducationItem[];
  experiences: WorkExperience[];
  projects: ProjectItem[];
  skills: SkillItem[];

  /** 自我描述原文（不参与匹配，仅作上下文） */
  selfDescriptions: string[];

  /** 全部证据 */
  evidence: CandidateEvidence[];

  /** 推导字段：有证据支撑的能力 */
  provenSkills: string[];
  /** 推导字段：只在声明里出现、但找不到证据的能力 */
  unprovenSkills: string[];
  /** 推导字段：用户明确表示还在学的 */
  learningSkills: string[];

  /** v0.3 预留：真实面试记录 */
  interviewHistory: InterviewRecord[];

  /**
   * v0.2：能力问诊结论。
   *
   * 放在档案里而不是绑在某个岗位上 —— 这是「换岗位不丢积累」的关键：
   * 问出来的掌握程度属于这个人，不属于某一份 JD。
   */
  assessments: SkillAssessment[];

  /** 脱敏后的简历原文 */
  rawText: string;
  rawSourceRef: SourceRef;
  /** 入库时执行的隐私处理结果，可随时回看「哪些字段被拿掉了」 */
  privacy: PrivacyReport;
  parsedBy: ParseOrigin;
}

export function createEmptyProfile(displayName = ''): CandidateProfile {
  const now = new Date().toISOString();
  return {
    id: '',
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    basics: { displayName, targetRoles: [], yearsOfExperience: null },
    summary: '',
    education: [],
    experiences: [],
    projects: [],
    skills: [],
    selfDescriptions: [],
    evidence: [],
    provenSkills: [],
    unprovenSkills: [],
    learningSkills: [],
    interviewHistory: [],
    assessments: [],
    rawText: '',
    rawSourceRef: { kind: 'resume', locator: '未提供', excerpt: '' },
    privacy: {
      scannedAt: now,
      redacted: false,
      findings: [],
      originalLength: 0,
      redactedLength: 0,
      redactedText: '',
    },
    parsedBy: 'rule',
  };
}

/** 派生统计，用于首页「已建立 N 项能力记录」 */
export interface ProfileStats {
  skillCount: number;
  evidenceCount: number;
  projectCount: number;
  experienceCount: number;
  provenCount: number;
  unprovenCount: number;
  strongEvidenceCount: number;
  /** v0.2：问诊过的技能数 */
  assessedCount: number;
  /** v0.2：由问诊补充的证据数 */
  qaEvidenceCount: number;
}

export function profileStats(profile: CandidateProfile | null): ProfileStats {
  if (!profile) {
    return {
      skillCount: 0,
      evidenceCount: 0,
      projectCount: 0,
      experienceCount: 0,
      provenCount: 0,
      unprovenCount: 0,
      strongEvidenceCount: 0,
      assessedCount: 0,
      qaEvidenceCount: 0,
    };
  }
  return {
    skillCount: profile.skills.length,
    evidenceCount: profile.evidence.length,
    projectCount: profile.projects.length,
    experienceCount: profile.experiences.length,
    provenCount: profile.provenSkills.length,
    unprovenCount: profile.unprovenSkills.length,
    strongEvidenceCount: profile.evidence.filter((e) => e.strength === 'strong').length,
    assessedCount: (profile.assessments ?? []).length,
    qaEvidenceCount: profile.evidence.filter((e) => e.origin === 'qa').length,
  };
}
