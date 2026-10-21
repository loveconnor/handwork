import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { readSidebarKeys, orderSidebarChats, visibleSidebarChats, sidebarChatTime } from '../../lib/sidebar-chats.ts';

test('sidebar selection, unread and attention cues stay distinct during interaction', () => {
  const component = readFileSync(new URL('../../components/site/HandworkSidebarContent.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../desktop/desktop.css', import.meta.url), 'utf8');
  assert.match(component, /<span className="handwork-chat-unread" aria-hidden \/>/);
  assert.doesNotMatch(component, /<(Check|Circle)\s/);
  assert.match(component, /className="handwork-group-mark" data-kind=/);
  assert.match(css, /\.handwork-group-signal \{[^}]*margin-inline-start: 4px;/);
  assert.doesNotMatch(css, /\.handwork-group-signal \{[^}]*margin-left: auto/);
  assert.doesNotMatch(component, /working \? '·' : '•'/);
  assert.match(css, /\.handwork-group-mark:not\(\[data-kind="needs"\]\) \{ width: 3px; height: 3px; border-radius: 50%; background: currentColor;/);
  assert.match(component, /: <span className="handwork-chat-status" aria-hidden \/>/);
  assert.match(component, /data-status=\{flagged \|\| running \|\| undefined\}/);
  assert.match(css, /\.handwork-chat-item\.is-active \{ background: var\(--hui-color-background-neutral-secondary\); \}/);
  assert.match(css, /\.handwork-chat-item:hover[^}]*55%, transparent/);
  assert.doesNotMatch(css, /\.handwork-chat-item\.is-active \{[^}]*box-shadow/);
  assert.match(css, /\.handwork-show-more \{ align-self: flex-start; width: fit-content; margin-inline-start: 24px; min-height: 30px; height: 30px; text-align: start; \}/);
  assert.doesNotMatch(css, /\.handwork-show-more \{[^}]*padding-inline-start/);
  assert.match(css, /\.handwork-sidebar \[data-slot="sidebar-content"\] \{[^}]*padding-block: 16px;[^}]*scroll-padding-block: 16px;[^}]*mask-image: linear-gradient\(to bottom, transparent, #000 16px, #000 calc\(100% - 16px\), transparent\)/);
  assert.match(css, /:is\(:hover, :focus-within, :has\(\[data-popup-open\]\)\) \.handwork-chat-time:not\(\[data-status\]\) \{ visibility: hidden; \}/);
  assert.match(css, /@media \(hover: none\) \{ \.handwork-chat-time:not\(\[data-status\]\) \{ display: none; \} \}/);
});

test('sidebar preferences tolerate missing, malformed and inaccessible values', () => {
  for (const value of [null, '', '{', '{}', '[null]', '[1]']) assert.deepEqual(readSidebarKeys(value), []);
  assert.deepEqual(readSidebarKeys('["a","a","b"]'), ['a', 'b']);
});

test('background activity cannot move existing chats; pins and new chats remain discoverable', () => {
  const chats = [{ id: 'b', updatedAt: '2026-10-21' }, { id: 'a' }, { id: 'new' }, { id: 'pin', pinned: true }];
  assert.deepEqual(orderSidebarChats(chats, ['a', 'b']).map(chat => chat.id), ['pin', 'new', 'a', 'b']);
  assert.deepEqual(chats.map(chat => chat.id), ['b', 'a', 'new', 'pin']);
  assert.deepEqual(orderSidebarChats(chats, []).map(chat => chat.id), ['pin', 'b', 'a', 'new']);
});

test('short groups never hide selected, pinned, working or actionable chats', () => {
  const chats = Array.from({ length: 12 }, (_, i) => ({ id: String(i), pinned: i === 10 }));
  const attention = new Map([['7', 'approval'], ['8', 'failed'], ['9', 'queue']]);
  assert.deepEqual(visibleSidebarChats(chats, false, '6', attention, new Set(['11'])).map(chat => chat.id), ['0', '1', '2', '3', '4', '6', '7', '8', '9', '10', '11']);
  assert.equal(visibleSidebarChats(chats, true, '', attention), chats);
  assert.deepEqual(visibleSidebarChats([], false, ''), []);
});

test('row times handle missing dates, future dates and minute/day boundaries', () => {
  const now = Date.UTC(2026, 9, 21, 12);
  assert.equal(sidebarChatTime(undefined, now), '');
  assert.equal(sidebarChatTime('invalid', now), '');
  for (const [minutes, label] of [[-1, 'now'], [0, 'now'], [1, '1m'], [59, '59m'], [60, '1h'], [1440, '1d']]) {
    assert.equal(sidebarChatTime(new Date(now - minutes * 60_000).toISOString(), now), label);
  }
});
