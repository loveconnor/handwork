import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptFieldKind, promptFormSource, promptFormValues, promptParts } from '../../lib/saved-prompts.ts';
import { fillPrompt, promptVariables } from '../../lib/saved-prompts.ts';

test('each field gets the input that suits its name', () => {
  assert.equal(promptFieldKind('project'), 'text');
  assert.equal(promptFieldKind('changelog'), 'long');
  assert.equal(promptFieldKind('error_log'), 'long');
  assert.equal(promptFieldKind('docs url'), 'url');
  assert.equal(promptFieldKind('reviewer_email'), 'email');
  assert.equal(promptFieldKind('word count'), 'number');
});

test('prompt fields become a Honest AI form with one bound input per field', () => {
  const source = promptFormSource(['project', 'changelog', 'docs url'], { project: 'Say "hi"' });
  assert.match(source, /^\$field0 = "Say \\"hi\\""$/m, 'values are quoted safely');
  assert.match(source, /control0 = FormControl\("Project", Input\("project", "Enter project", "text", \{maxLength: 4000\}, \$field0\)\)/);
  assert.match(source, /control1 = FormControl\("Changelog", TextArea\("changelog", "Paste or describe the changelog", 4, \{maxLength: 4000\}, \$field1\)\)/);
  assert.match(source, /Input\("docs url", "https:\/\/", "url"/);
  assert.match(source, /form = Form\("prompt_fields", actions, \[control0, control1, control2\]\)/);
  assert.match(source, /^root = Stack\(\[form\]\)$/m);
});

test('live form state maps back to field names, and the prompt preview splits text from fields', () => {
  const names = ['project', 'version'];
  assert.deepEqual(promptFormValues({ $field0: 'Handwork', prompt_fields: { version: { value: '0.2.0' } } }, names), { project: 'Handwork', version: '0.2.0' });
  assert.deepEqual(promptFormValues({}, names), { project: '', version: '' });
  const text = 'Notes for {{project}} v{{ version }}.';
  assert.deepEqual(promptParts(text), [{ kind: 'text', text: 'Notes for ' }, { kind: 'field', name: 'project' }, { kind: 'text', text: ' v' }, { kind: 'field', name: 'version' }, { kind: 'text', text: '.' }]);
  assert.deepEqual(promptVariables(text), names);
  assert.equal(fillPrompt(text, { project: 'Handwork' }), 'Notes for Handwork v{{ version }}.', 'empty fields stay as placeholders');
});
