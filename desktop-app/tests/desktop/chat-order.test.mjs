import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSidebarChats, sortChatsByRecency } from '../../lib/chat-order.ts';

const chat = (id, updatedAt, workspace = '') => ({ id, label: id, workspace, updatedAt });
const ids = chats => chats.map(chat => chat.id);

test('project and normal chats are newest first regardless of open tab or saved list order', () => {
  const saved = [
    chat('project-old', '2026-10-15T12:00:00Z', '/project'),
    chat('normal-old', '2026-10-15T12:00:00Z'),
    chat('project-new', '2026-10-17T12:00:00Z', '/project'),
    chat('normal-new', '2026-10-17T12:00:00Z'),
  ];
  const tabs = [chat('project-old', undefined, '/project'), chat('normal-old', undefined)];
  const result = sortChatsByRecency(mergeSidebarChats(tabs, saved, ['/project']));
  assert.deepEqual(ids(result.filter(chat => chat.workspace === '/project')), ['project-new', 'project-old']);
  assert.deepEqual(ids(result.filter(chat => !chat.workspace)), ['normal-new', 'normal-old']);
  assert.equal(result.length, 4, 'open saved chats are not duplicated');
  assert.equal(saved[0].id, 'project-old', 'input lists are not reordered in place');
});

test('live activity moves an open chat up immediately, even before saved history refreshes', () => {
  for (const workspace of ['', '/project']) {
    const saved = [chat('old', '2026-10-15T12:00:00Z', workspace), chat('recent', '2026-10-16T12:00:00Z', workspace)];
    const tabs = [{ ...saved[0], label: 'Live title', updatedAt: '2026-10-17T12:00:00Z' }];
    const result = sortChatsByRecency(mergeSidebarChats(tabs, saved, ['/project']));
    assert.deepEqual(ids(result), ['old', 'recent']);
    assert.equal(result[0].label, 'Live title');
    assert.equal(result[0].updatedAt, tabs[0].updatedAt);
  }
});

test('new blank chats appear first and saved background activity replaces older tab dates', () => {
  const tabs = [chat('open', '2026-10-15T12:00:00Z'), chat('new', '2026-10-17T12:00:00Z')];
  const saved = [chat('closed', '2026-10-16T12:00:00Z'), chat('open', '2026-10-16T18:00:00Z')];
  const result = sortChatsByRecency(mergeSidebarChats(tabs, saved, []));
  assert.deepEqual(ids(result), ['new', 'open', 'closed']);
  assert.equal(result[1].updatedAt, saved[1].updatedAt);
});

test('pins retain precedence with newest first within pinned and unpinned chats', () => {
  const result = sortChatsByRecency([
    chat('recent', '2026-10-17T12:00:00Z'),
    { ...chat('pin-old', '2026-10-14T12:00:00Z'), pinned: true },
    chat('old', '2026-10-15T12:00:00Z'),
    { ...chat('pin-new', '2026-10-16T12:00:00Z'), pinned: true },
  ]);
  assert.deepEqual(ids(result), ['pin-new', 'pin-old', 'recent', 'old']);
});

test('missing and invalid dates sort last with stable ties; removed project history stays hidden', () => {
  const saved = [chat('missing'), chat('valid', '2026-10-17T12:00:00Z'), chat('invalid', 'not-a-date'), chat('tie', '2026-10-17T12:00:00Z'), chat('removed', '2026-10-18T12:00:00Z', '/removed')];
  assert.deepEqual(ids(sortChatsByRecency(mergeSidebarChats([], saved, []))), ['valid', 'tie', 'missing', 'invalid']);
});
