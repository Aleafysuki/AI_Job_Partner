import React, { useEffect, useState } from 'react';
import {
  ASSESSMENT_LABEL,
  EVIDENCE_KIND_LABEL,
  IMPORTANCE_LABEL,
  STRENGTH_LABEL,
  type Assessment,
  type EvidenceKind,
  type EvidenceStrength,
  type TriLevel,
} from '@aijob/core';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// 基础控件
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';

const BUTTON_STYLE: Record<ButtonVariant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 active:bg-indigo-800 border border-transparent shadow-sm',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 active:bg-slate-100 shadow-sm',
  ghost: 'bg-transparent text-slate-600 border border-transparent hover:bg-slate-100',
  danger: 'bg-white text-rose-600 border border-rose-200 hover:bg-rose-50',
  subtle: 'bg-indigo-50 text-indigo-700 border border-indigo-100 hover:bg-indigo-100',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}) {
  const sizeCls = size === 'sm' ? 'px-2.5 py-1 text-xs' : size === 'lg' ? 'px-5 py-2.5 text-sm' : 'px-3.5 py-1.5 text-[13px]';
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        sizeCls,
        BUTTON_STYLE[variant],
        className,
      )}
    >
      {loading && (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]', className)}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3.5', className)}>
      <div className="min-w-0">
        <div className="text-[14px] font-semibold text-slate-800">{title}</div>
        {subtitle ? <div className="mt-0.5 text-xs leading-relaxed text-slate-500">{subtitle}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SectionTitle({
  title,
  description,
  right,
}: {
  title: string;
  description?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-slate-800">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
      </div>
      {right}
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'muted';

const TONE_STYLE: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 border-slate-200',
  accent: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  danger: 'bg-rose-50 text-rose-700 border-rose-200',
  info: 'bg-sky-50 text-sky-700 border-sky-200',
  muted: 'bg-slate-50 text-slate-500 border-slate-200',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap',
        TONE_STYLE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const ASSESSMENT_TONE: Record<Assessment, Tone> = {
  matched: 'success',
  partial: 'warning',
  lacking_evidence: 'info',
  gap: 'danger',
  unknown: 'muted',
};

export function AssessmentBadge({ assessment, className }: { assessment: Assessment; className?: string }) {
  return (
    <Badge tone={ASSESSMENT_TONE[assessment]} className={className}>
      {ASSESSMENT_LABEL[assessment]}
    </Badge>
  );
}

const STRENGTH_TONE: Record<EvidenceStrength, Tone> = {
  strong: 'success',
  medium: 'accent',
  weak: 'warning',
  none: 'muted',
};

export function StrengthBadge({ strength }: { strength: EvidenceStrength }) {
  return <Badge tone={STRENGTH_TONE[strength]}>证据强度 · {STRENGTH_LABEL[strength]}</Badge>;
}

export function ImportanceBadge({ importance }: { importance: TriLevel }) {
  const tone: Tone = importance === 'high' ? 'danger' : importance === 'medium' ? 'warning' : 'muted';
  return <Badge tone={tone}>重要度 · {IMPORTANCE_LABEL[importance]}</Badge>;
}

export function KindBadge({ kind }: { kind: EvidenceKind }) {
  const tone: Tone = kind === 'self_claim' ? 'warning' : kind === 'project' || kind === 'work' ? 'success' : 'neutral';
  return <Badge tone={tone}>{EVIDENCE_KIND_LABEL[kind]}</Badge>;
}

export function Chip({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <span
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] leading-4 text-slate-600',
        onClick && 'cursor-pointer hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700',
      )}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">{hint}</span> : null}
    </label>
  );
}

const INPUT_CLS =
  'w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[13px] text-slate-800 outline-none transition ' +
  'placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-slate-400';

export function TextInput({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn(INPUT_CLS, className)} />;
}

/**
 * 多行输入。
 *
 * 项目用的是 React 18，`ref` 不在 `TextareaHTMLAttributes` 里，
 * 所以这里显式声明一次 —— 问诊页需要「点『都不像』后自动聚焦到输入框」，
 * 没有 ref 就做不到那一步跳转。
 * （用 forwardRef 而非 React 19 的 ref-as-prop，避免动到其它调用方。）
 */
type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: React.Ref<HTMLTextAreaElement>;
};

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { className, ...rest },
  ref,
) {
  return <textarea {...rest} ref={ref} className={cn(INPUT_CLS, 'leading-relaxed', className)} />;
});

