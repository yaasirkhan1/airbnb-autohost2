'use strict';
// Telegram ops bot — folded into the main service (long-poll, no public route). A plain-English
// message from the HOST ONLY is parsed (Haiku) → mapped to an action → run against the existing
// authed endpoints/flows → confirmed back. Guest messages + pricing changes are drafted/echoed and
// fire ONLY after the host replies "yes"; everything else fires immediately.
//
// HARD SECURITY: the bot answers ONLY the numeric Telegram user id in `ownerId` (TELEGRAM_OWNER_ID).
// Any other sender is ignored entirely — no reply, no parse, no action. Non-negotiable: this bot can
// move live prices and message guests.
//
// `handleUpdate` is pure over injected deps (parse/compose/resolveGuest/handlers/pending Map) so the
// whole dispatch — owner lock, confirmation gating, front-desk resolution — is unit-testable with no
// network. `start` is the only piece that touches the Telegram HTTP API.
const { requiresConfirmation, confirmText, isAffirmative, isNegative } = require('./telegram-actions');

// Extract the numeric sender id from an update (message OR edited_message), or null.
function senderId(update) {
  const m = update && (update.message || update.edited_message);
  return m && m.from && typeof m.from.id === 'number' ? m.from.id : null;
}

function isOwner(update, ownerId) {
  const id = senderId(update);
  return id != null && String(id) === String(ownerId);
}

// Core dispatch. Returns { ignored?, replies: [string], fired?: action }. Mutates deps.pending.
async function handleUpdate(update, deps) {
  const { ownerId, pending } = deps;
  const msg = update && (update.message || update.edited_message);

  // SECURITY GATE — anything not from the owner is dropped silently (no reply, no work).
  if (!isOwner(update, ownerId)) return { ignored: true, replies: [] };
  if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) return { ignored: true, replies: [] };

  const chatId = msg.chat && msg.chat.id;
  const text = msg.text.trim();
  const held = pending.get(chatId);

  // ── A confirmation is pending: accept only yes/no; never fire anything else here. ──
  if (held) {
    if (isAffirmative(text)) {
      pending.delete(chatId);
      const out = await executePending(held, deps);
      return { replies: [out], fired: held.kind };
    }
    if (isNegative(text)) {
      pending.delete(chatId);
      return { replies: ['Okay — cancelled, nothing sent or changed.'] };
    }
    return { replies: [`You have a pending ${held.kind.replace('_', ' ')} awaiting confirmation. Reply "yes" to go ahead or "no" to cancel.`] };
  }

  // ── Fresh command. ──
  const intent = await deps.parse(text);
  if (intent.action === 'clarify') return { replies: [intent.reason] };

  if (requiresConfirmation(intent.action)) {
    if (intent.action === 'guest_message') return handleGuestDraft(intent, chatId, deps);
    // pricing_adjust / pricing_decay_freeze — echo the exact interpreted change, then wait for yes.
    pending.set(chatId, { kind: intent.action, intent });
    return { replies: [confirmText(intent)] };
  }

  // ── Immediate actions — fire now, confirm what was done. ──
  const handler = deps.handlers[intent.action];
  if (!handler) return { replies: ['I’m not set up to do that yet.'] };
  const out = await handler(intent);
  return { replies: [out], fired: intent.action };
}

// guest_message: resolve the guest first (ask if 0/many), then COMPOSE in the host's voice (Sonnet),
// echo the final text, and stash it pending "yes". Nothing is sent here.
async function handleGuestDraft(intent, chatId, deps) {
  const res = await deps.resolveGuest(intent.guest);
  if (res.status === 'none') return { replies: [`I couldn’t find a guest matching “${intent.guest}”. Who do you mean?`] };
  if (res.status === 'many') {
    const list = res.candidates.map(c => `• ${c.label}`).join('\n');
    return { replies: [`More than one guest matches “${intent.guest}”:\n${list}\nWhich one?`] };
  }
  const composed = await deps.compose({ guest: res.guest, gist: intent.gist });
  deps.pending.set(chatId, { kind: 'guest_message', guest: res.guest, text: composed });
  return { replies: [`${confirmText(intent)}\n\n“${composed}”\n\nReply "yes" to send to ${res.guest.label}, or "no" to cancel.`] };
}

function executePending(held, deps) {
  if (held.kind === 'guest_message') return deps.handlers.guest_message_send({ guest: held.guest, text: held.text });
  if (held.kind === 'pricing_adjust') return deps.handlers.pricing_adjust(held.intent);
  if (held.kind === 'pricing_decay_freeze') return deps.handlers.pricing_decay_freeze(held.intent);
  return Promise.resolve('Nothing to do.');
}

// ── Long-poll loop (the only networked part). Folded into the service at boot. ──
async function start(deps) {
  const { token, ownerId, log = console } = deps;
  if (!token || !ownerId) { log.log('[telegram] disabled — TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_ID not set'); return; }
  const api = (method) => `https://api.telegram.org/bot${token}/${method}`;
  const send = async (chatId, text) => {
    try {
      await fetch(api('sendMessage'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch (e) { log.error('[telegram] sendMessage failed:', e.message); }
  };
  deps.pending = deps.pending || new Map();
  let offset = 0;
  log.log(`[telegram] ops bot started — long-polling (owner ${ownerId})`);
  // Fire-and-forget loop; never throws out (a poll error backs off and retries).
  (async function loop() {
    for (;;) {
      try {
        const r = await fetch(api('getUpdates') + `?timeout=30&offset=${offset}`);
        const data = await r.json();
        for (const update of (data.result || [])) {
          offset = update.update_id + 1;
          // Drop non-owner updates BEFORE any work (defense in depth alongside handleUpdate).
          if (!isOwner(update, ownerId)) continue;
          try {
            const out = await handleUpdate(update, deps);
            const chatId = (update.message || update.edited_message).chat.id;
            for (const reply of (out.replies || [])) await send(chatId, reply);
          } catch (e) {
            log.error('[telegram] handle error:', e.message);
          }
        }
      } catch (e) {
        log.error('[telegram] poll error:', e.message);
        await new Promise(res => setTimeout(res, 5000)); // back off, then keep polling
      }
    }
  })();
}

module.exports = { isOwner, senderId, handleUpdate, handleGuestDraft, executePending, start };
