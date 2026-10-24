import { FolderPlus, MessageSquare, Pencil } from "../../shared/ui/icons";
import { MOD } from "../../platform/tauri/platform";
import { RailAction } from "./RailAction";
export type ChatNavigationProps = {
  onOpenProject?: () => void;
  onOpenChats?: () => void;
  onNewChat?: () => void;
  chatsActive?: boolean;
};
export function ChatNavigation({
  onOpenProject,
  onOpenChats,
  onNewChat,
  chatsActive = false,
  compact = false,
}: ChatNavigationProps & { compact?: boolean }) {
  if (!onOpenChats && !onNewChat && !onOpenProject) return null;
  if (compact)
    return (
      <nav aria-label="Chats" className="flex flex-col items-center gap-1.5">
        {onNewChat && (
          <button
            type="button"
            aria-label="New chat"
            title="New chat"
            onClick={onNewChat}
            className="honest-button honest-ghost grid size-8 place-items-center rounded-lg text-content/60 hover:bg-content/5"
          >
            <Pencil className="size-4" />
          </button>
        )}
        {onOpenChats && (
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
        )}
        {onOpenProject && (
          <button
            type="button"
            aria-label="New project"
            title="New project"
            onClick={onOpenProject}
            className="honest-button honest-ghost grid size-8 place-items-center rounded-lg text-content/60 hover:bg-content/5"
          >
            <FolderPlus className="size-4" />
          </button>
        )}
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
      {onOpenProject ? (
        <RailAction
          label="New project"
          icon={FolderPlus}
          onClick={onOpenProject}
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
