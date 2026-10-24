import { MessageSquare, Pencil } from "../../shared/ui/icons";
import { MOD } from "../../platform/tauri/platform";
import { RailAction } from "./RailAction";
export type ChatNavigationProps = {
  onOpenChats?: () => void;
  onNewChat?: () => void;
  chatsActive?: boolean;
};
export function ChatNavigation({
  onOpenChats,
  onNewChat,
  chatsActive = false,
  compact = false,
}: ChatNavigationProps & { compact?: boolean }) {
  if (!onOpenChats && !onNewChat) return null;
  if (compact)
    return (
      <nav aria-label="Chats" className="flex flex-col items-center gap-1.5">
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={onNewChat}
          className="honest-button honest-ghost grid size-8 place-items-center rounded-lg text-content/60 hover:bg-content/5"
        >
          <Pencil className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Chats"
          title="Chats"
          aria-current={chatsActive ? "page" : undefined}
          onClick={onOpenChats}
          className={`honest-button honest-ghost grid size-8 place-items-center rounded-lg ${chatsActive ? "bg-selection text-content" : "text-content/60 hover:bg-content/5"}`}
        >
          <MessageSquare className="size-4" />
        </button>
      </nav>
    );
  return (
    <nav aria-label="Chats" className="flex flex-col gap-px">
      {onNewChat ? (
        <RailAction
          label="New chat"
          icon={Pencil}
          onClick={onNewChat}
          shortcut={`${MOD}N`}
        />
      ) : null}
      {onOpenChats ? (
        <RailAction
          label="Chats"
          icon={MessageSquare}
          onClick={onOpenChats}
          active={chatsActive}
        />
      ) : null}
    </nav>
  );
}
