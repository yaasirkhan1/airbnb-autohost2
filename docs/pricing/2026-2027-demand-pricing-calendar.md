# Downtown Atlanta Annual Demand & Pricing Calendar
### Peachtree Towers · 300 Peachtree St NE · 7 live units
**Window:** June 2026 – May 2027 · **World Cup blackout (June 11 – July 16, 2026) is EXCLUDED — handled manually.**
**Built:** June 1, 2026 · **Strategy:** steady occupancy with rate discipline — book well, but never fire-sale.

> Machine-readable companion: `config/pricing-calendar.json` (the file the pricing tool consumes).

---

## 0. FINAL RULES (locked with operator, June 1)

| Rule | Value |
|---|---|
| **Tool floor (lowest auto price)** | **$75** — the tool never goes below this. $50 is the operator's MANUAL hand-lever only. |
| **Weekend floor** | **$99+** on the cheapest unit (Fri/Sat never below $99, any unit, any season). Scaled up for nicer units. |
| **Ceiling** | **$700** (raised from $600 to allow the 2BR Dragon Con rate). |
| **Dragon Con (Sep 3–7)** | **$500/night** all 1BRs · **$688/night** the 2BR (21-I) · **5-night min** · fixed override. |
| **AmericasMart big shows** | **~$199/night** anchor (older 1BR), scaled up · **8-night min**. |
| **Blackout** | Never touch June 11 – July 16, 2026. |

> NOTE: these rails ($75 floor / $99 weekend / $700 ceiling) SUPERSEDE the earlier brainstorm values ($80 / $600).

---

## 1. THE ANNUAL DEMAND SHAPE

Downtown business/convention units, blocks from GWCC, AmericasMart, Mercedes-Benz Stadium, State Farm Arena.

| Season | Months | Demand | Notes |
|---|---|---|---|
| **Soft summer** | mid-Jul → Aug | Low | Hot, conventions thin. |
| **PEAK fall** | Sep → mid-Nov | High | Dragon Con, football, conventions. Best revenue window. |
| **Holiday split** | late Nov → Dec | Mixed | Thanksgiving & Christmas weeks empty; early Dec & NYE spike. |
| **Winter trough** | Jan → Feb | Low | Cold, post-holiday. Bright spot: Atlanta Market (mid-Jan). |
| **High season** | Mar → May | High | Spring conventions, weather, graduations. |

**Current-price note:** the 120-day pull showed medians of $121–158 with only 9–23 of 85 nights booked — priced ahead of demand for the season. This calendar pulls most non-event summer/early-fall nights down toward Normal/Medium to convert, while holding rate discipline at the $75/$99 floors.

---

## 2. UNIT GROUPS

| Group | Units | Position |
|---|---|---|
| **Premium 1BR** | 18-A, 24-L, 21-D | Top of 1BR range |
| **Updated 1BR** | 4-L | Mid |
| **Older 1BR** | 23-N, 7-B | Value anchor (sets the floors) |
| **2BR (sleeps 4)** | 21-I | Premium; shines in group/event demand |

---

## 3. PER-UNIT PRICING TIER GRID

Floors respected ($75 base, $99 weekend on the cheapest unit). Ceiling $700. Event overrides in Section 6 replace these tiers on event dates.

| Tier | Older 1BR (23-N, 7-B) | Updated (4-L) | Premium (18-A, 24-L, 21-D) | 2BR (21-I) |
|---|---|---|---|---|
| **Emergency-fill** (tool floor) | $75 | $79 | $85 | $99 |
| **Low** | $79 | $85 | $92 | $115 |
| **Normal** (weekday baseline) | $85 | $92 | $99 | $129 |
| **Weekend** (Fri/Sat floor) | $99 | $109 | $119 | $159 |
| **High** (high-season wknd / minor event) | $125 | $135 | $149 | $199 |
| **Event override** | see Section 6 (Dragon Con $500, AmericasMart $199, etc.) | | | |

**Mapping to your targets:** weekday Normal ≈ your $74–92 band; Weekend ≈ your $99–117 band. High and event overrides are where the upside lives. The tool will not auto-price below $75, and never below $99 on a Friday or Saturday — if you ever want $50, you set it by hand.

---

## 4. MIN-STAY LOGIC

| Tier | Min-stay |
|---|---|
| Emergency-fill / Low / Normal | 1 night (weekday), 2 across a weekend |
| Weekend / High | 2 nights |
| **Dragon Con** | **5 nights** |
| **AmericasMart big shows** | **8 nights** |
| Other compression (SEC Champ, bowls) | 2 nights |

**Single-night events** (one Falcons game, one concert): bump the price one tier that night, no forced multi-night min — don't create unsellable gaps.

---

## 5. COUNTDOWN / DYNAMIC ADJUSTMENT

Set the tier early, let pace decide. "Open" = unbooked. **Hard limits hold at every step: never below $75, never below $99 on a weekend.**

