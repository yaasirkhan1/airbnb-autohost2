// Tests for the legacy demand-engine kill-switches. Run: node scripts/test-legacy-killswitch.js
// Asserts an excluded property ID is skipped by the old engine, and the on/off switch.
'use strict';
const assert = require('assert');
const { legacyEngineEnabled, legacyEngineExcluded } = require('../src/server.js');

let pass = 0; const ok = (n, f) => { f(); console.log('✓', n); pass++; };
const N23 = '283977a3-3af3-4d90-8d95-b418a3014d90'; // 23-N
const OTHER = 'bbe43523-c42a-46b0-8235-7ad08ae990c9'; // 4-L

// ── PRICING_LEGACY_EXCLUDE ──
ok('excluded ID is skipped; non-excluded IDs are NOT', () => {
  const env = { PRICING_LEGACY_EXCLUDE: N23 };
  assert.strictEqual(legacyEngineExcluded(N23, env), true, '23-N must be skipped by the old engine');
  assert.strictEqual(legacyEngineExcluded(OTHER, env), false, '4-L must still be processed');
});
ok('default (unset) → nothing excluded (current behavior preserved)', () => {
  assert.strictEqual(legacyEngineExcluded(N23, {}), false);
  assert.strictEqual(legacyEngineExcluded(N23, { PRICING_LEGACY_EXCLUDE: '' }), false);
});
ok('comma list with spaces + multiple IDs handled', () => {
  const env = { PRICING_LEGACY_EXCLUDE: ` ${N23} , ${OTHER} ` };
  assert.strictEqual(legacyEngineExcluded(N23, env), true);
  assert.strictEqual(legacyEngineExcluded(OTHER, env), true);
  assert.strictEqual(legacyEngineExcluded('7b7fda8b-e1d8-460f-8143-59a1a2b4d81c', env), false);
});

// ── PRICING_LEGACY_ENGINE ──
ok('engine on by default; only exact "off" disables', () => {
  assert.strictEqual(legacyEngineEnabled({}), true);                       // default ON
  assert.strictEqual(legacyEngineEnabled({ PRICING_LEGACY_ENGINE: 'off' }), false);
  assert.strictEqual(legacyEngineEnabled({ PRICING_LEGACY_ENGINE: 'on' }), true);
  assert.strictEqual(legacyEngineEnabled({ PRICING_LEGACY_ENGINE: 'OFF' }), true); // case-sensitive; not "off"
});

// ── Simulate the loop's filtering: excluded unit is dropped from the processed set ──
ok('loop filtering: with 23-N excluded, old engine processes the other 6 only', () => {
  const ALL = [
    '1af8fdde-58ee-426e-8374-6530397347e8', '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc',
    'bbe43523-c42a-46b0-8235-7ad08ae990c9', '80c21aac-00eb-49af-9094-6792839ff5a4',
    '3e702102-a219-4c18-9f88-3a4d1ceb3825', N23, '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c',
  ];
  const env = { PRICING_LEGACY_EXCLUDE: N23 };
  const processed = ALL.filter(id => !legacyEngineExcluded(id, env));
  assert.strictEqual(processed.length, 6, 'exactly 6 units still managed by the legacy engine');
  assert.ok(!processed.includes(N23), '23-N is NOT processed by the legacy engine');
});

console.log(`\n${pass}/${pass} passed`);
