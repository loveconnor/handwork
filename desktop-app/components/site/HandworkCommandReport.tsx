"use client";

import { useEffect, useState } from 'react';
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { DesktopAPI } from '@/lib/desktop-api';

export type ReportCommand = 'status' | 'usage' | 'doctor' | 'version';
const titles = { status: 'Runtime status', usage: 'Local usage', doctor: 'Health checks', version: 'Handwork version' };
const label = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');

export function ReportValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="handwork-report-muted">Not reported</span>;
  if (typeof value === 'number') return <span className="handwork-report-number">{value.toLocaleString()}</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'string') return <span>{value || 'None'}</span>;
  if (Array.isArray(value)) return value.length ? <ol className="handwork-report-list">{value.slice(0, 100).map((item, index) => <li key={index}><ReportValue value={item} /></li>)}{value.length > 100 && <li className="handwork-report-muted">Showing 100 of {value.length.toLocaleString()} entries.</li>}</ol> : <span className="handwork-report-muted">None</span>;
  return <dl className="handwork-report-fields">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{label(key)}</dt><dd><ReportValue value={item} /></dd></div>)}</dl>;
}

export default function HandworkCommandReport({ command, api, onClose }: { command?: ReportCommand; api?: DesktopAPI; onClose: () => void }) {
  const [result, setResult] = useState<{ command: string; data: unknown; exitCode: number }>();
  const [error, setError] = useState<{ command: string; message: string }>();
  useEffect(() => {
    if (!command) return;
    setResult(undefined); setError(undefined);
    let current = true;
    if (!api?.commandReport) { setError({ command, message: 'This engine connection does not provide terminal reports. Restart with the updated desktop build.' }); return; }
    void api.commandReport(command).then(result => { if (current) setResult(result); }).catch(cause => { if (current) setError({ command, message: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { current = false; };
  }, [command, api]);
  const shown = result?.command === command ? result : undefined;
  const failure = error && error.command === command ? error.message : undefined;
  return <Dialog open={!!command} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPopup className="handwork-command-report" finalFocus={() => document.querySelector<HTMLTextAreaElement>('[data-slot="prompt-bar-input"]')}>
      <DialogHeader><DialogTitle>{command ? titles[command] : 'Terminal report'}</DialogTitle><DialogDescription>From the terminal engine, without sending a model prompt.</DialogDescription></DialogHeader>
      <DialogBody>
        {failure ? <p role="alert">{failure}</p> : shown ? <>{shown.exitCode !== 0 && <p role="status" className="handwork-report-warning">The engine reported issues, exit code {shown.exitCode}.</p>}<ReportValue value={shown.data} /></> : <p role="status">Loading report…</p>}
      </DialogBody>
      <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
    </DialogPopup>
  </Dialog>;
}
