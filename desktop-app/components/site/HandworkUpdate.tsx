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
  if (compact) return <div className="handwork-update">
    <Button variant={state.status === 'downloaded' || state.status === 'available' ? 'secondary' : 'ghost'} size="icon-sm" disabled={blocked} aria-label={label} title={message} onClick={() => void activate()}>
      <RefreshCw size={16} aria-hidden />
    </Button>
  </div>;
  // One quiet row, no heavier than New chat: a dot, what is happening, and the one thing to do.
  const failed = state.status === 'error' || !!failure;
  const title = {
    idle: 'Check for updates', checking: 'Checking for updates…', available: 'Update available',
    downloading: 'Downloading update', downloaded: 'Update ready', installing: 'Restarting…', error: 'Update failed', unavailable: 'Updates unavailable',
  }[state.status];
  const action = state.status === 'downloaded' ? 'Restart' : state.status === 'available' ? 'Download' : state.status === 'error' ? 'Retry' : '';
  return <div className="handwork-update" data-status={state.status} data-failed={failed || undefined}>
    <div className="handwork-update-row" title={message}>
      <span className="handwork-update-dot" aria-hidden />
      <span className="handwork-update-title">{failed && state.status !== 'error' ? 'Update failed' : title}</span>
      {state.status === 'downloading' && <span className="handwork-update-progress">{state.progress ?? 0}%</span>}
      {action && <Button variant="ghost" size="xs" className="handwork-update-action" disabled={blocked} aria-label={label} title={message} onClick={() => void activate()}>{action}</Button>}
    </div>
    {state.status === 'downloading' && <span className="handwork-update-bar" aria-hidden><span style={{ width: `${state.progress ?? 0}%` }} /></span>}
    {message !== 'Check for updates.' && <span role="status" className={failed ? 'handwork-update-status' : 'sr-only'}>{message}</span>}
  </div>;
}
