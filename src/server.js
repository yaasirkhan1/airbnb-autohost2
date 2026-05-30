const express = require('express');
const crypto = require('crypto');
const path = require('path');
const vault = require('./vault');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

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
  checkin: process.env.CHECKIN_TIME || '3:00 PM',
  checkout: process.env.CHECKOUT_TIME || '11:00 AM',
  houseRules: process.env.HOUSE_RULES || 'No smoking, no parties, quiet hours after 10pm.',
  extraContext: process.env.EXTRA_CONTEXT || '',
  delayMinutes: parseInt(process.env.REPLY_DELAY_MINUTES || '5'),
  autosend: process.env.AUTOSEND !== 'false',
};

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
      await new Promise(r => setTimeout(r, 1500));
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

  // Start polling after warm-up so only truly new messages trigger replies
  pollingSince = toHospitableDate(new Date());
  setInterval(pollForNewMessages, 60 * 1000);
  console.log(`[poll] Polling started — checking every 60s (since ${pollingSince})`);
}

async function warmUpSeenMessages() {
  if (!knownPropertyIds.length) return;
  console.log('[poll] Warm-up — marking existing inbox messages as seen...');
  // Fetch recent reservations (default window = next 2 weeks per spec)
  // properties[] is a required param on GET /reservations
  const qs = buildPropertyQs();
  const data = await hospGet(`/reservations?${qs}&per_page=50&include=guest`);
  const reservations = parseReservations(data);
  console.log(`[poll] Warm-up: found ${reservations.length} reservations to scan`);
  for (const r of reservations) {
    try {
      const msgData = await hospGet(`/reservations/${r.id}/messages?per_page=20`);
      const messages = parseMessages(msgData);
      for (const m of messages) seenMessageIds.add(messageKey(r.id, m));
    } catch (e) {
      console.warn(`[poll] Warm-up: could not fetch messages for reservation ${r.id}: ${e.message}`);
    }
  }
  console.log(`[poll] Warm-up done — ${seenMessageIds.size} existing messages marked seen`);
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
    const data  = await hospGet(`/reservations?${qs}&last_message_at=${encodeURIComponent(since)}&per_page=50`);
    const reservations = parseReservations(data);

    if (reservations.length) {
      console.log(`[poll/res] ${reservations.length} reservation(s) with recent messages`);
    }

    for (const reservation of reservations) {
      await processNewMessages(
        reservation.id,
        'reservation',
        `/reservations/${reservation.id}/messages?per_page=10`,
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

async function pollInquiryMessages() {
  if (inquiriesUnavailable) return;

  try {
    const since = toHospitableDate(new Date(Date.now() - 90 * 1000));
    const data  = await hospGet(`/inquiries?last_message_at=${encodeURIComponent(since)}&per_page=50`);
    const inquiries = parseInquiries(data);

    if (inquiries.length) {
      console.log(`[poll/inq] ${inquiries.length} inquir${inquiries.length === 1 ? 'y' : 'ies'} with recent messages`);
    }

    for (const inquiry of inquiries) {
      await processNewMessages(
        inquiry.id,
        'inquiry',
        `/inquiries/${inquiry.id}/messages?per_page=10`,
      );
    }
  } catch (e) {
    if (e.message.includes('404') || e.message.includes('403')) {
      inquiriesUnavailable = true;
      console.log(`[poll/inq] Inquiry endpoint unavailable (${e.message.split(':')[0]}) — skipping in future polls. To enable: contact team-platform@hospitable.com for inquiry:read scope.`);
    } else {
      console.error('[poll/inq] Error:', e.message);
    }
  }
}

async function processNewMessages(resourceId, resourceType, messagesPath) {
  try {
    const msgData = await hospGet(messagesPath);
    const messages = parseMessages(msgData);

    for (const msg of messages) {
      if (msg.sender_type !== 'guest') continue;

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
      console.log(`[poll/${resourceType.slice(0, 3)}] 📨 "${guestName}" (${resourceId}): "${body.slice(0, 80)}"`);

      try {
        const draft = await draftReply(guestName, body, 'your listing', null);
        // Both reservations and inquiries use the same resourceId for sending
        scheduleReply(resourceId, guestName, body, draft, 'your listing', null);
      } catch (e) {
        console.error(`[poll/${resourceType.slice(0, 3)}] Error drafting reply: ${e.message}`);
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
      model: 'claude-sonnet-4-6',
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
  const profileData = propertyProfiles.get(propertyId);
  const examples = propertyId ? findSimilarExamples(propertyId, messageBody) : [];

  let systemPrompt;

  if (profileData?.profile) {
    // Rich profile from learned history
    const exampleBlock = examples.length
      ? `\nHere are similar past exchanges to use as style reference:\n` +
        examples.map(e => `Guest: "${e.guest}"\nYour past reply: "${e.host}"`).join('\n\n')
      : '';

    systemPrompt = `You are ${HOST_SETTINGS.name}, an Airbnb host replying to a guest at "${propertyName}".

You have learned this host's communication style from their real message history. Match it precisely.

HOST PROFILE (learned from real messages):
${profileData.profile}

PROPERTY DETAILS (use these facts):
- Check-in: ${HOST_SETTINGS.checkin}
- Check-out: ${HOST_SETTINGS.checkout}
- House rules: ${HOST_SETTINGS.houseRules}
- Extra context: ${HOST_SETTINGS.extraContext}
${exampleBlock}

Instructions:
- Reply in the exact style shown in the profile and examples
- Be concise (2-4 sentences) unless the question genuinely needs more
- Answer the guest's specific question directly
- Never make up information you don't have
- No sign-off or signature needed`;
  } else {
    // Fallback to variable-based prompt if no profile yet
    systemPrompt = `You are ${HOST_SETTINGS.name}, an Airbnb host with a ${HOST_SETTINGS.tone} communication style.
Property: ${propertyName}
Check-in: ${HOST_SETTINGS.checkin} | Check-out: ${HOST_SETTINGS.checkout}
House rules: ${HOST_SETTINGS.houseRules}
${HOST_SETTINGS.extraContext ? 'Context: ' + HOST_SETTINGS.extraContext : ''}
Keep replies concise (2-4 sentences). Answer directly. Never make up information.`;
  }

  return callClaude(systemPrompt, `Guest ${guestName} says: "${messageBody}"`, 500);
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

app.post('/webhook/hospitable', async (req, res) => {
  // Always 200 first so Hospitable doesn't retry
  res.sendStatus(200);

  // Log the full raw payload immediately — visible in Railway logs regardless of what follows
  console.log('[webhook] Received payload:', JSON.stringify(req.body, null, 2));

  const event = req.body;

  // Validate action
  if (!event?.action) {
    console.log('[webhook] Ignored — no action field. Full body logged above.');
    return;
  }
  if (event.action !== 'message.created') {
    console.log(`[webhook] Ignored — action is "${event.action}", expected "message.created"`);
    return;
  }

  // Message schema (per Hospitable OpenAPI spec):
  // { conversation_id, body, sender_type, sender: { full_name, first_name }, ... }
  const msg = event.data;
  if (!msg) {
    console.log('[webhook] Ignored — event.data is empty');
    return;
  }

  const senderType = msg.sender_type;
  if (senderType === 'host') {
    console.log('[webhook] Ignored — sender_type is host');
    return;
  }

  const conversationId = msg.conversation_id;
  const messageBody    = msg.body || '';
  const guestName      = msg.sender?.full_name || msg.sender?.first_name || 'Guest';

  if (!conversationId) { console.log('[webhook] Ignored — no conversation_id'); return; }
  if (!messageBody)    { console.log('[webhook] Ignored — empty message body'); return; }

  // reservation_id is needed for POST /reservations/{id}/messages (the send endpoint)
  const reservationId = msg.reservation_id || null;
  console.log(`[webhook] ✉ Guest "${guestName}" | reservation=${reservationId} | convo=${conversationId} | "${messageBody.slice(0, 100)}"`);

  if (!reservationId) {
    console.warn('[webhook] No reservation_id on message — cannot send reply (inquiry before booking?)');
    return;
  }

  // Mark as seen so the poller doesn't double-process this message
  const wKey = messageKey(reservationId, msg);
  if (seenMessageIds.has(wKey)) {
    console.log('[webhook] Already seen this message (poller got it first) — skipping');
    return;
  }
  seenMessageIds.add(wKey);

  // Fetch reservation to get property info (/conversations endpoint does not exist in v2 API)
  let propertyId   = null;
  let propertyName = 'your listing';
  try {
    const resData = await hospGet(`/reservations/${reservationId}?include=properties`);
    const res = resData.data || resData;
    const prop = res.properties?.[0] || res.property || null;
    propertyId   = prop?.id   || null;
    propertyName = prop?.public_name || prop?.name || 'your listing';
    console.log(`[webhook] Property: "${propertyName}" (${propertyId})`);
  } catch (e) {
    console.warn(`[webhook] Could not fetch reservation for property info: ${e.message}`);
  }

  // Kick off profile learning for unknown properties (non-blocking)
  if (propertyId && !propertyProfiles.has(propertyId)) {
    console.log(`[learn] No profile yet for "${propertyName}" — learning in background`);
    learnPropertyProfile(propertyId, propertyName).catch(console.error);
  }

  try {
    const draftedReply = await draftReply(guestName, messageBody, propertyName, propertyId);
    scheduleReply(reservationId, guestName, messageBody, draftedReply, propertyName, propertyId);
    console.log(`[webhook] ✓ Reply scheduled for "${guestName}" on reservation ${reservationId}`);
  } catch (err) {
    console.error('[webhook] Error drafting reply:', err.message);
  }
});

// ─── Scheduling ───────────────────────────────────────────────────────────────

function scheduleReply(reservationId, guestName, originalMessage, draftedReply, propertyName, propertyId) {
  const id = crypto.randomUUID();
  const delayMs = HOST_SETTINGS.delayMinutes * 60 * 1000;
  const sendAt = Date.now() + delayMs;

  const entry = {
    id, reservationId, guestName, propertyName, propertyId,
    originalMessage, draftedReply, editedReply: draftedReply,
    status: 'pending', createdAt: Date.now(), sendAt,
    usedProfile: propertyProfiles.has(propertyId),
  };

  const timer = setTimeout(async () => {
    const current = pendingReplies.get(id);
    if (!current || current.status !== 'pending') return;
    current.status = 'sending';
    try {
      await sendToHospitable(current.reservationId, current.editedReply);
      current.status = 'sent';
      console.log(`[scheduler] ✓ Sent reply to ${current.guestName} on reservation ${current.reservationId}`);
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

async function sendToHospitable(reservationId, body) {
  // Endpoint per Hospitable OpenAPI spec: POST /reservations/{uuid}/messages
  // Body per spec: { body: string } — flat, no data.attributes wrapper
  const url = `https://public.api.hospitable.com/v2/reservations/${reservationId}/messages`;
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
    id: e.id, reservationId: e.reservationId, guestName: e.guestName,
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
    await sendToHospitable(entry.reservationId, entry.editedReply);
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

app.get('/health', (req, res) => res.json({
  ok: true,
  pending: pendingReplies.size,
  profilesLoaded: propertyProfiles.size,
  uptime: Math.floor(process.uptime()),
  polling: { active: !!pollingSince, since: pollingSince, propertiesLoaded: knownPropertyIds.length, seenMessages: seenMessageIds.size },
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
      HOSPITABLE_API_KEY: !!process.env.HOSPITABLE_API_KEY,
      ANTHROPIC_API_KEY:  !!process.env.ANTHROPIC_API_KEY,
      HOST_NAME:          process.env.HOST_NAME || '(not set)',
      REPLY_DELAY_MINUTES: HOST_SETTINGS.delayMinutes,
      AUTOSEND:           HOST_SETTINGS.autosend,
    },
    queue: {
      pending: pendingReplies.size,
      profilesLoaded: propertyProfiles.size,
    },
  });
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
    const draft = await draftReply(guestName, messageBody, 'Test Property', null);
    scheduleReply(conversationId, guestName, messageBody, draft, 'Test Property', null);
    res.json({ ok: true, draft, conversationId });
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
