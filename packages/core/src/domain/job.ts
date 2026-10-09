import type { SourceRef, TriLevel } from './common';
import type { PrivacyReport } from './privacy';

/**
 * Job Requirement —— 系统内部的第二类核心数据。
 * 岗位不被当作「一段文本」，而是被拆成一条条可独立判断的要求。
 */

export type RequirementType =
  | 'must'           // 必须条件
  | 'tech'           // 技术要求
  | 'responsibility' // 工作职责
  | 'experience'     // 经验要求
  | 'education'      // 学历要求
  | 'tool'           // 工具要求
  | 'soft'           // 软技能
  | 'bonus'          // 加分项
  | 'implicit';      // 隐含要求

export const REQUIREMENT_TYPE_LABEL: Record<RequirementType, string> = {
  must: '必须条件',
  tech: '技术要求',
  responsibility: '工作职责',
  experience: '经验要求',
  education: '学历要求',
  tool: '工具要求',
  soft: '软技能',
  bonus: '加分项',
  implicit: '隐含要求',
};

export const REQUIREMENT_TYPE_ORDER: RequirementType[] = [
  'must',
  'tech',
  'experience',
  'education',
  'tool',
  'responsibility',
  'soft',
  'implicit',
  'bonus',
];

/** 需要什么类型的证据才能证明这条要求 */
export type EvidenceNeeded = 'project' | 'work' | 'education' | 'certificate' | 'portfolio' | 'any';

export const EVIDENCE_NEEDED_LABEL: Record<EvidenceNeeded, string> = {
  project: '项目',
  work: '工作经历',
  education: '教育背景',
  certificate: '证书',
  portfolio: '作品/链接',
  any: '任意可核对的证据',
};

export interface RequirementItem {
  id: string;
  /** 展示序号，稳定不变（#01 #02 …） */
  index: number;
  /** 归一化后的要求表述 */
  content: string;
  /** 岗位原文片段 */
  original: string;
  type: RequirementType;
  importance: TriLevel;
  /** 硬门槛（学历 / 年限 / 地点等）—— 命中即高风险，不允许用软证据搪塞 */
  hardGate: boolean;
  /** 归一化关键词 / 技能名，用于匹配 */
  keywords: string[];
  evidenceNeeded: EvidenceNeeded;
  sourceRef: SourceRef;
  confidence: TriLevel;
  editedByUser: boolean;
}

export interface JobRequirement {
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;

  jobTitle: string;
  company: string;
  source: 'text' | 'manual' | 'image';
  sourceFileName?: string;

  /** 岗位定位：这个岗位到底在做什么 */
  roleSummary: string;

  items: RequirementItem[];

  /** 可能的筛选风险（文档：可能的筛选风险） */
  screenRisks: string[];

  /** 脱敏后的 JD 原文 */
  rawText: string;
  privacy: PrivacyReport;
  parsedBy: 'ai' | 'rule' | 'mixed';
}

export function createEmptyJob(): JobRequirement {
  const now = new Date().toISOString();
  return {
    id: '',
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    jobTitle: '',
    company: '',
    source: 'text',
    roleSummary: '',
    items: [],
    screenRisks: [],
    rawText: '',
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

export function jobStats(job: JobRequirement | null) {
  if (!job) return { requirementCount: 0, hardGateCount: 0, highCount: 0 };
  return {
    requirementCount: job.items.length,
    hardGateCount: job.items.filter((i) => i.hardGate).length,
    highCount: job.items.filter((i) => i.importance === 'high').length,
  };
}
