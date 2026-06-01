// TDD for the warm-up grace comparison + seenMessageIds persistence.
// Run: node scripts/test-seen-store.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWithinGrace, loadSeen, saveSeen } = require('../src/seen-store');

let pass = 0;
const check = (name, fn) => { fn(); console.log('✓', name); pass++; };

const NOW = Date.parse('2026-06-01T22:13:52Z');

// ── Grace comparison (the bug: ISO 'T' vs PHP-space string compare) ──
check('17h-old message is NOT within grace → gets marked seen (the bug case)', () => {
  assert.strictEqual(isWithinGrace('2026-06-01T05:32:00Z', NOW), false);
});
check('9h-old message is NOT within grace', () => {
  assert.strictEqual(isWithinGrace('2026-06-01T13:32:00Z', NOW), false);
});
check('2-min-old message IS within grace → correctly left unseen', () => {
  assert.strictEqual(isWithinGrace('2026-06-01T22:11:52Z', NOW), true);
});
check('missing/invalid timestamp → not within grace (safe: mark seen)', () => {
  assert.strictEqual(isWithinGrace(undefined, NOW), false);
  assert.strictEqual(isWithinGrace('not-a-date', NOW), false);
});
check('regression control: the OLD string compare wrongly called the 17h-old msg "recent"', () => {
  const toPhp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const graceCutoff = toPhp(NOW - 5 * 60 * 1000);            // "2026-06-01 22:08:52"
  const oldResult = '2026-06-01T05:32:00Z' > graceCutoff;     // string compare (the bug)
  assert.strictEqual(oldResult, true, 'old code left it unseen (bug)');
  assert.strictEqual(isWithinGrace('2026-06-01T05:32:00Z', NOW), false, 'new code marks it seen (fixed)');
});

// ── Persistence round-trip ──
check('saveSeen → loadSeen round-trips the keys', () => {
  const file = path.join(os.tmpdir(), `seen-test-${Date.now()}.json`);
  const original = new Set(['resA:plat1', 'resB:plat2', 'inquiry:x:warmed']);
  assert.strictEqual(saveSeen(original, file), true);
  const loaded = loadSeen(file);
  assert.deepStrictEqual([...loaded].sort(), [...original].sort());
  fs.unlinkSync(file);
});
check('loadSeen on a missing file → empty Set (no throw)', () => {
  const loaded = loadSeen(path.join(os.tmpdir(), `nope-${Date.now()}.json`));
  assert.ok(loaded instanceof Set && loaded.size === 0);
});

console.log(`\nRESULT: ${pass}/7 passed`);
