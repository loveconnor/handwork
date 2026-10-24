import {
  ALT,
  IS_MAC,
  IS_WIN,
  MOD,
  SHIFT,
} from "../../../platform/tauri/platform";
import {
  canonicalShortcut,
  isGlobalShortcut,
  QUICK_COMPOSER_DEFAULT_SHORTCUT,
  quickComposerShortcutLabel,
  shortcutFromKeyEvent,
  shortcutTokens,
} from "../../quick-composer/model/quickComposerShortcut";
import { readFlag, writeFlag } from "./storageFlags";
const SECTION_KEY = "handwork.settingsSection";
export type SettingsSectionId =
  | "general"
  | "connections"
  | "appearance"
  | "keybindings"
  | "chat"
  | "providers"
  | "mcp"
  | "skills"
  | "monos"
  | "worktrees"
  | "archive";
/** Rail buckets. Sections list in order under their group label. */
export type SettingsGroupId = "app" | "agents" | "workspace";
export const SETTINGS_GROUPS: {
  id: SettingsGroupId;
  label: string;
}[] = [
  { id: "app", label: "App" },
  { id: "agents", label: "Agents" },
  { id: "workspace", label: "Workspace" },
];
export type SettingsSection = {
  id: SettingsSectionId;
  group: SettingsGroupId;
  label: string;
  description: string;
  /** Extra words search matches the section on, beyond its label. */
  keywords?: string;
};
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "general",
    group: "app",
    label: "General",
    description:
      "Manage notifications, workspace behavior, and app updates.",
    keywords: "version update sounds notifications rail",
  },
  {
    id: "connections",
    group: "app",
    label: "Connections",
    description:
      "Connect another computer to run agents remotely, or pair your phone with this desktop.",
    keywords:
      "ssh remote host machine server environment always on mobile phone iphone qr pair router",
  },
  {
    id: "appearance",
    group: "app",
    label: "Appearance",
    description:
      "Set the theme, colors, window transparency, and chat background.",
    keywords:
      "theme dark light color accent glass transparency blur zoom scale wallpaper rail sidebar",
  },
  {
    id: "keybindings",
    group: "app",
    label: "Keyboard shortcuts",
    description:
      "View and change keyboard shortcuts.",
    keywords: "shortcut hotkey keyboard binding",
  },
  {
    id: "chat",
    group: "agents",
    label: "Chat",
    description:
      "Set message layout, follow-up behavior, file saving, and code review preferences.",
    keywords:
      "transcript composer prompt message diff review layout format save editor",
  },
  {
    id: "providers",
    group: "agents",
    label: "Providers",
    description:
      "Manage provider accounts, agent installations, and default models.",
    keywords:
      "account sign in login model harness claude codex gemini cli default hooks",
  },
  {
    id: "mcp",
    group: "agents",
    label: "MCP",
    description:
      "Connect MCP servers to give agents access to tools and services.",
    keywords:
      "tools servers connections oauth authenticate login claude codex cursor opencode",
  },
  {
    id: "skills",
    group: "agents",
    label: "Skills",
    description:
      "Choose which skills agents can use in your projects.",
    keywords: "skill instructions prompt",
  },
  {
    id: "monos",
    group: "agents",
    label: "Hands",
    description:
      "Manage Hands, their projects, and the chats they start.",
    keywords: "mono resident agent mascot claim project title bar",
  },
  {
    id: "archive",
    group: "workspace",
    label: "Archive",
    description: "Find and restore archived projects and chats.",
    keywords: "archived restore delete hidden",
  },
  {
    id: "worktrees",
    group: "workspace",
    label: "Worktrees",
    description: "Create and manage separate working copies of your projects.",
    keywords: "git branch worktree working copy project create delete",
  },
];
export function settingsSectionsByGroup(): {
  id: SettingsGroupId;
  label: string;
  sections: SettingsSection[];
}[] {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    sections: SETTINGS_SECTIONS.filter((section) => section.group === group.id),
  })).filter((group) => group.sections.length > 0);
}
/**
 * One searchable control. `id` is the row's `data-setting-id` in SettingsView,
 * which is also what Settings scrolls to when it opens on an anchor.
 */
