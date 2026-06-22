// Tests that each plain-English command parses to the RIGHT action, that unit/field coercion works,
// and that anything ambiguous or low-confidence collapses to "clarify" (never a stray live action).
// Run: node scripts/test-telegram-intent.js
'use strict';
const assert = require('assert');
const I = require('../src/telegram-intent');

let pass = 0, fail = 0;
const tests = [];
const check = (n, f) => tests.push([n, f]);
const N = (raw) => I.normalizeIntent(raw);

check('cleaning override → multiple ops, units canonicalized, urgent/deadline kept', () => {
  const r = N({ action: 'cleaning_override', confidence: 0.95, ops: [
    { op: 'remove', unit: '24-l' },
    { op: 'add', unit: '21i', urgent: true, deadline: '4:00PM' },
  ] });
  assert.strictEqual(r.action, 'cleaning_override');
  assert.deepStrictEqual(r.ops.map(o => [o.op, o.unit, o.urgent]), [['remove', '24-L', false], ['add', '21-I', true]]);
  assert.strictEqual(r.ops[1].deadline, '4:00PM');
});

check('cleaner_message → message text', () => {
  const r = N({ action: 'cleaner_message', confidence: 0.9, message: 'Skip 7-B today, guest extended.' });
  assert.deepStrictEqual([r.action, r.message], ['cleaner_message', 'Skip 7-B today, guest extended.']);
});

check('checkin_status and checkin_resend', () => {
  assert.strictEqual(N({ action: 'checkin_status', confidence: 0.9 }).action, 'checkin_status');
  const r = N({ action: 'checkin_resend', confidence: 0.9, target: 'Jamie' });
  assert.deepStrictEqual([r.action, r.target], ['checkin_resend', 'Jamie']);
});

check('frontdesk_form → guest name', () => {
  const r = N({ action: 'frontdesk_form', confidence: 0.9, name: 'John Smith' });
  assert.deepStrictEqual([r.action, r.name], ['frontdesk_form', 'John Smith']);
});

check('guest_message keeps guest + gist (does NOT compose here)', () => {
  const r = N({ action: 'guest_message', confidence: 0.9, guest: 'Jamie', gist: 'late checkout is fine, no charge' });
  assert.deepStrictEqual([r.action, r.guest, r.gist], ['guest_message', 'Jamie', 'late checkout is fine, no charge']);
});

check('pricing_adjust normalizes signed pct, dates, units=all', () => {
  const r = N({ action: 'pricing_adjust', confidence: 0.9, pct: -5, start: '2026-06-20', end: '2026-06-29', units: 'all' });
  assert.deepStrictEqual([r.action, r.pct, r.start, r.end, r.units], ['pricing_adjust', -5, '2026-06-20', '2026-06-29', 'all']);
});

check('pricing_adjust with a unit list coerces labels', () => {
  const r = N({ action: 'pricing_adjust', confidence: 0.9, pct: 10, start: '2026-07-01', end: '2026-07-03', units: ['21i', '4l'] });
  assert.deepStrictEqual(r.units, ['21-I', '4-L']);
});

check('pricing_decay_freeze: enable=true default 7 days; disable parsed', () => {
  const on = N({ action: 'pricing_decay_freeze', confidence: 0.9, enable: true, days: 7 });
  assert.deepStrictEqual([on.action, on.enable, on.days], ['pricing_decay_freeze', true, 7]);
  const off = N({ action: 'pricing_decay_freeze', confidence: 0.9, enable: false });
  assert.deepStrictEqual([off.enable, off.days], [false, 7]);
});

check('low confidence → clarify', () => {
  assert.strictEqual(N({ action: 'pricing_adjust', confidence: 0.3, pct: -5, start: '2026-06-20', end: '2026-06-29', units: 'all' }).action, 'clarify');
});

check('missing required fields → clarify (never a half-formed live action)', () => {
  assert.strictEqual(N({ action: 'pricing_adjust', confidence: 0.9, pct: 0 }).action, 'clarify');           // no pct/range
  assert.strictEqual(N({ action: 'cleaning_override', confidence: 0.9, ops: [{ op: 'add', unit: '99-Z' }] }).action, 'clarify'); // unknown unit
  assert.strictEqual(N({ action: 'guest_message', confidence: 0.9, guest: 'Jamie' }).action, 'clarify');     // no gist
  assert.strictEqual(N({ action: 'frontdesk_form', confidence: 0.9 }).action, 'clarify');                    // no name
});

check('unknown/garbage action → clarify', () => {
  assert.strictEqual(N({ action: 'launch_missiles', confidence: 0.99 }).action, 'clarify');
  assert.strictEqual(N('not json at all').action, 'clarify');
});

check('parseIntent runs the model output through normalize (Haiku stub)', async () => {
  const fakeClaude = async (model, _sys, _user) => {
    assert.strictEqual(model, I.PARSE_MODEL); // must use Haiku
    return JSON.stringify({ action: 'cleaner_message', confidence: 0.95, message: 'On my way' });
  };
  const r = await I.parseIntent({ text: 'text Veronica: On my way', callClaude: fakeClaude, today: '2026-06-22' });
  assert.deepStrictEqual([r.action, r.message], ['cleaner_message', 'On my way']);
});

check('parseIntent fails safe to clarify when the model errors', async () => {
  const r = await I.parseIntent({ text: 'hi', callClaude: async () => { throw new Error('boom'); }, today: '2026-06-22' });
  assert.strictEqual(r.action, 'clarify');
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); console.log('✓', n); pass++; }
    catch (e) { console.log('✗', n, '\n   ', e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
