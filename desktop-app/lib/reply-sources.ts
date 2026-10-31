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

// Sites whose names are not their domain's spelling.
const siteNames: Record<string, string> = {
  github: 'GitHub', githubusercontent: 'GitHub', openai: 'OpenAI', chatgpt: 'ChatGPT', youtube: 'YouTube', youtu: 'YouTube',
  stackoverflow: 'Stack Overflow', stackexchange: 'Stack Exchange', npmjs: 'npm', arxiv: 'arXiv', linkedin: 'LinkedIn',
  mozilla: 'MDN', wikipedia: 'Wikipedia', huggingface: 'Hugging Face', nytimes: 'NYT', ycombinator: 'Hacker News',
};

/** A short name for a source pill: "raw.githubusercontent.com" reads as "GitHub", "kent.edu" as "Kent". */
export function siteName(domain: string): string {
  const parts = domain.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length < 2) return domain;
  // "bbc.co.uk", "abc.net.au": the name sits before a two-part suffix.
  const twoPart = parts.length > 2 && parts.at(-1)!.length === 2 && ['co', 'com', 'ac', 'gov', 'edu', 'org', 'net'].includes(parts.at(-2)!);
  const label = parts.at(twoPart ? -3 : -2)!;
  return siteNames[label] ?? (label.length <= 3 ? label.toUpperCase() : label[0].toUpperCase() + label.slice(1));
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
  // "(example.com)" around a lone source link: the link renders as a citation
  // pill, which needs no brackets of its own.
  function unwrap(node: RootContent | PhrasingContent) {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html' || !('children' in node)) return;
    const children = node.children as (RootContent | PhrasingContent)[];
    children.forEach((child, index) => {
      const before = children[index - 1], after = children[index + 1];
      if (!link(child) || before?.type !== 'text' || after?.type !== 'text' || !/\(\s*$/.test(before.value) || !/^\s*\)/.test(after.value)) return;
      const open = before.position?.end.offset, close = after.position?.start.offset;
      if (open === undefined || close === undefined) return;
      const leading = before.value.length - before.value.replace(/\(\s*$/, '').length;
      const trailing = after.value.length - after.value.replace(/^\s*\)/, '').length;
      removed.push([open - leading, open], [close, close + trailing]);
    });
    for (const child of children) unwrap(child);
  }
  for (const node of root.children) unwrap(node);
  removed.sort((a, b) => a[0] - b[0]);
  let markdown = text;
  for (const [start, end] of removed.reverse()) markdown = markdown.slice(0, start) + markdown.slice(end);
  return { markdown: markdown.trim(), sources: [...sources.values()] };
}
