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

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'pricing-engine-run.js');

// 23-N only. NOTE: intentionally no '--override-sanity'.
const PRICING_23N_ARGS = ['--unit', '23-N', '--confirm', '--batch', '30'];
const PRICING_CRON_SCHEDULE = '0 9 * * *';        // 9:00 AM, in PRICING_CRON_TZ
const PRICING_CRON_TZ = 'America/New_York';        // DST-correct via node-cron timezone option

// Run the 23-N pricing engine once. `spawn` and `log` are injectable for tests.
function runPricing23N(spawn = execFile, log = console) {
  log.log('[pricing] Cron fired — 9:00 AM Eastern (23-N)');
  return spawn('node', [RUNNER, ...PRICING_23N_ARGS], { cwd: ROOT, env: process.env }, (err, stdout, stderr) => {
    if (stdout) log.log('[pricing]\n' + String(stdout).trim());
    if (stderr) log.error('[pricing:err] ' + String(stderr).trim());
    if (err) log.error('[pricing] run failed: ' + err.message);
  });
}

module.exports = { PRICING_23N_ARGS, PRICING_CRON_SCHEDULE, PRICING_CRON_TZ, runPricing23N, RUNNER };
