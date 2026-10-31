import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { linter, type Diagnostic } from '@codemirror/lint';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * Syntax errors read straight off the parse tree the highlighter already
 * builds: Lezer leaves error nodes wherever it could not go on, which catches
 * unclosed brackets, stray quotes and malformed statements without a type
 * checker or language server.
 *
 * Highlighter grammars are not spec-complete, so known gaps (arrow type
 * predicates, typed `catch`, Tailwind at-rules) are passed over. Rust is
 * highlighted but not linted: its grammar misses `let`-`else` and attributes
 * on statements, and those holes cascade through the rest of the file.
 */
const MAX_LINT_CHARS = 512 * 1024;
/** One bad character can strand the rest of the file behind follow-on errors; the first ones are the real ones. */
const MAX_DIAGNOSTICS = 50;
const LINT_DELAY_MS = 700;
const MAX_TOKEN_CHARS = 24;
/** A full parse is timeboxed so a huge file does not hold up the editor. */
const PARSE_BUDGET_MS = 150;
/** The Lezer grammars in `languageForPath` that report errors; Markdown accepts anything. */
const LINTABLE = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.css', '.html', '.htm', '.py']);

export function isLintable(path: string) {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  return LINTABLE.has(name.includes('.') ? name.slice(name.lastIndexOf('.')) : '');
}

export function editorLint(path: string): Extension {
  if (!isLintable(path)) return [];
  return [
    linter(view => syntaxDiagnostics(view.state), {
      delay: LINT_DELAY_MS,
      // The language arrives after an async import and big files parse in chunks; neither is an edit.
      needsRefresh: update => syntaxTree(update.state) !== syntaxTree(update.startState),
    }),
    lintTheme,
  ];
}

export function syntaxDiagnostics(state: EditorState): Diagnostic[] {
  if (state.doc.length > MAX_LINT_CHARS) return [];
  // Parsing stops at the viewport and leaves an error at the frontier; finish the tree first.
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  if (tree.length === 0) return [];
  const incomplete = tree.length < state.doc.length;
  const diagnostics: Diagnostic[] = [];
  tree.iterate({
    enter: node => {
      if (!node.type.isError) return true;
      if (incomplete && node.from >= tree.length) return false;
      if (isGrammarGap(state, node.node.parent, node.from)) return false;
      if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(errorDiagnostic(state, node.from, node.to));
      // Error nodes nest; their children would mark the same typo again.
      return false;
    },
  });
  return diagnostics;
}

/** Arrow `(x): x is T =>`, including tuple predicates like `x is [K, V]`. */
const TYPE_PREDICATE = /:\s*(?:asserts\s+)?(?:this|[\w$]+)\s+is\b/;
/** `catch (error: unknown)`: Lezer's catch clause has no type annotation. */
const TYPED_CATCH = /^catch\s*\(\s*[\w$]+\s*:/;
/** Multiline JSX comments: `{` then a block comment. */
const JSX_BLOCK_COMMENT = /^\{\s*\/\*/;
/** Tailwind v4 at-rules the CSS grammar does not know. */
const TAILWIND_AT = /^@(?:source|plugin|theme|utility|custom-variant|reference|config)\b/;
/** `fn<typeof import("mod")>()`: `import(` parses as a dynamic import. */
const TYPEOF_IMPORT = /<typeof\s+import\s*\(/;

type Parent = { name: string; from: number; to: number; parent: unknown } | null;
function isGrammarGap(state: EditorState, parent: Parent, from: number) {
  const line = state.doc.lineAt(from).text;
  if (TYPE_PREDICATE.test(line) || TYPEOF_IMPORT.test(line)) return true;
  for (; parent; parent = parent.parent as Parent) {
    const text = state.doc.sliceString(parent.from, parent.to);
    if (parent.name === 'CatchClause' && TYPED_CATCH.test(text)) return true;
    if (parent.name === 'JSXEscape' && JSX_BLOCK_COMMENT.test(text)) return true;
    if (parent.name === 'AtRule' && TAILWIND_AT.test(text)) return true;
  }
  return false;
}

function errorDiagnostic(state: EditorState, from: number, to: number): Diagnostic {
  const message = errorMessage(state, from, to);
  let start = from, end = to;
  // Most error nodes are zero-width; widen to one character for an underline, never across a line break.
  if (start === end) {
    const line = state.doc.lineAt(start);
    if (end < line.to) end += 1;
    else if (start > line.from) start -= 1;
  }
  return { from: start, to: end, severity: 'error', message };
}

function errorMessage(state: EditorState, from: number, to: number) {
  const skipped = to > from ? state.doc.sliceString(from, to).trim() : '';
  if (skipped) return `Unexpected ${quote(skipped)}`;
  const token = tokenAt(state, from);
  if (token) return `Unexpected ${quote(token)}`;
  return from >= state.doc.length ? 'Unexpected end of file' : 'Unexpected end of line';
}

/** The token the parser stopped in front of. */
function tokenAt(state: EditorState, pos: number) {
  if (pos >= state.doc.length) return null;
  const line = state.doc.lineAt(pos);
  if (pos >= line.to) return null;
  return state.doc.sliceString(pos, Math.min(line.to, pos + MAX_TOKEN_CHARS + 1)).trimStart().match(/^(\w+|[^\s\w])/)?.[1] ?? null;
}

function quote(text: string) {
  const flat = text.replace(/\s+/g, ' ');
  return `“${flat.length > MAX_TOKEN_CHARS ? `${flat.slice(0, MAX_TOKEN_CHARS)}…` : flat}”`;
}

const lintTheme = EditorView.theme({
  // A text-decoration squiggle takes the palette directly; the base theme's is an SVG background.
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--hui-color-foreground-danger-primary, #f87171)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
  '.cm-lintPoint:after': { borderBottomColor: 'var(--hui-color-foreground-danger-primary, #f87171)' },
  '.cm-tooltip-lint .cm-diagnostic': { fontFamily: 'var(--hui-font-family-mono, ui-monospace, monospace)', fontSize: '12px', padding: '4px 8px', marginLeft: '0' },
  '.cm-tooltip-lint .cm-diagnostic-error': { borderLeft: '2px solid var(--hui-color-foreground-danger-primary, #f87171)' },
});
