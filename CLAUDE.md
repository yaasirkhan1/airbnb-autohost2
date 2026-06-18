# airbnb-autohost2 — Project Reference

---

## DEVELOPMENT WORKFLOW

### New Feature
1. **`brainstorming` skill** — explore what Hospitable/Railway actually supports before writing any code
2. **`writing-plans` skill** — map which functions get touched; server.js is 2100+ lines
3. Implement
4. **`requesting-code-review` skill** — before any deploy
5. `railway up --detach`
6. **`railway logs -n 50 | grep -i "error\|fail\|warn"`** — non-negotiable after every deploy
7. **`/deploy-check`** — confirm behavior change is actually live

### Bug Fix
1. **`systematic-debugging` skill** — reproduce → root cause → fix (do not write code before root cause is confirmed)
2. `railway up --detach`
3. `railway logs -n 50 | grep -i "error\|fail\|warn"`
4. **`/deploy-check`**

### Multi-Unit Task (listing briefs, bulk calendar checks, multi-property queries)
1. **`dispatching-parallel-agents` skill**

### Rule
**Never announce a deploy as complete without running the log grep and `/deploy-check` first.**
A clean deploy is not "pushed to GitHub" — it is "logs show no errors and behavior is confirmed."

---

## PRICING — MANUAL OVERRIDE PRECEDENCE (standing rule)

**A verbal/manual pricing instruction from the host (Yasser) ALWAYS takes precedence over any pre-set automation** — tier calculations, per-date floors, weekend uplifts, decay/fill campaigns, event prices, and the sanity-swing guard. When the host gives a manual price or min-stay, apply it; never refuse or silently water it down because it conflicts with prior config. The host needs maneuverability to drive bookings on short notice.

**Apply it so config never blocks the change:**
- Use the override paths: `--override-sanity` on the engine runner (past the >60% swing halt), and direct single-date calendar PUTs to set a price below a floor or outside a campaign window. Single-date PUTs avoid the batch-boundary drop.
- A manual override is intent, not a mistake — never let a daily cron / campaign silently revert it. If something would overwrite it, fence the dates or update the config event so it persists, and say so.

**But never commit blind — preview + flag, then let the host confirm:**
- Always **show the resulting prices** (read back the exact per-date values) before/as the change commits.
- **Flag, in one line,** if the override pushes a price **far below its floor** or makes an **unusually large move** — and let the host confirm before it commits.
- Routine overrides within normal range: apply directly (the instruction is the authorization) and read-back verify; reserve the confirm step for the far-below-floor / large-move cases above.

---

## CLEANING SCHEDULE — manual override (host command)

A nightly **9:00 PM ET cron** (`sendCleaningSchedule` in server.js) texts the cleaner + host a Spanish turnover list via OpenPhone — units with a checkout **tomorrow**; same-day turnovers flagged `⚡ URGENTE`.

**Manual override from the host's phone:** when the host says **"add &lt;unit&gt; to cleaning [tomorrow | &lt;date&gt;]"**, **"remove &lt;unit&gt; from cleaning [tomorrow | &lt;date&gt;]"**, or an urgent variant **"add &lt;unit&gt; to cleaning tomorrow, urgent, ready by 4pm"**, register it by calling the LIVE endpoint (do NOT edit code or redeploy for a one-off):

```
POST https://airbnb-autohost2-production.up.railway.app/api/cleaning-override
Authorization: Bearer <API_SECRET>
{ "action": "add"|"remove", "unit": "7-B", "date"?: "YYYY-MM-DD",
  "priority"?: true, "deadline"?: "4:00 PM" }   // priority + deadline: ADD only; date defaults to tomorrow
```

