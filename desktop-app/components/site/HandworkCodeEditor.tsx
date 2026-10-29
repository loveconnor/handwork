"use client";
import { useEffect, useRef } from 'react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, type CompletionContext } from '@codemirror/autocomplete';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { editorHighlightStyle, languageForPath } from '@/lib/editor-language';
import { findPanel } from './editorFindPanel';
import { editorLint } from './editorLint';
import { gitGutter, hasGitBase, setGitBase } from './editorGitGutter';

/** The editor's look, drawn from the app's tokens so it sits in the panel like native UI. */
const chrome = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--handwork-code-font-size, 13px)', color: 'var(--_syntax-plain)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--hui-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', lineHeight: '1.6', overscrollBehavior: 'contain' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--hui-color-foreground-base-primary)' },
  '.cm-line': { padding: '0 16px 0 6px' },
  // Opaque so code scrolled sideways passes under the line numbers, not through them.
  '.cm-gutters': { backgroundColor: 'var(--hw-panel, var(--hui-color-background-base-primary))', border: 'none', color: 'var(--hui-color-foreground-base-tertiary)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 14px', minWidth: '28px', fontVariantNumeric: 'tabular-nums' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--hui-color-foreground-base-secondary)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-base-primary) 3.5%, transparent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-info-primary, #3b7be0) 22%, transparent) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--hui-color-foreground-base-primary)', borderLeftWidth: '1.5px' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-base-primary) 10%, transparent)', outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-warning-primary, #b46b12) 14%, transparent)' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', color: 'var(--hui-color-foreground-base-tertiary)' },
  // The find bar floats over the top-right of the code instead of pushing it down.
  '.cm-panels': { backgroundColor: 'transparent', color: 'inherit', border: 'none' },
  '.cm-panels.cm-panels-top': { position: 'absolute', top: '8px', right: '14px', left: '14px', zIndex: 300, display: 'flex', justifyContent: 'flex-end', border: 'none', pointerEvents: 'none' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-warning-primary, #b46b12) 22%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--hui-color-foreground-warning-primary, #b46b12) 40%, transparent)' },
  // Suggestions and lint messages float like the app's own menus.
  '.cm-tooltip': { border: '0.5px solid var(--hui-color-border-base-primary)', borderRadius: '8px', backgroundColor: 'var(--hui-color-background-base-primary)', color: 'var(--hui-color-foreground-base-primary)', boxShadow: 'var(--hui-shadow-soft)', overflow: 'hidden' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { padding: '4px', maxHeight: '15em', fontFamily: 'var(--hui-font-family-mono, ui-monospace, monospace)', fontSize: '12.5px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', borderRadius: '5px', lineHeight: '1.5' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--hw-selected, var(--hui-color-background-base-primary-hover))', color: 'var(--hui-color-foreground-base-primary)' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
  '.cm-completionIcon': { opacity: '0.55', width: '1.4em' },
  '.cm-completionDetail': { color: 'var(--hui-color-foreground-base-tertiary)', fontStyle: 'normal' },
  // Language server docs, signatures, references and the rename field, in the app's type and colours.
  '.cm-tooltip-hover, .cm-lsp-signature-tooltip': { maxWidth: 'min(560px, 80vw)', maxHeight: '320px', overflow: 'auto', fontSize: '12.5px', lineHeight: '1.5' },
  '.cm-lsp-documentation': { padding: '6px 10px', fontFamily: 'var(--hui-font-family-sans, inherit)' },
  '.cm-lsp-documentation pre, .cm-lsp-documentation code': { fontFamily: 'var(--hui-font-family-mono, ui-monospace, monospace)', fontSize: '12px' },
  '.cm-lsp-documentation pre': { margin: '4px 0', whiteSpace: 'pre-wrap' },
  '.cm-lsp-documentation p': { margin: '4px 0' },
  '.cm-lsp-documentation hr': { border: 'none', borderTop: '1px solid var(--hui-color-border-base-primary)', margin: '6px -10px' },
  '.cm-lsp-documentation a': { color: 'var(--hui-color-foreground-info-primary, inherit)' },
  '.cm-lsp-active-parameter': { fontWeight: '600', textDecoration: 'underline' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--hw-hairline, var(--hui-color-border-base-primary))', backgroundColor: 'var(--hw-panel, var(--hui-color-background-base-primary))' },
  '.cm-lsp-reference-panel': { maxHeight: '180px', overflow: 'auto', fontSize: '12px', fontFamily: 'var(--hui-font-family-mono, ui-monospace, monospace)' },
  '.cm-lsp-reference-panel > b': { display: 'block', padding: '6px 12px 2px', fontFamily: 'var(--hui-font-family-sans, inherit)', fontWeight: '500', color: 'var(--hui-color-foreground-base-secondary)' },
  '.cm-lsp-reference-panel li[aria-selected]': { backgroundColor: 'var(--hw-selected, var(--hui-color-background-base-primary-hover))' },
  '.cm-lsp-rename-panel, .cm-lsp-message': { pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderRadius: '8px', border: '0.5px solid var(--hui-color-border-base-primary)', backgroundColor: 'var(--hui-color-background-base-primary)', boxShadow: 'var(--hui-shadow-soft)', fontSize: '12.5px' },
  '.cm-lsp-rename-panel input': { height: '24px', padding: '0 6px', border: '1px solid var(--hw-field-focus, var(--hui-color-border-base-primary))', borderRadius: '5px', background: 'transparent', color: 'inherit', font: 'inherit', fontFamily: 'var(--hui-font-family-mono, ui-monospace, monospace)', outline: 'none' },
  '.cm-lsp-rename-panel button, .cm-lsp-message button': { height: '24px', padding: '0 8px', border: '0.5px solid var(--hui-color-border-base-primary)', borderRadius: '5px', background: 'transparent', color: 'inherit', font: 'inherit' },
  '.cm-lsp-message-error': { color: 'var(--hui-color-foreground-danger-primary)' },
});

