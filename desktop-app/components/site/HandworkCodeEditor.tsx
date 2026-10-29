"use client";
import { useEffect, useRef } from 'react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { editorHighlightStyle, languageForPath } from '@/lib/editor-language';

/** The editor's look, drawn from the app's tokens so it sits in the panel like native UI. */
const chrome = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--handwork-code-font-size, 13px)', color: 'var(--_syntax-plain)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--hui-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', lineHeight: '1.6', overscrollBehavior: 'contain' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--hui-color-foreground-base-primary)' },
  '.cm-line': { padding: '0 16px 0 6px' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--hui-color-foreground-base-tertiary)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 14px', minWidth: '28px', fontVariantNumeric: 'tabular-nums' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--hui-color-foreground-base-secondary)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-base-primary) 3.5%, transparent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-info-primary, #3b7be0) 22%, transparent) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--hui-color-foreground-base-primary)', borderLeftWidth: '1.5px' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-base-primary) 10%, transparent)', outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-warning-primary, #b46b12) 14%, transparent)' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', color: 'var(--hui-color-foreground-base-tertiary)' },
  '.cm-panels': { backgroundColor: 'var(--hw-raised, var(--hui-color-background-base-primary))', color: 'inherit', borderTop: '1px solid var(--hw-hairline)' },
  '.cm-panels.cm-panels-top': { borderTop: 'none', borderBottom: '1px solid var(--hw-hairline)' },
  '.cm-search': { fontFamily: 'inherit', fontSize: '12px', padding: '6px 8px' },
  '.cm-search input, .cm-search button': { fontFamily: 'inherit', fontSize: '12px', borderRadius: '6px' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-warning-primary, #b46b12) 22%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-warning-primary, #b46b12) 40%, transparent)' },
});

function baseExtensions(onChange: (text: string) => void, onSave: () => void, language: Compartment, readOnly: Compartment, editable: boolean): Extension[] {
  return [
    lineNumbers(), highlightActiveLineGutter(), foldGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(editorHighlightStyle, { fallback: true }),
    bracketMatching(), closeBrackets(), rectangularSelection(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
    keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true; } }, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()); }),
    language.of([]), readOnly.of(EditorState.readOnly.of(!editable)), chrome,
  ];
}

/**
 * One CodeMirror view for the workbench. Switching files swaps in that file's
 * saved editor state, so each keeps its own undo history, cursor and scroll.
 */
export function HandworkCodeEditor({ path, text, editable, states, onChange, onSave }: {
  path: string; text: string; editable: boolean;
  /** Editor states by path, owned by the caller so they outlive tab switches. */
  states: Map<string, EditorState>;
  onChange: (path: string, text: string) => void; onSave: (path: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(path);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };
  const compartments = useRef({ language: new Compartment(), readOnly: new Compartment() });

  const stateFor = (file: string, doc: string, canEdit: boolean) => {
    const saved = states.get(file);
    if (saved && saved.doc.toString() === doc) return saved;
    const { language, readOnly } = compartments.current;
    return EditorState.create({ doc, extensions: baseExtensions(next => handlers.current.onChange(current.current, next), () => handlers.current.onSave(current.current), language, readOnly, canEdit) });
  };

  useEffect(() => {
    if (!host.current) return;
    view.current = new EditorView({ parent: host.current, state: stateFor(path, text, editable) });
    return () => { if (view.current) states.set(current.current, view.current.state); view.current?.destroy(); view.current = null; };
    // The view is created once; file switches are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch files: keep the outgoing file's state, bring in the incoming one's.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (current.current !== path) {
      states.set(current.current, editor.state);
      current.current = path;
      editor.setState(stateFor(path, text, editable));
    } else if (editor.state.doc.toString() !== text) {
      // The text was replaced from outside (reloaded from disk): take it, keeping undo.
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
    }
    editor.dispatch({ effects: compartments.current.readOnly.reconfigure(EditorState.readOnly.of(!editable)) });
    let live = true;
    void languageForPath(path).then(language => { if (live && view.current && current.current === path) view.current.dispatch({ effects: compartments.current.language.reconfigure(language ?? []) }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, text, editable]);

  return <div ref={host} className="handwork-code-editor honest-syntax" data-path={path} />;
}
