import type { LanguageServerKind } from './desktop-api';

/** Which language server reads a file, and the LSP language ID it is opened as. */
export function languageServerFor(path: string): { kind: LanguageServerKind; languageId: string } | null {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  switch (extension) {
    case '.ts': case '.mts': case '.cts': return { kind: 'typescript', languageId: 'typescript' };
    case '.tsx': return { kind: 'typescript', languageId: 'typescriptreact' };
    case '.js': case '.mjs': case '.cjs': return { kind: 'typescript', languageId: 'javascript' };
    case '.jsx': return { kind: 'typescript', languageId: 'javascriptreact' };
    case '.py': case '.pyi': return { kind: 'python', languageId: 'python' };
    case '.rs': return { kind: 'rust', languageId: 'rust' };
    case '.go': return { kind: 'go', languageId: 'go' };
    case '.c': case '.h': return { kind: 'c', languageId: 'c' };
    case '.cc': case '.cpp': case '.cxx': case '.hh': case '.hpp': case '.hxx': return { kind: 'c', languageId: 'cpp' };
    case '.m': return { kind: 'c', languageId: 'objective-c' };
    case '.mm': return { kind: 'c', languageId: 'objective-cpp' };
    case '.swift': return { kind: 'swift', languageId: 'swift' };
    default: return null;
  }
}

const windowsPath = (path: string) => /^[a-zA-Z]:[\\/]/.test(path);

/** A file URI for an absolute path, encoded the way language servers write them. */
export function fileUri(absolute: string): string {
  const slashed = absolute.replace(/\\/g, '/');
  const encoded = slashed.split('/').map((part, index) => index === 0 && /^[a-zA-Z]:$/.test(part) ? part : encodeURIComponent(part)).join('/');
  return `file://${windowsPath(absolute) ? '/' : ''}${encoded}`;
}

/** Servers differ in how they encode a URI (drive letter case, `%3A`); compare them decoded. */
export function uriKey(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  let path = decodeURIComponent(uri.slice('file://'.length).replace(/^localhost/, ''));
  if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1, 2).toLowerCase() + path.slice(2);
  return path;
}

/** The project-relative path a URI names, or null when it is outside the project. */
export function projectPath(uri: string, workspace: string): string | null {
  const file = uriKey(uri);
  const root = uriKey(fileUri(workspace.replace(/[\\/]+$/, '')));
  if (!file.startsWith('/') && !/^[a-z]:/.test(file)) return null;
  // Windows paths compare without case, as the filesystem does.
  const caseless = /^[a-z]:/.test(root);
  if (!(caseless ? file.toLowerCase().startsWith(`${root.toLowerCase()}/`) : file.startsWith(`${root}/`))) return null;
  const relative = file.slice(root.length + 1);
  return relative.split('/').some(part => !part || part === '.' || part === '..') ? null : relative;
}

export type TextEdit = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };

/** Apply LSP text edits to plain text. Positions count UTF-16 units, as JavaScript strings do. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  const offset = ({ line, character }: { line: number; character: number }) => {
    if (line >= starts.length) return text.length;
    const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
    return Math.min(starts[line] + character, lineEnd);
  };
  // Applied from the end, each edit leaves the offsets of the ones before it alone.
  const ordered = edits.map(edit => ({ from: offset(edit.range.start), to: offset(edit.range.end), insert: edit.newText })).sort((a, b) => b.from - a.from || b.to - a.to);
  let result = text;
  for (const { from, to, insert } of ordered) result = result.slice(0, from) + insert + result.slice(to);
  return result;
}

type WorkspaceEdit = {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: ({ textDocument: { uri: string }; edits: (TextEdit | { annotationId?: string } & TextEdit)[] } | { kind: string })[];
};
/** The text edits of a workspace edit by URI; creating, renaming and deleting files are left out. */
export function editsByUri(edit: WorkspaceEdit | null | undefined): Map<string, TextEdit[]> {
  const result = new Map<string, TextEdit[]>();
  for (const change of edit?.documentChanges ?? []) if ('textDocument' in change) result.set(change.textDocument.uri, [...(result.get(change.textDocument.uri) ?? []), ...change.edits]);
  if (!edit?.documentChanges) for (const [uri, edits] of Object.entries(edit?.changes ?? {})) result.set(uri, edits);
  return result;
}

const ALLOWED_TAGS = new Set(['P', 'PRE', 'CODE', 'A', 'EM', 'STRONG', 'B', 'I', 'UL', 'OL', 'LI', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'SPAN', 'DIV', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DEL', 'S', 'SUB', 'SUP', 'KBD']);
/** Hover and completion docs arrive as Markdown, which may hold HTML; keep only plain formatting. */
export function sanitizeDocs(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const clean = (node: Element) => {
    for (const child of [...node.children]) {
      if (!ALLOWED_TAGS.has(child.tagName)) { child.replaceWith(...(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(child.tagName) ? [] : [...child.childNodes])); continue; }
      for (const attribute of [...child.attributes]) {
        const keep = attribute.name === 'class' || (attribute.name === 'href' && child.tagName === 'A' && /^https?:/i.test(attribute.value));
        if (!keep) child.removeAttribute(attribute.name);
      }
      clean(child);
    }
  };
  // Unwrapping can surface children that need checking too, so repeat until nothing changes.
  for (let previous = ''; previous !== template.innerHTML;) { previous = template.innerHTML; clean(template.content as unknown as Element); }
  return template.innerHTML;
}

/** A line trimmed around a match, as project search previews are, with where the match starts in it. */
export function matchPreview(line: string, character: number): { preview: string; offset: number } {
  const start = Math.max(0, character - 60);
  return { preview: (start ? '…' : '') + line.slice(start, start + 240), offset: character - start + (start ? 1 : 0) };
}
