import { writeFile } from 'node:fs/promises';
import './copy-map-worker.mjs';
import { buildSlashCommands } from './build-slash-commands.mjs';
await buildSlashCommands();
import { generateSystemPrompt, honestChatSpec } from 'honestui/genui/server';
import { desktopComponentNames } from '../electron/genui-components.mjs';
const mathFormattingRule = String.raw`For mathematical notation, use LaTeX \cdot for a centered multiplication dot, never a baseline period. Keep sentence punctuation distinct from multiplication. Separate proof labels from equations with spacing, for example \qquad\text{(IH)}, rather than joining a label with a period.`;
const components = Object.fromEntries(desktopComponentNames.map(name => {
  if (!honestChatSpec.components[name]) throw new Error(`Missing Honest AI component: ${name}`);
  return [name, honestChatSpec.components[name]];
}));
const prompt = generateSystemPrompt({ library: { root: 'Stack', components }, promptOptions: {
  preamble: "You are Handwork in the desktop app. Respond in Markdown with optional fenced honestai programs. Use interactive components when they help the user; most replies only need prose.",
  inlineMode: false, toolCalls: false, bindings: true,
  additionalRules: [
    mathFormattingRule,
    'You are Handwork in the desktop app. Answer in Markdown. Use fenced honestai blocks when a table, chart, form, or interactive choice helps the user complete their task.',
    'Every visual program MUST be inside a Markdown code fence labeled honestai, with the opening fence on its own line and the closing fence on its own line. Never output bare root assignments as prose. The root-first verification rule applies INSIDE each fence, not to the first line of the whole reply. Every block must be one complete program with a Stack root. Ordinary prose stays outside the block. Only use the listed components.',
    'This is an inline conversation, not a persistent dashboard editor. A reply may mix Markdown prose with fenced honestai programs. Emit a complete program for each visual; never emit only changed statements. Questions and explanations may include visuals when useful.',
    'When the user asks to visualize, illustrate, or diagram an explanation, use Honest AI visual components rather than ASCII art in CodeBlock. Use Diagram with DiagramNode for references, relationships, and flows; use PartsDiagram with DiagramPart for parts, layers, and nesting. Keep actual source code in CodeBlock.',
    'For pointer explanations, show the pointer holding an illustrative address and an arrow to the variable at that address holding its value. The pointer refers to the variable; do not draw the variable pointing to its address. Label sample addresses as illustrative.',
    'Use real project evidence. Never invent metrics, results, tool execution, or successful actions. Prefer prose when no structured UI is useful.',
    'Map uses the host-provided HonestAI place lookup, OpenFreeMap map tiles, and USGS imagery where available. Supply place names and search queries through MapPlace; never invent coordinates. Lookup and network failures remain visible with the place list.',
    'Interactions can only continue the conversation through @ToAssistant. No OpenUrl, Query, Mutation, Run, scripts, remote media, network requests, or direct file access. Tool execution and permissions belong to the native Handwork agent.',
    'Keep user requests and repository instructions authoritative. These instructions only describe the desktop response format.',
  ],
  examples: [
    'root = Stack([summary, table])\nsummary = TextContent("Here are the files inspected.")\ntable = Table([Col("File", ["README.md", "package.json"]), Col("Purpose", ["Project documentation", "Package configuration"])])',
    'root = Stack([memory, explanation])\nmemory = Diagram([DiagramNode("Pointer p", "0x1000", "Stores the address of x"), DiagramNode("Variable x at 0x1000", "42", "The value read by *p")], ["points to"], "Illustrative address; actual addresses vary.")\nexplanation = TextContent("Reading *p follows the address stored in p to read x. Writing *p changes x.")',
  ].map(source => '```honestai\n' + source + '\n```'),
}});
await writeFile(new URL('../electron/genui-prompt.json', import.meta.url), JSON.stringify(prompt));
// Match HonestAI's playground route: generateSystemPrompt({ library: chatSpec }).
// Keep the complete spec, including its chat preamble, rules, and examples.
await writeFile(new URL('../electron/standalone-prompt.json', import.meta.url), JSON.stringify(generateSystemPrompt({ library: honestChatSpec }) + '\n\n' + mathFormattingRule));
