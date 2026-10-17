"use client";
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { BackupPreview, DesktopAPI, RestoreCategory, RestoreResult } from '@/lib/desktop-api';
import { restoreChoices, restoreSummary } from '@/lib/backup-summary';

const megabytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const dated = (time: number) => time ? new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'an unknown date';

/** Full backups: one file to keep somewhere safe, and a checked, previewed restore. */
export function HandworkBackup({ api, disabled, busy, run, onMessage, onRestored }: {
  api?: DesktopAPI; disabled: boolean; busy: boolean;
  run: <T,>(task: () => Promise<T>, label: string) => Promise<T | undefined>;
  onMessage: (message: string) => void; onRestored: (result: RestoreResult) => void;
}) {
  const [preview, setPreview] = useState<BackupPreview>();
  const [chosen, setChosen] = useState<Record<RestoreCategory, boolean>>({ chats: true, prompts: true, preferences: true, unsent: true });
  const [restoring, setRestoring] = useState(false);
  const [failure, setFailure] = useState('');
  async function backUp() {
    const result = await run(() => api!.createBackup(), 'Backing up…');
    if (result && !result.cancelled) onMessage(`Backed up ${result.chats} chat${result.chats === 1 ? '' : 's'} to ${result.path?.split(/[\\/]/).pop()} (${megabytes(result.bytes ?? 0)} before compression).`);
  }
  async function choose() {
    const result = await run(() => api!.previewBackup(), 'Checking backup…');
    if (!result || 'cancelled' in result) return;
    setFailure(''); setChosen(restoreChoices(result)); setPreview(result);
  }
  async function restore() {
    if (!preview || restoring) return;
    setRestoring(true); setFailure('');
    try {
      const available = restoreChoices(preview);
      const result = await api!.restoreBackup(preview.token, Object.fromEntries((Object.keys(available) as RestoreCategory[]).map(id => [id, available[id] && chosen[id]])));
      setPreview(undefined);
      onMessage(restoreSummary(result));
      onRestored(result);
    } catch (cause) { setFailure((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setRestoring(false); }
  }
  const option = (id: RestoreCategory, title: string, detail: string, available: boolean) => <label className="handwork-restore-option" data-disabled={!available || undefined}>
    <Checkbox size="small" checked={available && chosen[id]} disabled={!available || restoring} onCheckedChange={value => setChosen(current => ({ ...current, [id]: value === true }))} />
    <span><span className="handwork-setting-title">{title}</span><p>{detail}</p></span>
  </label>;
  const anything = !!preview && Object.entries(restoreChoices(preview)).some(([id, available]) => available && chosen[id as RestoreCategory]);
  return <>
    <h3>Backup and restore</h3>
    <p className="handwork-settings-note">A backup is one file with your chats and their attachments, saved prompts, preferences, archived chats, chat versions, drafts, and queued messages. API keys, sign-ins, and engine settings are never included. Keep backups somewhere private: they contain your full chat history.</p>
    <div className="handwork-settings-buttons">
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => void backUp()}>Back up…</Button>
      <Button size="sm" variant="ghost" disabled={disabled || busy} title={busy ? 'Wait for running replies to finish' : undefined} onClick={() => void choose()}>Restore from backup…</Button>
    </div>
    <Dialog open={!!preview} onOpenChange={value => { if (!value && !restoring) setPreview(undefined); }}>
      <DialogContent className="handwork-chat-dialog handwork-restore-dialog" showCloseButton={!restoring}>
        <DialogHeader>
          <DialogTitle>Restore from backup?</DialogTitle>
          <DialogDescription>{preview ? `${preview.fileName} · made ${dated(preview.createdAt)}${preview.appVersion ? ` with Handwork ${preview.appVersion}` : ''} · ${megabytes(preview.size)}. The backup was checked and is complete.` : ''}</DialogDescription>
        </DialogHeader>
        {preview && <DialogBody className="handwork-restore-options">
          {option('chats', 'Chats', preview.chats.new
            ? `${preview.chats.new} of ${preview.chats.total} chats are new here, with their attachments, versions, and archive state.${preview.chats.total > preview.chats.new ? ' Chats already on this computer stay as they are.' : ''}${preview.projects.total ? ` ${preview.projects.available} of ${preview.projects.total} projects were found on this computer.` : ''}`
            : `All ${preview.chats.total} chats are already on this computer.`, preview.chats.new > 0)}
          {option('prompts', 'Saved prompts', preview.prompts.new ? `${preview.prompts.new} of ${preview.prompts.total} prompts are new here.` : preview.prompts.total ? 'Every saved prompt is already here.' : 'The backup has no saved prompts.', preview.prompts.new > 0)}
          {option('preferences', 'Preferences', 'Theme, text sizes, defaults, notifications, and favorite models replace the ones here. Startup tabs stay local.', preview.preferences)}
          {option('unsent', 'Drafts and queued messages', preview.unsent.drafts || preview.unsent.queued
            ? `${[preview.unsent.drafts && `${preview.unsent.drafts} draft${preview.unsent.drafts === 1 ? '' : 's'}`, preview.unsent.queued && `${preview.unsent.queued} queued message${preview.unsent.queued === 1 ? '' : 's'}`].filter(Boolean).join(' and ')}. Queued messages come back paused, so nothing sends until you review it.`
            : 'Nothing unsent in this backup is missing here.', preview.unsent.drafts + preview.unsent.queued > 0)}
          {failure && <p role="alert" className="handwork-chat-action-error">{failure}</p>}
        </DialogBody>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={restoring} onClick={() => setPreview(undefined)}>Cancel</Button>
          <Button type="button" disabled={restoring || !anything} onClick={() => void restore()}>{restoring ? 'Restoring…' : 'Restore'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
