// Parse a draft-reply model response. The expected shape is a JSON envelope
// { confident, reply }, but the model intermittently answers in plain prose with no
// JSON. The old parser escalated ANY non-JSON output as low-confidence, which dropped a
// perfectly good reply (prod incident: guest "Mekhi" asked to extend the stay; Claude
// returned "Hi Mekhi, …" as prose → no {…} → escalated → guest got nothing).
//
// Tiers:
//   1. valid JSON object        → use { confident, reply } as-is.
//   2. no JSON, substantive prose → recover the prose as the reply (confident).
//   3. empty / refusal prose, or malformed JSON (had a { but won't parse) → escalate.
// Pure + dependency-free → unit-testable.

// Conservative refusal match: a short, clearly non-answering message. Kept tight (and
// length-capped) so a genuine reply that merely opens with an apology
// ("I'm sorry for the wait — here's the WiFi…") is NOT mistaken for a refusal.
const REFUSAL_RE = /\b(can'?t|cannot|unable to|not able to|don'?t)\s+(help|assist|answer|provide|do that|with that)\b/i;

function isRefusal(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  return REFUSAL_RE.test(t) && t.length < 200;
}

function parseDraftReply(raw) {
  const text = String(raw == null ? '' : raw);
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const reply = (parsed.reply || '').trim();
      const confident = parsed.confident !== false && reply.length > 0;
      return { reply: reply || null, confident, source: 'json' };
    } catch {
      // Looked like JSON but didn't parse — never ship braces/garbage to the guest.
      return { reply: null, confident: false, source: 'malformed-json' };
    }
  }

  // No complete JSON object → the model replied in plain prose. Recover it unless it's
  // empty, a refusal, or a broken JSON attempt (e.g. truncated `{"reply": "…` with no
  // closing brace — shipping that to a guest would leak braces/keys).
  const prose = text.trim();
  if (!prose || isRefusal(prose)) return { reply: null, confident: false, source: 'empty-or-refusal' };
  if (/^\{/.test(prose) || /"(confident|reply)"\s*:/.test(prose)) {
    return { reply: null, confident: false, source: 'malformed-json' };
  }
  return { reply: prose, confident: true, source: 'prose-fallback' };
}

module.exports = { parseDraftReply, isRefusal };
