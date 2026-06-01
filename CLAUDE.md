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
