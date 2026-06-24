const express      = require('express');
const crypto       = require('crypto');
const path         = require('path');
const fs           = require('fs');
const nodemailer   = require('nodemailer');
const { Resend }   = require('resend');
const cron         = require('node-cron');
const { runPricingAllUnits, PRICING_CRON_SCHEDULE, PRICING_CRON_TZ, runPricingHealthcheck, PRICING_HEALTHCHECK_SCHEDULE, runDecayPass, DECAY_CRON_SCHEDULES, runWcFillPass } = require('./pricing-cron');
const vault        = require('./vault');
const { isWithinGrace, loadSeen, saveSeen, tsMs } = require('./seen-store');
const { savePending, loadPending, partitionPending } = require('./pending-store');
const { decideAlert, loadAlerts, saveAlerts } = require('./alert-store');
const { parseDraftReply } = require('./draft-parse');
const { isEntryCodeRequest, resolveEntryCode, entryCodeReply, loadEntryCodes } = require('./entry-codes');
const { tomorrowInTZ, dateInTimeZone, classifyTurnover, isActiveReservation } = require('./cleaning-schedule');
const cleaningOverride = require('./cleaning-override');
const cleanerMessage = require('./cleaner-message');
const doorCodes = require('./door-codes');
const checkinSweep = require('./checkin-sweep');
const checkinTemplate = require('./checkin-template');
const hostFacts = require('./host-facts');
const guestNameLib = require('./guest-name');
const { fragmentBurst, routeAction } = require('./concierge-window');
const { decideConcierge, classifyAccessIntent } = require('./concierge-classifier');
const { buildConciergeEmail, conciergeGuestReply, conciergeHardcodedReply, resolveConciergeReply, conciergeSentSms, conciergeFailedSms, conciergeSms } = require('./concierge-email');
const { ATLANTA_PROPERTY_IDS, isManaged, filterManaged } = require('./managed-properties');
const { resolveReplyTarget } = require('./reply-target');
const pricingAdjust = require('./pricing-adjust');
const pricingFreeze = require('./pricing-freeze');
const decayStatus = require('./decay-status');
const pricingConfig = require('./pricing-config.json');
const { isNightBooked } = require('./pricing-guards');
const telegramBot = require('./telegram-bot');
const telegramIntent = require('./telegram-intent');
const { loadKnowledgeBase } = require('./knowledge-base');
const { loadParkingKB, isParkingQuestion, buildParkingSection } = require('./parking-knowledge');
const { loadRestaurantKB, isRestaurantQuestion, buildRestaurantSection } = require('./restaurant-knowledge');
const { loadConventionKB, isConventionQuestion, buildConventionSection } = require('./convention-knowledge');

// Concierge / event-intelligence knowledge base (local-area facts). Loaded once at
// startup from the repo (DATA_DIR), injected into draftReply's system prompt so Claude
// answers area/venue/transit/distance questions confidently instead of escalating.
const KNOWLEDGE_BASE = loadKnowledgeBase();
// Parking facts (src/knowledge/parking.md) injected into draftReply on parking
// questions so Claude answers the specific question from verified facts only —
// replaces the old one-size-fits-all PARKING_REPLY block.
const PARKING_SECTION = buildParkingSection(loadParkingKB());
// Restaurant facts (src/knowledge/restaurants.md) injected into draftReply on food/restaurant
// questions only (topic-gated like parking) so the prompt stays lean otherwise.
const RESTAURANT_SECTION = buildRestaurantSection(loadRestaurantKB());
// Convention hotels & venues (src/knowledge/conventions.md) injected on convention/trade-show
// questions only (topic-gated like parking) so the prompt stays lean otherwise.
const CONVENTION_SECTION = buildConventionSection(loadConventionKB());

const app = express();

// ─── Properties map (numeric/legacy ID → UUID + metadata) ────────────────────
const PROPS_MAP_PATH = path.join(
  process.env.DATA_DIR || path.join(__dirname, '../data'),
  'properties-map.json'
);

function loadPropertiesMap() {
  try {
    if (fs.existsSync(PROPS_MAP_PATH)) return JSON.parse(fs.readFileSync(PROPS_MAP_PATH, 'utf8'));
  } catch (e) {
    console.error('[props-map] Failed to load:', e.message);
  }
  return {};
}

function savePropertiesMap(map) {
  try {
    fs.mkdirSync(path.dirname(PROPS_MAP_PATH), { recursive: true });
    fs.writeFileSync(PROPS_MAP_PATH, JSON.stringify(map, null, 2));
  } catch (e) {
    console.error('[props-map] Failed to save:', e.message);
  }
}

function upsertPropertiesMap(id, fields) {
  const map = loadPropertiesMap();
  map[id] = { ...map[id], ...fields, updatedAt: new Date().toISOString() };
  savePropertiesMap(map);
  return map[id];
}
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const API_SECRET = process.env.API_SECRET;
// Pure auth decision for /api/*. FAIL-CLOSED: if no API_SECRET is configured, REJECT (this surface
// can move live prices + message guests — it must never be unauthenticated by accident). Exported
// for tests.
function checkApiAuth(apiSecret, authHeader) {
  if (!apiSecret) return { ok: false, status: 401, error: 'Unauthorized — API_SECRET not configured' };
  const token = String(authHeader || '').replace('Bearer ', '').trim();
  if (token !== apiSecret) return { ok: false, status: 401, error: 'Unauthorized' };
  return { ok: true };
}
app.use('/api/', (req, res, next) => {
  const auth = checkApiAuth(API_SECRET, req.headers.authorization);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  next();
});

const pendingReplies = new Map();
const replyLog = [];

// Per-property learned profiles + raw history cache
const propertyProfiles = new Map();  // propertyId -> { profile, learnedAt, propertyName }
const propertyHistory = new Map();   // propertyId -> [{ guest, host, topic }]

// Polling state
const seenMessageIds = new Set(); // dedup between webhook + polling
const recentMsgsByConvo = new Map(); // conversation_id → recent turns (guest msgs + bot replies) for fragment-burst detection AND inquiry-thread history (GET /inquiries messages is 405)
const CONVO_BUFFER_CAP = 16;         // keep enough turns for a coherent pre-booking back-and-forth
// Append a turn to a conversation's in-memory buffer. role 'guest' → guest turn; 'host' → a reply
// the bot/host sent (so an inquiry thread, which has no GETable history, stays two-sided).
function pushConvoMsg(conversationId, role, body) {
  if (!conversationId || !String(body || '').trim()) return;
  const buf = recentMsgsByConvo.get(conversationId) || [];
  buf.push({ body: String(body), sender_role: role, created_at: new Date().toISOString() });
  while (buf.length > CONVO_BUFFER_CAP) buf.shift();
  recentMsgsByConvo.set(conversationId, buf);
  if (recentMsgsByConvo.size > 500) recentMsgsByConvo.delete(recentMsgsByConvo.keys().next().value);
}
const alertState = loadAlerts(); // conversationKey → host-alert throttle state (persisted to volume)
let knownPropertyIds  = [];       // populated after initAllPropertyProfiles
let pollingSince      = null;     // ISO timestamp — only reply to messages after this

// "First responder wins": default 0 = no artificial delay — the auto-responder sends
// immediately, and right before sending re-checks the Hospitable thread and backs off
// if the host already replied (any channel). Set a small buffer here (e.g. 1 = 60s)
// only if Airbnb-app → Hospitable sync lag ever causes double-replies.
const REPLY_DELAY_MINUTES = Number(process.env.REPLY_DELAY_MINUTES) || 0;

const HOST_SETTINGS = {
  name: process.env.HOST_NAME || 'Your Host',
  tone: process.env.HOST_TONE || 'warm and friendly',
  checkin: process.env.CHECKIN_TIME || '4:00 PM',
  checkout: process.env.CHECKOUT_TIME || '11:00 AM',
  houseRules: process.env.HOUSE_RULES || 'No smoking, no parties, quiet hours after 10pm.',
  extraContext: process.env.EXTRA_CONTEXT || '',
  delayMinutes: REPLY_DELAY_MINUTES,
  autosend: process.env.AUTOSEND !== 'false',
};

// Hospitable sender roles that count as "the host replied" (i.e. me / my team).
const HOST_REPLY_ROLES = new Set(['host', 'co-host', 'teammate']);

// Claude models. Guest replies (draftReply) use the high-quality model; the bulk
// profile-building pass uses the cheaper/faster Haiku since it just summarizes style.
const REPLY_MODEL   = 'claude-opus-4-8';
const PROFILE_MODEL = 'claude-haiku-4-5';

// ─── Atlanta demand-based pricing engine — config & state ────────────────────

const ATLANTA_1BR_IDS = [
  '1af8fdde-58ee-426e-8374-6530397347e8',  // WC Apartment Premier
  '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc',  // Downtown 1BR High-Rise
  'bbe43523-c42a-46b0-8235-7ad08ae990c9',  // WC Lodging Short Walk
  '80c21aac-00eb-49af-9094-6792839ff5a4',  // WC Traveler Pkg A
  '3e702102-a219-4c18-9f88-3a4d1ceb3825',  // WC Flat Rate Walk
  '283977a3-3af3-4d90-8d95-b418a3014d90',  // WC Traveler Pkg B
];
const ATLANTA_2BR_ID  = '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c'; // WC Package 2BR (21-I)
const ATLANTA_ALL_IDS = [...ATLANTA_1BR_IDS, ATLANTA_2BR_ID];

const PRICE_RULES = {
  '1br': { floor: 175,  ceiling:  799 },
  '2br': { floor: 250,  ceiling: 1199 },
};
function getPriceRules(id) {
  return id === ATLANTA_2BR_ID ? PRICE_RULES['2br'] : PRICE_RULES['1br'];
}

// Absolute garbage-floor for MANUAL writes (PUT /api/pricing) — deliberately BELOW the demand
// engine's business floor ($175/$250) so intentional low overrides (World Cup fill at $72–$109,
// or any short-notice manual price) still go through, while a catastrophic/compounding value (the
// $3.60 incident) is still raised to a sane minimum. This is a manual-write guard ONLY; the hourly
// demand engine keeps its $175/$250 PRICE_RULES floor on its own runs.
const HARD_MIN_PRICE = { '1br': 72, '2br': 109 };

// Pure: clamp a manual price for property `id` to [HARD_MIN_PRICE, PRICE_RULES.ceiling].
// Returns { price, bound } where bound ∈ 'floor' | 'ceiling' | null (null = unchanged).
function clampManualPrice(id, price) {
  if (typeof price !== 'number' || !isFinite(price)) return { price, bound: null };
  const type    = id === ATLANTA_2BR_ID ? '2br' : '1br';
  const floor    = HARD_MIN_PRICE[type];
  const ceiling = PRICE_RULES[type].ceiling;
  if (price < floor)   return { price: floor,   bound: 'floor' };
  if (price > ceiling) return { price: ceiling, bound: 'ceiling' };
  return { price, bound: null };
}

// ── Kill-switches for the legacy hourly demand engine (default = ON, current behavior) ──
// Both read process.env at runtime so a Railway variable change takes effect on the next
// cycle (and reversibly: unset → legacy engine resumes).
//   PRICING_LEGACY_ENGINE=off     → don't schedule the legacy engine at all.
//   PRICING_LEGACY_EXCLUDE=id,id  → legacy engine skips these property IDs (the new engine
//                                   owns them) so the two engines never fight over a calendar.
function legacyEngineEnabled(env = process.env) {
  return env.PRICING_LEGACY_ENGINE !== 'off';
}
function legacyEngineExcluded(propId, env = process.env) {
  const set = new Set(String(env.PRICING_LEGACY_EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean));
  return set.has(propId);
}

// Persisted per-property price state: { price, lastInquiryAt, lastChangedAt, pendingPush, log[] }
const pricingState   = new Map();
const pricingChanges = []; // global chronological log, capped at 200
let   pricingLastRun = null;

const PRICING_STATE_PATH = path.join(
  process.env.DATA_DIR || path.join(__dirname, '../data'),
  'pricing_state.json'
);

function loadPricingState() {
  try {
    if (!fs.existsSync(PRICING_STATE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(PRICING_STATE_PATH, 'utf8'));
    for (const [id, s] of Object.entries(raw)) pricingState.set(id, s);
    console.log(`[pricing] Loaded state for ${pricingState.size} properties`);
  } catch (e) {
    console.error('[pricing] Could not load pricing_state.json:', e.message);
  }
}

function savePricingState() {
  try {
    fs.mkdirSync(path.dirname(PRICING_STATE_PATH), { recursive: true });
    fs.writeFileSync(PRICING_STATE_PATH, JSON.stringify(Object.fromEntries(pricingState), null, 2));
  } catch (e) {
    console.error('[pricing] Could not save pricing_state.json:', e.message);
  }
}

// ─── Hospitable API helpers ───────────────────────────────────────────────────

function parseProperties(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.properties)) return data.properties;
  return [];
}

function formatHouseRules(rules) {
  if (!rules || typeof rules !== 'object') return '';
  const lines = [];
  if (rules.smoking_allowed === false) lines.push('No smoking');
  else if (rules.smoking_allowed === true) lines.push('Smoking allowed');
  if (rules.pets_allowed === false) lines.push('No pets');
  else if (rules.pets_allowed === true) lines.push('Pets allowed');
  if (rules.events_allowed === false) lines.push('No events or parties');
  else if (rules.events_allowed === true) lines.push('Events allowed');
  return lines.join('. ');
}

async function hospGet(apiPath) {
  const res = await fetch(`https://public.api.hospitable.com/v2${apiPath}`, {
    headers: {
      'Authorization': `Bearer ${process.env.HOSPITABLE_API_KEY}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Hospitable ${res.status} on GET ${apiPath}: ${body}`);
  }
  return res.json();
}

async function hospPut(apiPath, body) {
  const res = await fetch(`https://public.api.hospitable.com/v2${apiPath}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${process.env.HOSPITABLE_API_KEY}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Hospitable ${res.status} on PUT ${apiPath}: ${text}`);
  }
  return res.json().catch(() => ({}));
}

// Best-effort fetch of the booking/inquiry GUEST object (the reliable guest identity, unlike a
// per-message sender which can be the host on inquiries). Returns the guest object or null; never
// throws (a name lookup must never break message handling). Used for safe greeting-name resolution.
async function fetchGuestObject(resourceType, resourceId) {
  if (!resourceId) return null;
  const seg = resourceType === 'inquiry' ? 'inquiries' : 'reservations';
  try {
    const d = await hospGet(`/${seg}/${resourceId}?include=guest`);
    return ((d && (d.data || d)) || {}).guest || null;
  } catch (e) {
    console.log(`[guest-name] could not fetch guest for ${seg}/${resourceId}: ${e.message}`);
    return null;
  }
}

// ─── History learning ─────────────────────────────────────────────────────────
// The Hospitable public API has no /conversations endpoint.
// Reservations are the correct resource; messages live at /reservations/{id}/messages.

async function fetchReservationsForProperty(propertyId, limit = 40) {
  try {
    const data = await hospGet(`/reservations?properties[]=${propertyId}&per_page=${limit}&include=guest`);
    return parseReservations(data);
  } catch (e) {
    console.error(`[learn] Could not fetch reservations for ${propertyId}:`, e.message);
    return [];
  }
}

async function fetchMessagesForReservation(reservationId) {
  try {
    const data = await hospGet(`/reservations/${reservationId}/messages?per_page=50`);
    return parseMessages(data);
  } catch (e) {
    console.error(`[learn] Could not fetch messages for reservation ${reservationId}:`, e.message);
    return [];
  }
}

async function learnPropertyProfile(propertyId, propertyName) {
  console.log(`[learn] Building profile for property: ${propertyName} (${propertyId})`);

  const reservations = await fetchReservationsForProperty(propertyId, 40);
  if (!reservations.length) {
    console.log(`[learn] No reservations found for ${propertyName}`);
    return null;
  }

  // Build Q&A pairs from message history
  const pairs = [];
  for (const reservation of reservations.slice(0, 25)) {
    const messages = await fetchMessagesForReservation(reservation.id);
    let lastGuest = null;
    for (const msg of messages) {
      // Message schema (v2) uses flat fields — no attributes nesting
      const sender = msg.sender_type;
      const body   = msg.body || '';
      if (!body.trim()) continue;
      if (sender === 'guest') {
        lastGuest = body;
      } else if (sender === 'host' && lastGuest) {
        pairs.push({ guest: lastGuest.slice(0, 300), host: body.slice(0, 400) });
        lastGuest = null;
        if (pairs.length >= 60) break;
      }
    }
    if (pairs.length >= 60) break;
  }

  if (!pairs.length) {
    console.log(`[learn] No Q&A pairs found for ${propertyName}`);
    return null;
  }

  console.log(`[learn] Extracted ${pairs.length} Q&A pairs for ${propertyName} — generating profile...`);

  // Ask Claude to extract a host profile from the history
  const historyText = pairs.map((p, i) =>
    `Example ${i + 1}:\nGuest: ${p.guest}\nHost: ${p.host}`
  ).join('\n\n');

  const profileText = await callClaude(
    `You are analyzing Airbnb host message history to extract a communication profile. 
Be specific and extract real patterns — actual phrases they use, specific information they provide, how they open and close messages, how they handle common questions.
Return a detailed profile in plain text under these headings:
- Tone & style
- Common opening phrases
- How they handle check-in questions
- How they handle parking questions  
- How they handle late arrivals
- How they handle maintenance/issues
- Recurring info they always mention
- Things they never say / avoid
- Overall personality as a host`,
    `Here are real message exchanges for the property "${propertyName}". Learn this host's communication style:\n\n${historyText}`,
    800,
    PROFILE_MODEL,
  );

  propertyHistory.set(propertyId, pairs);
  const profile = { profile: profileText, learnedAt: Date.now(), propertyName, pairsCount: pairs.length };
  propertyProfiles.set(propertyId, profile);
  console.log(`[learn] ✅ Profile built for ${propertyName}`);
  return profile;
}

async function initAllPropertyProfiles() {
  try {
    console.log('[learn] Fetching all properties...');
    const data = await hospGet('/properties?per_page=50');
    const allProperties = parseProperties(data);
    // Scope to the 7 managed Atlanta units by STABLE ID (titles change — e.g. the
    // "World Cup…" renames — so we never match on name). Everything downstream
    // (poll, inquiries, warm-up, webhook) flows from knownPropertyIds.
    const properties = filterManaged(allProperties);
    knownPropertyIds = properties.map(p => p.id);
    console.log(`[learn] ${allProperties.length} properties on account → scoped to ${knownPropertyIds.length} managed (Atlanta); building profiles...`);
    for (const p of properties) {
      const id = p.id;
      const name = p.public_name || p.name || id;
      await learnPropertyProfile(id, name);
      await new Promise(r => setTimeout(r, 200));
    }
    console.log('[learn] ✅ All property profiles ready');
  } catch (e) {
    console.error('[learn] Failed to init profiles:', e.message);
  }

  // Warm-up: mark all messages currently in the inbox as seen WITHOUT replying.
  // This prevents the poller from spamming guests when the server (re)starts.
  try {
    await warmUpSeenMessages();
  } catch (e) {
    console.error('[poll] Warm-up error:', e.message);
  }

  // Start polling after warm-up so only truly new messages trigger replies.
  // Set pollingSince to match the grace window (5 min back) so that messages
  // left unseen during warm-up are not also blocked by the pollingSince check.
  // seenMessageIds deduplication handles the older messages that were marked seen.
  pollingSince = toHospitableDate(new Date(Date.now() - 5 * 60 * 1000));
  setInterval(pollForNewMessages, 60 * 1000);
  console.log(`[poll] Polling started — checking every 60s (since ${pollingSince})`);

  // Start hourly demand-based pricing engine (10s after warm-up to avoid startup noise).
  // PRICING_LEGACY_ENGINE=off disables it entirely (kill-switch; default = on).
  if (!legacyEngineEnabled()) {
    console.log('[pricing] legacy demand engine DISABLED via PRICING_LEGACY_ENGINE=off');
  } else {
    loadPricingState();
    setTimeout(() => {
      runPricingEngine().catch(e => console.error('[pricing] Initial run failed:', e.message));
      setInterval(
        () => runPricingEngine().catch(e => console.error('[pricing] Run error:', e.message)),
        60 * 60 * 1000
      );
      console.log('[pricing] Engine started — runs every 60 minutes');
    }, 10 * 1000);
  }
}

