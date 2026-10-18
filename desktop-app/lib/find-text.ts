/** Match folded text while keeping offsets in the original UTF-16 string for DOM Ranges. */
export function findTextMatches(text: string, query: string, limit = 2000): { start: number; end: number }[] {
  const needle = query.toLowerCase();
  if (!needle || limit <= 0) return [];
  const lower = text.toLowerCase();
  let index = lower.indexOf(needle);
  if (index < 0) return [];

  // Default Unicode lowercasing only changes UTF-16 length through expansion.
  // Most text needs no mapping. Otherwise walk only as far as matched boundaries,
  // without allocating offset arrays for the entire document.
  const needsMapping = lower.length !== text.length;
  let originalOffset = 0;
  let foldedOffset = 0;
  const originalBoundary = (boundary: number, isEnd: boolean): number => {
    if (!needsMapping) return boundary;
    while (originalOffset < text.length) {
      const character = String.fromCodePoint(text.codePointAt(originalOffset)!);
      const foldedLength = character.toLowerCase().length;
      if (foldedOffset + foldedLength > boundary) {
        if (foldedLength === character.length) return originalOffset + boundary - foldedOffset;
        // A boundary inside İ's i + combining dot covers the original İ.
        return originalOffset + (isEnd && boundary > foldedOffset ? character.length : 0);
      }
      originalOffset += character.length;
      foldedOffset += foldedLength;
    }
    return originalOffset;
  };
  const matches = [];
  for (; index >= 0 && matches.length < limit; index = lower.indexOf(needle, index + needle.length)) {
    const start = originalBoundary(index, false);
    const end = originalBoundary(index + needle.length, true);
    if (!matches.length || start >= matches[matches.length - 1].end) matches.push({ start, end });
  }
  return matches;
}
