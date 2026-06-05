// Real failure-alert sender for the pricing engine. Texts NOTIFY_PHONE via OpenPhone — the
// SAME integration the cleaning schedule + host alerts use (QUO_API_KEY / QUO_FROM_NUMBER /
// NOTIFY_PHONE). NEVER throws: a failed alert send must not crash the pricing run (it logs).
// fetchImpl is injectable for tests (default = global fetch).
'use strict';
const OPENPHONE_URL = 'https://api.openphone.com/v1/messages';

function buildAlertSender(env = process.env, fetchImpl) {
  const apiKey = env.QUO_API_KEY;
  const from = env.QUO_FROM_NUMBER;
  const to = env.NOTIFY_PHONE || env.ALERT_PHONE;
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  return async function sendAlert(alert) {
    if (!apiKey || !from || !to) {
      console.warn(`[pricing-alert] no SMS creds — would send: ${alert.type}: ${alert.detail}`);
      return { sent: false, reason: 'not configured' };
    }
    if (!f) return { sent: false, reason: 'no fetch available' };
    const content = `⚠️ PRICING ${alert.type}: ${alert.detail}`.slice(0, 300);
    try {
      const res = await f(OPENPHONE_URL, {
        method: 'POST',
        headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: [to], from, content }),
      });
      if (!res.ok) { console.error(`[pricing-alert] OpenPhone ${res.status}`); return { sent: false, status: res.status }; }
      console.log(`[pricing-alert] SMS sent to ${to}: ${alert.type}`);
      return { sent: true, status: res.status };
    } catch (e) {
      console.error(`[pricing-alert] send failed: ${e.message}`);
      return { sent: false, error: e.message };
    }
  };
}

module.exports = { buildAlertSender, OPENPHONE_URL };
