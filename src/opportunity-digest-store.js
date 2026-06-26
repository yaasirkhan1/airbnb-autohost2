'use strict';
// Persisted pending digest (volume), so the morning cron and the long-poll bot share state and it
// survives a redeploy mid-review. Keyed by chatId → { date, items }. Same store pattern as the rest.
const fs = require('fs');
const path = require('path');

const storePath = () =>
  path.join(process.env.STATE_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'opportunity-digest.json');

function loadAll() { try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { return {}; } }
function saveAll(s) { const p = storePath(); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(s, null, 2)); }

function get(chatId) { return loadAll()[String(chatId)] || null; }
function set(chatId, digest) { const s = loadAll(); s[String(chatId)] = digest; saveAll(s); }
function clear(chatId) { const s = loadAll(); delete s[String(chatId)]; saveAll(s); }

module.exports = { storePath, get, set, clear };
