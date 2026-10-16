function fieldLabel(key: string): string {
  const label = key.replace(/^\$+/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return label ? label[0].toUpperCase() + label.slice(1) : 'Value';
}

function collectFields(value: unknown, fields: Map<string, string>, path: string[] = []): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    if (value.every(item => item === null || typeof item !== 'object')) {
      fields.set(path.join(' · ') || 'Details', value.map(item => item === null ? 'None' : String(item)).join(', ') || 'None');
    } else {
      value.forEach((item, index) => collectFields(item, fields, [...path, String(index + 1)]));
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectFields(item, fields, [...path, fieldLabel(key)]);
  } else {
    fields.set(path.join(' · ') || 'Details', value === null ? 'None' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value));
  }
}

export type ActionSubmission = { message: string; fields: { label: string; value: string }[] };

/** Recover submitted fields from the persisted prompt, so cards survive reopening a chat. */
export function actionSubmission(prompt: string): ActionSubmission | null {
  const separator = prompt.indexOf('\n\n');
  if (separator < 1) return null;
  const message = prompt.slice(0, separator);
  const details = prompt.slice(separator + 2);
  // Older GenUI actions included JSON sections. Present those as the same card.
  if (details.startsWith('Action context:\n') || details.startsWith('Submitted form values:\n')) {
    const fields = new Map<string, string>();
    try {
      for (const section of details.split('\n\n')) {
        const match = /^(?:Action context|Submitted form values):\n([\s\S]+)$/.exec(section);
        if (!match) return null;
        collectFields(JSON.parse(match[1]), fields);
      }
    } catch { return null; }
    return fields.size ? { message, fields: [...fields].map(([label, value]) => ({ label, value })) } : null;
  }
  const fields: ActionSubmission['fields'] = [];
  for (const line of details.split('\n')) {
    const match = /^([\p{L}\p{N}][\p{L}\p{N} ·/_()-]*):[ \t]*(.*)$/u.exec(line);
    if (match) fields.push({ label: match[1], value: match[2] });
    else if (fields.length) fields[fields.length - 1].value += `\n${line}`;
    else return null;
  }
  return fields.length ? { message, fields } : null;
}

export function actionPrompt(event: { type: string; humanFriendlyMessage: string; params: Record<string, unknown>; formState?: Record<string, unknown> }): string | null {
  if (event.type !== 'continue_conversation' || typeof event.humanFriendlyMessage !== 'string') return null;
  const message = event.humanFriendlyMessage.trim();
  if (!message) return null;
  const fields = new Map<string, string>();
  collectFields(event.params.context, fields);
  // Form bindings use a leading "$"; merge them with context so values appear once.
  collectFields(event.formState, fields);
  const details = [...fields].map(([label, value]) => `${label}: ${value}`).join('\n');
  const prompt = message + (details ? `\n\n${details}` : '');
  return prompt.length <= 100_000 ? prompt : null;
}
