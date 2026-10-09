import { newId } from '../utils/text';
import type { PiiFinding, PiiType, PrivacyReport } from '../domain/privacy';
import { PII_LABEL, PII_PLACEHOLDER, maskValue } from '../domain/privacy';

/**
 * PII 识别与脱敏。
 *
 * 设计原则：
 * 1. 只依赖确定性规则，不做「猜」——把简历里能确认身份的字段拿掉；
 * 2. 保留能支撑求职判断的信息（学历、技能、项目、时间），只屏蔽身份类字段；
 * 3. 完整地址会被脱敏，但会额外抽取「城市」写入档案的 location 字段（用户可见可删），
 *    避免因为脱敏导致「地点要求」永远无法判断。
 */

interface RuleHit {
  type: PiiType;
  rule: string;
  start: number;
  end: number;
  value: string;
  priority: number;
  /** 地址等字段额外提炼出的可用信息（仅保留在本地档案里） */
  keepHint?: string;
}

const CN_CITIES = [
  '北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '成都', '重庆', '武汉', '西安', '天津',
  '长沙', '郑州', '青岛', '宁波', '东莞', '无锡', '厦门', '福州', '合肥', '昆明', '济南', '大连',
  '沈阳', '哈尔滨', '长春', '石家庄', '太原', '南昌', '贵阳', '南宁', '兰州', '海口', '乌鲁木齐',
  '呼和浩特', '银川', '西宁', '拉萨', '佛山', '珠海', '中山', '惠州', '温州', '嘉兴', '常州', '徐州',
  '香港', '澳门', '台北',
];

export function extractCity(text: string): string | undefined {
  for (const city of CN_CITIES) {
    if (text.includes(city)) return city;
  }
  return undefined;
}

const SECTION_BLACKLIST = [
  '个人简历', '求职简历', '简历', '基本信息', '个人信息', '个人优势', '个人简介',
  '自我评价', '教育背景', '教育经历', '工作经历', '实习经历', '项目经历', '项目经验',
  '校园经历', '实践经历', '技能特长', '专业技能', '联系方式', '求职意向', '获奖情况',
  '作品集', '荣誉奖项', '校园活动', '培训经历', '证书',
];

/** 在整段文本中按顺序收集所有命中 */
function collect(text: string): RuleHit[] {
  const hits: RuleHit[] = [];

  const push = (
    re: RegExp,
    type: PiiType,
    priority: number,
    rule: string,
    group = 0,
    hintFrom?: (v: string) => string | undefined,
  ) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[group];
      if (raw === undefined) continue;
      const offset = m.index + m[0].indexOf(raw);
      hits.push({
        type,
        rule,
        start: offset,
        end: offset + raw.length,
        value: raw,
        priority,
        keepHint: hintFrom?.(raw),
      });
      if (m[0].length === 0) re.lastIndex += 1;
    }
  };

  // 1) 身份证 18 位
  push(/\b\d{17}[\dXx]\b/g, 'id_card', 100, '18 位身份证号');

  // 2) 银行卡 / 长数字串 16-19 位
  push(/(?<!\d)\d{16,19}(?!\d)/g, 'bank_card', 90, '16-19 位长数字串');

  // 3) 手机号（含分隔符写法）
  push(/(?<!\d)1[3-9]\d(?:[-\s]?\d{4})[-\s]?\d{4}(?!\d)/g, 'phone', 80, '中国大陆手机号');

  // 4) 邮箱
  push(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'email', 80, '邮箱地址');

  // 5) 座机
  push(/(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)/g, 'phone', 75, '固定电话');

  // 6) 身份证 15 位（老式，放在长数字之后避免抢优先级）
  push(/(?<!\d)\d{15}(?!\d)/g, 'id_card', 70, '15 位身份证号');

  // 7) 地址（带标签）
  push(
    /(?:地\s*址|住\s*址|现居(?:住地)?|居住地|通讯地址|家庭住址)\s*[:：]?\s*([^\n，,；;|]{4,60})/g,
    'address',
    70,
    '住址字段',
    1,
    (v) => extractCity(v),
  );

  // 8) 社交账号
  push(
    /(?:微信号|微信|WeChat|wechat|QQ\s*号|QQ号|QQ|钉钉号|抖音号|小红书号|微博(?:号)?|Telegram|telegram|TG)\s*[:：]\s*([A-Za-z0-9_.\-@]{3,40})/g,
    'social',
    68,
    '社交账号字段',
    1,
  );

  // 9) 姓名（显式标签）
  push(
    /(?:姓\s*名|Name)\s*[:：]?\s*([\u4e00-\u9fa5]{2,4}|[A-Za-z][A-Za-z.'\-]*(?:\s+[A-Za-z][A-Za-z.'\-]*){0,3})/g,
    'name',
    60,
    '姓名字段',
    1,
  );

  // 10) 姓名（文档开头独立成行的中文名）
  const headLines = text.split('\n').slice(0, 6);
  let cursor = 0;
  let firstNonEmptySeen = false;
  const hasContact = /(?<!\d)1[3-9]\d{9}(?!\d)|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text);
  for (const line of headLines) {
    const trimmed = line.trim();
    const lineStart = cursor;
    cursor += line.length + 1;
    if (!trimmed) continue;
    const isFirst = !firstNonEmptySeen;
    firstNonEmptySeen = true;
    if (trimmed.length < 2 || trimmed.length > 4) continue;
    if (!/^[\u4e00-\u9fa5]{2,4}$/.test(trimmed)) continue;
    if (SECTION_BLACKLIST.some((w) => trimmed.includes(w))) continue;
    if (!isFirst && !hasContact) continue;
    hits.push({
      type: 'name',
      rule: isFirst ? '简历首行中文姓名' : '联系方式附近的独立中文姓名',
      start: lineStart + line.indexOf(trimmed),
      end: lineStart + line.indexOf(trimmed) + trimmed.length,
      value: trimmed,
      priority: 55,
    });
  }

  return hits;
}

