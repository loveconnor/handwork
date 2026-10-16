export function actionPrompt(event: { type: string; humanFriendlyMessage: string; params: Record<string, unknown>; formState?: Record<string, unknown> }): string | null {
  if (event.type !== 'continue_conversation' || typeof event.humanFriendlyMessage !== 'string') return null;
  const message = event.humanFriendlyMessage.trim();
  if (!message) return null;
  const context = event.params.context !== undefined ? `\n\nAction context:\n${JSON.stringify(event.params.context)}` : '';
  const state = event.formState && Object.keys(event.formState).length ? `\n\nSubmitted form values:\n${JSON.stringify(event.formState)}` : '';
  const prompt = message + context + state;
  return prompt.length <= 100_000 ? prompt : null;
}
