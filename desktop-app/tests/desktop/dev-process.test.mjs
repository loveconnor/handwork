import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { desktopDevProcess } from '../../scripts/desktop-dev-process.mjs';

function fixture() {
  const children = [];
  const exits = [];
  const runner = desktopDevProcess({ delay: 5, onExit: (...args) => exits.push(args), launch() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = signal => { child.signalCode = signal; queueMicrotask(() => child.emit('exit', null, signal)); };
    children.push(child);
    return child;
  } });
  return { runner, children, exits };
}

test('native edits debounce and restart without ending the dev server', async () => {
  const { runner, children, exits } = fixture();
  try {
    runner.start();
    runner.restart();
    runner.restart();
    await wait(50);
    assert.equal(children.length, 2);
    assert.equal(children[0].signalCode, 'SIGTERM');
    assert.deepEqual(exits, []);
    runner.restart();
    await runner.close();
    await wait(30);
    assert.equal(children.length, 2);
    assert.equal(children[1].signalCode, 'SIGTERM');
    runner.restart();
    await wait(30);
    assert.equal(children.length, 2);
  } finally { await runner.close(); }
});

test('normal app exit and launch errors still stop development', async () => {
  for (const failure of [false, true]) {
    const { runner, children, exits } = fixture();
    runner.start();
    const error = new Error('launch failed');
    if (failure) children[0].emit('error', error);
    else { children[0].exitCode = 0; children[0].emit('exit', 0, null); }
    assert.equal(exits[0][0], failure ? 1 : 0);
    if (failure) assert.equal(exits[0][1], error);
    await runner.close();
  }
});
