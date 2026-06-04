#!/usr/bin/env node
// Standalone health monitor for the AutoHost app. Runs in GitHub Actions on a
// schedule (see .github/workflows/health-monitor.yml) — it is NOT part of the
// Railway app and shares no code with it.
//
// DETECT-AND-NOTIFY ONLY. This script never repairs, never tops up credits, and
// never touches account/billing settings. It uses API keys solely to (a) read the
// app's /health, (b) probe whether the Anthropic key can still bill (read-only
// 1-token call), (c) read OpenPhone's own sent-message record to confirm the
// nightly cleaning SMS, and (d) send YOU an alert SMS via OpenPhone.
//
// Checks:
//   1. GET /health        → alert if unreachable / non-200
//   2. profilesLoaded === 0 → alert
//   3. Anthropic credits exhausted (1-token probe returns the credit 400) → alert
//   4. Nightly cleaning SMS (after 9pm ET): confirm via OpenPhone sent messages → alert if missing
//   5. OpenPhone credits: detected when an SMS send returns HTTP 402 (no public
//      balance endpoint exists) — see the alert-channel caveat below.
//
// Dedup: per-issue state is persisted between runs (STATE_FILE, carried by the
// Actions cache). An issue alerts ONCE; it won't re-alert until it clears and recurs.
//
// Heartbeat: one "✅ all systems normal" SMS per ET calendar day (first all-clear
// run at/after 09:00 ET).
//
// Alert-channel caveat: alerts go out over OpenPhone, so if OpenPhone itself is out
// of credits the SMS can't be delivered. In that case the script exits non-zero so
// GitHub's native "scheduled run failed" email reaches you out-of-band.

const fs = require('fs');

const {
  HEALTH_URL,
  APP_API_SECRET,
  ANTHROPIC_API_KEY,
  OPENPHONE_API_KEY,
  OPENPHONE_FROM_NUMBER,
  ALERT_PHONE,
  CLEANER_PHONE,
  STATE_FILE = 'monitor-state.json',
  GITHUB_STEP_SUMMARY,
} = process.env;

const required = { HEALTH_URL, APP_API_SECRET, ANTHROPIC_API_KEY, OPENPHONE_API_KEY, OPENPHONE_FROM_NUMBER, ALERT_PHONE, CLEANER_PHONE };
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);

// ─── helpers ──────────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { activeIssues: {}, lastHeartbeatDate: null }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('state save failed:', e.message); }
}

// Calendar date + clock in America/New_York for `d` (the cron's timezone).
function etParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  let hour = Number(p.hour); if (hour === 24) hour = 0; // some ICU builds emit 24 at midnight
  return { date: `${p.year}-${p.month}-${p.day}`, hour, minute: Number(p.minute) };
}

const digits = s => String(s || '').replace(/\D/g, '');

async function sendSms(content) {
  try {
    const r = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: { Authorization: OPENPHONE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: [ALERT_PHONE], from: OPENPHONE_FROM_NUMBER, content: content.slice(0, 300) }),
    });
    if (!r.ok) return { ok: false, status: r.status, body: (await r.text()).slice(0, 200) };
    return { ok: true };
  } catch (e) { return { ok: false, status: 0, body: e.message }; }
}

// ─── checks ─────────────────────────────────────────────────────────────────

