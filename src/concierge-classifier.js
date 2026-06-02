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

// Returns true if the message should fire the front-desk contingency.
//   text       — the guest text to classify (single message, or joined recents)
//   regexHit   — whether CONCIERGE_REGEX already matched (fast-path + fallback)
//   callClaude — async (systemPrompt, userMsg, maxTokens) => string
//   timeoutMs  — hard budget for the AI call (default 4s)
//   log        — optional (err) => void for fallback logging
async function classifyConcierge(text, { regexHit = false, callClaude, timeoutMs = 4000, log } = {}) {
  if (regexHit) return true;                 // fast-path: trust the regex
  if (typeof callClaude !== 'function') return regexHit;
  try {
    const verdict = await withTimeout(callClaude(CLASSIFIER_SYSTEM_PROMPT, String(text || ''), 5), timeoutMs);
    return parseVerdict(verdict);
  } catch (e) {
    if (log) log(e);
    return regexHit;                         // fallback: never worse than regex-only
  }
}

module.exports = { classifyConcierge, parseVerdict, withTimeout, CLASSIFIER_SYSTEM_PROMPT };
