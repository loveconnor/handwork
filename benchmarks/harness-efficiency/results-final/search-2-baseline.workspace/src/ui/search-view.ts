import type { SearchController, SearchState } from '../search/controller.ts';

export interface SearchElements {
  input: HTMLInputElement;
  results: HTMLElement;
  loading: HTMLElement;
  error: HTMLElement;
}

export function mountSearchView(controller: SearchController, elements: SearchElements): () => void {
  const render = (state: SearchState): void => {
    elements.results.textContent = state.results.map(result => result.title).join('\n');
    elements.loading.hidden = !state.loading;
    elements.error.textContent = state.error ?? '';
    elements.error.hidden = state.error === null;
  };
  const onInput = (): void => { void controller.search(elements.input.value); };
  elements.input.addEventListener('input', onInput);
  const unsubscribe = controller.subscribe(render);
  return () => {
    elements.input.removeEventListener('input', onInput);
    unsubscribe();
  };
}
