import type { ChatPreference } from './desktop-api';

type Changes = Pick<ChatPreference, 'title' | 'pinned' | 'archived'>;
type Edit = { changes: Changes };
type Pending = { confirmed: ChatPreference; edits: Edit[]; tail: Promise<unknown> };

/** Publish immediately; serialize writes per chat so rapid edits keep their order. */
export class OptimisticChatUpdates {
  revision = 0;
  private pending = new Map<string, Pending>();

  invalidate() { this.revision++; }

  private project(state: Pending): ChatPreference {
    return Object.assign({}, state.confirmed, ...state.edits.map(edit => edit.changes));
  }

  merge(preferences: Record<string, ChatPreference>) {
    const merged = { ...preferences };
    for (const [id, state] of this.pending) merged[id] = { ...merged[id], ...this.project(state) };
    return merged;
  }

  update(id: string, current: ChatPreference, changes: Changes,
    write: () => Promise<ChatPreference>, publish: (preference: ChatPreference) => void) {
    let state = this.pending.get(id);
    if (!state) {
      state = { confirmed: current, edits: [], tail: Promise.resolve() };
      this.pending.set(id, state);
    }
    const pending = state;
    const edit = { changes };
    pending.edits.push(edit);
    this.invalidate();
    publish(this.project(pending));
    const saving = pending.tail.then(async () => {
      try { pending.confirmed = await write(); }
      finally {
        pending.edits = pending.edits.filter(item => item !== edit);
        this.invalidate();
        publish(this.project(pending));
        if (!pending.edits.length) this.pending.delete(id);
      }
    });
    // A failed edit rolls back without preventing the next edit from saving.
    pending.tail = saving.catch(() => {});
    return saving;
  }
}
