"use client";

import { useEffect, useState } from 'react';
import { RefreshCw } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import type { DesktopAPI, UpdateState, UpdateDraft } from '@/lib/desktop-api';

export default function HandworkUpdate({ api, busy, compact = false, prepareRestart }: {
  api?: DesktopAPI; busy: boolean; compact?: boolean; prepareRestart: () => Promise<UpdateDraft[]>;
}) {
  const [state, setState] = useState<UpdateState>({ status: 'idle', message: 'Check for updates.' });
  const [failure, setFailure] = useState('');
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    let receivedEvent = false;
    void api.getUpdateState().then(value => { if (mounted && !receivedEvent) setState(value); }).catch(() => { if (mounted) setState({ status: 'unavailable', message: 'Install a release build to enable updates.' }); });
    const unsubscribe = api.onEvent(event => { if (event.method === 'desktop/update' && mounted) { receivedEvent = true; setState(event.params as unknown as UpdateState); setFailure(''); } });
    return () => { mounted = false; unsubscribe(); };
  }, [api]);
  if (!api || !state.version || ['idle', 'checking', 'unavailable'].includes(state.status)) return null;
  const label = {
    idle: 'Check for updates', checking: 'Checking…', available: 'Download update',
    downloading: `Downloading ${state.progress ?? 0}%`, downloaded: 'Restart to update',
    installing: 'Restarting…', error: 'Retry update', unavailable: 'Updates unavailable',
  }[state.status];
  const blocked = ['checking', 'downloading', 'installing', 'unavailable'].includes(state.status) || (state.status === 'downloaded' && busy);
  const message = failure || (state.status === 'downloaded' && busy ? 'Finish or stop the current response before restarting.' : state.message);
  async function activate() {
    if (!api || blocked) return;
    setFailure('');
    try {
      if (state.status === 'downloaded') await api.installUpdate(await prepareRestart());
      else if (state.status === 'available' || (state.status === 'error' && state.version)) await api.downloadUpdate();
      else await api.checkUpdates();
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
  }
  return <div className="handwork-update">
    <Button variant={state.status === 'downloaded' || state.status === 'available' ? 'secondary' : 'ghost'} size={compact ? 'icon-sm' : 'sm'} className={compact ? undefined : 'handwork-update-button'} disabled={blocked} aria-label={label} title={message} onClick={() => void activate()}>
      <RefreshCw size={16} aria-hidden />{!compact && <span>{label}</span>}
    </Button>
    {!compact && message !== 'Check for updates.' && <span role="status" className="handwork-update-status">{message}</span>}
  </div>;
}