export function Select({
  className,
  options,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { options: Array<{ value: string; label: string }> }) {
  return (
    <select {...rest} className={cn(INPUT_CLS, 'cursor-pointer pr-6', className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <div className="text-[13px] font-medium text-slate-700">{label}</div>
        {hint ? <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{hint}</div> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors',
          checked ? 'bg-indigo-600' : 'bg-slate-300',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 容器类
// ---------------------------------------------------------------------------

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  footer,
  children,
  width = 'max-w-2xl',
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/25 p-6 backdrop-blur-[1px]">
      <div className={cn('animate-fade-up mt-10 w-full rounded-xl bg-white shadow-xl', width)}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3.5">
          <div>
            <div className="text-[14px] font-semibold text-slate-800">{title}</div>
            {subtitle ? <div className="mt-0.5 text-xs text-slate-500">{subtitle}</div> : null}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Collapsible({
  title,
  children,
  defaultOpen = false,
  right,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  right?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-600">
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            className={cn('shrink-0 transition-transform', open && 'rotate-90')}
            fill="currentColor"
          >
            <path d="M4 2l5 4-5 4z" />
          </svg>
          {title}
        </span>
        {right}
      </button>
      {open ? <div className="border-t border-slate-200 px-3 py-2.5">{children}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'py-8' : 'py-16')}>
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="10" cy="10" r="7.2" />
          <path d="M10 6.5v4.2M10 13.4v.1" strokeLinecap="round" />
        </svg>
      </div>
      <div className="text-[13px] font-medium text-slate-700">{title}</div>
      {description ? <div className="mt-1 max-w-md text-xs leading-relaxed text-slate-500">{description}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-0.5 text-lg font-semibold leading-tight text-slate-800">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div> : null}
    </div>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={cn('rounded-lg border px-3.5 py-2.5', TONE_STYLE[tone])}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs leading-relaxed">
          {title ? <div className="font-semibold">{title}</div> : null}
          <div className={title ? 'mt-0.5 opacity-90' : ''}>{children}</div>
        </div>
        {action}
      </div>
    </div>
  );
}

export function StepList({
  steps,
  progress,
}: {
  steps: Array<{ id: string; label: string }>;
  progress: Record<string, { status: string; detail?: string }>;
}) {
  return (
    <ul className="space-y-2">
      {steps.map((step) => {
        const state = progress[step.id];
        const status = state?.status ?? 'pending';
        return (
          <li key={step.id} className="flex items-center gap-2.5 text-[13px]">
            <span
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px]',
                status === 'done' && 'border-emerald-500 bg-emerald-500 text-white',
                status === 'running' && 'border-indigo-500 bg-indigo-50',
                status === 'skipped' && 'border-slate-300 bg-slate-100 text-slate-400',
                status === 'pending' && 'border-slate-300 bg-white',
              )}
            >
              {status === 'done' ? (
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M2 5.2l2 2 4-4.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : status === 'running' ? (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
              ) : status === 'skipped' ? (
                '—'
              ) : null}
            </span>
            <span className={cn('flex-1', status === 'pending' ? 'text-slate-400' : 'text-slate-700')}>{step.label}</span>
            {state?.detail ? <span className="text-[11px] text-slate-400">{state.detail}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function Callout({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg border border-indigo-100 bg-indigo-50/60 px-3.5 py-2.5 text-xs leading-relaxed text-indigo-900', className)}>
      {children}
    </div>
  );
}

export function JsonBlock({ value, maxHeight = 320 }: { value: unknown; maxHeight?: number }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className="overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700"
      style={{ maxHeight }}
    >
      {text}
    </pre>
  );
}

export function Toasts({ toast, onDismiss }: { toast: { id: string; kind: 'success' | 'error' | 'info'; text: string } | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(onDismiss, toast.kind === 'error' ? 7000 : 4200);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;
  const tone: Tone = toast.kind === 'success' ? 'success' : toast.kind === 'error' ? 'danger' : 'info';
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] max-w-md">
      <div className={cn('animate-fade-up pointer-events-auto rounded-lg border px-4 py-2.5 shadow-lg', TONE_STYLE[tone])}>
        <div className="flex items-start gap-3">
          <span className="text-xs leading-relaxed">{toast.text}</span>
          <button onClick={onDismiss} className="mt-0.5 shrink-0 opacity-50 transition hover:opacity-100">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export function ComingSoonPanel({
  reason,
  items,
}: {
  reason: string;
  items: Array<{ id: string; label: string; description: string; docRef: string; since: string }>;
}) {
  return (
    <Card className="border-dashed">
      <div className="px-5 py-4">
        <div className="flex items-center gap-2">
          <Badge tone="accent">Coming Soon</Badge>
          <span className="text-[13px] font-medium text-slate-700">当前版本未开放</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{reason}</p>
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
              <Badge tone="muted">{item.since}</Badge>
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-700">{item.label}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{item.description}</div>
                <div className="mt-0.5 text-[10px] text-slate-400">产品文档 · 第 {item.docRef} 节</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
