"use client";
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, X } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import type { DesktopAPI, ProviderUpdate } from '@/lib/desktop-api';
import { ProviderLogo } from './ProviderLogo';

type Row = { status: 'idle' } | { status: 'updating' } | { status: 'updated'; version?: string; opened?: boolean } | { status: 'failed'; error: string };

const cleanError = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'The update did not finish.';

/**
 * Offers updates for the software behind connected providers, as the native
 * app did for its agents: checked once per launch, dismissed for this run only.
 */
export function HandworkProviderUpdates({ api, providers, ready }: { api?: DesktopAPI; providers: string[]; ready: boolean }) {
  const [updates, setUpdates] = useState<ProviderUpdate[]>([]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [dismissed, setDismissed] = useState(false);
  const key = providers.join(',');

  useEffect(() => {
    if (!api?.providerUpdates || !ready || !key) return;
    let current = true;
    api.providerUpdates(key.split(',')).then(next => { if (current) setUpdates(next); }, () => { /* Offline or unavailable: nothing to offer. */ });
    return () => { current = false; };
  }, [api, ready, key]);

  if (dismissed || updates.length === 0 || typeof document === 'undefined') return null;
  const stateOf = (provider: string): Row => rows[provider] ?? { status: 'idle' };
  const busy = updates.some(update => stateOf(update.provider).status === 'updating');
  const pending = updates.filter(update => ['idle', 'failed'].includes(stateOf(update.provider).status));
  const anyUpdated = updates.some(update => { const row = stateOf(update.provider); return row.status === 'updated' && !row.opened; });

  const start = (targets: ProviderUpdate[]) => {
    for (const update of targets) {
      setRows(current => ({ ...current, [update.provider]: { status: 'updating' } }));
      api!.updateProvider(update.provider).then(
        result => setRows(current => ({ ...current, [update.provider]: { status: 'updated', ...result } })),
        cause => setRows(current => ({ ...current, [update.provider]: { status: 'failed', error: cleanError(cause) } })),
      );
    }
  };

  return createPortal(<section className="handwork-provider-updates" role="status" aria-label="Provider updates">
    <header>
      <span>{updates.length === 1 ? 'Provider update available' : 'Provider updates available'}</span>
      {pending.length > 1 && <Button size="sm" variant="ghost" className="handwork-provider-updates-all" onClick={() => start(pending)}>Update all</Button>}
      <Button size="icon-sm" variant="ghost" className="handwork-provider-updates-close" aria-label="Dismiss provider updates" title="Dismiss until next launch" disabled={busy} onClick={() => setDismissed(true)}><X aria-hidden width={14} height={14} /></Button>
    </header>
    <div className="handwork-provider-update-rows">{updates.map(update => {
      const row = stateOf(update.provider);
      // One fixed column for every action, so the buttons share a width and edge.
      return <article key={update.provider} className="handwork-provider-update-row" data-state={row.status}>
        <span className="handwork-provider-update-mark" aria-hidden><ProviderLogo provider={update.provider} size={15} /></span>
        <div className="handwork-provider-update-text">
          <span className="handwork-provider-update-name">{update.name}</span>
          {row.status === 'updated'
            ? <span className="handwork-provider-update-meta" data-tone="done">{row.opened ? 'Download page opened' : `Now on ${row.version}`}</span>
            : row.status === 'failed'
              ? <span className="handwork-provider-update-meta" data-tone="error" role="alert" title={row.error}>{row.error}</span>
              : update.installed
                ? <span className="handwork-provider-update-meta"><span>{update.installed}</span><span aria-label="to">→</span><span className="handwork-provider-update-latest">{update.latest}</span></span>
                : <span className="handwork-provider-update-meta" data-tone="warning" title={`This installation stopped running. Reinstall ${update.latest} to fix it.`}>Not running</span>}
        </div>
        {row.status === 'updated'
          ? <span className="handwork-provider-update-action handwork-provider-update-check" aria-hidden><Check width={15} height={15} /></span>
          : <Button size="sm" variant="outline" className="handwork-provider-update-action" disabled={row.status === 'updating'} onClick={() => start([update])}>
            {row.status === 'updating' ? <LoaderCircle aria-label={update.action === 'reinstall' ? 'Reinstalling' : 'Updating'} width={14} height={14} className="motion-safe:animate-spin" />
              : row.status === 'failed' ? 'Retry' : update.action === 'reinstall' ? 'Reinstall' : update.action === 'download' ? 'Download' : 'Update'}
          </Button>}
      </article>;
    })}</div>
    <footer>{anyUpdated ? 'Handwork uses the new versions from your next message.' : 'Updates bring the latest models and fixes.'}</footer>
  </section>, document.body);
}
