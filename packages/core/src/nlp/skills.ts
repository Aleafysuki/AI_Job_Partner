import { escapeRegExp, hasCjk } from '../utils/text';

/**
 * 技能词典。
 *
 * 为什么需要它：
 * 文档第七节明确「匹配的单位不是关键词，而是 Requirement → Evidence → Assessment」，
 * 但要让机器判断「用户写的这段经历到底支撑哪种能力」，就必须先把
 * 「Python / python3 / 蟒蛇语言」这类不同写法归一到同一个标准能力名。
 *
 * 词典只负责「归一化」，不负责「判定是否满足」——判定在 MatchingEngine 里，
 * 且必须结合证据强度，不允许因为出现词就判定满足。
 */

export type SkillKind =
  | 'language' | 'frontend' | 'backend' | 'ai' | 'agent' | 'data' | 'devops'
  | 'test' | 'mobile' | 'design' | 'product' | 'seo' | 'content' | 'office'
  | 'soft' | 'certificate' | 'domain';

export const SKILL_KIND_LABEL: Record<SkillKind, string> = {
  language: '编程语言',
  frontend: '前端',
  backend: '后端与服务',
  ai: 'AI / LLM',
  agent: 'Agent / 工作流',
  data: '数据与数据库',
  devops: '工程化 / 部署',
  test: '测试',
  mobile: '移动端',
  design: '设计',
  product: '产品 / 运营',
  seo: 'SEO / 增长',
  content: '内容 / 文案',
  office: '办公 / 文档',
  soft: '软技能',
  certificate: '证书',
  domain: '领域知识',
};

export const SKILL_KIND_ORDER: SkillKind[] = [
  'language', 'frontend', 'backend', 'ai', 'agent', 'data', 'devops', 'test',
  'mobile', 'design', 'product', 'seo', 'content', 'office', 'soft', 'certificate', 'domain',
];

export interface SkillDef {
  /** 归一化标准名 */
  name: string;
  /** 其它写法（大小写不敏感） */
  aliases: string[];
  kind: SkillKind;
  /** 是否为「框架/工具」类，工具类证据通常弱于能力类 */
  isTool?: boolean;
}

