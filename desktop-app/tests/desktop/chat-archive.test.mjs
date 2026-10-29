import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopBackend } from '../../electron/backend.mjs';
import { ChatPreferences } from '../../electron/chat-preferences.mjs';
import { validateArguments } from '../../electron/ipc.mjs';

function backend() {
  const chatPreferences = new ChatPreferences();
  const app = new DesktopBackend({ chatPreferences, settingsService: { home: '/tmp' }, chatDirectory: '/tmp/handwork-chats' });
  app.recentSessions = [{ sessionId: 'done', title: 'Finished work', cwd: '/project' }, { sessionId: 'open', title: 'Ongoing', cwd: '/project' }];
  return app;
}

test('archiving is a reversible preference that saved chat lists report', () => {
  const app = backend();
  app.updateChat('done', { archived: true, pinned: true });
  let sessions = app.listCachedSessions().sessions;
  assert.deepEqual(sessions.map(session => [session.sessionId, session.archived]), [['done', true], ['open', false]]);
  assert.equal(sessions[0].pinned, true, 'a pin survives archiving and returns on restore');
  app.updateChat('done', { archived: false });
  sessions = app.listCachedSessions().sessions;
  assert.equal(sessions[0].archived, false);
  assert.equal(sessions[0].title, 'Finished work', 'history is untouched');
  assert.throws(() => app.updateChat('missing', { archived: true }), /no longer available/);
});

test('the archive flag must be a boolean and travels with other chat changes', () => {
  assert.doesNotThrow(() => validateArguments('updateChat', ['chat', { archived: true }]));
  assert.doesNotThrow(() => validateArguments('updateChat', ['chat', { archived: false, pinned: false }]));
  for (const changes of [{ archived: 'yes' }, { archived: 1 }, { hidden: true }, {}]) {
    assert.throws(() => validateArguments('updateChat', ['chat', changes]), /argument 2/);
  }
});
