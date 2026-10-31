"use client";
import { CircleAlert, X } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { IconFileText, IconClose } from '@/components/atoms/Icons';
import type { Attachment } from '@/lib/desktop-api';
import { attachmentAllowance, formatBytes, MAX_ATTACHMENTS, type RejectedFile } from '@/lib/attachment-staging';

/**
 * Files staged for the next message, what room is left, and any files that could
 * not be added with the reason for each. Accepted files stay when others fail.
 */
export function HandworkAttachmentTray({ files, rejected, onRemove, onDismissRejected }: {
  files: Attachment[]; rejected: RejectedFile[];
  onRemove: (index: number) => void; onDismissRejected: () => void;
}) {
  if (!files.length && !rejected.length) return null;
  const allowance = attachmentAllowance(files);
  return <div className="handwork-attachment-tray">
    {files.length > 0 && <div className="handwork-attachments" aria-label="Attachments">{files.map((file, index) => <Button key={`${file.name}-${index}`} size="sm" variant="secondary" aria-label={`Remove ${file.name}`} title={`${file.name} · ${formatBytes(file.size)}`} onClick={() => onRemove(index)}>
      {file.data && file.mimeType.startsWith("image/") ? <img className="handwork-attachment-thumb" src={`data:${file.mimeType};base64,${file.data}`} alt="" /> : <IconFileText size={14} />}<span>{file.name}</span><IconClose size={12} />
    </Button>)}</div>}
    {files.length > 0 && <p className="handwork-attachment-allowance" role="status">
      {files.length} of {MAX_ATTACHMENTS} files · {allowance.remaining ? `about ${formatBytes(allowance.leftBytes)} left` : 'file limit reached'}
    </p>}
    {rejected.length > 0 && <div className="handwork-attachment-rejected" role="alert">
      <div className="handwork-attachment-rejected-heading">
        <CircleAlert aria-hidden width={13} height={13} />
        <span>{rejected.length === 1 ? '1 file was not added' : `${rejected.length} files were not added`}{files.length ? '. The others are attached.' : '.'}</span>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" title="Dismiss" onClick={onDismissRejected}><X aria-hidden width={12} height={12} /></Button>
      </div>
      <ul>{rejected.map((file, index) => <li key={`${file.name}-${index}`}><span className="handwork-attachment-rejected-name">{file.name}</span><span>{file.reason}</span></li>)}</ul>
    </div>}
  </div>;
}
