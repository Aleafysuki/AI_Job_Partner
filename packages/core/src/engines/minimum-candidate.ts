import type { JobRequirement, RequirementItem } from '../domain/job';
import type { CandidateProfile } from '../domain/profile';
import type { MinimumCandidateModel } from '../domain/report';
import { ASSESSMENT_LABEL } from '../domain/common';
import type { Assessment } from '../domain/common';
import { isEnabled } from '../version';

/**
 * 最低可解释候选人画像（文档第 8 / 19 节）
 * ==================================
 *
 * **反向问题**：不是「我能不能进这个岗位」，而是
 * 「如果我只有现在这些，还差到哪一步才够？」
 *
 * 为什么值得做：
 *   匹配报告回答的是「现在够不够」，但用户真正卡住的地方常常是
 *   「差的那点到底要不要补」—— 一个「部分满足」对决策几乎没有帮助。
 *   把所有缺口摊平成一张「最低清单」，用户能直接回答：
 *   「这六条我要补三条值不值得」。
 *
 * 三条硬约束：
 *
 * 1. **只列硬性缺口，不列优化项。** 「最低」二字的含义就是这个 ——
 *    如果混进「加分项」，用户会以为不补就进不去，而那是错的。
 *
 * 2. **每一项必须能追回它的来源要求 id**（`derivedFromRequirementIds`）。
 *    没有来源的项用户无法核对，也就无法判断该不该信。
 *
 * 3. **不给出「够不够」的二元结论。** 只给「你还差哪几项」与
 *    「哪几项是硬门槛」—— 门槛是否真的卡人，取决于竞争情况，
 *    系统看不到也不该替用户断言。
 *
 * ── v0.3 实装记录（2026-10-08）────────────────────────────────
 * 此前本文件是 35 行空壳：能力解锁后直接返回「生成逻辑尚未实现」。
 * 原实现保留在下方注释里，便于对照（用户偏好：设计变更不简单删除原代码块）。
 *
 *   export function buildMinimumCandidate(_input: {
 *     profile: CandidateProfile;
 *     job: JobRequirement;
 *   }): MinimumCandidateResult {
 *     if (!isEnabled('match.minimum_candidate')) {
 *       return { supported: false, reason: '「最低通过简历画像」属于 v0.2 能力，当前版本暂未开放…' };
 *     }
 *     return { supported: false, reason: '能力已解锁，但生成逻辑尚未实现。' };
 *   }
 *
 * 为什么那时不做：那时缺 `assessments` 入参 ——
 * 没有逐条结论就无从判断「差什么」，只能凭空编。
 * 现在匹配引擎已经产出结论，条件成熟了。
 */

export interface MinimumCandidateResult {
  supported: boolean;
  /** 不支持时，为什么 */
  reason?: string;
  model?: MinimumCandidateModel;
}

/**
 * 分桶的标题与说明。
 *
 * 为什么分桶而不给一张平表：平表会让用户平均用力，
 * 而这几类的「性价比」差别极大 —— 补证据远比补知识容易，
 * 混在一张表里，用户会先去啃最贵的那几项。
 */
const BUCKETS: Array<{ group: string; note: string; assessment: Assessment }> = [
  {
    group: '硬门槛缺口',
    note: '这几项不满足通常在筛选阶段就被排除，不给你面试机会。',
    assessment: 'gap',
  },
  {
    group: '缺少可核对的证据',
    note: '你可能真会，但档案里没有能让人信的东西。这一类性价比最高——补证据比补知识容易得多。',
    assessment: 'lacking_evidence',
  },
  {
    group: '讲不到点上',
    note: '你可能会，但简历上的描述没能对应到这条要求。改表述就能解决，不需要新学东西。',
    assessment: 'partial',
  },
  {
    group: '暂时判断不了',
    note: '信息不足。补全档案或做一次能力问诊就能判。',
    assessment: 'unknown',
  },
];

export function buildMinimumCandidate(input: {
  profile: CandidateProfile;
  job: JobRequirement;
  /** 匹配引擎算出的逐条结论：要求 id → 结论。缺这一项就无从判断 */
  assessments?: Map<string, Assessment>;
}): MinimumCandidateResult {
  if (!isEnabled('match.minimum_candidate')) {
    return {
      supported: false,
      reason: '「最低通过简历画像」属于 v0.3 能力，当前版本暂未开放（见设置页「版本与能力」）。',
    };
  }

  const { job, assessments } = input;
  if (!assessments || assessments.size === 0) {
    return {
      supported: false,
      reason: '还没有这个岗位的匹配结论。先跑一次简历匹配，才能算出「最低还差什么」。',
    };
  }

  // 收集未满足的要求
  const byAssessment = new Map<Assessment, RequirementItem[]>();
  for (const item of job.items) {
    const a = assessments.get(item.id);
    if (!a || a === 'matched') continue;
    const list = byAssessment.get(a) ?? [];
    list.push(item);
    byAssessment.set(a, list);
  }

  const importanceRank: Record<string, number> = { high: 0, medium: 1, low: 2 };

  const buckets = BUCKETS.map((b) => {
    const items = byAssessment.get(b.assessment) ?? [];
    const sorted = [...items].sort((x, y) => {
      // 硬门槛在前；同类里按重要度降序
      if (x.hardGate !== y.hardGate) return x.hardGate ? -1 : 1;
      return importanceRank[y.importance] - importanceRank[x.importance];
    });
    return {
      group: b.group,
      items: sorted.map((it) => {
        const tag = it.hardGate ? '硬门槛' : it.importance === 'high' ? '重要' : '一般';
        return `[${tag}·${ASSESSMENT_LABEL[b.assessment]}] ${it.content}`;
      }),
      derivedFromRequirementIds: sorted.map((it) => it.id),
    };
  }).filter((b) => b.items.length > 0);

  if (buckets.length === 0) {
    return {
      supported: true,
      model: {
        jobId: job.id,
        targetRole: job.jobTitle,
        buckets: [],
        note: '按当前这个岗位的要求，你档案里已有的证据已经能逐条对应上了。没有需要补的最低项。',
      },
    };
  }

  const hardGapCount = (byAssessment.get('gap') ?? []).filter((i) => i.hardGate).length;
  const hardGateTotal = job.items.filter((i) => i.hardGate).length;

  const lines: string[] = ['这张清单只列「不补就够不上」的部分，不含加分项。'];
  if (hardGapCount > 0) {
    lines.push(
      `其中 ${hardGapCount} 项同时是硬门槛（共 ${hardGateTotal} 条）——` +
        '这一类通常在筛选阶段就被排除，补它才有意义；其它项可以不补。',
    );
  }
  lines.push('是否真的够得上取决于竞争情况与筛选方式，这个系统看不到，也不替你判断。');

  return {
    supported: true,
    model: {
      jobId: job.id,
      targetRole: job.jobTitle,
      buckets,
      note: lines.join('\n'),
    },
  };
}