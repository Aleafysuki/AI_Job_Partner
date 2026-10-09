import { useEffect, useRef } from 'react';
import { APP_NAME, AI_PURPOSE_LABEL, PARSE_STEPS } from '@aijob/core';
import { Layout } from './components/Layout';
import { MetroShell } from './components/MetroShell';
import { Button, Banner, Card, Modal, StepList, Toasts, JsonBlock } from './components/ui';
import { useApp } from './state/store';
import { quietPort } from './lib/bridge';
import { useMobileShell } from './lib/platform';
import { Workbench } from './pages/Workbench';
import { ProfilePage } from './pages/Profile';
import { JobPage } from './pages/Job';
import { MatchPage } from './pages/Match';
import { SkillInterviewPage } from './pages/SkillInterview';
import { TrainingPage } from './pages/Training';
import { PrepPage } from './pages/Prep';
import MockInterviewPage from './pages/Mock';
import { DebriefPage } from './pages/Debrief';
import { SettingsPage } from './pages/Settings';

function BootScreen() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold text-white">
          JP
        </div>
        <div className="text-[13px] font-medium text-slate-700">{APP_NAME}</div>
        <div className="mt-1 text-xs text-slate-400">正在读取本地数据…</div>
      </div>
    </div>
  );
}

export default function App() {
  const ready = useApp((s) => s.ready);
  const init = useApp((s) => s.init);
  const route = useApp((s) => s.route);
  const toast = useApp((s) => s.toast);
  const dismissToast = useApp((s) => s.dismissToast);
  const progress = useApp((s) => s.progress);
  const progressVisible = useApp((s) => s.progressVisible);
  const warnings = useApp((s) => s.warnings);
  const clearWarnings = useApp((s) => s.clearWarnings);
  const confirm = useApp((s) => s.confirm);
  const resolveConfirm = useApp((s) => s.resolveConfirm);
  const started = useRef(false);

  /**
   * 外壳选择：同一份页面组件，两种外框。
   *   - 桌面端（Electron）：components/Layout.tsx，左侧双栏工作台；
   *   - Android 端：components/MetroShell.tsx，Metro 大色块头部 + Pivot 分页导航。
   * 两个外壳的 props 完全一致（children + 状态取自同一个 store），
   * 所以页面组件不需要知道自己被哪个外壳包着。
   *
   * 注意这是**宿主身份**判断，不是窗口宽度判断 —— 理由见 lib/platform.ts 顶部注释。
   */
  const Shell = useMobileShell ? MetroShell : Layout;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void init();
  }, [init]);

  /**
   * 静默录制时窗口是隐藏的，用户只能通过托盘菜单要求结束录制。
   * 主进程拿到这个意图后通知页面，由页面停掉 MediaRecorder 并落盘 ——
   * 媒体流是页面里的对象，主进程碰不到。
   */
  useEffect(() => {
    return quietPort.onStopRequested(() => {
      void useApp.getState().stopInterviewCapture();
    });
  }, []);

  if (!ready) return <BootScreen />;

  return (
    <>
      <Shell>
        {warnings.length > 0 ? (
          <div className="mb-4">
            <Banner
              tone="warning"
              title="本次分析有提示"
              action={
                <button onClick={clearWarnings} className="text-[11px] text-amber-700 underline-offset-2 hover:underline">
                  知道了
                </button>
              }
            >
              <ul className="space-y-0.5">
                {warnings.map((w, i) => (
                  <li key={`${i}-${w.slice(0, 12)}`}>· {w}</li>
                ))}
              </ul>
            </Banner>
          </div>
        ) : null}

        {route === 'workbench' ? <Workbench /> : null}
        {route === 'profile' ? <ProfilePage /> : null}
        {route === 'job' ? <JobPage /> : null}
        {route === 'match' ? <MatchPage /> : null}
        {route === 'interview' ? <SkillInterviewPage /> : null}
        {route === 'training' ? <TrainingPage /> : null}
        {route === 'prep' ? <PrepPage /> : null}
        {route === 'mock' ? <MockInterviewPage /> : null}
        {route === 'debrief' ? <DebriefPage /> : null}
        {route === 'settings' ? <SettingsPage /> : null}
      </Shell>

      {/* 解析进度（文档第十四节的第一次使用流程） */}
      <Modal
        open={progressVisible}
        title="正在分析你的简历"
        subtitle="按步骤抽取结构，全程本地完成；只有脱敏后的文本会在开启模型时被发送。"
        onClose={() => undefined}
        width="max-w-lg"
      >
        <StepList steps={PARSE_STEPS} progress={progress} />
      </Modal>

      {/* 发送前确认（设置里可开启），让用户确认没有任何原始 PII 被送出去 */}
      <Modal
        open={Boolean(confirm)}
        title="即将把以下内容发送给模型"
        subtitle={confirm ? `${AI_PURPOSE_LABEL[confirm.purpose]} · 共 ${confirm.messages.reduce((n, m) => n + m.content.length, 0)} 字` : ''}
        onClose={() => resolveConfirm(false)}
        width="max-w-3xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => resolveConfirm(false)}>
              取消，改用本地规则引擎
            </Button>
            <Button variant="primary" onClick={() => resolveConfirm(true)}>
              确认发送
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Banner tone="info">
            下面是脱敏后的完整内容。请确认里面没有你不希望外发的信息；如果发现遗漏，请取消并在设置里关闭远程调用。
          </Banner>
          {confirm?.messages.map((m, i) => (
            <Card key={`${m.role}-${i}`} className="overflow-hidden">
              <div className="border-b border-slate-100 px-3 py-1.5 text-[11px] font-medium text-slate-500">
                {m.role === 'system' ? '系统提示词' : '用户内容'}
              </div>
              <div className="px-3 py-2">
                <JsonBlock value={m.content} maxHeight={220} />
              </div>
            </Card>
          ))}
        </div>
      </Modal>

      <Toasts toast={toast} onDismiss={dismissToast} />
    </>
  );
}