export const SKILLS: SkillDef[] = [
  // ---------------- 编程语言 ----------------
  { name: 'Python', aliases: ['python3', 'python2', 'py'], kind: 'language' },
  { name: 'JavaScript', aliases: ['js', 'es6', 'ecmascript'], kind: 'language' },
  { name: 'TypeScript', aliases: ['ts', 'typescript'], kind: 'language' },
  { name: 'Java', aliases: ['java8', 'java se', 'jdk'], kind: 'language' },
  { name: 'C#', aliases: ['csharp', 'c sharp', '.net c#'], kind: 'language' },
  { name: 'C++', aliases: ['cpp', 'c plus plus'], kind: 'language' },
  { name: 'C 语言', aliases: ['c语言', 'ansi c'], kind: 'language' },
  { name: 'Go', aliases: ['golang', 'go语言'], kind: 'language' },
  { name: 'Rust', aliases: ['rustlang'], kind: 'language' },
  { name: 'PHP', aliases: ['php7', 'php8'], kind: 'language' },
  { name: 'Kotlin', aliases: [], kind: 'language' },
  { name: 'Swift', aliases: [], kind: 'language' },
  { name: 'Dart', aliases: [], kind: 'language' },
  { name: 'R 语言', aliases: ['r语言', 'rstudio'], kind: 'language' },
  { name: 'SQL', aliases: ['结构化查询语言'], kind: 'language' },
  { name: 'Shell', aliases: ['bash', 'shell脚本', 'powershell', 'bat'], kind: 'language' },
  { name: 'MATLAB', aliases: [], kind: 'language' },
  { name: 'Scala', aliases: [], kind: 'language' },
  { name: 'VB.NET', aliases: ['vb', 'vbnet'], kind: 'language' },

  // ---------------- 前端 ----------------
  { name: 'React', aliases: ['react.js', 'reactjs'], kind: 'frontend', isTool: true },
  { name: 'Vue', aliases: ['vue.js', 'vuejs', 'vue3', 'vue2'], kind: 'frontend', isTool: true },
  { name: 'Angular', aliases: ['angularjs'], kind: 'frontend', isTool: true },
  { name: 'Next.js', aliases: ['nextjs', 'next js'], kind: 'frontend', isTool: true },
  { name: 'Nuxt', aliases: ['nuxt.js', 'nuxtjs'], kind: 'frontend', isTool: true },
  { name: 'HTML5', aliases: ['html', '语义化标签'], kind: 'frontend' },
  { name: 'CSS3', aliases: ['css', 'css3', '样式'], kind: 'frontend' },
  { name: 'Tailwind CSS', aliases: ['tailwind', 'tailwindcss'], kind: 'frontend', isTool: true },
  { name: 'Sass/Less', aliases: ['sass', 'scss', 'less'], kind: 'frontend', isTool: true },
  { name: 'Webpack', aliases: [], kind: 'frontend', isTool: true },
  { name: 'Vite', aliases: [], kind: 'frontend', isTool: true },
  { name: '小程序开发', aliases: ['微信小程序', 'miniprogram', '小程序'], kind: 'frontend' },
  { name: 'Electron', aliases: [], kind: 'frontend', isTool: true },
  { name: 'Tauri', aliases: [], kind: 'frontend', isTool: true },
  { name: '响应式布局', aliases: ['自适应布局', '移动端适配', 'rem', '响应式'], kind: 'frontend' },
  { name: '前端工程化', aliases: ['构建优化', '打包优化', '前端性能优化'], kind: 'frontend' },
  { name: '浏览器扩展', aliases: ['chrome插件', '浏览器插件', '油猴脚本', 'tampermonkey'], kind: 'frontend' },
  { name: 'Web 性能优化', aliases: ['首屏优化', 'lighthouse', '性能优化'], kind: 'frontend' },
  { name: 'ECharts/图表可视化', aliases: ['echarts', 'chart.js', 'd3.js', '数据可视化', '图表'], kind: 'frontend', isTool: true },
  { name: '地图可视化', aliases: ['leaflet', 'mapbox', '高德地图', '百度地图', 'openlayers'], kind: 'frontend', isTool: true },

  // ---------------- 后端与服务 ----------------
  { name: 'Node.js', aliases: ['nodejs', 'node', 'express', 'koa', 'nestjs', 'nest.js', 'fastify'], kind: 'backend', isTool: true },
  { name: 'FastAPI', aliases: [], kind: 'backend', isTool: true },
  { name: 'Django', aliases: [], kind: 'backend', isTool: true },
  { name: 'Flask', aliases: [], kind: 'backend', isTool: true },
  { name: 'Spring Boot', aliases: ['spring', 'springboot', 'spring cloud'], kind: 'backend', isTool: true },
  { name: '.NET / ASP.NET', aliases: ['asp.net', '.net', 'dotnet', 'aspnet', '.net core', '.net 8'], kind: 'backend', isTool: true },
  { name: 'RESTful API', aliases: ['rest api', 'restful', 'rest接口', '接口开发', 'api开发'], kind: 'backend' },
  { name: 'GraphQL', aliases: [], kind: 'backend' },
  { name: 'WebSocket / 实时通信', aliases: ['websocket', 'socket.io', '实时通信', '长连接'], kind: 'backend' },
  { name: 'HTTP 协议', aliases: ['http', 'https协议', '请求头', '状态码'], kind: 'backend' },
  { name: 'JWT / 鉴权', aliases: ['jwt', 'oauth', '鉴权', '权限设计', '登录鉴权', '认证授权'], kind: 'backend' },
  { name: '微服务', aliases: ['microservice', '服务拆分', '分布式服务'], kind: 'backend' },
  { name: '消息队列', aliases: ['mq', 'kafka', 'rabbitmq', 'rocketmq'], kind: 'backend', isTool: true },
  { name: 'Redis', aliases: ['缓存设计', '缓存'], kind: 'backend', isTool: true },
  { name: '性能优化/高并发', aliases: ['高并发', '并发处理', '性能调优', '压测', '负载均衡'], kind: 'backend' },
  { name: 'Linux 服务器', aliases: ['linux', 'centos', 'ubuntu', '服务器运维'], kind: 'backend' },
  { name: 'Nginx', aliases: [], kind: 'devops', isTool: true },
  { name: 'Docker', aliases: ['容器化', 'docker-compose'], kind: 'devops', isTool: true },
  { name: 'Kubernetes', aliases: ['k8s'], kind: 'devops', isTool: true },
  { name: 'CI/CD', aliases: ['持续集成', 'jenkins', 'github actions', '流水线'], kind: 'devops' },
  { name: '云服务部署', aliases: ['云服务器', '阿里云', '腾讯云', 'aws', 'vercel', '部署上线'], kind: 'devops' },
  { name: 'Git', aliases: ['gitlab', 'github', 'gitee', '版本管理', '代码管理'], kind: 'devops', isTool: true },

  // ---------------- AI / LLM ----------------
  { name: '大语言模型应用', aliases: ['llm', '大模型', '大语言模型', '语言模型应用'], kind: 'ai' },
  { name: 'Prompt Engineering', aliases: ['提示词', 'prompt', '提示工程', 'prompt 工程'], kind: 'ai' },
  { name: '模型 API 调用', aliases: ['api调用', 'openai api', 'gpt api', 'claude api', 'deepseek api', '通义千问 api', '调用模型'], kind: 'ai' },
  { name: 'RAG 检索增强', aliases: ['rag', '检索增强', '知识库问答', '向量检索', 'embedding 检索'], kind: 'ai' },
  { name: '向量数据库', aliases: ['vector database', 'faiss', 'milvus', 'chroma', 'pinecone', 'pgvector'], kind: 'ai', isTool: true },
  { name: 'Embedding / 向量化', aliases: ['embedding', '向量化', '文本向量'], kind: 'ai' },
  { name: '模型微调', aliases: ['finetune', 'fine-tune', 'lora', '微调', 'sft'], kind: 'ai' },
  { name: '模型量化/本地部署', aliases: ['量化', 'gguf', 'onnx', 'llama.cpp', '本地部署模型', 'ollama', 'vllm'], kind: 'ai' },
  { name: '多模态', aliases: ['multimodal', '多模态模型', '图像理解', '语音识别'], kind: 'ai' },
  { name: 'AI 应用落地', aliases: ['ai应用', 'ai 产品', 'ai落地', 'ai 落地'], kind: 'ai' },
  { name: 'Token 成本控制', aliases: ['token', '成本控制', 'token 成本', '推理成本'], kind: 'ai' },
  { name: '模型评测', aliases: ['eval', '评测', '效果评测', 'benchmark'], kind: 'ai' },
  { name: 'PyTorch', aliases: ['torch', 'pytorch'], kind: 'ai', isTool: true },
  { name: 'TensorFlow', aliases: ['tensorflow', 'keras'], kind: 'ai', isTool: true },
  { name: '机器学习', aliases: ['machine learning', 'ml', '传统机器学习', 'sklearn', 'scikit-learn'], kind: 'ai' },
  { name: '深度学习', aliases: ['deep learning', '神经网络', 'cnn', 'rnn', 'transformer'], kind: 'ai' },
  { name: '计算机视觉', aliases: ['cv', 'opencv', 'ocr', '图像识别', '目标检测'], kind: 'ai' },
  { name: '自然语言处理', aliases: ['nlp', '文本分类', '命名实体识别', '分词'], kind: 'ai' },
  { name: '推荐算法', aliases: ['推荐系统', '召回排序', '协同过滤'], kind: 'ai' },
  { name: '语音处理', aliases: ['tts', 'asr', '语音合成', '语音识别'], kind: 'ai' },

  // ---------------- Agent / 工作流 ----------------
  { name: 'Agent 开发', aliases: ['ai agent', 'agent', '智能体', '智能体开发', 'agent 开发', 'agent应用', 'agent 应用'], kind: 'agent' },
  { name: '多 Agent 协作', aliases: ['multi-agent', '多智能体', '多 agent 协作', 'agent 编排'], kind: 'agent' },
  { name: 'Function Calling / 工具调用', aliases: ['function calling', 'tool use', '工具调用', 'function call'], kind: 'agent' },
  { name: '工作流编排', aliases: ['workflow', '工作流', '流程编排', '自动化流程'], kind: 'agent' },
  { name: 'Dify', aliases: [], kind: 'agent', isTool: true },
  { name: 'Coze / 扣子', aliases: ['coze', '扣子'], kind: 'agent', isTool: true },
  { name: 'n8n', aliases: [], kind: 'agent', isTool: true },
  { name: 'LangChain', aliases: ['langchain', 'langgraph', 'llamaindex'], kind: 'agent', isTool: true },
  { name: 'MCP 协议', aliases: ['mcp', 'model context protocol'], kind: 'agent' },
  { name: 'AutoGPT / 自主智能体', aliases: ['autogpt', '自主智能体', 'autonomous agent'], kind: 'agent' },

  // ---------------- 数据 ----------------
  { name: 'MySQL', aliases: ['mariadb'], kind: 'data', isTool: true },
  { name: 'PostgreSQL', aliases: ['postgres', 'pgsql'], kind: 'data', isTool: true },
  { name: 'MongoDB', aliases: ['mongo'], kind: 'data', isTool: true },
  { name: 'SQLite', aliases: [], kind: 'data', isTool: true },
  { name: '数据库设计', aliases: ['表结构设计', '范式', '索引优化', '数据建模'], kind: 'data' },
  { name: 'SQL 查询与优化', aliases: ['sql优化', '复杂查询', '慢查询'], kind: 'data' },
  { name: 'Pandas / NumPy', aliases: ['pandas', 'numpy', '数据处理库'], kind: 'data', isTool: true },
  { name: '数据清洗', aliases: ['数据预处理', 'etl', '数据整理', '去重'], kind: 'data' },
  { name: '数据采集 / 爬虫', aliases: ['爬虫', '抓取', 'scrapy', 'selenium', 'playwright', 'requests', '采集', '网页采集'], kind: 'data' },
  { name: '数据分析', aliases: ['数据分析', '数据统计', '指标分析', '漏斗分析', '留存分析'], kind: 'data' },
  { name: '数据可视化报表', aliases: ['bi', 'tableau', 'power bi', '看板', '报表'], kind: 'data', isTool: true },
  { name: 'Excel 数据处理', aliases: ['excel', '数据透视表', 'vlookup', 'wps 表格'], kind: 'office', isTool: true },
  { name: '数据合规 / 隐私', aliases: ['数据合规', '隐私保护', '脱敏', '个人信息保护'], kind: 'data' },

  // ---------------- 测试 ----------------
  { name: '软件测试', aliases: ['测试用例', '功能测试', 'qa'], kind: 'test' },
  { name: '自动化测试', aliases: ['selenium 测试', 'pytest', 'jest', 'cypress', '单元测试', '自动化脚本测试'], kind: 'test' },
  { name: '接口测试', aliases: ['postman', 'api 测试', 'jmeter'], kind: 'test', isTool: true },

  // ---------------- 移动端 ----------------
  { name: 'Android 开发', aliases: ['android', '安卓', 'android studio'], kind: 'mobile' },
  { name: 'iOS 开发', aliases: ['ios', 'xcode', 'swiftui'], kind: 'mobile' },
  { name: 'Flutter', aliases: ['flutter'], kind: 'mobile', isTool: true },
  { name: 'React Native', aliases: ['react-native'], kind: 'mobile', isTool: true },
  { name: 'Uni-app', aliases: ['uniapp', 'uni-app'], kind: 'mobile', isTool: true },

  // ---------------- 设计 ----------------
  { name: 'UI 设计', aliases: ['界面设计', 'ui', '视觉设计', '界面稿'], kind: 'design' },
  { name: 'UX / 交互设计', aliases: ['ux', '交互设计', '用户体验', '原型设计'], kind: 'design' },
  { name: 'Figma', aliases: ['figma', 'sketch', 'xd', 'axure', '墨刀', '即时设计'], kind: 'design', isTool: true },
  { name: 'Photoshop', aliases: ['ps', 'photoshop'], kind: 'design', isTool: true },
  { name: 'Illustrator', aliases: ['ai 绘图', 'illustrator'], kind: 'design', isTool: true },
  { name: '平面设计', aliases: ['海报设计', 'banner', '物料设计', '排版'], kind: 'design' },
  { name: '视频剪辑', aliases: ['pr', 'premiere', '剪映', '剪辑', 'ae', 'after effects', '达芬奇'], kind: 'design', isTool: true },
  { name: '3D 建模', aliases: ['blender', '3dmax', 'maya', 'c4d', '建模'], kind: 'design', isTool: true },
  { name: '设计规范 / 组件库', aliases: ['设计规范', 'design system', '组件库', 'ui 规范'], kind: 'design' },

  // ---------------- 产品 / 运营 ----------------
  { name: '需求分析', aliases: ['需求梳理', '需求文档', 'prd', '需求评审'], kind: 'product' },
  { name: '产品设计', aliases: ['产品经理', '产品规划', '产品方案'], kind: 'product' },
  { name: '竞品分析', aliases: ['竞品调研', '行业调研', '市场调研'], kind: 'product' },
  { name: '用户研究', aliases: ['用户访谈', '问卷调查', '用户画像'], kind: 'product' },
  { name: '项目管理', aliases: ['项目推进', '排期', '敏捷', 'scrum', '跨部门协作推进'], kind: 'product' },
  { name: '用户运营', aliases: ['社群运营', '用户增长', '拉新', '促活', '留存运营'], kind: 'product' },
  { name: '活动运营', aliases: ['活动策划', '营销活动', '落地活动'], kind: 'product' },
  { name: '内容运营', aliases: ['内容策划', '选题', '内容矩阵', '账号运营'], kind: 'content' },
  { name: '数据驱动运营', aliases: ['数据驱动', 'a/b 测试', 'abtest', '效果复盘'], kind: 'product' },

  // ---------------- SEO / 增长 ----------------
  { name: 'SEO', aliases: ['搜索引擎优化', '关键词优化', '站内优化', '外链', 'seo优化'], kind: 'seo' },
  { name: 'SEM / 投放', aliases: ['sem', '竞价', '信息流', 'adwords', '投放优化'], kind: 'seo' },
  { name: 'GEO / AI 搜索优化', aliases: ['geo', '生成式引擎优化', 'ai 搜索优化', 'ai搜索'], kind: 'seo' },
  { name: '关键词研究', aliases: ['关键词挖掘', '关键词布局', '长尾词'], kind: 'seo' },
  { name: '网站分析', aliases: ['google analytics', 'ga4', '百度统计', '流量分析', '站长工具'], kind: 'seo', isTool: true },
  { name: '内容营销', aliases: ['内容获客', '获客', '转化率优化', 'cro'], kind: 'seo' },

  // ---------------- 内容 / 文案 ----------------
  { name: '文案写作', aliases: ['撰写文案', '文案', '写作'], kind: 'content' },
  { name: '技术写作 / 文档', aliases: ['技术文档', '文档撰写', '说明书', 'apidoc', '技术博客'], kind: 'content' },
  { name: '新媒体内容', aliases: ['小红书', '公众号', '知乎', '抖音内容', '短视频脚本'], kind: 'content' },
  { name: '翻译 / 英语能力', aliases: ['英语', 'cet-4', 'cet4', 'cet-6', 'cet6', '雅思', '托福', 'ielts', 'toefl', 'english'], kind: 'content' },

  // ---------------- 办公 ----------------
  { name: 'Word 文档排版', aliases: ['word', '文档排版', 'wps 文字'], kind: 'office', isTool: true },
  { name: 'PPT 制作', aliases: ['ppt', '幻灯片', '演示文稿', 'keynote'], kind: 'office', isTool: true },
  { name: 'Office 办公套件', aliases: ['office', 'wps', '办公软件', 'microsoft office'], kind: 'office', isTool: true },
  { name: '流程自动化', aliases: ['流程自动化', 'rpa', '自动化脚本', '脚本工具'], kind: 'office' },
  { name: 'GitHub 使用 / 开源协作', aliases: ['开源贡献', 'pull request', 'issue 管理'], kind: 'office' },

  // ---------------- 软技能 ----------------
  { name: '沟通表达', aliases: ['沟通能力', '表达能力', '沟通协作', '善于沟通'], kind: 'soft' },
  { name: '团队协作', aliases: ['协作能力', '团队合作', '配合团队'], kind: 'soft' },
  { name: '独立解决问题', aliases: ['解决问题能力', '问题定位', '排查问题', 'debug 能力', '独立完成'], kind: 'soft' },
  { name: '学习能力', aliases: ['快速学习', '自驱学习', '主动学习', '学习能力强'], kind: 'soft' },
  { name: '责任心 / 抗压', aliases: ['抗压能力', '责任心', '目标感', '自驱力', '主动性强'], kind: 'soft' },
  { name: '细致严谨', aliases: ['细致', '严谨', '耐心', '注重细节'], kind: 'soft' },
  { name: '时间管理', aliases: ['多任务处理', '时间管理', '优先级管理'], kind: 'soft' },
  { name: '客户沟通 / 需求对接', aliases: ['对接客户', '客户沟通', '需求对接', '售前支持'], kind: 'soft' },

  // ---------------- 证书 ----------------
  { name: '学历：本科及以上', aliases: ['本科', '全日制本科', '统招本科', '学士'], kind: 'certificate' },
  { name: '学历：大专及以上', aliases: ['大专', '专科'], kind: 'certificate' },
  { name: '学历：硕士及以上', aliases: ['硕士', '研究生', 'mba'], kind: 'certificate' },
  { name: '计算机等级证书', aliases: ['计算机二级', '计算机三级', 'ncre'], kind: 'certificate' },
  { name: '软件著作权 / 专利', aliases: ['软著', '专利', '论文发表'], kind: 'certificate' },

  // ---------------- 领域知识 ----------------
  { name: '电商业务', aliases: ['电商', '跨境电商', '店铺运营'], kind: 'domain' },
  { name: '音视频 / 游戏行业', aliases: ['游戏行业', '音游', '直播行业'], kind: 'domain' },
  { name: '金融 / 财务知识', aliases: ['金融', '财务分析', '会计'], kind: 'domain' },
  { name: '医疗 / 生物信息', aliases: ['医疗', '生物信息', '生物统计'], kind: 'domain' },
  { name: '教育 / 培训', aliases: ['教育培训', '课程设计', '教研'], kind: 'domain' },
  { name: '法律 / 合规', aliases: ['法律', '合规', '知识产权'], kind: 'domain' },
  { name: '旅游 / 酒店行业', aliases: ['旅游', '酒店', 'ota', '民宿'], kind: 'domain' },
  { name: '制造业 / 硬件', aliases: ['制造业', '硬件', '嵌入式', '单片机', 'iot', '物联网'], kind: 'domain' },
];

