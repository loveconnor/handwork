import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionPrompt, actionSubmission } from '../../lib/genui-action.ts';

const action = (params = {}, formState) => ({
  type: 'continue_conversation',
  humanFriendlyMessage: 'Help me plan an Ohio trip using these preferences.',
  params,
  formState,
});

test('GenUI submits readable fields once, using the current form values', () => {
  assert.equal(actionPrompt(action({ context: { destination: 'Ohio', preferences: 'Hiking' } }, {
    $destination: 'Hocking Hills', $preferences: 'Hiking',
  })), 'Help me plan an Ohio trip using these preferences.\n\nDestination: Hocking Hills\nPreferences: Hiking');
});

test('nested fields, selections, and unchecked values remain in the readable prompt', () => {
  const prompt = actionPrompt(action({ context: {
    travelDates: { start_date: '2026-10-20' },
    activities: ['Hiking', 'Museums'],
    flexible: false,
    budget: 0,
    notes: 'First line\nSecond line',
  } }));
  assert.match(prompt, /Travel Dates · Start date: 2026-10-20/);
  assert.match(prompt, /Activities: Hiking, Museums/);
  assert.match(prompt, /Flexible: No/);
  assert.match(prompt, /Budget: 0/);
  assert.match(prompt, /Notes: First line\nSecond line/);
});

test('plain actions stay plain and invalid or oversized actions remain rejected', () => {
  assert.equal(actionPrompt(action()), action().humanFriendlyMessage);
  assert.equal(actionPrompt({ ...action(), type: 'other' }), null);
  assert.equal(actionPrompt({ ...action(), humanFriendlyMessage: ' ' }), null);
  assert.equal(actionPrompt(action({ context: { notes: 'x'.repeat(100_000) } })), null);
});

test('submitted preferences become card fields from the persisted readable prompt', () => {
  const prompt = actionPrompt(action({}, { $destination: 'Hocking Hills', $preferences: 'Hiking\nQuiet trails' }));
  assert.deepEqual(actionSubmission(prompt), {
    message: action().humanFriendlyMessage,
    fields: [{ label: 'Destination', value: 'Hocking Hills' }, { label: 'Preferences', value: 'Hiking\nQuiet trails' }],
  });
  assert.equal(actionSubmission('A normal message.\n\nAnother paragraph.'), null);
});

test('old JSON submissions also display as cards without duplicate fields', () => {
  assert.deepEqual(actionSubmission('Plan a trip.\n\nAction context:\n{"destination":"Ohio"}\n\nSubmitted form values:\n{"$destination":"Hocking Hills"}'), {
    message: 'Plan a trip.', fields: [{ label: 'Destination', value: 'Hocking Hills' }],
  });
  assert.equal(actionSubmission('Plan a trip.\n\nAction context:\ninvalid JSON'), null);
});
