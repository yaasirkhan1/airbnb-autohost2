// In-process daily pricing run for prod (Railway). Mirrors the cleaning cron's pattern:
// node-cron in server.js fires this on a timezone-aware schedule. The actual engine run is
// spawned as a CHILD PROCESS so its process.exit can never take the web server down.
//
// Scope: ALL 7 units, each pushed INDEPENDENTLY (its own runner invocation → own snapshot,
// sanity check, read-back, lock). One unit's sanity-halt / 422 / read-back-mismatch aborts
// ONLY that unit (the runner self-alerts) and never blocks or corrupts the others. Units run
// SEQUENTIALLY because the runner holds a lockfile (parallel spawns would collide).
// Per-unit args: --confirm --batch 30 (read-back verified), and NO --override-sanity —
// a sanity trip must HALT + alert, never auto-push. Snapshots/audit/dead-man land in
// PRICING_DATA_DIR (mounted Railway volume) so they survive redeploys.
'use strict';
const path = require('path');
const { execFile } = require('child_process');
const { buildAlertSender } = require('./alert-notify');
const { buildAlert } = require('./pricing-resilience');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'pricing-engine-run.js');
const DECAY_RUNNER = path.join(ROOT, 'scripts', 'decay-run.js');
const WC_FILL_RUNNER = path.join(ROOT, 'scripts', 'wc-fill-run.js');

// Vacancy decay passes — 9:00 AM / 3:00 PM / 7:00 PM in PRICING_CRON_TZ (Eastern). Each
// pass ratchets the fenced units' nightly price down one step (floored, booked-skip). The
// runner self-no-ops once its campaign window is past, so these schedules need no teardown.
const DECAY_CRON_SCHEDULES = ['0 9 * * *', '0 15 * * *', '0 19 * * *'];

// All 7 units, pushed one-at-a-time (independent runs). Order is deterministic.
const PRICING_UNITS = ['4-L', '24-L', '18-A', '21-D', '21-I', '23-N', '7-B'];
// Per-unit args. NOTE: intentionally no '--override-sanity'.
const unitArgs = (unit) => ['--unit', unit, '--confirm', '--batch', '30'];
const PRICING_CRON_SCHEDULE = '0 9 * * *';        // 9:00 AM, in PRICING_CRON_TZ
const PRICING_CRON_TZ = 'America/New_York';        // DST-correct via node-cron timezone option

// Run the 23-N pricing engine once. `spawn` and `log` are injectable for tests.
// Dead-man healthcheck — runs 30 min after the daily run. The runner's --healthcheck alerts
// (DEADMAN → SMS) if no successful run is on record within 25h, catching a cron that never fired.
const PRICING_HEALTHCHECK_ARGS = ['--healthcheck'];
const PRICING_HEALTHCHECK_SCHEDULE = '30 9 * * *'; // 9:30 AM, in PRICING_CRON_TZ (after the 09:00 run)

// Push ONE unit (its own runner invocation). Resolves when the child exits — ALWAYS resolves
// (never rejects) so one unit's failure can't stop the loop or corrupt the others. The runner
// owns its own failure alerts (sanity-halt / 422 / read-back mismatch → SMS); we only add an
// alert here for a SPAWN failure (it never started → couldn't self-alert): non-numeric code.
function runPricingUnit(unit, spawn = execFile, log = console) {
  return new Promise((resolve) => {
    spawn('node', [RUNNER, ...unitArgs(unit)], { cwd: ROOT, env: process.env }, (err, stdout, stderr) => {
      if (stdout) log.log(`[pricing:${unit}]\n` + String(stdout).trim());
      if (stderr) log.error(`[pricing:${unit}:err] ` + String(stderr).trim());
      if (err) {
        log.error(`[pricing:${unit}] run failed: ` + err.message);
        if (typeof err.code !== 'number') {
          Promise.resolve(buildAlertSender(process.env)(buildAlert('PRICING_CRON_SPAWN_FAILED', `${unit}: ${err.message}`))).catch(() => {});
        }
      }
      resolve(); // independence: continue to the next unit regardless of this one's outcome
    });
  });
}