const ALIAS_INDEX = new Map<string, SkillDef>();
for (const def of SKILLS) {
  ALIAS_INDEX.set(def.name.toLowerCase(), def);
  for (const alias of def.aliases) {
    const key = alias.toLowerCase();
    if (!ALIAS_INDEX.has(key)) ALIAS_INDEX.set(key, def);
  }
}

const MATCHER_CACHE = new Map<string, RegExp>();

function matcherFor(term: string): RegExp {
  const cached = MATCHER_CACHE.get(term);
  if (cached) return cached;
  const escaped = escapeRegExp(term);
  // 拉丁术语要求词边界，避免 "js" 命中 "组件" 里的字母组合；中文术语直接子串匹配
  const source = hasCjk(term)
    ? escaped
    : `(?<![A-Za-z0-9+#])${escaped}(?![A-Za-z])`;
  const re = new RegExp(source, 'i');
  MATCHER_CACHE.set(term, re);
  return re;
}

export interface SkillHit {
  def: SkillDef;
  /** 文本中实际命中的写法 */
  matched: string;
}

/** 在文本里找出所有技能，同一技能只返回一次 */
export function findSkillsInText(text: string): SkillHit[] {
  if (!text) return [];
  const out: SkillHit[] = [];
  const seen = new Set<string>();
  for (const def of SKILLS) {
    const terms = [def.name, ...def.aliases];
    for (const term of terms) {
      const re = matcherFor(term);
      const m = re.exec(text);
      if (m) {
        if (seen.has(def.name)) break;
        seen.add(def.name);
        out.push({ def, matched: m[0] });
        break;
      }
    }
  }
  return out;
}

