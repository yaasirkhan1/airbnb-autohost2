// Restaurant knowledge base loader + prompt wiring. Mirrors parking-knowledge.js:
// src/knowledge/restaurants.md is injected into draftReply ONLY when the guest asks
// about food/restaurants (topic-gated, like parking), so the prompt stays lean otherwise.
//
// Side-effect-free on require (pure functions + an on-demand file read), so it is
// unit-testable offline. server.js wires buildRestaurantSection() into draftReply.

const fs = require('fs');
const path = require('path');

// Static reference shipped in the repo (NOT the STATE_DIR volume).
const RESTAURANT_FILE = path.join(__dirname, 'knowledge', 'restaurants.md');

/** Read restaurants.md verbatim. Missing/unreadable → '' (feature degrades, no crash). */
function loadRestaurantKB(file = RESTAURANT_FILE) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Does this guest message warrant the restaurant knowledge base? Broad enough to catch
// cuisine names and meal words, narrow enough to skip unrelated messages.
function isRestaurantQuestion(text) {
  const t = String(text || '');
  // Meal/food intent + cuisine names. Kept broad on cuisines on purpose: a request for a cuisine NOT
  // in the file (e.g. "Korean BBQ") must still gate the KB in, so the agent can offer the closest
  // in-house match instead of escalating with an empty reply.
  return /\b(restaurants?|food|eat|eatery|dining|dinner|lunch|brunch|breakfast|coffee|caf[eé]|hungry|cuisine|menu|takeout|delivery|reservations?|steakhouse|steak|sushi|sashimi|ramen|noodles?|pho|dim\s*sum|pizza|burgers?|wings?|bbq|barbe?cue|seafood|oysters?|vegan|vegetarian|tacos?|deli|diner|bakery|dessert|gelato|tapas|gastropub|grill|mexican|italian|thai|indian|chinese|japanese|korean|vietnamese|mediterranean|greek|halal|southern|soul\s*food)\b/i.test(t) ||
    /\bwhere\b.{0,20}\b(to|should|can|do)\b.{0,15}\b(eat|grab (a bite|food|dinner|lunch|breakfast)|get food)\b/i.test(t);
}

// The system-prompt block injected when a message is a restaurant question. Restates the file's
// HOW TO USE / RULES as hard rules, then appends the file verbatim so Claude recommends from it.
// Empty kb → ''.
function buildRestaurantSection(kb = loadRestaurantKB()) {
  if (!kb) return '';
  return `\nRESTAURANT KNOWLEDGE BASE (authoritative — when the guest asks about food/restaurants, recommend from this section):
- Match the guest's request to a category and recommend 2–3 options, leading with the closest, highest-rated ([TOP PICK]). NEVER paste the whole list or every category.
- Mention each pick's rating and approximate walk distance. Keep the SALES/SERVICE tone per the two-mode rule.
- NEVER promise a place is open or state its current hours — ratings/categories are as of the build date and hours change. Tell the guest to confirm hours directly or on Google before heading over.
- Do NOT quote menu prices as fixed: use the $ tier only as a general guide ($ = budget … $$$$ = high-end).
- If the guest wants something not in this file, offer the CLOSEST category match from it and keep the recommendation in-house as Cal — do NOT tell the guest to go look it up themselves.
- A restaurant question always gets a helpful reply: set "confident": true and never return an empty reply.

${kb}\n`;
}

module.exports = { loadRestaurantKB, isRestaurantQuestion, buildRestaurantSection, RESTAURANT_FILE };