export type SettingsEntry = {
  id: string;
  section: SettingsSectionId;
  label: string;
  keywords?: string;
};
export const SETTINGS_INDEX: SettingsEntry[] = [
  {
    id: "mobile-access",
    section: "connections",
    label: "Paired phones",
    keywords: "mobile phone iphone qr pair code router device",
  },
  {
    id: "remote-machines",
    section: "connections",
    label: "Remote computers",
    keywords: "ssh remote connect host server environment",
  },
  {
    id: "mcp-servers",
    section: "mcp",
    label: "MCP servers",
    keywords: "claude tools connections oauth authenticate login add remove",
  },
  {
    id: "monos-enabled",
    section: "monos",
    label: "Show Hands",
    keywords: "mono agent rail hide",
  },
  {
    id: "rail-monos-pinned",
    section: "monos",
    label: "Pin Hands above project icons",
    keywords: "mono rail compact collapsed icons top divider project picker",
  },
  {
    id: "mono-list",
    section: "monos",
    label: "Your Hands",
    keywords:
      "mono reset soul name projects sessions sidebar visibility hidden show",
  },
  {
    id: "project-worktrees",
    section: "worktrees",
    label: "Project worktrees",
    keywords: "git branch working copy create delete manage",
  },
  {
    id: "update",
    section: "general",
    label: "Version",
    keywords: "update upgrade release what's new build changelog",
  },
  {
    id: "sounds",
    section: "general",
    label: "Sounds",
    keywords: "audio cue chime mute volume",
  },
  {
    id: "notifications",
    section: "general",
    label: "Notifications",
    keywords: "notify alert toast permission reminder background",
  },
  ...(IS_MAC
    ? [
        {
          id: "quick-composer",
          section: "general" as const,
          label: "Quick composer",
          keywords: "spotlight global shortcut hotkey floating prompt anywhere",
        },
      ]
    : []),
  {
    id: "working-agents",
    section: "general",
    label: "Working agents",
    keywords: "live running sessions rail card",
  },
  {
    id: "file-tabs",
    section: "general",
    label: "File tabs",
    keywords: "editor open top workspace normal session pane beside chat",
  },
  {
    id: "tab-animations",
    section: "general",
    label: "Tab animations",
    keywords: "motion open close resize transition",
  },
  ...(IS_WIN
    ? [
        {
          id: "close-to-tray",
          section: "general" as const,
          label: "Close to tray",
          keywords: "minimize background quit exit window taskbar windows",
        },
      ]
    : []),
  {
    id: "theme",
    section: "appearance",
    label: "Theme",
    keywords: "dark light system appearance mode",
  },
  {
    id: "workspace-theme",
    section: "appearance",
    label: "Workspace theme",
    keywords:
      "color colour palette scheme preset inset harbor moss ember orchid",
  },
  {
    id: "accent-color",
    section: "appearance",
    label: "Accent color",
    keywords: "highlight bubble send button tint",
  },
  {
    id: "diff-colors",
    section: "appearance",
    label: "Diff colors",
    keywords:
      "colorblind color blind accessibility added removed red green blue orange high contrast changes",
  },
  {
    id: "hue",
    section: "appearance",
    label: "Hue",
    keywords: "tint color chrome",
  },
  {
    id: "saturation",
    section: "appearance",
    label: "Saturation",
    keywords: "tint color neutral grey gray",
  },
  {
    id: "dark-lightness",
    section: "appearance",
    label: "Dark-mode lightness",
    keywords: "black brightness contrast background",
  },
  {
    id: "inset-glass",
    section: "appearance",
    label: "Transparent window",
    keywords: "glass inset translucent transparency opaque desktop blur layout",
  },
  {
    id: "sidebar-opacity",
    section: "appearance",
    label: "Sidebar opacity",
    keywords: "glass translucent transparency vibrancy",
  },
  {
    id: "blur",
    section: "appearance",
    label: "Blur radius",
    keywords: "glass translucent vibrancy backdrop",
  },
  {
    id: "main-pane-glass",
    section: "appearance",
    label: "Main area transparency",
    keywords: "glass translucent transparency body window",
  },
  {
    id: "inset-layout",
    section: "appearance",
    label: "Inset layout",
    keywords:
      "classic preview sidebar navigation tabs inset workspace card rounded floating linear frame",
  },
  {
    id: "interface-scale",
    section: "appearance",
    label: "Interface scale",
    keywords: "zoom font size bigger smaller ui",
  },
  {
    id: "collapsed-project-rail",
    section: "appearance",
    label: "Collapsed sidebar",
    keywords: "sidebar compact icons hidden navigation layout",
  },
  {
    id: "show-excluded-files",
    section: "appearance",
    label: "Show ignored files",
    keywords: "explorer gitignore ignored hidden files tree",
  },
  {
    id: "chat-background",
    section: "appearance",
    label: "Chat background",
    keywords: "wallpaper image picture opacity backdrop",
  },
  {
    id: "transcript-layout",
    section: "chat",
    label: "Message layout",
    keywords: "full width chat bubble message",
  },
  {
    id: "anchor-prompts",
    section: "chat",
    label: "Keep new messages at the top",
    keywords: "scroll position sticky message",
  },
  {
    id: "paced-reveal",
    section: "chat",
    label: "Smooth text reveal",
    keywords: "streaming pacing immediate latency performance animation",
  },
  {
    id: "follow-up",
    section: "chat",
    label: "Follow-up behavior",
    keywords: "queue steer interrupt send while running",
  },
  {
    id: "model-controls",
    section: "chat",
    label: "Model controls",
    keywords:
      "effort thinking reasoning fast service tier model picker composer",
  },
  {
    id: "composer-autocorrect",
    section: "chat",
    label: "Autocorrect",
    keywords: "spelling spell check autocorrect typo macos composer",
  },
  {
    id: "format-on-save",
    section: "chat",
    label: "Format on save",
    keywords: "prettier quotes editor save format",
  },
  {
    id: "diff-view",
    section: "chat",
    label: "Diff view",
    keywords: "unified editor review changes working tree",
  },
  {
    id: "agent-clis",
    section: "providers",
    label: "Installed agents",
    keywords:
      "codex opencode cursor grok pi omp fx hermes antigravity devin binary path",
  },
  {
    id: "provider-accounts",
    section: "providers",
    label: "Provider accounts",
    keywords:
      "account sign in login rename remove delete credentials profile usage limit quota exhausted",
  },
  {
    id: "show-remaining-usage",
    section: "providers",
    label: "Show remaining usage",
    keywords: "usage limit meter bar left used quota percent",
  },
  {
    id: "mask-emails",
    section: "providers",
    label: "Hide account email addresses",
    keywords: "email privacy blur hide screenshot account",
  },
  {
    id: "claude-hooks",
    section: "providers",
    label: "Claude Code hooks",
    keywords: "pretooluse settings.json block command notification",
  },
  {
    id: "idle-agents",
    section: "providers",
    label: "Keep idle agents running",
    keywords: "memory ram cpu performance process warm park background",
  },
  {
    id: "show-archived",
    section: "archive",
    label: "Show archived chats in sidebar",
    keywords: "hidden conversations list",
  },
];
export type SettingsSearchResult = {
  section: SettingsSectionId;
  sectionLabel: string;
  /** Row to scroll to, or `null` when the whole section matched. */
  settingId: string | null;
  label: string;
};
/** Ranks a label/keyword pair against a lowercased needle; `null` means no match. */
function matchScore(
  needle: string,
  label: string,
  keywords?: string,
): number | null {
  const lower = label.toLowerCase();
  if (lower.startsWith(needle)) return 0;
  if (lower.includes(needle)) return 1;
  if (keywords?.toLowerCase().includes(needle)) return 2;
  return null;
}
const NO_HIDDEN_SETTINGS: ReadonlySet<string> = new Set();
/** Appearance rows that only one layout shows: the inset workspace drops the
 * tint and translucency controls, and only it has workspace themes and its
 * own glass switch. */
