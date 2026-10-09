/**
 * UI 端到端冒烟测试。
 *
 * 为什么不装独立的浏览器自动化工具：这个项目已经带了 Electron（真实 Chromium），
 * 用它加载打包后的渲染进程可以直接验证「界面能起来 + 完整流程能跑通」，
 * 而且不需要额外下载几百兆的浏览器。
 *
 * 运行：
 *   node_modules/electron/dist/electron.exe apps/desktop/scripts/ui-smoke.cjs
 *
 * 覆盖范围：
 *   v0.1 主链路：载入示例 → 解析简历 → 拆解岗位 → 匹配 → 校验报告
 *   v0.2 新链路：能力问诊（逐题作答 → 生成结论 → 校验证据封顶）
 *                薄弱项训练（生成计划 → 作答自评 → 校验进度）
 *   v0.2 追加：  面试复盘（导入转写 → 生成复盘 → 校验 18 维报告结构）
 *
 * 关于录音：本脚本不验证真实录音。冒烟运行环境没有音频输入设备，
 * 而「假装录上了」比「没验证」更糟 —— 所以这里刻意只覆盖
 * 「转写文本 → 复盘报告」这条不依赖硬件、但完整跑通分析链路的部分。
 * 录音与内录需要人工在真机上验证（见 README 的验证手段一节）。
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'out', 'renderer', 'index.html');
const SHOTS = path.resolve(ROOT, '..', '..', 'screenshots');

// 隔离的运行环境：
// 某些受限环境（容器 / 沙箱 / 无 GPU 访问）里 Chromium 的 GPU 进程会直接崩溃，
// 导致 Electron 以 "GPU process isn't usable. Goodbye." 退出。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.setPath('userData', path.join(os.tmpdir(), `aijob-smoke-${process.pid}`));

const consoleErrors = [];
const results = {};

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(win, expression, timeoutMs, label) {
  const started = Date.now();
  process.stderr.write(`  · 等待：${label}（最多 ${timeoutMs}ms）\n`);
  while (Date.now() - started < timeoutMs) {
    // catch：渲染进程无 GPU 时 executeJavaScript 可能以 UnknownVizError 失败。
    // 那一轮当作「还没满足」继续等，而不是让整条冒烟挂住。
    const ok = await win.webContents
      .executeJavaScript(`(() => { try { return Boolean(${expression}); } catch (e) { return false; } })()`)
      .catch(() => false);
    if (ok) {
      process.stderr.write(`  ✓ ${label}\n`);
      return true;
    }
    await delay(300);
  }
  throw new Error(`等待超时：${label}`);
}

/** 等两帧 + 一小段静默，确保真的画出来了再截图（否则会截到白屏） */
/**
 * 等两帧，让界面稳定下来再截图 / 读 DOM。
 *
 * 加超时与 catch 的原因（本机无 GPU 时踩过，症状是「跑到一半停住且无任何报错」）：
 *   1. requestAnimationFrame 在无 GPU 环境下偶尔不触发，不设上限就会一直挂着；
 *   2. executeJavaScript 可能以 UnknownVizError 失败，它冒出去会用一个
 *      与真实原因无关的错把整条链路盖掉。
 */
async function settle(win) {
  try {
    await Promise.race([
      win.webContents
        .executeJavaScript(
          'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 260))))',
        )
        .catch(() => 'errored'),
      delay(15_000).then(() => 'timeout'),
    ]);
  } catch {
    await delay(400);
  }
}

/** 因截图超时被跳过的名字。空数组 = 全部成功 */
const shotsSkipped = [];

async function shoot(win, name) {
  await settle(win);
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);

  // 超时后必须吞掉那个还在跑的 capturePage：它稍后返回时携带的错误会被
  // Electron 当成未捕获异常抛出，表现为一串看不懂的 "UnknownVizError"。
  //
  // 加这层的原因：本机没有 GPU，capturePage 偶尔会长时间不返回 ——
  // 截图只是留档证据，不值得用它换掉后面所有断言。
  const pending = win.webContents.capturePage().catch(() => null);
  let timedOut = false;
  const guard = delay(20_000).then(() => {
    timedOut = true;
    return null;
  });

  const image = await Promise.race([pending, guard]);
  if (timedOut || !image) {
    void pending;
    shotsSkipped.push(name);
    process.stderr.write(`  ⚠ 截图超时已跳过：${name}（本机无 GPU 时的已知问题）\n`);
    return null;
  }
  fs.writeFileSync(file, image.toPNG());
  const size = fs.statSync(file).size;
  if (size < 20_000) throw new Error(`截图疑似空白：${file}（${size} bytes）`);
  return file;
}

