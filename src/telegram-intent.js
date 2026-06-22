'use strict';
// Parse a plain-English host message into a structured ops intent with Claude Haiku (fast/cheap).
// The model returns JSON ONLY; `normalizeIntent` then validates/coerces it into one of the known
// actions. Anything unrecognized or low-confidence collapses to { action:'clarify' } so the bot
// asks rather than firing an ambiguous command (hard requirement: never guess a live action).

const ACTIONS = new Set([
  'cleaning_override',   // add/remove units from a night's cleaning list (immediate)
  'cleaning_status',     // VIEW the cleaning list for a date — read-only, sends nothing
  'cleaner_message',     // one-off SMS to Veronica (immediate)
  'checkin_status',      // today's check-in sweep result (read-only)
  'checkin_resend',      // re-send check-in instructions to a guest/unit (immediate)
  'frontdesk_form',      // fire the concierge/front-desk contingency for an arriving guest (immediate)
  'guest_message',       // compose + send a guest message (CONFIRM before send)
  'pricing_adjust',      // % price change over a date range (CONFIRM before apply)
  'pricing_decay_freeze',// freeze/unfreeze decay for a rolling N-day window (CONFIRM before apply)
  'clarify',             // not confidently parseable → ask the host
]);

const PARSE_MODEL = 'claude-haiku-4-5';

const PARSE_SYSTEM_PROMPT = `You convert an Airbnb host's plain-English phone message into ONE JSON object describing the command. Output JSON ONLY — no prose, no code fences.

The host runs 7 Atlanta units (labels: 4-L, 7-B, 18-A, 21-D, 21-I, 23-N, 24-L). "Veronica" is the cleaner.

Pick exactly one "action" from this list and include its fields:

- "cleaning_override": CHANGE a night's cleaning list by ADDING or REMOVING units. Field "ops": array of {"op":"add"|"remove","unit":"21-I","urgent":true|false,"deadline":"4:00PM"|null,"date":"YYYY-MM-DD"|null}. "tomorrow"/"tonight" → date:null (defaults to tomorrow). "urgent"/"guest arriving" → urgent:true. "ready by 4"/"by 4pm" → deadline. A message can carry several ops ("take 24-L off and add 21-I urgent"). Use this ONLY when the host is adding/removing a unit — NOT when they are just asking what's scheduled.
- "cleaning_status": VIEW/show the cleaning list for a date — a READ-ONLY query that sends nothing and changes nothing. Use for "what's on the cleaning schedule [tomorrow]", "what's being cleaned [tomorrow/<date>]", "show cleaning for <date>", "who's cleaning tomorrow", "what needs cleaning". Field "date":"YYYY-MM-DD" optional (default: tomorrow). If the host is asking WHAT is scheduled (not changing it), this is the action — never cleaning_override.
- "cleaner_message": a free-text SMS to the cleaner. Field "message": the exact text to send.
- "checkin_status": show today's check-in sweep. Optional "date":"YYYY-MM-DD".
- "checkin_resend": re-send check-in instructions. Field "target": guest name OR unit label.
- "frontdesk_form": send the front-desk/concierge form for a guest. Field "name": the guest's name.
- "guest_message": host wants to message a guest in their own words. Fields "guest": guest name/identifier, "gist": what the host wants conveyed (you do NOT write the message here).
- "pricing_adjust": change prices by a percentage over a date range. Fields "pct": signed number (lower 5% → -5, raise 10% → 10), "start":"YYYY-MM-DD", "end":"YYYY-MM-DD", "units": "all" OR array of unit labels.
- "pricing_decay_freeze": freeze or unfreeze automated price decay for a rolling window of N days from today. Fields "enable": true to FREEZE (turn decay OFF), false to UNFREEZE (turn decay back ON); "days": integer window length (default 7 when freezing).
- "clarify": you cannot confidently determine the command, or required fields are missing/ambiguous. Field "reason": a short question for the host.

Always include "confidence": 0.0–1.0. If below 0.6, use action "clarify". Resolve relative dates using the provided TODAY. Never invent a unit not in the list.`;

// Coerce a unit token ("21-i", "Apt 21-I", "21I") to a canonical label, or null if not one of ours.
const UNIT_LABELS = ['4-L', '7-B', '18-A', '21-D', '21-I', '23-N', '24-L'];
function canonUnit(tok) {
  if (!tok) return null;
  const norm = String(tok).toUpperCase().replace(/^APT\s*/, '').replace(/[\s.]/g, '').replace(/^(\d+)([A-Z])$/, '$1-$2');
  return UNIT_LABELS.find(l => l === norm) || null;
}

function clamp01(n) { const x = Number(n); return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0; }

// Robustly pull a JSON object out of the model's text. Haiku frequently wraps its output in
// ```json fences or adds a one-line preamble despite "JSON ONLY" instructions — a naive
// JSON.parse then throws and collapses EVERY command to clarify. Mirrors draft-parse.js: try a
// fenced block, then the first balanced {…}, then the whole string. Returns the object or null.
function extractJson(text) {
  const s = String(text == null ? '' : text).trim();
  const candidates = [];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const brace = s.match(/\{[\s\S]*\}/);      // first { … last } — survives fences AND preamble
  if (brace) candidates.push(brace[0]);
  candidates.push(s);
  for (const c of candidates) {
    try { const o = JSON.parse(c); if (o && typeof o === 'object') return o; } catch { /* next candidate */ }
  }
  return null;
}