- **Urgent / ready-by:** "urgent" / "make it urgent" / "guest arriving" → `priority: true` (lands in the `⚡ URGENTE` section); "ready by 4pm" / "by 4" → `deadline: "4pm"` (the endpoint normalizes "4pm" / "16:00" → "4:00PM"). A priority add with no stated time defaults the deadline to 4:00PM.
- Unit tokens are flexible ("7-B" / "7b" / "Apt 7-B"); the endpoint rejects unknown units with the valid list.
- The override is **persisted to the mounted volume, merged into that night's 9 PM run, then auto-expires** — it's date-keyed, so it can never affect a future night. Tell the host to set it **before 9 PM ET** for that night.
- **Confirm back** to the host exactly what registered (action, unit, date) from the endpoint's JSON response.
- Code: `src/cleaning-override.js` (store + pure logic); merge + expiry in `sendCleaningSchedule` (server.js); tests `scripts/test-cleaning-override.js`.

**One-off SMS to Veronica (the cleaner):** when the host says **"text Veronica: &lt;message&gt;"** or **"send Veronica &lt;message&gt;"**, send that exact message to her OpenPhone number via the LIVE endpoint (do NOT hunt for raw QUO creds or curl OpenPhone by hand):

```
POST https://airbnb-autohost2-production.up.railway.app/api/cleaner-message
Authorization: Bearer <API_SECRET>
{ "message": "<arbitrary text>" }    // alias: "text"
```

- This is a free-text message to the cleaner only (Veronica, `229-573-3899`) — NOT the host, NOT the nightly schedule. Use it for corrections/updates to a schedule already sent, or any ad-hoc note.
- Uses the same QUO creds (`QUO_API_KEY` / `QUO_FROM_NUMBER`) as `sendCleaningSchedule`. 200 `{ok,to,status}` on send / 400 empty / 503 not configured / 502 OpenPhone failure.
- Code: `src/cleaner-message.js` (pure sender, injectable fetch); route in server.js; tests `scripts/test-cleaner-message.js`.

---

## HOST-ADDED KNOWLEDGE FACTS — plain-English facts the host teaches the bot

The host grows the auto-responder's knowledge by telling Claude facts in plain English from their phone. These facts are **only ever the ones the host explicitly adds** — nothing is auto-learned from guest threads. Recognize these phrasings and call the LIVE endpoint (do NOT edit code or redeploy for a fact):

```
POST https://airbnb-autohost2-production.up.railway.app/api/knowledge
Authorization: Bearer <API_SECRET>
{ "action": "add"|"remove"|"list", "topic": "discount programs for the Georgia Aquarium",
  "fact": "Yes — CityPASS/C3 bundle it at a discount…", "scope"?: "all" }
```

- **"remember: guests asking about &lt;X&gt; should be told &lt;Y&gt;"** (or "remember: &lt;fact&gt;", "add a fact: …", "the bot should know …") → `action:"add"` with `topic`=X, `fact`=Y. **A same-topic add SUPERSEDES the old fact** (one fact per topic) — so "update the X fact to …" is just another add.
- **"forget the fact about &lt;X&gt;"** / "remove/delete the &lt;X&gt; fact" → `action:"remove"` with `topic`=X. Response `removed:true|false`.
- **"what facts does the bot know?"** / "list the facts" → `action:"list"` (or `GET /api/knowledge`).
- **Scope is ALL-UNITS** (every Atlanta property) for now; `scope` defaults to `"all"`. Per-unit targeting is structured-for but not wired (`factsForProperty` + a `scope` array) — don't promise per-unit yet.
- **Confirm back** to the host exactly what registered (topic + whether it superseded an existing fact) from the endpoint JSON.
- Facts are **persisted to the volume** and read by `draftReply` **at call time** (no redeploy needed to take effect). They're injected as a `HOST-ADDED FACTS` section that is **explicitly SUBORDINATE to every guardrail** (parking rules, stadium framing, price/policy/fee facts, `confident:false` escalation) — a fact can never override those.
- Phrase each fact as a **scoped condition** ("If a guest asks about X, tell them Y") so it maps to intent, not a stray keyword.
- Code: `src/host-facts.js` (store + pure logic); endpoint `POST /api/knowledge` + injection in `draftReply` (server.js); tests `scripts/test-host-facts.js`. Whole-list injection today; **topic-gating** (filter facts by keyword match like `isParkingQuestion`) slots into `buildFactsSection` if the list grows large.

---

## RESPONDER TONE — two modes (sales vs service)

