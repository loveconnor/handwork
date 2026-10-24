import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  send: vi.fn(),
  forget: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
}));
vi.mock("./handwork", () => ({
  sendHandworkTurn: mock.send,
  forgetHandworkSession: mock.forget,
  cancelHandworkTurn: mock.cancel,
}));
import { runHandworkTextPrompt } from "./handworkText";
beforeEach(() => vi.clearAllMocks());
it("isolates background text generation and releases its session", async () => {
  mock.send.mockImplementation(async (input) => {
    expect(input.ephemeral).toBe(true);
    expect(input.runtimeMode).toBe("supervised");
    input.onEvent({ type: "message.delta", text: "Hello" });
    input.onEvent({ type: "message.delta", text: " world" });
  });
  await expect(
    runHandworkTextPrompt({ cwd: "/repo", prompt: "Title" }),
  ).resolves.toBe("Hello world");
  expect(mock.forget).toHaveBeenCalledWith(
    expect.stringMatching(/^handwork-text-/),
  );
});
it("surfaces provider errors and cleans up on failure", async () => {
  mock.send.mockImplementation(async (input) =>
    input.onEvent({
      type: "session.error",
      message: "Authentication required",
    }),
  );
  await expect(
    runHandworkTextPrompt({ cwd: "/repo", prompt: "Title" }),
  ).rejects.toThrow("Authentication required");
  expect(mock.forget).toHaveBeenCalledTimes(1);
});
it("does not start an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runHandworkTextPrompt({
      cwd: "/repo",
      prompt: "Title",
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(mock.send).not.toHaveBeenCalled();
});
