export interface SearchResult {
  id: string;
  title: string;
  url: string;
}

export interface SearchApi {
  search(query: string): Promise<SearchResult[]>;
}

export function createSearchApi(fetcher: typeof fetch = globalThis.fetch): SearchApi {
  return {
    async search(query) {
      const response = await fetcher(`/api/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error(`Search request failed (${response.status})`);
      const payload = await response.json() as { items: SearchResult[] };
      return payload.items;
    },
  };
}
