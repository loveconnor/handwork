import { createContext, lazy, Suspense, useContext } from "react";

export const GeneratedChatContext = createContext<{
  send: (text: string) => void;
  busy: boolean;
} | null>(null);
const InteractiveReply = lazy(() => import("./InteractiveReply"));

export function GeneratedChatBlock({
  program,
  streaming,
}: {
  program: string;
  streaming: boolean;
}) {
  const chat = useContext(GeneratedChatContext);
  if (!chat)
    return (
      <pre>
        <code>{program}</code>
      </pre>
    );
  return (
    <Suspense fallback={<p role="status">Loading interactive reply…</p>}>
      <InteractiveReply
        program={program}
        streaming={streaming}
        send={chat.send}
        busy={chat.busy}
      />
    </Suspense>
  );
}
