import { expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  APP_VIEW_LABELS,
  appViewForTab,
} from "../../features/workspace/model/appViewTabs";
import {
  SETTINGS_INDEX,
  SETTINGS_SECTIONS,
} from "../../features/settings/model/settings";
it("cannot restore Inbox or Notes tabs or discover their settings", () => {
  expect(Object.keys(APP_VIEW_LABELS)).toEqual(["automations"]);
  expect(appViewForTab("app-view:search")).toBeUndefined();
  expect(appViewForTab("app-view:inbox")).toBeUndefined();
  expect(appViewForTab("app-view:notes")).toBeUndefined();
  expect(
    SETTINGS_SECTIONS.some((section) => String(section.id) === "inbox"),
  ).toBe(false);
  expect(SETTINGS_INDEX.some((setting) => String(setting.id) === "notes")).toBe(
    false,
  );
});
it("does not mount the removed views, poll the inbox, or expose native notebook commands", () => {
  const app = readFileSync("src/app/App.tsx", "utf8");
  expect(app).not.toContain("useInboxActivity");
  expect(app).not.toContain("<InboxView");
  expect(app).not.toContain("<NotesView");
  const native = readFileSync("src-tauri/src/lib.rs", "utf8");
  expect(native).not.toMatch(/notes::notes_/);
  const menu = readFileSync("src-tauri/src/menu.rs", "utf8");
  expect(menu).not.toContain("open_inbox");
  expect(menu).not.toContain("open_notes");
});

it("deletes the feature modules and backend rather than only hiding navigation", () => {
  for (const path of [
    "src/features/inbox",
    "src/features/notes",
    "src/features/sessions/model/savedContext.ts",
    "src-tauri/src/notes.rs",
    "src-tauri/src/jira.rs",
    "src-tauri/src/linear.rs",
  ])
    expect(existsSync(path), path).toBe(false);
  expect(
    readFileSync(
      "src/features/sessions/ui/TranscriptSelectionMenu.tsx",
      "utf8",
    ),
  ).not.toContain("onAddToNotes");
});
