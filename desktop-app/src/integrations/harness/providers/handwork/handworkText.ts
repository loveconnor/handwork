import type { TextPromptInput } from "../../core/registry";
import {
  sendHandworkTurn,
  forgetHandworkSession,
  cancelHandworkTurn,
} from "./handwork";
const active = new Set<string>();
/** Tool-free, unsaved engine sessions never borrow the visible conversation. */
export async function runHandworkTextPrompt(
  input: TextPromptInput,
): Promise<string> {
  input.signal?.throwIfAborted();
  const id = `handwork-text-${crypto.randomUUID()}`;
  active.add(id);
  let output = "";
  let failure: Error | undefined;
  const abort = () => {
    void cancelHandworkTurn(id);
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    failure = new Error("Handwork text request timed out");
    void cancelHandworkTurn(id);
  }, input.timeoutMs ?? 90000);
  try {
    await sendHandworkTurn({
      sessionId: id,
      cwd: input.cwd,
      model: input.model ?? "handwork:default",
      modelSettings: input.modelSettings,
      runtimeMode: "supervised",
      ephemeral: true,
      text: input.prompt,
      onEvent: (event) => {
        if (event.type === "message.delta") output += event.text;
        if (event.type === "session.error") failure = new Error(event.message);
        input.onEvent?.(event);
      },
    });
    input.signal?.throwIfAborted();
    if (failure) throw failure;
    return output;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    active.delete(id);
    await forgetHandworkSession(id);
  }
}
export async function stopHandworkTextPrompt(): Promise<void> {
  await Promise.all([...active].map(forgetHandworkSession));
}