// Run all 7 units SEQUENTIALLY (the runner holds a lockfile — no parallel). Each is an
// independent push; a halt/alert on one does not affect the rest.
async function runPricingAllUnits(spawn = execFile, log = console) {
  log.log(`[pricing] Cron fired — 9:00 AM Eastern (all ${PRICING_UNITS.length} units, independent pushes)`);
  for (const unit of PRICING_UNITS) {
    await runPricingUnit(unit, spawn, log);
  }
  log.log('[pricing] Cron run complete — all units attempted');
}

// One vacancy-decay pass (its own runner invocation). Spawned as a child so its exit can
// never take the web server down. ALWAYS resolves; a spawn failure (couldn't start → can't
// self-alert) raises one alert. The runner itself is fail-closed and self-no-ops when its
// campaign window is past.
function runDecayPass(spawn = execFile, log = console) {
  return new Promise((resolve) => {
    log.log('[decay] Pass firing (ratchet step, floored, booked-skip)');
    spawn('node', [DECAY_RUNNER, '--confirm'], { cwd: ROOT, env: process.env }, (err, stdout, stderr) => {
      if (stdout) log.log('[decay]\n' + String(stdout).trim());
      if (stderr) log.error('[decay:err] ' + String(stderr).trim());
      if (err) {
        log.error('[decay] run failed: ' + err.message);
        if (typeof err.code !== 'number') {
          Promise.resolve(buildAlertSender(process.env)(buildAlert('DECAY_CRON_SPAWN_FAILED', err.message))).catch(() => {});
        }
      }
      resolve();
    });
  });
}

// One World Cup FILL decay pass (Jun 14–26). Spawned as a child like the decay pass — its exit
// can't take the web server down; always resolves; self-no-ops once the window passes or the
// kill switch (WC_FILL.active / WC_FILL_OFF) is off. Shares the 9/15/19 ET decay schedule.
function runWcFillPass(spawn = execFile, log = console) {
  return new Promise((resolve) => {
    log.log('[wc-fill] Pass firing (seed already applied; ratchet to floor, booked-skip)');
    spawn('node', [WC_FILL_RUNNER, '--confirm'], { cwd: ROOT, env: process.env }, (err, stdout, stderr) => {
      if (stdout) log.log('[wc-fill]\n' + String(stdout).trim());
      if (stderr) log.error('[wc-fill:err] ' + String(stderr).trim());
      if (err) {
        log.error('[wc-fill] run failed: ' + err.message);
        if (typeof err.code !== 'number') {
          Promise.resolve(buildAlertSender(process.env)(buildAlert('WC_FILL_CRON_SPAWN_FAILED', err.message))).catch(() => {});
        }
      }
      resolve();
    });
  });
}

// Fires the dead-man check (the runner alerts if stale). Runs as its own scheduled job.
function runPricingHealthcheck(spawn = execFile, log = console) {
  log.log('[pricing] Dead-man healthcheck firing');
  return spawn('node', [RUNNER, ...PRICING_HEALTHCHECK_ARGS], { cwd: ROOT, env: process.env }, (err, stdout, stderr) => {
    if (stdout) log.log('[pricing] ' + String(stdout).trim());
    if (stderr) log.error('[pricing:hc] ' + String(stderr).trim());
    // exit 4 = STALE (the runner already SMS-alerted DEADMAN); non-zero exit is expected then.
  });
}

module.exports = {
  PRICING_UNITS, unitArgs, PRICING_CRON_SCHEDULE, PRICING_CRON_TZ, runPricingUnit, runPricingAllUnits, RUNNER,
  PRICING_HEALTHCHECK_ARGS, PRICING_HEALTHCHECK_SCHEDULE, runPricingHealthcheck,
  DECAY_RUNNER, DECAY_CRON_SCHEDULES, runDecayPass,
  WC_FILL_RUNNER, runWcFillPass,
};
