"use client";
import { HoverTooltip } from "@/components/ui/tooltip";
import { useEffect, useState, type ReactNode } from 'react';
import { ContextMeter } from 'honestui/ai/context-meter';
import { Check, Copy, SquareArrowOutUpRight } from 'honestui/icons';
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription, DialogBody } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ProviderLogo } from './ProviderLogo';
import type { FileTarget } from './HandworkFileViewer';
import type { ChatDetails, DesktopAPI } from '@/lib/desktop-api';
import type { ConfigOption, Conversation, EntryAttachment } from '@/lib/desktop-state';
import { modelDisplayName } from '@/lib/model-presentation';
import { formatBytes } from '@/lib/attachment-staging';
import { isMac } from '@/lib/saved-prompts';

const tools = [['read', 'Read files'], ['edit', 'Edit files'], ['bash', 'Run commands'], ['web_fetch', 'Fetch web pages'], ['web_search', 'Search the web']] as const;
const actions = { ask: { label: 'Ask', variant: 'warning' }, allow: { label: 'Allow', variant: 'success' }, deny: { label: 'Block', variant: 'error' } } as const;
const scopeLabels = { app: 'All projects', ancestor: 'Parent folder', project: 'This project' };
const revealLabel = isMac ? 'Show in Finder' : 'Show in folder';
const clean = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const capitalized = (value: string) => value ? value[0].toUpperCase() + value.slice(1) : value;
const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
/** A path that fits one line: the start is elided so the meaningful end stays visible. */
function shortPath(path: string, home?: string): string {
  const shown = home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path;
  if (shown.length <= 52) return shown;
  const parts = shown.split('/').filter(Boolean);
  let tail = parts.pop() ?? shown;
  while (parts.length && tail.length + parts[parts.length - 1].length < 44) tail = `${parts.pop()}/${tail}`;
  return `…/${tail}`;
}
const folderName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() || folder;

function rule(value: unknown): keyof typeof actions | undefined {
  const action = typeof value === 'string' ? value : value && typeof value === 'object' && '*' in value ? String((value as Record<string, unknown>)['*']) : undefined;
  return action && Object.hasOwn(actions, action) ? action as keyof typeof actions : undefined;
}

/** One flat section of the sheet: a small label, then its rows. Hairlines separate sections. */
function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="handwork-details-section" aria-label={title}>
    <header><h3>{title}</h3>{action}</header>
    {children}
  </section>;
}

/** A key/value line: label left, value right. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function Skeleton({ lines = 2 }: { lines?: number }) {
  return <div className="handwork-details-skeleton" role="status" aria-label="Loading">{Array.from({ length: lines }, (_, index) => <span key={index} style={{ width: `${88 - index * 26}%` }} />)}</div>;
}

function RevealButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <Button variant="ghost" size="icon-sm" className="handwork-details-reveal" aria-label={`${revealLabel}: ${label}`} title={revealLabel} onClick={onClick}><SquareArrowOutUpRight aria-hidden width={13} height={13} /></Button>;
}

/** Attachments with the message they came from, so repeated names like "Image 1" stay distinct. */
function chatAttachments(conversation: Conversation) {
  let message = 0;
  return conversation.entries.flatMap(entry => {
    if (entry.kind !== 'user') return [];
    message++;
    return (entry.attachments ?? []).map((file, index) => ({ file, key: `${entry.id}-${index}`, message }));
  });
}

/**
 * Everything that shapes the open chat's replies, in one place: model settings,
 * context, where it works, instruction files, tool rules, and attachments.
 * Anything that is not known yet is left out rather than guessed.
 */
