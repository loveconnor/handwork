import { playCue } from "../../settings/model/sounds";
type Look = {
  mascot: string;
  color: string;
};
type Props = {
  /** The mascot and color the user's first Mono will have. */
  look: Look;
  /** Creates the first Mono and opens it. */
  onCreate: () => void;
  /** Turns Monos off, as Settings › Monos › Show monos does. */
  onHide: () => void;
};
/**
 * Stands in for the rail's Monos while the user has none, inviting them to
 * make their first. The switch hides Monos altogether.
 */
export function MonoIntroCard({ onCreate, onHide }: Props) {
  return (
    <section
      aria-label="Create a Hand"
      data-mono-intro
      className="mx-2 overflow-hidden rounded-lg bg-content/[0.03]"
    >
      <div className="flex items-center gap-2 pl-2.5 pr-2 pt-2">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">
          Create a Hand
        </h3>
        <button
          type="button"
          role="switch"
          aria-checked
          aria-label="Show Hands"
          title="Hide Hands from the sidebar. Show them again in Settings, Hands."
          onClick={() => {
            onHide();
            playCue("switch");
          }}
          className="relative h-4 w-7 shrink-0 rounded-full bg-accent transition-colors"
        >
          <span className="absolute left-3.5 top-0.5 size-3 rounded-full bg-white" />
        </button>
      </div>

      <p className="px-2.5 pt-1.5 text-[11px] leading-snug text-content/55">
        Create assistants with their own instructions and memory. Assign projects and schedule recurring tasks.
      </p>

      <div className="p-2">
        <button
          type="button"
          onClick={onCreate}
          className="h-7 w-full cursor-default rounded-md bg-content text-[12px] font-medium text-background-base hover:bg-content/85 active:scale-[0.98]"
        >
          Create a Hand
        </button>
      </div>
    </section>
  );
}
