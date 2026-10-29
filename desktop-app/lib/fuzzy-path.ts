/**
 * Quick-open matching: the query's characters must appear in the path in
 * order. Matches in the file name, at word starts and in runs score higher,
 * so `wbl` finds `lib/workbench-layout.ts` ahead of a path that merely
 * contains those letters somewhere.
 */
export type PathMatch = { path: string; score: number; positions: number[] };

const boundary = (path: string, index: number) => index === 0 || /[\/\-_. ]/.test(path[index - 1]) || (/[a-z]/.test(path[index - 1]) && /[A-Z]/.test(path[index]));

/** Score one run of query characters against the path, starting no earlier than `from`. */
function matchFrom(path: string, lower: string, query: string, from: number, nameStart: number): { score: number; positions: number[] } | null {
  const positions: number[] = [];
  let score = 0, at = from, previous = -2;
  for (const char of query) {
    // Prefer the next occurrence at a word boundary, else the next occurrence at all.
    let index = lower.indexOf(char, at);
    if (index < 0) return null;
    for (let probe = index; probe >= 0 && probe !== previous + 1; probe = lower.indexOf(char, probe + 1)) {
      if (boundary(path, probe)) { index = probe; break; }
    }
    score += 1;
    if (index === previous + 1) score += 4;
    if (boundary(path, index)) score += 3;
    if (index >= nameStart) score += 2;
    positions.push(index);
    previous = index;
    at = index + 1;
  }
  return { score, positions };
}

export function matchPath(path: string, query: string): PathMatch | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { path, score: 0, positions: [] };
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf('/') + 1;
  let score = 0;
  const positions: number[] = [];
  for (const term of terms) {
    // A term that fits wholly in the file name is tried there first.
    const inName = matchFrom(path, lower, term, nameStart, nameStart);
    const anywhere = matchFrom(path, lower, term, 0, nameStart);
    const best = inName && (!anywhere || inName.score >= anywhere.score) ? inName : anywhere;
    if (!best) return null;
    score += best.score;
    positions.push(...best.positions);
  }
  const name = lower.slice(nameStart);
  const joined = terms.join('');
  if (name === joined || name.startsWith(`${joined}.`)) score += 20;
  else if (name.startsWith(joined)) score += 10;
  // Between equal matches, the shallower, shorter path wins.
  score -= path.split('/').length * 0.5 + path.length * 0.01;
  return { path, score, positions: [...new Set(positions)].sort((a, b) => a - b) };
}

export function rankPaths(paths: readonly string[], query: string, limit = 100): PathMatch[] {
  const matches: PathMatch[] = [];
  for (const path of paths) {
    const match = matchPath(path, query);
    if (match) matches.push(match);
  }
  return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}