export function HandworkChatDetails({ open, onOpenChange, api, title, chatId, options, conversation, onOpenSettings, onOpenFile }: {
  open: boolean; onOpenChange: (open: boolean) => void; api?: DesktopAPI; title: string; chatId?: string;
  options: ConfigOption[]; conversation: Conversation; onOpenSettings: () => void; onOpenFile?: (file: FileTarget) => void;
}) {
  const [details, setDetails] = useState<ChatDetails>();
  const [failure, setFailure] = useState('');
  const [allFiles, setAllFiles] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    setDetails(undefined); setFailure(''); setAllFiles(false); setCopied(false);
    // A desktop build from before this sheet existed cannot report project details.
    if (!api?.chatDetails) { setFailure('Restart Handwork to see where this chat works and which files guide it.'); return; }
    let current = true;
    void api.chatDetails().then(value => { if (current) setDetails(value); }).catch(cause => { if (current) setFailure(clean(cause)); });
    return () => { current = false; };
  }, [open, api]);

  const option = (id: string) => options.find(item => item.id === id);
  const choice = (id: string) => {
    const found = option(id);
    if (!found) return undefined;
    const name = found.options.find(item => item.value === found.currentValue)?.name ?? found.currentValue;
    return id === 'model' ? modelDisplayName(name) : name;
  };
  const providerId = option('provider')?.currentValue ?? '';
  const fast = option('fast_mode')?.currentValue;
  const fastOn = !!fast && /^(on|true)$/i.test(fast);
  const model = choice('model');
  const provider = choice('provider');
  const effort = choice('effort');
  const mode = choice('mode');
  const attachments = chatAttachments(conversation);
  const images = attachments.filter(item => item.file.data && item.file.mimeType.startsWith('image/'));
  const files = attachments.filter(item => !images.includes(item));
  const reveal = (target: string) => void api?.revealFile(target).catch(() => {});
  const openImage = (file: EntryAttachment) => { onOpenChange(false); onOpenFile?.({ name: file.name, mimeType: file.mimeType, data: file.data }); };
  const loading = !details && !failure;
  const standalone = details?.standalone;
  // Only what is known is shown; an unreported model leaves the section out.
  const hasModel = !!(provider || effort || fast || conversation.used !== undefined);
  const copyId = () => { if (!chatId) return; void navigator.clipboard.writeText(chatId).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPopup className="handwork-chat-details" initialFocus={() => document.querySelector<HTMLElement>('.handwork-chat-details')}>
      <DialogHeader className="handwork-details-header">
        <span className="handwork-details-eyebrow" aria-hidden>Chat details</span>
        <DialogTitle className="handwork-details-title" title={title}>{title}</DialogTitle>
        {(model || mode) && <DialogDescription className="handwork-details-subtitle">
          {model && <span className="handwork-details-model"><ProviderLogo provider={providerId} size={13} />{model}</span>}
          {model && mode && !standalone && <span aria-hidden className="handwork-details-dot" />}
          {mode && !standalone && <span>{mode}</span>}
        </DialogDescription>}
      </DialogHeader>
      <DialogBody className="handwork-details-body">
        {hasModel && <Section title="Setup">
          <dl className="handwork-details-facts">
            {provider && <Fact label="Provider">{provider}</Fact>}
            {effort && <Fact label="Effort">{capitalized(effort)}</Fact>}
            {fast && <Fact label="Fast mode">{fastOn ? 'On' : 'Off'}</Fact>}
            {conversation.used !== undefined && <Fact label="Context">{conversation.capacity
              ? <span className="handwork-details-meter"><ContextMeter used={conversation.used} limit={conversation.capacity} /><span>{compact(conversation.used)}<span className="handwork-details-meta"> / {compact(conversation.capacity)}</span></span></span>
              : `${conversation.used.toLocaleString()} tokens used`}</Fact>}
          </dl>
        </Section>}

        {failure && <p role="alert" className="handwork-details-alert">{failure}</p>}

        {!failure && <Section title={standalone ? 'Where it works' : 'Folders'}>
          {loading ? <Skeleton /> : standalone
            ? <p className="handwork-details-note">Standalone chat with no project folder. Handwork can search the web and read files attached here, but cannot open or change other files.</p>
            : details && <ul className="handwork-details-rows">
              <li>
                <div className="handwork-details-row-text"><span>{folderName(details.workspace)}</span><HoverTooltip content={details.workspace}><small>{shortPath(details.workspace, details.home)}</small></HoverTooltip></div>
                <RevealButton label={details.workspace} onClick={() => reveal(details.workspace)} />
              </li>
              {details.directories.map(folder => <li key={folder}>
                <div className="handwork-details-row-text"><span>{folderName(folder)} <span className="handwork-details-meta">Extra folder</span></span><HoverTooltip content={folder}><small>{shortPath(folder, details.home)}</small></HoverTooltip></div>
                <RevealButton label={folder} onClick={() => reveal(folder)} />
              </li>)}
            </ul>}
        </Section>}

        {!failure && <Section title="Instructions">
          {loading ? <Skeleton /> : standalone
            ? <p className="handwork-details-note">Standalone chats do not read AGENTS.md files.</p>
            : details && <>
              {details.instructions.length ? <ul className="handwork-details-rows">{details.instructions.map(file => <li key={file.path}>
                <div className="handwork-details-row-text"><span>{scopeLabels[file.scope]} <span className="handwork-details-meta">{formatBytes(file.bytes)}</span></span><HoverTooltip content={file.path}><small>{shortPath(file.path, details.home)}</small></HoverTooltip></div>
                <RevealButton label={file.path} onClick={() => reveal(file.path)} />
              </li>)}</ul> : <p className="handwork-details-note">No AGENTS.md files apply yet. <button type="button" className="handwork-details-link" onClick={() => { onOpenChange(false); onOpenSettings(); }}>Add instructions in Settings</button></p>}
              <p className="handwork-details-footnote">AGENTS.md files in subfolders also apply when Handwork works there.</p>
            </>}
        </Section>}

        {!failure && !standalone && <Section title="Tool permissions">
          {loading ? <Skeleton lines={3} /> : details && <>
            <dl className="handwork-details-facts">{tools.map(([id, label]) => {
              const project = rule(details.permissions.project[id]);
              const action = project ?? rule(details.permissions.global[id]);
              return <Fact key={id} label={label}>{action ? <HoverTooltip content={project ? 'Set for this project' : 'Set for all projects'}><Badge variant={actions[action].variant} size="sm" >{actions[action].label}{project ? ' · project' : ''}</Badge></HoverTooltip> : <span className="handwork-details-meta">Default</span>}</Fact>;
            })}</dl>
            <p className="handwork-details-footnote">Path-specific rules can still apply. Changes take effect after you reconnect.</p>
          </>}
        </Section>}

        <Section title="Attachments" action={attachments.length > 0 && <span className="handwork-details-count">{attachments.length}</span>}>
          {!attachments.length ? <p className="handwork-details-note">No files attached yet.</p> : <>
            {images.length > 0 && <ul className="handwork-details-thumbs">{(allFiles ? images : images.slice(0, 8)).map(({ file, key, message }) => <li key={key}>
              <HoverTooltip content={`${file.name} · message ${message}${file.size ? ` · ${formatBytes(file.size)}` : ''}`}><button type="button" onClick={() => openImage(file)} aria-label={`Open ${file.name} from message ${message}`} >
                <img src={`data:${file.mimeType};base64,${file.data}`} alt="" />
              </button></HoverTooltip>
            </li>)}</ul>}
            {files.length > 0 && <ul className="handwork-details-rows">{(allFiles ? files : files.slice(0, 5)).map(({ file, key, message }) => <li key={key}>
              <div className="handwork-details-row-text"><span>{file.name}</span><small>Message {message}{file.size ? ` · ${formatBytes(file.size)}` : ''}</small></div>
              {file.uri?.startsWith('file:') && <RevealButton label={file.name} onClick={() => reveal(file.uri!)} />}
            </li>)}</ul>}
            {(images.length > 8 || files.length > 5) && <Button variant="ghost" size="xs" className="handwork-details-more" onClick={() => setAllFiles(value => !value)}>{allFiles ? 'Show fewer' : `Show all ${attachments.length}`}</Button>}
          </>}
        </Section>

        {chatId && <Section title="Chat ID">
          <ul className="handwork-details-rows">
            <li>
              <div className="handwork-details-row-text"><code className="handwork-details-id" title={chatId}>{chatId}</code></div>
              <Button variant="ghost" size="icon-sm" className="handwork-details-reveal handwork-details-copy" data-copied={copied || undefined} aria-label={copied ? 'Copied' : 'Copy chat ID'} title={copied ? 'Copied' : 'Copy'} onClick={copyId}>{copied ? <Check aria-hidden width={13} height={13} /> : <Copy aria-hidden width={13} height={13} />}</Button>
            </li>
          </ul>
        </Section>}
      </DialogBody>
    </DialogPopup>
  </Dialog>;
}
