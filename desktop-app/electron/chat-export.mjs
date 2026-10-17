import path from 'node:path';

// The engine stores a prompt's files after its text as `File: <uri>` blocks and its
// images as `[Image #n]` placeholders. Readable exports show them as an attachment list.
const FILE_HEADER = /(?:^|\n)File: ((?:file|attachment):\/\/[^\n]*)\n/g;
const IMAGE_PLACEHOLDER = /\n?\[Image #(\d+)\]/g;

function fileName(uri, content) {
  const attached = /^Attached file: ([^\n]+)/.exec(content)?.[1];
  if (attached) return attached;
  try { return decodeURIComponent(new URL(uri).pathname.split('/').filter(Boolean).pop() || uri); } catch { return uri; }
}

/** A user message as the person wrote it, plus the names of what they attached. */
export function readableUserText(raw) {
  const headers = [...raw.matchAll(FILE_HEADER)];
  const files = headers.map((match, index) => fileName(match[1], raw.slice(match.index + match[0].length, headers[index + 1]?.index ?? raw.length)));
  const prompt = headers.length ? raw.slice(0, headers[0].index) : raw;
  const images = [...prompt.matchAll(IMAGE_PLACEHOLDER)].map(match => `Image ${match[1]}`);
  return { text: prompt.replace(IMAGE_PLACEHOLDER, '').trim(), attachments: [...images, ...files] };
}

const projectName = workspace => workspace ? path.basename(workspace) : '';

/** Chats as one Markdown document, readable anywhere and easy to share. */
export function chatsToMarkdown(chats, exportedAt = new Date()) {
  const date = exportedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const sections = chats.map(chat => {
    const lines = [`# ${chat.title || 'Untitled chat'}`, '', `*Exported from Handwork on ${date}${chat.project ? ` · ${chat.project}` : ''}*`];
    for (const message of chat.messages) {
      if (message.role === 'user') {
        const { text, attachments } = readableUserText(message.text);
        lines.push('', '## You', '');
        if (attachments.length) lines.push(`*Attached: ${attachments.join(', ')}*`, '');
        lines.push(text || '*(attachments only)*');
      } else {
        lines.push('', '## Handwork', '', message.text.trim());
      }
    }
    return lines.join('\n');
  });
  return sections.join('\n\n---\n\n') + '\n';
}

/** Adds the project name each chat belongs to; standalone chats have none. */
export function describeChat(chat, isStandalone) {
  return { ...chat, project: isStandalone(chat.workspace) ? '' : projectName(chat.workspace) };
}

export function exportFileName(scope, format, title) {
  const base = scope === 'current' && title
    ? title.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'handwork-chat'
    : 'handwork-chats';
  return `${base}.${format === 'markdown' ? 'md' : 'json'}`;
}