async function warmUpSeenMessages() {
  if (!knownPropertyIds.length) return;
  console.log('[poll] Warm-up — marking existing inbox messages as seen...');

  // Restore persisted seen-keys first so a restart doesn't re-reply to messages
  // we already handled (the in-memory Set is otherwise wiped on every restart).
  const persisted = loadSeen();
  for (const k of persisted) seenMessageIds.add(k);
  console.log(`[poll] Warm-up: restored ${persisted.size} persisted seen-keys`);

  // Grace window: messages younger than 5 minutes are NOT marked seen.
  // pollingSince is also set to this same cutoff so the two systems stay aligned.
  const graceCutoff = toHospitableDate(new Date(Date.now() - 5 * 60 * 1000));

  // ── Reservations ────────────────────────────────────────────────────────────
  try {
    const qs = buildPropertyQs();
    const data = await hospGet(`/reservations?${qs}&per_page=50&include=guest`);
    const reservations = parseReservations(data);
    console.log(`[poll] Warm-up: found ${reservations.length} reservations to scan`);

    for (const r of reservations) {
      try {
        const msgData = await hospGet(`/reservations/${r.id}/messages?per_page=20`);
        const messages = parseMessages(msgData);
        for (const m of messages) {
          if (isWithinGrace(m.created_at)) {
            console.log(`[poll] Warm-up: leaving recent reservation message unseen (${m.created_at})`);
            continue;
          }
          seenMessageIds.add(messageKey(r.id, m));
        }
      } catch (e) {
        console.warn(`[poll] Warm-up: could not fetch messages for reservation ${r.id}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn('[poll] Warm-up: could not fetch reservations:', e.message);
  }

  // ── Inquiries — mark existing inquiry IDs as seen so we don't re-process on restart ──
  // NOTE: GET /inquiries/{id}/messages returns 405 (POST-only endpoint).
  // Inquiry message CONTENT arrives only via webhook (message.created payload).
  // The poller can only list inquiry IDs; actual message handling is webhook-driven.
  if (!inquiriesUnavailable) {
    try {
      const data = await hospGet(`/inquiries?${buildPropertyQs()}&per_page=50`);
      const inquiries = parseInquiries(data);
      console.log(`[poll] Warm-up: found ${inquiries.length} inquiries — marking IDs as seen (messages via webhook only)`);
      // Mark each inquiry ID itself as seen so the poll loop won't try to re-fetch messages.
      // Message dedup happens at the webhook layer via seenMessageIds.
      for (const inq of inquiries) {
        seenMessageIds.add(`inquiry:${inq.id}:warmed`);
      }
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('403')) {
        inquiriesUnavailable = true;
        console.log(`[poll] Warm-up: inquiry endpoint unavailable — skipping inquiry warm-up`);
      } else {
        console.warn('[poll] Warm-up: could not fetch inquiries:', e.message);
      }
    }
  }

  saveSeen(seenMessageIds);
  console.log(`[poll] Warm-up done — ${seenMessageIds.size} existing messages marked seen (grace window: ${graceCutoff})`);
}

async function pollForNewMessages() {
  if (!knownPropertyIds.length || !pollingSince) return;
  if (!process.env.HOSPITABLE_API_KEY) return;

  // ── Reservations (covers bookings + booking-requests) ──────────────────────
  await pollReservationMessages();

  // ── Inquiries (covers pre-booking messages with no reservation yet) ─────────
  await pollInquiryMessages();
}

async function pollReservationMessages() {
  try {
    const since = toHospitableDate(new Date(Date.now() - 90 * 1000));
    const qs    = buildPropertyQs();
    // include=properties so we know which property each reservation belongs to
    const data  = await hospGet(`/reservations?${qs}&last_message_at=${encodeURIComponent(since)}&per_page=50&include=properties`);
    const reservations = parseReservations(data);

    if (reservations.length) {
      console.log(`[poll/res] ${reservations.length} reservation(s) with recent messages`);
    }

    for (const reservation of reservations) {
      const prop       = reservation.properties?.[0] || reservation.property || null;
      const propId     = prop?.id   || null;
      const propName   = prop?.public_name || prop?.name || 'your listing';
      await processNewMessages(
        reservation.id,
        'reservation',
        `/reservations/${reservation.id}/messages?per_page=10`,
        propId,
        propName,
      );
    }
  } catch (e) {
    console.error('[poll/res] Error:', e.message);
  }
}

// Inquiry endpoints were added to the Hospitable API in Sept 2024 but are not
// yet in the public OpenAPI spec. We probe them optimistically and back off if
// the endpoint is unavailable (404) or not scoped (403).
let inquiriesUnavailable = false;
let inquiryFailCount     = 0;
const INQUIRY_FAIL_LIMIT = 5;

async function pollInquiryMessages() {
  // NOTE: GET /inquiries/{id}/messages returns 405 — Hospitable's inquiry messages
  // endpoint is POST-only. Inquiry message content arrives via webhook only.
  // This poller only checks for recently-active inquiries to keep seenMessageIds warm
  // (so the webhook dedup layer recognises them). Actual replies are sent by the
  // webhook handler when it receives message.created events with inquiry_id set.
  if (inquiriesUnavailable) return;

  try {
    const since = toHospitableDate(new Date(Date.now() - 90 * 1000));
    const qs    = buildPropertyQs();
    const data  = await hospGet(`/inquiries?${qs}&last_message_at=${encodeURIComponent(since)}&per_page=50`);
    const inquiries = parseInquiries(data);

    inquiryFailCount = 0; // reset on success

    if (inquiries.length) {
      console.log(`[poll/inq] ${inquiries.length} inquir${inquiries.length === 1 ? 'y' : 'ies'} with recent activity (replies handled via webhook)`);
    }

    // No message GET here — would 405. Webhook delivers message body.
  } catch (e) {
    if (e.message.includes('404') || e.message.includes('403')) {
      inquiryFailCount++;
      if (inquiryFailCount >= INQUIRY_FAIL_LIMIT) {
        inquiriesUnavailable = true;
        console.error(`[poll/inq] CRITICAL: inquiry endpoint failed ${INQUIRY_FAIL_LIMIT} consecutive times — permanently disabling. Check inquiry:read scope. Last error: ${e.message.split(':')[0]}`);
      } else {
        console.warn(`[poll/inq] Inquiry endpoint error (${e.message.split(':')[0]}) — skipping this cycle (fail ${inquiryFailCount}/${INQUIRY_FAIL_LIMIT})`);
      }
    } else {
      console.error('[poll/inq] Error:', e.message);
    }
  }
}

async function processNewMessages(resourceId, resourceType, messagesPath, propertyId = null, propertyName = 'your listing') {
  try {
    const msgData = await hospGet(messagesPath);
    const messages = parseMessages(msgData);

    for (const msg of messages) {
      // Use sender_role (actual Hospitable field) with sender_type as fallback
      const role = msg.sender_role || msg.sender_type;
      if (role === 'host' || role === 'co-host' || role === 'teammate') continue;

      const key = messageKey(resourceId, msg);
      if (seenMessageIds.has(key)) continue;
      seenMessageIds.add(key);
      if (seenMessageIds.size > 2000) {
        seenMessageIds.delete(seenMessageIds.values().next().value);
      }
      saveSeen(seenMessageIds);

      if (msg.created_at && tsMs(msg.created_at) < tsMs(pollingSince)) continue;

      const body = (msg.body || '').trim();
      if (!body) continue;

      // Safe guest-name resolution: prefer the real GUEST object, fall back to the message sender
      // ONLY if it isn't the host/account name, else a neutral no-name greeting — NEVER the host's
      // name (see guest-name.js; the "greet Jamie as Yaasir on an inquiry" bug).
      const senderName = msg.sender?.full_name || msg.sender?.first_name;
      const hostNames = guestNameLib.hostNameSet({ hostEnvName: process.env.HOST_NAME, messages });
      const guestObj = await fetchGuestObject(resourceType, resourceId);
      const guestName = guestNameLib.resolveGuestName({ guest: guestObj, senderName, hostNames });
      const tag = resourceType.slice(0, 3);
      console.log(`[poll/${tag}] 📨 "${guestName || 'guest'}" property="${propertyName}" (${resourceId}): "${body.slice(0, 80)}"`);
      console.log(`[poll/${tag}] using profile: ${propertyProfiles.has(propertyId)}`);

      // Front-desk contingency detection — this message OR a tight burst of recent
      // short fragments. conciergeRegexHit (regex on the message or the burst) is the
      // synchronous, deterministic front-desk signal.
      const conciergeBurst    = fragmentBurst(messages);
      const conciergeRegexHit = CONCIERGE_REGEX.test(body) || (!!conciergeBurst && CONCIERGE_REGEX.test(conciergeBurst));
      const conciergeText     = (conciergeBurst && conciergeBurst.length > body.length) ? conciergeBurst : body;

      // Maintenance emergency SMS side-effect — notify host immediately
      if (MAINTENANCE_EMERGENCY_REGEX.test(body)) {
        notifyHost({ guestName, messageBody: body, propertyName, conversationKey: resourceId, resourceId, resourceType })
          .catch(e => console.error(`[maintenance] SMS failed: ${e.message}`));
      }

      // (1) COMPLAINT GUARDRAIL FIRST — a money/refund complaint must NEVER be answered with the
      // canned concierge/access reply. Checked BEFORE the concierge fire so an incidental
      // access-regex match can't short-circuit it (the Ashley/7-B refund-complaint bug, 2026-06-13:
      // the concierge regex hit first and the money check downstream never ran).
      if (isMoneyComplaint(body)) {
        console.log(`[poll/${tag}] 💸 Money/refund complaint — escalated to host, NO auto-reply (pre-concierge)`);
        notifyHost({ guestName, messageBody: body, propertyName, conversationKey: resourceId, resourceId, resourceType }).catch(console.error);
        continue;
      }

      // Concierge detection: regex fast-path; AI classifier consulted only on a regex miss.
      let conciergeHit = conciergeRegexHit;
      let conciergeVia = conciergeRegexHit ? 'regex' : '';
      if (!conciergeHit) {
        try { conciergeHit = await decideConciergeHit(conciergeText, false, `poll/${tag}`); conciergeVia = conciergeHit ? 'ai' : ''; }
        catch (e) { console.error(`[concierge-ai] poll decision error (ignored): ${e.message}`); }
      }
      if (conciergeHit) {
        // (2) CONTEXT GATE — before firing the canned reply, classify intent. A live ACCESS problem
        // → run the await-gated contingency (email → concierge SMS → guest confirmation). A PAST
        // COMPLAINT that merely tripped the access trigger → do NOT fire the canned reply; fall
        // through to the normal draftReply, whose SERVICE mode owns the issue (service recovery).
        const intent = await decideConciergeIntent(conciergeText, `poll/${tag}/${conciergeVia || 'regex'}`);
        if (intent === 'access') {
          const { reply } = await runConciergeContingency({ guestName, propertyId, resourceId, resourceType, propertyName, context: `poll/${tag}${conciergeVia === 'ai' ? '/ai' : ''}` });
          scheduleReply(resourceId, guestName, body, reply, propertyName, propertyId, resourceType);
          continue; // handled this message
        }
        console.log(`[poll/${tag}] concierge trigger OVERRIDDEN by complaint intent — routing to service reply, not the canned access flow`);
        // fall through to the generic draftReply (SERVICE-mode service recovery)
      }

      // DIRECT-QUESTION CATCH: a guest asking how to check in / for the door code gets the filled
      // check-in instructions immediately, bound to THIS reservation's own unit — unless already
      // sent (no double-send). A unit missing a field is NOT sent broken: host-alert + skip.
      // Guarded so it can never break the message handler.
      if (resourceType === 'reservation' && checkinSweep.CHECKIN_QUESTION_REGEX.test(body)) {
        try {
          const thread = await fetchMessagesForReservation(resourceId).catch(() => []);
          if (!checkinSweep.wasCheckinSent(thread)) {
            const rdata = await hospGet(`/reservations/${resourceId}?include=guest`).catch(() => null);
            const reservation = (rdata && (rdata.data || rdata)) || {};
            reservation.propertyId = propertyId;
            const plan = checkinSweep.planForReservation(
              reservation, thread, loadPropertiesMap(), doorCodes.loadStore(), process.env.HOST_NAME || 'KS');
            if (plan.action === 'send') {
              await sendToHospitable(resourceId, plan.message, resourceType);
              console.log(`[checkin] direct question → sent instructions to ${plan.unit} (${guestName})`);
              continue;
            }
            if (plan.action === 'skip') {
              console.log(`[checkin] direct question from ${guestName} (${plan.unit || '?'}) — SKIP, missing ${plan.missing.join('/')}`);
              notifyHostRaw(`⚠️ Check-in question from ${guestName} (${plan.unit || '?'}) — can't auto-send, missing ${plan.missing.join('/')}. Handle manually.`).catch(() => {});
              continue;
            }
            // already_sent → fall through to the normal reply path
          }
        } catch (e) { console.error(`[checkin] direct-question catch error (ignored): ${e.message}`); }
      }

      try {
        const { reply, confident } = await draftReply(guestName, body, propertyName, propertyId, false, resourceId, resourceType);
        if (!confident || !reply) {
          console.log(`[poll/${tag}] Low confidence — escalated to host, no guest reply`);
          notifyHost({ guestName, messageBody: body, propertyName, conversationKey: resourceId, resourceId, resourceType }).catch(console.error);
        } else {
          scheduleReply(resourceId, guestName, body, reply, propertyName, propertyId, resourceType);
        }
      } catch (e) {
        console.error(`[poll/${tag}] Error drafting reply: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[poll/${resourceType.slice(0, 3)}] Error fetching messages for ${resourceId}: ${e.message}`);
  }
}

// ─── Polling helpers ──────────────────────────────────────────────────────────

function buildPropertyQs() {
  return knownPropertyIds.map(id => `properties[]=${id}`).join('&');
}

function parseReservations(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.reservations)) return data.reservations;
  return [];
}

function parseMessages(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.messages)) return data.messages;
  return [];
}

function parseInquiries(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.inquiries)) return data.inquiries;
  return [];
}

function messageKey(reservationId, msg) {
  // platform_id is the channel-native message ID (most stable unique key)
  if (msg.platform_id) return `${reservationId}:${msg.platform_id}`;
  return `${reservationId}:${msg.created_at}`;
}

// Hospitable API requires last_message_at in PHP "Y-m-d H:i:s" format,
// not ISO 8601 — i.e. "2026-05-30 12:34:56" with a space, no T, no ms, no Z.
function toHospitableDate(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

// ─── Atlanta demand-based pricing engine — logic ─────────────────────────────

// Count reservation/inquiry threads for this property that:
//   - had a message within the last windowHours
//   - have a check_in date within the next 30 days (or unknown check_in = counted)
// Returns { count, latestAt }
async function countPropertyInquiries(propertyId, windowHours) {
  const since    = toHospitableDate(new Date(Date.now() - windowHours * 3600 * 1000));
  const todayStr = new Date().toISOString().slice(0, 10);
  const in30dStr = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  let count = 0, latestAt = null;

  const tally = (items, getPropId) => {
    for (const item of items) {
      if (getPropId && getPropId(item) !== propertyId) continue;
      const checkIn = (item.check_in || item.checkin || '').slice(0, 10);
      if (checkIn && (checkIn < todayStr || checkIn > in30dStr)) continue;
      count++;
      const t = item.last_message_at || item.updated_at || item.created_at;
      if (t && (!latestAt || t > latestAt)) latestAt = t;
    }
  };

  try {
    const data = await hospGet(
      `/reservations?properties[]=${propertyId}&last_message_at=${encodeURIComponent(since)}&per_page=50`
    );
    tally(parseReservations(data), null);
  } catch (e) {
    console.error(`[pricing] reservations lookup (${propertyId.slice(0, 8)}…):`, e.message);
  }

  if (!inquiriesUnavailable) {
    try {
      const data = await hospGet(`/inquiries?${buildPropertyQs()}&last_message_at=${encodeURIComponent(since)}&per_page=50`);
      tally(parseInquiries(data), inq =>
        inq.property_id || inq.property?.id || inq.properties?.[0]?.id
      );
    } catch (_) {}
  }

  return { count, latestAt };
}

async function runPricingEngine() {
  const runAt = new Date().toISOString();
  console.log(`[pricing] ── Hourly demand check ${runAt} ──`);

  for (const propId of ATLANTA_ALL_IDS) {
    if (legacyEngineExcluded(propId)) { console.log(`[pricing] ${propId.slice(0, 8)}… skip (excluded via PRICING_LEGACY_EXCLUDE)`); continue; }
    try {
      const rules = getPriceRules(propId);
      const state = pricingState.get(propId) || {
        price: rules.floor, lastInquiryAt: null, lastChangedAt: null, pendingPush: false, log: [],
      };

      const { count: count24h, latestAt } = await countPropertyInquiries(propId, 24);
      if (count24h > 0 && latestAt) state.lastInquiryAt = latestAt;

      const hoursSinceLast = state.lastInquiryAt
        ? (Date.now() - new Date(state.lastInquiryAt).getTime()) / 3600000
        : Infinity;

      const prev = state.price;
      let next   = prev;
      let reason = null;

      if (count24h >= 3) {
        next = Math.min(Math.round(prev * 1.10), rules.ceiling);
        if (next > prev)
          reason = `HIGH_DEMAND: ${count24h} inquiries in 24h → +10% ($${prev}→$${next})`;
      } else if (count24h === 0 && hoursSinceLast >= 48) {
        next = Math.max(Math.round(prev * 0.95), rules.floor);
        if (next < prev)
          reason = `LOW_DEMAND: 0 inquiries for ${Math.round(hoursSinceLast)}h → -5% ($${prev}→$${next})`;
      }

      const priceChanged = !!(reason && next !== prev);
      const shouldPush   = priceChanged || state.pendingPush;

      if (shouldPush) {
        // Build 31-day range of daily price updates
        const days = [];
        const d = new Date(), end = new Date(Date.now() + 30 * 24 * 3600 * 1000);
        while (d <= end) {
          days.push({ date: d.toISOString().slice(0, 10), price: { amount: next * 100 } });
          d.setDate(d.getDate() + 1);
        }

        let pushStatus = 'pending_flag';
        try {
          await hospPut(`/properties/${propId}/calendar`, days);
          pushStatus = 'pushed';
          state.pendingPush = false;
        } catch (e) {
          pushStatus = e.message.includes('422') ? 'pending_flag' : `error:${e.message.slice(0, 80)}`;
          state.pendingPush = true;
        }

        if (priceChanged) {
          const entry = {
            ts: runAt, propertyId: propId,
            from: prev, to: next, reason,
            count24h, hoursSinceLast: Math.round(hoursSinceLast), push: pushStatus,
          };
          state.price = next;
          state.lastChangedAt = runAt;
          state.log = [entry, ...(state.log || [])].slice(0, 50);
          pricingChanges.unshift(entry);
          if (pricingChanges.length > 200) pricingChanges.pop();
          console.log(`[pricing] ${propId.slice(0, 8)}… ${reason} | push=${pushStatus}`);
        } else {
          console.log(`[pricing] ${propId.slice(0, 8)}… retry push $${next} | push=${pushStatus}`);
        }
      } else {
        console.log(`[pricing] ${propId.slice(0, 8)}… no change ($${prev}) | 24h=${count24h} last=${Math.round(hoursSinceLast)}h ago`);
      }

      pricingState.set(propId, state);
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`[pricing] Engine error for ${propId}:`, e.message);
    }
  }

  pricingLastRun = runAt;
  savePricingState();
  console.log('[pricing] ── Done ──');
}

// ─── Claude API ───────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userMsgOrMessages, maxTokens = 800, model = REPLY_MODEL) {
  // Accept either a single string (legacy callers) or a full messages array
  // (conversation history). A string is wrapped as one user turn, exactly as before.
  const messages = Array.isArray(userMsgOrMessages)
    ? userMsgOrMessages
    : [{ role: 'user', content: userMsgOrMessages }];

  // Prompt caching: callers may pass `system` as a pre-built array of content blocks
  // with their own cache_control placement (see draftReply — large stable block first,
  // volatile per-message content after the breakpoint). A plain string is wrapped as a
  // single ephemeral-cached block. Caching is prefix-based: only content up to the
  // cache_control marker is cached; the messages (per-request delta) are always fresh.
  const system = Array.isArray(systemPrompt)
    ? systemPrompt
    : [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31, extended-cache-ttl-2025-04-11',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err}`);
  }
  const data = await response.json();
  // Surface cache effectiveness so we can confirm the big system block is being reused.
  const u = data.usage;
  if (u && (u.cache_read_input_tokens || u.cache_creation_input_tokens)) {
    console.log(`[claude] ${model} cache read=${u.cache_read_input_tokens || 0} write=${u.cache_creation_input_tokens || 0} fresh=${u.input_tokens || 0}`);
  }
  return data.content?.[0]?.text || '';
}

// Front-desk contingency decision: regex fast-path → AI on regex-miss → regex
// fallback on ANY error/timeout. NEVER throws and ALWAYS resolves within ~4s, so
// callers can fire-and-forget it OFF the guest-reply path (it can't block, delay,
// or crash a reply). Kill switch: env CONCIERGE_AI=false reverts to regex-only.
// Logs every decision for live audit.
async function decideConciergeHit(text, regexHit, context = '') {
  const rec = await decideConcierge({ text, regexHit, callClaude, env: process.env, timeoutMs: 4000 });
  const ai = rec.aiConsulted
    ? (rec.source === 'ai-fallback' ? `FALLBACK(${rec.rawVerdict})` : (rec.fired ? 'YES' : 'no'))
    : 'n/a';
  console.log(`[concierge-ai] ${context} regexHit=${rec.regexHit ? 'Y' : 'N'} ai=${ai} source=${rec.source} FIRED=${rec.fired ? 'YES' : 'no'} | "${String(text || '').slice(0, 140)}"`);
  return rec.fired;
}

// Context gate run AFTER a concierge trigger hits, BEFORE the canned reply fires: classify
// whether this is a live ACCESS problem (fire concierge) or a PAST COMPLAINT (don't fire the
// canned access reply). Returns 'access' | 'complaint'. Never throws; fail-open to 'access'.
async function decideConciergeIntent(text, context = '') {
  const rec = await classifyAccessIntent({ text, callClaude, env: process.env, timeoutMs: 4000 });
  console.log(`[concierge-intent] ${context} intent=${rec.intent} source=${rec.source} | "${String(text || '').slice(0, 140)}"`);
  return rec.intent;
}

// Run the front-desk contingency once a hit is confirmed: await the email, then
//   success → (trial) SMS the host "✅ … SENT" when CONCIERGE_NOTIFY_ALL!=='false'
//   failure → SMS the host "❌ … FAILED" escalation (always)
// Returns { ok, reply } from resolveConciergeReply (never throws). Used by both the
// regex/burst await-gated path and the fire-and-forget AI path.
async function runConciergeContingency({ guestName, propertyId, resourceId, resourceType, propertyName, context }) {
  const propMap   = loadPropertiesMap();
  const unitLabel = propMap[propertyId]?.label || propMap[propertyId]?.unit || `unit (${(propertyId || '').slice(0, 8)})`;
  const notifyAll = process.env.CONCIERGE_NOTIFY_ALL !== 'false'; // trial: default ON; set false to revert to failure-only
  const conciergeEmailTo = process.env.CONCIERGE_EMAIL_TO || '300ptconcierge@gmail.com';
  const conciergePhone   = process.env.CONCIERGE_PHONE; // front-desk SMS recipient (unset → sendOpenPhoneSms no-ops with a warn)
  const res = await resolveConciergeReply({
    guestName, unitLabel, notifyAll,
    sendEmail:       () => sendConciergeEmail({ guestName, propertyId, resourceId, resourceType }),
    notifyConcierge: () => sendOpenPhoneSms(conciergePhone, conciergeSms({ guestName, unitLabel, conciergeEmail: conciergeEmailTo })),
    notifySuccess:   (text) => notifyHostRaw(text),
    escalate:        (e) => notifyHostRaw(conciergeFailedSms({ guestName, unitLabel, error: e })),
  });
  console.log(`[${context}] concierge ${res.ok ? `email OK → guest confirmed${notifyAll ? ' + host SMS (SENT)' : ''}` : 'email FAILED → honest reply + host escalated'}`);
  return res;
}

// ─── Host-reply detection ─────────────────────────────────────────────────────

// Re-fetch a thread from Hospitable and report whether the host (me / my team)
// posted a message AFTER the guest's most recent message. Used to (a) skip an
// auto-reply when I've already answered, and (b) mark a conversation "resolved"
// so host-alert SMS stops. A host message counts when sender_role/sender_type is
// one of HOST_REPLY_ROLES; the guest's latest is the newest non-host message.
async function hostRepliedAfterGuest(resourceId, resourceType = 'reservation') {
  const seg = resourceType === 'inquiry' ? 'inquiries' : 'reservations';
  const data = await hospGet(`/${seg}/${resourceId}/messages?per_page=50`);
  const msgs = parseMessages(data);
  let lastGuest = 0, lastHost = 0, lastHostAt = null;
  for (const m of msgs) {
    const t = tsMs(m.created_at);
    if (!t || Number.isNaN(t)) continue;
    const role = m.sender_role || m.sender_type || '';
    if (HOST_REPLY_ROLES.has(role)) {
      if (t > lastHost) { lastHost = t; lastHostAt = m.created_at; }
    } else if (t > lastGuest) {
      lastGuest = t; // newest non-host message = guest's latest
    }
  }
  return { replied: lastGuest > 0 && lastHost > lastGuest, lastHostAt, lastGuest, lastHost };
}

// ─── Host notifications ───────────────────────────────────────────────────────

// Send a raw SMS to the host exactly as written (no "needs your reply" wrapper).
// Used for concierge SENT/FAILED notifications, which need precise wording.
async function notifyHostRaw(text) {
  const apiKey = process.env.QUO_API_KEY;
  const from   = process.env.QUO_FROM_NUMBER;
  const to     = process.env.NOTIFY_PHONE;

  if (!apiKey || !from || !to) {
    console.warn(`[notify] (no SMS creds) would send: "${text}"`);
    return;
  }
  try {
    const res = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: [to], from, content: text.slice(0, 300) }),
    });
    if (!res.ok) throw new Error(`OpenPhone ${res.status}: ${await res.text()}`);
    console.log(`[notify] SMS sent via OpenPhone to ${to}: "${text.slice(0, 80)}"`);
  } catch (e) {
    // LOUD on purpose: a failed host alert (e.g. OpenPhone 402 out-of-credits) must
    // never be a quiet one-liner — this means the host was NOT notified at all.
    console.error(`[notify] ❗❗ HOST ALERT NOT DELIVERED — OpenPhone SMS FAILED: ${e.message} | undelivered text: "${text.slice(0, 160)}"`);
  }
}

// Generic OpenPhone sender to an ARBITRARY recipient (modeled on the cleaning-SMS sender).
// notifyHostRaw stays NOTIFY_PHONE-only by design; this one takes a `to` so we can text the
// front desk (CONCIERGE_PHONE). Never throws — returns {ok}. No-op (warn) if creds/recipient missing.
async function sendOpenPhoneSms(to, text) {
  const apiKey = process.env.QUO_API_KEY;
  const from   = process.env.QUO_FROM_NUMBER;
  if (!apiKey || !from || !to) {
    console.warn(`[sms] (no creds or no recipient: to=${to || 'unset'}) would send: "${String(text).slice(0, 120)}"`);
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: [to], from, content: String(text).slice(0, 1000) }),
    });
    if (!res.ok) throw new Error(`OpenPhone ${res.status}: ${await res.text()}`);
    console.log(`[sms] sent to ${to}: "${String(text).slice(0, 80)}"`);
    return { ok: true };
  } catch (e) {
    console.error(`[sms] ❗ SMS to ${to} FAILED: ${e.message}`);
    return { ok: false, error: e };
  }
}