| Days out | Normal (non-event) | Compression / event |
|---|---|---|
| **90** | Tier set. Hold. | Set high, min-stays live. Hold. |
| **60** | Hold; +5% if pacing ahead. | Hold — demand hasn't woken up. |
| **30** | Open & behind → drop one tier (toward $75 floor / $99 weekend). Ahead → hold/+5–10%. | Hold; event demand starts now. |
| **21** | Open → drop toward floor. | Hold; bowls/conventions book late. |
| **14** | Open → floor ($75 / $99 weekend), min-stay 1–2. | First trim: drop one tier, relax min-stay 1 night. |
| **7** | Open → floor, 1-night. | Drop toward High tier, 1–2 night min. |
| **3** | Open → floor, 1-night. (Hand-drop to $50 only if you choose.) | Emergency logic; sold beats empty. |
| **1** | Open → floor, 1-night. | Same. |

**Golden rule:** never panic-drop Dragon Con / SEC Champ / bowl nights early — that demand books in the final 21–30 days.

---

## 6. EVENT CALENDAR — June 2026 → May 2027

Demand 1–10. "Action" = the price rule for that block. Blackout dates omitted.

### JULY 2026 (from Jul 17)
| Dates | Event | Venue | Demand | Action | Min-stay |
|---|---|---|---|---|---|
| Jul 17–31 | Soft summer | — | 2–3 | Normal weekday / Weekend floor | 1–2 |

### AUGUST 2026
| Dates | Event | Venue | Demand | Action | Min-stay |
|---|---|---|---|---|---|
| Aug 3–6 | Atlanta Apparel (smaller market) | AmericasMart | 6 | High | 2 |
| Aug 7–27 | Soft summer | — | 2–4 | Normal / Weekend floor | 1–2 |
| Aug 14 (Fri) | Falcons preseason vs Broncos | Mercedes-Benz | 4 | High that night | 1 |
| Aug 28–31 | Dragon Con ramp | — | 5→8 | High, climbing | 2 |

### SEPTEMBER 2026 — PEAK
| Dates | Event | Venue | Demand | Action | Min-stay |
|---|---|---|---|---|---|
| **Sep 3–7** | **DRAGON CON** | Downtown hotels | **10** | **$500 1BR / $688 2BR (override)** | **5** |
| Sep 5 (Sat) | Aflac Kickoff: Baylor v Auburn | Mercedes-Benz | 8 | (covered by Dragon Con override) | — |
| Sep 8–19 | Convention baseline | — | 5 | High weekend / Normal weekday | 2 |
| Sep 20 (Sun) | Falcons home opener vs Panthers | Mercedes-Benz | 5 | High that night | 1 |
| Sep 21–30 | Convention baseline | — | 5 | High weekend / Normal weekday | 2 |

> Dragon Con is the single biggest event of the year — host hotels are your neighbors. $500/$688, 5-night min, hold firm until ~14 days out.

### OCTOBER 2026 — STRONG
| Dates | Event | Venue | Demand | Action | Min-stay |
|---|---|---|---|---|---|
| Oct 6–9 | Atlanta Apparel market week | AmericasMart | 6 | High | 2 |
| Oct 11 (Sun) | Falcons vs Ravens (SNF) | Mercedes-Benz | 6 | High (Sat+Sun) | 2 |
| Oct 18 (Sun) | Falcons vs Bears | Mercedes-Benz | 5 | High that night | 1 |
| Oct 25 (Sun) | Falcons vs 49ers | Mercedes-Benz | 5 | High that night | 1 |
| Oct (other) | Fall conventions | — | 5 | High weekend / Normal weekday | 2 |

### NOVEMBER 2026 — MODERATE
| Dates | Event | Venue | Demand | Action | Min-stay |
|---|---|---|---|---|---|
| Nov 15 (Sun) | Falcons vs Chiefs (Mahomes) | Mercedes-Benz | 7 | High (Sat+Sun) | 2 |
| Nov 1–24 | Convention baseline | — | 4–5 | Normal / Weekend | 1–2 |
| Nov 25–29 | Thanksgiving — downtown empties | — | 2 | Floor ($75 / $99 wknd) | 1 |

### DECEMBER 2026 — MIXED
| Dates | Event | Venue | Demand | Action | Min-stay |
|---|---|---|---|---|---|
| **Dec 5 (Sat)** | **SEC CHAMPIONSHIP** | Mercedes-Benz | 8 | High → push top of band; treat Dec 4–6 as one block | 2 |
| Dec 6 (Sun) | Falcons vs Lions | Mercedes-Benz | 6 | High | 2 |
| Dec 7–20 | Pre-holiday (soft) | — | 3–4 | Normal / floor | 1 |
| Dec 21–26 | Christmas — downtown dead | — | 2 | Floor | 1 |
| Dec 27 (Sun) | Falcons vs Buccaneers (TBD) | Mercedes-Benz | 5 | High that night | 1 |
| Dec 31 (Thu) | New Year's Eve | Downtown | 7 | High (1–2 night spike) | 1–2 |
| ~late Dec | *Peach Bowl / CFP — date TBD* | Mercedes-Benz | 7 | High on confirmed date | 2 |

