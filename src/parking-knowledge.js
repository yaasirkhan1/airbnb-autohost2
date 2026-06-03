// Parking knowledge base loader + prompt wiring.
//
// Parking questions used to short-circuit to a single hardcoded PARKING_REPLY
// block (one generic answer for every question, with prices/addresses that were
// never verified). Instead we now route parking to the Claude reply layer with
// src/knowledge/parking.md injected as authoritative reference, so each guest
// gets a specific answer grounded ONLY in verified facts.
//
// This module is side-effect-free on require (pure functions + a file read on
// demand), so it is unit-testable offline. server.js wires it into draftReply.

const fs = require('fs');
const path = require('path');

// Static reference shipped in the repo (NOT the STATE_DIR volume).
const PARKING_FILE = path.join(__dirname, 'knowledge', 'parking.md');

/** Read parking.md verbatim. Missing/unreadable → '' (feature degrades, no crash). */
function loadParkingKB(file = PARKING_FILE) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Does this guest message warrant the parking knowledge base? Kept broad enough
// to catch garages / parking apps, narrow enough to skip unrelated messages.
function isParkingQuestion(text) {
  return /\bpark(ing|ed)?\b|\bgarage\b|\bvalet\b|spothero|parkmobile/i.test(String(text || ''));
}

// The system-prompt block injected when a message is a parking question. Restates
// parking.md's SHIP-AS-IS DIRECTIVE / ANSWER GUIDANCE as hard rules, then appends
// the file verbatim so Claude answers from verified facts only. Empty kb → ''.
function buildParkingSection(kb = loadParkingKB()) {
  if (!kb) return '';
  return `\nPARKING KNOWLEDGE BASE (authoritative — when the guest asks about parking, follow this section's SHIP-AS-IS DIRECTIVE and ANSWER GUIDANCE exactly):
- Answer the SPECIFIC parking question the guest asked; do NOT paste a generic block or list every garage.
- Use ONLY facts tagged [VERIFIED] or [GUEST-REPORTED]. NEVER state anything tagged [VERIFY], [VERIFY price], or [YOUR INPUT] as fact — if the answer depends on one of those, tell the guest the live detail is best confirmed on SpotHero/ParkMobile rather than quoting a number.
- ALWAYS be helpful: a parking question should get a useful reply, so set "confident": true and NEVER return an empty reply for one. If the EXACT thing asked is only in an unconfirmed [YOUR INPUT]/[VERIFY] field (e.g. whether the building has its own or free on-site parking), do not claim it either way — briefly say you can't confirm that specific point, then give the guest the VERIFIED nearby options and point them to SpotHero. (Only the front-desk/concierge and door-code situations escalate; parking does not.)
- NEVER mention break-ins, theft, crime, vandalism, or safety incidents. The 🔒 INTERNAL ONLY notes are only for deciding which lots to recommend, never to repeat to a guest.
- For live rates/availability, point the guest to SpotHero (spothero.com) or ParkMobile (parkmobile.io).
- ALWAYS close a parking reply with the required disclaimer: downtown Atlanta rates/hours/policies change quickly (especially around events), so confirm current details with the lot or on SpotHero before parking.

${kb}\n`;
}

module.exports = { loadParkingKB, isParkingQuestion, buildParkingSection, PARKING_FILE };