// Throttled host alert, keyed per conversation (conversationKey). Sends ONE alert
// when a conversation first needs a reply, suppresses for 15 min, then sends up to
// 2 collapsed reminders if the guest keeps messaging AND the host hasn't replied,
// then goes silent; a 6h+ quiet gap resets the cycle. If resourceId is provided we
// re-check the Hospitable thread first — a detected host reply marks the convo
// resolved and stops alerts. Without a conversationKey (e.g. manual /api/notify),
// falls back to the original always-send behavior.
async function notifyHost({ guestName, messageBody, propertyName, conversationKey, resourceId, resourceType = 'reservation' }) {
  // guestName may be null (no trustworthy guest name) — show a neutral label in host alerts.
  const who = guestName || 'a guest';
  const firstAlertText = `⚠ AutoHost: ${who} at ${propertyName} needs your reply. Message: "${messageBody.slice(0, 100)}"`;
  if (!conversationKey) return notifyHostRaw(firstAlertText);

  let hostReplied = false;
  if (resourceId) {
    try {
      ({ replied: hostReplied } = await hostRepliedAfterGuest(resourceId, resourceType));
    } catch (e) {
      // On a lookup error, assume NOT replied so we don't wrongly silence alerts.
      console.warn(`[notify] host-reply check failed for ${conversationKey} (${e.message}) — assuming not replied`);
    }
  }

  const now = Date.now();
  const { action, count, state } = decideAlert(alertState.get(conversationKey), now, hostReplied);
  alertState.set(conversationKey, state);
  saveAlerts(alertState);

  switch (action) {
    case 'first':
      return notifyHostRaw(firstAlertText);
    case 'reminder':
      return notifyHostRaw(`⚠ AutoHost: ${who} — ${count} new message${count === 1 ? '' : 's'}, still needs reply`);
    case 'resolved':
      console.log(`[notify] host already replied — ${conversationKey} resolved, no alert sent`);
      return;
    case 'suppress':
      console.log(`[notify] within 15-min window — alert suppressed for ${conversationKey} (pending ${state.pendingCount})`);
      return;
    case 'silent':
      console.log(`[notify] max reminders reached or resolved — silent for ${conversationKey}`);
      return;
  }
}

// ─── Hardcoded responses — bypass Claude for common predictable questions ─────

// ─── Money / refund complaints — NEVER auto-reply ────────────────────────────
// A guest complaint involving a refund, compensation, money, a dispute, "had to pay",
// or "cost me" must NOT get an auto-reply. The bot over-promised "coordinating with
// Airbnb … I'll follow up" on Ashley Marrow's (21-D) hotel-cost complaint, committing the
// host to a resolution/refund he never authorized. These ESCALATE to the host (SMS) and
// stay SILENT to the guest — the host handles money, disputes, and compensation personally.
const COMPLAINT_MONEY_REGEX = new RegExp([
  '\\brefunds?\\b', '\\breimburs', '\\bcompensat', '\\bcharge\\s?back', '\\bdispute\\b',
  'cost\\w*\\s+(me|us)\\b', 'out[ -]of[ -]pocket', 'money\\s+back', '\\bowe[ds]?\\s+(me|us)\\b',
  'lost\\s+money', '(more|my)\\s+money', 'had to\\s+(pay|spend)\\b',
  'had to\\s+(book|get|rent|find|reserve|grab)\\s+(?:a\\s+|an\\s+|another\\s+|my\\s+)?(hotel|motel|room|airbnb|air\\s?bnb|place|lodging|somewhere)',
  'want.{0,25}(refund|money\\s+back|compensat)',
].join('|'), 'i');
const isMoneyComplaint = (text) => COMPLAINT_MONEY_REGEX.test(String(text || ''));

// ─── Frustration / complaint sentiment (triggers DE-ESCALATION guidance) ─────
// Heuristic signal that a guest reads as upset/frustrated/complaining, so draftReply layers in
// DE_ESCALATION_GUIDANCE (a real acknowledgement first, own it, lower the temperature). This is a
// TONE gate only — it never changes facts/policies, and the isMoneyComplaint escalation (which
// runs earlier and stays silent) still owns anything about money/refunds. Best-effort: the model
// also gets the full thread + guidance, so borderline cases are still handled gracefully.
const FRUSTRATION_REGEX = new RegExp([
  '\\bfrustrat\\w*', '\\bupset\\b', '\\bangry\\b', '\\bfurious\\b', '\\bannoyed\\b', '\\birritat\\w*',
  '\\bunacceptable\\b', '\\bridiculous\\b', '\\bdisappoint\\w*', '\\bterrible\\b', '\\bawful\\b',
  '\\bhorrible\\b', '\\bdisgust\\w*', '\\bfilthy\\b', '\\bnightmare\\b', '\\boutrageous\\b',
  '\\bappalled\\b', '\\bruined\\b', '\\bthe\\s+worst\\b', '\\bfed\\s+up\\b', '\\bnot\\s+happy\\b',
  '\\bnot\\s+okay\\b', '\\bnot\\s+acceptable\\b', '\\bvery\\s+(?:disappointed|unhappy|upset)\\b',
  '\\bcompletely\\s+unacceptable\\b', '\\bspeak\\s+to\\s+(?:a\\s+)?(?:manager|someone|the\\s+owner)\\b',
  '\\bthis\\s+is\\s+(?:unacceptable|ridiculous|not\\s+okay)\\b', '\\bkeeps?\\s+piling\\s+up\\b',
  '\\bmultiple\\s+(?:issues|problems|disruptions)\\b', '\\bdid\\s+not\\s+receive\\s+(?:the|what)\\b',
].join('|'), 'i');
const isFrustrated = (text) => FRUSTRATION_REGEX.test(String(text || ''));

// ─── Concierge / front-desk access issues ────────────────────────────────────

const CONCIERGE_REGEX = new RegExp(
  // Every apostrophe below is written straight ('); .replace() at the end turns
  // each one into the class ['’] so the regex matches BOTH straight and curly
  // (U+2019) apostrophes — phone keyboards autoinsert the curly one.
  (
  // Physical denial / access blocked
  "won'?t\\s+let\\s+me\\s+in|wont\\s+let\\s+me\\s+in" +
  "|can'?t\\s+get\\s+in|cant\\s+get\\s+in" +
  "|they\\s+won'?t\\s+let|they\\s+wont\\s+let" +
  "|not\\s+letting\\s+me\\b" +
  "|denied\\s+access|turned\\s+away" +
  "|said\\s+i\\s+can'?t\\s+come\\s+up|says\\s+i\\s+can'?t\\s+come\\s+up" +
  "|won'?t\\s+allow|wont\\s+allow" +
  "|security\\s+won'?t\\s+let" +
  "|won'?t\\s+buzz\\s+me|they\\s+won'?t\\s+buzz" +
  "|guard\\s+is\\s+asking|asking\\s+for\\s+authorization" +
  "|can'?t\\s+get\\s+to\\s+my\\s+floor" +
  // Check-in failure (not followed by "early" or a time to avoid early-checkin collision)
  "|unable\\s+to\\s+check[\\s-]?in" +
  "|cannot\\s+check[\\s-]?in" +
  "|can'?t\\s+check[\\s-]?in(?!\\s*early|\\s+at\\s+\\d|\\s+until|\\s+before)" +
  // Reservation not found / system issue
  "|no\\s+reservation|no\\s+booking|no\\s+record\\b" +
  "|not\\s+in\\s+the\\s+system" +
  "|doesn'?t\\s+show\\s+up|not\\s+showing\\s+up|not\\s+showing\\s+a\\s+reservation" +
  "|can'?t\\s+find\\s+my\\s+reservation|cannot\\s+find\\s+my\\s+reservation" +
  "|don'?t\\s+have\\s+a\\s+reservation|don'?t\\s+see\\s+a?\\s+reservation" +
  "|don'?t\\s+have\\s+me\\b" +
  // Form / front desk
  "|check[\\s-]in\\s+form|form\\s+not\\s+sent" +
  "|building\\s+won'?t|building\\s+wont" +
  "|they\\s+need\\s+a\\s+form|front\\s+desk\\s+needs|need\\s+a\\s+form" +
  // Form never sent / never received — "form" present AND a negation followed (within
  // ~2 words) by a send/receive verb. Catches "form was never sent", "didn't receive
  // the form", "never received the form", "you never sent me the form", "front desk
  // never got my form", "no one sent the form to the building".
  "|(?=[\\s\\S]*\\bform\\b)(?=[\\s\\S]*\\b(?:never|not|wasn'?t|hasn'?t|haven'?t|didn'?t|did\\s+not|no\\s+one|nobody)\\s+(?:\\w+\\s+){0,2}?(?:sent|send|receiv\\w*|got|get|gotten|gave|give|provided)\\b)" +
  // Front desk / concierge doesn't have (or never received) the reservation.
  // The third lookahead MUST name a real desk/lobby word. 'building', 'they', and 'system'
  // were REMOVED on 2026-06-13: they false-fired on a refund complaint (Ashley/7-B) that
  // only incidentally contained "reservation" + "did not receive" + "they"/"building" with
  // no actual desk involvement. A bare "they don't have my reservation" now falls to the AI
  // classifier instead of this zero-width regex clause.
  "|(?=[\\s\\S]*\\breservation\\b)(?=[\\s\\S]*(?:doesn'?t|does\\s+not|didn'?t|did\\s+not|don'?t\\s+have|do\\s+not\\s+have|no\\s+record|can'?t\\s+find|cannot\\s+find|never\\s+(?:got|received)))(?=[\\s\\S]*(?:front\\s+desk|\\bdesk\\b|concierge|reception|lobby))" +
  // Send / forward (or "did you send?") my reservation/info/form to the concierge
  // / front desk / building. Broadened beyond the literal word "reservation" and
  // works for both commands and status-questions (lookahead-only, grammar-agnostic).
  // NOTE: 'details' and 'building' were REMOVED from this pattern on 2026-06-09 — they
  // false-fired on normal pre-arrival questions ("when will you send the details… access
  // the building", Ashley/7-B). 'details' = the guest's own awaited info, 'building' = a
  // place they enter, neither implies a desk handoff. Keep specific reservation/form nouns
  // + a real desk word (concierge/front desk/desk/reception/lobby).
  "|(?=[\\s\\S]*\\b(?:reservation|reservations|info|information|informations|form|paperwork|registration|booking)\\b)(?=[\\s\\S]*(?:send|sent|sending|forward|forwarded|over\\s+to|pass(?:ed)?\\s+(?:on|along)))(?=[\\s\\S]*(?:concierge|front\\s+desk|\\bdesk\\b|reception|lobby))" +
  // NOTE: "key" / fob / entry-code / door-code phrasings intentionally do NOT trigger
  // the front-desk contingency. Every unit has a coded door lock (Hospitable's Schlage
  // integration), so a guest saying "key"/"fob" means a building-access fob or amenity
  // access — NOT a check-in failure. Only form / confirm / send-the-reservation / lobby /
  // no-record-at-the-desk messages fire it. (Removed "elevator requires a key" 2026-06-06.)
  // ── 2026-06-03: phrasings that slipped through the night of 2026-06-02 (44-min
  // late concierge email). This is a front-desk/concierge high-rise — the desk
  // checks guests in only after we send a form or supplementary email, so plain
  // front-desk / lobby / room-number language is high-signal here even without an
  // explicit "reservation/form" word. Promote these to direct triggers.
  // front desk / concierge / reception co-occurring with a confirm/call/wait/ask intent
  "|(?=[\\s\\S]*(?:front\\s+desk|concierge|reception))(?=[\\s\\S]*(?:confirm|call(?:ed|ing)?|waiting|wait\\b|asking|ask\\b))" +
  // waiting / stuck / still in the lobby (or downstairs) — desk hasn't let them up
  "|(?:waiting|stuck|still)\\s+(?:\\w+\\s+){0,3}?(?:in\\s+(?:the\\s+)?lobby|downstairs)" +
  "|in\\s+the\\s+lobby\\b(?=[\\s\\S]*(?:waiting|still|stuck|can'?t|won'?t|let\\s+me))" +
  // internal jargon: guest relaying our "update me in the spreadsheet" workflow
  "|update\\s+(?:me|us)\\s+(?:in|on)\\s+(?:the\\s+)?spread\\s?sheet" +
  // room-number question at/around check-in (the desk can't place the guest)
  "|what'?s?\\s+(?:the\\s+|my\\s+)?room\\s+(?:number|#)|which\\s+room\\s+(?:am\\s+i|is)|what\\s+room\\s+(?:am\\s+i|number)" +
  // Compound: location word + access-denial word anywhere in the message
  "|(?=[\\s\\S]*(?:desk|lobby|reception))(?=[\\s\\S]*(?:can'?t|unable|no\\s+reservation|won'?t|wont|not\\s+letting))"
  ).replace(/'/g, "['’]"),  // accept straight ' and curly ’ apostrophes (mobile keyboards)
  "i"
);

const MAINTENANCE_EMERGENCY_REGEX = /water\s+leak|no\s+hot\s+water|smoke\s+alarm|fire\s+alarm|flood(ing)?|no\s+electricity|power\s+(is\s+)?out/i;

// Only 'accepted' is a valid Hospitable status for a confirmed booking (it also
// covers guests currently in-stay). 'checked_in' is NOT a valid status value →
// HTTP 400, which previously made this lookup throw and the concierge email show
// N/A check-in/out dates.
function buildActiveReservationPath(propertyId) {
  return `/reservations?properties[]=${propertyId}&status[]=accepted&per_page=5&include=guest`;
}

// Pure: pick the reservation whose [check_in, check_out] spans `today`
// (YYYY-MM-DD), else the most recent. `today` must already be in the property's
// local timezone (the caller passes the ET date).
function findActiveReservation(reservations, today) {
  return (
    reservations.find(r => {
      const ci = (r.check_in  || r.checkin  || '').slice(0, 10);
      const co = (r.check_out || r.checkout || '').slice(0, 10);
      return ci && co && ci <= today && co >= today;
    }) ||
    reservations[0] ||
    null
  );
}

async function getActiveReservation(propertyId) {
  if (!propertyId) return null;
  try {
    const data = await hospGet(buildActiveReservationPath(propertyId));
    const reservations = parseReservations(data);
    // "today" must be the property-local (Atlanta) date — a UTC date rolls a day
    // ahead in the ET evening and mis-selects the active reservation on turnover days.
    const today = dateInTimeZone(new Date(), 'America/New_York');
    return findActiveReservation(reservations, today);
  } catch (e) {
    console.error('[concierge] Could not fetch reservation:', e.message);
    return null;
  }
}

async function sendConciergeEmail({ guestName, propertyId, resourceId, resourceType }) {
  const propMap   = loadPropertiesMap();
  const unitEntry = propMap[propertyId] || {};
  const unitLabel = unitEntry.label || unitEntry.unit || `unit (${(propertyId || '').slice(0, 8)})`;

  const reservation = resourceType === 'reservation'
    ? await getActiveReservation(propertyId)
    : null;
  const checkIn  = reservation?.check_in  || reservation?.checkin  || 'N/A';
  const checkOut = reservation?.check_out || reservation?.checkout || 'N/A';
  const arrivalTime = reservation?.arrival_time || reservation?.check_in_time || '4:00 PM';
  const g = reservation?.guests;
  const numGuests = (g && typeof g === 'object')
    ? (g.total ?? (((g.adults || 0) + (g.children || 0)) || null))
    : (g ?? reservation?.number_of_guests ?? null);

  const { subject, body, html } = buildConciergeEmail({ guestName, unitLabel, checkIn, checkOut, arrivalTime, numGuests });

  const to = process.env.CONCIERGE_EMAIL_TO || '300ptconcierge@gmail.com';
  console.log(`[concierge] Sending email — unit=${unitLabel} guest="${guestName}" to=${to}`);

  const resendKey  = process.env.RESEND_API_KEY;
  const gmailUser  = process.env.GMAIL_USER;
  const gmailPass  = process.env.GMAIL_APP_PASSWORD;

  if (!resendKey && !gmailUser) {
    // No way to actually send — treat as a failure so the guest is never told it
    // was emailed when it wasn't. Callers own escalation.
    console.error('[concierge] No email credentials set — cannot send front-desk email');
    console.error(`[concierge] (would-be) TO: ${to} | SUBJECT: ${subject}`);
    throw new Error('No email credentials configured (RESEND_API_KEY / GMAIL_USER)');
  }

  try {
    if (resendKey) {
      // Resend HTTP API — works on Railway (no outbound SMTP port required)
      const resend = new Resend(resendKey);
      const from   = process.env.RESEND_FROM || `Peachtree Tower Rentals <${gmailUser || 'cal@peachtreestayatl.com'}>`;
      const result = await resend.emails.send({ from, to, subject, text: body, html });
      if (result.error) throw new Error(`Resend error: ${JSON.stringify(result.error)}`);
      console.log(`[concierge] ✓ Email sent via Resend to ${to} — id=${result.data?.id}`);
      return;
    }

    // Nodemailer SMTP fallback (may be blocked by some hosting providers)
    const transporter = nodemailer.createTransport({
      host:              'smtp.gmail.com',
      port:              465,
      secure:            true,
      auth:              { user: gmailUser, pass: gmailPass },
      connectionTimeout: 10000,
      greetingTimeout:   10000,
      socketTimeout:     15000,
    });
    await transporter.sendMail({ from: gmailUser, to, subject, text: body, html });
    console.log(`[concierge] ✓ Email sent via SMTP to ${to} for ${guestName} in ${unitLabel}`);
  } catch (e) {
    // Leaf function: surface the failure to the caller. The caller owns escalation
    // (host SMS) + the honest guest reply, so escalation happens exactly once.
    console.error(`[concierge] ✗ Email FAILED to ${to}: ${e.message}`);
    throw e;
  }
}

// Active entry / lock failure. Broadened from the original (locked out | key doesn't work |
// can't open the door | lock isn't working | fob stopped) to ALSO catch door-code / keypad
// malfunctions — the front-desk concierge classifier deliberately excludes these, so without
// this they fall through to a generic reply instead of the instant lockout response.
// Scoped to an ACTIVE failure: every branch requires a failure signal (won't/isn't/doesn't
// work, broken, beeps red, won't open). A bare mention — "what's my door code?", "how does the
// keypad work?", "is the code working?" — has no failure verb and never matches.
const LOCKOUT_REGEX = new RegExp([
  'locked?\\s*out',
  'fob\\s+stopped',
  // code / keypad / lock / key / fob + "(isn't|won't|doesn't|not|stopped) … work"
  '\\b(?:door\\s*code|entry\\s*code|key\\s*pad|keypad|code|lock|key|fob)\\b[^.?!\\n]{0,16}(?:isn\'?t|is\\s*not|are\\s*not|aren\'?t|won\'?t|will\\s*not|wont|does\\s*not|doesn\'?t|not|stopped)\\s*work',
  // code / keypad / lock / fob + broken / dead / malfunctioning / not responding
  '\\b(?:door\\s*code|entry\\s*code|keypad|key\\s*pad|code|lock|fob)\\b[^.?!\\n]{0,16}(?:broken|malfunction(?:ing)?|dead|not\\s+responding)',
  // keypad beeping / flashing red (or a red beep/flash signal)
  'keypad[^.?!\\n]{0,20}red',
  '(?:beep|flash|blink)(?:s|ing)?[^.?!\\n]{0,8}red',
  // door won't / can't open or unlock
  'door[^.?!\\n]{0,12}(?:won\'?t|wont|will\\s*not|can\'?t|cant|cannot|wouldn\'?t|doesn\'?t)[^.?!\\n]{0,12}(?:open|unlock|budge)',
  // can't open/unlock the door / can't get the door open
  'can\'?t[^.?!\\n]{0,20}(?:open|unlock)[^.?!\\n]{0,12}(?:door|unit|apartment|room|it)',
  'can\'?t[^.?!\\n]{0,16}door[^.?!\\n]{0,12}(?:open|unlock)',
  'can\'?t\\s+get\\s+(?:in|into\\s+the\\s+(?:unit|apartment|room|door)|through\\s+the\\s+door)',
].join('|'), 'i');

function detectHardcodedResponse(guestName, messageBody) {
  const b = messageBody.toLowerCase();
  const name = (guestName || 'there').split(' ')[0]; // first name only

  // Front desk / building access — highest priority, fires before everything else
  if (CONCIERGE_REGEX.test(b)) {
    return { confident: true, reply: conciergeGuestReply(guestName) };
  }

  // Lockout / key not working — second-highest priority after concierge
  if (LOCKOUT_REGEX.test(b)) {
    return {
      confident: true,
      reply: `Hi ${name}, I'm sorry about that! Please call or text 954-552-2122 right away and we'll get you in immediately. 🔑`,
    };
  }

  // Maintenance emergency
  if (MAINTENANCE_EMERGENCY_REGEX.test(b)) {
    return {
      confident: true,
      reply: `Hi ${name}, please contact building security at the front desk immediately for any in-unit emergency. You can also reach us directly at 954-552-2122. I'm being notified now. 🚨`,
    };
  }

  // Age requirement
  if (
    /\bage\b|how old|minimum age|age requirement|\byoung\b|years old/.test(b) ||
    (/\b2[1-5]\b/.test(b) && /\byear|\bold\b/.test(b))
  ) {
    return {
      confident: true,
      reply: `Hi ${name}, thank you for your interest in booking our property! Our minimum age requirement is 26, but we do occasionally make exceptions for the right guest.\n\nTo be considered as an exception, please provide us with the following details:\n- Who you'll be traveling with\n- The purpose of your trip\n- How many guests will be staying at the property\n\nOnce we have this information, we'll be happy to review your request and let you know if we can accommodate your booking. Looking forward to hearing from you!\n\nBest,\nCal`,
    };
  }

  // Early check-in
  if (/early.{0,15}check[\s-]?in|check[\s-]?in.{0,15}early|arriv.{0,15}early|early.{0,15}arriv/.test(b)) {
    return {
      confident: true,
      reply: `Thank you for reaching out! We'd be happy to accommodate an early check-in, depending on availability. The earliest we can offer is 1:00 PM, and there is a $45 early check-in fee to cover the additional preparation time.\n\nIf you'd like to proceed, just let us know and we'll confirm availability and send over the payment request. Looking forward to hosting you!\n\nBest,\nCal`,
    };
  }

  // Late checkout
  if (/late.{0,15}check[\s-]?out|check[\s-]?out.{0,15}late|stay.{0,10}later?\b|late.{0,10}depart|extend.{0,15}check/.test(b)) {
    return {
      confident: true,
      reply: `Thanks for reaching out! We do offer late check-out based on availability, and the latest we can accommodate is 1:30 PM for a $45 fee.\n\nIf you'd like to proceed, just let us know and we'll confirm availability and send over the payment request. Looking forward to your stay!\n\nBest,\nCal`,
    };
  }

  // Towels / linens
  if (/\btowel|\blinen|\bbed.?sheet/.test(b)) {
    return {
      confident: true,
      reply: "Fresh towels are in the closet and dressers! If you need extras, we can have our cleaning team bring some over — just say the word 😊",
    };
  }

  // Heating & cooling / thermostat
  if (/\bheat(ing)?\b|\bcooling\b|\ba[\s\/]?c\b|air.?condition|thermostat|\btemperature\b|\bcold\b|\bwarm\b|too hot|too cold|adjust.{0,15}temp|\bradiat(or|ion)\b/.test(b)) {
    return {
      confident: true,
      reply: `To adjust the heating and cooling, follow these steps:\n\nSeasonal adjustment: As mentioned in the listing, the heating/cooling functions change with the seasons. In spring and summer you can adjust the A/C, while in late fall and winter you can adjust the heating controls.\n\nAccessing controls: Locate the radiation unit underneath the window in each room.\n\nPanel access: On top of the radiation unit, find the square panel.\n\nActivating controls: Press the back two corners of the square panel to display the fan adjustment controls.\n\nBy following these steps, you can access and adjust the heating and cooling according to your needs. Feel free to reach out if you need any further assistance!\n\nBest,\nCal`,
    };
  }

  // Parking questions are intentionally NOT hardcoded — they flow to draftReply,
  // which injects PARKING_SECTION (src/knowledge/parking.md) so Claude answers the
  // specific question from verified facts only. (Concierge + door-code stay hardcoded.)

  // WiFi / internet
  if (/\bwi?-?fi\b|\bpassword\b|\binternet\b|\bnetwork\b/.test(b)) {
    return {
      confident: true,
      reply: `Hi ${name}, the WiFi network name and password are posted on the welcome card inside the unit and will also be included in your check-in instructions sent 24 hours before arrival. If you're already checked in and can't find it, reply here and I'll send it right over! 😊`,
    };
  }

  return null;
}

