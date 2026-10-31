"use client";

import { HoverTooltip } from "@/components/ui/tooltip";
import { useEffect, useState } from 'react';
import { ExternalLink, FolderOpen, Copy, Check, FileText } from 'honestui/icons';
import { Markdown } from 'honestui/ai/markdown';
import { SyntaxCode } from 'honestui/syntax/react';
import { mathPlugins } from 'honestui/ai/markdown-math';
import { prepareMath } from '@/lib/markdown-math';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { DesktopAPI, FilePreview } from '@/lib/desktop-api';
import { isMac } from '@/lib/saved-prompts';

/** Something a message refers to: image bytes it already carries, or a local file. */
export type FileTarget = { name: string; mimeType?: string; data?: string; target?: string };

export const revealLabel = isMac ? 'Reveal in Finder' : 'Show in folder';
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const size = (bytes?: number) => bytes === undefined ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Keep source files as source, and let Honest Prose format Markdown documents. */
export function FileTextPreview({ preview }: { preview: FilePreview }) {
  const name = preview.name.toLowerCase();
  const extension = name.split('.').at(-1);
  const markdown = preview.mimeType === 'text/markdown' || /\.(md|markdown)$/.test(name);
  if (markdown) return <Markdown className="handwork-file-markdown" syntaxHighlighting syntaxPalette="violet" remarkPlugins={mathPlugins.remarkPlugins} rehypePlugins={mathPlugins.rehypePlugins}>{prepareMath(preview.text ?? '')}</Markdown>;
  const language = /^(dockerfile|containerfile)(\.|$)/.test(name) ? 'dockerfile'
    : /^(\.env(?:\.|$)|\.?(bashrc|zshrc|profile)$)/.test(name) ? 'bash'
    : extension === 'mjs' || extension === 'cjs' ? 'js'
    : extension === 'mts' || extension === 'cts' ? 'ts'
    : extension;
  return <SyntaxCode className="handwork-file-text" code={preview.text ?? ''} language={language} data-syntax-palette="violet" aria-label={`${preview.name} source`} />;
}

/** Previews images and text files in the app; everything else opens in its own app. */
export function HandworkFileViewer({ file, api, onClose }: { file?: FileTarget; api?: DesktopAPI; onClose: () => void }) {
  const [preview, setPreview] = useState<FilePreview>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setPreview(undefined); setMessage(''); setCopied(false);
    if (!file) return;
    // Images sent from this computer already carry their bytes.
    if (file.data && file.mimeType?.startsWith('image/')) { setStatus('ready'); return; }
    if (!file.target || !api?.previewFile) { setStatus('failed'); setMessage('This file is not available on this computer.'); return; }
    let current = true;
    setStatus('loading');
    api.previewFile(file.target).then(result => { if (current) { setPreview(result); setStatus('ready'); } })
      .catch(cause => { if (current) { setStatus('failed'); setMessage(errorText(cause)); } });
    return () => { current = false; };
  }, [file, api]);

  const image = file?.data && file.mimeType?.startsWith('image/') ? `data:${file.mimeType};base64,${file.data}` : preview?.kind === 'image' && preview.data ? `data:${preview.mimeType};base64,${preview.data}` : undefined;
  const act = async (action: 'open' | 'reveal') => {
    if (!api || !file?.target) return;
    setMessage('');
    try { await (action === 'open' ? api.openFile(file.target) : api.revealFile(file.target)); if (action === 'open') onClose(); }
    catch (cause) { setMessage(errorText(cause)); }
  };
  const location = preview?.path;

  return <Dialog open={!!file} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className={`handwork-file-viewer ${image ? 'is-image' : ''}`} finalFocus={() => document.querySelector<HTMLElement>('[data-slot="prompt-bar-input"]')}>
      <DialogHeader>
        <DialogTitle>{preview?.name ?? file?.name}</DialogTitle>
        <HoverTooltip content={location}><DialogDescription className="handwork-file-location" >
          {preview && <span className="handwork-file-size">{size(preview.size)} ·</span>}
          {/* Long paths keep their file name visible and lose the start instead. */}
          <span className="handwork-file-path"><bdi>{location ?? (status === 'loading' ? 'Loading…' : 'Sent with this message')}</bdi></span>
        </DialogDescription></HoverTooltip>
      </DialogHeader>
      <div className="handwork-file-body">
        {status === 'loading' && <p role="status" className="handwork-file-empty">Loading preview…</p>}
        {image && <img src={image} alt={file?.name ?? ''} />}
        {!image && preview?.kind === 'text' && <FileTextPreview preview={preview} />}
        {preview?.truncated && <p className="handwork-file-note">Showing the first 512 KB.</p>}
        {!image && status !== 'loading' && preview?.kind !== 'text' && <div className="handwork-file-empty">
          <FileText aria-hidden width={22} height={22} />
          <p>{preview?.allowed === false ? 'This file is outside your projects and attachments.' : status === 'failed' ? 'Preview unavailable' : 'No preview for this file type'}</p>
          <span>{preview?.allowed === false ? `${revealLabel} to open it yourself.` : preview?.canOpen ? 'Open it in its default app.' : ''}</span>
        </div>}
      </div>
      {message && <p role="alert" className="handwork-file-error">{message}</p>}
      {(location || preview?.canReveal || preview?.canOpen) && <DialogFooter className="handwork-file-actions">
        {location && <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard.writeText(location).then(() => setCopied(true)); }}>{copied ? <Check aria-hidden width={14} height={14} /> : <Copy aria-hidden width={14} height={14} />}{copied ? 'Copied' : 'Copy path'}</Button>}
        <span className="handwork-file-spacer" />
        {preview?.canReveal && <Button variant="outline" size="sm" onClick={() => void act('reveal')}><FolderOpen aria-hidden width={14} height={14} />{revealLabel}</Button>}
        {preview?.canOpen && <Button size="sm" onClick={() => void act('open')}><ExternalLink aria-hidden width={14} height={14} />Open</Button>}
      </DialogFooter>}
    </DialogContent>
  </Dialog>;
}