/** Words already in the file are offered where the language has no suggestions of its own, which would repeat them. */
const wordCompletions = EditorState.languageData.of(() => [{
  autocomplete: (context: CompletionContext) => context.state.languageDataAt('autocomplete', context.pos).length > 1 ? null : completeAnyWord(context),
}]);

function baseExtensions(onChange: (text: string) => void, onSave: () => void, language: Compartment, support: Compartment, readOnly: Compartment, editable: boolean): Extension[] {
  return [
    lineNumbers(), gitGutter(), highlightActiveLineGutter(), foldGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(editorHighlightStyle, { fallback: true }),
    bracketMatching(), closeBrackets(), autocompletion({ activateOnTyping: true }), wordCompletions, rectangularSelection(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true, createPanel: findPanel }),
    keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true; } }, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()); }),
    language.of([]), support.of([]), readOnly.of(EditorState.readOnly.of(!editable)), chrome,
  ];
}

/**
 * One CodeMirror view for the workbench. Switching files swaps in that file's
 * saved editor state, so each keeps its own undo history, cursor and scroll.
 */
export type EditorReveal = { line: number; column?: number; length?: number; token: number };

export function HandworkCodeEditor({ path, text, editable, states, base, reveal, onRevealed, support, supportVersion, onChange, onSave }: {
  path: string; text: string; editable: boolean;
  /** Language features for a file beyond highlighting: its language server, or a syntax check. */
  support?: (path: string) => Promise<Extension>;
  /** Changes when `support` has new answers, such as after a language server restarts. */
  supportVersion?: number;
  /** The file as last staged in git, for the change bars; null when untracked, undefined while unknown. */
  base?: string | null;
  /** Move the cursor here and scroll it into view; a new token asks again. */
  reveal?: EditorReveal; onRevealed?: () => void;
  /** Editor states by path, owned by the caller so they outlive tab switches. */
  states: Map<string, EditorState>;
  onChange: (path: string, text: string) => void; onSave: (path: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(path);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };
  const compartments = useRef({ language: new Compartment(), support: new Compartment(), readOnly: new Compartment() });

  const stateFor = (file: string, doc: string, canEdit: boolean) => {
    const saved = states.get(file);
    if (saved && saved.doc.toString() === doc) return saved;
    const { language, support, readOnly } = compartments.current;
    return EditorState.create({ doc, extensions: baseExtensions(next => handlers.current.onChange(current.current, next), () => handlers.current.onSave(current.current), language, support, readOnly, canEdit) });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, text, editable]);

  // The file's language and its language server arrive after async loads; a keystroke does not reload them.
  useEffect(() => {
    let live = true;
    const apply = (compartment: Compartment, extension: Extension) => {
      const editor = view.current;
      if (live && editor && current.current === path && compartment.get(editor.state) !== extension) editor.dispatch({ effects: compartment.reconfigure(extension) });
    };
    void languageForPath(path).then(language => apply(compartments.current.language, language ?? []));
    void (support ? support(path) : Promise.resolve(editorLint(path))).then(extension => apply(compartments.current.support, extension)).catch(() => apply(compartments.current.support, editorLint(path)));
    return () => { live = false; };
  }, [path, support, supportVersion]);

  useEffect(() => {
    const editor = view.current;
    if (editor && base !== undefined && !hasGitBase(editor.state, base)) editor.dispatch({ effects: setGitBase.of(base) });
  }, [path, base]);

  const revealed = useRef<number | null>(null);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !reveal || revealed.current === reveal.token) return;
    revealed.current = reveal.token;
    const doc = editor.state.doc;
    const line = doc.line(Math.min(Math.max(1, reveal.line), doc.lines));
    const from = Math.min(line.to, line.from + Math.max(0, (reveal.column ?? 1) - 1));
    const to = Math.min(line.to, from + (reveal.length ?? 0));
    editor.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    editor.focus();
    onRevealed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reveal]);

  return <div ref={host} className="handwork-code-editor honest-syntax" data-path={path} />;
}