The guest auto-responder (`draftReply`) runs the **brief, answer-first, human voice** (signed "Cal", no scripted empathy), **plus** a per-message tone mode selected by `resourceType` (`SALES_MODE_GUIDANCE` / `SERVICE_MODE_GUIDANCE` injected into the dynamic system block). **Tone only — never overrides facts, prices, policies, or any factual guardrail.**

- **INQUIRY → SALES mode** (pre-booking; goal: win the booking): sell the experience/benefits, confident & benefit-forward, reframe concerns positively, reduce friction, light/honest urgency only (never invent scarcity), gently move toward the close.
- **Confirmed RESERVATION → SERVICE mode** (booked; goal: an effortless, cared-for stay): anticipate needs, personalize, take ownership of issues (turn problems into goodwill), go a step beyond, warm/attentive/proactive.

These are paraphrased general hospitality principles (our own words). Factual guardrails stay in force — incl. **parking** (frame easy/affordable, plenty of options at all price points, reserve on SpotHero for best rate; no dollar quotes, no crime mentions, rates-change disclaimer) and **stadium distance** (~15-min walk via Centennial Olympic Park, framed as an easy enjoyable stroll). Money/refund complaints still escalate silently regardless of mode.

---

## Project Overview

24/7 auto-responder for **7 Airbnb properties** at **300 Peachtree Road NE, Downtown Atlanta, GA**. The server polls Hospitable every 60 seconds for new guest messages, runs them through a hardcoded trigger matcher, and falls back to Claude (claude-sonnet-4-6) for anything that doesn't match. All replies are signed **"Cal"**.

- **Production URL**: https://airbnb-autohost2-production.up.railway.app
- **API_SECRET**: `51419b9c8d371fca2c641965952729276fef5f82cbc38a27f3eb9ca708b600d2`
- **Deployment**: Railway — auto-deploys from `yaasirkhan1/airbnb-autohost2` on GitHub push to `main`
- **Runtime**: Node.js ≥ 18, single entrypoint `src/server.js` (2,100+ lines)

---

## Unit Mappings

All 7 units are in the same high-rise at 300 Peachtree Road NE.

| Unit  | Floor | Beds              | Bathroom                              | Hospitable UUID                        | Hospitable Internal |
|-------|-------|-------------------|---------------------------------------|----------------------------------------|---------------------|
| 4-L   | 4     | King (1BR)        | Walk-in shower only                   | `bbe43523-c42a-46b0-8235-7ad08ae990c9` | `6. (4-L)`          |
| 7-B   | 7     | King (1BR)        | Walk-in shower only                   | `1af8fdde-58ee-426e-8374-6530397347e8` | `2. (7-B)`          |
| 18-A  | 18    | Queen (1BR)       | Standing shower + bathtub w/ rainfall | `5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc` | `3. (18-A)`         |
| 21-D  | 21    | King (1BR)        | Bathtub                               | `80c21aac-00eb-49af-9094-6792839ff5a4` | `4. (21-D)`         |
| 21-I  | 21    | Queen + Double (2BR) | Full shower + bathtub combo        | `7b7fda8b-e1d8-460f-8143-59a1a2b4d81c` | `7. (21-I)`         |
| 23-N  | 23    | King (1BR)        | Bathtub                               | `283977a3-3af3-4d90-8d95-b418a3014d90` | `1. (23-N)`         |
| 24-L  | 24    | Queen (1BR)       | Walk-in shower only                   | `3e702102-a219-4c18-9f88-3a4d1ceb3825` | `5. (24-L)`         |

Pricing floors/ceilings: 1BR = $175–$799/night, 2BR (21-I) = $250–$1,199/night.

---

## Key Policies

| Policy              | Detail                                              |
|---------------------|-----------------------------------------------------|
| Check-in            | 4:00 PM                                             |
| Check-out           | 11:00 AM                                            |
| Early check-in      | Available from 1:00 PM — $45 fee                    |
| Late checkout       | Available until 1:30 PM — $45 fee                   |
| Minimum guest age   | 26 (exceptions considered with travel context)      |
| Host sign-off       | Always **"Cal"**                                    |
| Concierge email     | `300ptconcierge@gmail.com` (sent via Resend)        |

