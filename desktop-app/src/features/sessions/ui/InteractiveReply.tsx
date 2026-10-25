import { openUrl } from "@tauri-apps/plugin-opener";
import { useColorScheme } from "../../../shared/hooks/useColorScheme";
import GeneratedReplyContent from "./GeneratedReplyContent";
import "../../../styles/honest-generated.css";
import "../../../styles/honest-chart-tokens.css";

export { generatedMessage } from "./GeneratedReplyContent";

export default function InteractiveReply(props: {
  program: string;
  streaming: boolean;
  send: (text: string) => void;
  busy: boolean;
}) {
  const scheme = useColorScheme();
  return <GeneratedReplyContent {...props} scheme={scheme} openUrl={openUrl} />;
}
