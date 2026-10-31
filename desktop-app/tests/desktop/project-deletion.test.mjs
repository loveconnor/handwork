import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/project-store.mjs';
import { DesktopBackend } from '../../electron/backend.mjs';

for (const versioned of [false, true]) {
  test(`project removal persists without deleting files or other metadata (${versioned ? 'versioned' : 'array'} registry)`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'handwork-project-delete-'));
    try {
      const folder = path.join(directory, 'project');
      const other = path.join(directory, 'other');
      mkdirSync(folder);
      writeFileSync(path.join(folder, 'keep.txt'), 'keep me');
      const file = path.join(directory, 'projects.json');
      const remaining = { path: other, name: 'Other', sessions: ['saved-chat'], custom: true };
      writeFileSync(file, JSON.stringify(versioned ? { version: 1, custom: 'preserved', projects: [{ path: folder }, remaining] } : [folder, other]));
      const projects = new ProjectStore(file);
      const backend = new DesktopBackend({ projects, settingsService: { home: directory } });
      backend.workspace = folder;
      assert.deepEqual(backend.removeProject(folder), [other]);
      assert.deepEqual(new ProjectStore(file).list(), [other]);
      assert.equal(readFileSync(path.join(folder, 'keep.txt'), 'utf8'), 'keep me');
      assert.equal(backend.workspace, folder, 'removing the sidebar project must not interrupt its active chat');
      if (versioned) assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, custom: 'preserved', projects: [remaining] });
      assert.deepEqual(projects.remove(folder), [other], 'repeated deletion is harmless');
      projects.add(folder);
      assert.deepEqual(new ProjectStore(file).list(), [folder, other]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('in-memory projects can be removed, including the final project', () => {
  const projects = new ProjectStore();
  projects.add('/project');
  assert.deepEqual(projects.remove('/missing'), ['/project']);
  assert.deepEqual(projects.remove('/project'), []);
  assert.deepEqual(projects.list(), []);
});
