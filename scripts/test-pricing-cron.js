// Tests for the prod pricing cron wiring. Run: node scripts/test-pricing-cron.js
// Guards the deliberate scope: 23-N only, --confirm --batch 30, 9 AM ET, and NO
// --override-sanity (a sanity trip must HALT + alert, never auto-push).
'use strict';
const assert = require('assert');
const cron = require('../src/pricing-cron');

let pass = 0; const ok = (n, f) => { f(); console.log('✓', n); pass++; };

ok('schedule is 9:00 AM, America/New_York (DST-correct)', () => {
  assert.strictEqual(cron.PRICING_CRON_SCHEDULE, '0 9 * * *');
  assert.strictEqual(cron.PRICING_CRON_TZ, 'America/New_York');
});

ok('args = 23-N only, --confirm --batch 30, and NO --override-sanity', () => {
  assert.deepStrictEqual(cron.PRICING_23N_ARGS, ['--unit', '23-N', '--confirm', '--batch', '30']);
  assert.ok(!cron.PRICING_23N_ARGS.includes('--override-sanity'), 'must never auto-push past sanity');
  // only 23-N — no other unit may sneak in
  const otherUnits = ['4-L', '7-B', '18-A', '21-D', '21-I', '24-L'];
  assert.ok(cron.PRICING_23N_ARGS.includes('23-N'));
  assert.ok(!cron.PRICING_23N_ARGS.some(a => otherUnits.includes(a)), 'no other unit may be scheduled');
  assert.strictEqual(cron.PRICING_23N_ARGS.filter(a => a === '--unit').length, 1, 'exactly one --unit');
});

ok('runPricing23N spawns node with the runner + exact args (injected spawn, no side effects)', () => {
  let captured = null;
  const fakeSpawn = (cmd, args, opts, cb) => { captured = { cmd, args, opts }; return {}; };
  const quiet = { log() {}, error() {} };
  cron.runPricing23N(fakeSpawn, quiet);
  assert.strictEqual(captured.cmd, 'node');
  assert.ok(captured.args[0].endsWith('scripts/pricing-engine-run.js'), 'spawns the engine runner');
  assert.deepStrictEqual(captured.args.slice(1), ['--unit', '23-N', '--confirm', '--batch', '30']);
  assert.ok(!captured.args.includes('--override-sanity'));
  assert.ok(captured.opts && captured.opts.env, 'passes process.env (Railway HOSPITABLE_API_KEY)');
});

console.log(`\n${pass}/${pass} passed`);