---

## Architecture

```
src/server.js          — single-file Express app (all logic lives here)
src/vault.js           — per-property listing content store (title, summary, access info, etc.)
data/unit-profiles.json  — static unit metadata (floor, bed type, bathroom, amenities keep/remove)
data/properties-map.json — UUID → label/public_name mapping (auto-updated by /api/listing-populate)
data/pricing_state.json  — persisted pricing state (written on every engine run)
public/                  — static files served at /
```

### Request flow

1. **60-second poll** — `pollForNewMessages()` checks Hospitable `/reservations` and `/inquiries` for messages in the last 90 seconds.
2. **Dedup** — `seenMessageIds` Set prevents double-replies between webhook and poller.
3. **Hardcoded match** — `detectHardcodedResponse()` runs first; if it matches, reply is sent immediately (no Claude call).
4. **Claude fallback** — `draftReply()` builds a system prompt with the learned property profile + vault entry, calls Claude, parses JSON response `{ confident, reply }`.
5. **Low confidence** — if `confident: false`, message is escalated to host via OpenPhone SMS; no guest reply is sent.
6. **Scheduled send** — replies are queued in `pendingReplies` with a configurable delay (default 5 min) before being sent via `POST /reservations/{id}/messages`.

### Warm-up on startup

On boot, `initAllPropertyProfiles()` fetches all 7 properties, learns host communication profiles from the last 40 reservations per property (up to 60 Q&A pairs), then runs `warmUpSeenMessages()` to mark all current inbox messages as seen (with a 5-minute grace window) — preventing spam on restart.

---

## Hardcoded Triggers

These bypass Claude entirely. Patterns are matched case-insensitively against the guest message.

| Trigger               | Pattern keywords                                                              | Reply behavior                                                                         |
|-----------------------|-------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|
| **Concierge/access**  | "won't let me in", "can't get in", "form not sent", "front desk needs", etc.  | Instant reply + fires `sendConciergeEmail()` to `300ptconcierge@gmail.com` via Resend  |
| **Age requirement**   | "age", "how old", "minimum age", "21/22/23/24/25 year old", etc.             | States 26 minimum, offers exception process, asks for travel details                   |
| **Early check-in**    | "early check-in", "check in early", "arrive early"                            | $45 fee, available from 1:00 PM, confirm availability                                  |
| **Late checkout**     | "late check-out", "check out late", "stay later", "extend check"              | $45 fee, available until 1:30 PM, confirm availability                                 |
| **Towels/linens**     | "towel", "linen", "bed sheet"                                                 | Fresh towels in closet/dressers; cleaning team can bring extras                        |
| **HVAC/thermostat**   | "heat", "cooling", "A/C", "thermostat", "too hot/cold", "radiator"            | Instructions: radiation unit under window → press back two corners of square panel     |
| **Parking**           | "park", "parking"                                                             | Full `PARKING_REPLY` block (AAA Garage on Baker St, ParkMobile tip, etc.)              |
| **Cancellation**      | `reservation.changed` webhook with `status: cancelled`                        | Sends `CANCELLATION_FOLLOWUP` message to guest asking for feedback                     |

---

## Integrations

| Service          | Purpose                                  | Env var                                                  |
|------------------|------------------------------------------|----------------------------------------------------------|
| Hospitable API   | Fetch properties, reservations, messages, send replies, update calendar prices | `HOSPITABLE_API_KEY`, `HOSPITABLE_WEBHOOK_SECRET` |
| Anthropic Claude | Draft guest replies (model: claude-sonnet-4-6) | `ANTHROPIC_API_KEY`                              |
| Resend           | Send concierge emails                    | `RESEND_API_KEY`, `RESEND_FROM`                          |
| OpenPhone (QUO)  | SMS host when Claude is not confident    | `QUO_API_KEY`, `QUO_FROM_NUMBER`, `NOTIFY_PHONE`         |
| Nodemailer/SMTP  | Fallback email (if Resend not set)       | `GMAIL_USER`, `GMAIL_APP_PASSWORD`                       |

