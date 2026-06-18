// One-off SMS to Veronica (the cleaner) via OpenPhone — the SAME integration the nightly
// cleaning schedule uses (QUO_API_KEY / QUO_FROM_NUMBER). Powers POST /api/cleaner-message so a
// "text Veronica: ..." prompt becomes a single authed POST — no credential hunting, no raw curl.
// NEVER throws: a failed send returns {ok:false,...} so the route can answer cleanly.
// fetchImpl is injectable for tests (default = global fetch).
'use strict';
const OPENPHONE_URL = 'https://api.openphone.com/v1/messages';

// Veronica's OpenPhone number — the cleaner recipient in sendCleaningSchedule's `recipients`.
const CLEANER_PHONE = '229-573-3899';

// Trim + bound a free-text message. Returns { message } when usable, else { error }.
// OpenPhone caps SMS content; we clamp to 1000 like sendOpenPhoneSms does.
function validateMessage(raw) {
  const message = String(raw == null ? '' : raw).trim();
  if (!message) return { error: 'message is required (non-empty text)' };
  return { message: message.slice(0, 1000) };
}

// Build a sender bound to env + fetch. Returns async (message) => result.
// Mirrors buildAlertSender: degrades (no throw) when creds or fetch are missing.
function buildCleanerSender(env = process.env, fetchImpl) {
  const apiKey = env.QUO_API_KEY;
  const from   = env.QUO_FROM_NUMBER;
  const to     = env.CLEANER_PHONE || CLEANER_PHONE;
  const f      = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return async function sendCleanerMessage(message) {
    const { message: content, error } = validateMessage(message);
    if (error) return { ok: false, reason: error };
    if (!apiKey || !from) {
      console.warn(`[cleaner-sms] no SMS creds — would send to ${to}: "${content.slice(0, 80)}"`);
      return { ok: false, reason: 'not configured', to };
    }
    if (!f) return { ok: false, reason: 'no fetch available', to };
    try {
      const res = await f(OPENPHONE_URL, {
        method: 'POST',
        headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: [to], from, content }),
      });
      if (!res.ok) { console.error(`[cleaner-sms] OpenPhone ${res.status}`); return { ok: false, status: res.status, to }; }
      console.log(`[cleaner-sms] SMS sent to ${to}: "${content.slice(0, 80)}"`);
      return { ok: true, status: res.status, to };
    } catch (e) {
      console.error(`[cleaner-sms] send failed: ${e.message}`);
      return { ok: false, error: e.message, to };
    }
  };
}

module.exports = { buildCleanerSender, validateMessage, CLEANER_PHONE, OPENPHONE_URL };