/** 解决区间重叠：起点靠前优先，同起点时优先级高者胜 */
function resolveOverlaps(hits: RuleHit[]): RuleHit[] {
  const sorted = [...hits].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.end - b.start - (a.end - a.start);
  });
  const out: RuleHit[] = [];
  let lastEnd = -1;
  for (const hit of sorted) {
    if (hit.start < lastEnd) continue;
    out.push(hit);
    lastEnd = hit.end;
  }
  return out;
}

export interface RedactOptions {
  /** 关掉后只做识别不改写文本（用于「只看识别结果」） */
  apply?: boolean;
}

export function redactPII(raw: string, options: RedactOptions = {}): PrivacyReport {
  const apply = options.apply !== false;
  const text = raw ?? '';
  const chosen = resolveOverlaps(collect(text));

  const findings: PiiFinding[] = chosen.map((hit) => {
    const line = text.slice(0, hit.start).split('\n').length;
    const finding: PiiFinding = {
      id: newId('pii'),
      type: hit.type,
      label: PII_LABEL[hit.type],
      value: hit.value,
      masked: maskValue(hit.type, hit.value),
      placeholder: PII_PLACEHOLDER[hit.type],
      start: hit.start,
      end: hit.end,
      line,
      confidence: hit.type === 'name' && hit.priority < 60 ? 'medium' : 'high',
      rule: hit.rule,
    };
    return finding;
  });

  let redactedText = text;
  if (apply) {
    let result = '';
    let cursor = 0;
    for (const hit of chosen) {
      result += text.slice(cursor, hit.start);
      result += PII_PLACEHOLDER[hit.type];
      cursor = hit.end;
    }
    result += text.slice(cursor);
    redactedText = result;
  }

  return {
    scannedAt: new Date().toISOString(),
    redacted: findings.length > 0,
    findings,
    originalLength: text.length,
    redactedLength: redactedText.length,
    redactedText,
  };
}

/** 从识别结果里提炼本地才保留的字段（城市），不进入 Prompt */
export function cityFromFindings(findings: PiiFinding[], original: string): string | undefined {
  const addr = findings.find((f) => f.type === 'address');
  if (addr) {
    const city = extractCity(addr.value);
    if (city) return city;
  }
  return extractCity(original);
}
