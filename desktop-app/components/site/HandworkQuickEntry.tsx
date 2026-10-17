"use client";

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, SquareDashedMousePointer, X } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { applyAppearance, savedAppearance } from '@/lib/appearance';
import type { Attachment } from '@/lib/desktop-api';
import { isMac } from '@/lib/saved-prompts';

const MAX_HEIGHT = 200;
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** The compact composer shown by the global quick entry shortcut. */
export default function HandworkQuickEntry() {
  const api = typeof window !== 'undefined' ? window.handwork : undefined;
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState('');
  const card = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('handwork-quick-root');
    const sync = () => applyAppearance(savedAppearance());
    sync();
    // The main window owns appearance settings; storage events carry its changes here.
    window.addEventListener('storage', sync);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', sync);
    const unsubscribe = api?.onEvent(event => {
      if (event.method !== 'quick/show') return;
      sync(); setError('');
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    });
    input.current?.focus();
    return () => { window.removeEventListener('storage', sync); media.removeEventListener('change', sync); unsubscribe?.(); };
  }, [api]);

  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = '0px';
    field.style.height = `${Math.min(field.scrollHeight, MAX_HEIGHT)}px`;
    field.style.overflowY = field.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [text]);
  useEffect(() => {
    const element = card.current;
    if (!element || !api?.quickResize) return;
    const observer = new ResizeObserver(() => { void api.quickResize(element.getBoundingClientRect().height + 32).catch(() => {}); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [api]);

  const canSend = !!api && !capturing && (text.trim().length > 0 || files.length > 0);
  async function submit() {
    if (!canSend) return;
    try { await api!.quickSubmit(text.trim(), files); setText(''); setFiles([]); setError(''); }
    catch (cause) { setError(errorText(cause)); }
  }
  async function capture() {
    if (!api || capturing) return;
    setCapturing(true); setError('');
    try { const shot = await api.quickCapture(); if (shot) setFiles(current => [...current, shot].slice(0, 10)); }
    catch (cause) { setError(errorText(cause)); }
    finally { setCapturing(false); requestAnimationFrame(() => input.current?.focus()); }
  }

  return <form ref={card} className="handwork-quick" aria-label="Quick entry" onSubmit={event => { event.preventDefault(); void submit(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); void api?.quickDismiss(); } }}>
    <div className="handwork-quick-brand app-drag" aria-hidden><span>Handwork</span></div>
    <textarea ref={input} rows={1} value={text} aria-label="Ask Handwork" placeholder="Ask Handwork anything…" spellCheck
      onChange={event => setText(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
    {files.length > 0 && <ul className="handwork-quick-files" aria-label="Attachments">{files.map((file, index) => <li key={`${file.name}-${index}`}>
      {file.data && file.mimeType.startsWith('image/') && <img src={`data:${file.mimeType};base64,${file.data}`} alt="" />}
      <span>{file.name}</span>
      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter((_, position) => position !== index))}><X aria-hidden width={12} height={12} /></Button>
    </li>)}</ul>}
    {error && <p role="alert" className="handwork-quick-error">{error}</p>}
    <div className="handwork-quick-controls">
      <Button type="button" variant="ghost" size="sm" disabled={!api || capturing} onClick={() => void capture()}><SquareDashedMousePointer aria-hidden width={15} height={15} />{capturing ? 'Capturing…' : 'Screenshot'}</Button>
      <span className="handwork-quick-hint"><kbd>↵</kbd> opens a new chat · <kbd>esc</kbd> closes</span>
      <Button type="submit" size="icon" className="handwork-quick-send" aria-label="Send to Handwork" title={isMac ? 'Send (↵)' : 'Send (Enter)'} disabled={!canSend}><ArrowUp aria-hidden strokeWidth={2} /></Button>
    </div>
  </form>;
}
