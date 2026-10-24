import { MessageSquare } from "../../../shared/ui/icons";
export type AgentIconStatus = "idle" | "working" | "needs-you";
type Props = {
  name: string;
  color: string;
  status?: AgentIconStatus;
  still?: boolean;
  className?: string;
};
export function AgentIcon({
  color,
  status = "idle",
  className = "size-7 shrink-0",
}: Props) {
  return (
    <MessageSquare
      data-agent-icon=""
      data-status={status}
      aria-hidden
      className={`${className} ${status === "working" ? "motion-safe:animate-pulse" : ""}`}
      style={{ color }}
      strokeWidth={1.75}
    />
  );
}
