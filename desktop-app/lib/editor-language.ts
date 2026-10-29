import { HighlightStyle, LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags, type Tag } from '@lezer/highlight';

// Carried over from the native app's editor. Colours are honestui's syntax
// variables, so the editor matches code in replies and follows the theme.
const groups: [string, Tag[]][] = [
  ['var(--_syntax-keyword)', [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.modifier, tags.self, tags.bool, tags.null, tags.atom, tags.unit]],
  ['var(--_syntax-function)', [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName, tags.macroName]],
  ['var(--_syntax-string)', [tags.string, tags.docString, tags.character, tags.attributeValue, tags.special(tags.string), tags.regexp, tags.escape]],
  ['var(--_syntax-type)', [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)]],
  ['var(--_syntax-tag)', [tags.tagName]],
  ['var(--_syntax-constant)', [tags.number, tags.integer, tags.float]],
  ['var(--_syntax-comment)', [tags.comment, tags.lineComment, tags.blockComment, tags.docComment]],
  ['var(--_syntax-property)', [tags.propertyName, tags.attributeName]],
  ['var(--_syntax-parameter)', [tags.meta, tags.processingInstruction, tags.annotation]],
  ['var(--_syntax-keyword)', [tags.heading, tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6]],
];

export const editorHighlightStyle = HighlightStyle.define([
  ...groups.map(([color, tag]) => ({ tag, color })),
  { tag: tags.invalid, color: 'var(--_syntax-invalid)', textDecoration: 'underline' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
]);

const legacy = (parser: StreamParser<unknown>): Extension => StreamLanguage.define(parser);
const fileName = (path: string) => path.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';

/** The language for a file, loaded on demand; null for plain text. */
export async function languageForPath(path: string): Promise<Extension | null> {
  const name = fileName(path);
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(extension)) {
    const { javascript } = await import('@codemirror/lang-javascript');
    return javascript({ jsx: extension === '.jsx' || extension === '.tsx', typescript: ['.ts', '.tsx', '.mts', '.cts'].includes(extension) });
  }
  if (extension === '.json') return (await import('@codemirror/lang-json')).json();
  if (extension === '.jsonc') return legacy((await import('@codemirror/legacy-modes/mode/javascript')).json);
  if (extension === '.css') return (await import('@codemirror/lang-css')).css();
  if (['.scss', '.sass'].includes(extension)) return (await import('@codemirror/lang-sass')).sass({ indented: extension === '.sass' });
  if (extension === '.less') return (await import('@codemirror/lang-less')).less();
  if (['.html', '.htm'].includes(extension)) return (await import('@codemirror/lang-html')).html();
  if (extension === '.vue') return (await import('@codemirror/lang-vue')).vue();
  if (extension === '.svelte') return (await import('@replit/codemirror-lang-svelte')).svelte();
  if (['.md', '.mdx', '.markdown'].includes(extension)) return (await import('@codemirror/lang-markdown')).markdown();
  if (extension === '.rs') {
    const { rustLanguage } = await import('@codemirror/lang-rust');
    const { completeFromList } = await import('@codemirror/autocomplete');
    const keywords = 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' ').map(label => ({ label, type: 'keyword' }));
    return new LanguageSupport(rustLanguage, [rustLanguage.data.of({ autocomplete: completeFromList(keywords) })]);
  }
  if (extension === '.py') return (await import('@codemirror/lang-python')).python();
  if (extension === '.c') return legacy((await import('@codemirror/legacy-modes/mode/clike')).c);
  if (['.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'].includes(extension)) return (await import('@codemirror/lang-cpp')).cpp();
  if (extension === '.java') return (await import('@codemirror/lang-java')).java();
  if (['.php', '.phtml'].includes(extension)) return (await import('@codemirror/lang-php')).php();
  if (extension === '.sql') return (await import('@codemirror/lang-sql')).sql();
  if (['.xml', '.svg', '.plist'].includes(extension)) return (await import('@codemirror/lang-xml')).xml();
  if (['.yaml', '.yml'].includes(extension)) return (await import('@codemirror/lang-yaml')).yaml();
  if (extension === '.cs') return legacy((await import('@codemirror/legacy-modes/mode/clike')).csharp);
  if (extension === '.go') return legacy((await import('@codemirror/legacy-modes/mode/go')).go);
  if (extension === '.zig') return legacy((await import('@codemirror/legacy-modes/mode/clike')).c);
  if (extension === '.dart') return legacy((await import('@codemirror/legacy-modes/mode/clike')).dart);
  if (extension === '.swift') return legacy((await import('@codemirror/legacy-modes/mode/swift')).swift);
  if (['.kt', '.kts'].includes(extension)) return legacy((await import('@codemirror/legacy-modes/mode/clike')).kotlin);
  if (['.rb', '.rake'].includes(extension) || ['gemfile', 'rakefile'].includes(name)) return legacy((await import('@codemirror/legacy-modes/mode/ruby')).ruby);
  if (['.sh', '.bash', '.zsh'].includes(extension) || ['.bashrc', '.bash_profile', '.zshrc', '.zprofile'].includes(name)) return legacy((await import('@codemirror/legacy-modes/mode/shell')).shell);
  if (name === '.env' || name.startsWith('.env.')) {
    const { properties } = await import('@codemirror/legacy-modes/mode/properties');
    // Keys come out as "def", which the palette leaves uncoloured; give them a colour of their own.
    return legacy({ ...properties, token: (stream, state) => { const style = properties.token(stream, state); return style === 'def' ? 'envKey' : style; }, tokenTable: { envKey: tags.labelName } });
  }
  if (extension === '.toml') return legacy((await import('@codemirror/legacy-modes/mode/toml')).toml);
  if (['.scala', '.sc'].includes(extension)) return legacy((await import('@codemirror/legacy-modes/mode/clike')).scala);
  if (extension === '.lua') return legacy((await import('@codemirror/legacy-modes/mode/lua')).lua);
  if (extension === '.r') return legacy((await import('@codemirror/legacy-modes/mode/r')).r);
  if (['.pl', '.pm'].includes(extension)) return legacy((await import('@codemirror/legacy-modes/mode/perl')).perl);
  if (['.ps1', '.psd1', '.psm1'].includes(extension)) return legacy((await import('@codemirror/legacy-modes/mode/powershell')).powerShell);
  if (['.m', '.mm'].includes(extension)) { const { objectiveC, objectiveCpp } = await import('@codemirror/legacy-modes/mode/clike'); return legacy(extension === '.mm' ? objectiveCpp : objectiveC); }
  if (extension === '.proto') return legacy((await import('@codemirror/legacy-modes/mode/protobuf')).protobuf);
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return legacy((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile);
  return null;
}
