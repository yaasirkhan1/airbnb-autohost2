// End-to-end proof that --rollback restores a calendar to its EXACT pre-push state.
// Flow: seed a known calendar → real push run (snapshots, then changes prices) →
//       --rollback that snapshot → confirm every night == pre-push price + min-stay.
// Uses rollback-mock.js (stateful, persisted) so writes survive across runner processes.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'data', '.rollback-mock-state.json');
const RUNNER = path.join(ROOT, 'scripts', 'pricing-engine-run.js');
const MOCK = path.join(ROOT, 'scripts', 'rollback-mock.js');

// Dragon Con nights for 4-L → engine computes set $500 / min 5, so a push WILL change
// both price and min-stay away from the seed below (a real, observable change to undo).
const DATES = ['2026-09-04', '2026-09-05', '2026-09-06'];
const SEED = {};
for (const d of DATES) SEED[d] = { price: 120, minStay: 2 }; // known pre-push state
fs.writeFileSync(STATE, JSON.stringify({ cal: SEED }));
const before = JSON.parse(JSON.stringify(SEED));

const run = (args) => execFileSync('node', ['--require', MOCK, RUNNER, ...args], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, HOSPITABLE_API_KEY: 'mocktoken' },
});

// 1) PUSH — real write run; snapshots pre-push state, then changes the calendar.
const pushOut = run(['--unit', '4-L', '--start', DATES[0], '--end', DATES[DATES.length - 1],
  '--confirm', '--batch', '30', '--override-sanity']);
const snapPath = (pushOut.match(/snapshot saved: (\S+)/) || [])[1];
assert.ok(snapPath && fs.existsSync(snapPath), 'snapshot file should have been written');
const afterPush = JSON.parse(fs.readFileSync(STATE, 'utf8')).cal;

// 2) ROLLBACK — restore the snapshot's prior values, read-back verified.
const rbOut = run(['--rollback', snapPath, '--confirm']);
const afterRollback = JSON.parse(fs.readFileSync(STATE, 'utf8')).cal;

// 3) Report before / after-push / after-rollback, then assert exact restore.
console.log('\n================= ROLLBACK PROOF (4-L, Dragon Con nights) =================');
console.log('date         BEFORE(push)     AFTER push        AFTER rollback');
for (const d of DATES) {
  const f = x => `$${x.price}/min${x.minStay}`;
  console.log(`${d}   ${f(before[d]).padEnd(15)}  ${f(afterPush[d]).padEnd(16)}  ${f(afterRollback[d])}`);
}

let restored = true;
for (const d of DATES) {
  try {
    assert.strictEqual(afterRollback[d].price, before[d].price, `${d} price`);
    assert.strictEqual(afterRollback[d].minStay, before[d].minStay, `${d} min-stay`);
    // sanity: the push actually changed something, so this is a real undo, not a no-op
    assert.notStrictEqual(afterPush[d].price, before[d].price, `${d} push should have changed price`);
  } catch (e) { restored = false; console.error('✗', e.message); }
}

console.log('\nrunner push line: ' + (pushOut.match(/pushed \+ verified.*$/m) || ['(none)'])[0]);
console.log('runner rollback line: ' + (rbOut.match(/ROLLBACK complete.*$/m) || ['(none)'])[0]);
try { fs.unlinkSync(STATE); } catch {}
if (restored) console.log('\n✅ PROOF PASSED — every night restored to its exact pre-push price AND min-stay.');
else { console.log('\n❌ PROOF FAILED — restore did not match pre-push state.'); process.exit(1); }
