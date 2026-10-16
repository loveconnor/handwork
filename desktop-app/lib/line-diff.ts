// Minimal line diff (LCS) for ToolChips diff previews. Renderer-only; caps work for large files.
export type DiffLine = { text: string; tone: "add" | "del" | "ctx" };
export type LineDiff = { add: number; del: number; lines: DiffLine[] };
const MAX_LINES = 400;
const MAX_PREVIEW = 60;

export function lineDiff(oldText: string, newText: string): LineDiff {
  const a = oldText ? oldText.split("\n").slice(0, MAX_LINES) : [];
  const b = newText ? newText.split("\n").slice(0, MAX_LINES) : [];
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const lines: DiffLine[] = [];
  let add = 0, del = 0, i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ text: a[i], tone: "ctx" }); i++; j++; }
    else if (j < b.length && (i >= a.length || table[i][j + 1] > table[i + 1][j])) { lines.push({ text: b[j], tone: "add" }); add++; j++; }
    else { lines.push({ text: a[i], tone: "del" }); del++; i++; }
  }
  // Preview keeps changed lines and one line of context around them.
  const keep = lines.map((line, index) => line.tone !== "ctx" || lines[index - 1]?.tone !== "ctx" && index > 0 || lines[index + 1]?.tone !== "ctx" && index + 1 < lines.length);
  const preview = lines.filter((_, index) => keep[index]).slice(0, MAX_PREVIEW);
  if (lines.filter((_, index) => keep[index]).length > MAX_PREVIEW) preview.push({ text: "…", tone: "ctx" });
  return { add, del, lines: preview };
}