async function checkHealth() {
  try {
    const r = await fetch(HEALTH_URL, { headers: { Authorization: `Bearer ${APP_API_SECRET}` } });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    return { ok: true, json: await r.json() };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// Read-only: a 1-token call is the only way to learn whether the key can still bill.
// The credit-exhaustion condition surfaces as a 400 with a specific message. We can
// detect EXHAUSTION (zero) — there is no Anthropic balance API to detect "near zero".
async function anthropicExhausted() {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
    if (r.ok) return { exhausted: false };
    const t = await r.text();
    if (r.status === 400 && /credit balance is too low/i.test(t)) return { exhausted: true };
    return { exhausted: false, note: `anthropic probe ${r.status}` };
  } catch (e) { return { exhausted: false, note: e.message }; }
}

// Confirm tonight's cleaning SMS via OpenPhone's OWN sent-message record (no Railway
// log access, no app change). Defensive: any uncertainty → 'unknown' (no alert).
async function checkCleaningSent(etDate) {
  try {
    const pnr = await fetch('https://api.openphone.com/v1/phone-numbers', { headers: { Authorization: OPENPHONE_API_KEY } });
    if (!pnr.ok) return { status: 'unknown', note: `phone-numbers ${pnr.status}` };
    const list = (await pnr.json()).data || [];
    const fromD = digits(OPENPHONE_FROM_NUMBER);
    const pn = list.find(x => digits(x.phoneNumber || x.number || x.e164) === fromD);
    if (!pn?.id) return { status: 'unknown', note: 'from-number not found in OpenPhone account' };

    const url = `https://api.openphone.com/v1/messages?phoneNumberId=${encodeURIComponent(pn.id)}` +
      `&participants[]=${encodeURIComponent(CLEANER_PHONE)}&maxResults=50`;
    const mr = await fetch(url, { headers: { Authorization: OPENPHONE_API_KEY } });
    if (!mr.ok) return { status: 'unknown', note: `messages ${mr.status}` };
    const msgs = (await mr.json()).data || [];

    const sent = msgs.some(m => {
      const dir = (m.direction || '').toLowerCase();
      if (dir && dir !== 'outgoing') return false;
      const text = m.text || m.body || m.content || '';
      if (!/🧹|limpieza|sin limpiezas/i.test(text)) return false; // the cleaning-SMS marker
      const created = m.createdAt || m.created_at;
      if (!created) return false;
      const p = etParts(new Date(created));
      return p.date === etDate && p.hour >= 21; // tonight, after the 9pm cron
    });
    return { status: sent ? 'ok' : 'failed' };
  } catch (e) { return { status: 'unknown', note: e.message }; }
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const summary = [];
  const note = s => { summary.push(s); console.log(s); };

  if (missing.length) { note(`FATAL: missing required env: ${missing.join(', ')}`); writeSummary(summary); process.exit(1); }

  const state = loadState();
  const { date: etDate, hour: etHour, minute: etMin } = etParts();
  const issues = []; // { key, msg }

  // 1 & 2 — health + profiles
  const health = await checkHealth();
  if (!health.ok) {
    issues.push({ key: 'app-down', msg: `🚨 AutoHost DOWN — /health ${health.reason}` });
  } else if (health.json?.profilesLoaded === 0) {
    issues.push({ key: 'profiles-zero', msg: '⚠ AutoHost: profilesLoaded=0 — no property profiles loaded' });
  }

  // 3 — Anthropic credits
  const anth = await anthropicExhausted();
  if (anth.exhausted) issues.push({ key: 'anthropic-credits', msg: '🚨 Anthropic API credits exhausted — guest replies & profile learning will fail' });
  if (anth.note) note(`anthropic: ${anth.note}`);

  // 4 — nightly cleaning SMS (only after the 9pm ET cron has had time to run)
  if (etHour > 21 || (etHour === 21 && etMin >= 20)) {
    const clean = await checkCleaningSent(etDate);
    if (clean.status === 'failed') issues.push({ key: 'cleaning-failed', msg: `🚨 Nightly cleaning SMS did NOT go out tonight (${etDate})` });
    if (clean.note) note(`cleaning check: unknown (${clean.note})`);
  }

  // ─── reconcile + alert (dedup) ───
  const currentKeys = new Set(issues.map(i => i.key));
  for (const k of Object.keys(state.activeIssues)) if (!currentKeys.has(k)) { delete state.activeIssues[k]; note(`recovered: ${k}`); }

  let deliveryFailed = false, openphoneOut = false;
  for (const it of issues) {
    if (state.activeIssues[it.key]) { note(`still active (already alerted): ${it.key}`); continue; }
    const res = await sendSms(it.msg);
    if (res.ok) { state.activeIssues[it.key] = new Date().toISOString(); note(`ALERT SENT: ${it.key}`); }
    else { deliveryFailed = true; if (res.status === 402) openphoneOut = true; note(`ALERT UNDELIVERED (${res.status}): ${it.key} — ${res.body}`); }
  }

  // 5 — OpenPhone credit exhaustion is whatever made a send return 402
  if (openphoneOut) note('🚨 OpenPhone credits exhausted — alert SMS could not be delivered (relying on GitHub failure email)');

  // ─── daily heartbeat ───
  if (issues.length === 0 && !deliveryFailed) {
    if (state.lastHeartbeatDate !== etDate && etHour >= 9) {
      const res = await sendSms('✅ AutoHost: all systems normal');
      if (res.ok) { state.lastHeartbeatDate = etDate; note('heartbeat sent'); }
      else { deliveryFailed = true; if (res.status === 402) openphoneOut = true; note(`heartbeat UNDELIVERED (${res.status})`); }
    } else { note('all clear (no heartbeat due)'); }
  }

  saveState(state);
  note(`summary: issues=[${issues.map(i => i.key).join(',') || 'none'}] active=[${Object.keys(state.activeIssues).join(',') || 'none'}] deliveryFailed=${deliveryFailed}`);
  writeSummary(summary);

  // Exit non-zero ONLY when an alert/heartbeat could not be delivered, so GitHub's
  // native failure email is the out-of-band fallback for a broken SMS channel.
  process.exit(deliveryFailed ? 1 : 0);

  function writeSummary(lines) {
    if (GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(GITHUB_STEP_SUMMARY, `### Health Monitor\n\n${lines.map(l => `- ${l}`).join('\n')}\n`); } catch {} }
  }
})().catch(e => { console.error('monitor crashed:', e); process.exit(1); });
