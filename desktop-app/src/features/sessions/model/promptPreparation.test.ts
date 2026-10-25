import { HONEST_CHAT_SYSTEM_PROMPT } from "./honestChatPrompt";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyFileMentionsToTurn: vi.fn(),
  applySkillsToTurn: vi.fn(),
  events: [] as string[],
  warmNativeSkills: vi.fn(),
  skillNamesInText: vi.fn((): string[] => []),
}));

vi.mock("../../files/model/fileMentions", () => ({
  applyFileMentionsToTurn: mocks.applyFileMentionsToTurn,
}));

vi.mock("../../skills/model/skills", () => ({
  applySkillsToTurn: mocks.applySkillsToTurn,
  warmNativeSkills: mocks.warmNativeSkills,
  skillNamesInText: mocks.skillNamesInText,
  isNativeCommandPrompt: (text: string, harness: string) =>
    harness === "omp" && text.startsWith("/"),
}));

import { preparePrompt } from "./promptPreparation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.events.length = 0;
  mocks.applyFileMentionsToTurn.mockReset();
  mocks.applySkillsToTurn.mockReset();
  mocks.warmNativeSkills.mockReset();
  mocks.skillNamesInText.mockReset().mockReturnValue([]);
  mocks.warmNativeSkills.mockImplementation(() => {
    mocks.events.push("warm");
  });
});

describe("preparePrompt", () => {
  it.each([
    "/workflow foo @README.md",
    "/Review_Code a:b",
    "/omp:compact custom instructions",
  ])("preserves native command arguments: %s", async (text) => {
    await expect(
      preparePrompt(text, { harness: "omp", cwd: "/repo" }),
    ).resolves.toBe(text.replace("/omp:compact", "/compact"));
    expect(mocks.applyFileMentionsToTurn).not.toHaveBeenCalled();
    expect(mocks.applySkillsToTurn).not.toHaveBeenCalled();
  });
  it("starts warmup before awaiting file mentions", async () => {
    const files = deferred<string>();
    mocks.applyFileMentionsToTurn.mockImplementation(() => {
      mocks.events.push("files");
      return files.promise;
    });
    mocks.applySkillsToTurn.mockResolvedValue("prepared");

    const preparation = preparePrompt("hello", {
      harness: "pi",
      cwd: "/repo",
    });
    expect(mocks.events).toEqual(["warm", "files"]);

    files.resolve("with files");
    await expect(preparation).resolves.toBe("prepared");
    expect(mocks.applySkillsToTurn).toHaveBeenCalledWith("with files", {
      harness: "pi",
      cwd: "/repo",
    });
  });
});

it("gives standalone conversations ordinary chat context while preserving attachments", async () => {
  mocks.applyFileMentionsToTurn.mockResolvedValue("Explain the attached image");
  mocks.applySkillsToTurn.mockImplementation(async (text: string) => text);
  const prompt = await preparePrompt("Explain this", {
    harness: "handwork",
    cwd: "/home/chat-user",
  });
  expect(prompt).toContain(HONEST_CHAT_SYSTEM_PROMPT);
  expect(prompt).toContain("```honestai");
  expect(prompt).toContain("No project or repository is attached");
  expect(prompt).toContain("do not assume it is a coding task");
  expect(prompt.endsWith("Explain the attached image")).toBe(true);
  expect(mocks.warmNativeSkills).not.toHaveBeenCalled();
  expect(prompt).toContain("Do not call tools just to answer an ordinary conversation");
  expect(prompt).toContain("Do not discover, read, or activate skills unless the user explicitly asks");
});

it("uses the same prompt for desktop and mobile standalone Chats", async () => {
  mocks.applyFileMentionsToTurn.mockImplementation(async (text: string) => text);
  mocks.applySkillsToTurn.mockImplementation(async (text: string) => text);
  const { newNormalChat } = await import("./normalChats");
  const { mobileNewSession } = await import("../../mobile/model/mobileWorkspace");
  const desktop = newNormalChat();
  const mobile = mobileNewSession(desktop.cwd);
  const text = "Compare these options with a table";
  expect(await preparePrompt(text, mobile)).toBe(await preparePrompt(text, desktop));
  expect(mocks.warmNativeSkills).not.toHaveBeenCalled();
});

it("still loads a skill explicitly requested in Chats", async () => {
  mocks.skillNamesInText.mockReturnValue(["requested-skill"]);
  mocks.applyFileMentionsToTurn.mockResolvedValue("/requested-skill hello");
  mocks.applySkillsToTurn.mockResolvedValue("explicit skill instructions");
  const { normalChatCwd } = await import("./normalChats");
  const context = { harness: "handwork" as const, cwd: normalChatCwd() };
  const prompt = await preparePrompt("/requested-skill hello", context);
  expect(mocks.warmNativeSkills).toHaveBeenCalledWith(context);
  expect(prompt.endsWith("explicit skill instructions")).toBe(true);
});
