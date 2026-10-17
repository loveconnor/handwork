/** Placeholder titles are not useful conversation names. */
export function isPlaceholderTitle(title) {
  return typeof title !== 'string' || !title.trim() || /^(?:new chat|untitled(?: chat| session)?|chat\s*·\s*.+)$/i.test(title.trim());
}

/** Use the first prompt until the engine supplies a title. Never include file contents. */
export function chatTitle(title, prompt = '') {
  if (!isPlaceholderTitle(title)) return title;
  const file = /(?:^|\n)File: (?:file|attachment):\/\//.exec(prompt);
  const text = (file ? prompt.slice(0, file.index) : prompt).replace(/\[Image #\d+\]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return /\[Image #\d+\]/.test(prompt) ? 'Image attachment' : file ? 'File attachment' : 'New chat';
  const characters = Array.from(text);
  if (characters.length <= 72) return text;
  const preview = characters.slice(0, 72).join('');
  const boundary = preview.lastIndexOf(' ');
  return (boundary > 40 ? preview.slice(0, boundary) : preview).trimEnd() + '…';
}
