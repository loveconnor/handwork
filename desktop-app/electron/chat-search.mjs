import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

// Only user and assistant lines are parsed. Tool output stays out of the index.
const MESSAGE_LINE = /^\{"schema_version":2,"seq":\d+,"timestamp_ms":\d+,"event":\{"(user|assistant)":/;
const MAX_SESSION_TEXT = 4 * 1024 * 1024;
const SNIPPET_RADIUS = 72;

/** Splits a query into lowercase terms; "quoted phrases" stay together. */
export function searchTerms(query) {
  const terms = [];
  for (const match of query.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2]).trim();
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms.slice(0, 8);
}

function snippet(text, terms) {
  const lower = text.toLowerCase();
  const first = Math.min(...terms.map(term => lower.indexOf(term)).filter(index => index >= 0));
  const start = Math.max(0, first - SNIPPET_RADIUS);
  const end = Math.min(text.length, first + SNIPPET_RADIUS * 2);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** Full-text search over the engine's saved conversations, cached per session file. */
export class ChatSearchIndex {
  constructor(directory) {
    this.directory = directory;
    this.sessions = new Map();
    this.refreshing = null;
  }

  async readSession(id) {
    const folder = path.join(this.directory, id);
    const events = path.join(folder, 'events.jsonl');
    const info = await stat(events).catch(() => null);
    if (!info?.isFile()) { this.sessions.delete(id); return; }
    const cached = this.sessions.get(id);
    if (cached && cached.mtime === info.mtimeMs && cached.size === info.size) return;
    let metadata = {};
    try { metadata = JSON.parse(await readFile(path.join(folder, 'session.json'), 'utf8')); } catch { /* Titles are optional. */ }
    if (metadata.subagent_child === true) { this.sessions.delete(id); return; }
    const messages = [];
    let bytes = 0;
    for (const line of (await readFile(events, 'utf8')).split('\n')) {
      const role = MESSAGE_LINE.exec(line)?.[1];
      if (!role) continue;
      let text;
      try { text = JSON.parse(line).event[role].text; } catch { continue; }
      if (typeof text !== 'string' || !text.trim()) continue;
      // Consecutive assistant chunks belong to the same reply.
      const last = messages.at(-1);
      if (last?.role === role && role === 'assistant') last.text += text;
      else messages.push({ role, text });
      bytes += text.length;
      if (bytes > MAX_SESSION_TEXT) break;
    }
    this.sessions.set(id, {
      mtime: info.mtimeMs, size: info.size, messages,
      title: typeof metadata.title === 'string' ? metadata.title : '',
      updatedAt: Number(metadata.updated_at_ms) || info.mtimeMs,
    });
  }

  refresh() {
    // Concurrent searches share one directory scan.
    this.refreshing ??= (async () => {
      const entries = await readdir(this.directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      const ids = entries.filter(entry => entry.isDirectory() && /^[\w-]{4,64}$/.test(entry.name)).map(entry => entry.name);
      for (const id of this.sessions.keys()) if (!ids.includes(id)) this.sessions.delete(id);
      for (let index = 0; index < ids.length; index += 16) await Promise.all(ids.slice(index, index + 16).map(id => this.readSession(id).catch(() => {})));
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async search(query, limit = 30) {
    const terms = searchTerms(query);
    if (!terms.length) return { terms, results: [] };
    await this.refresh();
    const results = [];
    for (const [sessionId, session] of this.sessions) {
      const title = session.title.toLowerCase();
      // Every term must appear somewhere in the chat, including its title.
      const lowered = session.messages.map(message => message.text.toLowerCase());
      if (!terms.every(term => title.includes(term) || lowered.some(text => text.includes(term)))) continue;
      let best = -1; let bestScore = 0; let matches = 0;
      lowered.forEach((text, index) => {
        const score = terms.filter(term => text.includes(term)).length;
        if (score) matches++;
        if (score > bestScore) { best = index; bestScore = score; }
      });
      if (best < 0) continue;
      const message = session.messages[best];
      results.push({ sessionId, title: session.title, role: message.role, messageIndex: best, matches, score: bestScore, updatedAt: session.updatedAt, snippet: snippet(message.text, terms.filter(term => lowered[best].includes(term))) });
    }
    results.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
    return { terms, results: results.slice(0, limit).map(({ score: _score, ...result }) => result) };
  }
}
