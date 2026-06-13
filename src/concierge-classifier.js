// Strategy B — AI intent detection for the front-desk contingency.
//
// One job: decide whether a guest message means "the front desk / concierge
// can't check me in because they don't have my reservation/form, and the host
// needs to send it." This sits ON TOP of CONCIERGE_REGEX, never replacing it:
//
//   1. fast-path — if the regex already matched, fire immediately (no AI call).
//      The regex is high-precision on the patterns it knows; trust it.
//   2. AI path   — only when the regex missed, ask Claude (catches fragmented
//      / paraphrased cases the regex can't, e.g. Dekarius / Kedravious).
//   3. fallback  — if the AI call throws OR times out, fall back to the regex
//      result. A classifier error can therefore never do worse than today's
//      regex-only behavior, and never silently drops a guest.
//
// Safety:
//   - Kill switch: env CONCIERGE_AI=false instantly reverts to regex-only, no
//     redeploy. (Any value other than the literal string "false" = AI enabled.)
//   - decideConcierge() NEVER throws and ALWAYS resolves within timeoutMs — so
//     a caller can run it without ever blocking, delaying, or crashing the
//     guest-reply path.
//
// No side effects on require — Claude is injected, so this is unit-testable
// offline. server.js passes its real callClaude().

const CLASSIFIER_SYSTEM_PROMPT = `You are a strict binary classifier for an Airbnb auto-host system. The properties are units in a high-rise building that has a front desk / concierge in the lobby.

PROPERTY CHECK-IN CONTEXT (important): At this building, guests cannot reach their unit on their own at check-in. The lobby front desk / concierge must clear each guest before letting them up, and the desk will only do that once the host has sent them the guest's check-in form or a supplementary authorization email. So when a guest is stuck at the desk or in the lobby, asking us to confirm/call the front desk, saying they can't get up, or asking which room they're in, it almost always means the desk does not yet have their authorization and the host needs to send it.

Decide whether the guest's message indicates THIS SPECIFIC SITUATION:
"The building's front desk / concierge cannot check the guest in, or won't let them in or up or past the desk, because the front desk does not have the guest's reservation, registration, or check-in authorization on file — so the host needs to send the guest's reservation details to the front desk."

Answer YES if the message shows ANY of these:
- The front desk / concierge / reception / lobby / building has no reservation, no form, no record, or no authorization for the guest — e.g. "nothing under my name", "they can't find my booking", "I'm not in the system".
- The guest asks whether the host sent (or asks the host to send) their reservation / info / form / details to the front desk or concierge.
- The guest is being kept from going up or past the front desk, or won't be let in, because the desk lacks their paperwork or authorization.
- Short fragments that together mean "send my reservation to the front desk / concierge" or "did you send my info to the desk".
- The guest says they are waiting / stuck / still in the lobby or downstairs, or can't get up to their floor.
- The guest asks the host to confirm to, call, or contact the front desk (e.g. "please call the front desk to confirm", "can you confirm with the desk"), or relays our internal phrasing like "update me in the spreadsheet".
- The guest asks what / which room number they are in, or where to go, around check-in time (the desk can't place them without our authorization).

Answer NO if the message is anything else, including:
- Simply asking where the front desk is, when it is open, its hours, or its phone number.
- Asking for wifi, towels, parking, amenities, luggage, directions, or any other normal request — even if it mentions the words "send" or "front desk".
- Simply providing or listing who is staying (guest names), the number of guests, the arrival or check-in time, or other routine pre-arrival / registration details, WITHOUT reporting any trouble getting in. Sending the host this information is normal pre-arrival housekeeping — it is NOT a front-desk access problem, even when it mentions guests, names, or check-in (e.g. "Here are the names of the guests staying: …", "We'll arrive around 6pm, there will be 3 of us").
- Asking WHEN the host will send the guest their own check-in details / instructions / address, or HOW to enter or access the building, or what the address is. These are routine pre-arrival questions about information the guest is still waiting for — NOT a report that the front desk lacks their reservation (e.g. "when will you be sending out the details for the stay and how do I access the building?", "what's the address?", "when do I get the check-in info?").
- Asking for a key fob, building-access fob, elevator / gym / pool / garage / amenity fob or access, or the unit's door code / entry code / lock code. Every unit has a coded door lock, so a "key" or "fob" request is a building-access or amenity matter, NOT a front-desk check-in failure (e.g. "can I get a key fob for the gym?", "what's the door code?", "how do I get an elevator fob?").
- Any question that does not involve the front desk lacking the guest's reservation or check-in authorization.

Answer YES ONLY when the message reports an ACTUAL front-desk / check-in access problem (the desk lacks their reservation / form / authorization, they are kept from going up or past the desk, or they are stuck / waiting / can't get up), or explicitly asks you to send or confirm their reservation details to the front desk (including relaying "update me in the spreadsheet"). Merely providing information (guest names, party size, arrival time, registration details), asking for a key fob / building or amenity access, or asking for the door code is NOT enough — answer NO. When genuinely uncertain whether there is a real access problem, answer NO. Reply with EXACTLY one word: YES or NO. No punctuation, no explanation.`;