export const INSET_LAYOUT_HIDDEN_SETTINGS: ReadonlySet<string> = new Set([
  "hue",
  "saturation",
  "dark-lightness",
  "sidebar-opacity",
  "blur",
  "main-pane-glass",
]);
export const CLASSIC_LAYOUT_HIDDEN_SETTINGS: ReadonlySet<string> = new Set([
  "workspace-theme",
  "inset-glass",
]);
/** Individual settings first, then whole sections, so a row wins its own name. */
export function searchSettings(
  query: string,
  limit = 8,
  hidden: ReadonlySet<string> = NO_HIDDEN_SETTINGS,
): SettingsSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored: {
    score: number;
    result: SettingsSearchResult;
  }[] = [];
  for (const entry of SETTINGS_INDEX) {
    if (hidden.has(entry.id)) continue;
    const score = matchScore(needle, entry.label, entry.keywords);
    if (score == null) continue;
    scored.push({
      score,
      result: {
        section: entry.section,
        sectionLabel: settingsSectionLabel(entry.section),
        settingId: entry.id,
        label: entry.label,
      },
    });
  }
  for (const section of SETTINGS_SECTIONS) {
    const score = matchScore(
      needle,
      section.label,
      `${section.description} ${section.keywords ?? ""}`,
    );
    if (score == null) continue;
    scored.push({
      score: score + 0.5,
      result: {
        section: section.id,
        sectionLabel: section.label,
        settingId: null,
        label: section.label,
      },
    });
  }
  return scored
    .sort(
      (a, b) =>
        a.score - b.score || a.result.label.localeCompare(b.result.label),
    )
    .slice(0, limit)
    .map((item) => item.result);
}
export const SETTINGS_SECTION_DEFAULT: SettingsSectionId = "general";
export function isSettingsSectionId(
  value: unknown,
): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}
export function settingsSectionLabel(id: SettingsSectionId): string {
  return (
    SETTINGS_SECTIONS.find((section) => section.id === id)?.label ?? "General"
  );
}
export function settingsSectionDescription(id: SettingsSectionId): string {
  return (
    SETTINGS_SECTIONS.find((section) => section.id === id)?.description ?? ""
  );
}
export function loadSettingsSection(): SettingsSectionId {
  try {
    const raw = localStorage.getItem(SECTION_KEY);
    return isSettingsSectionId(raw) ? raw : SETTINGS_SECTION_DEFAULT;
  } catch {
    return SETTINGS_SECTION_DEFAULT;
  }
}
export function saveSettingsSection(id: SettingsSectionId) {
  try {
    localStorage.setItem(SECTION_KEY, id);
  } catch {
    // private mode / quota
  }
}
const FOLLOW_UP_BEHAVIOR_KEY = "handwork.followUpBehavior";
const COMPOSER_EFFORT_VISIBLE_KEY = "handwork.composerEffortVisible";
const MODEL_CONTROLS_KEY = "handwork.modelControls";
const FILE_TAB_MODE_KEY = "handwork.fileTabMode";
const TAB_ANIMATIONS_ENABLED_KEY = "handwork.tabAnimationsEnabled";
const COLLAPSED_PROJECT_RAIL_MODE_KEY = "handwork.collapsedProjectRailMode";
export type FollowUpBehavior = "steer" | "queue";
export const FOLLOW_UP_BEHAVIOR_DEFAULT: FollowUpBehavior = "steer";
export function loadFollowUpBehavior(): FollowUpBehavior {
  try {
    const raw = localStorage.getItem(FOLLOW_UP_BEHAVIOR_KEY);
    return raw === "queue" || raw === "steer"
      ? raw
      : FOLLOW_UP_BEHAVIOR_DEFAULT;
  } catch {
    return FOLLOW_UP_BEHAVIOR_DEFAULT;
  }
}
export function saveFollowUpBehavior(value: FollowUpBehavior) {
  try {
    localStorage.setItem(FOLLOW_UP_BEHAVIOR_KEY, value);
  } catch {
    // private mode / quota
  }
}
export type FileTabMode = "pane" | "workspace";
export const FILE_TAB_MODE_DEFAULT: FileTabMode = "pane";
/** Choose whether an ordinary file joins the active pane or gets a top tab. */
export function loadFileTabMode(): FileTabMode {
  try {
    const raw = localStorage.getItem(FILE_TAB_MODE_KEY);
    return raw === "pane" || raw === "workspace" ? raw : FILE_TAB_MODE_DEFAULT;
  } catch {
    return FILE_TAB_MODE_DEFAULT;
  }
}
export function saveFileTabMode(value: FileTabMode) {
  try {
    localStorage.setItem(FILE_TAB_MODE_KEY, value);
  } catch {
    // private mode / quota
  }
}
export const TAB_ANIMATIONS_ENABLED_DEFAULT = false;
export function loadTabAnimationsEnabled(): boolean {
  return readFlag(TAB_ANIMATIONS_ENABLED_KEY) ?? TAB_ANIMATIONS_ENABLED_DEFAULT;
}
export function saveTabAnimationsEnabled(value: boolean) {
  writeFlag(TAB_ANIMATIONS_ENABLED_KEY, value);
}
export type CollapsedProjectRailMode = "compact" | "hidden";
export const COLLAPSED_PROJECT_RAIL_MODE_DEFAULT: CollapsedProjectRailMode =
  "compact";