Other relevant env vars: `HOST_NAME`, `HOST_TONE`, `CHECKIN_TIME`, `CHECKOUT_TIME`, `HOUSE_RULES`, `REPLY_DELAY_MINUTES` (default 5), `AUTOSEND` (default true), `CONCIERGE_EMAIL_TO` (default `300ptconcierge@gmail.com`), `DATA_DIR`.

---

## Demand-Based Pricing Engine

Runs hourly. Counts reservations/inquiries with activity in the last 24 hours per property.

- **≥ 3 inquiries in 24h** → price × 1.10 (capped at ceiling)
- **0 inquiries for ≥ 48h** → price × 0.95 (floored at floor)
- Pushes updated prices to Hospitable `/properties/{id}/calendar` for the next 31 days
- State persisted in `data/pricing_state.json`
- 1BR IDs: all units except 21-I; 2BR ID: `7b7fda8b-e1d8-460f-8143-59a1a2b4d81c`

---

## API Endpoints

All `/api/*` endpoints require `Authorization: Bearer <API_SECRET>` header.

| Method | Path                            | Purpose                                                      |
|--------|---------------------------------|--------------------------------------------------------------|
| GET    | `/health`                       | Health check — returns server status, env flags, pricing state |
| GET    | `/api/properties/all`           | List all Hospitable properties with IDs and metadata         |
| GET    | `/api/properties/:id/raw`       | Proxy a single Hospitable property (add `?include=amenities,house_rules`) |
| GET    | `/api/properties-map`           | View all stored UUID → label mappings                        |
| POST   | `/api/properties-map`           | Add/update a property map entry                              |
| POST   | `/api/push-amenities`           | Push amenity keep/remove lists from unit-profiles.json to Hospitable |
| POST   | `/api/test-concierge-email`     | Fire a test concierge email to verify Resend config          |
| POST   | `/api/listing-populate`         | Rewrite source listing copy into unique copy for a target property via Claude |
| GET    | `/api/pricing/engine`           | View pricing engine state — current prices, last run, change log |
| GET    | `/api/pricing`                  | View per-property pricing state                              |
| PUT    | `/api/pricing`                  | Manually set price for a property                            |
| GET    | `/api/queue`                    | View pending reply queue                                     |
| POST   | `/api/cancel/:id`               | Cancel a queued reply                                        |
| POST   | `/api/edit/:id`                 | Edit a queued reply before it sends                          |
| POST   | `/api/send-now/:id`             | Send a queued reply immediately                              |
| POST   | `/api/relearn/:propertyId`      | Re-run profile learning for a single property                |
| POST   | `/api/notify`                   | Trigger a host SMS notification manually                     |
| GET    | `/api/vault`                    | List all vault entries                                       |
| GET    | `/api/vault/:propertyId`        | Get vault entry for a property                               |
| POST   | `/api/vault/:propertyId`        | Save/update vault entry for a property                       |
| POST   | `/api/vault/import/hospitable`  | Import listing content from Hospitable into the vault        |
| POST   | `/api/vault/:propertyId/variation` | Generate a Claude-rewritten variation of vault content    |
| POST   | `/api/vault/:propertyId/push`   | Push vault content to Hospitable                             |
| POST   | `/webhook/hospitable`           | Hospitable webhook receiver (message.created + reservation.changed) |
| POST   | `/webhook/test`                 | Test webhook endpoint                                        |

---

## Development

```bash
npm run dev    # node --watch src/server.js (hot reload)
npm start      # node src/server.js
```

Required env vars for local dev (copy from Railway dashboard or `.env`):
```
HOSPITABLE_API_KEY=
ANTHROPIC_API_KEY=
RESEND_API_KEY=
API_SECRET=51419b9c8d371fca2c641965952729276fef5f82cbc38a27f3eb9ca708b600d2
```

## Repo

GitHub: `yaasirkhan1/airbnb-autohost2`  
Railway project: `airbnb-autohost2` (auto-deploy on push to `main`)