// ─── Reply drafting ───────────────────────────────────────────────────────────

function findSimilarExamples(propertyId, guestMessage, count = 3) {
  const history = propertyHistory.get(propertyId) || [];
  if (!history.length) return [];
  // Simple keyword matching to find relevant examples
  const words = guestMessage.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const scored = history.map(pair => {
    const text = (pair.guest + ' ' + pair.host).toLowerCase();
    const score = words.filter(w => text.includes(w)).length;
    return { ...pair, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, count).filter(p => p.score > 0);
}

// Build an Anthropic messages array from a Hospitable reservation thread so Claude
// sees the real conversation (what it already said + what the guest actually asked).
//   guest (sender_type/sender_role) → {role:'user'};  host/co-host/teammate → {role:'assistant'}.
// Chronological; empty-body messages skipped; consecutive same-role turns merged
// (the API wants alternating roles); capped to the last `cap` turns; and guaranteed
// to end with the latest guest message.
//
// The Anthropic messages array MUST start with a user turn, so any leading host
// (assistant) turns are removed from `messages` — but their content is NOT discarded.
// It is returned in `priorContext` so the caller can fold it into the SYSTEM prompt
// ("messages already sent to this guest"). This is the fix for the bug where the
// first host turn (often the check-in details we already sent — door code, Wi-Fi,
// access) was silently deleted, leaving the model unaware it had been covered.
// For threads longer than `cap`, the oldest turns beyond the window are NOT dropped silently —
// they're condensed into `olderSummary` so the conversation's opening context survives.
// Returns: { messages: [{role, content}], priorContext: string, olderSummary: string }.
//
// Condense the oldest turns (outside the kept window) into a short digest that preserves the
// conversation's OPENING context. Deterministic (no LLM): role-label, truncate, cap the count.
function summarizeOlderTurns(older, maxTurns = 8, perTurn = 160) {
  if (!older || !older.length) return '';
  const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
  const head = older.slice(0, maxTurns).map(t =>
    `${t.role === 'assistant' ? 'You (host)' : 'Guest'}: ${oneLine(t.content).slice(0, perTurn)}`);
  const more = older.length > maxTurns ? `\n… (+${older.length - maxTurns} more earlier turns)` : '';
  return head.join('\n') + more;
}

function buildThreadMessages(thread, latestBody, cap = 30) {
  const HOST_ROLES = new Set(['host', 'co-host', 'teammate']);
  const roleOf = m => (HOST_ROLES.has(m.sender_role || m.sender_type) ? 'assistant' : 'user');
  const latest = (latestBody || '').trim();

  // Chronological order — sort defensively, the API order is not guaranteed.
  const sorted = (thread || []).slice().sort((a, b) => (tsMs(a.created_at) || 0) - (tsMs(b.created_at) || 0));

  let turns = [];
  for (const m of sorted) {
    const content = (m.body || '').trim();
    if (!content) continue;                       // skip empty-body messages
    turns.push({ role: roleOf(m), content });
  }

  // Guarantee the new guest message is the final user turn (in case the thread
  // fetch lagged and didn't include it yet, or it isn't last).
  const last = turns[turns.length - 1];
  if (latest && (!last || last.role !== 'user' || last.content !== latest)) {
    turns.push({ role: 'user', content: latest });
  }

  // Keep the last ~cap turns; turns older than that are condensed into olderSummary (so a long
  // thread keeps its opening context) rather than silently dropped. Then merge consecutive
  // same-role turns and ensure the array starts with a user turn (Anthropic requires user-first).
  const kept = turns.slice(-cap);
  const older = turns.slice(0, Math.max(0, turns.length - kept.length));
  const olderSummary = summarizeOlderTurns(older);
  turns = kept;
  const merged = [];
  for (const t of turns) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === t.role) prev.content += `\n\n${t.content}`;
    else merged.push({ role: t.role, content: t.content });
  }
  // Leading host turns can't lead the messages array, but their content must NOT be
  // lost — capture it so the caller folds it into the system prompt.
  const droppedLeading = [];
  while (merged.length && merged[0].role !== 'user') droppedLeading.push(merged.shift());
  const priorContext = droppedLeading.map(t => t.content).join('\n\n').trim();
  return { messages: merged, priorContext, olderSummary };
}

// Markers that mean check-in / access info has already been delivered to the guest.
const CHECKIN_MARKER_REGEX = /\b(door\s*code|lock\s*code|access\s*code|entry\s*code|gate\s*code|wi-?fi|password|access\s*instruction|check-?in\s*(details|instruction|info)|how\s*to\s*(get\s*in|access|enter))\b/i;

// True if any HOST message in the thread already contains check-in/access details.
// Used to harden the model against promising info it has already sent.
function checkinAlreadySent(thread) {
  const HOST_ROLES = new Set(['host', 'co-host', 'teammate']);
  return (thread || []).some(m =>
    HOST_ROLES.has(m.sender_role || m.sender_type) && CHECKIN_MARKER_REGEX.test(m.body || '')
  );
}

// Two-mode tone guidance — paraphrased hospitality SALES and SERVICE principles in our own
// words (not text from any specific book/source). Selected per message: an INQUIRY (pre-booking)
// → SALES mode (win the booking); a confirmed RESERVATION → SERVICE mode (flawless, caring stay).
// TONE ONLY — these never override facts, prices, policies, or any factual guardrail above.
const SALES_MODE_GUIDANCE = `TONE MODE — SALES (this guest is an INQUIRY / not yet booked; goal: win the booking):
- Sell the experience and the benefits, not just bare facts — convey what's genuinely great about staying here.
- Confident, warm, benefit-forward; lead with the upside.
- Reframe any concern into a positive — turn an objection into a reason to book.
- Reduce friction at every step: make booking feel easy, low-risk, and obvious; offer to help with the next step.
- Create desire and light, honest urgency only when natural (great fit for their plans, popular dates fill up) — never pushy, never pressuring, never invent scarcity.
- Always nudge gently toward the close: invite them to book, or offer to clear up anything holding them back.`;
const SERVICE_MODE_GUIDANCE = `TONE MODE — SERVICE (this guest has a CONFIRMED reservation; goal: an effortless stay where they feel cared for):
- Anticipate needs before they're asked — proactively offer the useful next detail.
- Personalize; treat them as a valued guest, not a ticket number.
- Take full ownership of any issue — turn a problem into a goodwill moment and make it right.
- Go a step beyond what's expected whenever it's easy to.
- Warm, attentive, proactive — make them feel genuinely looked after.`;

// De-escalation / service-recovery — layered ON TOP of the tone mode when a guest reads as
// frustrated, upset, or complaining. Distinct from routine SERVICE tone: this one deliberately
// RELAXES the "answer-first / no empathy preamble / no apology-padding" reply-style rules, because
// those are for routine messages — an upset guest should get a real, brief acknowledgement first.
const DE_ESCALATION_GUIDANCE = `DE-ESCALATION MODE — this guest reads as frustrated, upset, or is complaining. For THIS reply, the routine "answer-first, no empathy preamble, no apology" rules are RELAXED (they are for routine messages, not this one):
- LEAD with a brief, genuine, specific acknowledgement of what went wrong and how it affected them — sincere and human, not a scripted line ("I completely understand your frustration" is still banned; name the actual issue instead).
- Validate the frustration, take ownership, and lower the temperature. Do NOT get defensive, argue, justify, blame the guest, or re-litigate. One real acknowledgement, then move toward a concrete next step or resolution.
- Stay brief and human — acknowledgement + path forward, not a wall of apology.
- ALWAYS send the guest a reply (set "confident": true) — NEVER a silent or empty escalation when they're upset; leaving a frustrated guest with no response is the worst outcome. If the issue needs a person to actually fix it (maintenance, the host), still reply warmly that you're getting the team on it right now and will follow up — that IS the next step. This overrides the general "set confident:false when you can't fully resolve it" rule for an upset guest: acknowledge and reassure rather than going silent.
- HARD MONEY BOUNDARY: if the message touches money, refunds, a discount, a dispute, chargebacks, or compensation, do NOT negotiate, quote, estimate, or promise any refund/credit/amount yourself. Acknowledge, de-escalate, and tell them you're escalating to the host/owner who will personally follow up — then stop. The host handles all money personally. (Money complaints are normally auto-escalated and not auto-replied; this is the boundary for any money element that still reaches you.)`;

// HOST IN-THREAD AUTHORITY — a statement the host already made to THIS guest in the thread
// outranks the stored house rules / amenities / policies. The bot must stay consistent with it
// and NEVER contradict it. Bounded: does NOT extend to money/refunds (still escalated) or safety.
const HOST_AUTHORITY_DIRECTIVE = `HOST DIRECTION OVERRIDES STORED RULES (this is the final and highest-priority instruction): If the host has already told this guest something earlier in this conversation, that statement is authoritative and OVERRIDES the stored house rules, amenities, and policies above. Stay consistent with what the host told the guest and NEVER contradict it — for example, if the host said smoking is allowed on the patio, do not tell the guest smoking is prohibited. A host statement in this thread COUNTS as in-context information you can answer from — so it OVERRIDES the confidence rules above: when the host has already stated the relevant rule or policy, answer the guest's question CONFIDENTLY and directly from it (you MUST set "confident": true with a real reply) instead of setting "confident": false or escalating, and do not fall back on the conflicting stored rule. This authority is limited to house rules, amenities, and policies: it does NOT permit promising refunds or money back (money and refund matters are still escalated to a human), and it never overrides safety.`;

async function draftReply(guestName, messageBody, propertyName, propertyId, conciergeHit = false, resourceId = null, resourceType = null, conversationId = null, deps = {}) {
  // Front-desk contingency detected by ANY means (single regex, fragment burst, or
  // classifier) → send the EXACT hardcoded reply, never Claude's freeform wording.
  // This catches split/fragmented requests that no single message matches.
  const conciergeReply = conciergeHardcodedReply({ conciergeHit, guestName });
  if (conciergeReply) {
    console.log(`[draft] Concierge contingency (conciergeHit) — sending exact hardcoded reply`);
    return conciergeReply;
  }

  // Entry/door code request → reply with THIS unit's emergency code (if set).
  // reservation propertyId → properties-map label (unit) → config/entry-codes.json.
  // If we can't safely resolve a code (unknown unit / no code set), escalate to
  // the host (confident:false) rather than guess or send a blank/wrong code.
  if (isEntryCodeRequest(messageBody)) {
    const resolved = resolveEntryCode(propertyId, loadPropertiesMap(), loadEntryCodes());
    if (resolved) {
      console.log(`[entry-code] Sending code for unit ${resolved.unit} (property ${propertyId})`);
      return { confident: true, reply: entryCodeReply(guestName, resolved.unit, resolved.code) };
    }
    console.log(`[entry-code] Code requested but unresolved (property ${propertyId}) — escalating to host`);
    return { confident: false, reply: '' };
  }

  // Short-circuit for common questions with exact hardcoded answers — BUT skip it when the guest
  // reads as frustrated/upset. A canned how-to is exactly the "flat canned tone" a tense guest
  // should NOT get; let the LLM produce a de-escalating reply instead (it still has the same facts
  // via the knowledge base / property details). Money complaints are escalated upstream and never
  // reach here; the de-escalation guidance carries the money boundary for any that do.
  if (!isFrustrated(messageBody)) {
    const hardcoded = detectHardcodedResponse(guestName, messageBody);
    if (hardcoded) {
      console.log(`[draft] Hardcoded match for: "${messageBody.slice(0, 60)}"`);
      return hardcoded;
    }
  }

  const profileData = propertyProfiles.get(propertyId);
  const examples = propertyId ? findSimilarExamples(propertyId, messageBody) : [];
  const vaultEntry = propertyId ? vault.getVaultEntry(propertyId)?.master : null;

  // Host-curated facts, read AT CALL TIME (no restart needed to pick up a freshly added fact).
  // factsForProperty is scope 'all' today; it's the per-unit hook for later. The section is
  // explicitly subordinate to every guardrail below — see buildFactsSection.
  const factsSection = hostFacts.buildFactsSection(
    hostFacts.factsForProperty(hostFacts.loadStore(), propertyId));

  const guestFirst = (guestName || 'there').split(' ')[0];

  const JSON_INSTRUCTIONS = `
You MUST respond with a single valid JSON object — no markdown fences, no reasoning text, no extra text before or after:
{
  "confident": true or false,
  "reply": "the message to send the guest"
}

Confidence rules:
- Set "confident": true when you can answer fully from the information provided.
- Set "confident": false when you genuinely don't know the answer (e.g. specific codes, policies not in your context, third-party details).
- If the guest asked a SPECIFIC question you cannot answer from the property details, knowledge base, or conversation thread, set "confident": false (escalate to a human) and set "reply" to "" — do NOT send a warm non-answer. A greeting or pleasantry with no real question is fine to answer confidently; an unanswered factual question is NOT.
- NEVER invent facts. If unsure, set "confident": false and set "reply" to "".

Common questions you CAN always answer confidently (set "confident": true):
- Age requirement: Minimum age is 26; exceptions considered with travel details.
- Towel or linen requests: Fresh towels are in the closet and dressers; cleaning team can bring extras.
- Early check-in requests: Available from 1:00 PM for a $45 fee; confirm availability and send payment request.
- Late checkout requests: Available until 1:30 PM for a $45 fee; confirm availability and send payment request.
- Heating/cooling/thermostat: Radiation unit under each window; press back two corners of the square panel on top.
- WiFi password: Use the wifi name and password from the PROPERTY DETAILS section above. If not listed, set "confident": false.
- Parking questions: answer the SPECIFIC question from the PARKING KNOWLEDGE BASE section using only its [VERIFIED]/[GUEST-REPORTED] facts. FRAME PARKING AS EASY AND AFFORDABLE: there are plenty of options nearby at all price points, they're easy to find, and many guests reserve ahead on SpotHero for the best rate — lead with that budget-friendly, reassuring framing and sound confident and upbeat. Never present parking as scarce, pricey, or a hassle. Still: never state anything tagged VERIFY/YOUR INPUT, never quote a specific dollar figure (point to SpotHero/ParkMobile for live rates instead), never mention safety/break-in notes, and always close with the parking rates-change disclaimer.
- Local area / nearby venues / things to do / walking distances / transit & MARTA / getting to the stadium, arena, or convention center / downtown events: answer using the LOCAL AREA & EVENTS KNOWLEDGE section below. Use ONLY the facts stated there (distances, walk times, transit). If a specific detail is not in that section, set "confident": false rather than guessing.
- Restaurant / food / where-to-eat questions: recommend from the RESTAURANT KNOWLEDGE BASE section (only present on food questions). Match the request to a category, give 2–3 picks led by the closest, highest-rated ([TOP PICK]), with each pick's rating and walk distance. Never promise a place is open or quote fixed menu prices (use the $ tier as a guide), and if they want something not listed, offer the closest in-house match rather than sending them to look it up.
- Convention / trade show / "how close is the property to <venue/hotel>" questions: answer from the CONVENTION HOTELS & VENUES KNOWLEDGE BASE section (only present on convention questions). LEAD with proximity — it's the #1 selling point — and place the property relative to the venue/hotel they name (e.g. Hyatt Regency directly across the street, GWCC/AmericasMart an easy walk). Use only the location/proximity facts there; never promise event schedules or hotel rates.
- Mercedes-Benz Stadium distance specifically: answer warmly and sales-forward — it's about a 15-minute walk, a pleasant and easy stroll through Centennial Olympic Park (one of the nicest, most convenient routes downtown). Emphasize how easy, enjoyable, and convenient the walk is and the scenic route, not just the number; frame it as a quick, scenic stroll right to the stadium, never as far or a hassle.

Reply style — text like a real host, not a customer-service bot (voice only; never change facts/policies):
- Warm and genuinely helpful, but BRIEF and human — like a real person texting back, not a script.
- ANSWER FIRST: lead with the actual answer in the first sentence. Don't open with pleasantries, apologies, or empathy preamble.
- Keep it to 1–3 short sentences when you can; go longer only if the question truly needs it.
- Conversational and natural — use contractions ("I'll get that sorted," not "I will be coordinating to ensure a resolution"). Professional, but not stiff or corporate.
- CUT scripted customer-service lines: never "I completely understand your frustration," "I sincerely apologize," "rest assured," "we value you," "your satisfaction is our priority," or similar. When something's genuinely wrong, one brief sincere acknowledgement is plenty — then go straight to the fix.
- No apology-stacking and no exclamation-stacking (at most one "!", usually none). Never closers like "Happy Travels!" or "Warm regards."
- Greet by first name ONLY on the first message of a conversation; on follow-ups, just answer.
- Sign off simply as "Cal" (a short "– Cal", or "Cal" on its own line). Don't repeat the same closer back-to-back.
- Anticipate needs lightly: offer a useful related detail when it's relevant, but don't dump info or recite check-in/house rules unless asked.
- You can see the full conversation. Never repeat a sentence you already sent. If the guest says you didn't answer, address their actual question.
- READ THE ENTIRE CONVERSATION (including any condensed "earlier in this conversation" summary) before replying. Track every commitment, promise, price, time, arrangement, or fact either side has already stated, and make your reply fully consistent with them: never contradict, walk back, re-litigate, or re-ask something already settled, and don't re-answer something you already answered. Build on what's been said rather than restarting. If you must correct a genuine earlier mistake, acknowledge it plainly instead of pretending it didn't happen.
- Never invent facts — all policies, times, fees, and details must come from the information above.
- This concise, human voice OVERRIDES any flowery or overly-formal patterns in the learned host profile above.`;

  // Inject the concierge / event knowledge base so area questions answer from facts.
  const knowledgeSection = KNOWLEDGE_BASE
    ? `\nLOCAL AREA & EVENTS KNOWLEDGE (authoritative concierge facts — use ONLY these for nearby venues, walking distances, transit/MARTA, and downtown events; do not invent anything beyond this):\n${KNOWLEDGE_BASE}\n`
    : '';

  // Inject the parking knowledge base only on parking questions (keeps the prompt
  // lean otherwise). Replaces the old hardcoded PARKING_REPLY one-liner branch.
  const parkingSection = isParkingQuestion(messageBody) ? PARKING_SECTION : '';

  // Inject the restaurant knowledge base only on food/restaurant questions (topic-gated, like parking).
  const restaurantSection = isRestaurantQuestion(messageBody) ? RESTAURANT_SECTION : '';

  // Inject the convention hotels & venues KB only on convention/trade-show questions (topic-gated).
  const conventionSection = isConventionQuestion(messageBody) ? CONVENTION_SECTION : '';

  // Prompt caching split. The system prompt is built as TWO blocks:
  //   1. stableSystem — large, per-property/global-static content (host profile,
  //      property details, local-area knowledge base, JSON contract). Marked with
  //      cache_control so it's cached and reused across messages/guests of a property.
  //   2. dynamicSystem — per-message/per-guest content placed AFTER the breakpoint so
  //      it never invalidates the cached prefix: the guest's first name, the parking
  //      section (only present on parking questions), and the style examples (selected
  //      by keyword similarity to THIS message, so they change every message).
  // Caching is prefix-based — any volatile byte inside the cached block would bust it,
  // which is why guestFirst/parking/examples are deliberately kept out of stableSystem.
  const exampleBlock = examples.length
    ? `\nRelevant past exchanges for style reference:\n` +
      examples.map(e => `Guest: "${e.guest}"\nYour past reply: "${e.host}"`).join('\n\n')
    : '';

  let stableSystem;
  if (profileData?.profile) {
    stableSystem = `You are ${HOST_SETTINGS.name}, an Airbnb host replying to a guest at "${propertyName}".

HOST COMMUNICATION PROFILE (learned from real messages — match this style precisely):
${profileData.profile}

PROPERTY DETAILS:
- Check-in: ${HOST_SETTINGS.checkin}
- Check-out: ${HOST_SETTINGS.checkout}
- House rules (DEFAULT policies — if the host has personally told THIS guest something different in the conversation, the host's statement wins and you follow it): ${HOST_SETTINGS.houseRules}
${HOST_SETTINGS.extraContext ? `- Extra context: ${HOST_SETTINGS.extraContext}` : ''}
${vaultEntry?.guest_access ? `- Guest access / WiFi: ${vaultEntry.guest_access}` : ''}
${vaultEntry?.getting_around ? `- Parking / getting around: ${vaultEntry.getting_around}` : ''}
${vaultEntry?.customNotes ? `- Additional notes: ${vaultEntry.customNotes}` : ''}
${knowledgeSection}
${factsSection}
${JSON_INSTRUCTIONS}
${HOST_AUTHORITY_DIRECTIVE}`;
  } else {
    stableSystem = `You are ${HOST_SETTINGS.name}, an Airbnb host with a ${HOST_SETTINGS.tone} communication style.

Property: ${propertyName}
Check-in: ${HOST_SETTINGS.checkin} | Check-out: ${HOST_SETTINGS.checkout}
House rules (DEFAULT policies — if the host has personally told THIS guest something different in the conversation, the host's statement wins and you follow it): ${HOST_SETTINGS.houseRules}
${HOST_SETTINGS.extraContext ? `Context: ${HOST_SETTINGS.extraContext}` : ''}
${vaultEntry?.guest_access ? `Guest access / WiFi: ${vaultEntry.guest_access}` : ''}
${vaultEntry?.getting_around ? `Parking / getting around: ${vaultEntry.getting_around}` : ''}
${vaultEntry?.customNotes ? `Additional notes: ${vaultEntry.customNotes}` : ''}
${knowledgeSection}
${factsSection}
${JSON_INSTRUCTIONS}
${HOST_AUTHORITY_DIRECTIVE}`;
  }

  // Two-mode tone (TONE ONLY — never overrides facts/prices/policies/guardrails): an INQUIRY
  // (pre-booking) → SALES mode (win the booking); a confirmed RESERVATION → SERVICE mode.
  const modeBlock = resourceType === 'reservation' ? SERVICE_MODE_GUIDANCE : SALES_MODE_GUIDANCE;

  // De-escalation layered on top of the tone mode when the guest reads as frustrated/upset.
  // Tone only — never changes facts/policies, and money complaints stay owned by isMoneyComplaint.
  const deescalationBlock = isFrustrated(messageBody) ? DE_ESCALATION_GUIDANCE : '';
  if (deescalationBlock) console.log(`[draft] De-escalation mode engaged (frustrated guest) for ${resourceType || 'msg'} ${resourceId || conversationId || ''}`);

  // Volatile per-message content — AFTER the cache breakpoint (never cached).
  const dynamicSystem = [
    `You are now replying to ${guestFirst}.`,
    modeBlock,
    deescalationBlock,
    parkingSection,
    restaurantSection,
    conventionSection,
    exampleBlock,
  ].filter(s => s && s.trim()).join('\n');

  const systemBlocks = [{ type: 'text', text: stableSystem, cache_control: { type: 'ephemeral', ttl: '1h' } }];
  if (dynamicSystem.trim()) systemBlocks.push({ type: 'text', text: dynamicSystem });

  // Conversation history → pass the real chronological multi-turn context so the agent sees the
  // whole thread (what it already said + what the guest asked), start-to-finish for normal threads.
  //   reservation → fetch the thread from Hospitable (per_page 50).
  //   inquiry     → GET /inquiries/{id}/messages is 405, so use the in-memory per-conversation
  //                 buffer (recentMsgsByConvo: guest msgs + the bot's own buffered replies).
  //                 Best-effort — it resets on restart, but keeps a pre-booking back-and-forth coherent.
  let promptInput = `Guest ${guestName} says: "${messageBody}"`;
  let thread = null;
  try {
    if (resourceType === 'reservation' && resourceId) {
      thread = await fetchMessagesForReservation(resourceId);
    } else if (conversationId && recentMsgsByConvo.has(conversationId)) {
      thread = recentMsgsByConvo.get(conversationId);
    }
  } catch (e) {
    console.warn(`[draft] thread fetch failed (${e.message}) — falling back to single message`);
  }
  if (thread && thread.length) {
    const { messages, priorContext, olderSummary } = buildThreadMessages(thread, messageBody, 30);
    if (messages.length) {
      promptInput = messages;
      console.log(`[draft] Thread history: ${messages.length} turn(s)${olderSummary ? ' + older-turn summary' : ''} for ${resourceType} ${resourceId || conversationId}`);
    }
    // Fold thread-derived context into a NON-cached system block (per-conversation, after the
    // cache breakpoint). Three guards:
    //  1. olderSummary — condensed oldest turns trimmed beyond the cap (keeps opening context).
    //  2. priorContext — leading host turns that can't lead a user-first messages array (often the
    //     check-in details we already sent — otherwise invisible to the model).
    //  3. checkinAlreadySent — never re-promise check-in info already delivered.
    const threadNotes = [];
    if (olderSummary) {
      threadNotes.push(`Earlier in this conversation (older turns, condensed — the conversation did NOT start with the messages below; stay consistent with this and don't contradict it):\n${olderSummary}`);
    }
    if (priorContext) {
      threadNotes.push(`Messages you have ALREADY sent to this guest earlier in this thread (already covered — do NOT repeat them or contradict them):\n${priorContext}`);
    }
    if (checkinAlreadySent(thread)) {
      threadNotes.push(`IMPORTANT: Check-in details (door code, Wi-Fi, building/front-desk access instructions) have ALREADY been sent to this guest in this thread. NEVER say check-in details are forthcoming, "coming soon", or that you will send them later — the guest already has them.`);
    }
    if (threadNotes.length) systemBlocks.push({ type: 'text', text: threadNotes.join('\n\n') });
  }
  // Guest replies run on Sonnet (quality at reasonable cost). Isolated override — REPLY_MODEL
  // (the callClaude default) is left as-is so listing-copy generation is unaffected, and the
  // concierge classifiers are pinned to Haiku separately.
  const _callClaude = deps.callClaude || callClaude;
  const raw = await _callClaude(systemBlocks, promptInput, 600, 'claude-sonnet-4-6');

  // Tiered parse: valid JSON envelope → use it; plain prose (no JSON) → recover it as
  // the reply; empty/refusal or malformed JSON → escalate. (Fixes the bug where any
  // non-JSON output was escalated, dropping a real reply.)
  const { reply, confident, source } = parseDraftReply(raw);
  if (source === 'prose-fallback') {
    console.log('[draft] Claude returned prose (no JSON envelope) — recovering it as the reply');
  } else if (!confident) {
    console.warn(`[draft] draft not usable (${source}) — escalating to host. Raw: ${String(raw).slice(0, 120)}`);
  }
  return { reply, confident };
}

