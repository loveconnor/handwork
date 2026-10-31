'use client';

import { useEffect } from 'react';
import { HoverTooltip } from '@/components/ui/tooltip';

type WindowState = { fullscreen: boolean; maximized: boolean };
type Action = 'minimize' | 'toggle-maximize' | 'close' | 'state';
type Props = { api: { windowAction: (action: Action) => Promise<WindowState | undefined> }; maximized: boolean; onState: (state: WindowState) => void };

export function HandworkWindowControls({ api, maximized, onState }: Props) {
  useEffect(() => {
    let active = true;
    void api.windowAction('state').then(state => { if (active && state) onState(state); }).catch(console.error);
    return () => { active = false; };
    // Read once on mount; ongoing state updates come from window/state events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  const run = (action: Action) => { void api.windowAction(action).then(state => { if (state) onState(state); }).catch(console.error); };
  const zoomLabel = maximized ? 'Restore' : 'Maximize';
  return <div className='handwork-window-controls' role='group' aria-label='Window controls'>
    <HoverTooltip content='Minimize'><button type='button' aria-label='Minimize' onClick={() => run('minimize')}><svg aria-hidden='true' width='12' height='12' viewBox='0 0 12 12' fill='none'><path d='M1 6h10' stroke='currentColor' /></svg></button></HoverTooltip>
    <HoverTooltip content={zoomLabel}><button type='button' aria-label={zoomLabel} onClick={() => run('toggle-maximize')}><svg aria-hidden='true' width='12' height='12' viewBox='0 0 12 12' fill='none'>{maximized ? <path d='M3.5 3.5v-2h7v7h-2m-7-5h7v7h-7z' stroke='currentColor' /> : <rect x='1.5' y='1.5' width='9' height='9' stroke='currentColor' />}</svg></button></HoverTooltip>
    <HoverTooltip content='Close'><button className='handwork-window-close' type='button' aria-label='Close' onClick={() => run('close')}><svg aria-hidden='true' width='12' height='12' viewBox='0 0 12 12' fill='none'><path d='m1.5 1.5 9 9m0-9-9 9' stroke='currentColor' /></svg></button></HoverTooltip>
  </div>;
}
