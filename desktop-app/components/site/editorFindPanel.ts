import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, setSearchQuery } from '@codemirror/search';

/** Counting stops here, so a broad search in a huge file stays instant. */
const COUNT_LIMIT = 9999;

const paths = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  expand: '<path d="m9 18 6-6-6-6"/>',
};
const icon = (name: keyof typeof paths) => {
  const span = document.createElement('span');
  span.className = 'handwork-code-find-icon';
  span.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  return span;
};
function element<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string>, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}
const button = (label: string, content: Node | string, className = 'handwork-code-find-button') =>
  element('button', { type: 'button', class: className, 'aria-label': label, title: label }, content);

function count(state: EditorState, query: SearchQuery) {
  if (!query.search || !query.valid) return { index: 0, total: 0 };
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0, index = 0;
  for (let next = cursor.next(); !next.done && total < COUNT_LIMIT; next = cursor.next()) {
    total++;
    if (next.value.from === from && next.value.to === to) index = total;
  }
  return { index, total };
}

/**
 * A floating find bar in the app's own controls, replacing CodeMirror's form:
 * one field with its options inside it, a match count, and replace on demand.
 */
export function findPanel(view: EditorView): Panel {
  let query = getSearchQuery(view.state);
  const editable = !view.state.readOnly;

  const find = element('input', { class: 'handwork-code-find-input', placeholder: 'Find', 'aria-label': 'Find', 'main-field': 'true', spellcheck: 'false', autocomplete: 'off' });
  const replace = element('input', { class: 'handwork-code-find-input', placeholder: 'Replace', 'aria-label': 'Replace', spellcheck: 'false', autocomplete: 'off' });
  const status = element('span', { class: 'handwork-code-find-count', 'aria-live': 'polite' });
  const option = (label: string, glyph: string, key: 'caseSensitive' | 'regexp' | 'wholeWord') => {
    const toggle = button(label, glyph, 'handwork-code-find-option');
    toggle.dataset.option = key;
    toggle.addEventListener('mousedown', event => event.preventDefault());
    toggle.addEventListener('click', () => commit({ [key]: !query[key] }));
    return toggle;
  };
  const caseToggle = option('Match case', 'Aa', 'caseSensitive');
  const wordToggle = option('Whole word', 'ab', 'wholeWord');
  const regexToggle = option('Regular expression', '.*', 'regexp');

  const previous = button('Previous match (Shift+Enter)', icon('up'));
  const next = button('Next match (Enter)', icon('down'));
  const close = button('Close (Escape)', icon('close'));
  previous.addEventListener('click', () => findPrevious(view));
  next.addEventListener('click', () => findNext(view));
  close.addEventListener('click', () => closeSearchPanel(view));

  const findField = element('div', { class: 'handwork-code-find-field' }, icon('search'), find, status, caseToggle, wordToggle, regexToggle);
  findField.addEventListener('mousedown', event => { if (event.target === findField) { event.preventDefault(); find.focus(); } });
  const findRow = element('div', { class: 'handwork-code-find-row' }, findField, previous, next, close);
  const dom = element('div', { class: 'handwork-code-find', role: 'search' });

  let expander: HTMLButtonElement | undefined;
  let replaceRow: HTMLDivElement | undefined;
  if (editable) {
    expander = button('Toggle replace', icon('expand'), 'handwork-code-find-button handwork-code-find-expand');
    expander.addEventListener('click', () => setReplaceOpen(dom.dataset.replace === undefined, true));
    const one = button('Replace (Enter)', 'Replace', 'handwork-code-find-text');
    const all = button('Replace all', 'All', 'handwork-code-find-text');
    one.addEventListener('click', () => replaceNext(view));
    all.addEventListener('click', () => replaceAll(view));
    replaceRow = element('div', { class: 'handwork-code-find-row' }, element('div', { class: 'handwork-code-find-field' }, replace), one, all);
    findRow.prepend(expander);
    dom.append(findRow, replaceRow);
  } else dom.append(findRow);

  function setReplaceOpen(open: boolean, focus = false) {
    if (!expander || !replaceRow) return;
    if (open) dom.dataset.replace = ''; else delete dom.dataset.replace;
    expander.setAttribute('aria-expanded', String(open));
    replaceRow.hidden = !open;
    if (focus) (open ? replace : find).focus();
  }

  function render(state: EditorState) {
    if (find.value !== query.search) find.value = query.search;
    if (replace.value !== query.replace) replace.value = query.replace;
    for (const toggle of [caseToggle, wordToggle, regexToggle]) toggle.setAttribute('aria-pressed', String(query[toggle.dataset.option as 'caseSensitive']));
    const { index, total } = count(state, query);
    if (query.search && (!query.valid || total === 0)) findField.dataset.invalid = ''; else delete findField.dataset.invalid;
    status.textContent = !query.search ? '' : !query.valid ? 'Invalid' : total === 0 ? 'No results' : `${index || '–'} of ${total >= COUNT_LIMIT ? `${COUNT_LIMIT}+` : total}`;
    previous.disabled = next.disabled = total === 0;
  }

  function commit(change: Partial<{ search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }> = {}) {
    const updated = new SearchQuery({ search: find.value, replace: replace.value, caseSensitive: query.caseSensitive, regexp: query.regexp, wholeWord: query.wholeWord, ...change });
    if (updated.eq(query)) return;
    query = updated;
    view.dispatch({ effects: setSearchQuery.of(updated) });
  }

  find.addEventListener('input', () => commit());
  replace.addEventListener('input', () => commit());
  dom.addEventListener('keydown', event => {
    if (runScopeHandlers(view, event, 'search-panel')) { event.preventDefault(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.target === find) (event.shiftKey ? findPrevious : findNext)(view);
    else if (event.target === replace) ((event.metaKey || event.ctrlKey) && event.altKey ? replaceAll : replaceNext)(view);
  });

  setReplaceOpen(!!query.replace);
  render(view.state);
  return {
    dom,
    top: true,
    mount: () => find.select(),
    update(update: ViewUpdate) {
      let changed = update.docChanged || update.selectionSet;
      for (const transaction of update.transactions) for (const effect of transaction.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(query)) query = effect.value;
        if (effect.is(setSearchQuery)) changed = true;
      }
      if (changed) render(update.state);
    },
  };
}
