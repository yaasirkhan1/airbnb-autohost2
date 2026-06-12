'use strict';
// Host-curated knowledge facts for the guest auto-responder. The host adds facts in plain English
// from their phone ("remember: guests asking about X should be told Y" / "forget the fact about X");
// Claude POSTs to /api/knowledge, which records them here. draftReply reads this store AT CALL TIME
// and injects a clearly-scoped HOST-ADDED FACTS section into the system prompt — explicitly
// SUBORDINATE to every existing guardrail (parking rules, stadium framing, price/policy facts, the
// confident:false escalation). These facts are ONLY ever the ones the host explicitly adds — the
// profile learner never writes here, so nothing is auto-learned from guest threads.
//
// Persisted to the mounted volume (STATE_DIR/DATA_DIR) like cleaning-overrides.json, so host-added
// facts survive a redeploy. Scope is ALL-UNITS for now: every fact applies to all Atlanta
// properties. The shape carries a `scope` field so per-unit targeting can be added later WITHOUT a
// rewrite (see factsForProperty).
const fs = require('fs');
const path = require('path');

const storePath = () =>
  path.join(process.env.STATE_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'host-facts.json');

// ── pure logic (unit-tested) ─────────────────────────────────────────────────

// Topic → stable id/key. Lowercase, trim, collapse to a slug. The topic is the natural key:
// a new fact on the same topic SUPERSEDES the old one (no duplicates).
function slugTopic(topic) {
  return String(topic || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Add (or supersede) a fact. Returns a NEW array. A fact whose topic slug matches an existing one
// replaces it. scope defaults to 'all' (every property); pass an array of property ids for per-unit
// targeting later. `now` is injectable for deterministic tests.
function addFact(facts, { topic, fact, scope = 'all' } = {}, now = Date.now()) {
  const id = slugTopic(topic);
  if (!id || !String(fact || '').trim()) return (facts || []).slice(); // ignore empty add
  const kept = (facts || []).filter(f => f.id !== id); // supersede same-topic
  return [...kept, { id, topic: String(topic).trim(), fact: String(fact).trim(), scope, addedAt: now }];
}

// Remove a fact by topic. Returns { facts, removed }.
function removeFact(facts, topic) {
  const id = slugTopic(topic);
  const before = (facts || []).length;
  const out = (facts || []).filter(f => f.id !== id);
  return { facts: out, removed: out.length !== before };
}

// Select the facts that apply to a property. Today every fact is scope 'all'. The propertyId
// branch is where per-unit targeting slots in later (scope as an array of ids) — no rewrite needed.
function factsForProperty(facts, propertyId = null) {
  return (facts || []).filter(f =>
    f.scope === 'all' || (Array.isArray(f.scope) && propertyId && f.scope.includes(propertyId)));
}

// Render the HOST-ADDED FACTS prompt section. Returns '' when there are no facts (keeps the prompt
// lean). The subordination clause is ALWAYS present whenever any fact is shown — that is the
// guardrail: a host fact can never override parking/stadium/price/policy rules or confident:false.
//
// WHOLE-LIST injection for now (small list → let the model pick the matching fact). TOPIC-GATING
// slots in HERE later: filter `facts` by keyword/topic match against the guest message before
// rendering (mirroring isParkingQuestion), instead of rendering all of them.
function buildFactsSection(facts) {
  const list = facts || [];
  if (list.length === 0) return '';
  const lines = list.map(f => `- When a guest asks about ${f.topic}: ${f.fact}`).join('\n');
  return `\nHOST-ADDED FACTS (host-curated, authoritative for their specific topic; apply to all properties):
${lines}

Rules for HOST-ADDED FACTS — these are SUBORDINATE to every guardrail above:
- Use a fact ONLY when the guest's question is specifically about that fact's topic; otherwise ignore it entirely (do not let a stray keyword pull in an unrelated fact).
- A host fact NEVER overrides the parking rules, the Mercedes-Benz Stadium framing, any price/policy/fee facts, or any safety guardrail. If a fact conflicts with any of those, follow the guardrail and ignore the fact.
- A host fact never relaxes the confident:false escalation rule: if you are unsure the fact actually answers the question, set "confident": false rather than stretching it.\n`;
}

// ── persistence (impure) ─────────────────────────────────────────────────────
function loadStore() { try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { return []; } }
function saveStore(facts) {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(facts || [], null, 2));
}

module.exports = {
  slugTopic, addFact, removeFact, factsForProperty, buildFactsSection, loadStore, saveStore, storePath,
};