// Strict parse: only an affirmative leading "YES" fires. Anything else is silent.
function parseVerdict(text) {
  return /^yes\b/i.test(String(text || '').trim());
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`classifier timeout after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

// Core decision. NEVER throws; ALWAYS resolves (within ~timeoutMs) to a record:
//   { regexHit, aiEnabled, aiConsulted, rawVerdict, fired, source }
//   source ∈ regex-fast-path | kill-switch | no-callClaude | ai | ai-fallback
//
// Inputs:
//   text       — guest text to classify (single message, or joined recents)
//   regexHit   — whether CONCIERGE_REGEX already matched (fast-path + fallback)
//   callClaude — async (systemPrompt, userMsg, maxTokens) => string
//   env        — environment for the kill switch (default process.env)
//   timeoutMs  — hard budget for the AI call (default 4000)
async function decideConcierge({ text, regexHit = false, callClaude, env = process.env, timeoutMs = 4000 } = {}) {
  const aiEnabled = (env && env.CONCIERGE_AI) !== 'false';

  // 1. fast-path: trust the regex, spend no AI call.
  if (regexHit) {
    return { regexHit: true, aiEnabled, aiConsulted: false, rawVerdict: null, fired: true, source: 'regex-fast-path' };
  }
  // kill switch: AI disabled → regex-only behavior.
  if (!aiEnabled) {
    return { regexHit: false, aiEnabled, aiConsulted: false, rawVerdict: null, fired: false, source: 'kill-switch' };
  }
  if (typeof callClaude !== 'function') {
    return { regexHit: false, aiEnabled, aiConsulted: false, rawVerdict: null, fired: regexHit, source: 'no-callClaude' };
  }
  // 2. AI path.
  try {
    const rawVerdict = await withTimeout(callClaude(CLASSIFIER_SYSTEM_PROMPT, String(text || ''), 5), timeoutMs);
    return { regexHit: false, aiEnabled, aiConsulted: true, rawVerdict, fired: parseVerdict(rawVerdict), source: 'ai' };
  } catch (e) {
    // 3. fallback: never worse than regex-only (regexHit is false here → silent).
    return { regexHit: false, aiEnabled, aiConsulted: true, rawVerdict: `ERROR:${e.message}`, fired: regexHit, source: 'ai-fallback' };
  }
}

// Thin boolean wrapper kept for callers/tests that only want the decision.
async function classifyConcierge(text, opts = {}) {
  const { regexHit = false, callClaude, timeoutMs = 4000, log } = opts;
  const rec = await decideConcierge({ text, regexHit, callClaude, timeoutMs, env: process.env });
  if (log && rec.source === 'ai-fallback') log(new Error(rec.rawVerdict));
  return rec.fired;
}

// ─── Context gate: ACTIVE access problem vs PAST complaint ────────────────────
// A second classifier that runs AFTER the concierge trigger (regex OR AI) has hit, BEFORE the
// canned front-desk reply fires. It reads the full message and decides whether this is a live
// access/check-in problem to solve right now (→ ACCESS, fire the concierge flow) or a complaint
// about something that already happened (→ COMPLAINT, do NOT fire the canned access reply —
// route to service recovery / host). This is what stops a frustrated, past-tense grievance from
// being answered with "we emailed the front desk your check-in info."
const INTENT_SYSTEM_PROMPT = `You are a strict binary classifier for an Airbnb auto-host at a high-rise with a lobby front desk / concierge. The guest message below has ALREADY been flagged as possibly front-desk related. Your only job is to decide WHICH of two intents it is:

ACCESS — an active, happening-NOW access or check-in problem the host can fix right now by sending the front desk the guest's reservation/authorization. Signals: the guest can't get in or up, is stuck or waiting in the lobby/downstairs, the desk has no record/booking/form/authorization for them, they're being turned away, or they ask the host to send/confirm their reservation to the desk. Present-tense, "right now", needs action.

COMPLAINT — the guest is unhappy, frustrated, or disputing something that ALREADY happened, and is NOT asking to be let in right now. Signals: past tense ("was", "had to", "were", "arrived to find"), grievances about the unit or booking (wrong/misrepresented unit, dirty, double-booked, maintenance issues, not as listed/photos), inconvenience, disappointment, or asking for a refund / discount / compensation / "reconsideration". Even if it mentions "reservation", "building", "they", or "did not receive", if the core is a grievance about the past — it is COMPLAINT.

If the message contains BOTH a live access problem AND a complaint, answer ACCESS (the guest needs in right now; the grievance can be handled after).

Reply with EXACTLY one word: ACCESS or COMPLAINT. No punctuation, no explanation.`;

// Parse the verdict. Match the "compl…" PREFIX (not the whole word): an all-caps "COMPLAINT"
// tokenizes into several subwords, so a tight token budget can return a truncated "COMPLA" — the
// prefix still classifies it correctly. Bias: only a complaint-prefix diverts away from the access
// flow; anything else (incl. unparseable) → 'access', so a classifier glitch never strands a guest
// with a live access problem. The money-complaint guardrail runs BEFORE this gate anyway.
function parseIntent(text) {
  return /^\s*compl/i.test(String(text || '')) ? 'complaint' : 'access';
}

// Core intent decision. NEVER throws; ALWAYS resolves (within ~timeoutMs) to:
//   { intent: 'access'|'complaint', raw, source }
//   source ∈ kill-switch | no-callClaude | ai | ai-fallback
// Fail-open to 'access' (preserves today's fire-the-concierge behavior on any error/timeout).
async function classifyAccessIntent({ text, callClaude, env = process.env, timeoutMs = 4000 } = {}) {
  const aiEnabled = (env && env.CONCIERGE_AI) !== 'false';
  if (!aiEnabled) return { intent: 'access', raw: null, source: 'kill-switch' };
  if (typeof callClaude !== 'function') return { intent: 'access', raw: null, source: 'no-callClaude' };
  try {
    // 16-token budget so the longer word ("COMPLAINT") returns in full rather than truncating.
    const raw = await withTimeout(callClaude(INTENT_SYSTEM_PROMPT, String(text || ''), 16), timeoutMs);
    return { intent: parseIntent(raw), raw, source: 'ai' };
  } catch (e) {
    return { intent: 'access', raw: `ERROR:${e.message}`, source: 'ai-fallback' };
  }
}

module.exports = {
  decideConcierge, classifyConcierge, parseVerdict, withTimeout, CLASSIFIER_SYSTEM_PROMPT,
  classifyAccessIntent, parseIntent, INTENT_SYSTEM_PROMPT,
};
