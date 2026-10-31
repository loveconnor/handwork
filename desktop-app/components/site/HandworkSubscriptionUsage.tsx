"use client";
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from './ProviderLogo';
import { Popover, PopoverTrigger, PopoverPopup } from '@/components/ui/popover';
import type { CodexResetCredit, CodexResetOutcome, CodexResets, DesktopAPI, SubscriptionUsage, SubscriptionUsageWindow } from '@/lib/desktop-api';
import { resetCreditExpiry, usageResetLabel, usageWindowState } from '@/lib/subscription-usage';
import styles from './HandworkSubscriptionUsage.module.css';

type ResetStep = { key: string; phase: 'confirming' | 'using' | 'done' | 'failed'; message?: string; good?: boolean };

const outcomeLabel: Record<CodexResetOutcome, string> = {
  reset: 'Codex usage was reset.',
  nothingToReset: 'There’s no usage to reset yet.',
  noCredit: 'No banked resets are left.',
  alreadyRedeemed: 'That reset was already used.',
};

const cleanError = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback;

export function HandworkSubscriptionUsage({ api, active, compact = false, provider = 'codex' }: { api?: DesktopAPI; active: boolean; compact?: boolean; provider?: 'codex' | 'claude' }) {
  const name = provider === 'claude' ? 'Claude' : 'Codex';
  const titleId = useId();
  const [usage, setUsage] = useState<SubscriptionUsage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [now, setNow] = useState(Date.now);
  const [resets, setResets] = useState<CodexResets | null>();
  const [step, setStep] = useState<ResetStep>();
  const [open, setOpen] = useState(false);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active || !api) { setUsage(undefined); setError(''); setUpdatedAt(undefined); setResets(undefined); return; }
    let current = true;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (!current || pending || document.visibilityState === 'hidden') return;
      pending = true; setLoading(true);
      clearTimeout(timer);
      let delay = 60_000;
      try {
        const result = await api!.providerUsage(provider);
        if (!current) return;
        const at = Date.now();
        setUsage(result); setError(''); setUpdatedAt(result.source === 'sdk-events' ? result.observedAt ?? undefined : at); setNow(at);
        // Check just after a reported reset rather than waiting a full minute.
        const nextReset = Math.min(...result.windows.map(item => item.resetsAt ?? Infinity).filter(atReset => atReset > at));
        delay = Math.min(delay, Math.max(1000, nextReset - at + 250));
      } catch (cause) {
        if (current) setError(cleanError(cause, 'Please try again.'));
      } finally {
        pending = false;
        if (current) { setLoading(false); setNow(Date.now()); timer = setTimeout(() => void load(), delay); }
      }
    }
    refresh.current = () => { void load(); };
    const resume = () => { if (document.visibilityState !== 'hidden') void load(); };
    const clock = setInterval(() => { if (document.visibilityState !== 'hidden') setNow(Date.now()); }, 15_000);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    const unsubscribe = api.onEvent?.(event => { if (provider === 'claude' && event.method === 'desktop/provider-usage') void load(); });
    void load();
    return () => {
      unsubscribe?.();
      current = false; clearTimeout(timer); clearInterval(clock);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      refresh.current = () => {};
    };
  }, [api, active, provider]);

  // Resets come from Codex itself, which starts a process; read them when the
  // details are looked at rather than on the usage timer.
  const loadResets = useCallback(async () => {
    if (provider !== 'codex' || !api?.codexResets) return;
    try { setResets(await api.codexResets()); } catch { setResets(null); }
  }, [api, provider]);
  useEffect(() => { if (active && api && (open || !compact)) void loadResets(); }, [active, api, open, compact, loadResets]);

  async function spendReset(credit: CodexResetCredit | undefined, key: string) {
    if (!api) return;
    setStep({ key, phase: 'using' });
    try {
      const outcome = await api.useCodexReset(credit?.id ?? null);
      setStep({ key, phase: 'done', message: outcomeLabel[outcome], good: outcome === 'reset' });
      refresh.current();
      await loadResets();
    } catch (cause) {
      setStep({ key, phase: 'failed', message: cleanError(cause, 'Could not use the reset. Try again.') });
    }
  }

  const resetRows: (CodexResetCredit | undefined)[] = resets ? [...resets.credits, ...Array.from({ length: Math.max(0, resets.availableCount - resets.credits.length) }, () => undefined)] : [];
  // A row that just finished stays until the list refreshes past it.
  const finished = step?.phase === 'done' || step?.phase === 'failed' ? step : undefined;

  const details = <section className={styles.usage} aria-labelledby={titleId} aria-busy={loading}>
    <div className={styles.header}>
      <span className={styles.mark} aria-hidden><ProviderLogo provider={provider} size={16} /></span>
      <div className={styles.heading}>
        <span id={titleId} className={styles.title}>{name} usage{usage?.plan && <span className={styles.plan}>{usage.plan.replaceAll('_', ' ')}</span>}</span>
        <span className={styles.updated}>{usage?.source === 'sdk-events' && !updatedAt ? 'Waiting for a Claude usage report' : updatedLabel(updatedAt, now, !!api)}</span>
      </div>
      <Button size="icon-sm" variant="ghost" className={styles.refresh} disabled={!api || !active || loading} onClick={() => { refresh.current(); void loadResets(); }} aria-label={`Refresh ${name} subscription usage`} title="Refresh">
        <RefreshCw aria-hidden width={14} height={14} className={loading ? 'motion-safe:animate-spin' : undefined} />
      </Button>
    </div>
    {error && usage && <p className={styles.stale} role="status">Could not refresh usage. Showing the last reading.</p>}
    {!usage && !error && <p className={styles.empty} role="status">{api ? 'Checking your allowance…' : 'Open the desktop app to view your allowance.'}</p>}
    {!usage && error && <p className={styles.empty} role="status">Could not load usage. {error}</p>}
    {usage && usage.windows.length === 0 && <p className={styles.empty}>{provider === 'claude' ? 'Claude has not reported usage limits to Handwork yet. Usage and reset times appear when its SDK reports them during a chat.' : 'OpenAI has not reported usage limits for this account.'}</p>}
    {usage && usage.windows.length > 0 && <div className={styles.windows} data-stale={!!error || undefined}>{usage.windows.map(item => <UsageWindow key={item.id} item={item} now={now} />)}</div>}
    {resetRows.length > 0 && <section className={styles.resets} aria-label="Banked resets">
      <div className={styles.resetsHeader}>
        <span role="heading" aria-level={3} className={styles.resetsTitle}>Banked resets</span><span className={styles.count}>{resets!.availableCount}</span>
        {resets!.email && <span className={styles.account} title={`Resets belong to the Codex sign-in ${resets!.email}`}>{resets!.email}</span>}
      </div>
      <div className={styles.resetList}>{resetRows.map((credit, index) => {
        const key = credit?.id ?? `unlisted-${index}`;
        const mine = step?.key === key ? step : undefined;
        const busy = step?.phase === 'using';
        return <article key={key} className={styles.credit}>
          <div className={styles.creditText}>
            <span role="heading" aria-level={4} className={styles.creditTitle}>{credit?.title || `Reset ${index + 1}`}</span>
            {credit?.description && <p>{credit.description}</p>}
          </div>
          <div className={styles.creditFoot}>
            <span className={styles.expiry} title={credit?.expiresAt ? new Date(credit.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : undefined}>{resetCreditExpiry(credit?.expiresAt ?? null, now)}</span>
            {mine?.phase === 'using' ? <span className={styles.applying} role="status"><LoaderCircle aria-hidden width={12} height={12} className="motion-safe:animate-spin" />Applying…</span>
              : mine?.phase === 'confirming' ? <span className={styles.confirm}>
                <Button size="xs" variant="ghost" onClick={() => setStep(undefined)}>Cancel</Button>
                <Button size="xs" className={styles.spend} onClick={() => void spendReset(credit, key)}>Use now</Button>
              </span>
              : <Button size="xs" variant="outline" className={styles.use} disabled={!api || busy} onClick={() => setStep({ key, phase: 'confirming' })}>Use reset</Button>}
          </div>
          {mine?.phase === 'confirming' && <p className={styles.confirmText}>This restores your full Codex allowance now and can’t be undone.</p>}
        </article>;
      })}</div>
    </section>}
    {finished && <p className={styles.outcome} data-good={finished.good || undefined} data-failed={finished.phase === 'failed' || undefined} role="status">{finished.message}</p>}
    <p className={styles.note}>{provider === 'claude' ? 'Last usage reported by Claude Code, shared across your account. Refresh reads the latest report; it does not send a model request. Claude does not expose banked reset credits here.' : 'Shared across apps using your Codex subscription.'}</p>
  </section>;

  if (!compact) return details;
  if (!active) return null;
  return <Popover open={open} onOpenChange={next => { if (next || step?.phase !== 'using') { setOpen(next); if (!next) setStep(undefined); } }}>
    <PopoverTrigger openOnHover delay={300} closeDelay={150} render={<Button variant="ghost" size="icon-sm" className={styles.summary} aria-label={`${name} subscription usage and reset times`} />}>
      <ProviderLogo provider={provider} size={18} />
    </PopoverTrigger>
    <PopoverPopup side="top" align="start" sideOffset={10} className={styles.popup}>{details}</PopoverPopup>
  </Popover>;
}