export const COLLAPSED_PROJECT_RAIL_MODE_CHANGE_EVENT =
  "handwork:collapsed-project-rail-mode-change";
export function loadCollapsedProjectRailMode(): CollapsedProjectRailMode {
  try {
    const raw = localStorage.getItem(COLLAPSED_PROJECT_RAIL_MODE_KEY);
    return raw === "compact" || raw === "hidden"
      ? raw
      : COLLAPSED_PROJECT_RAIL_MODE_DEFAULT;
  } catch {
    return COLLAPSED_PROJECT_RAIL_MODE_DEFAULT;
  }
}
export function saveCollapsedProjectRailMode(value: CollapsedProjectRailMode) {
  try {
    localStorage.setItem(COLLAPSED_PROJECT_RAIL_MODE_KEY, value);
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<CollapsedProjectRailMode>(
      COLLAPSED_PROJECT_RAIL_MODE_CHANGE_EVENT,
      { detail: value },
    ),
  );
}
export function subscribeCollapsedProjectRailMode(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(
    COLLAPSED_PROJECT_RAIL_MODE_CHANGE_EVENT,
    onStoreChange,
  );
  return () =>
    window.removeEventListener(
      COLLAPSED_PROJECT_RAIL_MODE_CHANGE_EVENT,
      onStoreChange,
    );
}
export type ModelControls = "menu" | "beside";
export const MODEL_CONTROLS_DEFAULT: ModelControls = "menu";
/** Fired on `window` when the composer model controls setting flips. */
export const MODEL_CONTROLS_CHANGE_EVENT = "handwork:model-controls-change";
export function loadModelControls(): ModelControls {
  try {
    const raw = localStorage.getItem(MODEL_CONTROLS_KEY);
    if (raw === "menu" || raw === "beside") return raw;
    if (raw == null) {
      // Migrate the previous effort-control toggle: on means beside the picker.
      const legacy = localStorage.getItem(COMPOSER_EFFORT_VISIBLE_KEY);
      if (legacy === "1" || legacy === "true") return "beside";
    }
  } catch {
    // private mode / quota
  }
  return MODEL_CONTROLS_DEFAULT;
}
export function saveModelControls(value: ModelControls) {
  try {
    localStorage.setItem(MODEL_CONTROLS_KEY, value);
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ModelControls>(MODEL_CONTROLS_CHANGE_EVENT, {
      detail: value,
    }),
  );
}
export function subscribeModelControls(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MODEL_CONTROLS_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(MODEL_CONTROLS_CHANGE_EVENT, onStoreChange);
}
const MONOS_ENABLED_KEY = "handwork.monosEnabled";
export const MONOS_ENABLED_DEFAULT = true;
/** Fired on `window` when monos are shown or hidden. */
export const MONOS_ENABLED_CHANGE_EVENT = "handwork:monos-enabled-change";
/** Whether monos show in the title bar at all, across every project. */
export function loadMonosEnabled(): boolean {
  return readFlag(MONOS_ENABLED_KEY) ?? MONOS_ENABLED_DEFAULT;
}
export function saveMonosEnabled(value: boolean) {
  writeFlag(MONOS_ENABLED_KEY, value);
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(MONOS_ENABLED_CHANGE_EVENT, { detail: value }),
  );
}
export function subscribeMonosEnabled(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MONOS_ENABLED_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(MONOS_ENABLED_CHANGE_EVENT, onStoreChange);
}
const MONO_MENU_BAR_KEY = "handwork.monoMenuBarIcon";
/** Fired on `window` when the menu bar icon is shown or hidden. */
export const MONO_MENU_BAR_CHANGE_EVENT = "handwork:mono-menu-bar-change";
export function loadMonoMenuBarIcon(): boolean {
  return readFlag(MONO_MENU_BAR_KEY) ?? true;
}
export function saveMonoMenuBarIcon(value: boolean) {
  writeFlag(MONO_MENU_BAR_KEY, value);
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MONO_MENU_BAR_CHANGE_EVENT));
}
export function subscribeMonoMenuBarIcon(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MONO_MENU_BAR_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(MONO_MENU_BAR_CHANGE_EVENT, onStoreChange);
}
const QUICK_COMPOSER_ENABLED_KEY = "handwork.quickComposerEnabled";
const QUICK_COMPOSER_SHORTCUT_KEY = "handwork.quickComposerShortcut";
export const QUICK_COMPOSER_ENABLED_DEFAULT = true;
export function loadQuickComposerEnabled(): boolean {
  return readFlag(QUICK_COMPOSER_ENABLED_KEY) ?? QUICK_COMPOSER_ENABLED_DEFAULT;
}
export function saveQuickComposerEnabled(value: boolean) {
  writeFlag(QUICK_COMPOSER_ENABLED_KEY, value);
}
export function loadQuickComposerShortcut(): string {
  try {
    const value = localStorage.getItem(QUICK_COMPOSER_SHORTCUT_KEY);
    return value && isGlobalShortcut(value)
      ? value
      : QUICK_COMPOSER_DEFAULT_SHORTCUT;
  } catch {
    return QUICK_COMPOSER_DEFAULT_SHORTCUT;
  }
}
export function saveQuickComposerShortcut(value: string) {
  if (!isGlobalShortcut(value)) return;
  // Same conflict rules as every other row, so the separately stored Quick
  // Composer chord cannot claim a combination another command already owns.
  const shortcut = validateKeybindingShortcut(QUICK_COMPOSER_COMMAND, value);
  try {
    localStorage.setItem(QUICK_COMPOSER_SHORTCUT_KEY, shortcut);
  } catch {
    // private mode / quota
  }
}
const LIVE_AGENTS_ENABLED_KEY = "handwork.liveAgentsEnabled";
export const LIVE_AGENTS_ENABLED_DEFAULT = true;
/** Fired on `window` when the working-agents rail card setting flips. */
export const LIVE_AGENTS_ENABLED_CHANGE_EVENT =
  "handwork:live-agents-enabled-change";
