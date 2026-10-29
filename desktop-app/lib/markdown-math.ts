import { normalizeMathDelimiters } from 'honestui/ai/markdown-math';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)[\s\S]*?\1/g;
// `$x^2$` reads as math; `$5 and $10` does not, because the content would end in a space,
// and `$5-$10` does not, because a digit follows the closing dollar.
const INLINE_DOLLAR = /(?<![\\$\w])\$(?![\s$])([^$\n]{1,400}?)(?<![\s\\])\$(?![\w$])/g;
const LOOKS_NUMERIC = /^[\d\s.,%-]*$/;

function inlineDollars(prose: string): string {
  return prose.replace(INLINE_DOLLAR, (whole, math: string) => LOOKS_NUMERIC.test(math) ? whole : `$$${math}$$`);
}

/** Applies `transform` to prose only, leaving fenced and inline code untouched. */
function outsideCode(source: string, transform: (prose: string) => string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let fence: string | undefined;
  let prose: string[] = [];
  const flush = () => {
    if (!prose.length) return;
    const text = prose.join('\n');
    let result = ''; let offset = 0;
    for (const match of text.matchAll(INLINE_CODE)) {
      result += transform(text.slice(offset, match.index)) + match[0];
      offset = match.index + match[0].length;
    }
    out.push(result + transform(text.slice(offset)));
    prose = [];
  };
  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) { out.push(line); if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; continue; }
    if (marker) { flush(); fence = marker; out.push(line); continue; }
    prose.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * Prepares a reply for the math plugins: LaTeX delimiters become `$$`, single-dollar
 * math is recognised conservatively, and while streaming an unclosed `$$` stays text
 * so a half-written equation does not flash as an error.
 */
export function prepareMath(source: string, streaming = false): string {
  if (!/[$\\]/.test(source)) return source;
  let text = outsideCode(normalizeMathDelimiters(source), inlineDollars);
  if (streaming) {
    const opens = [...outsideCode(text, prose => prose.replace(/\$\$/g, '\u0000')).matchAll(/\u0000/g)];
    if (opens.length % 2 === 1) {
      // Escape only the last, unclosed `$$` that sits outside code.
      let seen = 0;
      text = outsideCode(text, prose => prose.replace(/\$\$/g, match => ++seen === opens.length ? '\\$\\$' : match));
    }
  }
  return text;
}
