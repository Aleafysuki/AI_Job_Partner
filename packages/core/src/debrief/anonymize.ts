import type { PiiType } from '../domain/privacy';
import { redactPII } from '../privacy/redactor';

/**
 * 面试转写的去标识化。
 *
 * 为什么不能只复用 `redactPII()`：那套规则是为简历设计的 ——
 * 它找的是「姓名: 张明」这种显式字段和简历首行的孤立中文名。
 * 而面试转写里的身份信息长这样：
 *
 *   「张经理你好，我是字节跳动这边的 HR，我们在北京海淀区的园区」
 *   「我跟腾讯的刘总聊过，他们那边用的是另外一套系统」
 *
 * 这里没有「姓名:」标签，称呼、公司名、品牌名都是嵌在句子里随口说出来的。
 * 所以这里补两条规则（称呼 → 面试官、机构名 → A 公司），
 * 再把 `redactPII()` 当作兜底，捞电话 / 邮箱 / 身份证 / 银行卡 / 地址 / 社交账号。
 *
 * 一条硬约束：**本模块返回的报告里不保留任何被替换掉的原文**。
 * 替换记录只有「类型 + 次数」，因为这份报告会跟着复盘报告一起落盘展示。
 */

export type AnonymizeCategory = 'person_title' | 'organization' | 'pii';

export const ANONYMIZE_CATEGORY_LABEL: Record<AnonymizeCategory, string> = {
  person_title: '称呼 / 人名',
  organization: '公司 / 机构名',
  pii: '身份信息',
};

export interface AnonymizeReplacement {
  category: AnonymizeCategory;
  /** 替换成的占位文本，例如「面试官」「A 公司」 */
  placeholder: string;
  count: number;
}

/**
 * 命中的身份信息，**只保留打码后的值**。
 *
 * 为什么不直接嵌 `PrivacyReport`：那个结构的 `findings[].value` 存的是原始值
 * （它原本的用途是让用户在本地核对「哪些被拿掉了」）。
 * 而这份去标识化报告会跟着复盘结果一起落盘、一起展示、一起导出 ——
 * 那等于把刚拿掉的东西又原样写进了另一份文件。所以这里做一次收敛：
 * 只留下类型、打码值与命中的规则。
 */
export interface AnonymizeFinding {
  type: PiiType;
  label: string;
  /** 打码值，例如 138****5678 */
  masked: string;
  rule: string;
}

export interface AnonymizeReport {
  scannedAt: string;
  originalLength: number;
  anonymizedLength: number;
  replacements: AnonymizeReplacement[];
  findings: AnonymizeFinding[];
}

export interface AnonymizeResult {
  text: string;
  report: AnonymizeReport;
}

/**
 * 机构名后缀。
 *
 * 只收「强后缀」：公司 / 集团 / 银行 / 医院 / 学校 ……
 * 刻意不收「科技 / 网络 / 软件 / 电子」这类弱后缀 ——
 * 「我们是做人工智能网络的」会被误伤成「我们是做 A 公司的」，
 * 而这类品牌名留给模型阶段按上下文判断更稳。
 */
const ORG_SUFFIXES = [
  '股份有限公司',
  '有限责任公司',
  '有限公司',
  '研究院',
  '研究所',
  '事务所',
  '分公司',
  '子公司',
  '集团',
  '公司',
  '银行',
  '证券',
  '保险',
  '医院',
  '大学',
  '学院',
  '学校',
  '工厂',
  '门店',
  '连锁',
  '超市',
  '酒店',
];

/**
 * 称呼后缀：张经理 / 李总监 / 王老师 / 刘工 —— 一律替换为「面试官」。
 *
 * 刻意**不含**「面试官」本身：它已经是我们要替换成的那个代称，
 * 放进来会让「的面试官」这类正常表述被反复改写。
 */
const TITLE_SUFFIXES = ['总经理', '总监', '主管', '经理', '老师', '先生', '女士'];

const ORG_RE = new RegExp(`[\\u4e00-\\u9fa5A-Za-z0-9]{2,8}(?:${ORG_SUFFIXES.join('|')})`, 'g');
const TITLE_RE = new RegExp(`[\\u4e00-\\u9fa5]{1,2}(?:${TITLE_SUFFIXES.join('|')})`, 'g');
/** 「李总」：单字后缀，必须排除「总结 / 总之 / 总体 / 总算 / 总部 / 总额 / 总览」这类常用词 */
const BOSS_RE = /[\u4e00-\u9fa5]总(?![结之体算计部额览的称])/g;

