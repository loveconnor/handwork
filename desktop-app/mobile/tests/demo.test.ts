import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_SELECTION,
  demoCloseWatch,
  demoNextUpdates,
  demoOpenWatch,
  demoRequest,
  resetDemo,
} from "@/features/connection/demo";
import { selectedWorkspace } from "@/features/connection/selection";
import type { Catalog } from "@/features/connection/ConnectionProvider";
import type { Turn } from "@/features/workspace/types";
import { applyFrames, type WatchFrame } from "@/features/workspace/watchUpdates";

vi.mock("expo-sqlite/kv-store", () => ({ default: {} }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: {} }));

const ask = async <T,>(method: string, params: object = {}) => {
  const result = demoRequest<T>(method, params);
  await vi.advanceTimersByTimeAsync(100);
  return result;
};

describe("demo workspace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDemo();
  });
  afterEach(() => vi.useRealTimers());

  it("lists projects whose sessions and files can be read", async () => {
    const catalog = await ask<Catalog>("workspace.list");
    const shown = selectedWorkspace(catalog, DEMO_SELECTION);
    expect(shown.projects.map((project) => project.name)).toEqual([
      "Chats",
      "weather-app",
      "notes-api",
    ]);
    for (const session of shown.sessions) {
      const read = await ask<{ turns: Turn[] }>("conversation.read", {
        conversationId: session.id,
      });
      expect(read.turns.length).toBeGreaterThan(0);
    }
    const weather = shown.projects[1];
    expect(weather.additions).toBeGreaterThan(0);
    const root = await ask<{ entries: { name: string; isDir: boolean }[] }>(
      "project.files",
      { projectId: weather.id, path: "" },
    );
    expect(root.entries.map((entry) => entry.name)).toEqual([
      "src",
      "package.json",
      "README.md",
    ]);
    const file = await ask<{ text: string }>("project.file", {
      projectId: weather.id,
      path: "src/components/Forecast.tsx",
    });
    expect(file.text).toContain("export function Forecast");
  });

  it("streams a sample reply to a new session over a watch", async () => {
    const { projects } = await ask<Catalog>("workspace.list");
    const { sessionId } = await ask<{ sessionId: string }>("session.start", {
      projectId: projects[1].id,
      text: "Hello there",
    });
    const watch = demoOpenWatch({ conversationId: sessionId });
    let turns: Turn[] = [];
    let busy = true;
    for (let i = 0; busy && i < 200; i++) {
      const pending = demoNextUpdates<WatchFrame>(watch, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const applied = applyFrames(turns, await pending);
      expect(applied).not.toBeNull();
      turns = applied!.turns;
      busy = applied!.busy ?? busy;
    }
    expect(busy).toBe(false);
    expect(turns).toHaveLength(1);
    expect(turns[0].footer).toBe(true);
    expect(turns[0].items.map((item) => item.type)).toEqual(["user", "text"]);
    expect(turns[0].items[1]).toMatchObject({ streaming: false });
    demoCloseWatch(watch);
    const catalog = await ask<Catalog>("workspace.list");
    expect(catalog.sessions[0]).toMatchObject({ id: sessionId, title: "Hello there", busy: false });
  });

  it("stages and commits the sample changes", async () => {
    const { projects } = await ask<Catalog>("workspace.list");
    const projectId = projects[1].id;
    await ask("project.gitAction", { projectId, action: "stage", paths: ["src/App.tsx"] });
    await ask("project.gitAction", { projectId, action: "commit", message: "Add forecast" });
    const changes = await ask<{ files: { relative: string }[] }>("project.changes", { projectId });
    expect(changes.files.map((file) => file.relative)).toEqual([
      "src/api/weather.ts",
      "src/components/Forecast.tsx",
    ]);
    expect(await ask("project.git", { projectId })).toMatchObject({ ahead: 1, files: 2 });
  });
});
