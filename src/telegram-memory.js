'use strict';
// Two-layer memory for the Telegram ops bot.
//   HOT  — a rolling per-chat buffer (last ~6 turns OR anything from the past ~7 days) fed into the
//          intent parser on every message so the bot stops re-asking what you just answered. Persisted
//          to the existing volume (STATE_DIR/DATA_DIR), same pattern as every other store here.
//   COLD — turns that age out of the hot window are appended to an archive file and NOT loaded by
//          default. A reach-back query searches the archive, returns only the relevant slice (the
//          caller answers from it via the model), then drops it — you pay for that lookup only then.
//
// NOTE: this project has no database; the "archive" is a JSON file on the same /data volume, matching
// the door-codes / cleaning-overrides / lock-audit stores. Swap to a real DB later without touching
// the pure logic below.
const fs = require('fs');
const path = require('path');

const MAX_HOT_TURNS = 6;
const HOT_MAX_AGE_DAYS = 7;

const dir = () => process.env.STATE_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const HOT_PATH = () => path.join(dir(), 'telegram-memory.json');     // { [chatId]: [ {role,text,ts} ] }
const ARCHIVE_PATH = () => path.join(dir(), 'telegram-archive.json'); // [ {chatId,role,text,ts} ]

// ── pure logic ────────────────────────────────────────────────────────────────
// A turn stays HOT if it's within the last maxTurns OR newer than maxAgeDays (union — the past week
// is always hot even if there were many turns; the last 6 are hot even if older than a week).
function isHotTurn(turn, idx, total, nowMs, { maxTurns = MAX_HOT_TURNS, maxAgeDays = HOT_MAX_AGE_DAYS } = {}) {
  if (idx >= total - maxTurns) return true;
  const ts = Date.parse(turn && turn.ts);
  return Number.isFinite(ts) && (nowMs - ts) <= maxAgeDays * 86400000;
}
function partition(turns, nowMs, opts = {}) {
  const total = (turns || []).length, hot = [], cold = [];
  (turns || []).forEach((t, i) => (isHotTurn(t, i, total, nowMs, opts) ? hot : cold).push(t));
  return { hot, cold };
}
function formatHistory(turns) {
  return (turns || []).map(t => `${t.role === 'host' ? 'Host' : 'Bot'}: ${t.text}`).join('\n');
}

// Reach-back detection — a question that points at the PAST (older than the hot window).
const REACHBACK = /\b(last (week|month|year|time)|a (week|month|while) ago|earlier|previously|back (in|on|when)|what did we (decide|say|do|agree)|remember (when|that|we|the)|the other (day|week|month)|we (decided|discussed|talked about|agreed)|did we|weeks? ago|months? ago)\b/i;
function isReachBack(text) { return REACHBACK.test(String(text || '')); }

// Archive search — token-overlap relevance, scoped to a chat. Returns only the top matches.
const tokenize = s => String(s || '').toLowerCase().match(/[a-z0-9$-]+/g) || [];
function searchArchive(archive, query, { limit = 6, chatId } = {}) {
  const qt = new Set(tokenize(query).filter(w => w.length > 2));
  if (!qt.size) return [];
  return (archive || [])
    .filter(e => chatId == null || e.chatId === chatId)
    .map(e => ({ e, score: tokenize(e.text).filter(w => qt.has(w)).length }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.e);
}

// ── persistence (impure) ────────────────────────────────────────────────────────
function loadHot() { try { return JSON.parse(fs.readFileSync(HOT_PATH(), 'utf8')); } catch { return {}; } }
function saveHot(s) { const p = HOT_PATH(); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(s, null, 2)); }
function loadArchive() { try { return JSON.parse(fs.readFileSync(ARCHIVE_PATH(), 'utf8')); } catch { return []; } }
function saveArchive(a) { const p = ARCHIVE_PATH(); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(a, null, 2)); }

// Record one turn for a chat: append, roll any newly-cold turns to the archive, persist. Returns hot.
function recordTurn(chatId, turn, nowMs = Date.now()) {
  const t = { ts: new Date(nowMs).toISOString(), ...turn };
  const store = loadHot();
  const all = [...(store[String(chatId)] || []), t];
  const { hot, cold } = partition(all, nowMs);
  if (cold.length) saveArchive([...loadArchive(), ...cold.map(c => ({ chatId: String(chatId), ...c }))]);
  store[String(chatId)] = hot;
  saveHot(store);
  return hot;
}
// HOT history for a chat, formatted for the parser (string). Empty string when none.
function getHistory(chatId) { return formatHistory(loadHot()[String(chatId)] || []); }

module.exports = {
  MAX_HOT_TURNS, HOT_MAX_AGE_DAYS, HOT_PATH, ARCHIVE_PATH,
  isHotTurn, partition, formatHistory, isReachBack, searchArchive,
  loadHot, saveHot, loadArchive, saveArchive, recordTurn, getHistory,
};
