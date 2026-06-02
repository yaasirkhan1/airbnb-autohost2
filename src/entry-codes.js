// Per-unit emergency entry codes. The operator sets one permanent Schlage code
// per unit in config/entry-codes.json; when a guest asks for their code, the
// responder looks up THEIR unit and replies with that unit's code.
// No side effects on require — unit-testable.
const fs = require('fs');
const path = require('path');

const CODES_FILE = path.join(__dirname, '..', 'config', 'entry-codes.json');

const norm = s => String(s || '').toLowerCase().replace(/[’‘]/g, "'");

// Matches a guest asking for the door/entry code (handles mobile curly apostrophes).
const ENTRY_CODE_REGEX = new RegExp(
  "(?:entry|door|access|gate|building|key|lock)\\s*code" +
  "|code\\s+(?:to|for)\\s+(?:get\\s+in|get\\s+into|the\\s+door|entry|the\\s+building|unlock)" +
  "|(?:what's|what\\s+is|whats)\\s+(?:the|my)\\s+(?:entry\\s+|door\\s+)?code" +
  "|do\\s+you\\s+have\\s+(?:an?\\s+|my\\s+|the\\s+)?(?:entry\\s+|door\\s+)?code" +
  "|(?:need|send|get)\\s+(?:me\\s+)?(?:the|my|an?)\\s+(?:entry\\s+|door\\s+)?code",
  "i"
);

function isEntryCodeRequest(text) {
  return ENTRY_CODE_REGEX.test(norm(text));
}

/**
 * Load the operator-maintained codes. Prefers the ENTRY_CODES_JSON env var
 * (so real door codes never get committed to git); falls back to the local
 * config file. Missing/corrupt → {}. The "_format" doc key is stripped.
 */
function loadEntryCodes(file = CODES_FILE) {
  if (process.env.ENTRY_CODES_JSON) {
    try { const { _format, ...codes } = JSON.parse(process.env.ENTRY_CODES_JSON); return codes; }
    catch { /* fall through to file */ }
  }
  try {
    const { _format, ...codes } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return codes;
  } catch {
    return {};
  }
}

/**
 * Resolve the entry code for the guest's reservation.
 *   propertyId → propsMap[propertyId].label (unit nickname) → codes[unit].
 * Returns { unit, code } only when a non-empty code exists; otherwise null
 * (so we NEVER send a blank or wrong code — the caller escalates instead).
 */
function resolveEntryCode(propertyId, propsMap, codes) {
  if (!propertyId || !propsMap || !codes) return null;
  const entry = propsMap[propertyId];
  const unit = entry && (entry.label || entry.unit);
  if (!unit) return null;
  const code = codes[unit];
  if (code == null || !String(code).trim()) return null;
  return { unit, code: String(code).trim() };
}

function entryCodeReply(guestName, unit, code) {
  const name = (guestName || 'there').trim().split(/\s+/)[0] || 'there';
  return `Hi ${name}! The entry code for your unit (${unit}) is ${code}. ` +
    `Enter it on the Schlage keypad, then press the Schlage logo to unlock. ` +
    `Let me know if you have any trouble getting in!\n\nBest,\nCal`;
}

module.exports = { isEntryCodeRequest, resolveEntryCode, entryCodeReply, loadEntryCodes, ENTRY_CODE_REGEX, CODES_FILE };