export function loadLiveAgentsEnabled(): boolean {
  return readFlag(LIVE_AGENTS_ENABLED_KEY) ?? LIVE_AGENTS_ENABLED_DEFAULT;
}
export function saveLiveAgentsEnabled(value: boolean) {
  writeFlag(LIVE_AGENTS_ENABLED_KEY, value);
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(LIVE_AGENTS_ENABLED_CHANGE_EVENT, {
      detail: value,
    }),
  );
}
export function subscribeLiveAgentsEnabled(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(LIVE_AGENTS_ENABLED_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(LIVE_AGENTS_ENABLED_CHANGE_EVENT, onStoreChange);
}
const CLOSE_TO_TRAY_KEY = "handwork.closeToTray";
export const CLOSE_TO_TRAY_DEFAULT = true;
export function loadCloseToTray(): boolean {
  // Close to tray is Windows-only: nowhere else installs a tray icon.
  if (!IS_WIN) return false;
  return readFlag(CLOSE_TO_TRAY_KEY) ?? CLOSE_TO_TRAY_DEFAULT;
}
export function saveCloseToTray(value: boolean) {
  writeFlag(CLOSE_TO_TRAY_KEY, value);
}
const DIFF_VIEWER_KEY = "handwork.diffViewer";
export type DiffViewer = "editor" | "unified";
export const DIFF_VIEWER_DEFAULT: DiffViewer = "editor";
/** Fired on `window` when the working-tree diff layout flips. */
export const DIFF_VIEWER_CHANGE_EVENT = "handwork:diff-viewer-change";
function isDiffViewer(value: unknown): value is DiffViewer {
  return value === "editor" || value === "unified";
}
export function loadDiffViewer(): DiffViewer {
  try {
    const raw = localStorage.getItem(DIFF_VIEWER_KEY);
    return isDiffViewer(raw) ? raw : DIFF_VIEWER_DEFAULT;
  } catch {
    return DIFF_VIEWER_DEFAULT;
  }
}
export function saveDiffViewer(value: DiffViewer) {
  const next = isDiffViewer(value) ? value : DIFF_VIEWER_DEFAULT;
  try {
    localStorage.setItem(DIFF_VIEWER_KEY, next);
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<DiffViewer>(DIFF_VIEWER_CHANGE_EVENT, { detail: next }),
  );
}
export function subscribeDiffViewer(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(DIFF_VIEWER_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(DIFF_VIEWER_CHANGE_EVENT, onStoreChange);
}
const FORMAT_ON_SAVE_KEY = "handwork.formatOnSave";
export const FORMAT_ON_SAVE_DEFAULT = true;
export function loadFormatOnSave(): boolean {
  return readFlag(FORMAT_ON_SAVE_KEY) ?? FORMAT_ON_SAVE_DEFAULT;
}
export function saveFormatOnSave(value: boolean) {
  writeFlag(FORMAT_ON_SAVE_KEY, value);
}
const AUTOSAVE_KEY = "handwork.autosave";
const AUTOSAVE_CHANGE_EVENT = "handwork:autosave-change";
export const AUTOSAVE_DEFAULT = false;
export function loadAutosave(): boolean {
  return readFlag(AUTOSAVE_KEY) ?? AUTOSAVE_DEFAULT;
}
export function saveAutosave(value: boolean): boolean {
  writeFlag(AUTOSAVE_KEY, value);
  const saved = loadAutosave();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTOSAVE_CHANGE_EVENT));
  }
  return saved;
}
export function subscribeAutosave(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === AUTOSAVE_KEY) onStoreChange();
  };
  window.addEventListener(AUTOSAVE_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(AUTOSAVE_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}
const CLAUDE_HOOKS_KEY = "handwork.claudeHooks";
export const CLAUDE_HOOKS_DEFAULT = true;
export function loadClaudeHooks(): boolean {
  return readFlag(CLAUDE_HOOKS_KEY) ?? CLAUDE_HOOKS_DEFAULT;
}
export function saveClaudeHooks(value: boolean) {
  writeFlag(CLAUDE_HOOKS_KEY, value);
}
const IDLE_AGENT_LIMIT_KEY = "handwork.idleAgentLimit";
/** How many finished conversations keep their agent CLI warm. */
export const IDLE_AGENT_LIMITS = [0, 1, 2, 3, 5] as const;
export type IdleAgentLimit = (typeof IDLE_AGENT_LIMITS)[number];
export const IDLE_AGENT_LIMIT_DEFAULT: IdleAgentLimit = 3;
export function loadIdleAgentLimit(): IdleAgentLimit {
  try {
    const raw = Number(localStorage.getItem(IDLE_AGENT_LIMIT_KEY) ?? NaN);
    return (
      IDLE_AGENT_LIMITS.find((limit) => limit === raw) ??
      IDLE_AGENT_LIMIT_DEFAULT
    );
  } catch {
    return IDLE_AGENT_LIMIT_DEFAULT;
  }
}
export function saveIdleAgentLimit(value: IdleAgentLimit) {
  try {
    localStorage.setItem(IDLE_AGENT_LIMIT_KEY, String(value));
  } catch {
    // private mode / quota
  }
}
const CTRL = IS_MAC ? "⌃" : "Ctrl+";
/** Labels are separate from command IDs so saved shortcuts remain compatible. */
const SHORTCUT_LABELS: Record<string, string> = {
  "App: Settings": "Open settings",
  "App: Search": "Open command palette",
  "App: Go to File": "Go to file",
  "App: Command Palette": "Open command palette",
  "App: Find in Files": "Find in files",
  "App: Open Project": "Open project",
  "App: New Chat": "New chat",
  "App: New Window": "New window",
  "App: Quick Composer": "Open quick composer",
  "App: Toggle Sidebar": "Toggle sidebar",
  "App: Toggle Session Sidebar": "Toggle chat sidebar",
  "App: Switch Model": "Switch model",
  "App: Toggle Hand": "Toggle Hand",
  "Composer: Toggle Workspace": "Change working copy",
  "View: Reload": "Reload Handwork",
  "View: Zoom In": "Zoom in",
  "View: Zoom Out": "Zoom out",
  "View: Reset Zoom": "Reset zoom",
  "Tab: New": "New tab",
  "Tab: Close Others": "Close other tabs",
  "Tab: Close All": "Close all tabs",
  "Tab: Next": "Next tab",
  "Tab: Previous": "Previous tab",
  "Tab: Cycle Next": "Cycle to next tab",
  "Tab: Cycle Previous": "Cycle to previous tab",
  "Tab: Back": "Go back",
  "Tab: Forward": "Go forward",
  "Tab: Activate 1–8": "Switch to tab 1 through 8",
  "Tab: Activate Last": "Switch to last tab",
  "Session: Archive": "Archive chat",
  "Session: Stop": "Stop reply",
  "Session: Previous": "Previous chat",
  "Session: Next": "Next chat",
  "Session: Previous in Current Tab": "Previous chat in this tab",
  "Session: Next in Current Tab": "Next chat in this tab",
  "Project: Previous": "Previous project",
  "Project: Next": "Next project",
  "Pane: Close": "Close pane",
  "Pane: Split Right": "Split pane right",
  "Pane: Split Down": "Split pane below",
  "Pane: Focus Left": "Focus pane on left",
  "Pane: Focus Right": "Focus pane on right",
  "Pane: Focus Up": "Focus pane above",
  "Pane: Focus Down": "Focus pane below",
  "Terminal: New": "New terminal",
  "Terminal: New Tab": "New terminal tab",
  "Terminal: Toggle Dock": "Toggle terminal",
  "Editor: Find": "Find in file",
  "Editor: Replace": "Replace in file"
};
export function shortcutCommandLabel(command: string): string {
  return SHORTCUT_LABELS[command] ?? command;
}
export type KeybindingRow = {
  command: string;
  keys: string;
  when: string;
  fixed?: true;
};
/**
 * Mirrors the bindings we actually handle: the native menu accelerators in
 * `src-tauri/src/menu.rs`, `tabCommand`, the window key handler in App, and
 * focused surface handlers such as the draft composer workspace toggle.
 */
export const KEYBINDINGS: KeybindingRow[] = [
  { command: "App: Settings", keys: `${MOD},`, when: "Always" },
  { command: "App: Search", keys: `${MOD}K`, when: "Always" },
  { command: "App: Go to File", keys: `${MOD}P`, when: "Always" },
  { command: "App: Command Palette", keys: `${MOD}${SHIFT}P`, when: "Always" },
  { command: "App: Find in Files", keys: `${MOD}${SHIFT}F`, when: "Always" },
  { command: "App: Open Project", keys: `${MOD}O`, when: "Always" },
  { command: "App: New Chat", keys: `${MOD}N`, when: "Always" },
  { command: "App: New Window", keys: `${MOD}${SHIFT}N`, when: "Always" },
  ...(IS_MAC
    ? [
        {
          command: "App: Quick Composer",
          keys: `${MOD}${SHIFT}Space`,
          when: "Anywhere",
        },
      ]
    : []),
  { command: "App: Toggle Sidebar", keys: `${MOD}B`, when: "Always" },
  {
    command: "App: Toggle Session Sidebar",
    keys: `${MOD}${SHIFT}B`,
    when: "Always",
  },
  { command: "App: Switch Model", keys: `${MOD}.`, when: "Always" },
  { command: "App: Toggle Hand", keys: `${MOD}I`, when: "In a project with a Hand" },
  {
    command: "Composer: Toggle Workspace",
    keys: `${MOD}${SHIFT}G`,
    when: "While writing a new project chat",
  },
  { command: "View: Reload", keys: `${MOD}${SHIFT}R`, when: "Always" },
  { command: "View: Zoom In", keys: `${MOD}+`, when: "Always" },
  { command: "View: Zoom Out", keys: `${MOD}-`, when: "Always" },
  { command: "View: Reset Zoom", keys: `${MOD}0`, when: "Always" },
  { command: "Tab: New", keys: `${MOD}T`, when: "Always" },
  { command: "Tab: Close Others", keys: `${MOD}${ALT}T`, when: "Always" },
  { command: "Tab: Close All", keys: `${MOD}${SHIFT}W`, when: "Always" },
  { command: "Tab: Next", keys: `${MOD}${SHIFT}]`, when: "Always" },
  { command: "Tab: Previous", keys: `${MOD}${SHIFT}[`, when: "Always" },
  { command: "Tab: Cycle Next", keys: `${CTRL}Tab`, when: "Always" },
  {
    command: "Tab: Cycle Previous",
    keys: `${CTRL}${SHIFT}Tab`,
    when: "Always",
  },
  { command: "Tab: Back", keys: `${MOD}[`, when: "Always" },
  { command: "Tab: Forward", keys: `${MOD}]`, when: "Always" },
  { command: "Tab: Activate 1–8", keys: `${MOD}1 … ${MOD}8`, when: "Always" },
  { command: "Tab: Activate Last", keys: `${MOD}9`, when: "Always" },
  {
    command: "Session: Archive",
    keys: `${MOD}${SHIFT}A`,
    when: "In a chat with no dialog open",
  },
  {
    command: "Session: Stop",
    keys: "Esc",
    when: "While an agent runs and the terminal is not focused",
    fixed: true,
  },
  {
    command: "Session: Previous",
    keys: `${MOD}${SHIFT}↑`,
    when: "With no dialog open and no text being edited",
  },
  {
    command: "Session: Next",
    keys: `${MOD}${SHIFT}↓`,
    when: "With no dialog open and no text being edited",
  },
  {
    command: "Session: Previous in Current Tab",
    keys: `${MOD}↑`,
    when: "With no dialog open and no text being edited",
  },
  {
    command: "Session: Next in Current Tab",
    keys: `${MOD}↓`,
    when: "With no dialog open and no text being edited",
  },
  {
    command: "Project: Previous",
    keys: `${MOD}${SHIFT}←`,
    when: "With no dialog open and no text being edited",
  },
  {
    command: "Project: Next",
    keys: `${MOD}${SHIFT}→`,
    when: "With no dialog open and no text being edited",
  },
  { command: "Pane: Close", keys: `${MOD}W`, when: "Always" },
  { command: "Pane: Split Right", keys: `${MOD}D`, when: "Outside the file editor" },
  {
    command: "Pane: Split Down",
    keys: `${MOD}${SHIFT}D`,
    when: "Outside the file editor",
  },
  { command: "Pane: Focus Left", keys: `${MOD}${ALT}←`, when: "Always" },
  { command: "Pane: Focus Right", keys: `${MOD}${ALT}→`, when: "Always" },
  { command: "Pane: Focus Up", keys: `${MOD}${ALT}↑`, when: "Always" },
  { command: "Pane: Focus Down", keys: `${MOD}${ALT}↓`, when: "Always" },
  { command: "Terminal: New", keys: `${MOD}\``, when: "Always" },
  { command: "Terminal: New Tab", keys: `${MOD}${SHIFT}\``, when: "Always" },
  { command: "Terminal: Toggle Dock", keys: `${MOD}J`, when: "Always" },
  { command: "Editor: Find", keys: `${MOD}F`, when: "In the file editor" },
  { command: "Editor: Replace", keys: `${MOD}${ALT}F`, when: "In the file editor" },
];
const KEYBINDING_OVERRIDES_KEY = "handwork.keybindingOverrides";
const KEYBINDINGS_CHANGE_EVENT = "handwork:keybindings-change";
export type KeybindingOverride = {
  disabled?: boolean;
  shortcut?: string;
};
export type KeybindingOverrides = Record<string, KeybindingOverride>;
const VALID_COMMANDS = new Set(
  KEYBINDINGS.filter((row) => !row.fixed).map((row) => row.command),
);
const KEY_CODES: Record<string, string> = {
  " ": "Space",
  Enter: "Enter",
  Space: "Space",
  Tab: "Tab",
  "`": "Backquote",
  "[": "BracketLeft",
  "]": "BracketRight",
  ",": "Comma",
  ".": "Period",
  "+": "Equal",
  "-": "Minus",
  "\\": "Backslash",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  "←": "ArrowLeft",
  "→": "ArrowRight",
};
const DISPLAY_MODIFIERS: [string, string][] = IS_MAC
  ? [
      ["⌘", "Command"],
      ["⌃", "Control"],
      ["⌥", "Option"],
      ["⇧", "Shift"],
    ]
  : [
      ["Ctrl+", "Control"],
      ["Alt+", "Option"],
      ["Shift+", "Shift"],
    ];
const QUICK_COMPOSER_COMMAND = "App: Quick Composer";
const ACTIVATE_RANGE_COMMAND = "Tab: Activate 1–8";
/**
 * Every chord a command owns by default, in stored form. Grouped rows expand
 * to one chord per key so a rebind can never shadow a working shortcut.
 */
function defaultShortcutsFor(command: string): string[] {
  const row = KEYBINDINGS.find((entry) => entry.command === command);
  if (!row) return [];
  let rest = row.keys;
  const modifiers: string[] = [];
  for (const [display, modifier] of DISPLAY_MODIFIERS) {
    if (rest.startsWith(display)) {
      modifiers.push(modifier);
      rest = rest.slice(display.length);
    }
  }
  const chords = (code: string) => {
    const value = canonicalShortcut(
      modifiers.length ? [...modifiers, code].join("+") : code,
    );
    return value ? [value] : [];
  };
  if (row.keys.includes("…")) {
    return [1, 2, 3, 4, 5, 6, 7, 8].flatMap((digit) => chords(`Digit${digit}`));
  }
  if (/^[A-Za-z]$/.test(rest)) return chords(`Key${rest.toUpperCase()}`);
  if (/^[0-9]$/.test(rest)) return chords(`Digit${rest}`);
  if (KEY_CODES[rest]) return chords(KEY_CODES[rest]);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(rest)) return chords(rest);
  return [];
}
/** Chord to owning command, covering defaults, live overrides and Quick Composer. */
function shortcutOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const row of KEYBINDINGS) {
    // The Quick Composer chord is stored separately from the table.
    const chords =
      row.command === QUICK_COMPOSER_COMMAND
        ? [loadQuickComposerShortcut()]
        : defaultShortcutsFor(row.command);
    for (const chord of chords) owners.set(chord, row.command);
  }
  for (const [command, override] of Object.entries(loadKeybindingOverrides())) {
    if (override.shortcut) owners.set(override.shortcut, command);
  }
  return owners;
}
function validateShortcut(command: string, shortcut: string): string {
  const canonical = canonicalShortcut(shortcut);
  if (!canonical) throw new Error("That combination is not a valid shortcut");
  if (command === ACTIVATE_RANGE_COMMAND && !/Digit[1-8]$/.test(canonical)) {
    throw new Error("Tab: Activate 1–8 needs a number key from 1 to 8");
  }
  return canonical;
}
/** Shared by both save paths so no chord can be claimed twice. */
export function validateKeybindingShortcut(
  command: string,
  shortcut: string,
): string {
  const canonical = validateShortcut(command, shortcut);
  const owner = shortcutOwners().get(canonical);
  if (owner && owner !== command) {
    throw new Error(`Already used by ${shortcutCommandLabel(owner)}`);
  }
  return canonical;
}
let cacheStorage: Storage | null = null;
let cacheRaw: string | null = null;
let cacheValue: KeybindingOverrides = {};
function parseKeybindingOverrides(raw: string | null): KeybindingOverrides {
  const value = JSON.parse(raw ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const next: KeybindingOverrides = {};
  for (const [savedCommand, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    // Retain shortcuts saved before the feature was renamed to Hands.
    const command = savedCommand === "App: Toggle Mono" ? "App: Toggle Hand" : savedCommand;
    if (savedCommand !== command && Object.prototype.hasOwnProperty.call(value, command)) continue;
    if (!VALID_COMMANDS.has(command) || !entry || typeof entry !== "object")
      continue;
    const override = entry as {
      disabled?: unknown;
      shortcut?: unknown;
    };
    const disabled = override.disabled === true;
    const shortcut =
      typeof override.shortcut === "string"
        ? (canonicalShortcut(override.shortcut) ?? undefined)
        : undefined;
    if (shortcut) next[command] = { shortcut };
    else if (disabled) next[command] = { disabled: true };
  }
  return next;
}
/** Cached per raw value: this runs several times on every keydown. Returns a fresh object. */
export function loadKeybindingOverrides(): KeybindingOverrides {
  try {
    const storage = localStorage;
    const raw = storage.getItem(KEYBINDING_OVERRIDES_KEY);
    if (cacheStorage === storage && cacheRaw === raw) return { ...cacheValue };
    const next = parseKeybindingOverrides(raw);
    cacheStorage = storage;
    cacheRaw = raw;
    cacheValue = next;
    return { ...next };
  } catch {
    return {};
  }
}
export function saveKeybindingOverride(
  command: string,
  override: KeybindingOverride,
): KeybindingOverrides {
  const next = loadKeybindingOverrides();
  if (override.disabled) next[command] = { disabled: true };
  else if (override.shortcut) {
    const shortcut = validateKeybindingShortcut(command, override.shortcut);
    next[command] = { shortcut };
  } else delete next[command];
  try {
    if (Object.keys(next).length) {
      localStorage.setItem(KEYBINDING_OVERRIDES_KEY, JSON.stringify(next));
    } else {
      localStorage.removeItem(KEYBINDING_OVERRIDES_KEY);
    }
  } catch {
    throw new Error("Could not save shortcuts");
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(KEYBINDINGS_CHANGE_EVENT));
  }
  return next;
}
export type ShortcutEvent = Pick<KeyboardEvent, "code"> &
  Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;
export function shortcutMatches(
  shortcut: string,
  event: ShortcutEvent,
): boolean {
  // Copy the fields: real keyboard events expose modifiers as prototype
  // accessors, so spreading the event would silently drop all of them.
  return (
    shortcutFromKeyEvent({
      code: event.code,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    }) === shortcut
  );
}
export function matchCustomKeybinding(event: ShortcutEvent): string | null {
  for (const [command, override] of Object.entries(loadKeybindingOverrides())) {
    if (override.shortcut && shortcutMatches(override.shortcut, event)) {
      return command;
    }
  }
  return null;
}
export function keybindingPressed(
  command: string,
  event: ShortcutEvent,
  defaultMatch: boolean,
): boolean {
  const override = loadKeybindingOverrides()[command];
  if (override?.disabled) return false;
  if (override?.shortcut) return shortcutMatches(override.shortcut, event);
  return defaultMatch;
}
export function keybindingShortcutLabel(
  command: string,
  fallback: string,
): string | null {
  const override = loadKeybindingOverrides()[command];
  if (override?.disabled) return null;
  return override?.shortcut
    ? quickComposerShortcutLabel(override.shortcut)
    : fallback;
}
export function keybindingShortcutTokens(
  command: string,
  fallback: string,
): string | null {
  const override = loadKeybindingOverrides()[command];
  if (override?.disabled) return null;
  return override?.shortcut ? shortcutTokens(override.shortcut) : fallback;
}
export function subscribeKeybindings(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEYBINDING_OVERRIDES_KEY) onStoreChange();
  };
  window.addEventListener(KEYBINDINGS_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(KEYBINDINGS_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}
export function currentKeybindings(): KeybindingRow[] {
  const overrides = loadKeybindingOverrides();
  return KEYBINDINGS.map((row) => {
    if (row.command === "App: Quick Composer") {
      return {
        ...row,
        keys: loadQuickComposerEnabled()
          ? quickComposerShortcutLabel(loadQuickComposerShortcut())
          : "Disabled",
      };
    }
    const override = overrides[row.command];
    return {
      ...row,
      keys: override?.disabled
        ? "Disabled"
        : override?.shortcut
          ? quickComposerShortcutLabel(override.shortcut)
          : row.keys,
    };
  });
}
export function filterKeybindings(
  rows: KeybindingRow[],
  query: string,
): KeybindingRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) =>
      shortcutCommandLabel(row.command).toLowerCase().includes(needle) ||
      row.command.toLowerCase().includes(needle) ||
      row.keys.toLowerCase().includes(needle) ||
      row.when.toLowerCase().includes(needle),
  );
}
