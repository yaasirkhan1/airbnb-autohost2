# Pricing Engine — Launch Checklist

Engine: `scripts/pricing-engine-run.js` (resilience layer in `src/pricing-resilience.js`).
Default = DRY RUN. Real writes need `--confirm`. Snapshots auto-arm before every push.

---

## Status

| Unit | State | Notes |
|------|-------|-------|
| **23-N** | ✅ LIVE | Priced **2026-06-05 → 2026-12-01** (121 nights). 2026-12-02 → 2027-06-04 = **BLOCKED/unavailable** (host availability not open that far out — will price automatically as it opens). Beyond-window 2027 events (Summer 2027 Jul, Dragon Con 2027 Sep) need a wider `--days`/`--end`. |
| 4-L, 24-L, 18-A, 21-D, 7-B, 21-I | ⛔ not launched | Dynamic pricing must be turned OFF first (see below). |

**Daily cron (live):** `com.peachtreetowers.pricing-23n` → `scripts/daily-pricing-23n.sh` @ 09:00. Runs `--healthcheck` (dead-man, alerts if no success in 25h) then `23-N --confirm --batch 30`. **No `--override-sanity` on the daily job** — if a run ever trips sanity it HALTs + alerts (never auto-pushes). `--override-sanity` is for manual runs only, after verifying the data.
- Disable: `launchctl unload ~/Library/LaunchAgents/com.peachtreetowers.pricing-23n.plist`
- (The old `com.peachtreetowers.pricing-dryrun` @ 10:00 is the legacy parked dry-run — unrelated.)

---

## Expand to another unit (repeat per unit U ∈ {4-L, 24-L, 18-A, 21-D, 7-B, 21-I})

1. **Turn OFF dynamic/Smart pricing for U in Hospitable.** Two engines fighting one calendar = silent no-ops / 422s. The run's pre-flight will HALT if it's still on, but turn it off first.

2. **Dry-run & review** (read-only, writes nothing):
   ```
   node scripts/pricing-engine-run.js --unit U --days 180
   ```
   Check: normal nights in band, events at set prices, World Cup SKIP, booked nights left alone.

3. **Go live** (pre-flight + snapshot run automatically as the first steps):
   ```
   node scripts/pricing-engine-run.js --unit U --confirm --batch 30 --override-sanity
   ```
   Pre-flight verifies property-ID/bedroom match + dynamic-pricing-off and **HALTs before any write** if either fails (fail-closed — calendar untouched). A snapshot is saved to `data/snapshots/` before the first push.

4. **Add U to the daily cron** once happy: edit `scripts/daily-pricing-23n.sh`, change `--unit 23-N` to a comma list, e.g. `--unit 23-N,U`.

Price bands (sanity reference): 1BR $175–$799, 2BR (21-I) $250–$1,199 ceilings per CLAUDE.md; engine floors/ceilings live in `src/pricing-config.json`.

---

## Watch the logs

- Run log: `logs/pricing-23n-<date>.log` · audit: `data/pricing-audit.log` (every write, old→new) · runs: `data/pricing-runs.log` · alerts: `data/pricing-alerts.log`
- **Good:** `pushed + verified (N nights)`, `⏳ read-back stale … retrying` (normal — Hospitable read-after-write lag, self-heals).
- **Stop and look:** `[ALERT] …`, `⛔ HALT`, `READ-BACK MISMATCH` (persisted after retries = real no-op), `BLOCKED 422 (dynamic pricing)` (DP still on), `MAPPING_DRIFT` (config↔Hospitable mismatch), `DEAD-MAN … STALE` (cron didn't run in 25h).

---

## Rollback (undo a bad push)

Every `--confirm` push snapshots prior price + min-stay first. To restore:
```
ls -t data/snapshots/                 # find the snapshot from the run to undo
node scripts/pricing-engine-run.js --rollback data/snapshots/<file>.json --confirm
```
Restores each night to its exact pre-push price + min-stay, read-back verified.
**Never glob-delete in `data/`** — snapshots are the only rollback record.
```