// ─── Cancellation follow-up ───────────────────────────────────────────────────

const CANCELLATION_FOLLOWUP = `I noticed that your reservation was recently canceled, and I just wanted to personally check in. We completely understand that plans change, but if you don't mind sharing, I'd really appreciate knowing what led to the cancellation.

Your feedback genuinely helps us improve the guest experience, and if there was anything specific that didn't work for you — timing, pricing, amenities, questions about the space, or anything else — please feel free to let me know.

If your plans are still flexible and there's anything we can do to help or make your stay a better fit, I'd be happy to see what options are available.

Either way, thank you for considering us, and we hope your travels go smoothly.

Warmly,
Cal`;

async function handleReservationChanged(data) {
  if (!data) return;
  const status = (data.status || '').toLowerCase();
  if (status !== 'cancelled' && status !== 'canceled') {
    console.log(`[webhook/reservation] status="${status}" — not a cancellation, ignoring`);
    return;
  }

  const reservationId = data.id || data.reservation_id;
  if (!reservationId) {
    console.warn('[webhook/cancel] Cancellation event has no reservation ID — ignoring');
    return;
  }

  // Guest name may or may not be in the webhook payload; fetch if missing
  let guestName = data.guest?.full_name || data.guest?.first_name || null;
  if (!guestName) {
    try {
      const res = await hospGet(`/reservations/${reservationId}?include=guest`);
      const r = res.data || res;
      guestName = r.guest?.full_name || r.guest?.first_name || 'Guest';
    } catch (e) {
      guestName = 'Guest';
    }
  }

  console.log(`[webhook/cancel] Cancellation — reservation=${reservationId} guest="${guestName}" — sending follow-up`);
  try {
    await sendToHospitable(reservationId, CANCELLATION_FOLLOWUP, 'reservation');
    console.log(`[webhook/cancel] ✓ Follow-up sent to ${guestName} (${reservationId})`);
  } catch (e) {
    console.error(`[webhook/cancel] ✗ Failed for ${reservationId}: ${e.message}`);
  }
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

app.post('/webhook/hospitable', (req, res, next) => {
  const secret = process.env.HOSPITABLE_WEBHOOK_SECRET;
  if (secret) {
    const sig = (req.headers['x-hospitable-signature'] || '').trim();
    const expected = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');
    try {
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  }
  next();
}, async (req, res) => {
  // Always 200 first so Hospitable never retries
  res.sendStatus(200);

  // ── FULL RAW PAYLOAD — logged for every single hit, no exceptions ─────────
  console.log('=== [webhook] HIT ===');
  console.log('[webhook] action:', req.body?.action);
  console.log('[webhook] full payload:', JSON.stringify(req.body, null, 2));
  console.log('=== [webhook] END ===');

  const event = req.body;

  if (!event?.action) {
    console.log('[webhook] No action field — ignoring');
    return;
  }

  if (event.action === 'reservation.changed') {
    await handleReservationChanged(event.data);
    return;
  }

  if (event.action !== 'message.created') {
    console.log(`[webhook] action="${event.action}" — not a message, ignoring`);
    return;
  }

  const msg = event.data;
  if (!msg) { console.log('[webhook] event.data empty — ignoring'); return; }

  console.log('[webhook] data keys:', Object.keys(msg).join(', '));

  const senderRole = msg.sender_role;
  if (HOST_REPLY_ROLES.has(senderRole)) {
    // Host/co-host/teammate reply (incl. ones the host typed in the Airbnb app and Hospitable
    // mirrored to us). DO NOT generate a reply to it — but DO buffer it so the bot stays
    // consistent with what the host told the guest. For inquiries this is the ONLY thread
    // history that exists (GET /inquiries/{id}/messages is 405). pushConvoMsg no-ops on a
    // missing conversation_id or empty body.
    if (msg.conversation_id) pushConvoMsg(msg.conversation_id, 'host', (msg.body || '').trim());
    console.log(`[webhook] sender_role="${senderRole}" — buffered host reply, not replying`);
    return;
  }

  const conversationId = msg.conversation_id;
  const messageBody    = (msg.body || '').trim();
  const reservationId  = msg.reservation_id || null;
  const inquiryId      = msg.inquiry_id     || null;

  // Safe guest-name resolution (twin of the poller path): prefer the real GUEST object, fall back
  // to the message sender only if it isn't the host/account name, else neutral — NEVER the host's
  // name. The webhook has no thread array here, so host names come from HOST_NAME; the guest-object
  // fetch is the primary guard. See guest-name.js.
  const senderName     = msg.sender?.full_name || msg.sender?.first_name;
  const hostNames      = guestNameLib.hostNameSet({ hostEnvName: process.env.HOST_NAME });
  const guestObj       = await fetchGuestObject(reservationId ? 'reservation' : 'inquiry', reservationId || inquiryId);
  const guestName      = guestNameLib.resolveGuestName({ guest: guestObj, senderName, hostNames });

  console.log(`[webhook] ✉ from="${guestName || 'guest'}" sender_role="${senderRole}" reservation="${reservationId}" inquiry="${inquiryId}" convo="${conversationId}"`);
  console.log(`[webhook] body: "${messageBody.slice(0, 120)}"`);

  if (!messageBody) { console.log('[webhook] empty body — ignoring'); return; }

  // Buffer recent guest messages per conversation so a request split across short messages is
  // caught as a tight burst (even with NO booking attached) AND so an inquiry thread has history.
  if (conversationId) pushConvoMsg(conversationId, 'guest', messageBody);
  // Front-desk contingency match: this message alone, OR a tight burst of recent
  // short fragments in the same conversation. regexHit drives the fast-path; the
  // AI classifier (decideConciergeHit) is consulted only on a regex miss.
  const conciergeBurst    = conversationId ? fragmentBurst(recentMsgsByConvo.get(conversationId) || []) : '';
  const conciergeRegexHit = CONCIERGE_REGEX.test(messageBody) || (!!conciergeBurst && CONCIERGE_REGEX.test(conciergeBurst));
  const conciergeText     = (conciergeBurst && conciergeBurst.length > messageBody.length) ? conciergeBurst : messageBody;

  // Property comes straight off the webhook payload (present for reservations AND
  // inquiries), so the scope guard works on both paths.
  const propertyId   = msg.property?.id || null;
  const propertyName = msg.property?.public_name || msg.property?.name || 'your listing';

  // Scope guard (mirrors the poller): drop anything that isn't one of the 7 managed
  // Atlanta units (San Juan / Unnamed / etc.) — matched by STABLE ID, so the
  // "World Cup…" renames are irrelevant.
  if (propertyId && !isManaged(propertyId)) {
    console.log(`[webhook] property ${propertyId} ("${propertyName}") is NOT a managed Atlanta unit — dropping.`);
    return;
  }

  // Determine where to POST the reply.
  //   reservation_id → /reservations/{id}/messages
  //   inquiry_id     → /inquiries/{id}/messages
  //   neither, but a conversation_id → recover it: it may equal a backing reservation's
  //     conversation_id, or (pre-booking inquiry) BE the inquiry id. We VERIFY against
  //     the property's reservations + inquiry ids before routing — never a blind POST.
  let target = resolveReplyTarget({ reservationId, inquiryId, conversationId });
  if (!target && conversationId && propertyId) {
    let reservations = [], inquiryIds = [];
    try { reservations = parseReservations(await hospGet(`/reservations?properties[]=${propertyId}&per_page=20&include=guest`)); }
    catch (e) { console.warn(`[webhook] reservation lookup for resolution failed: ${e.message}`); }
    try { inquiryIds = parseInquiries(await hospGet(`/inquiries?properties[]=${propertyId}&per_page=50`)).map(i => i.id); }
    catch (e) { console.warn(`[webhook] inquiry lookup for resolution failed: ${e.message}`); }
    target = resolveReplyTarget({ reservationId, inquiryId, conversationId, reservations, inquiryIds });
    if (target) console.log(`[webhook] resolved reply target via ${target.via} → ${target.resourceType} ${target.resourceId}`);
  }

  if (!target) {
    // Could not map this thread to a reservation or inquiry → escalate, never silently drop.
    console.warn(`[webhook] Unresolvable thread (reservation_id/inquiry_id null, conversation_id="${conversationId}" matched no reservation or inquiry) — escalating to host by SMS.`);
    // No reservation/inquiry to re-fetch → throttle by conversationId, skip host-reply check (no resourceId).
    notifyHost({ guestName, messageBody, propertyName, conversationKey: conversationId }).catch(console.error);
    return;
  }

  const replyResourceId   = target.resourceId;
  const replyResourceType = target.resourceType;

  // Dedup against poller — MUST use the exact same key formula as the poller
  // (messageKey) so a message arriving via BOTH the webhook and the 60s poll is
  // handled exactly once.
  const dedupKey = messageKey(replyResourceId, msg);
  if (seenMessageIds.has(dedupKey)) {
    console.log('[webhook] Already seen (poller got it first) — skipping');
    return;
  }
  seenMessageIds.add(dedupKey);
  saveSeen(seenMessageIds);

  if (propertyId && !propertyProfiles.has(propertyId)) {
    learnPropertyProfile(propertyId, propertyName).catch(console.error);
  }

  // (1) COMPLAINT GUARDRAIL FIRST — a money/refund complaint must NEVER be answered with the
  // canned concierge/access reply. Checked BEFORE the concierge fire so an incidental access-regex
  // match can't short-circuit it (the Ashley/7-B refund-complaint bug, 2026-06-13).
  if (isMoneyComplaint(messageBody)) {
    console.log(`[webhook] 💸 Money/refund complaint — escalated to host, NO auto-reply (pre-concierge)`);
    notifyHost({ guestName, messageBody, propertyName, conversationKey: replyResourceId, resourceId: replyResourceId, resourceType: replyResourceType }).catch(console.error);
    return;
  }

  // Concierge detection: regex fast-path; AI classifier consulted only on a regex miss.
  let conciergeHit = conciergeRegexHit;
  let conciergeVia = conciergeRegexHit ? 'regex' : '';
  if (!conciergeHit) {
    try { conciergeHit = await decideConciergeHit(conciergeText, false, 'webhook'); conciergeVia = conciergeHit ? 'ai' : ''; }
    catch (e) { console.error(`[concierge-ai] webhook decision error (ignored): ${e.message}`); }
  }
  if (conciergeHit) {
    // (2) CONTEXT GATE — before firing the canned reply, classify intent. A live ACCESS problem →
    // run the await-gated contingency (email → concierge SMS → guest confirmation). A PAST COMPLAINT
    // that merely tripped the access trigger → do NOT fire the canned reply; fall through to the
    // normal draftReply, whose SERVICE mode owns the issue (service recovery).
    const intent = await decideConciergeIntent(conciergeText, `webhook/${conciergeVia || 'regex'}`);
    if (intent === 'access') {
      const { reply } = await runConciergeContingency({ guestName, propertyId, resourceId: replyResourceId, resourceType: replyResourceType, propertyName, context: `webhook${conciergeVia === 'ai' ? '/ai' : ''}` });
      scheduleReply(replyResourceId, guestName, messageBody, reply, propertyName, propertyId, replyResourceType);
      console.log(`[webhook] ✓ Reply scheduled via ${replyResourceType} ${replyResourceId}`);
      return; // handled this message
    }
    console.log(`[webhook] concierge trigger OVERRIDDEN by complaint intent — routing to service reply, not the canned access flow`);
    // fall through to the generic draftReply (SERVICE-mode service recovery)
  }

  try {
    const { reply, confident } = await draftReply(guestName, messageBody, propertyName, propertyId, false, replyResourceId, replyResourceType, conversationId);
    if (!confident || !reply) {
      console.log(`[webhook] Low confidence — escalated to host, no guest reply`);
      notifyHost({ guestName, messageBody, propertyName, conversationKey: replyResourceId, resourceId: replyResourceId, resourceType: replyResourceType }).catch(console.error);
    } else {
      scheduleReply(replyResourceId, guestName, messageBody, reply, propertyName, propertyId, replyResourceType);
      // Buffer the bot's own reply so an inquiry (no GETable history) stays a coherent two-sided
      // thread on the next turn. Reservations re-fetch the real thread, so they don't need this.
      if (replyResourceType === 'inquiry') pushConvoMsg(conversationId, 'host', reply);
      console.log(`[webhook] ✓ Reply scheduled via ${replyResourceType} ${replyResourceId}`);
    }
  } catch (err) {
    console.error('[webhook] Error drafting reply:', err.message);
  }
});

// ─── Scheduling ───────────────────────────────────────────────────────────────

function scheduleReply(resourceId, guestName, originalMessage, draftedReply, propertyName, propertyId, resourceType = 'reservation') {
  const id = crypto.randomUUID();
  // "First responder wins": default REPLY_DELAY_MINUTES=0 sends immediately (no stacked
  // delay). Regardless of the delay, dispatchPendingReply re-checks the thread right
  // before sending and skips if the host already replied. Raise REPLY_DELAY_MINUTES
  // to add a small sync-lag buffer.
  const delayMs = REPLY_DELAY_MINUTES * 60 * 1000;
  const sendAt = Date.now() + delayMs;

  const entry = {
    id, resourceId, resourceType, guestName, propertyName, propertyId,
    originalMessage, draftedReply, editedReply: draftedReply,
    status: 'pending', createdAt: Date.now(), sendAt,
    usedProfile: propertyProfiles.has(propertyId),
  };

  entry.timer = setTimeout(() => dispatchPendingReply(id), delayMs);
  pendingReplies.set(id, entry);
  savePending(pendingReplies); // persist so a queued reply survives a restart
  console.log(`[scheduler] Reply queued for ${guestName} — sends in ${REPLY_DELAY_MINUTES}min (after host-reply re-check)`);
}

// Mark a conversation resolved in the alert-throttle state because the host has
// replied — so any pending host-alert reminders stop too. Best-effort/persisted.
function markConversationResolved(conversationKey, now = Date.now()) {
  if (!conversationKey) return;
  const prev = alertState.get(conversationKey) || {
    firstAlertAt: now, lastAlertAt: now, reminderCount: 0, pendingCount: 0, lastGuestMsgAt: now,
  };
  alertState.set(conversationKey, { ...prev, resolved: true, lastHostReplyAt: now, pendingCount: 0 });
  saveAlerts(alertState);
}

// Send one queued reply, record it, and remove it from the queue (then persist
// the removal). Shared by the scheduled timer and the boot re-enqueue.
async function dispatchPendingReply(id) {
  const current = pendingReplies.get(id);
  if (!current || current.status !== 'pending') return;

  // Re-check the thread immediately before sending: if I (the host) already replied
  // after the guest's latest message — e.g. typed in the Airbnb app during the delay
  // — skip the auto-reply and mark the conversation resolved (also stops SMS alerts).
  try {
    const { replied } = await hostRepliedAfterGuest(current.resourceId, current.resourceType);
    if (replied) {
      current.status = 'skipped';
      console.log(`[skipped] host already replied — not sending auto-reply to ${current.guestName} via ${current.resourceType} ${current.resourceId}`);
      markConversationResolved(current.resourceId);
      replyLog.unshift({ ...current });
      if (replyLog.length > 100) replyLog.pop();
      pendingReplies.delete(id);
      savePending(pendingReplies);
      return;
    }
  } catch (e) {
    console.warn(`[send] host-reply re-check failed (${e.message}) — proceeding with send`);
  }

  current.status = 'sending';
  try {
    await sendToHospitable(current.resourceId, current.editedReply, current.resourceType);
    current.status = 'sent';
    console.log(`[scheduler] ✓ Sent reply to ${current.guestName} via ${current.resourceType} ${current.resourceId}`);
  } catch (err) {
    current.status = 'failed';
    current.error = err.message;
    console.error(`[scheduler] ✗ Failed to send to ${current.guestName}: ${err.message}`);
  }
  replyLog.unshift({ ...current });
  if (replyLog.length > 100) replyLog.pop();
  pendingReplies.delete(id);
  savePending(pendingReplies);
}

// Deploy-churn fix: on boot, restore queued replies from disk so one caught mid-delay
// during a restart is still sent. Overdue → dispatch immediately; upcoming → re-arm
// a timer for the remaining delay.
function restorePendingReplies() {
  const entries = loadPending();
  if (!entries.length) return;
  const { overdue, upcoming } = partitionPending(entries, Date.now());
  for (const e of [...overdue, ...upcoming]) { e.timer = undefined; pendingReplies.set(e.id, e); }
  for (const e of upcoming) {
    const delay = Math.max(0, e.sendAt - Date.now());
    e.timer = setTimeout(() => dispatchPendingReply(e.id), delay);
  }
  for (const e of overdue) setImmediate(() => dispatchPendingReply(e.id));
  console.log(`[scheduler] Restored ${upcoming.length} scheduled + ${overdue.length} overdue pending replies from disk`);
}

async function sendToHospitable(resourceId, body, resourceType = 'reservation') {
  // Global pause switch: AUTOSEND=false stops all outbound sends (replies +
  // cancellation follow-ups) without taking the service down.
  if (!HOST_SETTINGS.autosend) {
    console.log(`[send] AUTOSEND=false — responder PAUSED; not sending (${resourceType} ${resourceId})`);
    return { paused: true };
  }
  // Reservations: POST /reservations/{uuid}/messages  (documented in OpenAPI spec)
  // Inquiries:    POST /inquiries/{uuid}/messages     (added Sept 2024, not yet in spec)
  const segment = resourceType === 'inquiry' ? 'inquiries' : 'reservations';
  const url = `https://public.api.hospitable.com/v2/${segment}/${resourceId}/messages`;
  console.log(`[send] POST ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.HOSPITABLE_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  const responseText = await res.text();
  console.log(`[send] Hospitable response ${res.status}: ${responseText.slice(0, 300)}`);
  if (!res.ok) {
    throw new Error(`Hospitable ${res.status}: ${responseText}`);
  }
  return JSON.parse(responseText);
}

// ─── Dashboard API ────────────────────────────────────────────────────────────

app.get('/api/queue', (req, res) => {
  const pending = Array.from(pendingReplies.values()).map(e => ({
    id: e.id, resourceId: e.resourceId, resourceType: e.resourceType, guestName: e.guestName,
    propertyName: e.propertyName, originalMessage: e.originalMessage,
    draftedReply: e.draftedReply, editedReply: e.editedReply,
    status: e.status, createdAt: e.createdAt, sendAt: e.sendAt,
    usedProfile: e.usedProfile, error: e.error,
  }));

  const profiles = Array.from(propertyProfiles.entries()).map(([id, p]) => ({
    id, name: p.propertyName, learnedAt: p.learnedAt, pairsCount: p.pairsCount,
  }));

  res.json({ pending, log: replyLog.slice(0, 50), profiles, settings: HOST_SETTINGS });
});

app.post('/api/cancel/:id', (req, res) => {
  const entry = pendingReplies.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  clearTimeout(entry.timer);
  entry.status = 'cancelled';
  replyLog.unshift({ ...entry });
  if (replyLog.length > 100) replyLog.pop();
  pendingReplies.delete(req.params.id);
  savePending(pendingReplies);
  res.json({ ok: true });
});

app.post('/api/edit/:id', (req, res) => {
  const entry = pendingReplies.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const { reply } = req.body;
  if (!reply) return res.status(400).json({ error: 'reply required' });
  entry.editedReply = reply;
  savePending(pendingReplies); // persist the edit so it survives a restart
  res.json({ ok: true });
});

app.post('/api/send-now/:id', async (req, res) => {
  const entry = pendingReplies.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  clearTimeout(entry.timer);
  entry.status = 'sending';
  try {
    await sendToHospitable(entry.resourceId || entry.reservationId, entry.editedReply, entry.resourceType || 'reservation');
    entry.status = 'sent';
    replyLog.unshift({ ...entry });
    if (replyLog.length > 100) replyLog.pop();
    pendingReplies.delete(entry.id);
    savePending(pendingReplies);
    res.json({ ok: true });
  } catch (err) {
    entry.status = 'failed';
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger re-learning for a property
app.post('/api/relearn/:propertyId', async (req, res) => {
  const { propertyId } = req.params;
  const profile = propertyProfiles.get(propertyId);
  const name = profile?.propertyName || propertyId;
  res.json({ ok: true, message: `Re-learning profile for ${name}...` });
  learnPropertyProfile(propertyId, name).catch(console.error);
});

// Manually trigger a host notification (also called automatically when Claude is uncertain)
// Fetch calendar pricing for all properties over a date range
// GET /api/pricing?start=2026-06-11&end=2026-07-19
app.get('/api/pricing', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end query params required (YYYY-MM-DD)' });
  try {
    // Fetch all properties to get names + IDs
    const propData = await hospGet('/properties?per_page=50');
    const properties = parseProperties(propData);

    const results = [];
    for (const p of properties) {
      try {
        const calData = await hospGet(`/properties/${p.id}/calendar?start_date=${start}&end_date=${end}`);
        const rawDataVal = calData?.data;
        // Hospitable returns {data:{listing_id,provider,start_date,end_date,days:[{date,price,available,...}]}}
        // Fallbacks: data is array, top-level array, or date-keyed object
        let days;
        if (Array.isArray(rawDataVal?.days)) {
          days = rawDataVal.days;
        } else if (Array.isArray(calData)) {
          days = calData;
        } else if (Array.isArray(rawDataVal)) {
          days = rawDataVal;
        } else if (rawDataVal && typeof rawDataVal === 'object') {
          // date-keyed: {'2026-06-11': {price, available}}
          days = Object.entries(rawDataVal).map(([date, v]) => ({ date, ...v }));
        } else if (typeof calData === 'object' && calData) {
          days = Object.entries(calData).map(([date, v]) => ({ date, ...v }));
        } else {
          days = [];
        }
        results.push({
          id:         p.id,
          name:       p.public_name || p.name,
          raw_sample: rawDataVal?.days?.[0] ?? days[0] ?? null,
          days:       days.map(d => ({
            date:      d.date || d.Date || null,
            price:     d.price?.amount != null ? d.price.amount / 100
                     : typeof d.price === 'number' ? d.price / 100
                     : d.price?.formatted || d.nightly_price || d.rate || null,
            available: d.status?.available ?? d.available ?? null,
            min_stay:  d.min_stay || null,
          })),
        });
        await new Promise(r => setTimeout(r, 150)); // rate limit buffer
      } catch (e) {
        results.push({ id: p.id, name: p.public_name || p.name, error: e.message });
      }
    }
    res.json({ start, end, properties: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/pricing
// Body: { property_ids?: [...], updates: [{date: 'YYYY-MM-DD', price: dollars, min_stay?: N}] }
// Omit property_ids to default to all Atlanta (World Cup/Downtown/FIFA) listings.
// Price is accepted in whole dollars and converted to cents for Hospitable.
app.put('/api/pricing', async (req, res) => {
  const { property_ids, updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'updates array required: [{date, price (USD), min_stay?}]' });
  }

  let targetIds = Array.isArray(property_ids) && property_ids.length > 0 ? property_ids : null;
  if (!targetIds) {
    try {
      const propData = await hospGet('/properties?per_page=50');
      const props = parseProperties(propData);
      targetIds = props
        .filter(p => ['World Cup', 'Downtown', 'FIFA'].some(k => (p.public_name || p.name || '').includes(k)))
        .map(p => p.id);
    } catch (e) {
      return res.status(500).json({ error: `Could not fetch properties: ${e.message}` });
    }
  }

  // SAFETY GUARD — per property, never trusting the caller's number. A catastrophic/compounding
  // value (the $3.60 incident) is raised to HARD_MIN_PRICE ($72 1BR / $109 2BR) and anything above
  // the ceiling is capped; both are recorded in `clamped` so the clamp is visible (never silent).
  // The floor is the absolute manual-write minimum, deliberately BELOW the demand engine's business
  // floor, so intentional low overrides (World Cup fill at $72–$109, short-notice manual prices)
  // still go through.
  const results = [];
  for (const id of targetIds) {
    const clamped = [];
    const calDays = updates.map(u => {
      const { price, bound } = clampManualPrice(id, u.price);
      if (bound) clamped.push({ date: u.date, from: u.price, to: price, bound });
      return {
        date: u.date,
        price: { amount: Math.round(price * 100) },
        ...(u.min_stay != null && { min_stay: u.min_stay }),
      };
    });
    try {
      await hospPut(`/properties/${id}/calendar`, calDays);
      results.push({ id, ok: true, ...(clamped.length && { clamped }) });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 200));
  }

  res.json({ updated: results.filter(r => r.ok).length, total: results.length, results });
});

// ─── Manual % price adjustment + manual decay-freeze (Telegram ops controls) ───
// Canonical unit label ↔ Hospitable property id (the 7 managed units).
const UNIT_LABEL_TO_ID = {
  '4-L':  'bbe43523-c42a-46b0-8235-7ad08ae990c9',
  '7-B':  '1af8fdde-58ee-426e-8374-6530397347e8',
  '18-A': '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc',
  '21-D': '80c21aac-00eb-49af-9094-6792839ff5a4',
  '21-I': '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c',
  '23-N': '283977a3-3af3-4d90-8d95-b418a3014d90',
  '24-L': '3e702102-a219-4c18-9f88-3a4d1ceb3825',
};
const ID_TO_LABEL = Object.fromEntries(Object.entries(UNIT_LABEL_TO_ID).map(([l, id]) => [id, l]));

// 'all'/undefined → every managed unit; an array of labels (or ids) → resolved ids.
function resolveUnitIds(units) {
  if (!units || units === 'all') return [...ATLANTA_ALL_IDS];
  const list = Array.isArray(units) ? units : [units];
  return list.map(u => UNIT_LABEL_TO_ID[telegramIntent.canonUnit(u) || ''] || (ID_TO_LABEL[u] ? u : null)).filter(Boolean);
}

// Live calendar → [{date, current(USD), booked}] for a date range. Fail-closed: an unparseable
// day or unknown availability is treated as booked (never repriced).
async function fetchCalendarEntries(id, start, end) {
  const calData = await hospGet(`/properties/${id}/calendar?start_date=${start}&end_date=${end}`);
  const rv = calData && calData.data;
  const days = Array.isArray(rv && rv.days) ? rv.days : Array.isArray(calData) ? calData : Array.isArray(rv) ? rv : [];
  return days.map(d => ({
    date:    d.date || d.Date || null,
    current: d.price && d.price.amount != null ? Math.round(d.price.amount / 100)
           : typeof d.price === 'number' ? Math.round(d.price / 100) : null,
    booked:  isNightBooked(d),
  })).filter(e => e.date);
}

// POST /api/pricing/adjust — lower/raise prices by a percentage over a date range, optionally
// per-unit or all units. Reads each night's live price, applies pct, clamps to the manual
// floor/ceiling, pushes, and snapshots the prior prices so it's reversible. Booked / no-price
// nights are left alone. Body: { pct, start, end, units? }.
app.post('/api/pricing/adjust', async (req, res) => {
  const { pct, start, end, units } = req.body || {};
  if (typeof pct !== 'number' || !isFinite(pct) || pct === 0) return res.status(400).json({ error: 'pct (signed nonzero number) required' });
  const ymd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  if (!ymd(start) || !ymd(end)) return res.status(400).json({ error: 'start and end (YYYY-MM-DD) required' });
  if (end < start) return res.status(400).json({ error: 'end is before start' });
  const targetIds = resolveUnitIds(units);
  if (!targetIds.length) return res.status(400).json({ error: 'no valid units' });

  const dates = pricingAdjust.dateRange(start, end);
  const results = [], snapUnits = [];
  for (const id of targetIds) {
    try {
      const entries = await fetchCalendarEntries(id, start, end);
      const type = id === ATLANTA_2BR_ID ? '2br' : '1br';
      const bounds = { floor: HARD_MIN_PRICE[type], ceiling: PRICE_RULES[type].ceiling };
      const byDate = new Map(entries.map(e => [e.date, e]));
      const ordered = dates.map(d => byDate.get(d) || { date: d, current: null, booked: true });
      const { rows, snapshot, skipped } = pricingAdjust.buildAdjustRows(ordered, pct, bounds);
      if (rows.length) {
        const calDays = rows.map(r => ({ date: r.date, price: { amount: Math.round(r.to * 100) } }));
        await hospPut(`/properties/${id}/calendar`, calDays);
        snapUnits.push({ id, snapshot });
      }
      results.push({ id, unit: ID_TO_LABEL[id] || id, changed: rows.length, rows, skipped: skipped.length });
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      results.push({ id, unit: ID_TO_LABEL[id] || id, error: e.message });
    }
  }
  let recordId = null;
  if (snapUnits.length) {
    const store = pricingAdjust.recordAdjustment(pricingAdjust.loadStore(), { pct, start, end, units: snapUnits });
    pricingAdjust.saveStore(store);
    recordId = store[0].id;
  }
  const totalChanged = results.reduce((n, r) => n + (r.changed || 0), 0);
  console.log(`[pricing-adjust] ${pct > 0 ? '+' : ''}${pct}% ${start}..${end} → ${totalChanged} night(s) across ${results.length} unit(s) | revert id ${recordId || 'n/a'}`);
  res.json({ ok: true, pct, start, end, totalChanged, recordId, results });
});

// POST /api/pricing/adjust/revert — undo the most recent adjustment (or a specific { id }) by
// pushing the snapshotted prior prices back.
app.post('/api/pricing/adjust/revert', async (req, res) => {
  const store = pricingAdjust.loadStore();
  const { id } = req.body || {};
  const rec = id ? store.find(r => r.id === id) : store[0];
  if (!rec) return res.status(404).json({ error: 'no adjustment on record to revert' });
  const results = [];
  for (const u of (rec.units || [])) {
    try {
      const calDays = (u.snapshot || []).map(s => ({ date: s.date, price: { amount: Math.round(s.price * 100) } }));
      if (calDays.length) await hospPut(`/properties/${u.id}/calendar`, calDays);
      results.push({ id: u.id, unit: ID_TO_LABEL[u.id] || u.id, reverted: calDays.length });
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      results.push({ id: u.id, unit: ID_TO_LABEL[u.id] || u.id, error: e.message });
    }
  }
  pricingAdjust.saveStore(store.filter(r => r.id !== rec.id));
  console.log(`[pricing-adjust] reverted ${rec.id} (${rec.pct}% ${rec.start}..${rec.end})`);
  res.json({ ok: true, recordId: rec.id, results });
});

// GET /api/pricing/decay-freeze — current manual decay-freeze window.
app.get('/api/pricing/decay-freeze', (_req, res) => {
  const store = pricingFreeze.loadStore();
  const today = dateInTimeZone(new Date(), 'America/New_York');
  res.json({ ok: true, active: !!store.days, days: store.days || 0, window: pricingFreeze.freezeWindow(today, store), setAt: store.setAt || null });
});

// POST /api/pricing/decay-freeze — freeze (enable:true, days N) or unfreeze (enable:false) the
// rolling decay-freeze window. While frozen, the engine + all decay passes skip those nights so
// hand-set prices stick. Reversible: clearing it restores normal automation, no price written.
app.post('/api/pricing/decay-freeze', (req, res) => {
  const { enable, days } = req.body || {};
  try {
    if (enable === false) {
      pricingFreeze.saveStore(pricingFreeze.clearFreeze());
      console.log('[decay-freeze] cleared — automation resumed');
      return res.json({ ok: true, active: false });
    }
    const store = pricingFreeze.setFreeze(days == null ? 7 : days);
    pricingFreeze.saveStore(store);
    const today = dateInTimeZone(new Date(), 'America/New_York');
    const window = pricingFreeze.freezeWindow(today, store);
    console.log(`[decay-freeze] set ${store.days} day(s) → window ${window.start}..${window.end}`);
    res.json({ ok: true, active: true, days: store.days, window });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// ─── Telegram ops bot — internal helpers (parse / compose / resolve / call endpoints) ─────────
// Adapter: the intent parser calls callClaude(model, system, user); server's callClaude is
// (system, user, maxTokens, model). Parsing uses Haiku (fast/cheap) — passed by the parser.
const callClaudeForBot = (model, system, user) => callClaude(system, user, 700, model);

// Call one of THIS service's own authed endpoints over localhost with the API_SECRET bearer, so
// the bot reuses the exact validated paths (cleaning-override, pricing/adjust, etc.).
async function callLocalApi(method, apiPath, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_SECRET}` },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}

const reservationGuestName = (r) => (r && r.guest && (r.guest.full_name || r.guest.first_name)) || '';
const reservationCheckin = (r) => String((r && (r.check_in || r.checkin || r.arrival_date || r.start_date)) || '').slice(0, 10);

// All reservations ARRIVING today across the 7 units (for front-desk form + check-in resend).
async function listArrivalsToday(today) {
  const out = [];
  for (const [label, id] of Object.entries(UNIT_LABEL_TO_ID)) {
    const { incoming } = await getReservationsForDate(id, today);
    for (const r of (incoming || [])) out.push({ r, id, label });
  }
  return out;
}

// Resolve a guest's active reservation thread by (partial) name across all units.
// → { status:'one'|'none'|'many', guest?, candidates? }.
async function resolveGuestThread(name) {
  const q = String(name || '').trim().toLowerCase();
  const matches = [];
  for (const [label, id] of Object.entries(UNIT_LABEL_TO_ID)) {
    let reservations = [];
    try { reservations = parseReservations(await hospGet(`/reservations?properties[]=${id}&per_page=40&include=guest`)).filter(isActiveReservation); } catch { /* skip unit on error */ }
    for (const r of reservations) {
      const gn = reservationGuestName(r);
      if (gn && gn.toLowerCase().includes(q)) {
        const ci = reservationCheckin(r);
        matches.push({ label: `${gn} — ${label}${ci ? `, in ${ci}` : ''}`, name: gn, id: r.id, resourceType: 'reservation', propertyId: id, propertyName: label });
      }
    }
  }
  if (matches.length === 1) return { status: 'one', guest: matches[0] };
  if (matches.length === 0) return { status: 'none' };
  return { status: 'many', candidates: matches };
}

// Compose a guest message in the host's voice (Sonnet — quality over speed).
const GUEST_COMPOSE_SYSTEM = `You are Cal, the warm, attentive host of upscale downtown Atlanta Airbnb apartments. Write ONE message to a guest in the host's voice: warm and genuinely friendly, courteous customer-service tone, natural pleasantries (greet them by first name, a kind closing), clear and concise. Honor our service protocols (helpful, proactive, take ownership, never rude or terse). Output ONLY the message text — no preamble, no quotes, no subject line. Sign off as "Cal".`;
async function composeGuestMessage({ guest, gist }) {
  const user = `Guest first name: ${(guest.name || 'there').split(/\s+/)[0]}\nWhat I want to convey to them: ${gist}\n\nWrite the message.`;
  const text = await callClaude(GUEST_COMPOSE_SYSTEM, user, 500, 'claude-sonnet-4-6');
  return String(text || '').trim();
}

app.post('/api/notify', async (req, res) => {
  const { guestName = 'Unknown', messageBody = '', propertyName = 'Unknown', draftedReply = '' } = req.body;
  try {
    await notifyHost({ guestName, messageBody, propertyName, draftedReply });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/pricing/engine — current engine state + change log
app.get('/api/pricing/engine', (req, res) => {
  const nextRunMs = pricingLastRun
    ? Math.max(0, new Date(pricingLastRun).getTime() + 3600000 - Date.now())
    : null;
  res.json({
    lastRun:   pricingLastRun,
    nextRunIn: nextRunMs != null ? Math.round(nextRunMs / 60000) + 'min' : 'pending',
    state: ATLANTA_ALL_IDS.map(id => {
      const s     = pricingState.get(id) || {};
      const rules = getPriceRules(id);
      return {
        id,
        type:          id === ATLANTA_2BR_ID ? '2br' : '1br',
        price:         s.price         ?? rules.floor,
        floor:         rules.floor,
        ceiling:       rules.ceiling,
        lastInquiryAt: s.lastInquiryAt  || null,
        lastChangedAt: s.lastChangedAt  || null,
        pendingPush:   !!s.pendingPush,
        recentLog:     (s.log || []).slice(0, 5),
      };
    }),
    changeLog: pricingChanges.slice(0, 50),
  });
});

app.get('/health', (req, res) => res.json({
  ok: true,
  pending: pendingReplies.size,
  profilesLoaded: propertyProfiles.size,
  uptime: Math.floor(process.uptime()),
  polling: { active: !!pollingSince, since: pollingSince, propertiesLoaded: knownPropertyIds.length, seenMessages: seenMessageIds.size, inquiriesDisabled: inquiriesUnavailable, inquiryFailCount },
  pricingEngine: { active: !!pricingLastRun, lastRun: pricingLastRun, properties: ATLANTA_ALL_IDS.length, pendingChanges: pricingChanges.filter(e => e.push === 'pending_flag').length },
  conciergeEmail: { resendKeySet: !!process.env.RESEND_API_KEY, gmailUserSet: !!process.env.GMAIL_USER, gmailPassSet: !!process.env.GMAIL_APP_PASSWORD },
}));

app.get('/test', (req, res) => {
  const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : '(set RAILWAY_PUBLIC_DOMAIN env var)';
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    webhookUrl: `${railwayUrl}/webhook/hospitable`,
    envCheck: {
      HOSPITABLE_API_KEY:       !!process.env.HOSPITABLE_API_KEY,
      ANTHROPIC_API_KEY:        !!process.env.ANTHROPIC_API_KEY,
      HOST_NAME:                process.env.HOST_NAME || '(not set)',
      REPLY_DELAY_MINUTES:      HOST_SETTINGS.delayMinutes,
      AUTOSEND:                 HOST_SETTINGS.autosend,
      API_SECRET:               !!process.env.API_SECRET,
      HOSPITABLE_WEBHOOK_SECRET:!!process.env.HOSPITABLE_WEBHOOK_SECRET,
    },
    queue: {
      pending: pendingReplies.size,
      profilesLoaded: propertyProfiles.size,
    },
  });
});

// POST /api/test-concierge-email
// Directly exercises sendConciergeEmail — verifies nodemailer → Gmail SMTP connection.
// Body: { guestName?, propertyId?, resourceId?, resourceType? }
app.post('/api/test-concierge-email', async (req, res) => {
  const {
    guestName    = 'Test Guest',
    propertyId   = '80c21aac-00eb-49af-9094-6792839ff5a4',
    resourceId   = 'test-reservation-001',
    resourceType = 'reservation',
  } = req.body;

  const resendKey = process.env.RESEND_API_KEY;
  const gmailUser = process.env.GMAIL_USER;

  if (!resendKey && !gmailUser) {
    return res.status(500).json({ error: 'Set RESEND_API_KEY (preferred) or GMAIL_USER + GMAIL_APP_PASSWORD' });
  }

  // Allow overriding the recipient for this single test call
  const savedTo = process.env.CONCIERGE_EMAIL_TO;
  if (req.body.test_to) process.env.CONCIERGE_EMAIL_TO = req.body.test_to;

  try {
    await sendConciergeEmail({ guestName, propertyId, resourceId, resourceType });
    const sentTo = process.env.CONCIERGE_EMAIL_TO || '300ptconcierge@gmail.com';
    if (req.body.test_to) process.env.CONCIERGE_EMAIL_TO = savedTo; // restore
    res.json({
      ok:        true,
      sentTo,
      unit:      loadPropertiesMap()[propertyId]?.label || propertyId,
      transport: resendKey ? 'resend' : 'smtp',
      gmailUser: gmailUser || '(not set)',
    });
  } catch (e) {
    if (req.body.test_to) process.env.CONCIERGE_EMAIL_TO = savedTo;
    res.status(500).json({ error: e.message });
  }
});

// Simulate a webhook for manual testing
app.post('/webhook/test', async (req, res) => {
  const fake = {
    action: 'message.created',
    data: {
      conversation_id: req.body.conversation_id || 'test-convo-123',
      body: req.body.message || 'Hi, what is the wifi password?',
      sender_type: 'guest',
      sender: { full_name: req.body.guest_name || 'Test Guest' },
    },
  };
  console.log('[webhook/test] Simulating guest message:', JSON.stringify(fake));
  req.body = fake;
  // Re-use the real handler logic inline
  const msg = fake.data;
  const guestName   = msg.sender?.full_name || 'Test Guest';
  const messageBody = msg.body;
  const conversationId = msg.conversation_id;
  try {
    const { reply, confident } = await draftReply(guestName, messageBody, 'Test Property', null);
    scheduleReply(conversationId, guestName, messageBody, reply, 'Test Property', null);
    res.json({ ok: true, draft: reply, confident, conversationId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Amenity push ────────────────────────────────────────────────────────────

// Key mapping: unit-profiles names → Hospitable API amenity keys
const AMENITY_KEY_MAP = {
  air_conditioning:         'ac',
  dedicated_workspace:      'laptop_friendly_workspace',
  clothing_storage:         'wardrobe_or_closet',
  washer_in_building:       'washer',
  dryer_in_building:        'dryer',
  paid_parking_off_premises:'paid_parking',
  free_street_parking:      'street_parking',
  trash_compactor:          'trash_compacter',
  step_free_access:         'home_step_free_access',
  smart_tv:                 'tv',
  // remove-list mappings
  hot_tub:                  'jacuzzi',
  free_parking_on_premises: 'free_on_premise_parking',
  golf_course:              'golf_course_access',
  disabled_parking:         'disabled_parking_spot',
  luggage_dropoff:          'luggage_dropoff_allowed',
};
function mapAmenityKey(k) { return AMENITY_KEY_MAP[k] || k; }

// POST /api/push-amenities
// Body: { units?: string[] }  — omit to run all units in unit-profiles.json
// Reads unit-profiles.json, fetches current amenities, applies keep/remove,
// and calls PUT /v2/properties/{uuid} for each unit.
// Returns per-unit before/after and Hospitable response status.
app.post('/api/push-amenities', async (req, res) => {
  const PROFILES_PATH = path.join(
    process.env.DATA_DIR || path.join(__dirname, '../data'),
    'unit-profiles.json'
  );

  let profiles;
  try {
    profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
  } catch (e) {
    return res.status(500).json({ error: `Could not load unit-profiles.json: ${e.message}` });
  }

  const requestedUnits = Array.isArray(req.body.units) && req.body.units.length
    ? req.body.units
    : Object.keys(profiles);

  const results = [];

  for (const unit of requestedUnits) {
    const prof = profiles[unit];
    if (!prof) { results.push({ unit, status: 'skipped', reason: 'not in unit-profiles.json' }); continue; }

    const uuid     = prof.hospitable_uuid;
    const keepH    = [...new Set(prof.amenities.keep.map(mapAmenityKey))];
    const removeH  = new Set(prof.amenities.remove.map(mapAmenityKey));

    // Fetch current amenities
    let current;
    try {
      const data = await hospGet(`/properties/${uuid}?include=amenities`);
      const p    = data.data || data;
      current    = Array.isArray(p.amenities) ? p.amenities
                 : typeof p.amenities === 'string' ? JSON.parse(p.amenities)
                 : [];
    } catch (e) {
      results.push({ unit, uuid, status: 'error', reason: `fetch failed: ${e.message}` });
      continue;
    }

    const curSet    = new Set(current);
    const target    = [...new Set([...current.filter(k => !removeH.has(k)), ...keepH])].sort();
    const removed   = current.filter(k => removeH.has(k));
    const added     = keepH.filter(k => !curSet.has(k));

    // Push to Hospitable
    let hospStatus = 'ok';
    let hospError  = null;
    try {
      await hospPut(`/properties/${uuid}`, { amenities: target });
      console.log(`[amenities] ✓ ${unit} (${uuid.slice(0,8)}…) -${removed.length} +${added.length}`);
    } catch (e) {
      hospStatus = 'error';
      hospError  = e.message.slice(0, 120);
      console.error(`[amenities] ✗ ${unit}: ${hospError}`);
    }

    results.push({
      unit,
      uuid,
      hospitable_internal: prof.hospitable_internal,
      status:   hospStatus,
      error:    hospError,
      removed,
      added,
      before:   current.length,
      after:    target.length,
    });

    await new Promise(r => setTimeout(r, 300)); // rate-limit buffer
  }

  res.json({ ok: true, results });
});

// ─── Property browser + listing populate ─────────────────────────────────────

// GET /api/properties/all
// Returns all Hospitable properties with internal name, public title, and a
// short description snippet — useful for identifying property IDs.
app.get('/api/properties/all', async (req, res) => {
  try {
    const data = await hospGet('/properties?per_page=100');
    const properties = parseProperties(data);
    res.json({
      count: properties.length,
      properties: properties.map(p => ({
        id:            p.id,
        name:          p.name,
        public_name:   p.public_name,
        description:   (p.description || p.summary || '').slice(0, 200),
        platform:      p.platform || p.channel || null,
        bedrooms:      p.bedrooms || null,
        city:          p.city || p.address?.city || null,
        // Numeric/legacy IDs — useful for mapping to v1 or platform IDs
        hospitable_id: p.hospitable_id || p.legacy_id || p.numeric_id || null,
        platform_id:   p.platform_id   || p.airbnb_id || p.external_id || null,
        listings:      p.listings      || null,
        // Dump any unknown top-level keys so we can discover new fields
        _extra: Object.fromEntries(
          Object.entries(p).filter(([k]) => ![
            'id','name','public_name','description','summary','platform',
            'bedrooms','city','the_space','guest_access','neighborhood_description',
            'getting_around','other_notes','house_rules','amenities',
            'space_overview','neighborhood_overview','access','transit',
            'other_details','notes','check_in_time','check_out_time',
          ].includes(k))
        ),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/properties/:id/raw — proxy a single Hospitable property with optional includes
// ?include=amenities,house_rules,listings (comma-separated)
app.get('/api/properties/:id/raw', async (req, res) => {
  try {
    const includes = req.query.include ? `?include=${req.query.include}` : '';
    const data = await hospGet(`/properties/${req.params.id}${includes}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/properties-map — view all stored property mappings
app.get('/api/properties-map', (req, res) => {
  res.json(loadPropertiesMap());
});

// POST /api/properties-map — manually add or update an entry
// Body: { id, uuid?, label?, airbnb_name?, owner?, notes? }
app.post('/api/properties-map', (req, res) => {
  const { id, ...fields } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  const entry = upsertPropertiesMap(id, fields);
  res.json({ ok: true, id, entry });
});

// POST /api/listing-populate
// Pulls content from source property (vault or Hospitable fields), rewrites it
// via Claude into unique copy, saves to vault for the target property, and
// attempts a Hospitable PUT (may not be supported by public API).
//
// Body: { source_id?, source_name?, target_id?, target_name? }
//   Use source_name / target_name for fuzzy substring match on name/public_name.
app.post('/api/listing-populate', async (req, res) => {
  const { source_id, target_id, source_name, target_name } = req.body;
  if (!source_id && !source_name) return res.status(400).json({ error: 'source_id or source_name required' });
  if (!target_id && !target_name) return res.status(400).json({ error: 'target_id or target_name required' });

  try {
    // ── 1. Find source and target properties ──────────────────────────────────
    const data = await hospGet('/properties?per_page=100');
    const properties = parseProperties(data);

    // Also check the known properties map for numeric/legacy ID → UUID mapping
    const propMap = loadPropertiesMap();

    const findProp = async (id, nameQuery) => {
      // 1. Check properties-map.json for a stored UUID mapping
      if (id && propMap[id]?.uuid) {
        const mapped = properties.find(p => p.id === propMap[id].uuid);
        if (mapped) return mapped;
      }

      // 2. UUID match in list
      if (id) {
        const byUuid = properties.find(p => p.id === id);
        if (byUuid) return byUuid;

        // 3. Try direct Hospitable lookup — resolves numeric/legacy IDs to UUID
        try {
          console.log(`[populate] Trying direct Hospitable lookup for id="${id}"`);
          const detail = await hospGet(`/properties/${id}`);
          const p = detail.data || detail;
          if (p?.id) {
            console.log(`[populate] Resolved "${id}" → UUID ${p.id}`);
            // Persist the numeric→UUID mapping for future calls
            upsertPropertiesMap(id, { uuid: p.id, resolved_from: id });
            const inList = properties.find(prop => prop.id === p.id);
            return inList || p;
          }
        } catch (e) {
          console.log(`[populate] Direct lookup for "${id}" failed: ${e.message.slice(0, 80)}`);
        }

        // 4. platform_id / external_id match
        const byPlatform = properties.find(p =>
          String(p.platform_id || '') === String(id) ||
          String(p.external_id  || '') === String(id) ||
          String(p.airbnb_id    || '') === String(id)
        );
        if (byPlatform) return byPlatform;
      }

      if (nameQuery) {
        const q = nameQuery.toLowerCase();
        return properties.find(p =>
          (p.name        || '').toLowerCase().includes(q) ||
          (p.public_name || '').toLowerCase().includes(q)
        ) || null;
      }

      return null;
    };

    const sourceProp = await findProp(source_id, source_name);
    const targetProp = await findProp(target_id, target_name);

    if (!sourceProp) return res.status(404).json({ error: `Source not found: ${source_id || source_name}` });
    if (!targetProp) return res.status(404).json({ error: `Target not found: ${target_id || target_name}` });

    const sourceLabel = sourceProp.name || sourceProp.public_name || sourceProp.id;
    const targetLabel = targetProp.public_name || targetProp.name || targetProp.id;
    console.log(`[populate] ${sourceLabel} (${sourceProp.id.slice(0,8)}…) → ${targetLabel} (${targetProp.id.slice(0,8)}…)`);

    // ── 2. Build source content — vault first, then Hospitable fields ─────────
    const sv = vault.getVaultEntry(sourceProp.id)?.master || {};
    const sp = sourceProp;

    const src = {
      title:          sv.title          || sp.public_name || sp.name || '',
      summary:        sv.summary        || sp.description || sp.summary || '',
      the_space:      sv.the_space      || sp.space_overview || sp.the_space || '',
      guest_access:   sv.guest_access   || sp.guest_access || sp.access || '',
      neighborhood:   sv.neighborhood   || sp.neighborhood_description || sp.neighborhood_overview || '',
      getting_around: sv.getting_around || sp.getting_around || sp.transit || '',
      other_notes:    sv.other_notes    || sp.other_details || sp.other_notes || sp.notes || '',
      houseRules:     sv.houseRules     || formatHouseRules(sp.house_rules) || '',
      customNotes:    sv.customNotes    || '',
      amenities:      Array.isArray(sp.amenities)
        ? sp.amenities.map(a => a.name || a.label || a).join(', ')
        : '',
    };

    // ── 3. Rewrite via Claude ─────────────────────────────────────────────────
    const systemPrompt = `You are an expert Airbnb copywriter for FIFA World Cup Atlanta 2026 listings.

Rewrite the provided source listing into completely unique copy for a new listing on the same property/building. The new copy must not be flaggable as duplicate content by Airbnb.

Rules:
- Preserve every factual detail (location, specific amenities, check-in/out, rules, features)
- Use a completely different opening angle, sentence structure, and vocabulary
- Lead with a different hook — if the source leads with location, lead with the experience, etc.
- FIFA World Cup 2026 angle must remain prominent in the title and opening
- Title ≤ 50 characters
- Be compelling and conversion-focused

Return ONLY valid JSON, no markdown fences, no extra text:
{
  "title": "≤50 char title",
  "summary": "2–3 sentence hook with a fresh angle",
  "the_space": "physical space description, different structure from source",
  "guest_access": "what guests can use",
  "neighborhood": "neighborhood, different emphasis than source",
  "getting_around": "transport and parking",
  "other_notes": "any other useful info for guests",
  "houseRules": "house rules as a concise paragraph"
}`;

    const userMsg = `Source internal label: "${sourceLabel}"
Target listing: "${targetLabel}"

SOURCE LISTING CONTENT:
TITLE: ${src.title || '(none)'}
SUMMARY: ${src.summary || '(none)'}
THE SPACE: ${src.the_space || '(none)'}
GUEST ACCESS: ${src.guest_access || '(none)'}
NEIGHBORHOOD: ${src.neighborhood || '(none)'}
GETTING AROUND: ${src.getting_around || '(none)'}
OTHER NOTES: ${src.other_notes || '(none)'}
HOUSE RULES: ${src.houseRules || '(none)'}
AMENITIES: ${src.amenities || '(none)'}
${src.customNotes ? `CUSTOM NOTES: ${src.customNotes}` : ''}

Rewrite this into completely unique listing copy.`;

    const raw = await callClaude(systemPrompt, userMsg, 2000);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Claude returned no JSON', raw: raw.slice(0, 400) });

    let rewritten;
    try {
      rewritten = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return res.status(500).json({ error: 'JSON parse failed', raw: raw.slice(0, 400) });
    }

    // ── 4. Save rewritten content to vault for target ─────────────────────────
    vault.saveToVault(targetProp.id, {
      title:          rewritten.title,
      summary:        rewritten.summary,
      the_space:      rewritten.the_space,
      guest_access:   rewritten.guest_access,
      neighborhood:   rewritten.neighborhood,
      getting_around: rewritten.getting_around,
      other_notes:    rewritten.other_notes,
      houseRules:     rewritten.houseRules,
      propertyName:   targetLabel,
      customNotes:    `Rewritten from source: ${sourceLabel} (${sourceProp.id})`,
    });
    console.log(`[populate] ✓ Saved to vault for ${targetProp.id.slice(0,8)}…`);

    // ── 5. Attempt Hospitable push (public API may not support content writes) ─
    let hospPush = 'not_attempted';
    try {
      await hospPut(`/properties/${targetProp.id}`, {
        public_name:              rewritten.title,
        description:              [rewritten.summary, rewritten.the_space].filter(Boolean).join('\n\n'),
        the_space:                rewritten.the_space,
        guest_access:             rewritten.guest_access,
        neighborhood_description: rewritten.neighborhood,
        getting_around:           rewritten.getting_around,
        other_details:            rewritten.other_notes,
      });
      hospPush = 'pushed';
      console.log(`[populate] ✓ Pushed to Hospitable for ${targetProp.id.slice(0,8)}…`);
    } catch (e) {
      hospPush = `api_unsupported: ${e.message.slice(0, 100)}`;
      console.log(`[populate] Hospitable push skipped (${e.message.slice(0, 60)}) — use clipboard below`);
    }

    // ── 6. Format clipboard output ────────────────────────────────────────────
    const sections = [
      ['TITLE',          rewritten.title],
      ['SUMMARY',        rewritten.summary],
      ['THE SPACE',      rewritten.the_space],
      ['GUEST ACCESS',   rewritten.guest_access],
      ['NEIGHBORHOOD',   rewritten.neighborhood],
      ['GETTING AROUND', rewritten.getting_around],
      ['OTHER NOTES',    rewritten.other_notes],
      ['HOUSE RULES',    rewritten.houseRules],
    ];
    const clipboard = sections.filter(([, v]) => v).map(([k, v]) => `${k}:\n${v}`).join('\n\n');

    res.json({
      ok: true,
      source:          { id: sourceProp.id, label: sourceLabel },
      target:          { id: targetProp.id, label: targetLabel },
      before: {
        title:   src.title,
        summary: src.summary.slice(0, 400),
      },
      after:           rewritten,
      vault_saved:     true,
      hospitable_push: hospPush,
      clipboard,
    });

  } catch (e) {
    console.error('[populate] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Nightly cleaning schedule ───────────────────────────────────────────────

const CLEANING_UNITS = [
  { id: '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc', label: 'Apt 18-A' },
  { id: '80c21aac-00eb-49af-9094-6792839ff5a4', label: 'Apt 21-D' },
  { id: '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c', label: 'Apt 21-I' },
  { id: '3e702102-a219-4c18-9f88-3a4d1ceb3825', label: 'Apt 24-L' },
  { id: 'bbe43523-c42a-46b0-8235-7ad08ae990c9', label: 'Apt 4-L'  },
  { id: '283977a3-3af3-4d90-8d95-b418a3014d90', label: 'Apt 23-N' },
  { id: '1af8fdde-58ee-426e-8374-6530397347e8', label: 'Apt 7-B'  },
];

const SPANISH_DAYS   = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
const SPANISH_MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

function tomorrowDateString() {
  // "Tomorrow" in the cron's timezone (America/New_York), NOT UTC. At 9PM ET the
  // UTC date has already rolled to the next day, so the old toISOString() logic
  // targeted a day too far ahead. See src/cleaning-schedule.js.
  return tomorrowInTZ(new Date(), 'America/New_York');
}

function formatSpanishDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return `${SPANISH_DAYS[d.getUTCDay()]} ${SPANISH_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Returns true if the message thread shows BOTH a request AND payment confirmation
function detectPaidAdjustment(messages, type) {
  const requestPattern  = type === 'late_checkout'
    ? /late.{0,20}check.?out|check.?out.{0,20}late|stay.{0,15}later|late\s+departure/i
    : /early.{0,20}check.?in|check.?in.{0,20}early|arriv.{0,15}early|early\s+arrival/i;
  const paymentPattern  = /\$45|payment\s+received|paid|resolution\s+center|payment\s+confirmed/i;
  const approvalPattern = /confirmed|approved|all\s+set|you're\s+good|sounds\s+good|absolutely|of\s+course|no\s+problem|we\s+can\s+accommodate/i;

  let guestRequested = false;
  let hostApproved   = false;
  let paymentSeen    = false;

  for (const msg of messages) {
    const body   = (msg.body || '').trim();
    const sender = msg.sender_role || msg.sender_type || '';
    if (!body) continue;

    if (sender === 'guest' && requestPattern.test(body)) guestRequested = true;

    if ((sender === 'host' || sender === 'co-host' || sender === 'teammate') && approvalPattern.test(body)) {
      if (guestRequested) hostApproved = true;
    }

    if (paymentPattern.test(body)) paymentSeen = true;
  }

  return guestRequested && hostApproved && paymentSeen;
}

async function getReservationMessages(reservationId) {
  try {
    const data = await hospGet(`/reservations/${reservationId}/messages?per_page=50`);
    return parseMessages(data);
  } catch (e) {
    console.error(`[cleaning] Could not fetch messages for ${reservationId}: ${e.message}`);
    return [];
  }
}

function dateOffset(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Fetch reservations around a target date and split into check-outs / check-ins on that date.
// DATE-BOUNDED on purpose: an unbounded per_page=50 pull silently dropped a departing
// reservation (it returns an arbitrary window), so a real checkout could be missed. We query a
// [target-30 .. target+1] window (overlap-based) so any in-progress stay departing on the target
// — even a long one — is returned. Only ACTIVE (non-cancelled) reservations count.
async function getReservationsForDate(propertyId, dateStr) {
  try {
    const startBound = dateOffset(dateStr, -30);
    const endBound   = dateOffset(dateStr, 1);
    const data = await hospGet(
      `/reservations?properties[]=${propertyId}&start_date=${startBound}&end_date=${endBound}&per_page=100&include=guest`
    );
    const reservations = parseReservations(data).filter(isActiveReservation);
    const coField = r => (r.check_out || r.checkout || r.check_out_date || r.departure_date || r.end_date || r.departure || '').slice(0, 10);
    const ciField = r => (r.check_in  || r.checkin  || r.check_in_date  || r.arrival_date  || r.start_date || r.arrival || '').slice(0, 10);
    const outgoing = reservations.filter(r => coField(r) === dateStr);
    const incoming = reservations.filter(r => ciField(r) === dateStr);
    return { outgoing, incoming };
  } catch (e) {
    console.error(`[cleaning] Reservations lookup FAILED for ${propertyId}: ${e.message}`);
    return { outgoing: [], incoming: [] };
  }
}

async function buildCleaningEntry(unit, tomorrow) {
  // SOURCE OF TRUTH: a CHECKOUT on the target date means a turnover → cleaning needed.
  // (The old calendar gate required the target day to be FREE, which wrongly dropped every
  //  same-day turnover — a turnover makes the target day RESERVED by the incoming guest. The
  //  reservations API tells us checkouts directly and distinguishes a back-to-back from a
  //  continuing multi-night stay, which the calendar alone cannot.)
  const { outgoing, incoming } = await getReservationsForDate(unit.id, tomorrow);
  const { needsCleaning, sameDayTurnover } = classifyTurnover(outgoing, incoming);
  console.log(`[cleaning] ${unit.label} (${unit.id.slice(0,8)}…) ${tomorrow}: checkouts=${outgoing.length} checkins=${incoming.length} → ${needsCleaning ? (sameDayTurnover ? 'TURNOVER (priority)' : 'cleaning') : 'skip'}`);
  if (!needsCleaning) return null;

  // Same-day turnover (a check-in on the same date as the checkout) = highest priority.
  const hasSameDayIncoming = sameDayTurnover;

  // --- Vacancy time ---
  let vacancyTime      = '11:00AM';
  let vacancyConfirmed = false;
  if (outgoing.length > 0) {
    const msgs = await getReservationMessages(outgoing[0].id);
    if (detectPaidAdjustment(msgs, 'late_checkout')) {
      vacancyTime      = '1:30PM';
      vacancyConfirmed = true;
    }
  }

  // --- Deadline ---
  let deadlineTime      = null;
  let deadlineConfirmed = false;
  if (hasSameDayIncoming) {
    deadlineTime = '4:00PM';
    const msgs = await getReservationMessages(incoming[0].id);
    if (detectPaidAdjustment(msgs, 'early_checkin')) {
      deadlineTime      = '1:00PM';
      deadlineConfirmed = true;
    }
  }

  return {
    label:            unit.label,
    priority:         hasSameDayIncoming,
    vacancyTime,
    vacancyConfirmed,
    deadlineTime,
    deadlineConfirmed,
  };
}

function formatCleaningLine(entry) {
  const tag      = entry.manual ? ' (manual)' : '';
  const vacPart  = `disponible desde las ${entry.vacancyTime}${entry.vacancyConfirmed ? ' ✅' : ''}`;
  if (!entry.deadlineTime) return `• ${entry.label}${tag} — ${vacPart}`;
  const deadPart = `lista para las ${entry.deadlineTime}${entry.deadlineConfirmed ? ' ✅' : ''}`;
  return `• ${entry.label}${tag} — ${deadPart}, ${vacPart}`;
}

// Pure: assemble the SMS body from cleaning entries (priority/regular split). Exported so a
// dry-run can render the exact message without sending anything.
function buildScheduleSMS(entries, spanishDate) {
  if (!entries || entries.length === 0) {
    return `🧹 Sin limpiezas — ${spanishDate}\n— Peachtree Tower Rentals`;
  }
  const priority = entries.filter(e => e.priority);
  const regular  = entries.filter(e => !e.priority);
  const lines    = [];
  if (priority.length > 0) {
    lines.push('⚡ URGENTE (huésped entrante mismo día):');
    priority.forEach(e => lines.push(formatCleaningLine(e)));
  }
  if (regular.length > 0) {
    if (priority.length > 0) lines.push('');
    lines.push('Limpieza regular:');
    regular.forEach(e => lines.push(formatCleaningLine(e)));
  }
  return `🧹 Limpieza — ${spanishDate}\n\n${lines.join('\n')}\n\n— Peachtree Tower Rentals`;
}

async function sendCleaningSchedule() {
  const tomorrow    = tomorrowDateString();
  const spanishDate = formatSpanishDate(tomorrow);
  console.log(`[cleaning] Running schedule for ${tomorrow} (${spanishDate})`);

  const entries = [];
  for (const unit of CLEANING_UNITS) {
    const entry = await buildCleaningEntry(unit, tomorrow);
    if (entry) entries.push(entry);
    await new Promise(r => setTimeout(r, 200));
  }

  // Merge any host-set manual override for THIS night (add/remove a unit), then expire it so it
  // can't affect a future run. Pruned by date on load; the applied date is deleted after send.
  const todayET = dateInTimeZone(new Date(), 'America/New_York');
  const store   = cleaningOverride.pruneExpired(cleaningOverride.loadStore(), todayET);
  const override = store[tomorrow];
  let finalEntries = entries;
  if (override && ((override.add || []).length || (override.remove || []).length)) {
    finalEntries = cleaningOverride.applyOverride(entries, override);
    console.log(`[cleaning] Manual override applied for ${tomorrow}: +[${(override.add || []).join(', ')}] -[${(override.remove || []).join(', ')}]`);
  }

  const smsBody = buildScheduleSMS(finalEntries, spanishDate);
  console.log(`[cleaning] SMS:\n${smsBody}`);

  const apiKey    = process.env.QUO_API_KEY;
  const from      = process.env.QUO_FROM_NUMBER;
  const recipients = ['229-573-3899', '954-552-2122']; // cleaner + host

  if (!apiKey || !from) {
    console.warn('[cleaning] QUO_API_KEY or QUO_FROM_NUMBER not set — SMS not sent');
    return { ok: false, smsBody, error: 'QUO not configured' };
  }

  const results = [];
  for (const to of recipients) {
    try {
      const res = await fetch('https://api.openphone.com/v1/messages', {
        method: 'POST',
        headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: [to], from, content: smsBody }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenPhone ${res.status}: ${err}`);
      }
      console.log(`[cleaning] ✓ SMS sent to ${to}`);
      results.push({ to, ok: true });
    } catch (e) {
      console.error(`[cleaning] SMS failed for ${to}: ${e.message}`);
      results.push({ to, ok: false, error: e.message });
    }
  }

  // Expire this night's override now that it's been applied; persist the date-pruned store so a
  // past override never leaks into a future run (also self-heals if today rolled over).
  if (store[tomorrow]) delete store[tomorrow];
  cleaningOverride.saveStore(store);

  const allOk = results.every(r => r.ok);
  return { ok: allOk, smsBody, entries: finalEntries.length, override: override || null, recipients: results };
}

// READ-ONLY view of a date's cleaning list — the SAME entries + host overrides the 9 PM cron would
// send to Veronica, but sends NO SMS and mutates NOTHING (no override expiry/persist). Powers the
// Telegram "cleaning_status" query. The override store is loaded + pruned IN MEMORY for display only
// (never saved), so viewing tonight's list can't expire an override the real 9 PM run still needs.
async function buildCleaningScheduleText(dateStr) {
  const spanishDate = formatSpanishDate(dateStr);
  const entries = [];
  for (const unit of CLEANING_UNITS) {
    const entry = await buildCleaningEntry(unit, dateStr);   // GET reservations only — no send
    if (entry) entries.push(entry);
    await new Promise(r => setTimeout(r, 150));
  }
  const todayET  = dateInTimeZone(new Date(), 'America/New_York');
  const override = cleaningOverride.pruneExpired(cleaningOverride.loadStore(), todayET)[dateStr]; // read-only
  let finalEntries = entries;
  if (override && ((override.add || []).length || (override.remove || []).length)) {
    finalEntries = cleaningOverride.applyOverride(entries, override);
  }
  return { text: buildScheduleSMS(finalEntries, spanishDate), count: finalEntries.length, date: dateStr, override: override || null };
}

// POST /api/cleaning-override — host-set manual add/remove for one night's cleaning schedule.
// Body: { action: 'add'|'remove', unit: '7-B', date?: 'YYYY-MM-DD' }  (date defaults to tomorrow,
// i.e. tonight's 9 PM run). Recorded + persisted; merged into that night's run, then auto-expired.
app.post('/api/cleaning-override', (req, res) => {
  const { action, unit, date, priority, deadline } = req.body || {};
  if (action !== 'add' && action !== 'remove') return res.status(400).json({ error: "action must be 'add' or 'remove'" });
  const label = cleaningOverride.canonicalUnit(unit, CLEANING_UNITS.map(u => u.label));
  if (!label) return res.status(400).json({ error: `unknown unit "${unit}" — valid: ${CLEANING_UNITS.map(u => u.label).join(', ')}` });
  const todayET    = dateInTimeZone(new Date(), 'America/New_York');
  const targetDate = date || tomorrowDateString();
  if (targetDate < todayET) return res.status(400).json({ error: `date ${targetDate} is in the past` });
  const normDeadline = cleaningOverride.normalizeTime(deadline);   // 'add' only; "4pm" → "4:00PM"
  const store = cleaningOverride.recordOverride(
    cleaningOverride.pruneExpired(cleaningOverride.loadStore(), todayET),
    targetDate, action, label, { priority: !!priority, deadline: normDeadline },
  );
  cleaningOverride.saveStore(store);
  const urgent = action === 'add' && !!priority;
  console.log(`[cleaning] Override registered: ${action} ${label} for ${targetDate}${urgent ? ` (URGENT, ready by ${normDeadline || '4:00PM'})` : ''}`);
  res.json({
    ok: true, action, unit: label, date: targetDate,
    priority: action === 'add' ? !!priority : undefined,
    deadline: action === 'add' ? (normDeadline || (priority ? '4:00PM' : null)) : undefined,
    overrides: store[targetDate],
  });
});

// POST /api/door-code — host-set per-unit door code from the phone ("set door code for 21-I to 3562").
// Body: { unit: '21-I', code: '3562' }. Validates the unit + 4–8-digit code, persists to the volume
// store (data/door-codes.json), and is bound per-unit so it can only ever be served for THAT unit.
app.post('/api/door-code', (req, res) => {
  const { unit, code } = req.body || {};
  try {
    const store = doorCodes.setDoorCode(doorCodes.loadStore(), unit, code);
    doorCodes.saveStore(store);
    const label = doorCodes.canonicalUnit(unit);
    console.log(`[door-code] set ${label} (code updated)`);
    res.json({ ok: true, unit: label });   // never echo the code back
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/wifi — host-set per-unit Wi-Fi from the phone ("set wifi for 7-B to ARRIS-4A75-5G / 3G5344101127").
// Body: { unit: '7-B', name: 'ARRIS-4A75-5G', password: '...' }. Persists to the same per-unit
// volume store as the door codes, bound per-unit. Omit to fall back to the default rule.
app.post('/api/wifi', (req, res) => {
  const { unit, name, password } = req.body || {};
  try {
    const store = doorCodes.setWifi(doorCodes.loadStore(), unit, name, password);
    doorCodes.saveStore(store);
    const label = doorCodes.canonicalUnit(unit);
    console.log(`[wifi] set ${label} → SSID ${name} (password updated)`);
    res.json({ ok: true, unit: label, wifi_name: name });   // never echo the password back
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/cleaner-message — fire a one-off SMS to Veronica (the cleaner) via OpenPhone, using
// the SAME QUO creds as the nightly cleaning schedule. Body: { message: '...' } (alias: { text }).
// Auth: the /api/ Bearer(API_SECRET) middleware above. This is the "text Veronica: ..." action —
// no credential hunting, no raw curl. 400 empty / 503 not configured / 502 OpenPhone failure.
app.post('/api/cleaner-message', async (req, res) => {
  const raw = (req.body && (req.body.message ?? req.body.text)) || '';
  const { message, error } = cleanerMessage.validateMessage(raw);
  if (error) return res.status(400).json({ error });
  const result = await cleanerMessage.buildCleanerSender()(message);
  if (result.ok) return res.json({ ok: true, to: result.to, status: result.status, message });
  const code = result.reason === 'not configured' ? 503 : 502;
  return res.status(code).json({ ok: false, to: result.to, error: result.reason || result.error || `OpenPhone ${result.status}`, status: result.status });
});

// POST /api/knowledge — host-curated knowledge facts for the auto-responder.
// Body: { action: 'add', topic, fact, scope? } | { action: 'remove', topic } | { action: 'list' }.
// "remember: guests asking about X should be told Y" → add (same topic supersedes the old fact);
// "forget the fact about X" → remove. GET /api/knowledge also lists. Scope defaults to 'all'
// (every Atlanta property); pass an array of property ids for per-unit targeting later.
app.post('/api/knowledge', (req, res) => {
  const { action, topic, fact, scope } = req.body || {};
  const facts = hostFacts.loadStore();

  if (action === 'list') return res.json({ ok: true, facts });

  if (action === 'add') {
    if (!hostFacts.slugTopic(topic)) return res.status(400).json({ error: 'topic is required' });
    if (!String(fact || '').trim()) return res.status(400).json({ error: 'fact is required' });
    const next = hostFacts.addFact(facts, { topic, fact, scope: scope || 'all' });
    hostFacts.saveStore(next);
    const added = next.find(f => f.id === hostFacts.slugTopic(topic));
    console.log(`[knowledge] Fact added/updated: "${added.topic}" (scope=${JSON.stringify(added.scope)})`);
    return res.json({ ok: true, action, fact: added, count: next.length });
  }

  if (action === 'remove') {
    if (!hostFacts.slugTopic(topic)) return res.status(400).json({ error: 'topic is required' });
    const { facts: next, removed } = hostFacts.removeFact(facts, topic);
    hostFacts.saveStore(next);
    console.log(`[knowledge] Fact remove "${topic}" → ${removed ? 'removed' : 'no match'}`);
    return res.json({ ok: true, action, topic, removed, count: next.length });
  }

  return res.status(400).json({ error: "action must be 'add', 'remove', or 'list'" });
});

app.get('/api/knowledge', (_req, res) => res.json({ ok: true, facts: hostFacts.loadStore() }));

// ─── Test endpoint ────────────────────────────────────────────────────────────

app.post('/api/test-cleaning-schedule', async (req, res) => {
  try {
    const result = await sendCleaningSchedule();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Temporary debug endpoint — shows raw reservation fields for a property
app.get('/api/debug-reservations/:propertyId', async (req, res) => {
  try {
    // No status filter — fetch all statuses to catch checked_in, confirmed, etc.
    const raw = await hospGet(
      `/reservations?properties[]=${req.params.propertyId}&per_page=20&include=guest`
    );
    const reservations = parseReservations(raw);
    // Return the first reservation's full key set so we can see the exact field names
    res.json({
      count: reservations.length,
      firstReservationKeys: reservations[0] ? Object.keys(reservations[0]) : [],
      first: reservations[0] || null,
      all: reservations.map(r => ({
        id: r.id,
        // Show every possible date field name
        check_in:      r.check_in,
        checkin:       r.checkin,
        check_in_date: r.check_in_date,
        start_date:    r.start_date,
        arrival:       r.arrival,
        check_out:      r.check_out,
        checkout:       r.checkout,
        check_out_date: r.check_out_date,
        end_date:       r.end_date,
        departure:      r.departure,
        status: r.status,
        guest: r.guest?.full_name || r.guest?.first_name,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
// Only boot the HTTP server / pollers / cron when run directly (node src/server.js).
// When required by a test, skip startup so functions can be imported side-effect-free.
if (require.main === module) {
app.listen(PORT, () => {
  console.log(`\n🏠 Airbnb AutoHost running on port ${PORT}`);
  console.log(`   Host: ${HOST_SETTINGS.name} | Delay: ${HOST_SETTINGS.delayMinutes}min\n`);
  // Startup diagnostic: prove the volume split — seen/pending persist to STATE_DIR
  // (the volume), while static config still loads from the repo (DATA_DIR unset).
  try {
    const stateDir = process.env.STATE_DIR || process.env.DATA_DIR || '(repo ./data)';
    const mapCount = Object.keys(loadPropertiesMap()).length;
    let codeCount = 0; try { codeCount = Object.keys(loadEntryCodes()).length; } catch (_) {}
    console.log(`[startup] STATE_DIR(volume)=${stateDir} | properties-map=${mapCount} units | entry-codes=${codeCount} units`);
  } catch (e) { console.warn('[startup] diagnostic failed:', e.message); }
  restorePendingReplies(); // deploy-churn fix: re-send/re-arm queued replies persisted before the restart
  setTimeout(() => {
    initAllPropertyProfiles().catch(e => {
      console.error('[startup] initAllPropertyProfiles failed:', e.message);
    });
  }, 3000);

  // Nightly cleaning schedule — 9:00 PM Eastern every night
  cron.schedule('0 21 * * *', () => {
    console.log('[cleaning] Cron fired — 9:00 PM Eastern');
    sendCleaningSchedule().catch(e => console.error('[cleaning] Cron error:', e.message));
  }, { timezone: 'America/New_York' });
  console.log('[cleaning] Cron scheduled — 9:00 PM Eastern daily');

  // Morning check-in sweep — 8:00 AM Eastern (kept off the 9 AM pricing slot). For every guest
  // arriving TODAY who hasn't already been sent check-in instructions, send them (bound to that
  // reservation's own unit); a unit missing a field is skipped (host-alerted, never sent broken);
  // the host gets an SMS summary. HOST_NAME sets the sign-off (defaults to "KS").
  async function runMorningCheckinSweep(dryRun = false) {
    const today = dateInTimeZone(new Date(), 'America/New_York');
    const listArrivals = async (day) => {
      const out = [];
      for (const u of CLEANING_UNITS) {
        const { incoming } = await getReservationsForDate(u.id, day);
        for (const r of (incoming || [])) { r.propertyId = u.id; out.push(r); }
      }
      return out;
    };
    return checkinSweep.runSweep({
      today, listArrivals,
      fetchThread: (id) => fetchMessagesForReservation(id),
      send: (id, body, type) => sendToHospitable(id, body, type),
      smsHost: (text) => notifyHostRaw(text),
      propsMap: loadPropertiesMap(), doorCodeStore: doorCodes.loadStore(),
      hostName: process.env.HOST_NAME || 'KS', dryRun,
    });
  }
  cron.schedule('0 8 * * *', () => {
    console.log('[checkin] Cron fired — 8:00 AM Eastern morning sweep');
    runMorningCheckinSweep().catch(e => console.error('[checkin] sweep error:', e.message));
  }, { timezone: 'America/New_York' });
  console.log('[checkin] Morning check-in sweep scheduled — 8:00 AM Eastern daily');

  // Daily pricing run — 9:00 AM Eastern, 23-N ONLY (--confirm --batch 30, no override-sanity).
  // Spawns the engine as a child process so its exit can't take the server down. Set
  // PRICING_CRON=off (Railway env) to disable without a redeploy.
  if (process.env.PRICING_CRON === 'off') {
    console.log('[pricing] Cron DISABLED via PRICING_CRON=off');
  } else {
    cron.schedule(PRICING_CRON_SCHEDULE, () => runPricingAllUnits(), { timezone: PRICING_CRON_TZ });
    console.log('[pricing] Cron scheduled — 9:00 AM Eastern daily (all 7 units, independent pushes)');
    // Dead-man's switch: 30 min after the run, verify a healthy run is on record (alerts via SMS if not)
    cron.schedule(PRICING_HEALTHCHECK_SCHEDULE, () => runPricingHealthcheck(), { timezone: PRICING_CRON_TZ });
    console.log('[pricing] Dead-man healthcheck scheduled — 9:30 AM Eastern daily');
    // Vacancy decay passes — 9 AM / 3 PM / 7 PM Eastern. Ratchets fenced units' nightly
    // price down one step (floored, booked-skip). The runner self-no-ops once its campaign
    // window is past, so these schedules are date-scoped and self-lifting (no teardown).
    for (const sched of DECAY_CRON_SCHEDULES) {
      cron.schedule(sched, () => runDecayPass(), { timezone: PRICING_CRON_TZ });
    }
    console.log('[decay] Vacancy decay scheduled — 9:00 AM / 3:00 PM / 7:00 PM Eastern (date-scoped, self-lifting)');
    // World Cup FILL decay — Jun 14–26, same 9/15/19 ET cadence. Ratchets the fill-seeded
    // nights toward their per-date floors (booked-skip); engine fences these dates so it never
    // reverts them. Self-lifting after Jun 26; kill switch via WC_FILL.active / WC_FILL_OFF.
    for (const sched of DECAY_CRON_SCHEDULES) {
      cron.schedule(sched, () => runWcFillPass(), { timezone: PRICING_CRON_TZ });
    }
    console.log('[wc-fill] World Cup fill decay scheduled — 9:00 AM / 3:00 PM / 7:00 PM Eastern (Jun 14–26, self-lifting)');
  }

  // ─── Telegram ops bot — long-poll, OWNER-LOCKED, folded into this service ───────────────────
  // Plain-English host commands → Haiku parse → existing authed endpoints/flows. Guest messages +
  // pricing changes draft/echo and fire only on "yes"; everything else fires immediately. Only the
  // numeric TELEGRAM_OWNER_ID is ever answered. No public route — long-poll out to Telegram.
  (function startTelegramOpsBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const ownerId = process.env.TELEGRAM_OWNER_ID;
    const today = () => dateInTimeZone(new Date(), 'America/New_York');

    const handlers = {
      // ── Immediate (fire, then confirm) ──
      cleaning_override: async (intent) => {
        const lines = [];
        for (const op of intent.ops) {
          const { ok, json } = await callLocalApi('POST', '/api/cleaning-override', { action: op.op, unit: op.unit, date: op.date, priority: op.urgent, deadline: op.deadline });
          if (ok) lines.push(`${op.op === 'add' ? '➕' : '➖'} ${json.unit} ${op.op === 'add' ? 'added to' : 'removed from'} cleaning ${json.date}${json.priority ? ` ⚡ urgent (ready by ${json.deadline})` : ''}`);
          else lines.push(`⚠️ ${op.unit}: ${json.error || 'failed'}`);
        }
        return lines.join('\n');
      },
      cleaner_message: async (intent) => {
        const { ok, json } = await callLocalApi('POST', '/api/cleaner-message', { message: intent.message });
        return ok ? `✅ Texted Veronica: “${intent.message}”` : `⚠️ Couldn't text Veronica: ${json.error || 'failed'}`;
      },
      cleaning_status: async (intent) => {
        const date = intent.date || tomorrowDateString();   // default: tonight's run (tomorrow)
        const { text, count } = await buildCleaningScheduleText(date);   // read-only — sends nothing
        return `🧹 Cleaning schedule for ${date} (preview — nothing sent to Veronica):\n\n${text}\n\n(${count} unit${count === 1 ? '' : 's'}${intent.date ? '' : ' — defaulted to tomorrow'})`;
      },
      checkin_status: async () => {
        const plan = await runMorningCheckinSweep(true); // DRY-RUN — sends nothing
        return `🏨 Check-in status ${today()}:\n${plan.summary}`;
      },
      checkin_resend: async (intent) => {
        const arrivals = await listArrivalsToday(today());
        const label = telegramIntent.canonUnit(intent.target);
        const q = intent.target.toLowerCase();
        const cands = label ? arrivals.filter(a => a.label === label) : arrivals.filter(a => reservationGuestName(a.r).toLowerCase().includes(q));
        if (cands.length === 0) return `No arrival today matching “${intent.target}”. (Resend only covers guests arriving today.)`;
        if (cands.length > 1) return `More than one arrival matches “${intent.target}”: ${cands.map(c => `${reservationGuestName(c.r)} (${c.label})`).join(', ')}. Which one?`;
        const { r, label: unitLabel } = cands[0];
        const { fields, missing } = checkinTemplate.resolveCheckin(r, loadPropertiesMap(), doorCodes.loadStore(), { hostName: process.env.HOST_NAME || 'KS' });
        if (missing.length) return `⚠️ Can't resend — ${unitLabel} is missing ${missing.join(', ')}. Handle manually.`;
        await sendToHospitable(r.id, checkinTemplate.renderCheckinInstructions(fields), 'reservation');
        return `✅ Re-sent check-in instructions to ${reservationGuestName(r) || 'guest'} (${unitLabel}).`;
      },
      frontdesk_form: async (intent) => {
        const arrivals = await listArrivalsToday(today());
        const cands = arrivals.filter(a => reservationGuestName(a.r).toLowerCase().includes(intent.name.toLowerCase()));
        if (cands.length === 0) return `No arrival today matching “${intent.name}”. The front-desk form only fires for guests arriving today.`;
        if (cands.length > 1) return `More than one arrival matches “${intent.name}” today: ${cands.map(c => `${reservationGuestName(c.r)} (${c.label})`).join(', ')}. Which one?`;
        const { r, id, label } = cands[0];
        await runConciergeContingency({ guestName: reservationGuestName(r) || 'Guest', propertyId: id, resourceId: r.id, resourceType: 'reservation', propertyName: label, context: 'telegram-frontdesk' });
        return `✅ Front-desk form sent for ${reservationGuestName(r) || 'guest'} (${label}) — concierge email + desk SMS fired.`;
      },
      // ── Confirmed (fired by executePending after "yes") ──
      guest_message_send: async ({ guest, text }) => {
        const r = await sendToHospitable(guest.id, text, guest.resourceType || 'reservation');
        if (r && r.paused) return `⏸ AUTOSEND is off — message NOT sent.`;
        return `✅ Sent to ${guest.name} (${guest.propertyName}).`;
      },
      pricing_adjust: async (intent) => {
        const { ok, json } = await callLocalApi('POST', '/api/pricing/adjust', { pct: intent.pct, start: intent.start, end: intent.end, units: intent.units });
        if (!ok) return `⚠️ Price adjust failed: ${json.error || 'error'}`;
        return `✅ ${intent.pct > 0 ? 'Raised' : 'Lowered'} prices ${Math.abs(intent.pct)}% ${intent.start}→${intent.end}: ${json.totalChanged} night(s) changed. To undo: "revert last price change" (id ${json.recordId}).`;
      },
      pricing_status: async (intent) => {
        // READ-ONLY: report decay/freeze state + why each night in the range would/wouldn't decay.
        const t = today();
        const start = intent.start || t;
        const end = intent.end || pricingFreeze.addDays(t, 7);
        const allLabels = Object.keys(UNIT_LABEL_TO_ID);
        const units = (intent.units === 'all' || !Array.isArray(intent.units) || !intent.units.length)
          ? allLabels : intent.units;
        // Best-effort live calendar (price + availability) via the internal read-only endpoint.
        // On any failure, fall back to the fence-only status (still answers "would it decay").
        let calendar = null;
        try {
          const { ok, json } = await callLocalApi('GET', `/api/pricing?start=${start}&end=${end}`);
          if (ok && Array.isArray(json.properties)) {
            calendar = {};
            for (const p of json.properties) {
              const label = ID_TO_LABEL[p.id];
              if (!label || !units.includes(label)) continue;
              const floor = pricingConfig.units?.[label]?.floor ?? null;
              calendar[label] = {};
              for (const d of (p.days || [])) {
                if (!d.date) continue;
                calendar[label][d.date] = {
                  price: typeof d.price === 'number' ? Math.round(d.price) : null,
                  floor,
                  booked: d.available === false,
                };
              }
            }
          }
        } catch { /* fence-only fallback */ }
        const store = pricingFreeze.loadStore();
        const status = decayStatus.buildDecayStatus({ start, end, units, todayYmd: t, freezeStore: store, calendar });
        return `📊 ${status.text}\n\n(read-only — nothing was changed)`;
      },
      pricing_decay_freeze: async (intent) => {
        const { ok, json } = await callLocalApi('POST', '/api/pricing/decay-freeze', { enable: intent.enable, days: intent.days });
        if (!ok) return `⚠️ Decay-freeze failed: ${json.error || 'error'}`;
        return intent.enable
          ? `✅ Decay frozen for ${json.days} day(s) (${json.window.start}→${json.window.end}). Set prices by hand; automation won't touch those nights.`
          : `✅ Decay turned back ON — automation resumed.`;
      },
    };

    telegramBot.start({
      token, ownerId, log: console,
      pending: new Map(),
      parse: (text) => telegramIntent.parseIntent({ text, callClaude: callClaudeForBot, today: today() }),
      compose: composeGuestMessage,
      resolveGuest: resolveGuestThread,
      handlers,
    });
  })();
});
}

// Catch unhandled promise rejections so a single async failure can't take
// down the server (Railway sends SIGTERM when the process exits unexpectedly)
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err.message, err.stack);
});

// ─── Vault routes ─────────────────────────────────────────────────────────────

// Get full vault
app.get('/api/vault', (req, res) => {
  res.json({ vault: vault.getVault() });
});

// Get single vault entry
app.get('/api/vault/:propertyId', (req, res) => {
  const entry = vault.getVaultEntry(req.params.propertyId);
  if (!entry) return res.status(404).json({ error: 'Not in vault' });
  res.json(entry);
});

// Save/update master content
app.post('/api/vault/:propertyId', (req, res) => {
  const { title, summary, the_space, guest_access, neighborhood, getting_around, other_notes, houseRules, customNotes, propertyName } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  vault.saveToVault(req.params.propertyId, { title, summary, the_space, guest_access, neighborhood, getting_around, other_notes, houseRules, customNotes, propertyName });
  res.json({ ok: true });
});

// Auto-import from Hospitable into vault
app.post('/api/vault/import/hospitable', async (req, res) => {
  try {
    const data = await hospGet('/properties?per_page=50');
    const properties = parseProperties(data);
    const imported = [];

    for (const p of properties) {
      const id    = p.id;
      const name  = p.public_name || p.name || id;
      const title = p.public_name || p.name || '';
      const rawDescription = p.description || p.summary || '';

      // Fields Hospitable may return pre-split (usually empty for basic accounts)
      const the_space      = p.space_overview            || p.the_space   || '';
      const guest_access   = p.guest_access              || p.access      || '';
      const neighborhood   = p.neighborhood_description  || p.neighborhood_overview || p.directions || '';
      const getting_around = p.getting_around            || p.transit     || '';
      const other_notes    = p.other_details             || p.other_notes || p.notes || '';
      const houseRules     = formatHouseRules(p.house_rules);

      if (!title && !rawDescription) continue;

      // If Hospitable returned no split sections, ask Claude to split the description
      const hasAnySections = the_space || guest_access || neighborhood || getting_around || other_notes;
      let sections = { summary: rawDescription, the_space, guest_access, neighborhood, getting_around, other_notes };

      if (rawDescription && !hasAnySections) {
        try {
          console.log(`[import] Splitting description for "${name}" with Claude...`);
          sections = await vault.splitDescription(rawDescription, name, callClaude);
          // Ensure summary is populated even if Claude left it empty
          if (!sections.summary) sections.summary = rawDescription;
        } catch (e) {
          console.error(`[import] Split failed for "${name}":`, e.message);
          sections = { summary: rawDescription, the_space: '', guest_access: '', neighborhood: '', getting_around: '', other_notes: '' };
        }
      }

      vault.saveToVault(id, { title, ...sections, houseRules, propertyName: name });
      imported.push(name);
    }

    res.json({ ok: true, imported });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate a variation
app.post('/api/vault/:propertyId/variation', async (req, res) => {
  const { intensity } = req.body; // light | medium | heavy
  try {
    const variation = await vault.generateVariation(req.params.propertyId, intensity || 'medium', callClaude);
    res.json({ ok: true, variation });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Format vault content for clipboard export
// NOTE: The Hospitable public API v2 exposes no write endpoint for listing
// content (title, description, sections). The only writable property operation
// is PUT /properties/{uuid}/calendar (pricing/availability). Until Hospitable
// adds a content-write endpoint, updates must be pasted manually into the app.
app.post('/api/vault/:propertyId/push', (req, res) => {
  const { title, summary, the_space, guest_access, neighborhood, getting_around, other_notes, houseRules } = req.body;

  const SECTION_LABELS = {
    summary:        'SUMMARY',
    the_space:      'THE SPACE',
    guest_access:   'GUEST ACCESS',
    neighborhood:   'NEIGHBORHOOD',
    getting_around: 'GETTING AROUND',
    other_notes:    'OTHER NOTES',
    houseRules:     'HOUSE RULES',
  };
  const values = { summary, the_space, guest_access, neighborhood, getting_around, other_notes, houseRules };

  const lines = [`TITLE:\n${title || ''}`];
  for (const [key, label] of Object.entries(SECTION_LABELS)) {
    if (values[key]) lines.push(`${label}:\n${values[key]}`);
  }

  res.json({
    ok: true,
    clipboard: lines.join('\n\n'),
    notice: 'The Hospitable public API does not support writing listing content. Copy the text below and paste each section into Hospitable manually.',
  });
});

// Exported for unit tests (see scripts/test-*.js). Importing this module does NOT
// start the server thanks to the `require.main === module` guard around app.listen.
module.exports = {
  detectHardcodedResponse, draftReply, isParkingQuestion, CONCIERGE_REGEX, isMoneyComplaint,
  pushConvoMsg, recentMsgsByConvo, HOST_AUTHORITY_DIRECTIVE,
  callClaude, decideConciergeIntent, isFrustrated, summarizeOlderTurns, clampManualPrice,
  buildThreadMessages, checkinAlreadySent, fetchMessagesForReservation, fetchReservationsForProperty,
  sendOpenPhoneSms,
  hostRepliedAfterGuest, dispatchPendingReply, pendingReplies,
  // cleaning-schedule (exported for dry-run/tests; no SMS send path is touched)
  buildCleaningEntry, getReservationsForDate, buildScheduleSMS, formatSpanishDate, CLEANING_UNITS,
  buildCleaningScheduleText,
  // legacy-engine kill-switches (exported for tests)
  legacyEngineEnabled, legacyEngineExcluded,
  // security (exported for tests)
  checkApiAuth,
};
