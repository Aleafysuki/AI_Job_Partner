/**
 * 面试官问答推荐（v0.4）
 * =====================
 *
 * 用户的需求原话：「求职引导这边可以考虑做一下面试官问答推荐，
 * 比如可以根据自己的实际情况进行问题的回答（用户发问题过来）。当然这部分做个免责声明。」
 *
 * ## 它与已有功能的区别
 *
 * | 功能 | 方向 | 谁出题 |
 * | --- | --- | --- |
 * | 能力问诊 | 系统问 → 用户答 | 系统 |
 * | 薄弱项训练 | 系统出题 → 用户答 | 系统 |
 * | **面试问答推荐** | **用户拿面试官的问题来 → 系统给答法** | **用户** |
 *
 * 最后一列是它存在的理由：面试官的问题是**用户已经拿在手里的**，
 * 可能是从招聘网站的「面试会问什么」看到的，也可能 HR 微信里直接发的。
 * 用户此刻需要的是「这句话该怎么接」，而不是「再给我十道题」。
 *
 * ## 免责声明为什么必须硬编码在数据里
 *
 * 这一条是用户明确要求的，但它不只是合规姿态 —— 它防止产品被误用成
 * 「面试答案生成器」。一旦系统给出可以直接照抄的答案，
 * 用户就会去背它，而背出来的答案在追问下必然崩掉。
 *
 * 所以本模块的设计立场是：
 *   **给结构，不给台词。**
 *   输出「这个回答必须覆盖哪几点」「你能引用档案里的哪条证据」
 *   「对方可能接着追问什么」，而不是「你可以这样回答」。
 *
 * 措辞上也全部改成「要点」「结构建议」，不用「参考话术」——
 * 后者会直接被当成可背诵的稿子。
 */

/** 面试问题被归到哪一类 —— 分类决定给哪种答法 */
export type InterviewQuestionKind =
  /** 问经历：讲一件具体的事 */
  | 'behavioral'
  /** 问技术：概念、原理、方案 */
  | 'technical'
  /** 问动机：为什么来、为什么选我们 */
  | 'motivation'
  /** 问现状：薪资、离职原因、当前状态 */
  | 'situation'
  /** 问协作：和同事/上级/产品的关系 */
  | 'collaboration'
  /** 问规划：未来打算、职业规划 */
  | 'future'
  /** 问压力：难处、失败、扛不住的时候 */
  | 'pressure'
  /** 问匹配：为什么你适合这个岗位 */
  | 'fit';

export const QUESTION_KIND_LABEL: Record<InterviewQuestionKind, string> = {
  behavioral: '经历类',
  technical: '技术类',
  motivation: '动机类',
  situation: '现状类',
  collaboration: '协作类',
  future: '规划类',
  pressure: '压力类',
  fit: '匹配类',
};

/** 每一类问题的回答结构 —— 这是本模块真正的产出物 */
export interface AnswerBlueprint {
  kind: InterviewQuestionKind;
  /** 这一类回答必须覆盖的要点，2-4 条 */
  mustCover: string[];
  /** 常见但容易踩的坑 */
  pitfall: string;
  /** 面试官通常顺着哪一句继续追问 */
  followUpLikely: string;
}

