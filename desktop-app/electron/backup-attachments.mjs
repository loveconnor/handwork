import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Compare source paths using the source platform, not the restoring computer's. */
export function backupRelativePath(root, value) {
  if (typeof root !== 'string' || typeof value !== 'string' || /[\x00-\x1f]/.test(root + value)) return null;
  const paths = /^(?:[a-z]:[\\/]|\\\\)/i.test(root) ? path.win32 : path.posix;
  if (!paths.isAbsolute(root) || !paths.isAbsolute(value)) return null;
  // Reject traversal rather than normalizing it into an apparently trusted path.
  if (value.split(paths === path.win32 ? /[\\/]/ : /\//).includes('..')) return null;
  const relative = paths.relative(root, value);
  if (paths.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${paths.sep}`)) return null;
  return relative.split(paths.sep).filter(Boolean);
}

function fileURIPath(uri) {
  try {
    if (decodeURIComponent(uri).split(/[\\/]/).includes('..')) return null;
    const url = new URL(uri);
    if (url.protocol !== 'file:' || url.search || url.hash || url.username || url.password) return null;
    // Encoded separators must not become path boundaries after decoding.
    if (/%(?:2f|5c)/i.test(url.pathname)) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== 'localhost') return `\\\\${url.hostname}${pathname.replaceAll('/', '\\')}`;
    return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1).replaceAll('/', '\\') : pathname;
  } catch { return null; }
}

/** Only rewrite generated binary attachment blocks in stored user messages. */
export function relocateAttachmentEvents(contents, roots, archived) {
  return contents.split('\n').map(line => {
    let record;
    try { record = JSON.parse(line); } catch { return line; }
    const user = record?.event?.user;
    if (typeof user?.text !== 'string') return line;
    const text = user.text.replace(/(^|\n)File: (file:\/\/[^\n]+)\nAttached file: ([^\n]+)\nType: ([^\n]+)\nLocal copy: ([^\n]+)\nBinary attachment: inspect this file with a suitable local tool\./g,
      (block, prefix, uri, name, mime, local, offset) => {
        // A quoted code example is not an attachment, even if it has the same shape.
        const before = user.text.slice(0, offset);
        let fence = null;
        for (const line of before.split('\n')) {
          const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
          if (!marker) continue;
          if (!fence) fence = marker;
          else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        }
        if (fence) return block;
        const original = fileURIPath(uri);
        if (!original) return block;
        for (const { source, destination, archive } of roots) {
          const relative = backupRelativePath(source, original);
          const localRelative = backupRelativePath(source, local);
          if (!relative?.length || !localRelative || relative.join('/') !== localRelative.join('/')) continue;
          const key = `${archive}/${relative.join('/')}`;
          // Standalone files live only below <chat id>/attachments; project files are flat.
          if (archive === 'chats' && !(relative.length === 3 && /^[a-f0-9-]{36}$/.test(relative[0]) && relative[1] === 'attachments')) continue;
          if (!archived.has(key)) continue;
          const target = archived instanceof Map ? archived.get(key) : path.join(destination, ...relative);
          return `${prefix}File: ${pathToFileURL(target).href}\nAttached file: ${name}\nType: ${mime}\nLocal copy: ${target}\nBinary attachment: inspect this file with a suitable local tool.`;
        }
        return block;
      });
    if (text === user.text) return line;
    user.text = text;
    return JSON.stringify(record);
  }).join('\n');
}
