const express      = require('express');
const crypto       = require('crypto');
const path         = require('path');
const fs           = require('fs');
const nodemailer   = require('nodemailer');
const { Resend }   = require('resend');
const cron         = require('node-cron');
const vault        = require('./vault');

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
app.use('/api/', (req, res, next) => {
  if (!API_SECRET) return next(); // dev mode: skip if not set
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (token !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const pendingReplies = new Map();
const replyLog = [];

// Per-property learned profiles + raw history cache
const propertyProfiles = new Map();  // propertyId -> { profile, learnedAt, propertyName }
const propertyHistory = new Map();   // propertyId -> [{ guest, host, topic }]

// Polling state
const seenMessageIds = new Set(); // dedup between webhook + polling
let knownPropertyIds  = [];       // populated after initAllPropertyProfiles
let pollingSince      = null;     // ISO timestamp — only reply to messages after this

const HOST_SETTINGS = {
  name: process.env.HOST_NAME || 'Your Host',
  tone: process.env.HOST_TONE || 'warm and friendly',
  checkin: process.env.CHECKIN_TIME || '4:00 PM',
  checkout: process.env.CHECKOUT_TIME || '11:00 AM',
  houseRules: process.env.HOUSE_RULES || 'No smoking, no parties, quiet hours after 10pm.',
  extraContext: process.env.EXTRA_CONTEXT || '',
  delayMinutes: parseInt(process.env.REPLY_DELAY_MINUTES || '5'),
  autosend: process.env.AUTOSEND !== 'false',
};

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
    const data = await hospGet(`/reservations/${reservationId}/messages?per_page=20`);
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
    `Here are real message exchanges for the property "${propertyName}". Learn this host's communication style:\n\n${historyText}`
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
    const properties = parseProperties(data);
    knownPropertyIds = properties.map(p => p.id);
    console.log(`[learn] Found ${properties.length} properties — building profiles...`);
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

  // Start hourly demand-based pricing engine (10s after warm-up to avoid startup noise)
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

async function warmUpSeenMessages() {
  if (!knownPropertyIds.length) return;
  console.log('[poll] Warm-up — marking existing inbox messages as seen...');

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
          if (m.created_at && m.created_at > graceCutoff) {
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

      if (msg.created_at && msg.created_at < pollingSince) continue;

      const body = (msg.body || '').trim();
      if (!body) continue;

      const guestName = msg.sender?.full_name || msg.sender?.first_name || 'Guest';
      const tag = resourceType.slice(0, 3);
      console.log(`[poll/${tag}] 📨 "${guestName}" property="${propertyName}" (${resourceId}): "${body.slice(0, 80)}"`);
      console.log(`[poll/${tag}] using profile: ${propertyProfiles.has(propertyId)}`);

      // Concierge/front-desk email side-effect — fires before reply drafting
      if (CONCIERGE_REGEX.test(body)) {
        sendConciergeEmail({ guestName, propertyId, resourceId, resourceType })
          .catch(e => console.error(`[concierge] Email failed: ${e.message}`));
      }

      // Maintenance emergency SMS side-effect — notify host immediately
      if (MAINTENANCE_EMERGENCY_REGEX.test(body)) {
        notifyHost({ guestName, messageBody: body, propertyName })
          .catch(e => console.error(`[maintenance] SMS failed: ${e.message}`));
      }

      try {
        const { reply, confident } = await draftReply(guestName, body, propertyName, propertyId);
        if (!confident || !reply) {
          console.log(`[poll/${tag}] Low confidence — escalated to host, no guest reply`);
          notifyHost({ guestName, messageBody: body, propertyName }).catch(console.error);
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

async function callClaude(systemPrompt, userMsg, maxTokens = 800) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ─── Host notifications ───────────────────────────────────────────────────────

async function notifyHost({ guestName, messageBody, propertyName }) {
  const logLine = `[notify] ⚠ MANUAL REPLY NEEDED — Guest: "${guestName}" | Property: "${propertyName}" | Message: "${messageBody.slice(0, 120)}"`;

  const apiKey  = process.env.QUO_API_KEY;
  const from    = process.env.QUO_FROM_NUMBER;
  const to      = process.env.NOTIFY_PHONE;

  if (!apiKey || !from || !to) {
    console.warn(logLine);
    console.warn('[notify] Set QUO_API_KEY, QUO_FROM_NUMBER, NOTIFY_PHONE to receive SMS alerts.');
    return;
  }

  const smsBody = `⚠ AutoHost: ${guestName} at ${propertyName} needs your reply. Message: "${messageBody.slice(0, 100)}"`;

  try {
    const res = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: [to], from, content: smsBody }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenPhone ${res.status}: ${err}`);
    }
    console.log(`[notify] SMS sent via OpenPhone to ${to} for "${guestName}"`);
  } catch (e) {
    console.error(`[notify] SMS failed (${e.message}) — ${logLine}`);
  }
}

// ─── Hardcoded responses — bypass Claude for common predictable questions ─────

const PARKING_REPLY = `Parking Information – Peachtree Towers

We understand that parking is an important part of planning your trip, and there are several convenient, secure, and affordable parking options located just steps from the building. Most guests find parking quick and easy once they arrive.

Closest & Most Convenient Option

AAA Parking Garage – 17 Baker St NE, Atlanta, GA 30308
- Approximately 1–2 minute walk from the building
- Covered garage, safe and secure
- Generally the most convenient option for guests
- Rates vary based on demand and city events
- Typically has reliable availability except during major downtown events

Additional Nearby Parking Options

Peachtree Center Garage – 161 Peachtree Center Ave
- Approximately 5-minute walk
- Covered and secure
- Typical rates range from $10–$15 per day (may vary)

LAZ Parking – Courtland Street Lots
- Approximately 4–6 minute walk
- Often offers additional availability during busy periods
- Typical rates range from $8–$15 per day (may vary)

Emory / Children's Healthcare Garage
- Approximately 2–3 minute walk
- Clean, well-maintained facility
- Typical rates range from $12–$15 per day (may vary)

Street Parking

Street parking may be available on Peachtree Street, Baker Street, and surrounding blocks.
- Typically $2–$4 per hour
- Limited availability, especially during business hours and events
- Please review posted signage carefully, as some areas have restricted or tow-away zones

Helpful Tip: ParkMobile App

We highly recommend downloading the ParkMobile app before arrival. It allows you to view nearby options, compare real-time pricing, check availability, and extend parking remotely from your phone.

Event & Convention Notice

Downtown Atlanta hosts many major events throughout the year. Parking rates may increase during high-demand periods, including events at Georgia World Congress Center, Mercedes-Benz Stadium, State Farm Arena, Dragon Con, and major conventions, concerts, and sporting events. Arriving earlier in the day can help secure the best rates and availability.

Quick Summary

✓ Several secure parking garages are located within a 1–5 minute walk of the building
✓ The AAA Garage is typically the closest and most convenient option
✓ Street parking is available but limited
✓ ParkMobile is the easiest way to find and manage parking during your stay
✓ Parking is not included with the reservation, but multiple options are available nearby to fit different budgets

If you have any questions before arrival, we're always happy to help point you toward the best option for your stay.

Warm regards,
Cal`;

// ─── Concierge / front-desk access issues ────────────────────────────────────

const CONCIERGE_REGEX = new RegExp(
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
  "|can'?t\\s+get\\s+to\\s+my\\s+floor|elevator\\s+requires\\s+a\\s+key" +
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
  // Compound: location word + access-denial word anywhere in the message
  "|(?=[\\s\\S]*(?:desk|lobby|reception))(?=[\\s\\S]*(?:can'?t|unable|no\\s+reservation|won'?t|wont|not\\s+letting))",
  "i"
);

const MAINTENANCE_EMERGENCY_REGEX = /water\s+leak|no\s+hot\s+water|smoke\s+alarm|fire\s+alarm|flood(ing)?|no\s+electricity|power\s+(is\s+)?out/i;

async function getActiveReservation(propertyId) {
  if (!propertyId) return null;
  try {
    const data = await hospGet(
      `/reservations?properties[]=${propertyId}&status[]=accepted&status[]=checked_in&per_page=5&include=guest`
    );
    const reservations = parseReservations(data);
    const today = new Date().toISOString().slice(0, 10);
    return (
      reservations.find(r => {
        const ci = (r.check_in  || r.checkin  || '').slice(0, 10);
        const co = (r.check_out || r.checkout || '').slice(0, 10);
        return ci && co && ci <= today && co >= today;
      }) ||
      reservations[0] ||
      null
    );
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

  const subject = `Check-In Info for Guest in ${unitLabel} | ${checkIn} - ${checkOut}`;
  const body = `Hi,

Please allow ${guestName} to access unit ${unitLabel}.

Guest Name: ${guestName}
Unit: ${unitLabel}
Check-In: ${checkIn} at 4:00 PM
Check-Out: ${checkOut}

Please grant this guest full access to the unit for the duration of their stay.

Thank you,
Yasser Khan
Peachtree Tower Rentals`;

  const to = process.env.CONCIERGE_EMAIL_TO || '300ptconcierge@gmail.com';
  console.log(`[concierge] Sending email — unit=${unitLabel} guest="${guestName}" to=${to}`);

  const resendKey  = process.env.RESEND_API_KEY;
  const gmailUser  = process.env.GMAIL_USER;
  const gmailPass  = process.env.GMAIL_APP_PASSWORD;

  if (!resendKey && !gmailUser) {
    console.warn('[concierge] No email credentials set — logging email only');
    console.warn(`[concierge] TO: ${to} | SUBJECT: ${subject}`);
    console.warn(`[concierge] BODY:\n${body}`);
    return;
  }

  try {
    if (resendKey) {
      // Resend HTTP API — works on Railway (no outbound SMTP port required)
      const resend = new Resend(resendKey);
      const from   = process.env.RESEND_FROM || `Peachtree Tower Rentals <${gmailUser || 'cal@peachtreestayatl.com'}>`;
      const result = await resend.emails.send({ from, to, subject, text: body });
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
    await transporter.sendMail({ from: gmailUser, to, subject, text: body });
    console.log(`[concierge] ✓ Email sent via SMTP to ${to} for ${guestName} in ${unitLabel}`);
  } catch (e) {
    // Don't fail silently: if the front-desk email can't be delivered, alert the host
    // by SMS so a human can call the front desk and authorize access manually.
    console.error(`[concierge] ✗ Email FAILED to ${to}: ${e.message} — escalating to host SMS`);
    await notifyHost({
      guestName,
      messageBody: `FRONT-DESK EMAIL FAILED for unit ${unitLabel} (${e.message.slice(0, 80)}). Please call the front desk to authorize this guest's access.`,
      propertyName: unitLabel,
    });
    throw e;
  }
}

function detectHardcodedResponse(guestName, messageBody) {
  const b = messageBody.toLowerCase();
  const name = (guestName || 'there').split(' ')[0]; // first name only

  // Front desk / building access — highest priority, fires before everything else
  if (CONCIERGE_REGEX.test(b)) {
    return {
      confident: true,
      reply: `Hi ${name}, thanks for letting us know! A form was sent out this morning — I've also just emailed the front desk a supplementary email with your check-in information. Please let the front desk know that an email has been sent to them and to check their email — they should have everything they need to let you up right away. If you have any further trouble, reply here immediately and I'll call them directly. Welcome! 😊`,
    };
  }

  // Lockout / key not working — second-highest priority after concierge
  if (/locked\s+out|key\s+doesn'?t\s+work|can'?t\s+open\s+the\s+door|lock\s+isn'?t\s+working|fob\s+stopped/.test(b)) {
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

  // Parking
  if (/\bpark(ing)?\b/.test(b)) {
    return { confident: true, reply: PARKING_REPLY };
  }

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

async function draftReply(guestName, messageBody, propertyName, propertyId) {
  // Short-circuit for common questions with exact hardcoded answers
  const hardcoded = detectHardcodedResponse(guestName, messageBody);
  if (hardcoded) {
    console.log(`[draft] Hardcoded match for: "${messageBody.slice(0, 60)}"`);
    return hardcoded;
  }

  const profileData = propertyProfiles.get(propertyId);
  const examples = propertyId ? findSimilarExamples(propertyId, messageBody) : [];
  const vaultEntry = propertyId ? vault.getVaultEntry(propertyId)?.master : null;

  let systemPrompt;

  const JSON_INSTRUCTIONS = `
You MUST respond with a single valid JSON object — no markdown fences, no reasoning text, no extra text before or after:
{
  "confident": true or false,
  "reply": "the message to send the guest"
}

Confidence rules:
- Set "confident": true when you can answer fully from the information provided.
- Set "confident": false when you genuinely don't know the answer (e.g. specific codes, policies not in your context, third-party details).
- NEVER invent facts. If unsure, set "confident": false and set "reply" to "".

Common questions you CAN always answer confidently (set "confident": true):
- Age requirement: Minimum age is 26; exceptions considered with travel details.
- Towel or linen requests: Fresh towels are in the closet and dressers; cleaning team can bring extras.
- Early check-in requests: Available from 1:00 PM for a $45 fee; confirm availability and send payment request.
- Late checkout requests: Available until 1:30 PM for a $45 fee; confirm availability and send payment request.
- Heating/cooling/thermostat: Radiation unit under each window; press back two corners of the square panel on top.
- WiFi password: Use the wifi name and password from the PROPERTY DETAILS section above. If not listed, set "confident": false.
- Parking questions: Send the full Peachtree Towers parking guide (AAA Garage on Baker St is closest).

Reply style rules:
- Open with a brief warm greeting (e.g. "Hi [Name]!"), then immediately answer the question.
- Do NOT lead with check-in details, house rules, or unrelated information unless the guest asked.
- Be concise (2–4 sentences) unless the question genuinely needs more.
- No sign-off or signature.`;

  if (profileData?.profile) {
    const exampleBlock = examples.length
      ? `\nRelevant past exchanges for style reference:\n` +
        examples.map(e => `Guest: "${e.guest}"\nYour past reply: "${e.host}"`).join('\n\n')
      : '';

    systemPrompt = `You are ${HOST_SETTINGS.name}, an Airbnb host replying to a guest at "${propertyName}".

HOST COMMUNICATION PROFILE (learned from real messages — match this style precisely):
${profileData.profile}

PROPERTY DETAILS:
- Check-in: ${HOST_SETTINGS.checkin}
- Check-out: ${HOST_SETTINGS.checkout}
- House rules: ${HOST_SETTINGS.houseRules}
${HOST_SETTINGS.extraContext ? `- Extra context: ${HOST_SETTINGS.extraContext}` : ''}
${vaultEntry?.guest_access ? `- Guest access / WiFi: ${vaultEntry.guest_access}` : ''}
${vaultEntry?.getting_around ? `- Parking / getting around: ${vaultEntry.getting_around}` : ''}
${vaultEntry?.customNotes ? `- Additional notes: ${vaultEntry.customNotes}` : ''}
${exampleBlock}
${JSON_INSTRUCTIONS}`;
  } else {
    systemPrompt = `You are ${HOST_SETTINGS.name}, an Airbnb host with a ${HOST_SETTINGS.tone} communication style.

Property: ${propertyName}
Check-in: ${HOST_SETTINGS.checkin} | Check-out: ${HOST_SETTINGS.checkout}
House rules: ${HOST_SETTINGS.houseRules}
${HOST_SETTINGS.extraContext ? `Context: ${HOST_SETTINGS.extraContext}` : ''}
${vaultEntry?.guest_access ? `Guest access / WiFi: ${vaultEntry.guest_access}` : ''}
${vaultEntry?.getting_around ? `Parking / getting around: ${vaultEntry.getting_around}` : ''}
${vaultEntry?.customNotes ? `Additional notes: ${vaultEntry.customNotes}` : ''}
${JSON_INSTRUCTIONS}`;
  }

  const raw = await callClaude(systemPrompt, `Guest ${guestName} says: "${messageBody}"`, 600);

  try {
    // Extract just the JSON object — ignore any reasoning text before or after it
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON object found');
    const parsed = JSON.parse(jsonMatch[0]);
    const reply = (parsed.reply || '').trim();
    const confident = parsed.confident !== false && reply.length > 0;
    return { reply: reply || null, confident };
  } catch (e) {
    console.warn('[draft] Claude returned non-JSON — escalating to host. Raw:', raw.slice(0, 120));
    return { reply: null, confident: false };
  }
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
  if (senderRole === 'host' || senderRole === 'co-host' || senderRole === 'teammate') {
    console.log(`[webhook] sender_role="${senderRole}" — ignoring`);
    return;
  }

  const conversationId = msg.conversation_id;
  const messageBody    = (msg.body || '').trim();
  const guestName      = msg.sender?.full_name || msg.sender?.first_name || 'Guest';
  const reservationId  = msg.reservation_id || null;
  const inquiryId      = msg.inquiry_id     || null;

  console.log(`[webhook] ✉ from="${guestName}" sender_role="${senderRole}" reservation="${reservationId}" inquiry="${inquiryId}" convo="${conversationId}"`);
  console.log(`[webhook] body: "${messageBody.slice(0, 120)}"`);

  if (!messageBody) { console.log('[webhook] empty body — ignoring'); return; }

  // Determine the resource ID to use for sending the reply.
  // Reservations  → POST /reservations/{id}/messages
  // Inquiries     → POST /inquiries/{id}/messages  (Hospitable added Sept 2024)
  // Neither       → log and bail; we don't know where to send
  const replyResourceId   = reservationId || inquiryId || null;
  const replyResourceType = reservationId ? 'reservation' : inquiryId ? 'inquiry' : null;

  if (!replyResourceId) {
    console.warn('[webhook] No reservation_id or inquiry_id — cannot send reply. Full payload logged above.');
    return;
  }

  // Dedup against poller — MUST use the exact same key formula as the poller
  // (messageKey) so a message arriving via BOTH the webhook and the 60s poll is
  // handled exactly once. (Previously the webhook prefixed the resourceType,
  // producing a different key → every message was answered twice → 429s.)
  const dedupKey = messageKey(replyResourceId, msg);
  if (seenMessageIds.has(dedupKey)) {
    console.log('[webhook] Already seen (poller got it first) — skipping');
    return;
  }
  seenMessageIds.add(dedupKey);

  // Fetch property info from reservation (inquiries may not have property context)
  let propertyId   = null;
  let propertyName = 'your listing';
  if (reservationId) {
    try {
      const resData = await hospGet(`/reservations/${reservationId}?include=properties`);
      const r    = resData.data || resData;
      // Log the raw shape so we can see exactly what include=properties returns
      console.log('[webhook] reservation lookup keys:', Object.keys(r).join(', '));
      console.log('[webhook] reservation properties field:', JSON.stringify(r.properties || r.property || 'missing'));
      const prop = r.properties?.[0] || r.property || null;
      propertyId   = prop?.id || null;
      propertyName = prop?.public_name || prop?.name || 'your listing';
      console.log(`[webhook] resolved property="${propertyName}" id=${propertyId}`);
      console.log(`[webhook] propertyProfiles has this id: ${propertyProfiles.has(propertyId)}`);
      console.log(`[webhook] known profile ids: ${[...propertyProfiles.keys()].join(', ')}`);
    } catch (e) {
      console.warn(`[webhook] Could not fetch reservation for property info: ${e.message}`);
    }
  }

  if (propertyId && !propertyProfiles.has(propertyId)) {
    learnPropertyProfile(propertyId, propertyName).catch(console.error);
  }

  // Concierge/front-desk email side-effect
  if (CONCIERGE_REGEX.test(messageBody)) {
    sendConciergeEmail({ guestName, propertyId, resourceId: replyResourceId, resourceType: replyResourceType })
      .catch(e => console.error(`[concierge] Email failed: ${e.message}`));
  }

  try {
    const { reply, confident } = await draftReply(guestName, messageBody, propertyName, propertyId);
    if (!confident || !reply) {
      console.log(`[webhook] Low confidence — escalated to host, no guest reply`);
      notifyHost({ guestName, messageBody, propertyName }).catch(console.error);
    } else {
      scheduleReply(replyResourceId, guestName, messageBody, reply, propertyName, propertyId, replyResourceType);
      console.log(`[webhook] ✓ Reply scheduled via ${replyResourceType} ${replyResourceId}`);
    }
  } catch (err) {
    console.error('[webhook] Error drafting reply:', err.message);
  }
});

// ─── Scheduling ───────────────────────────────────────────────────────────────

function scheduleReply(resourceId, guestName, originalMessage, draftedReply, propertyName, propertyId, resourceType = 'reservation') {
  const id = crypto.randomUUID();
  const delayMs = HOST_SETTINGS.delayMinutes * 60 * 1000;
  const sendAt = Date.now() + delayMs;

  const entry = {
    id, resourceId, resourceType, guestName, propertyName, propertyId,
    originalMessage, draftedReply, editedReply: draftedReply,
    status: 'pending', createdAt: Date.now(), sendAt,
    usedProfile: propertyProfiles.has(propertyId),
  };

  const timer = setTimeout(async () => {
    const current = pendingReplies.get(id);
    if (!current || current.status !== 'pending') return;
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
  }, delayMs);

  entry.timer = timer;
  pendingReplies.set(id, entry);
  console.log(`[scheduler] Reply queued for ${guestName} — sends in ${HOST_SETTINGS.delayMinutes}min`);
}

async function sendToHospitable(resourceId, body, resourceType = 'reservation') {
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
  res.json({ ok: true });
});

app.post('/api/edit/:id', (req, res) => {
  const entry = pendingReplies.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const { reply } = req.body;
  if (!reply) return res.status(400).json({ error: 'reply required' });
  entry.editedReply = reply;
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

  const calDays = updates.map(u => ({
    date: u.date,
    price: { amount: Math.round(u.price * 100) },
    ...(u.min_stay != null && { min_stay: u.min_stay }),
  }));

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

  const results = [];
  for (const id of targetIds) {
    try {
      await hospPut(`/properties/${id}/calendar`, calDays);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 200));
  }

  res.json({ updated: results.filter(r => r.ok).length, total: results.length, results });
});


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
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
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

// Fetch ALL reservations for a property (no status filter) matching a specific date
async function getReservationsForDate(propertyId, dateStr) {
  try {
    const data = await hospGet(
      `/reservations?properties[]=${propertyId}&per_page=50&include=guest`
    );
    const reservations = parseReservations(data);
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

// PRIMARY detection: calendar-based occupancy check.
//
// Rules:
//   needsCleaning:      priorDay is RESERVED (not just USER-blocked) AND targetDay is free
//   hasSameDayIncoming: cleaning needed AND the reservations API confirms a new check-in on targetDate
//
// Why filter on reason==="RESERVED":
//   - "RESERVED" = Airbnb guest booked → cleaning needed after departure
//   - "BLOCKED" + source_type="USER" = host manually blocked, no guest → no cleaning needed
//
// Why use reservations to confirm back-to-back (not just calendar):
//   - Two consecutive RESERVED days could be the same multi-night guest (no checkout yet)
//     or two different guests (back-to-back). The calendar alone cannot distinguish them.
async function getCalendarOccupancy(propertyId, targetDate) {
  const priorDate = dateOffset(targetDate, -1);
  try {
    const data = await hospGet(
      `/properties/${propertyId}/calendar?start_date=${priorDate}&end_date=${targetDate}`
    );
    const days = data?.data?.days || data?.days || (Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []));
    const dayMap = Object.fromEntries(days.map(d => [d.date, d]));

    const priorDay  = dayMap[priorDate];
    const targetDay = dayMap[targetDate];

    const priorReason    = priorDay?.status?.reason;
    const targetAvailable = targetDay?.status?.available;

    console.log(`[cleaning] ${propertyId.slice(0,8)}… calendar prior(${priorDate}): reason=${priorReason} avail=${priorDay?.status?.available} | target(${targetDate}): reason=${targetDay?.status?.reason} avail=${targetAvailable}`);

    // Only flag cleaning if prior night had an actual RESERVATION (not a manual USER block)
    const needsCleaning = priorReason === 'RESERVED' && targetAvailable !== false;

    return { needsCleaning };
  } catch (e) {
    console.error(`[cleaning] Calendar lookup FAILED for ${propertyId}: ${e.message}`);
    return { needsCleaning: false };
  }
}

async function buildCleaningEntry(unit, tomorrow) {
  // Step 1: calendar confirms a guest checked out this morning
  const { needsCleaning } = await getCalendarOccupancy(unit.id, tomorrow);
  if (!needsCleaning) return null;

  // Step 2: reservations API for enrichment — late checkout/early check-in message analysis
  // and to detect same-day incoming guest (back-to-back)
  const { outgoing, incoming } = await getReservationsForDate(unit.id, tomorrow);

  // Back-to-back confirmed only if the reservations API has an actual incoming check-in today
  const hasSameDayIncoming = incoming.length > 0;

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
  const vacPart  = `disponible desde las ${entry.vacancyTime}${entry.vacancyConfirmed ? ' ✅' : ''}`;
  if (!entry.deadlineTime) return `• ${entry.label} — ${vacPart}`;
  const deadPart = `lista para las ${entry.deadlineTime}${entry.deadlineConfirmed ? ' ✅' : ''}`;
  return `• ${entry.label} — ${deadPart}, ${vacPart}`;
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

  let smsBody;
  if (entries.length === 0) {
    smsBody = `🧹 Sin limpiezas — ${spanishDate}\n— Peachtree Tower Rentals`;
  } else {
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

    smsBody = `🧹 Limpieza — ${spanishDate}\n\n${lines.join('\n')}\n\n— Peachtree Tower Rentals`;
  }

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

  const allOk = results.every(r => r.ok);
  return { ok: allOk, smsBody, entries: entries.length, recipients: results };
}

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
app.listen(PORT, () => {
  console.log(`\n🏠 Airbnb AutoHost running on port ${PORT}`);
  console.log(`   Host: ${HOST_SETTINGS.name} | Delay: ${HOST_SETTINGS.delayMinutes}min\n`);
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
});

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
