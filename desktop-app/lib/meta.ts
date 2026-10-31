export type Meta = {
  id: string;
  title: string;
  caption: string;
  file: string;
  variants?: string[];
  /** other files in this repo the component imports (ids in INTERNAL) — copy these too */
  deps?: string[];
  /** npm packages the component imports — install these */
  npm?: string[];
};

/** Shared building blocks that primitives import but that don't get their own
 * gallery card. Copy these alongside any component that lists them in `deps`. */
export const INTERNAL: Record<string, { title: string; path: string }> = {
  button: { title: "Button", path: "components/atoms/Button.tsx" },
  "glide-menu": { title: "GlideMenu", path: "components/primitives/GlideMenu.tsx" },
  "entity-chip": { title: "EntityChip", path: "components/atoms/EntityChip.tsx" },
  "value-pill": { title: "ValuePill", path: "components/atoms/ValuePill.tsx" },
  shimmer: { title: "Shimmer", path: "components/atoms/Shimmer.tsx" },
  "stream-text": { title: "StreamText", path: "components/atoms/StreamText.tsx" },
  icons: { title: "Icons", path: "components/atoms/Icons.tsx" },
  "provider-logo": { title: "ProviderLogo", path: "components/atoms/ProviderLogo.tsx" },
  "model-picker": { title: "ModelPicker", path: "components/primitives/ModelPicker.tsx" },
};

export const META: Meta[] = [
  {
    id: "loading-state",
    title: "Loading State",
    caption: "Pixel-grid loader with shimmer and elapsed time.",
    file: "LoadingState.tsx",
    variants: ["Drive", "Dots", "Orbit", "Surfer"],
  },
  {
    id: "thinking-state",
    title: "Thinking",
    caption: "Expandable traces — steps, reasoning, search, coding.",
    file: "ThinkingState.tsx",
    deps: ["icons"],
    variants: ["Steps", "Reasoning", "Search", "Coding"],
    npm: ["honestui"],
  },
  {
    id: "streaming-text",
    title: "Streaming Text",
    caption: "Streamed answer with inline sources, actions, and follow-ups.",
    file: "StreamingText.tsx",
    deps: ["icons"],
    npm: ["honestui"],
  },
  {
    id: "approval-card",
    title: "Approval Card",
    caption: "Human-in-the-loop questions the agent asks before acting.",
    file: "ApprovalCard.tsx",
    deps: ["icons", "button", "glide-menu"],
    npm: ["honestui"],
  },
  {
    id: "tool-chips",
    title: "Tool Chips",
    caption: "Code edits and tool calls as compact chips.",
    file: "ToolChips.tsx",
    deps: ["icons"],
    npm: ["honestui"],
  },
  {
    id: "task-rows",
    title: "Task Rows",
    caption: "Live agent task status — running, failed, completed.",
    file: "TaskRows.tsx",
    deps: ["icons"],
    variants: ["Capsules", "List"],
    npm: ["honestui"],
  },
  {
    id: "chat-composer",
    title: "Chat",
    caption: "Tabbed chat panel with reasoning replies and a composer.",
    file: "ChatComposer.tsx",
    deps: ["icons"],
    npm: ["honestui"],
  },
  {
    id: "prompt-bar",
    title: "Prompt Bar",
    caption: "Composer with @ sources, / commands, model picker, and dictation.",
    file: "PromptBar.tsx",
    deps: ["icons", "model-picker", "provider-logo", "glide-menu", "entity-chip"],
    npm: ["honestui", "glimm", "simple-icons"],
    variants: ["Rounded", "Pill"],
  },
  {
    id: "recommendation-card",
    title: "Recommendation Card",
    caption: "Agent suggestion with a confidence meter and actions.",
    file: "RecommendationCard.tsx",
    deps: ["button", "entity-chip", "value-pill"],
  },
  {
    id: "context-cards",
    title: "Context Cards",
    caption: "Retrieved knowledge chunks with their sources.",
    file: "ContextCards.tsx",
    deps: ["icons"],
    npm: ["honestui"],
  },
  {
    id: "diff-table",
    title: "Diff Table",
    caption: "AI-proposed edits sweeping through tabular data.",
    file: "DiffTable.tsx",
    deps: ["icons", "button"],
    npm: ["honestui"],
  },
  {
    id: "records-table",
    title: "Records Table",
    caption: "CRM-style grid with tags, sorting, and relationship status.",
    file: "RecordsTable.tsx",
    deps: ["icons", "glide-menu"],
    npm: ["honestui"],
  },
  {
    id: "filter-table",
    title: "Filter Table",
    caption: "Status chips that reorganize live data.",
    file: "FilterTable.tsx",
  },
  {
    id: "sidebar-nav",
    title: "Sidebar Nav",
    caption: "Collapsible workspace and chat navigation with gliding hover states.",
    file: "SidebarNav.tsx",
    deps: ["glide-menu", "icons"],
    npm: ["honestui"],
  },
  {
    id: "search",
    title: "Search",
    caption: "Command search with live filtering and an empty state.",
    file: "SearchList.tsx",
    deps: ["icons", "glide-menu"],
    npm: ["honestui"],
  },
  {
    id: "flowchart",
    title: "Flowchart",
    caption: "Workflow trigger and condition steps on a dotted canvas.",
    file: "Flowchart.tsx",
    deps: ["icons"],
    npm: ["honestui"],
  },
  {
    id: "insight-cards",
    title: "Insight Cards",
    caption: "Paged agent insights with scrub-ready live charts.",
    file: "InsightCards.tsx",
    deps: ["icons"],
    npm: ["honestui", "liveline"],
  },
  {
    id: "code-block",
    title: "Code Block",
    caption: "A line-numbered listing and a unified diff.",
    file: "CodeBlock.tsx",
    deps: ["icons"],
    variants: ["Code", "Diff"],
    npm: ["honestui"],
  },
  {
    id: "fine-tune-card",
    title: "Fine-tune Card",
    caption: "The agent adjusts design properties in an inspector.",
    file: "FineTuneCard.tsx",
    deps: ["icons", "glide-menu"],
    npm: ["honestui"],
  },
  {
    id: "selection-actions",
    title: "Selection Actions",
    caption: "Highlight a passage and hand it to the agent to rewrite.",
    file: "SelectionActions.tsx",
    deps: ["button", "shimmer", "stream-text", "icons"],
    npm: ["honestui"],
  },
  {
    id: "agent-screen",
    title: "Agent Screen",
    caption: "Watch an agent's screen — open, teach a task, record.",
    file: "AgentScreen.tsx",
    deps: ["icons", "button"],
    variants: ["Working", "Loading"],
    npm: ["honestui"],
  },
];
