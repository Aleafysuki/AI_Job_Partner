import { useState } from 'react';
import { Banner, Button, Card, Field, Modal, TextArea } from './ui';
import { useApp } from '../state/store';

/**
 * 首次使用流程（文档第十四节）。
 *
 * 刻意允许「没有规范简历」的用户直接粘一段经历进来 —— 文档第三节把这类人
 * 明确列为主要目标用户，所以这里不是兜底方案，而是并列入口。
 */
export function OnboardingPanel({ compact = false }: { compact?: boolean }) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [text, setText] = useState('');
  const [label, setLabel] = useState('我的档案');
  const importResumeFromFile = useApp((s) => s.importResumeFromFile);
  const importResumeFromText = useApp((s) => s.importResumeFromText);
  const loadSample = useApp((s) => s.loadSample);
  const busy = useApp((s) => s.busy);

  return (
    <>
      <Card className={compact ? '' : 'overflow-hidden'}>
        <div className={compact ? 'px-5 py-4' : 'px-6 py-6'}>
          {!compact ? (
            <>
              <h1 className="text-[19px] font-semibold text-slate-800">先告诉我一些关于你的事情</h1>
              <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">
                不需要一份规范的简历。可以上传文件，也可以直接把你做过的事写一段话给我。
                <br />
                我会把它整理成结构化档案 —— 并且标注哪些能力有证据、哪些只是自我声明。
              </p>
            </>
          ) : (
            <div className="text-[13px] font-medium text-slate-700">还没有能力档案</div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" loading={busy === 'pick'} onClick={() => void importResumeFromFile()}>
              上传简历（TXT / PDF / DOCX）
            </Button>
            <Button variant="secondary" onClick={() => setPasteOpen(true)}>
              直接输入我的经历
            </Button>
            <Button variant="ghost" loading={busy === 'resume'} onClick={() => void loadSample()}>
              载入示例数据，先看效果
            </Button>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-[11px] leading-relaxed text-slate-500">
              <span className="font-medium text-slate-600">先脱敏，再分析。</span>
              姓名、电话、邮箱、地址、身份证、社交账号会在进入分析链路之前替换为占位符，你随时可以查看被替换了哪些内容。
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5 text-[11px] leading-relaxed text-slate-500">
              <span className="font-medium text-slate-600">没有 API Key 也能用。</span>
              默认走内置本地规则引擎，全程离线；需要更强的语义理解时再配置模型接口。
            </div>
          </div>
        </div>
      </Card>

      <Modal
        open={pasteOpen}
        title="直接输入你的经历"
        subtitle="像跟人聊天一样写就行，例如：我以前做过一个网站，主要负责 SEO，也写过爬虫……"
        onClose={() => setPasteOpen(false)}
        width="max-w-3xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPasteOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!text.trim()}
              onClick={() => {
                setPasteOpen(false);
                void importResumeFromText(text, label, '手动输入');
              }}
            >
              开始整理
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="档案名称（仅本地使用，不写入简历）">
            <TextArea rows={1} value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="你的经历" hint="分点写效果最好：做过什么 / 用什么做的 / 结果如何。有数字就写上数字。">
            <TextArea
              rows={14}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'例如：\n- 2024 年用 Python 写过一个比价脚本，每天抓 500 条商品数据，跑了 3 个月\n- 负责一个小网站的 SEO，做关键词和站内优化，半年自然流量涨了 60%\n- 用过 Dify 搭过一个内部知识库问答'}
            />
          </Field>
          <Banner tone="info">
            系统会把这些内容拆成「项目 / 经历 / 技能 / 证据」，并按证据强度打标。只有自我声明、没有产出的能力会被单独列成「待证明」，不会当成已具备。
          </Banner>
        </div>
      </Modal>
    </>
  );
}
