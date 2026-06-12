// Tests for the manual cleaning-schedule override: ADD (append a unit), REMOVE (drop a unit),
// and EXPIRY (a past night's override never carries into a future run). Pure logic — no I/O.
// Run: node scripts/test-cleaning-override.js
'use strict';
const assert = require('assert');
const O = require('../src/cleaning-override');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };
const LABELS = ['Apt 4-L', 'Apt 7-B', 'Apt 18-A', 'Apt 21-D', 'Apt 21-I', 'Apt 23-N', 'Apt 24-L'];

check('canonicalUnit normalizes loose tokens to the unit label (and rejects unknowns)', () => {
  assert.strictEqual(O.canonicalUnit('7-B', LABELS), 'Apt 7-B');
  assert.strictEqual(O.canonicalUnit('7b', LABELS), 'Apt 7-B');
  assert.strictEqual(O.canonicalUnit('apt 4-l', LABELS), 'Apt 4-L');
  assert.strictEqual(O.canonicalUnit('Apt 24-L', LABELS), 'Apt 24-L');
  assert.strictEqual(O.canonicalUnit('99-Z', LABELS), null);
});

check('ADD: applyOverride appends a manual entry for a unit with no checkout', () => {
  const entries = [{ label: 'Apt 18-A', priority: false }];
  const merged = O.applyOverride(entries, { add: ['Apt 7-B'], remove: [] });
  assert.strictEqual(merged.length, 2);
  const a = merged.find(e => e.label === 'Apt 7-B');
  assert.ok(a && a.manual === true && a.priority === false, 'manual entry added');
});

check('ADD is idempotent — never duplicates or downgrades a unit already scheduled', () => {
  const entries = [{ label: 'Apt 7-B', priority: true }]; // already a same-day turnover
  const merged = O.applyOverride(entries, { add: ['Apt 7-B'], remove: [] });
  assert.strictEqual(merged.filter(e => e.label === 'Apt 7-B').length, 1);
  assert.strictEqual(merged[0].priority, true, 'keeps the real priority entry, not a manual dup');
});

check('REMOVE: applyOverride drops a scheduled unit', () => {
  const entries = [{ label: 'Apt 4-L' }, { label: 'Apt 18-A' }];
  const merged = O.applyOverride(entries, { add: [], remove: ['Apt 4-L'] });
  assert.deepStrictEqual(merged.map(e => e.label), ['Apt 18-A']);
});

check('recordOverride: a later opposite action supersedes the earlier one (changed mind)', () => {
  let s = O.recordOverride({}, '2026-06-11', 'add', 'Apt 7-B');
  s = O.recordOverride(s, '2026-06-11', 'remove', 'Apt 7-B');
  assert.deepStrictEqual(s['2026-06-11'].add, []);
  assert.deepStrictEqual(s['2026-06-11'].remove, ['Apt 7-B']);
});

check('EXPIRY: pruneExpired drops past-date overrides, keeps today + future', () => {
  const store = { '2026-06-09': { add: ['Apt 4-L'] }, '2026-06-10': { add: ['Apt 23-N'] }, '2026-06-11': { add: ['Apt 7-B'] } };
  const pruned = O.pruneExpired(store, '2026-06-10'); // today = 06-10
  assert.deepStrictEqual(Object.keys(pruned).sort(), ['2026-06-10', '2026-06-11']); // 06-09 expired
});

check('EXPIRY end-to-end: yesterday’s override does not apply to tonight’s entries', () => {
  // store had an override for 06-09; tonight targets 06-11 → after prune, no override for 06-11
  const store = O.pruneExpired({ '2026-06-09': { add: ['Apt 4-L'], remove: [] } }, '2026-06-11');
  const tonight = store['2026-06-11'];
  const entries = [{ label: 'Apt 18-A' }];
  const merged = O.applyOverride(entries, tonight); // tonight is undefined → unchanged
  assert.deepStrictEqual(merged.map(e => e.label), ['Apt 18-A']);
});

