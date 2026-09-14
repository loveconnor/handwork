export interface Cache {
  get(key:string): unknown;
  set(key:string,value:unknown): void;
  delete(key:string): void;
  keys(): string[];
}
export function createCache() {
  const entries=new Map<string,unknown>();
  const metrics={hits:0,misses:0,writes:0,deletes:0};
  return {
    metrics,
    get(key:string){if(entries.has(key)){metrics.hits++;return structuredClone(entries.get(key));}metrics.misses++;return undefined;},
    set(key:string,value:unknown){metrics.writes++;entries.set(key,structuredClone(value));},
    delete(key:string){metrics.deletes++;entries.delete(key);},
    keys(){return [...entries.keys()];},
  };
}