async function clickByText(win, text) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const nodes = Array.from(document.querySelectorAll('button, a'));
    const hit = nodes.find((n) => (n.textContent || '').replace(/\\s+/g, '').includes(${JSON.stringify(text)}));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`找不到按钮：${text}`);
  await delay(400);
}

/** 在受控组件里写入文本（React 需要走原生 setter + input 事件） */
const SET_TEXT_HELPER = `
  const __setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
`;

async function main() {
  if (!fs.existsSync(RENDERER)) {
    throw new Error(`找不到构建产物 ${RENDERER}，请先执行 npm run build`);
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 940,
    show: true,
    title: 'AI Job Partner · UI 冒烟测试',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  win.webContents.on('console-message', (event) => {
    const level = event && typeof event === 'object' ? event.level : undefined;
    const message = event && typeof event === 'object' ? event.message : String(event);
    if (level === 'error' || level === 3 || /error/i.test(String(level))) {
      // 带上出错脚本：只记 message 的话，「Uncaught SyntaxError」这类错
      // 无法定位到是哪个文件加载失败（2026-10-08 为此排查了很久）
      const src = event && typeof event === 'object' && event.sourceId ? ` @ ${event.sourceId.split('/').pop()}:${event.lineNumber}` : '';
      consoleErrors.push(`${String(message)}${src}`);
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    consoleErrors.push(`渲染进程崩溃：${JSON.stringify(details)}`);
  });

  await win.loadFile(RENDERER);

  // 0) 保证从干净状态开始（否则上一次的数据会让「载入示例」按钮不存在）
  await waitFor(win, `document.querySelector('#root') && document.querySelector('#root').childElementCount > 0`, 20000, 'React 应用挂载');
  await win.webContents.executeJavaScript(`window.localStorage.clear()`);
  await win.webContents.executeJavaScript(`location.reload()`);
  await delay(900);

  // 1) 首次使用引导
  await waitFor(win, `document.body.innerText.includes('先告诉我一些关于你的事情')`, 15000, '首次使用引导');
  results.mounted = true;
  results.onboardingVisible = true;
  results.shotWorkbenchEmpty = await shoot(win, '01-工作台-首次使用');

  // 2) 一键跑示例：简历 → 档案 → 岗位 → 匹配
  await clickByText(win, '载入示例数据');
  await waitFor(win, `document.body.innerText.includes('匹配分析报告')`, 60000, '匹配报告生成');
  await delay(600);

  const report = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    const pick = (label) => {
      const m = text.match(new RegExp(label + '\\\\s*\\\\n?\\\\s*(\\\\d+)'));
      return m ? Number(m[1]) : null;
    };
    return {
      total: pick('要求总数'),
      matched: pick('满足'),
      partial: pick('部分满足'),
      lacking: pick('缺少证据'),
      gap: pick('明显缺口'),
      unknown: pick('无法判断'),
      hasPriority: text.includes('接下来应该改什么'),
      hasWhyNot: text.includes('我为什么是现在这个判断'),
      hasDisclaimer: text.includes('不代表招聘方的实际筛选结果'),
      hasEvidenceChain: text.includes('完整判定链与原文出处'),
      matchCardCount: document.querySelectorAll('p.font-medium.leading-relaxed').length,
    };
  })()`);
  results.report = report;
  results.shotReport = await shoot(win, '02-匹配报告');

  // 3) 档案页
  await clickByText(win, '我的能力档案');
  await waitFor(win, `document.body.innerText.includes('技能清单')`, 10000, '档案页');
  results.shotProfile = await shoot(win, '03-我的能力档案');

  await clickByText(win, '证据');
  await delay(400);
  results.shotEvidence = await shoot(win, '04-证据清单');

  // 岗位页
  await clickByText(win, '岗位分析');
  await waitFor(win, `document.body.innerText.includes('岗位要求')`, 10000, '岗位页');
  results.shotJob = await shoot(win, '05-岗位拆解');

  // 设置页
  await clickByText(win, '设置');
  await waitFor(win, `document.body.innerText.includes('分析引擎')`, 10000, '设置页');
  results.shotSettings = await shoot(win, '06-设置-AI-Provider');
  await clickByText(win, '版本与能力');
  await waitFor(win, `document.body.innerText.includes('铁律')`, 10000, '版本能力页');
  await settle(win);
  results.shotVersion = await shoot(win, '07-设置-版本与能力');

  // -------------------------------------------------------------------------
  // 4) v0.2：能力问诊
  // -------------------------------------------------------------------------
  await clickByText(win, '能力问诊');
  await waitFor(win, `document.body.innerText.includes('建议先问这些')`, 10000, '能力问诊起始页');
  await settle(win);
  results.shotInterviewStart = await shoot(win, '08-能力问诊-推荐项');

  await clickByText(win, '开始问诊');
  await waitFor(win, `document.body.innerText.includes('能力问诊 ·')`, 10000, '问诊问答页');

  // 逐题作答：读取题卡上的「层次」标签判断当前题型，再给对应答案
  // （不按题干关键词匹配 —— 题目模板会随技能种类变化，那样写很脆）
  const answered = await win.webContents.executeJavaScript(`(async () => {
    ${SET_TEXT_HELPER}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const LAYERS = ['自评', '具体场景', '使用深度', '产出结果', '认知边界'];
    const ANSWERS = {
      '具体场景': '在公司内部知识库项目里用过，接入了 300 多份文档，负责检索这一段。',
      '使用深度': '遇到过召回不准的问题，因为切分粒度太粗，后来按标题层级切分并加了重排。',
      '产出结果': '准确率从 61% 提升到 84%，2024 年上线。',
      '认知边界': '向量库索引调优还没深入，多路召回的策略也不太确定。',
    };
    const seen = [];
    let count = 0;

    // 题卡与「已回答」列表用的是同一套层标签（ASSESS_LAYER_LABEL），
    // 所以不能全页面搜 span —— 答完之后「已回答」列表里的标签还在，
    // 会导致脚本反复找到第一题、点不到「生成问诊结论」，表现为冒烟卡住。
    //
    // 正解：只在**含有「下一题」按钮的那个容器**里找层标签。
    // 「已回答」列表里没有「下一题」，天然被排除。
    const currentBadge = () => {
      const card = Array.from(document.querySelectorAll('div')).find((d) => {
        if (!Array.from(d.querySelectorAll('span')).some((s) => LAYERS.includes((s.textContent || '').trim()))) return false;
        return Array.from(d.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '下一题');
      });
      if (!card) return null;
      return Array.from(card.querySelectorAll('span'))
        .map((s) => (s.textContent || '').trim())
        .find((t) => LAYERS.includes(t)) || null;
    };

    const finishNow = () =>
      Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('生成问诊结论'));

    for (let i = 0; i < 12; i += 1) {
      // 已经能生成结论了，说明答完了 —— 立刻退出，别再多转一圈
      if (finishNow()) break;

      const badge = currentBadge();
      if (!badge) break;
      seen.push(badge);

      // 只在当前题卡里操作，避免误点到导航或「已回答」列表里的同名按钮
      const card = Array.from(document.querySelectorAll('div')).find(
        (d) =>
          Array.from(d.querySelectorAll('span')).some((s) => (s.textContent || '').trim() === badge) &&
          Array.from(d.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '下一题'),
      );
      if (!card) break;

      if (badge === '自评') {
        // v0.3：不要硬编码具体选项文案。
        // 自评选项会随能力形状变化（软技能走 BEHAVIORAL_SCALE_OPTIONS，
        // 技术能力走 SELF_REPORT_OPTIONS），写死文案会在换题库后静默失败。
        // 这里取题卡里除工具按钮外的最后一个按钮（选项按档位从低到高排列）。
        const options = Array.from(card.querySelectorAll('button')).filter((b) => {
          const t = (b.textContent || '').trim();
          if (!t || t === '下一题' || t.includes('我没做过') || t.includes('想不起来')) return false;
          return true;
        });
        const option = options[options.length - 1];
        if (!option) break;
        option.click();
      } else {
        const area = card.querySelector('textarea');
        if (!area) break;
        __setValue(area, ANSWERS[badge] || '在项目里用过它。');
      }
      await sleep(180);

      const next = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '下一题');
      if (!next || next.disabled) break;
      next.click();
      count += 1;
      await sleep(280);
    }

    const finish = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('生成问诊结论'));
    return { count, seen, hasFinish: Boolean(finish) };
  })()`);
  results.interviewAnswered = answered;

  await clickByText(win, '生成问诊结论');
  await waitFor(win, `document.body.innerText.includes('问诊结论：')`, 20000, '问诊结论页');
  await settle(win);

  const interviewResult = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    const levels = ['未验证', '了解概念', '跟做过', '实际用过', '有产出', '可讲清取舍'];
    const level = levels.find((l) => text.includes(l)) || null;
    // 等级徽章与正文里的「掌握程度：X」必须一致，不能出现「徽章写有产出、正文说可讲清取舍」
    const claim = (text.match(/的掌握程度：([^\\n。]+)/) || [])[1] || null;
    return {
      level,
      claim,
      consistent: !claim || !level || claim.includes(level),
      producedEvidence: text.includes('本次问诊补充的证据'),
      cappedToMedium: text.includes('封顶'),
      hasSignals: text.includes('场景具体度') && text.includes('使用深度'),
      hasNextStep: text.includes('下一步'),
      hasUncertainties: text.includes('待学习') || text.includes('还不确定'),
    };
  })()`);
  results.interviewResult = interviewResult;
  results.shotInterviewResult = await shoot(win, '09-能力问诊-结论');

  // 5) 档案页应能看到问诊结论与证据来源标记
  await clickByText(win, '我的能力档案');
  await waitFor(win, `document.body.innerText.includes('问诊结论')`, 10000, '档案页-问诊结论入口');
  await clickByText(win, '问诊结论');
  await waitFor(win, `document.body.innerText.includes('问诊结论属于你本人')`, 10000, '问诊结论列表');
  await settle(win);
  results.shotProfileAssess = await shoot(win, '10-档案-问诊结论');
  results.profileAssess = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    return {
      listHasSkill: text.includes('问诊结论：') || /置信度/.test(text),
      hasSignals: /场景 \\d\\/3/.test(text),
    };
  })()`);

  // -------------------------------------------------------------------------
  // 6) v0.2：薄弱项训练
  // -------------------------------------------------------------------------
  await clickByText(win, '薄弱项训练');
  await waitFor(win, `document.body.innerText.includes('生成训练计划')`, 15000, '训练页');
  await settle(win);
  results.shotTrainingStart = await shoot(win, '11-薄弱项训练-起始');

  await clickByText(win, '生成训练计划');
  await waitFor(win, `document.body.innerText.includes('训练题（')`, 30000, '训练题列表');
  await settle(win);

  const plan = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    const m = text.match(/训练题（(\\d+)）/);
    return {
      itemCount: m ? Number(m[1]) : null,
      hasReferencePoints: text.includes('自查要点'),
      // v0.3：参考答案必须存在，且必须标清是「示例 · 不是标准答案」
      hasReferenceAnswer: text.includes('参考答案（示例 · 不是标准答案）'),
      saysNotStandard: text.includes('不是标准答案') || text.includes('看的是结构'),
      hasFollowUp: text.includes('面试官大概率会接着问'),
      hasSourceBreakdown: text.includes('能力缺口') && text.includes('缺少证据'),
      hasBoundaryNote: text.includes('不判断你的回答对不对'),
    };
  })()`);
  results.trainingPlan = plan;
  results.shotTraining = await shoot(win, '12-薄弱项训练-题目');

  // 作答 + 自评 + 保存，校验进度统计变化
  const answeredItem = await win.webContents.executeJavaScript(`(async () => {
    ${SET_TEXT_HELPER}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const area = document.querySelector('textarea');
    if (!area) return { ok: false, reason: 'no textarea' };
    __setValue(area, '我先说场景：这是在知识库项目里做的事；做法上按标题层级切分并加了重排；结果是准确率从 61% 提升到 84%。');
    await sleep(200);
    const score = Array.from(document.querySelectorAll('button')).find((b) => /^2 · 能说清做法/.test((b.textContent || '').trim()));
    if (score) score.click();
    await sleep(200);
    const save = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '保存');
    if (!save) return { ok: false, reason: 'no save button' };
    save.click();
    await sleep(500);
    return { ok: true };
  })()`);
  results.trainingAnswered = answeredItem;

  await waitFor(win, `document.body.innerText.includes('已作答')`, 10000, '训练题状态更新');
  await settle(win);
  results.shotTrainingAnswered = await shoot(win, '13-薄弱项训练-已作答');
  results.trainingStats = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    const m = text.match(/自评均分\\s*([\\d.]+)/);
    return { averageScore: m ? Number(m[1]) : null, hasAnsweredBadge: text.includes('已作答') };
  })()`);

  // 7) 训练题应从匹配结果里来：回到报告页确认有对应结论
  await clickByText(win, '简历匹配');
  await waitFor(win, `document.body.innerText.includes('这份报告接下来能直接做什么')`, 10000, '报告页的下一步入口');
  await settle(win);
  results.shotReportNext = await shoot(win, '14-匹配报告-下一步入口');

  // -------------------------------------------------------------------------
  // 7b) v0.3 回归：软技能问诊不得出现「自评」题
  // -------------------------------------------------------------------------
  // 用户反馈里最具体的一条（「对沟通表达问掌握程度不合适」）。
  // 单测只覆盖 core，验不到「界面真的没渲染那一题」，所以必须在真实浏览器里走一遍。
  //
  // 放在训练页全部做完之后：插在流程中间会打断「作答 → 状态更新」的等待，
  // 那时候页面已经切走，找不到 textarea。
  await clickByText(win, '能力问诊');
  // 前面的流程已经生成过一次问诊结论，assessResult 留在 store 里，
  // 所以切回来看到的是**结论页**而不是起始页 —— 必须先退出结论页。
  await waitFor(
    win,
    `document.body.innerText.includes('建议先问这些') || document.body.innerText.includes('问诊结论：')`,
    10000,
    '问诊页（结论页或起始页）',
  );
  const backToStart = await win.webContents.executeJavaScript(`(() => {
    const n = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('再问一个技能'));
    if (!n) return false;
    n.click();
    return true;
  })()`);
  if (backToStart) await waitFor(win, `document.body.innerText.includes('建议先问这些')`, 10000, '回到问诊起始页');

  const softSkill = await win.webContents.executeJavaScript(`(async () => {
    ${SET_TEXT_HELPER}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const click = (needle, exact) => {
      const n = [...document.querySelectorAll('button')].find((b) =>
        exact ? (b.textContent || '').trim() === needle : (b.textContent || '').includes(needle));
      if (!n) return false;
      n.click();
      return true;
    };
    if (!click('自选技能问诊')) return { error: '打不开自选技能弹窗' };
    await sleep(800);
    const input = document.querySelector('input[placeholder]');
    if (!input) return { error: '弹窗里没有技能名输入框' };
    __setValue(input, '沟通表达');
    await sleep(400);
    if (!click('开始', true)) return { error: '找不到开始按钮' };
    await sleep(2500);

    const LAYERS = ['自评', '具体场景', '使用深度', '产出结果', '认知边界'];
    const text = document.body.innerText;
    // 题卡 = 同时含层标签与「下一题」的**最内层**容器。
    // 用 find（取第一个匹配）会命中外层大容器，把页面上方的说明文案
    // 也算进来 —— 那段说明为了告诉用户「这类能力不问了解/熟悉」，
    // 本身就含「了解还是熟悉」，会导致 cardMentionsLadder 永远误报。
    const candidates = [...document.querySelectorAll('div')].filter(
      (d) =>
        [...d.querySelectorAll('span')].some((s) => LAYERS.includes((s.textContent || '').trim())) &&
        [...d.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '下一题'));
    const card = candidates.sort(
      (a, b) => a.querySelectorAll('span').length - b.querySelectorAll('span').length,
    )[0];
    const badge = card
      ? [...card.querySelectorAll('span')].map((s) => (s.textContent || '').trim()).find((t) => LAYERS.includes(t))
      : null;
    const cardText = card ? card.innerText : '';
    return {
      title: document.querySelector('h1') ? document.querySelector('h1').innerText : '',
      badge,
      cardSpanCount: card ? card.querySelectorAll('span').length : -1,
      hasBehavioralTag: text.includes('行为能力'),
      asksConcreteEvent: /最近三个月|最近一次|哪件事/.test(cardText),
      cardMentionsLadder: /属于了解还是熟悉|了解、熟悉|熟练/.test(cardText),
      hasTwoSkipButtons: text.includes('这项我没做过') && text.includes('想不起来'),
    };
  })()`);
  results.softSkillInterview = softSkill;
  await settle(win);
  results.shotSoftSkill = await shoot(win, '18-能力问诊-软技能无自评');
  await clickByText(win, '放弃这次问诊');
  await waitFor(win, `document.body.innerText.includes('建议先问这些')`, 10000, '再次回到起始页');

  // -------------------------------------------------------------------------
  // 7c) v0.4：问诊零打字 + 导航分组 + 面试问答页
  // -------------------------------------------------------------------------
  // 三件事都在真实浏览器里验，单测验不到渲染层：
  //   1. 每道题有可点选选项 → 能不打字完成整场问诊；
  //   2. 侧边栏按求职阶段分组；
  //   3. 面试问答页存在且免责声明在第一屏。
  results.quickChoiceFlow = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const click = (needle, exact) => {
      const n = [...document.querySelectorAll('button')].find((b) =>
        exact ? (b.textContent || '').trim() === needle : (b.textContent || '').includes(needle));
      if (!n) return false;
      n.click();
      return true;
    };
    if (!click('自选技能问诊')) return { error: '打不开自选技能弹窗' };
    await sleep(800);
    const input = document.querySelector('input[placeholder]');
    if (!input) return { error: '没有技能名输入框' };
    // 只输入一次技能名，之后全程点选项
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Redis');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    if (!click('开始', true)) return { error: '找不到开始按钮' };
    await sleep(2500);

    const textQuestions = [];
    let typed = 0;
    for (let i = 0; i < 10; i += 1) {
      if ([...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('生成问诊结论'))) break;
      // 选项按钮的特征：文字不是「下一题/跳过/换题」，且不是导航
      const choices = [...document.querySelectorAll('button')].filter((b) => {
        const t = (b.textContent || '').trim();
        if (!t || t === '下一题' || t.includes('跳过') || t.includes('我没做过') || t.includes('想不起来')) return false;
        if (/工作台|能力档案|岗位分析|简历匹配|能力问诊|薄弱项训练|面试问答|面试复盘|设置|换一套问题|放弃这次问诊/.test(t)) return false;
        if (t === '开始' || t === '关闭' || t === '保存' || t === '取消' || t === '删除' || t === '编辑') return false;
        return true;
      });
      const next = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '下一题');
      if (!next) break;
      textQuestions.push(choices.length);
      if (choices.length > 0) {
        // 只点最后一个非兜底项（兜底项会跳输入框，那就要打字了）
        const real = choices.filter((c) => !/自己写/.test(c.textContent || ''));
        if (real.length > 0) real[real.length - 1].click();
        else break;
      } else {
        // 没有选项就必须打字 —— 这类题记下来
        typed += 1;
        const area = document.querySelector('textarea');
        if (!area) break;
        const taSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        taSetter.call(area, '在支付网关项目里负责对接第三方渠道，协调了两次接口联调。');
        area.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(200);
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '下一题');
      if (!btn || btn.disabled) break;
      btn.click();
      await sleep(320);
    }
    const finished = [...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('生成问诊结论'));
    return {
      questionsWithChoices: textQuestions,
      totalQuestions: textQuestions.length,
      neededTyping: typed,
      finished,
    };
  })()`);
  await settle(win);
  results.shotQuickChoice = await shoot(win, '19-能力问诊-零打字选项');

  if (results.quickChoiceFlow.finished) {
    await clickByText(win, '生成问诊结论');
    await waitFor(win, `document.body.innerText.includes('问诊结论：')`, 20000, '问诊结论页');
    await clickByText(win, '再问一个技能');
    await waitFor(win, `document.body.innerText.includes('建议先问这些')`, 10000, '回到起始页');
  }

  // 导航分组：侧边栏必须出现四个阶段标题
  /* ---------------------------------------------------------------------------
   * v0.3 实装的三项：最低画像 / 简历建议 / 报告导出（2026-10-08）
   * ---------------------------------------------------------------------------
   * 这三项接在匹配报告页的下半部分，冒烟原先只截了页面上半部，
   * 所以「写错了但没崩」这种失败不会被发现 —— 必须显式断言文字存在。
   */
  await clickByText(win, '简历匹配');
  await waitFor(win, `document.body.innerText.includes('匹配明细')`, 15000, '匹配页（v0.3 功能区）');
  results.v03Features = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    return {
      hasExportButton: Array.from(document.querySelectorAll('button'))
        .some((b) => (b.textContent || '').includes('导出 HTML')),
      hasMinimumTitle: text.includes('最低还差什么'),
      hasResumeAdviceTitle: text.includes('简历可以怎么改'),
      // 简历建议必须给「原来写的」与「建议改成」两行，
      // 只给建议不给原句的话，用户无法核对系统有没有看懂他的原意
      hasFromQuote: text.includes('你原来写的'),
      // 免责必须在页面上，不能只写在数据里
      hasDisclaimer: text.includes('不会替你编造任何经历'),
      // 「还没做的能力」应只剩 OCR 一项
      pendingCount: Array.from(document.querySelectorAll('*'))
        .filter((el) => (el.textContent || '').trim() === '岗位截图 OCR').length,
    };
  })()`);

  results.navGroups = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    return {
      hasOverview: text.includes('总览'),
      hasPrepare: text.includes('准备'),
      hasAssess: text.includes('评估'),
      hasImprove: text.includes('提升'),
      hasSystem: text.includes('系统'),
      hasPrepPage: text.includes('面试问答'),
      hasStageCaption: /你有什么|差距在哪|怎么补上|引擎/.test(text),
    };
  })()`);

  // 面试问答页：免责声明必须在第一屏，且不能有「可以这样回答」这类话术
  await clickByText(win, '面试问答');
  await waitFor(win, `document.body.innerText.includes('面试问答推荐')`, 10000, '面试问答页');
  await settle(win);

  const prepResult = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ta = document.querySelector('textarea');
    if (!ta) return { error: '没有输入框' };
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '1. 介绍一下你自己\\n2. 为什么想加入我们\\n3. 讲一个你解决过的最难的技术问题\\n4. 期望薪资是多少？');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('生成回答结构建议'));
    if (!btn) return { error: '找不到生成按钮' };
    btn.click();
    await sleep(2000);
    const text = document.body.innerText;
    return {
      disclaimerFirstScreen: text.includes('这里给的是回答结构，不是标准答案'),
      saysNoAnswers: text.includes('不会替你生成可以直接照说的答案'),
      saysNoPrediction: text.includes('不预测面试结果'),
      itemCount: (text.match(/这个回答必须覆盖/g) || []).length,
      hasPitfall: text.includes('最容易踩的坑'),
      hasFollowUp: text.includes('对方大概率接着问'),
      noScriptedAnswer: !/你可以这样回答|参考话术|示例答案|照着说/.test(text),
      kinds: ['经历类', '技术类', '动机类', '现状类'].filter((k) => text.includes(k)),
    };
  })()`);
  results.interviewPrep = prepResult;
  await settle(win);
  results.shotPrep = await shoot(win, '20-面试问答-结构建议');
  results.shotPrepDisclaimer = await shoot(win, '21-面试问答-免责声明');

  // -------------------------------------------------------------------------
  // 8) v0.2 追加：面试复盘
  //
  // 录音需要真实音频设备，冒烟环境没有；这里走「粘贴转写文本」这条路 ——
  // 它不依赖硬件，但把「转写 → 去标识化 → 证据 → 18 维 → 报告」整条链路跑通。
  // -------------------------------------------------------------------------
  await clickByText(win, '面试复盘');
  await waitFor(win, `document.body.innerText.includes('面试复盘')`, 15000, '面试复盘页');
  await settle(win);
  results.shotDebriefStart = await shoot(win, '15-面试复盘-入口');

  await clickByText(win, '没有录音？直接粘贴转写文本');
  await waitFor(win, `document.body.innerText.includes('导入并准备复盘')`, 10000, '粘贴转写区');
  await clickByText(win, '填入示例文本');
  await delay(300);
  await clickByText(win, '导入并准备复盘');
  await waitFor(win, `document.body.innerText.includes('生成复盘报告')`, 15000, '会话详情');
  await settle(win);
  results.shotDebriefSession = await shoot(win, '16-面试复盘-记录');

  await clickByText(win, '生成复盘报告');
  await waitFor(win, `document.body.innerText.includes('先结论')`, 40000, '复盘报告');
  await settle(win);

  results.debrief = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    return {
      hasTier: ['可以考虑', '需要谨慎', '明显不匹配', '当前信息不足以归类'].some((t) => text.includes(t)),
      hasNextAction: text.includes('下一步（只有这一件）'),
      hasPerformance: text.includes('面试表现'),
      hasFit: text.includes('岗位适配度'),
      hasOpportunity: text.includes('机会侧：这个岗位实际是什么样'),
      hasPerformanceDims: text.includes('表现侧：我这次答得怎么样'),
      hasDecision: text.includes('三档决策表'),
      hasQuestions: text.includes('还需要问清的问题'),
      hasEvidenceIndex: text.includes('附录：证据索引'),
      hasAnonymizeNote: text.includes('去标识化'),
      // 18 个维度小节都应出现在 DOM 里（D1–D12 / P1–P6）
      dimensionBadges: (text.match(/\\b(D(?:[1-9]|1[0-2])|P[1-6])\\b/g) || []).length,
      radarCharts: document.querySelectorAll('svg[role="img"]').length,
      // 报告里不应该出现被脱敏掉的原始公司名
      leakedCompanyName: text.includes('云枢科技'),
    };
  })()`);
  results.shotDebriefReport = await shoot(win, '17-面试复盘-报告');

  // 报告末尾的「刻意不做的事」必须真的在页面上 —— 它是产品边界的一部分
  results.debriefBoundaries = await win.webContents.executeJavaScript(`(() => {
    const text = document.body.innerText;
    return {
      noRealtimeHint: text.includes('不做实时提示'),
      noResultPrediction: text.includes('不预测面试结果'),
      noSpeakerDiarization: text.includes('不做说话人分离'),
    };
  })()`);

  results.consoleErrors = consoleErrors;
  results.rendererErrors = consoleErrors.filter((m) => /Warning|Error|Uncaught|Unhandled/i.test(m)).slice(0, 10);
  // 截图被跳过的清单：必须如实报出，不能因为「断言全过」就当截图也拍到了
  results.shotsSkipped = shotsSkipped.slice();

  /* -------------------------------------------------------------------------
   * v0.3 的硬性断言。
   *
   * 加这一段的原因：前面那些步骤只是「截图留档」，即使行为错了也不会让冒烟失败。
   * 而这次改的全是**判断规则**（软技能不出自评、跳过的两种语义、用量计费）——
   * 规则错了必须让冒烟红，不能只靠截图肉眼发现。
   * ---------------------------------------------------------------------- */
  const v03Failures = [];
  // v0.3 三项：断言语义存在（写错但没崩是最常见的失败形态）
  const v3 = results.v03Features || {};
  if (v3.hasExportButton !== true) v03Failures.push('匹配报告页缺少「导出 HTML」按钮');
  if (v3.hasMinimumTitle !== true) v03Failures.push('缺少「最低还差什么」区块');
  if (v3.hasResumeAdviceTitle !== true) v03Failures.push('缺少「简历可以怎么改」区块');
  if (v3.hasFromQuote !== true) {
    v03Failures.push('简历建议没有展示「你原来写的」—— 用户无法核对系统是否看懂了他的原意');
  }
  if (v3.hasDisclaimer !== true) v03Failures.push('简历建议缺少「不会替你编造任何经历」的免责');

  const soft = results.softSkillInterview || {};
  if (soft.badge === '自评') v03Failures.push('软技能问诊出现了「自评」题（应当不出）');
  if (soft.badge !== '具体场景') v03Failures.push(`软技能第一题应是「具体场景」，实际是「${soft.badge}」`);
  if (soft.hasBehavioralTag !== true) v03Failures.push('软技能问诊页没有标出「行为能力」形状');
  if (soft.asksConcreteEvent !== true) v03Failures.push('软技能题目没有落在具体事件上');
  if (soft.cardMentionsLadder === true) v03Failures.push('软技能题卡里出现了「了解/熟悉/熟练」这类熟练度问法');
  if (soft.hasTwoSkipButtons !== true) v03Failures.push('缺少「没做过」与「想不起来」两个独立的跳过按钮');
  if (soft.error) v03Failures.push(`软技能问诊未跑通：${soft.error}`);
  if (plan.hasReferenceAnswer !== true) v03Failures.push('训练题没有参考答案折叠区');
  if (plan.saysNotStandard !== true) v03Failures.push('参考答案没有标清「不是标准答案」');

  /* --- v0.4：导航分级 / 问诊零打字 / 面试问答 --- */
  const nav = results.navGroups || {};
  for (const [key, label] of [
    ['hasOverview', '总览'],
    ['hasPrepare', '准备'],
    ['hasAssess', '评估'],
    ['hasImprove', '提升'],
    ['hasSystem', '系统'],
  ]) {
    if (nav[key] !== true) v03Failures.push(`导航缺少阶段分组「${label}」`);
  }
  if (nav.hasStageCaption !== true) v03Failures.push('导航阶段缺少说明文字（用户看不出每个阶段在做什么）');
  if (nav.hasPrepPage !== true) v03Failures.push('导航里没有「面试问答」入口');

  const qc = results.quickChoiceFlow || {};
  if (qc.error) v03Failures.push(`问诊选项化流程未跑通：${qc.error}`);
  if (!(qc.totalQuestions >= 3)) v03Failures.push('问诊题目数量异常');
  // 核心目标：绝大多数题应当能零打字完成。
  // 阈值取「至少 3/4 的题有选项」而不是 100% —— 自评题本来就是选择题，
  // 而万一某道题没配选项，也不该让整条链路判死。
  const withChoices = (qc.questionsWithChoices || []).filter((n) => n > 0).length;
  if (qc.totalQuestions > 0 && withChoices / qc.totalQuestions < 0.75) {
    v03Failures.push(
      `问诊只有 ${withChoices}/${qc.totalQuestions} 题能点选完成（要求 ≥75%）—— 降负担的目标没达到`,
    );
  }
  if (qc.finished !== true) v03Failures.push('点选式问诊没能走完全部题目');

  const prep = results.interviewPrep || {};
  if (prep.error) v03Failures.push(`面试问答页未跑通：${prep.error}`);
  if (prep.disclaimerFirstScreen !== true) v03Failures.push('面试问答页第一屏没有免责声明');
  if (prep.saysNoAnswers !== true) v03Failures.push('免责声明没有写明「不会替你生成答案」');
  if (prep.saysNoPrediction !== true) v03Failures.push('免责声明没有写明「不预测面试结果」');
  // 这条最关键：一旦页面出现「你可以这样回答」，产品就变成了面试答案生成器，
  // 用户会去背它，而背下来的答案在追问下必然崩掉。
  if (prep.noScriptedAnswer !== true) v03Failures.push('面试问答页出现了「可以这样回答/参考话术」这类可直接照抄的内容');
  if (!(prep.itemCount >= 4)) v03Failures.push('面试问题没有全部处理（少于 4 条）');
  if (prep.hasPitfall !== true) v03Failures.push('面试问答缺少「最容易踩的坑」');
  if (prep.hasFollowUp !== true) v03Failures.push('面试问答缺少「对方大概率接着问」');
  if (!(prep.kinds || []).includes('动机类')) v03Failures.push('「为什么想加入我们」没有被归为动机类');
  results.v03Failures = v03Failures;
  if (v03Failures.length > 0) {
    throw new Error(`v0.3 断言未通过：\n  - ${v03Failures.join('\n  - ')}`);
  }
}

app.whenReady().then(async () => {
  try {
    await main();
    results.ok = true;
  } catch (err) {
    results.ok = false;
    results.error = String(err && err.message ? err.message : err);
    results.consoleErrors = consoleErrors;
  } finally {
    process.stdout.write(`\n__SMOKE_RESULT__${JSON.stringify(results, null, 2)}__END__\n`);
    setTimeout(() => app.exit(results.ok ? 0 : 1), 200);
  }
});

app.on('window-all-closed', () => app.quit());
