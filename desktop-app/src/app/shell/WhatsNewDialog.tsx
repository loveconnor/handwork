import {
  formatReleaseDate,
  presentReleaseNotes,
  releaseNotesTitle,
} from "../model/releaseNotes";
import { AgentMarkdown } from "../../features/sessions/ui/AgentMarkdown";
import { Modal } from "../../shared/ui/Modal";
type Props = {
  version: string;
  onClose: () => void;
};
export function WhatsNewBody({ version }: { version: string }) {
  const notes = presentReleaseNotes(version);
  const title = releaseNotesTitle(version);
  return (
    <article aria-label={title} className="px-5 py-4">
      {notes?.markdown ? (
        <AgentMarkdown
          className="whats-new-md"
          text={notes.markdown}
          streaming={false}
        />
      ) : (
        <p className="text-[13px] text-content/60">
          No release notes are available for this version.
        </p>
      )}
    </article>
  );
}
export function WhatsNewDialog({ version, onClose }: Props) {
  const notes = presentReleaseNotes(version);
  const date = notes?.date ? formatReleaseDate(notes.date) : null;
  return (
    <Modal
      onClose={onClose}
      title="What's new"
      description={`Handwork ${version}${date ? ` · ${date}` : ""}`}
      size="md"
      className="h-[min(72vh,640px)]"
    >
      <WhatsNewBody version={version} />
    </Modal>
  );
}