### JANUARY 2027 — LOW, two bright spots
| Dates | Event | Venue | Demand | Action | Min-stay |
|---|---|---|---|---|---|
| ~Jan 1–2 | *Peach Bowl / CFP spillover* | Mercedes-Benz | 7 | High on confirmed date | 2 |
| Jan 3 (Sun) | Falcons vs Saints | Mercedes-Benz | 5 | High that night | 1 |
| **~Jan 12–18 (CONFIRM)** | **ATLANTA MARKET — Winter (big show)** | AmericasMart | 7 | **$199 anchor / scaled (override)** | **8** |
| Jan 16–18 | MLK weekend | — | 4 | Weekend/High | 2 |
| Jan (other) | Winter trough | — | 2–3 | Floor | 1 |

### FEBRUARY 2027 — LOW
| Dates | Event | Venue | Demand | Action | Min-stay |
|---|---|---|---|---|---|
| Feb 14 (Sun) | Valentine's | — | 4 | Weekend | 2 |
| ~late Feb | Atlanta United home opener (MLS) | Mercedes-Benz | 3 | Normal + bump match nights | 1 |
| Feb (other) | Winter trough | — | 2–3 | Floor | 1 |

### MARCH 2027 — HIGH SEASON BEGINS
| Dates | Event | Venue | Demand | Action | Min-stay |
|---|---|---|---|---|---|
| All month | Spring conventions, warming | — | 5–6 | Normal weekday / High weekend | 1–2 |
| Match nights | Atlanta United | Mercedes-Benz | 3–4 | +1 tier that night | 1 |

### APRIL 2027 — HIGH
| Dates | Event | Venue | Demand | Action | Min-stay |
|---|---|---|---|---|---|
| All month | Peak spring convention + leisure | — | 6 | High weekends | 2 |
| ~mid-Apr | *Dogwood Festival (est)* | Piedmont Park | 5 | High that weekend | 2 |

### MAY 2027 — HIGH (graduations)
| Dates | Event | Venue | Demand | Action | Min-stay |
|---|---|---|---|---|---|
| ~early–mid May (CONFIRM) | Graduation weekends (Ga Tech, GSU, AUC, Emory) | Campuses | 7 | High, 2–3 night stays | 2–3 |
| ~early May | *Shaky Knees (est)* | Central Park ATL | 6 | High that weekend | 2 |
| ~late May | Atlanta Jazz Fest (Memorial Day) | Piedmont Park | 5 | High that weekend | 2 |

---

## 7. CONFIRM-BEFORE-TRUSTING (estimates)

- **Peach Bowl / CFP date** — CFP-bracket dependent; confirm ~Nov.
- **Atlanta Market Winter 2027** — mid-Jan estimate; verify ANDMORE 2027 dates. (Note: the July AmericasMart big show moved to June 9–14 in 2026 due to the World Cup and is inside your blackout / past — the next summer big show is ~July 2027, outside this window. The $199/8-night rule applies whenever a big show returns.)
- **Graduation weekends (May 2027)** — each university sets its own; confirm in spring.
- **Festivals** (Music Midtown, Shaky Knees, Dogwood, Jazz Fest) — dates/cancellations vary; confirm before pricing. Music Midtown has been cancelled in past years.
- **NBA Hawks 2026–27** — releases ~Aug 2026; ~41 home games Oct–Apr, low per-game lodging impact (local fans). Background texture, not events.
- **One-off concerts** (State Farm Arena, Mercedes-Benz, Fox, Tabernacle) — scan ~30 days out; big act = one-night bump.
- **Comp rates:** couldn't pull live comps here. Spot-check 2–3 comparable downtown listings ~45 days out for Dragon Con / SEC Champ / NYE and sit just under prevailing comps.

---

## 8. AUTOMATING THE DAILY RUN (hand this to Claude Code)

**What automates safely:** the daily *math* — the tool running the countdown logic against this calendar and writing price changes. **What stays human:** the *research* — refreshing this calendar quarterly (events are set months out, so this is light: ~20 min, 4x/year, in a chat with me).

**Hard truth on "always-on like PriceLabs":** a scheduled job on your Mac only runs **when the Mac is on and awake.** PriceLabs runs on their cloud 24/7. To truly match that you'd later move the tool to an always-on cloud server — a separate project. The Mac schedule below gets you ~90% there for $0.

Automation requirements (operator):
1. Run once daily at **10:00 AM** via launchd.
2. First, do a **dry-run** and write the plan to a dated log file in `logs/`.
3. Only run **`--commit`** after sign-off that the San Juan test results look right — until then, **dry-run only**.
4. Respect every existing rail: blackout, $75 floor, $99 weekend floor, $700 ceiling, tool-owned ledger, manual overrides win.
5. Append every run to a rolling log.
6. Provide the `launchd` .plist, where it lives, the load/unload command, how to read the log, and how to pause.

---

## 9. MACHINE-READABLE APPENDIX

See `config/pricing-calendar.json` (kept in sync with this document; `version: 2026-06-01-final`).

---

*Estimates labeled. Confirmed dates sourced from official venue/league calendars as of June 1, 2026. Re-review quarterly and when the NBA schedule and CFP bracket release.*
