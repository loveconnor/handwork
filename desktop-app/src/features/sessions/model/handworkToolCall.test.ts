import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { handworkToolCall, handworkWorkSummary } from "./handworkToolCall";

function shell(text: string): Block {
  return { id: text, role: "tool", text, tool: { kind: "shell" } };
}

describe("Handwork CLI tool calls", () => {
  it("recognizes app actions with absolute, quoted, or bare executables", () => {
    expect(
      handworkToolCall(
        shell(
          "/repo/target/debug/Handwork.app/Contents/MacOS/handwork app artifacts.list --json '{}'",
        ),
      )?.label,
    ).toBe("List artifacts");
    expect(
      handworkToolCall(
        shell(
          "'/Applications/Handwork App/handwork' app folders.move --input -",
        ),
      )?.label,
    ).toBe("Move a session");
    expect(
      handworkToolCall(
        shell('"C:\\Program Files\\Handwork\\handwork.exe" app artifacts.list'),
      )?.label,
    ).toBe("List artifacts");
    expect(handworkToolCall(shell("handwork app --help"))?.label).toBe(
      "View CLI commands",
    );
    expect(
      handworkToolCall(shell("handwork app sessions.read --json '{}'"))?.label,
    ).toBe("Read a session");
    expect(
      handworkToolCall(shell("handwork app sessions.send --json '{}'"))?.label,
    ).toBe("Continue a session");
    expect(
      handworkToolCall(shell("handwork app sessions.draft --json '{}'"))?.label,
    ).toBe("Save a draft");
    for (const [action, label] of [
      ["sessions.stop", "Stop a session"],
      ["sessions.archive", "Archive a session"],
      ["sessions.delete", "Delete a session"],
    ]) {
      expect(
        handworkToolCall(shell(`handwork app ${action} --json '{}'`))?.label,
      ).toBe(label);
    }
    expect(
      handworkToolCall(shell("handwork app artifacts.write --input -"))?.label,
    ).toBe("Write an artifact");
    expect(
      handworkToolCall({
        id: "generic",
        role: "tool",
        text: "Run command:",
        tool: { kind: "other", title: "handwork app sessions.start" },
      })?.label,
    ).toBe("Start a session");
    expect(
      handworkToolCall({
        id: "codex-action",
        role: "tool",
        text: "List",
        tool: {
          kind: "execute",
          preview: { kind: "shell", title: "handwork app artifacts.list" },
        },
      })?.label,
    ).toBe("List artifacts");
  });

  it("does not restyle unrelated commands or text mentioning the CLI", () => {
    expect(
      handworkToolCall(shell("echo handwork app artifacts.list")),
    ).toBeUndefined();
    expect(handworkToolCall(shell("handwork control list"))).toBeUndefined();
    expect(
      handworkToolCall({
        id: "prose",
        role: "assistant",
        text: "handwork app artifacts.list",
      }),
    ).toBeUndefined();
  });

  it("does not compact compound shell commands or hide a longer shell preview", () => {
    for (const command of [
      "handwork app artifacts.list && echo extra",
      "handwork app artifacts.list; echo extra",
      "handwork app artifacts.list | cat",
      "handwork app artifacts.list\necho extra",
      'handwork app artifacts.list --json "$(echo extra)"',
    ]) {
      expect(handworkToolCall(shell(command))).toBeUndefined();
    }
    expect(
      handworkToolCall({
        id: "short-title",
        role: "tool",
        text: "handwork app artifacts.list",
        tool: {
          kind: "shell",
          title: "handwork app artifacts.list",
          preview: {
            kind: "shell",
            title: "handwork app artifacts.list && echo extra",
          },
        },
      }),
    ).toBeUndefined();
    expect(
      handworkToolCall(
        shell('handwork app sessions.send --json \'{"prompt":"a; b"}\''),
      )?.command,
    ).toBe('handwork app sessions.send --json \'{"prompt":"a; b"}\'');
  });

  it("names a group only when all its tool calls use Handwork", () => {
    const calls = [
      shell("handwork app --help"),
      shell("handwork app artifacts.list"),
    ];
    expect(handworkWorkSummary(calls, true)).toBe("Using Handwork");
    expect(handworkWorkSummary(calls, false)).toBe("Used Handwork");
    expect(
      handworkWorkSummary([...calls, shell("git status")], true),
    ).toBeUndefined();
  });
});
