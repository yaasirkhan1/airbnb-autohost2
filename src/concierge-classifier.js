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

Decide whether the guest's message indicates THIS SPECIFIC SITUATION:
"The building's front desk / concierge cannot check the guest in, or won't let them in or up or give them a key, because the front desk does not have the guest's reservation, registration, or check-in authorization on file — so the host needs to send the guest's reservation details to the front desk."

Answer YES if the message shows ANY of these:
- The front desk / concierge / reception / lobby / building says they have no reservation, no form, no record, or no authorization for the guest.
- The guest asks whether the host sent (or asks the host to send) their reservation / info / form / details to the front desk or concierge.
- The guest is being denied entry, access, a key, or a fob because the desk lacks their paperwork.
- Short fragments that together mean "send my reservation to the front desk / concierge" or "did you send my info to the desk".

Answer NO if the message is anything else, including:
- Simply asking where the front desk is, when it is open, its hours, or its phone number.
- Asking for wifi, towels, parking, amenities, luggage, directions, or any other normal request — even if it mentions the words "send" or "front desk".
- Any question that does not involve the front desk lacking the guest's reservation or check-in authorization.

When uncertain, answer NO. Reply with EXACTLY one word: YES or NO. No punctuation, no explanation.`;

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

module.exports = { decideConcierge, classifyConcierge, parseVerdict, withTimeout, CLASSIFIER_SYSTEM_PROMPT };
