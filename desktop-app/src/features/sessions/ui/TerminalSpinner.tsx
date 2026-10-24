import { LoaderCircle } from "../../../shared/ui/icons";
export function TerminalSpinner({
  className = "inline-block w-3.5 select-none text-center text-[11px] leading-none",
}: {
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={className}>
      <LoaderCircle className="mx-auto block size-[1em] animate-spin" />
    </span>
  );
}
