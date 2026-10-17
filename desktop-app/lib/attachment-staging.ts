import type { Attachment } from './desktop-api';

// Keep in step with electron/ipc.mjs, which enforces the same limits.
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_PROMPT_BYTES = 7 * 1024 * 1024;

export type RejectedFile = { name: string; reason: string };
/** A file offered for attaching, before its contents are read. */
export type FileCandidate = { name: string; size: number };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What a file costs in one message: base64 for binary files, UTF-8 bytes for text. */
export function messageBytes(file: Pick<Attachment, 'data' | 'text'>): number {
  return file.data !== undefined ? file.data.length : new TextEncoder().encode(file.text ?? '').length;
}
const encoded = (size: number) => Math.ceil(size / 3) * 4;

/** How many files and how much space a message has left, as file sizes (binary files cost about a third more). */
export function attachmentAllowance(files: Pick<Attachment, 'data' | 'text'>[]) {
  const used = files.reduce((total, file) => total + messageBytes(file), 0);
  return { count: files.length, remaining: Math.max(0, MAX_ATTACHMENTS - files.length), leftBytes: Math.max(0, Math.floor((MAX_PROMPT_BYTES - used) * 3 / 4)) };
}

/**
 * Splits offered files into those that fit this message and those that do not,
 * each with its own reason. Sizes are checked before anything is read.
 */
export function planAttachments(current: Pick<Attachment, 'name' | 'size' | 'data' | 'text'>[], candidates: FileCandidate[]): { accepted: number[]; rejected: RejectedFile[] } {
  let count = current.length;
  let used = current.reduce((total, file) => total + messageBytes(file), 0);
  const accepted: number[] = [];
  const rejected: RejectedFile[] = [];
  candidates.forEach((file, index) => {
    if (current.some(item => item.name === file.name && item.size === file.size)) rejected.push({ name: file.name, reason: 'Already attached' });
    else if (file.size > MAX_ATTACHMENT_BYTES) rejected.push({ name: file.name, reason: `${formatBytes(file.size)} is over the 5 MB limit per file` });
    else if (count >= MAX_ATTACHMENTS) rejected.push({ name: file.name, reason: `A message can carry ${MAX_ATTACHMENTS} files` });
    // Text may cost less than this estimate; the exact check runs after reading.
    else if (used + encoded(file.size) > MAX_PROMPT_BYTES) rejected.push({ name: file.name, reason: `Not enough room left in this message (about ${formatBytes(Math.max(0, Math.floor((MAX_PROMPT_BYTES - used) * 3 / 4)))} left)` });
    else { accepted.push(index); count++; used += encoded(file.size); }
  });
  return { accepted, rejected };
}

/** Adds read files that still fit, exactly measured. The rest are rejected with reasons. */
export function stageAttachments(current: Attachment[], incoming: Attachment[]): { files: Attachment[]; rejected: RejectedFile[] } {
  const files = [...current];
  const rejected: RejectedFile[] = [];
  let used = files.reduce((total, file) => total + messageBytes(file), 0);
  for (const file of incoming) {
    const cost = messageBytes(file);
    if (files.some(item => item.name === file.name && item.size === file.size && messageBytes(item) === cost)) rejected.push({ name: file.name, reason: 'Already attached' });
    else if (file.size > MAX_ATTACHMENT_BYTES) rejected.push({ name: file.name, reason: `${formatBytes(file.size)} is over the 5 MB limit per file` });
    else if (files.length >= MAX_ATTACHMENTS) rejected.push({ name: file.name, reason: `A message can carry ${MAX_ATTACHMENTS} files` });
    else if (used + cost > MAX_PROMPT_BYTES) rejected.push({ name: file.name, reason: `Not enough room left in this message (about ${formatBytes(Math.max(0, Math.floor((MAX_PROMPT_BYTES - used) * 3 / 4)))} left)` });
    else { files.push(file); used += cost; }
  }
  return { files, rejected };
}
