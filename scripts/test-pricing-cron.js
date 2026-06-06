// Tests for the prod pricing cron wiring. Run: node scripts/test-pricing-cron.js
// Guards the scope: ALL 7 units, each pushed INDEPENDENTLY, --confirm --batch 30, 9 AM ET,
// and NO --override-sanity (a sanity trip must HALT + alert, never auto-push). One unit's
// failure must not stop or corrupt the others.
'use strict';
const assert = require('assert');
const cron = require('../src/pricing-cron');

let pass = 0;
const ok = async (n, f) => { await f(); console.log('✓', n); pass++; };
const quiet = { log() {}, error() {} };
const ALL7 = ['4-L', '24-L', '18-A', '21-D', '21-I', '23-N', '7-B'];

(async () => {
  await ok('schedule is 9:00 AM, America/New_York (DST-correct); dead-man 9:30', () => {
    assert.strictEqual(cron.PRICING_CRON_SCHEDULE, '0 9 * * *');
    assert.strictEqual(cron.PRICING_CRON_TZ, 'America/New_York');
    assert.strictEqual(cron.PRICING_HEALTHCHECK_SCHEDULE, '30 9 * * *');
    assert.deepStrictEqual(cron.PRICING_HEALTHCHECK_ARGS, ['--healthcheck']);
  });

  await ok('PRICING_UNITS = exactly the 7 units (no more, no fewer)', () => {
    assert.deepStrictEqual([...cron.PRICING_UNITS].sort(), [...ALL7].sort());
    assert.strictEqual(cron.PRICING_UNITS.length, 7);
  });

  await ok('per-unit args = --unit <U> --confirm --batch 30, NO --override-sanity, exactly one --unit', () => {
    for (const u of cron.PRICING_UNITS) {
      const a = cron.unitArgs(u);
      assert.deepStrictEqual(a, ['--unit', u, '--confirm', '--batch', '30'], `${u} args`);
      assert.ok(!a.includes('--override-sanity'), `${u}: must never auto-push past sanity`);
      assert.strictEqual(a.filter(x => x === '--unit').length, 1, `${u}: exactly one --unit`);
    }
  });

  await ok('runPricingAllUnits spawns the runner once PER unit (7 independent invocations, correct args)', async () => {
    const calls = [];
    const fakeSpawn = (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); cb(null, '', ''); return {}; };
    await cron.runPricingAllUnits(fakeSpawn, quiet);
    assert.strictEqual(calls.length, 7, 'one spawn per unit');
    const unitsSeen = calls.map(c => c.args[c.args.indexOf('--unit') + 1]);
    assert.deepStrictEqual(unitsSeen, ALL7, 'all 7 units, in deterministic order, exactly once each');
    for (const c of calls) {
      assert.strictEqual(c.cmd, 'node');
      assert.ok(c.args[0].endsWith('scripts/pricing-engine-run.js'), 'spawns the engine runner');
      assert.ok(c.args.includes('--confirm') && c.args.includes('--batch') && c.args.includes('30'));
      assert.ok(!c.args.includes('--override-sanity'), 'no unit may auto-push past sanity');
      assert.ok(c.opts && c.opts.env, 'passes process.env (Railway creds)');
    }
  });

  await ok('independence: one unit failing does NOT stop the others (all 7 still attempted)', async () => {
    const seen = [];
    const errSpawn = (cmd, args, opts, cb) => {
      const u = args[args.indexOf('--unit') + 1];
      seen.push(u);
      // 18-A "fails" with a normal non-zero exit (e.g. sanity halt) — runner self-alerts.
      cb(u === '18-A' ? Object.assign(new Error('sanity halt'), { code: 2 }) : null, '', '');
      return {};
    };
    await cron.runPricingAllUnits(errSpawn, quiet);
    assert.deepStrictEqual(seen, ALL7, 'all 7 attempted in order despite 18-A failing — no early abort');
  });

  await ok('runPricingHealthcheck spawns the runner with --healthcheck (dead-man, unchanged)', () => {
    let captured = null;
    cron.runPricingHealthcheck((cmd, args, opts, cb) => { captured = { cmd, args }; return {}; }, quiet);
    assert.strictEqual(captured.cmd, 'node');
    assert.ok(captured.args[0].endsWith('scripts/pricing-engine-run.js'));
    assert.deepStrictEqual(captured.args.slice(1), ['--healthcheck']);
  });

  console.log(`\n${pass}/${pass} passed`);
})().catch(e => { console.error('❌ FAILED:', e.message); process.exit(1); });
