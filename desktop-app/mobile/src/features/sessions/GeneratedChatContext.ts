import { createContext } from "react";

/** Only standalone Chats enable interactive replies, as on desktop. */
export const GeneratedChatContext = createContext<{
  busy: boolean;
  send: (text: string) => Promise<void>;
} | null>(null);
