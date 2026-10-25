import { lazy, Suspense, use } from "react";
import { Linking, Text } from "react-native";
import { useScheme } from "@/ui/theme";
import { GeneratedChatContext } from "./GeneratedChatContext";

const GeneratedReplyDOM = lazy(() => import("./GeneratedReplyDOM"));

export function GeneratedChatBlock({ program, streaming }: {
  program: string;
  streaming: boolean;
}) {
  const chat = use(GeneratedChatContext);
  const scheme = useScheme();
  if (!chat) return null;
  return (
    <Suspense fallback={<Text>Loading interactive reply…</Text>}>
      <GeneratedReplyDOM
        program={program}
        streaming={streaming}
        busy={chat.busy}
        scheme={scheme}
        send={chat.send}
        openUrl={async (url) => { await Linking.openURL(url); }}
        dom={{ matchContents: true, scrollEnabled: false, style: { backgroundColor: "transparent" } }}
      />
    </Suspense>
  );
}
