"use client";
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DesktopAPI, SubscriptionUsage } from '@/lib/desktop-api';
import { usageResetLabel, usageWindowState } from '@/lib/subscription-usage';
import styles from './HandworkSubscriptionUsage.module.css';

export function HandworkSubscriptionUsage({ api, active }: { api?: DesktopAPI; active: boolean }) {
  const titleId = useId();
  const [usage, setUsage] = useState<SubscriptionUsage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [now, setNow] = useState(Date.now);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active || !api) return;
    let current = true;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (!current || pending || document.visibilityState === 'hidden') return;
      pending = true; setLoading(true);
      clearTimeout(timer);
      let delay = 60_000;
      try {
        const result = await api!.providerUsage('codex');
        if (!current) return;
        const at = Date.now();
        setUsage(result); setError(''); setUpdatedAt(at); setNow(at);
        // Check just after a reported reset rather than waiting a full minute.
        const nextReset = Math.min(...result.windows.map(item => item.resetsAt ?? Infinity).filter(atReset => atReset > at));
        delay = Math.min(delay, Math.max(1000, nextReset - at + 250));
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Please try again.');
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
    void load();
    return () => {
      current = false; clearTimeout(timer); clearInterval(clock);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      refresh.current = () => {};
    };
  }, [api, active]);

  return <section className={styles.usage} aria-labelledby={titleId} aria-busy={loading}>
    <div className={styles.header}>
      <span id={titleId} className={styles.title}>Subscription usage{usage?.plan && <span className={styles.plan}>{usage.plan.replaceAll('_', ' ')}</span>}</span>
      <Button size="sm" variant="ghost" className={styles.refresh} disabled={!api || !active || loading} onClick={() => refresh.current()} aria-label="Refresh Codex subscription usage">{loading ? 'Refreshing…' : 'Refresh'}</Button>
    </div>
    {!usage && !error && <p className={styles.message} role="status">{api ? 'Checking your allowance…' : 'Open the desktop app to view your allowance.'}</p>}
    {usage && usage.windows.length === 0 && <p className={styles.message}>OpenAI has not reported usage limits for this account.</p>}
    {usage && <div className={styles.windows} data-stale={!!error || undefined}>{usage.windows.map(item => {
      const state = usageWindowState(item, now);
      const reset = usageResetLabel(item.resetsAt, now);
      const exactReset = item.resetsAt === null ? undefined : new Date(item.resetsAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      return <div key={item.id} className={styles.window}>
        <div className={styles.windowHeader}><span>{item.label}</span><span className={styles.remaining} data-low={state.low || undefined}>{state.remaining === null ? 'Awaiting update' : `${state.remaining}% left`}</span></div>
        <div className={styles.track} role={state.remaining === null ? undefined : 'meter'} aria-hidden={state.remaining === null || undefined} aria-label={state.remaining === null ? undefined : `${item.label} allowance remaining`} aria-valuemin={state.remaining === null ? undefined : 0} aria-valuemax={state.remaining === null ? undefined : 100} aria-valuenow={state.remaining ?? undefined} aria-valuetext={state.remaining === null ? 'Awaiting updated allowance' : `${state.remaining}% remaining`}>
          <span className={styles.fill} data-low={state.low || undefined} style={{ transform: `scaleX(${(state.remaining ?? 0) / 100})` }} />
        </div>
        <div className={styles.reset} title={exactReset}>{state.exhausted && <span className={styles.limit}>Limit reached · </span>}{item.resetsAt === null ? reset : <time dateTime={new Date(item.resetsAt).toISOString()}>{reset}<span className={styles.exact}> · {exactReset}</span></time>}</div>
      </div>;
    })}</div>}
    <div className={styles.footer} aria-live="polite">
      {error ? <p className={styles.message} role="status">Could not update usage. {error}{usage && updatedAt ? ` Showing the last check from ${new Date(updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.` : ''}</p> : <p className={styles.message}>Shared across apps using your Codex subscription. Limits reset automatically.</p>}
    </div>
  </section>;
}