check('normalizeTime parses 4pm / 4:00 PM / 16:00 / 1:30pm → schedule format', () => {
  assert.strictEqual(O.normalizeTime('4pm'), '4:00PM');
  assert.strictEqual(O.normalizeTime('4:00 PM'), '4:00PM');
  assert.strictEqual(O.normalizeTime('16:00'), '4:00PM');
  assert.strictEqual(O.normalizeTime('1:30pm'), '1:30PM');
  assert.strictEqual(O.normalizeTime(''), null);
});

check('PRIORITY/DEADLINE: manualEntry honors priority + ready-by time (defaults 4:00PM)', () => {
  const e = O.manualEntry('Apt 24-L', { priority: true, deadline: '4:00PM' });
  assert.strictEqual(e.priority, true);
  assert.strictEqual(e.deadlineTime, '4:00PM');
  assert.strictEqual(e.manual, true);
  assert.strictEqual(O.manualEntry('Apt 24-L', { priority: true }).deadlineTime, '4:00PM'); // default
  assert.strictEqual(O.manualEntry('Apt 24-L', {}).priority, false); // non-urgent default
});

check('PRIORITY end-to-end: urgent add → priority entry with the 4 PM deadline (routes to URGENTE)', () => {
  const s = O.recordOverride({}, '2026-06-11', 'add', 'Apt 24-L', { priority: true, deadline: '4:00PM' });
  assert.deepStrictEqual(s['2026-06-11'].add, [{ label: 'Apt 24-L', priority: true, deadline: '4:00PM' }]);
  const merged = O.applyOverride([{ label: 'Apt 18-A', priority: false }], s['2026-06-11']);
  const e = merged.find(x => x.label === 'Apt 24-L');
  assert.ok(e && e.priority === true && e.deadlineTime === '4:00PM' && e.manual === true, 'urgent manual entry with deadline');
});

check('UPDATE: override on an already-scheduled unit sharpens deadline + escalates priority — no dup, no drop', () => {
  // 4-L is auto-scheduled as a same-day turnover: priority true, ready-by 4:00PM (unconfirmed).
  const entries = [
    { label: 'Apt 18-A', priority: false, vacancyTime: '11:00AM', vacancyConfirmed: false, deadlineTime: null, deadlineConfirmed: false },
    { label: 'Apt 4-L',  priority: true,  vacancyTime: '11:00AM', vacancyConfirmed: false, deadlineTime: '4:00PM', deadlineConfirmed: false },
  ];
  const s = O.recordOverride({}, '2026-06-13', 'add', 'Apt 4-L', { priority: true, deadline: '1:00PM' });
  const merged = O.applyOverride(entries, s['2026-06-13']);

  const fourL = merged.filter(e => e.label === 'Apt 4-L');
  assert.strictEqual(fourL.length, 1, 'renders exactly ONCE — no duplicate 4-L line');
  assert.strictEqual(merged.length, 2, 'no unit dropped');
  assert.strictEqual(fourL[0].priority, true, 'stays urgent');
  assert.strictEqual(fourL[0].deadlineTime, '1:00PM', 'deadline updated 4PM → 1PM');
});

check('UPDATE end-to-end: rendered SMS shows 4-L once, under ⚡ URGENTE, at 1:00PM', () => {
  const { buildScheduleSMS } = require('../src/server'); // side-effect-free require (require.main guard)
  const entries = [
    { label: 'Apt 4-L', priority: true, vacancyTime: '11:00AM', vacancyConfirmed: false, deadlineTime: '4:00PM', deadlineConfirmed: false },
  ];
  const s = O.recordOverride({}, '2026-06-13', 'add', 'Apt 4-L', { priority: true, deadline: '1:00PM' });
  const sms = buildScheduleSMS(O.applyOverride(entries, s['2026-06-13']), 'Sábado Jun 13');

  assert.ok(/⚡ URGENTE/.test(sms), 'has the urgent section');
  assert.ok(/Apt 4-L .*lista para las 1:00PM/.test(sms), '4-L ready-by reads 1:00PM');
  assert.ok(!/4:00PM/.test(sms), 'old 4:00PM deadline no longer present');
  assert.strictEqual((sms.match(/Apt 4-L/g) || []).length, 1, '4-L appears exactly once in the SMS');
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