function UsageWindow({ item, now }: { item: SubscriptionUsageWindow; now: number }) {
  const state = usageWindowState(item, now);
  const exactReset = item.resetsAt === null ? undefined : shortDate(item.resetsAt, now);
  const label = /limit$/i.test(item.label) ? item.label : `${item.label} limit`;
  return <div className={styles.window}>
    <div className={styles.windowHeader}><span>{label}</span><span className={styles.remaining} data-low={state.low || undefined}>{state.remaining === null ? 'Awaiting update' : `${state.remaining}% left`}</span></div>
    <div className={styles.track} role={state.remaining === null ? undefined : 'meter'} aria-hidden={state.remaining === null || undefined} aria-label={state.remaining === null ? undefined : `${item.label} allowance remaining`} aria-valuemin={state.remaining === null ? undefined : 0} aria-valuemax={state.remaining === null ? undefined : 100} aria-valuenow={state.remaining ?? undefined} aria-valuetext={state.remaining === null ? 'Awaiting updated allowance' : `${state.remaining}% remaining`}>
      <span className={styles.fill} data-low={state.low || undefined} style={{ transform: `scaleX(${(state.remaining ?? 0) / 100})` }} />
    </div>
    <div className={styles.reset}>
      <span>{state.exhausted && <span className={styles.limit}>Limit reached · </span>}{item.resetsAt === null ? usageResetLabel(null, now) : <time dateTime={new Date(item.resetsAt).toISOString()}>{usageResetLabel(item.resetsAt, now)}</time>}</span>
      {exactReset && <span className={styles.exact}>{exactReset}</span>}
    </div>
  </div>;
}

/** "Nov 4, 10:41 AM"; the year only when it is not this one. */
function shortDate(at: number, now: number) {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' });
}

function updatedLabel(at: number | undefined, now: number, desktop: boolean) {
  if (!desktop) return 'Desktop app only';
  if (!at) return 'Checking…';
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  return minutes === 0 ? 'Updated just now' : minutes < 60 ? `Updated ${minutes}m ago` : `Updated ${Math.floor(minutes / 60)}h ago`;
}
