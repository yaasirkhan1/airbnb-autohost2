#!/bin/bash
# Daily DRY-RUN of the pricing CLI. Writes a dated plan to logs/. NEVER commits.
# Invoked by launchd (com.peachtreetowers.pricing-dryrun) at 10:00 AM daily.
set -uo pipefail

PROJECT="/Users/yasserkhan/airbnb-autohost2"
cd "$PROJECT" || exit 1

DATE="$(date +%F)"
LOG="logs/pricing-dryrun-$DATE.log"
CLI="scripts/set-pricing.js"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"

{
  echo "===== Pricing DRY-RUN $(date '+%Y-%m-%d %H:%M:%S %Z') ====="
  if [ ! -f "$CLI" ]; then
    echo "SKIP: $CLI not built yet — automation is parked until the pricing CLI exists."
    echo "      (No prices computed or changed.)"
    exit 0
  fi
  # DRY-RUN ONLY. No --commit anywhere in this script by design.
  # Engine mode reads config/pricing-calendar.json and runs the countdown logic
  # across all 7 live units. Exact flags finalized when the CLI is built.
  "$NODE" "$CLI" --all --calendar config/pricing-calendar.json --horizon 120 --dry-run
  echo "===== end (dry-run, nothing committed) ====="
} >> "$LOG" 2>&1

echo "Wrote $LOG"