// Validate/coerce the model's raw JSON into a safe intent. Unknown action, missing required field,
// or confidence < 0.6 → { action:'clarify', reason }. Pure — the unit of the parse tests.
function normalizeIntent(raw, { minConfidence = 0.6 } = {}) {
  let o = raw;
  if (typeof raw === 'string') {
    o = extractJson(raw);
    if (!o) return clarify('I could not understand that — can you rephrase?');
  }
  if (!o || typeof o !== 'object' || !ACTIONS.has(o.action)) return clarify('I’m not sure what you want me to do — can you rephrase?');
  const confidence = clamp01(o.confidence);
  if (o.action !== 'clarify' && confidence < minConfidence) return clarify(o.reason || 'I’m not fully sure I understood — can you confirm what you want?');

  switch (o.action) {
    case 'cleaning_override': {
      const ops = (Array.isArray(o.ops) ? o.ops : []).map(op => ({
        op: op && op.op === 'remove' ? 'remove' : 'add',
        unit: canonUnit(op && op.unit),
        urgent: !!(op && op.urgent),
        deadline: (op && op.deadline) || null,
        date: validDate(op && op.date) || null,
      })).filter(op => op.unit);
      if (!ops.length) return clarify('Which unit and add or remove? e.g. "add 21-I urgent, take 24-L off".');
      return { action: 'cleaning_override', ops, confidence };
    }
    case 'cleaning_status':
      return { action: 'cleaning_status', date: validDate(o.date) || null, confidence };
    case 'cleaner_message': {
      const message = String(o.message || '').trim();
      if (!message) return clarify('What should I text Veronica?');
      return { action: 'cleaner_message', message, confidence };
    }
    case 'checkin_status':
      return { action: 'checkin_status', date: validDate(o.date) || null, confidence };
    case 'checkin_resend': {
      const target = String(o.target || '').trim();
      if (!target) return clarify('Resend check-in to which guest or unit?');
      return { action: 'checkin_resend', target, confidence };
    }
    case 'frontdesk_form': {
      const name = String(o.name || '').trim();
      if (!name) return clarify('Front-desk form for which guest?');
      return { action: 'frontdesk_form', name, confidence };
    }
    case 'guest_message': {
      const guest = String(o.guest || '').trim();
      const gist = String(o.gist || '').trim();
      if (!guest || !gist) return clarify('Tell me the guest and the gist — e.g. "tell Jamie the late checkout is approved".');
      return { action: 'guest_message', guest, gist, confidence };
    }
    case 'pricing_adjust': {
      const pct = Number(o.pct);
      const start = validDate(o.start), end = validDate(o.end);
      if (!Number.isFinite(pct) || pct === 0 || !start || !end) return clarify('Give me a percentage and a date range, e.g. "lower prices June 20-29 5%".');
      let units = o.units;
      if (units !== 'all') {
        units = (Array.isArray(units) ? units : [units]).map(canonUnit).filter(Boolean);
        if (!units.length) units = 'all';
      }
      return { action: 'pricing_adjust', pct, start, end, units, confidence };
    }
    case 'pricing_decay_freeze': {
      const enable = o.enable !== false;
      let days = parseInt(o.days, 10);
      if (!Number.isInteger(days) || days < 1) days = 7;
      return { action: 'pricing_decay_freeze', enable, days, confidence };
    }
    default:
      return clarify(o.reason || 'Can you clarify what you’d like me to do?');
  }
}

function clarify(reason) { return { action: 'clarify', reason: reason || 'Can you clarify?', confidence: 1 }; }
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null; }

// Call Haiku and normalize. callClaude(model, systemPrompt, userMessage) → string (injectable).
async function parseIntent({ text, callClaude, today, minConfidence } = {}) {
  const userMessage = `TODAY is ${today}.\nHost message: ${String(text || '').trim()}`;
  let rawText = '';
  try {
    rawText = await callClaude(PARSE_MODEL, PARSE_SYSTEM_PROMPT, userMessage);
  } catch (e) {
    console.error(`[telegram-parse] Claude call failed: ${e.message}`);
    return clarify('I had trouble reading that just now — can you send it again?');
  }
  const result = normalizeIntent(rawText, { minConfidence });
  // One-line trace so a parse problem is visible in the logs (raw output + resolved action).
  console.log(`[telegram-parse] "${String(text || '').slice(0, 60)}" → ${result.action}` +
    `${result.action === 'clarify' ? ` (${result.reason})` : ''} | raw: ${String(rawText || '').replace(/\s+/g, ' ').slice(0, 140)}`);
  return result;
}

module.exports = { ACTIONS, PARSE_MODEL, PARSE_SYSTEM_PROMPT, canonUnit, normalizeIntent, parseIntent, clarify, extractJson };
