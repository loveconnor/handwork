// Renderer-only projection of engine events. Never executes tools or grants authority.
export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const text = (value: unknown): string => typeof value === "string" ? value : "";
export type EntryDiff = { path: string; oldText: string; newText: string };
/** A file sent with a message: image bytes, or a local file the engine received by URI. */
export type EntryAttachment = { name: string; mimeType: string; size?: number; data?: string; uri?: string };
/** `rawText` is the prompt exactly as the engine stored it, which rewinding must match. */
export type Entry = { id: string; kind: "user" | "assistant" | "reasoning" | "tool"; text: string; rawText?: string; title?: string; status?: string; input?: string; diffs?: EntryDiff[]; toolKind?: string; attachments?: EntryAttachment[] };
export type Conversation = { entries: Entry[]; title: string; used?: number; capacity?: number; recovery?: string; canContinue?: boolean };

/** A reopened chat shows the context usage saved from its last reply until the engine reports again. */
export function withSavedUsage(conversation: Conversation, saved?: { used: number; size?: number }): Conversation {
  if (conversation.used !== undefined || !saved || !Number.isFinite(saved.used)) return conversation;
  return { ...conversation, used: saved.used, capacity: saved.size };
}
export const emptyConversation = (): Conversation => ({ entries: [], title: "New chat" });

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return text(record(value).text);
  return value.map(item => {
    const block = record(item);
    if (block.type === "diff") return ""; // Rendered from `diffs` as diff chips, not as prose.
    return text(record(block.content).text) || text(block.text);
  }).filter(Boolean).join("\n");
}
function contentDiffs(value: unknown): EntryDiff[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => record(item)).filter(block => block.type === "diff" && text(block.path))
    .map(block => ({ path: text(block.path), oldText: text(block.oldText), newText: text(block.newText) }));
}
const FILE_HEADER = /(?:^|\n)File: ((?:file|attachment):\/\/[^\n]*)\n/g;
const IMAGE_PLACEHOLDER = /\n?\[Image #\d+\]/g;
function fileName(uri: string, content: string): string {
  const attached = /^Attached file: ([^\n]+)/.exec(content)?.[1];
  if (attached) return attached;
  try { return decodeURIComponent(new URL(uri).pathname.split("/").filter(Boolean).pop() || uri); } catch { return uri; }
}
/**
 * The engine stores a prompt's files inside its text as `File: <uri>` blocks after
 * the message. Replayed history splits them back into the message and its files.
 */
export function splitUserText(raw: string): { text: string; files: EntryAttachment[] } {
  const headers = [...raw.matchAll(FILE_HEADER)];
  if (!headers.length) return { text: raw, files: [] };
  const files = headers.map((match, index) => {
    const start = match.index + match[0].length;
    const content = raw.slice(start, headers[index + 1]?.index ?? raw.length);
    const uri = match[1];
    return { name: fileName(uri, content), mimeType: "application/octet-stream", ...(uri.startsWith("file:") ? { uri } : {}) };
  });
  return { text: raw.slice(0, headers[0].index).trimEnd(), files };
}
export function applyUpdate(state: Conversation, update: RecordValue): Conversation {
  const type = update.sessionUpdate;
  if (type === "session_info_update") {
    const meta = record(record(update._meta).handwork);
    const recovery = record(meta.modelResponseRecovery);
    const cleared = meta.modelResponseRecovery === null || recovery.state === 'recovered';
    return { ...state, title: text(update.title) || state.title, ...(Object.hasOwn(meta, 'modelResponseRecovery') ? {
      recovery: cleared ? undefined : text(recovery.message) || undefined,
      canContinue: !cleared && recovery.state === 'paused' && recovery.durable === true && recovery.requiredAction === 'continue_later',
    } : {}) };
  }
  if (type === "usage_update") return { ...state, used: typeof update.used === "number" ? update.used : undefined, capacity: typeof update.size === "number" ? update.size : undefined };
  if (type === "tool_call" || type === "tool_call_update") {
    const id = text(update.toolCallId);
    if (!id) return state;
    const previous = state.entries.find(e => e.kind === "tool" && e.id === id);
    // Diff blocks arrive on their own update ahead of the text completion, so they accumulate.
    const incomingDiffs = update.content !== undefined ? contentDiffs(update.content) : [];
    const incomingText = update.content !== undefined ? contentText(update.content) : "";
    const next: Entry = {
      id, kind: "tool", title: text(update.title) || previous?.title || text(update.name) || "Tool",
      toolKind: text(update.kind) || previous?.toolKind,
      status: text(update.status) || previous?.status || "pending",
      input: update.rawInput !== undefined ? JSON.stringify(update.rawInput, null, 2) : previous?.input,
      text: incomingText || previous?.text || "",
      diffs: incomingDiffs.length ? [...(previous?.diffs ?? []), ...incomingDiffs] : previous?.diffs,
    };
    return { ...state, entries: previous ? state.entries.map(e => e === previous ? next : e) : [...state.entries, next] };
  }
  const kind = type === "agent_message_chunk" ? "assistant" : type === "user_message_chunk" ? "user" : type === "agent_thought_chunk" ? "reasoning" : null;
  if (!kind) return state;
  const content = record(update.content);
  if (kind === "user" && content.type === "image") {
    const data = text(content.data);
    const target = state.entries.findLast(entry => entry.kind === "user" && (!text(update.messageId) || entry.id === text(update.messageId)));
    if (!data || !target) return state;
    if (target.attachments?.some(file => file.data === data)) return state;
    const images = (target.attachments ?? []).filter(file => file.mimeType.startsWith("image/")).length;
    const image = { name: `Image ${images + 1}`, mimeType: text(content.mimeType) || "image/png", size: Math.floor(data.length * 3 / 4), data };
    return { ...state, entries: state.entries.map(entry => entry === target ? { ...entry, text: entry.text.replace(IMAGE_PLACEHOLDER, "").trim(), attachments: [...(entry.attachments ?? []), image] } : entry) };
  }
  const delta = content.type === "image" ? "[Image]" : text(content.text);
  if (!delta) return state;
  // ACP emits this operational notice as assistant text, including during history replay.
  if (kind === "assistant" && delta.trim() === "cancelled") return state;
  const explicitId = text(update.messageId);
  const last = state.entries.at(-1);
  const id = explicitId || (last?.kind === kind ? last.id : `${kind}-${state.entries.length}`);
  const previous = state.entries.find(e => e.id === id && e.kind === kind);
  // Live prompts are shown optimistically; ACP may echo them with an ID, adding image placeholders after the text.
  if (kind === "user" && last?.kind === "user" && last.id.startsWith("local-") && (delta === last.text || (last.attachments?.length && delta.startsWith(last.text)))) {
    return { ...state, entries: [...state.entries.slice(0, -1), { ...last, id }] };
  }
  if (kind === "user") {
    const rawText = (previous?.rawText ?? previous?.text ?? "") + delta;
    const { text: shown, files } = splitUserText(rawText);
    const images = previous?.attachments?.filter(file => file.data) ?? [];
    const next: Entry = { id, kind, rawText, text: images.length ? shown.replace(IMAGE_PLACEHOLDER, "").trim() : shown, ...(images.length || files.length ? { attachments: [...files, ...images] } : {}) };
    return { ...state, entries: previous ? state.entries.map(e => e === previous ? next : e) : [...state.entries, next] };
  }
  return { ...state, entries: previous ? state.entries.map(e => e === previous ? { ...e, text: e.text + delta } : e) : [...state.entries, { id, kind, text: delta }] };
}
export type ConfigChoice = { value: string; name: string; description?: string; permissionMode?: string };
export type ConfigOption = { id: string; name: string; currentValue: string; options: ConfigChoice[] };
export function configOptions(value: unknown): ConfigOption[] {
  if (!Array.isArray(value)) return [];
  const flatten = (items: unknown): ConfigChoice[] => !Array.isArray(items) ? [] : items.flatMap(item => {
    const option = record(item);
    if (typeof option.value !== "string") return flatten(option.options);
    const description = text(option.description);
    return [{ value: option.value, name: text(option.name) || option.value, ...(description ? { description } : {}), ...(typeof option.permissionMode === 'string' ? { permissionMode: option.permissionMode } : {}) }];
  });
  return value.map(item => {
    const option = record(item);
    return { id: text(option.id), name: text(option.name), currentValue: text(option.currentValue), options: flatten(option.options) };
  }).filter(option => option.id && option.options.length);
}
/** ACP `available_commands_update`: slash commands the engine says this client may run. */
export type Command = { name: string; description: string; input?: string };
export function availableCommands(value: unknown): Command[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const command = record(item);
    return { name: text(command.name), description: text(command.description), input: text(record(command.input).hint) || undefined };
  }).filter(command => command.name);
}
/** `handwork/providers/list`: which providers have a credential and how each signs in. */
export type ProviderInfo = { id: string; name: string; description?: string; connected: boolean; signIn: "browser" | "api_key" | "none"; keyEnv?: string; baseUrl?: string };
export function providerList(value: unknown): ProviderInfo[] {
  const list = record(value).providers;
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    const entry = record(item);
    const raw = text(entry.signIn);
    const signIn: ProviderInfo["signIn"] = raw === "browser" || raw === "none" ? raw : "api_key";
    return { id: text(entry.id), name: text(entry.name) || text(entry.id), description: text(entry.description) || undefined, connected: entry.connected === true, signIn, keyEnv: text(entry.keyEnv) || undefined, baseUrl: text(entry.baseUrl) || undefined };
  }).filter(entry => entry.id);
}
export type Permission = { id: string | number; title: string; detail: string; options: { optionId: string; name: string; kind?: string }[] };
export function permissionFromEvent(event: RecordValue): Permission | null {
  if (typeof event.id !== "string" && typeof event.id !== "number") return null;
  const params = record(event.params);
  const tool = record(params.toolCall);
  const options = Array.isArray(params.options) ? params.options.map(item => {
    const option = record(item);
    return { optionId: text(option.optionId), name: text(option.name), kind: text(option.kind) };
  }).filter(option => option.optionId && option.name) : [];
  // Show what the tool will act on; the full call stays out of the card to keep it readable.
  const input = tool.rawInput;
  const detail = input === undefined ? "" : typeof input === "string" ? input
    : Object.entries(record(input)).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n");
  return { id: event.id, title: text(tool.title) || "Permission required", detail, options };
}
