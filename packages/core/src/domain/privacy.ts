import type { TriLevel } from './common';

/**
 * 隐私处理（文档第十一节）—— 隐私是产品的一部分，不是附属功能。
 * 链路：原始内容 → 隐私识别 → 脱敏 → AI 分析，并且允许用户查看「AI 实际收到的内容」。
 */

export type PiiType =
  | 'name'
  | 'phone'
  | 'email'
  | 'id_card'
  | 'address'
  | 'social'
  | 'bank_card'
  | 'other';

export const PII_LABEL: Record<PiiType, string> = {
  name: '姓名',
  phone: '电话',
  email: '邮箱',
  id_card: '身份证',
  address: '地址',
  social: '社交账号',
  bank_card: '银行卡',
  other: '其他敏感信息',
};

export const PII_PLACEHOLDER: Record<PiiType, string> = {
  name: '[姓名]',
  phone: '[电话]',
  email: '[邮箱]',
  id_card: '[身份证]',
  address: '[地址]',
  social: '[社交账号]',
  bank_card: '[银行卡]',
  other: '[已脱敏]',
};

export interface PiiFinding {
  id: string;
  type: PiiType;
  label: string;
  /** 原始值（只在本地展示，永远不会进入 Prompt） */
  value: string;
  /** 打码后的展示值 */
  masked: string;
  placeholder: string;
  /** 在原文中的位置，用于高亮 */
  start: number;
  end: number;
  line: number;
  confidence: TriLevel;
  /** 命中的识别规则，便于用户理解为什么被判定为敏感 */
  rule: string;
}

export interface PrivacyReport {
  scannedAt: string;
  redacted: boolean;
  findings: PiiFinding[];
  originalLength: number;
  redactedLength: number;
  /** 脱敏后的文本 —— 这才是真正会送进分析链路 / 模型的内容 */
  redactedText: string;
}

export function maskValue(type: PiiType, value: string): string {
  const v = value.trim();
  if (type === 'email') {
    const [local, domain] = v.split('@');
    if (!domain) return '***';
    const head = local.slice(0, 1);
    return `${head}***@${domain}`;
  }
  if (type === 'phone' || type === 'bank_card') {
    if (v.length <= 7) return v.slice(0, 2) + '***';
    return `${v.slice(0, 3)}${'*'.repeat(Math.max(3, v.length - 7))}${v.slice(-4)}`;
  }
  if (type === 'id_card') {
    return `${v.slice(0, 4)}${'*'.repeat(Math.max(6, v.length - 8))}${v.slice(-4)}`;
  }
  if (type === 'name') {
    if (v.length <= 1) return '*';
    return `${v.slice(0, 1)}${'*'.repeat(v.length - 1)}`;
  }
  return v.length <= 4 ? '*'.repeat(v.length) : `${v.slice(0, 2)}***`;
}
