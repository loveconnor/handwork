export type ConfigChange = readonly [id: string, value: string];

/** Enqueue an entire provider/model selection before a send can capture the tail. */
export function queueConfiguration<T>(previous: Promise<unknown>, changes: readonly ConfigChange[], apply: (id: string, value: string) => Promise<T>): Promise<T[]> {
  return previous.then(async () => {
    const results: T[] = [];
    for (const [id, value] of changes) results.push(await apply(id, value));
    return results;
  });
}