/** 文本是否提到某个能力（按标准名或别名） */
export function textMentionsSkill(skillName: string, text: string): boolean {
  const def = resolveSkill(skillName);
  const terms = def ? [def.name, ...def.aliases] : [skillName];
  return terms.some((term) => matcherFor(term).test(text));
}

/** 把任意写法归一化到词典里的标准能力 */
export function resolveSkill(raw: string): SkillDef | undefined {
  const key = (raw ?? '').trim().toLowerCase();
  if (!key) return undefined;
  const direct = ALIAS_INDEX.get(key);
  if (direct) return direct;
  // 允许「Python 开发」「熟悉 React」这类带修饰的写法
  for (const def of SKILLS) {
    const terms = [def.name, ...def.aliases];
    if (terms.some((t) => key.includes(t.toLowerCase()))) return def;
  }
  return undefined;
}

export function aliasesOf(skillName: string): string[] {
  const def = resolveSkill(skillName);
  return def ? def.aliases : [];
}

export function skillKindOf(skillName: string): SkillKind {
  return resolveSkill(skillName)?.kind ?? 'domain';
}

/** 把一批原始写归一化成标准名并去重 */
export function normalizeSkillList(raws: string[]): string[] {
  const out: string[] = [];
  for (const raw of raws) {
    const def = resolveSkill(raw);
    const name = def ? def.name : raw.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
