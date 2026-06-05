// In-process daily pricing run for prod (Railway). Mirrors the cleaning cron's pattern:
// node-cron in server.js fires this on a timezone-aware schedule. The actual engine run is
// spawned as a CHILD PROCESS so its process.exit can never take the web server down.
//
// Scope (deliberate): 23-N ONLY, --confirm --batch 30 (read-back verified), and NO
// --override-sanity — a sanity trip must HALT + alert, never auto-push. Snapshots/audit/
// dead-man land in PRICING_DATA_DIR (mounted Railway volume) so they survive redeploys.
'use strict';
const path = require('path');
const { execFile } = require('child_process');
const { buildAlertSender } = require('./alert-notify');
const { buildAlert } = require('./pricing-resilience');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'pricing-engine-run.js');

// 23-N only. NOTE: intentionally no '--override-sanity'.
const PRICING_23N_ARGS = ['--unit', '23-N', '--confirm', '--batch', '30'];
const PRICING_CRON_SCHEDULE = '0 9 * * *';        // 9:00 AM, in PRICING_CRON_TZ
const PRICING_CRON_TZ = 'America/New_York';        // DST-correct via node-cron timezone option

// Run the 23-N pricing engine once. `spawn` and `log` are injectable for tests.
// Dead-man healthcheck — runs 30 min after the daily run. The runner's --healthcheck alerts
// (DEADMAN → SMS) if no successful run is on record within 25h, catching a cron that never fired.
const PRICING_HEALTHCHECK_ARGS = ['--healthcheck'];
const PRICING_HEALTHCHECK_SCHEDULE = '30 9 * * *'; // 9:30 AM, in PRICING_CRON_TZ (after the 09:00 run)

function runPricing23N(spawn = execFile, log = console) {
  log.log('[pricing] Cron fired — 9:00 AM Eastern (23-N)');
  return spawn('node', [RUNNER, ...PRICING_23N_ARGS], { cwd: ROOT, env: process.env }, (err, stdout, stderr) => {
    if (stdout) log.log('[pricing]\n' + String(stdout).trim());
    if (stderr) log.error('[pricing:err] ' + String(stderr).trim());
    if (err) {
      log.error('[pricing] run failed: ' + err.message);
      // The runner SMS-alerts its own failure modes (incl. a top-level crash). Only alert here
      // for a SPAWN failure (it never started → couldn't self-alert): non-numeric exit code.
      if (typeof err.code !== 'number') {
        Promise.resolve(buildAlertSender(process.env)(buildAlert('PRICING_CRON_SPAWN_FAILED', err.message))).catch(() => {});
      }
    }
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
  PRICING_23N_ARGS, PRICING_CRON_SCHEDULE, PRICING_CRON_TZ, runPricing23N, RUNNER,
  PRICING_HEALTHCHECK_ARGS, PRICING_HEALTHCHECK_SCHEDULE, runPricingHealthcheck,
};
