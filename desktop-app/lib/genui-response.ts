// Older replies can contain a bare program. Only recover replies that begin
// with the GenUI root; fenced code examples and ordinary prose stay Markdown.
export function bareGenuiSource(text: string): string | null {
  const source = text.trim();
  return /^root\s*=\s*Stack\s*\(/.test(source) && !/^\s*(?:`{3,}|~{3,})/m.test(source) ? source : null;
}
