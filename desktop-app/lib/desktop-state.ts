// Renderer-only projection of engine events. Never executes tools or grants authority.
export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const text = (value: unknown): string => typeof value === "string" ? value : "";
export type EntryDiff = { path: string; oldText: string; newText: string };
export type EntryAttachment = { name: string; mimeType: string; size: number; data?: string };
export type Entry = { id: string; kind: "user" | "assistant" | "reasoning" | "tool"; text: string; title?: string; status?: string; input?: string; diffs?: EntryDiff[]; toolKind?: string; attachments?: EntryAttachment[] };
export type Conversation = { entries: Entry[]; title: string; used?: number; capacity?: number; recovery?: string };
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
export function applyUpdate(state: Conversation, update: RecordValue): Conversation {
  const type = update.sessionUpdate;
  if (type === "session_info_update") {
    const recovery = record(record(record(update._meta).handwork).modelResponseRecovery);
    return { ...state, title: text(update.title) || state.title, ...(recovery.message ? { recovery: text(recovery.message) } : {}) };
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
  const delta = content.type === "image" ? "[Image attachment in saved session]" : text(content.text);
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
  return { ...state, entries: previous ? state.entries.map(e => e === previous ? { ...e, text: e.text + delta } : e) : [...state.entries, { id, kind, text: delta }] };
}
export type ConfigChoice = { value: string; name: string; description?: string };
export type ConfigOption = { id: string; name: string; currentValue: string; options: ConfigChoice[] };
export function configOptions(value: unknown): ConfigOption[] {
  if (!Array.isArray(value)) return [];
  const flatten = (items: unknown): ConfigChoice[] => !Array.isArray(items) ? [] : items.flatMap(item => {
    const option = record(item);
    if (typeof option.value !== "string") return flatten(option.options);
    const description = text(option.description);
    return [{ value: option.value, name: text(option.name) || option.value, ...(description ? { description } : {}) }];
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
