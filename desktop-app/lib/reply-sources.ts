import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent, PhrasingContent, Definition } from 'mdast';

export type ReplySource = { href: string; title: string; domain: string };

export function sourceUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value || '');
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const parser = unified().use(remarkParse).use(remarkGfm);
function label(node: RootContent | PhrasingContent): string {
  if ('value' in node) return node.value;
  if ('children' in node) return node.children.map(child => label(child)).join('');
  return '';
}

/** Read links from Markdown, leaving code, prose, and the original URLs intact. */
export function replySources(text: string): { markdown: string; sources: ReplySource[] } {
  const root = parser.parse(text) as Root;
  const definitions = new Map<string, Definition>();
  for (const node of root.children) if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node);
  const sources = new Map<string, ReplySource>();
  function link(node: RootContent | PhrasingContent): ReplySource | null {
    const raw = node.type === 'link' ? node.url : node.type === 'linkReference' ? definitions.get(node.identifier.toLowerCase())?.url : undefined;
    const href = sourceUrl(raw);
    if (!href) return null;
    const domain = new URL(href).hostname.replace(/^www\./, '');
    const title = label(node).trim();
    return { href, domain, title: !title || sourceUrl(title) ? domain : title };
  }
  function visit(node: RootContent | PhrasingContent) {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') return;
    const source = link(node);
    if (source && !sources.has(source.href)) sources.set(source.href, source);
    if ('children' in node) for (const child of node.children) visit(child);
  }
  for (const node of root.children) visit(node);
  // Replace standalone source lists, but keep any descriptions or other prose.
  const removed: [number, number][] = [];
  for (let index = 0; index < root.children.length - 1; index++) {
    const heading = root.children[index];
    const list = root.children[index + 1];
    if (!['heading', 'paragraph'].includes(heading.type) || !/^sources?:?$/i.test(label(heading).trim()) || list.type !== 'list') continue;
    const onlyLinks = list.children.every(item => item.children.length === 1 && item.children[0].type === 'paragraph' &&
      item.children[0].children.some(child => !!link(child)) && item.children[0].children.every(child =>
        !!link(child) || (child.type === 'text' && /^[\s,;:.()[\]\d-]*$/.test(child.value))));
    const start = heading.position?.start.offset;
    const end = list.position?.end.offset;
    if (onlyLinks && start !== undefined && end !== undefined) removed.push([start, end]);
  }
  let markdown = text;
  for (const [start, end] of removed.reverse()) markdown = markdown.slice(0, start) + markdown.slice(end);
  return { markdown: markdown.trim(), sources: [...sources.values()] };
}
