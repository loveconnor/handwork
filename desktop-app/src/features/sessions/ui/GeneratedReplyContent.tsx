import { Component, useState, type ReactNode } from "react";
import { Renderer, honestChatLibrary, type ActionEvent } from "honestui/genui";

export function generatedMessage(event: ActionEvent): string {
  const payload = {
    ...event.formState,
    ...(event.params.context !== undefined
      ? { "@context": event.params.context }
      : {}),
  };
  return (
    event.humanFriendlyMessage +
    (Object.keys(payload).length ? "\n" + JSON.stringify(payload) : "")
  );
}

class ReplyBoundary extends Component<
  { children: ReactNode; program: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <>
        <p role="alert">This interactive reply could not be displayed.</p>
        <pre>{this.props.program}</pre>
      </>
    ) : (
      this.props.children
    );
  }
}

export default function GeneratedReplyContent({
  program,
  streaming,
  send,
  busy,
  scheme,
  openUrl,
}: {
  program: string;
  streaming: boolean;
  send: (text: string) => void | Promise<void>;
  busy: boolean;
  scheme: "light" | "dark";
  openUrl: (url: string) => Promise<unknown>;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div
      className={`generated-chat-ui not-prose ${scheme === "dark" ? "dark" : ""}`}
      data-theme={scheme}
      data-style="modern"
      data-density="default"
      style={{ colorScheme: scheme }}
    >
      <ReplyBoundary program={program}>
        <Renderer
          library={honestChatLibrary}
          response={program}
          isStreaming={streaming}
          onAction={(event) => {
            setError(null);
            if (streaming || busy) {
              setError("Wait for the current reply to finish, then try again.");
              return;
            }
            if (event.type === "continue_conversation")
              void Promise.resolve(send(generatedMessage(event))).catch(() =>
                setError("The message could not be sent. Try again when connected."),
              );
            else if (event.type === "open_url") {
              try {
                const url = new URL(String(event.params.url));
                if (url.protocol !== "https:" && url.protocol !== "http:")
                  throw new Error();
                void openUrl(url.href).catch(() =>
                  setError("The link could not be opened."),
                );
              } catch {
                setError("This link needs a valid HTTP or HTTPS address.");
              }
            } else setError("This action is not available in chat.");
          }}
          onError={(errors) => {
            const messages = errors
              .filter((entry) => entry.severity !== "warning")
              .map((entry) => entry.message);
            setError(
              messages.length && !streaming
                ? "This interactive reply could not be displayed. " +
                    messages.join(" ")
                : null,
            );
          }}
        />
      </ReplyBoundary>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
