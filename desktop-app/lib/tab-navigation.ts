/** The tab to show after moving `step` tabs from the current one, wrapping around. */
export function adjacentTab<T extends { id: string }>(tabs: T[], current: string, step: 1 | -1): T | undefined {
  if (!tabs.length) return undefined;
  const index = tabs.findIndex(tab => tab.id === current);
  if (index < 0) return tabs[step === 1 ? 0 : tabs.length - 1];
  return tabs[(index + step + tabs.length) % tabs.length];
}

/** Mod+1 to Mod+8 pick that tab; Mod+9 always picks the last, as in browsers. */
export function numberedTab<T>(tabs: T[], digit: number): T | undefined {
  if (digit < 1 || digit > 9 || !tabs.length) return undefined;
  return digit === 9 ? tabs.at(-1) : tabs[digit - 1];
}

/** Recently closed tabs, newest last. A chat closed twice is remembered once. */
export function rememberClosed<T extends { id: string }>(closed: T[], tab: T, limit = 20): T[] {
  return [...closed.filter(item => item.id !== tab.id), tab].slice(-limit);
}

/** The most recently closed tab that is not open again and still exists. */
export function reopenCandidate<T extends { id: string }>(closed: T[], open: string[], exists: (id: string) => boolean): { tab?: T; rest: T[] } {
  const rest = closed.filter(item => !open.includes(item.id) && exists(item.id));
  return { tab: rest.at(-1), rest: rest.slice(0, -1) };
}
