#!/bin/bash
# Daily LIVE pricing run for 23-N ONLY, via the resilience-guarded engine.
# 1) dead-man --healthcheck on the PRIOR run (alerts if last success > 25h ago)
# 2) today's live run: 23-N --confirm --batch 30
# NOTE: NO --override-sanity here by design. Steady-state daily runs are small; if one ever
# trips the sanity check it should HALT + alert (bad-data signature), not auto-push. Use
# --override-sanity only for deliberate manual runs after you've verified the data.
# Snapshots fire automatically before any write (rollback armed in data/snapshots/).
# launchd: com.peachtreetowers.pricing-23n @ 09:00 daily. NEVER touches other units.
set -uo pipefail

PROJECT="/Users/yasserkhan/airbnb-autohost2"
cd "$PROJECT" || exit 1
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
DATE="$(date +%F)"
mkdir -p logs
LOG="logs/pricing-23n-$DATE.log"

{
  echo "===== 23-N daily pricing $(date '+%F %T %Z') ====="
  echo "--- [1] dead-man healthcheck (alerts if prior success > 25h) ---"
  "$NODE" scripts/pricing-engine-run.js --healthcheck || echo "(healthcheck flagged STALE — see [ALERT] above; today's run still proceeds)"
  echo "--- [2] live run: 23-N --confirm --batch 30 (sanity HALT is enforced, NOT overridden) ---"
  "$NODE" scripts/pricing-engine-run.js --unit 23-N --confirm --batch 30
  echo "===== end $(date '+%T') (exit $?) ====="
} >> "$LOG" 2>&1

echo "Wrote $LOG"
