import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { MAX_ATTACHMENT_BYTES } from './ipc.mjs';

export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export const isPromptImage = mimeType => Object.values(IMAGE_TYPES).includes(mimeType);
const BINARY_TYPES = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.zip': 'application/zip', '.gz': 'application/gzip', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wasm': 'application/wasm' };
const TEXT_TYPES = { '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/toml', '.xml': 'text/xml', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function fileAttachment(name, bytes, uri) {
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is larger than 5 MB`);
  const ext = path.extname(name).toLowerCase();
  const base = { name, size: bytes.length, uri };
  if (IMAGE_TYPES[ext]) return { ...base, mimeType: IMAGE_TYPES[ext], data: bytes.toString('base64') };
  if (!BINARY_TYPES[ext] && !bytes.includes(0)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { ...base, mimeType: TEXT_TYPES[ext] ?? 'text/plain', text };
    } catch { /* Non-UTF-8 bytes remain a binary attachment. */ }
  }
  return { ...base, mimeType: BINARY_TYPES[ext] ?? 'application/octet-stream', data: bytes.toString('base64') };
}

/** Keep binary uploads intact and give the native agent a durable local target. */
export async function prepareAttachmentFiles(items, directory) {
  return Promise.all(items.map(async item => {
    if (item.data === undefined || isPromptImage(item.mimeType)) return item;
    const bytes = Buffer.from(item.data, 'base64');
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`${item.name} is larger than 5 MB`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const extension = path.extname(item.name).slice(0, 24).replace(/[^a-zA-Z0-9.]/g, '');
    const filePath = path.join(directory, `${randomUUID()}${extension}`);
    await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
    return { name: item.name, size: bytes.length, mimeType: item.mimeType, uri: pathToFileURL(filePath).href,
      text: `Attached file: ${item.name}\nType: ${item.mimeType}\nLocal copy: ${filePath}\nBinary attachment: inspect this file with a suitable local tool.` };
  }));
}