export const ANSWER_BLUEPRINTS: Record<InterviewQuestionKind, AnswerBlueprint> = {
  behavioral: {
    kind: 'behavioral',
    mustCover: [
      '当时的情况：时间、场合、对方是谁、为什么这件事要找我',
      '我做的具体动作：一句话里至少有一个可观察的动作，不是「我参与了」而是「我做了 X」',
      '结果与反馈：对方的态度变化、可量化的影响，哪怕只是一句「他后来主动来找我了」',
    ],
    pitfall:
      '讲成流水账，或者只讲「我做了什么」不讲「为什么这么做」—— 追问一句「为什么这么选」就断了。',
    followUpLikely: '「如果重来一次，你会改哪一步？」',
  },
  technical: {
    kind: 'technical',
    mustCover: [
      '先给结论或原理主干，别从历史讲起',
      '说清边界：什么情况下这个方案会失效',
      '用你真做过的场景举例，而不是教科书上的例子',
    ],
    pitfall:
      '只背定义不说自己用过什么。面试官追问「你在项目里怎么用的」时，答不上来就等于没答。',
    followUpLikely: '「那你觉得这个方案的代价是什么？有没有更快的做法？」',
  },
  motivation: {
    kind: 'motivation',
    mustCover: [
      '说具体的：是这个岗位的哪一部分吸引你，而不是「贵司发展很好」',
      '接上你自己的积累：为什么是现在、为什么是你',
      '避免贬低前东家，也不必说前东家的坏话',
    ],
    pitfall: '背公司的宣传语。面试官一听就知道这不是你想的。',
    followUpLikely: '「你还看了哪些机会？为什么没去那边？」',
  },
  situation: {
    kind: 'situation',
    mustCover: [
      '给具体数字或状态，而不是「还行」「比较忙」',
      '说清这个状态对你找下一份工作的影响（如果有影响，别装没事）',
      '如果还在职，说清离职原因时要中性且可核对',
    ],
    pitfall:
      '模糊表述。面试官无法判断你是在保留底牌还是真的不清楚 —— 两种都减分。',
    followUpLikely: '「那你期望的薪资是多少？手上有 offer 吗？」',
  },
  collaboration: {
    kind: 'collaboration',
    mustCover: [
      '举一件具体的事：谁、什么时候、你和他意见不一致',
      '说清你怎么处理的（不是「我们沟通了一下」这种没有内容的表述）',
      '结果：分歧解决了没有，解决了之后关系如何',
    ],
    pitfall: '说自己「人缘好」「从不冲突」。任何人都这么说，等于什么都没说。',
    followUpLikely: '「跟同事有矛盾的时候，一般是谁先妥协？」',
  },
  future: {
    kind: 'future',
    mustCover: [
      '给方向不给空话：你想在什么方向上积累，而不是「想学习更多」',
      '说清这个方向和这个岗位的关系 —— 面试官关心的是你会不会待得住',
      '承认你还不知道的部分，比装确定要好',
    ],
    pitfall: '把规划说成晋升欲望，会让面试官担心你只是跳板。',
    followUpLikely: '「这个方向你有什么具体打算？最近在看什么？」',
  },
  pressure: {
    kind: 'pressure',
    mustCover: [
      '选一件真的难的事：难度具体在哪，不要选那种「时间很紧」的假难题',
      '说清你在里面具体处理了什么，而不是团队一起扛',
      '结果如果不好，也要诚实，并说你从中学到什么',
    ],
    pitfall:
      '选一个太轻松的失败故事，或者把责任全推给外部因素 —— 两者都显得不真诚。',
    followUpLikely: '「那件事里，谁的责任更大？」',
  },
  fit: {
    kind: 'fit',
    mustCover: [
      '直接对应岗位要求说，不要泛泛谈性格',
      '引用你档案里的具体证据（系统会替你列出来），而不是形容词',
      '主动说出你对这个岗位还不懂的地方 —— 面试官会告诉你，隐瞒没有好处',
    ],
    pitfall: '把「我很努力、我很负责」当答案。这些词对任何岗位都成立，所以没有区分度。',
    followUpLikely: '「你觉得这个岗位最难的地方是什么？」',
  },
};

/**
 * 一条能引用的证据。
 *
 * 刻意只给**原文与出处**，不给「可以这样表述」的改写 ——
 * 改写会变成代写，而代写出来的内容一旦说错，责任在系统。
 */
export interface CitableEvidence {
  evidenceId: string;
  title: string;
  /** 原文片段 */
  excerpt: string;
  kind: string;
  strength: 'strong' | 'medium' | 'weak' | 'none';
}

export interface PreparedQuestion {
  id: string;
  /** 用户原样输入的问题 */
  text: string;
  kind: InterviewQuestionKind;
  kindLabel: string;
  /** 回答结构 */
  blueprint: AnswerBlueprint;
  /** 档案里可能相关的证据（按关键词匹配，可能匹配不准，所以标明「可能相关」） */
  citable: CitableEvidence[];
  /** 这道问题和你档案的对接情况 */
  coverage: {
    /** 档案里有能直接对应上的内容吗 */
    hasEvidence: boolean;
    /** 档案里提到过这个问题涉及的能力吗 */
    skillMatched: boolean;
    /** 一句话告诉用户「这个问题你的档案里有没有东西」 */
    note: string;
  };
  /** 无模型时的兜底提醒；有模型时会是更具体的针对性提示 */
  advice: string;
}

export interface PrepareQuestionsOutput {
  items: PreparedQuestion[];
  /** 本次用了模型吗 */
  engine: 'rule' | 'ai' | 'hybrid';
  warnings: string[];
}

/**
 * 免责声明。
 *
 * 硬编码在数据里而不是写在页面上，原因：页面文案容易被后续改动覆盖，
 * 而免责是产品立场的一部分，必须与内容同源、不可被省略。
 *
 * 措辞刻意写明「结构建议」而不是「参考话术」——
 * 后者会被当成可背诵的稿子，而背出来的答案在追问下会崩。
 */
export const ANSWER_DISCLAIMER = {
  headline: '这里给的是回答结构，不是标准答案',
  points: [
    '系统不会替你生成可以直接照说的答案。它只告诉你「这个回答必须覆盖哪几点」，内容必须由你自己填。',
    '引用的证据只做提示，不能当成话术。照抄档案原文答面试，面试官追问两句就会露馅。',
    '这里不预测面试结果，也不判断某个答案「好不好」—— 那取决于面试官，工具无法代劳。',
    '你的档案、简历与这些问题都只保存在本机，不会因为用了这一页被发到别处。',
  ],
} as const;
