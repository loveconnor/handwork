'use dom';

import type { DOMProps } from "expo/dom";
import { useEffect } from "react";
import GeneratedReplyContent from "../../../../src/features/sessions/ui/GeneratedReplyContent";
import "../../../../src/styles/honest-generated.css";
import "../../../../src/styles/honest-chart-tokens.css";
import "./generatedReply.css";

/** The same renderer, component library and action handling as desktop Chats. */
export default function GeneratedReplyDOM(props: {
  program: string;
  streaming: boolean;
  busy: boolean;
  scheme: "light" | "dark";
  send: (text: string) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  dom?: DOMProps;
}) {
  useEffect(() => {
    // Portalled menus live outside the reply and inherit the document theme.
    document.documentElement.classList.toggle("theme-light", props.scheme === "light");
    document.documentElement.style.colorScheme = props.scheme;
  }, [props.scheme]);
  return <GeneratedReplyContent {...props} />;
}
