export function paginate<T>(items: readonly T[], page: number, pageSize: number): T[] {
  if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be a positive integer');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer');
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, items.length);
  return items.slice(start, end);
}