/** 已经是占位符的内容不再处理，避免二次替换把 [姓名] 变成 [面试官] */
function isPlaceholder(text: string): boolean {
  return /^\[[^\]]+\]$/.test(text);
}

const ORG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function letterAt(index: number): string {
  return ORG_ALPHABET[index] ?? `A${index - ORG_ALPHABET.length + 1}`;
}

export interface AnonymizeOptions {
  /** 关掉后只识别不改写（用于「只看识别结果」） */
  apply?: boolean;
}

/**
 * 对转写文本做去标识化。
 *
 * 顺序很重要：先处理机构名，再处理称呼，最后跑通用 PII 规则。
 * 反过来的话，「字节跳动」可能先被当作某个人名的一部分切开。
 */
export function anonymizeTranscript(raw: string, options: AnonymizeOptions = {}): AnonymizeResult {
  const apply = options.apply !== false;
  const source = raw ?? '';
  const counters = new Map<string, number>();
  const orgMap = new Map<string, string>();
  let orgSeq = 0;

  const bump = (placeholder: string, category: AnonymizeCategory) => {
    const key = `${category}::${placeholder}`;
    counters.set(key, (counters.get(key) ?? 0) + 1);
  };

  let working = source;

  if (apply) {
    // 1) 机构名 → A 公司 / B 公司（同一家机构在全文里保持同一个代号）
    working = working.replace(ORG_RE, (match) => {
      if (isPlaceholder(match)) return match;
      const existing = orgMap.get(match);
      if (existing) {
        bump(existing, 'organization');
        return existing;
      }
      const placeholder = `${letterAt(orgSeq)} 公司`;
      orgSeq += 1;
      orgMap.set(match, placeholder);
      bump(placeholder, 'organization');
      return placeholder;
    });

    // 2) 称呼 → 面试官（同一代称，不区分具体是谁）
    working = working.replace(TITLE_RE, (match) => {
      if (isPlaceholder(match)) return match;
      bump('面试官', 'person_title');
      return '面试官';
    });
    working = working.replace(BOSS_RE, (match) => {
      if (isPlaceholder(match)) return match;
      bump('面试官', 'person_title');
      return '面试官';
    });
  } else {
    ORG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ORG_RE.exec(source)) !== null) bump('A 公司', 'organization');
    TITLE_RE.lastIndex = 0;
    while ((m = TITLE_RE.exec(source)) !== null) bump('面试官', 'person_title');
  }

  // 3) 通用身份信息兜底：电话 / 邮箱 / 身份证 / 银行卡 / 地址 / 社交账号 / 显式姓名字段
  const privacy = redactPII(working, { apply });
  const finalText = apply ? privacy.redactedText : working;

  if (privacy.findings.length > 0) {
    bump('身份信息占位符', 'pii');
    counters.set('pii::身份信息占位符', privacy.findings.length);
  }

  const replacements: AnonymizeReplacement[] = [];
  for (const [key, count] of counters) {
    const [category, placeholder] = key.split('::');
    replacements.push({ category: category as AnonymizeCategory, placeholder, count });
  }
  replacements.sort((a, b) => (a.category === b.category ? a.placeholder.localeCompare(b.placeholder) : a.category.localeCompare(b.category)));

  return {
    text: finalText,
    report: {
      scannedAt: new Date().toISOString(),
      originalLength: source.length,
      anonymizedLength: finalText.length,
      replacements,
      // 只带走打码值：原始值留在本地隐私报告里，不进这份会被导出/分享的结构
      findings: privacy.findings.map((f) => ({
        type: f.type,
        label: f.label,
        masked: f.masked,
        rule: f.rule,
      })),
    },
  };
}

/** 报告顶部用的一句话摘要 */
export function summarizeAnonymize(report: AnonymizeReport): string {
  if (report.replacements.length === 0) return '未发现需要去标识化的内容';
  const parts = report.replacements.map(
    (r) => `${ANONYMIZE_CATEGORY_LABEL[r.category]} ${r.count} 处 → ${r.placeholder}`,
  );
  return `已去标识化：${parts.join('；')}`;
}
