const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// In-memory store (persists while server runs)
// For production you'd swap this for a DB like Supabase
const pendingReplies = new Map(); // id -> { message, reply, timer, status }
const replyLog = [];             // completed/cancelled log (last 100)

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

// ─── Hospitable webhook ───────────────────────────────────────────────────────

app.post('/webhook/hospitable', async (req, res) => {
  res.sendStatus(200); // Always ACK immediately

  const event = req.body;
  const action = event?.action;

  // Only handle incoming guest messages
  if (action !== 'message.created') return;

  const msg = event?.data;
  const senderType = msg?.sender_type || msg?.attributes?.sender_type;
  if (senderType === 'host') return; // Don't reply to our own messages

  const conversationId = msg?.conversation_id || msg?.relationships?.conversation?.data?.id;
  const guestName = msg?.guest_name || msg?.attributes?.guest_name || 'Guest';
  const messageBody = msg?.body || msg?.attributes?.body || '';
  const propertyName = msg?.property_name || msg?.attributes?.property_name || 'your listing';

  if (!conversationId || !messageBody) return;

  console.log(`[webhook] New message from ${guestName}: "${messageBody.slice(0, 80)}..."`);

  try {
    const draftedReply = await draftReply(guestName, messageBody, propertyName);
    scheduleReply(conversationId, guestName, messageBody, draftedReply, propertyName);
  } catch (err) {
    console.error('[webhook] Error drafting reply:', err.message);
  }
});

// ─── Claude reply drafting ────────────────────────────────────────────────────

async function draftReply(guestName, messageBody, propertyName) {
  const systemPrompt = `You are ${HOST_SETTINGS.name}, an Airbnb host with a ${HOST_SETTINGS.tone} communication style.
Property: ${propertyName}
Check-in: ${HOST_SETTINGS.checkin}
Check-out: ${HOST_SETTINGS.checkout}
House rules: ${HOST_SETTINGS.houseRules}
${HOST_SETTINGS.extraContext ? 'Additional context: ' + HOST_SETTINGS.extraContext : ''}

Guidelines:
- Keep replies concise and helpful (2-4 sentences)
- Answer the guest's specific question directly
- Be warm but not over-the-top
- Don't use generic phrases like "Great question!"
- Never make up information you don't have — say you'll check and get back to them
- No sign-off or signature needed`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Guest ${guestName} says: "${messageBody}"` }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ─── Reply scheduling ─────────────────────────────────────────────────────────

function scheduleReply(conversationId, guestName, originalMessage, draftedReply, propertyName) {
  const id = crypto.randomUUID();
  const delayMs = HOST_SETTINGS.delayMinutes * 60 * 1000;
  const sendAt = Date.now() + delayMs;

  const entry = {
    id,
    conversationId,
    guestName,
    propertyName,
    originalMessage,
    draftedReply,
    editedReply: draftedReply,
    status: 'pending',
    createdAt: Date.now(),
    sendAt,
  };

  const timer = setTimeout(async () => {
    const current = pendingReplies.get(id);
    if (!current || current.status !== 'pending') return;
    current.status = 'sending';
    try {
      await sendToHospitable(current.conversationId, current.editedReply);
      current.status = 'sent';
      console.log(`[scheduler] Sent reply to ${current.guestName}`);
    } catch (err) {
      current.status = 'failed';
      current.error = err.message;
      console.error(`[scheduler] Failed to send to ${current.guestName}:`, err.message);
    }
    replyLog.unshift({ ...current });
    if (replyLog.length > 100) replyLog.pop();
    pendingReplies.delete(id);
  }, delayMs);

  entry.timer = timer;
  pendingReplies.set(id, entry);
  console.log(`[scheduler] Reply queued for ${guestName} — sends in ${HOST_SETTINGS.delayMinutes} min (id: ${id})`);
}

// ─── Send via Hospitable API ──────────────────────────────────────────────────

async function sendToHospitable(conversationId, body) {
  const res = await fetch(`https://public.api.hospitable.com/v2/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.HOSPITABLE_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ data: { attributes: { body } } }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Hospitable API ${res.status}: ${err}`);
  }
  return res.json();
}

// ─── Dashboard API ────────────────────────────────────────────────────────────

// Get all pending + recent log
app.get('/api/queue', (req, res) => {
  const pending = Array.from(pendingReplies.values()).map(e => ({
    id: e.id,
    guestName: e.guestName,
    propertyName: e.propertyName,
    originalMessage: e.originalMessage,
    draftedReply: e.draftedReply,
    editedReply: e.editedReply,
    status: e.status,
    createdAt: e.createdAt,
    sendAt: e.sendAt,
  }));
  res.json({ pending, log: replyLog.slice(0, 50), settings: { ...HOST_SETTINGS, autosend: HOST_SETTINGS.autosend } });
});

// Cancel a pending reply
app.post('/api/cancel/:id', (req, res) => {
  const entry = pendingReplies.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  clearTimeout(entry.timer);
  entry.status = 'cancelled';
  replyLog.unshift({ ...entry });
  if (replyLog.length > 100) replyLog.pop();
  pendingReplies.delete(req.params.id);
  console.log(`[dashboard] Reply to ${entry.guestName} cancelled`);
  res.json({ ok: true });
});

// Edit + reschedule a pending reply
app.post('/api/edit/:id', (req, res) => {
  const entry = pendingReplies.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const { reply } = req.body;
  if (!reply) return res.status(400).json({ error: 'reply required' });
  entry.editedReply = reply;
  res.json({ ok: true });
});

// Send immediately (skip delay)
app.post('/api/send-now/:id', async (req, res) => {
  const entry = pendingReplies.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  clearTimeout(entry.timer);
  entry.status = 'sending';
  try {
    await sendToHospitable(entry.conversationId, entry.editedReply);
    entry.status = 'sent';
    replyLog.unshift({ ...entry });
    if (replyLog.length > 100) replyLog.pop();
    pendingReplies.delete(entry.id);
    res.json({ ok: true });
  } catch (err) {
    entry.status = 'failed';
    entry.error = err.message;
    res.status(500).json({ error: err.message });
  }
});

// Manual reply to any conversation
app.post('/api/manual-reply', async (req, res) => {
  const { conversationId, body } = req.body;
  if (!conversationId || !body) return res.status(400).json({ error: 'conversationId and body required' });
  try {
    await sendToHospitable(conversationId, body);
    replyLog.unshift({ id: crypto.randomUUID(), guestName: 'Manual', originalMessage: '(manual)', editedReply: body, status: 'sent', createdAt: Date.now() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, pending: pendingReplies.size, uptime: process.uptime() }));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏠 Airbnb AutoHost running on port ${PORT}`);
  console.log(`   Webhook: POST /webhook/hospitable`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Reply delay: ${HOST_SETTINGS.delayMinutes} min`);
  console.log(`   Host: ${HOST_SETTINGS.name}\n`);
});
