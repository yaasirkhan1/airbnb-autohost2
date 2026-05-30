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

async function fetchConversationsForProperty(propertyId, limit = 40) {
  try {
    const data = await hospGet(`/conversations?filter[property_id]=${propertyId}&per_page=${limit}&include=messages`);
    return data.data || [];
  } catch (e) {
    console.error(`[learn] Could not fetch conversations for ${propertyId}:`, e.message);
    return [];
  }
}

async function fetchMessagesForConversation(conversationId) {
  try {
    const data = await hospGet(`/conversations/${conversationId}/messages?per_page=20`);
    return data.data || [];
  } catch (e) {
    return [];
  }
}

async function learnPropertyProfile(propertyId, propertyName) {
  console.log(`[learn] Building profile for property: ${propertyName} (${propertyId})`);

  const conversations = await fetchConversationsForProperty(propertyId, 40);
  if (!conversations.length) {
    console.log(`[learn] No conversations found for ${propertyName}`);
    return null;
  }

  // Build Q&A pairs from history
  const pairs = [];
  for (const convo of conversations.slice(0, 25)) {
    const convoId = convo.id;
    const messages = await fetchMessagesForConversation(convoId);
    let lastGuest = null;
    for (const msg of messages) {
      const sender = msg.attributes?.sender_type || msg.sender_type;
      const body = msg.attributes?.body || msg.body || '';
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
    console.log(`[learn] Found ${properties.length} properties — building profiles...`);
    for (const p of properties) {
      const id = p.id;
      const name = p.public_name || p.name || id;
      await learnPropertyProfile(id, name);
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log('[learn] ✅ All property profiles ready');
  } catch (e) {
    console.error('[learn] Failed to init profiles:', e.message);
  }
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
  res.sendStatus(200);
  const event = req.body;
  if (event?.action !== 'message.created') return;

  const msg = event?.data;
  const senderType = msg?.sender_type || msg?.attributes?.sender_type;
  if (senderType === 'host') return;

  const conversationId = msg?.conversation_id || msg?.relationships?.conversation?.data?.id;
  const guestName = msg?.guest_name || msg?.attributes?.guest_name || 'Guest';
  const messageBody = msg?.body || msg?.attributes?.body || '';
  const propertyName = msg?.property_name || msg?.attributes?.property_name || 'your listing';
  const propertyId = msg?.property_id || msg?.relationships?.property?.data?.id;

  if (!conversationId || !messageBody) return;

  console.log(`[webhook] Message from ${guestName} at "${propertyName}": "${messageBody.slice(0, 80)}"`);

  // If we don't have a profile for this property yet, learn it now
  if (propertyId && !propertyProfiles.has(propertyId)) {
    console.log(`[learn] No profile for ${propertyName} yet — learning now...`);
    learnPropertyProfile(propertyId, propertyName).catch(console.error);
  }

  try {
    const draftedReply = await draftReply(guestName, messageBody, propertyName, propertyId);
    scheduleReply(conversationId, guestName, messageBody, draftedReply, propertyName, propertyId);
  } catch (err) {
    console.error('[webhook] Error drafting reply:', err.message);
  }
});

// ─── Scheduling ───────────────────────────────────────────────────────────────

function scheduleReply(conversationId, guestName, originalMessage, draftedReply, propertyName, propertyId) {
  const id = crypto.randomUUID();
  const delayMs = HOST_SETTINGS.delayMinutes * 60 * 1000;
  const sendAt = Date.now() + delayMs;

  const entry = {
    id, conversationId, guestName, propertyName, propertyId,
    originalMessage, draftedReply, editedReply: draftedReply,
    status: 'pending', createdAt: Date.now(), sendAt,
    usedProfile: propertyProfiles.has(propertyId),
  };

  const timer = setTimeout(async () => {
    const current = pendingReplies.get(id);
    if (!current || current.status !== 'pending') return;
    current.status = 'sending';
    try {
      await sendToHospitable(current.conversationId, current.editedReply);
      current.status = 'sent';
    } catch (err) {
      current.status = 'failed';
      current.error = err.message;
    }
    replyLog.unshift({ ...current });
    if (replyLog.length > 100) replyLog.pop();
    pendingReplies.delete(id);
  }, delayMs);

  entry.timer = timer;
  pendingReplies.set(id, entry);
  console.log(`[scheduler] Reply queued for ${guestName} — sends in ${HOST_SETTINGS.delayMinutes}min`);
}

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
  if (!res.ok) throw new Error(`Hospitable ${res.status}`);
  return res.json();
}

// ─── Dashboard API ────────────────────────────────────────────────────────────

app.get('/api/queue', (req, res) => {
  const pending = Array.from(pendingReplies.values()).map(e => ({
    id: e.id, conversationId: e.conversationId, guestName: e.guestName,
    propertyName: e.propertyName, originalMessage: e.originalMessage,
    draftedReply: e.draftedReply, editedReply: e.editedReply,
    status: e.status, createdAt: e.createdAt, sendAt: e.sendAt,
    usedProfile: e.usedProfile,
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
    await sendToHospitable(entry.conversationId, entry.editedReply);
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
}));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏠 Airbnb AutoHost running on port ${PORT}`);
  console.log(`   Host: ${HOST_SETTINGS.name} | Delay: ${HOST_SETTINGS.delayMinutes}min\n`);
  // Start learning profiles after 3 second startup delay
  setTimeout(initAllPropertyProfiles, 3000);
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
