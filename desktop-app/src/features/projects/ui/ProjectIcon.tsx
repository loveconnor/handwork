import { Folder } from "../../../shared/ui/icons";
type Props = {
  project: string;
  color?: string;
  name?: string | null;
  className?: string;
  active?: boolean;
};
export function ProjectIcon({
  color,
  className = "size-3 shrink-0",
  active = false,
}: Props) {
  return (
    <Folder
      data-project-icon=""
      data-active={active}
      aria-hidden
      className={`${className} ${active ? "motion-safe:animate-pulse" : ""}`}
      style={color ? { color } : undefined}
      strokeWidth={1.75}
    />
  );
}
