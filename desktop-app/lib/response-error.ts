/** Operational provider failures also arrive as assistant text, including in saved history. */
export function isResponseError(value: string): boolean {
  return /^(?:provider_error:\s*\S[^\n]*|Provider response failed)[.!]?$/i.test(value.trim());
}
