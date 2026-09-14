import type { SearchApi, SearchResult } from '../api/search.ts';

export interface SearchState {
  query: string;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
}

export interface SearchController {
  getState(): SearchState;
  subscribe(listener: (state: SearchState) => void): () => void;
  search(query: string): Promise<void>;
}

export function createSearchController(api: SearchApi): SearchController {
  let state: SearchState = { query: '', results: [], loading: false, error: null };
  const listeners = new Set<(state: SearchState) => void>();
  const getState = (): SearchState => ({ ...state, results: [...state.results] });
  const update = (patch: Partial<SearchState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(getState());
  };

  return {
    getState,
    subscribe(listener) {
      listeners.add(listener);
      listener(getState());
      return () => { listeners.delete(listener); };
    },
    async search(query) {
      const normalized = query.trim();
      if (!normalized) {
        update({ query: '', results: [], loading: false, error: null });
        return;
      }
      update({ query: normalized, loading: true, error: null });
      try {
        const results = await api.search(normalized);
        update({ results });
      } catch (error) {
        update({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        update({ loading: false });
      }
    },
  };
}
