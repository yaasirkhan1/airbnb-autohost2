// Convention hotels & venues knowledge base loader + prompt wiring. Mirrors
// restaurant-knowledge.js / parking-knowledge.js: src/knowledge/conventions.md is injected into
// draftReply ONLY when the guest asks about a convention / trade show / one of the convention
// venues or hotels (topic-gated), so the prompt stays lean otherwise.
//
// Side-effect-free on require (pure functions + an on-demand file read), so it is unit-testable
// offline. server.js wires buildConventionSection() into draftReply.

const fs = require('fs');
const path = require('path');

// Static reference shipped in the repo (NOT the STATE_DIR volume).
const CONVENTION_FILE = path.join(__dirname, 'knowledge', 'conventions.md');

/** Read conventions.md verbatim. Missing/unreadable → '' (feature degrades, no crash). */
function loadConventionKB(file = CONVENTION_FILE) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Does this guest message warrant the convention knowledge base? Catches convention/trade-show
// intent AND the proper names of the anchor venues + convention hotels (so "my conference is at
// the Hyatt" or "how far is GWCC?" both gate it in).
function isConventionQuestion(text) {
  const t = String(text || '');
  return /\b(convention|conventions|trade\s?show|tradeshow|trade\s?fair|expo|exposition|conference|congress|convention\s+center|showroom|exhibitor|americasmart|americas\s?mart|market\s?week|gwcc|world\s+congress|peachtree\s+center)\b/i.test(t) ||
    // Convention-hotel proper names (place the property relative to a guest's event hotel).
    /\b(hyatt\s+regency|marriott\s+marquis|marquis|westin\s+peachtree|the\s+westin|hilton\s+atlanta|courtland\s+grand|sheraton)\b/i.test(t);
}

// The system-prompt block injected when a message is a convention question. Restates the file's
// HOW TO USE rules as hard rules, then appends the file verbatim. Empty kb → ''.
function buildConventionSection(kb = loadConventionKB()) {
  if (!kb) return '';
  return `\nCONVENTION HOTELS & VENUES KNOWLEDGE BASE (authoritative — when the guest mentions a convention, trade show, market, or one of these venues/hotels, use this section):
- LEAD with how close the property is and frame the location as a major convenience; proximity is the #1 selling point.
- Use ONLY the location/proximity facts here (distances, blocks, which hotel is across the street). Do NOT promise event schedules, room rates, or hotel-specific details not in this file.
- Place the property relative to the guest's event hotel/venue when they name one (e.g. "the Hyatt Regency is directly across the street").
- Keep the SALES/SERVICE tone per the two-mode rule: an inquiry → sell walkability/convenience hard; a booked guest → clear, friendly directions.
- A convention/proximity question always gets a helpful reply: set "confident": true and never return an empty reply.

${kb}\n`;
}

module.exports = { loadConventionKB, isConventionQuestion, buildConventionSection, CONVENTION_FILE };
