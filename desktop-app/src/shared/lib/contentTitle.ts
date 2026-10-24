const MAX_TITLE = 200;
export function contentTitle(text: string): string {
  const heading = text.match(/^\s{0,3}#{1,6}\s+(.+)$/m);
  if (heading) {
    const title = unwrapMarkdown(heading[1]).slice(0, MAX_TITLE);
    if (title) return title;
  }
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") continue;
    const title = unwrapMarkdown(trimmed).slice(0, MAX_TITLE);
    if (title) return title;
  }
  return "Untitled";
}
function unwrapMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .trim();
}
