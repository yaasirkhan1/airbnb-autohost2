'use strict';
// Tests for the Telegram two-layer memory. Uses a throwaway STATE_DIR so it never touches real data.
const os = require('os'), fs = require('fs'), path = require('path');
process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mem-'));

const mem = require('../src/telegram-memory');
const bot = require('../src/telegram-bot');

let pass = 0, fail = 0;
const check = (n, fn) => { (async () => { try { if ((await fn()) === false) throw new Error('false'); console.log(`✓ ${n}`); pass++; } catch (e) { console.log(`✗ ${n} — ${e.message}`); fail++; } })(); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); return true; };
const DAY = 86400000;
const reset = () => { try { fs.rmSync(mem.HOT_PATH(), { force: true }); fs.rmSync(mem.ARCHIVE_PATH(), { force: true }); } catch {} };

// ── pure: hot/cold partition (union of last-6 OR past-week) ──────────────────
check('partition: a turn older than a week AND beyond last-6 → COLD', () => {
  const now = Date.parse('2026-06-26T12:00:00Z');
  const turns = [];
  for (let i = 0; i < 10; i++) turns.push({ role: 'host', text: `t${i}`, ts: new Date(now - (20 - i) * DAY).toISOString() }); // t0..t3 are >7d old & not last-6
  const { hot, cold } = mem.partition(turns, now);
  ok(cold.length >= 1, 'some cold');
  ok(hot.slice(-6).length === 6, 'last 6 hot');
  ok(cold.every(c => !hot.includes(c)), 'disjoint');
  return true;
});
check('partition: recent turns within the week stay HOT even beyond last-6', () => {
  const now = Date.now();
  const turns = []; for (let i = 0; i < 12; i++) turns.push({ role: 'host', text: `r${i}`, ts: new Date(now - i * 3600000).toISOString() }); // all within hours
  return mem.partition(turns, now).cold.length === 0;
});

// ── pure: reach-back detection ──────────────────────────────────────────────
for (const t of ['what did we decide about 21-I last month?', 'remember when we set the price', 'a few weeks ago we discussed this', 'did we change 4-L?'])
  check(`reach-back: "${t}"`, () => mem.isReachBack(t) === true);
for (const t of ['add 21-I to cleaning tomorrow', 'lower prices 5%', '21-I'])
  check(`NOT reach-back: "${t}"`, () => mem.isReachBack(t) === false);

// ── pure: archive search relevance ──────────────────────────────────────────
check('searchArchive returns the relevant old turn, scoped to chat', () => {
  const archive = [
    { chatId: '7', role: 'host', text: 'we decided 21-I stays at $122 for the World Cup nights' },
    { chatId: '7', role: 'host', text: 'cleaning schedule moved to 10pm' },
    { chatId: '9', role: 'host', text: '21-I something else entirely on another chat' },
  ];
  const hits = mem.searchArchive(archive, 'what did we decide about 21-I price', { chatId: '7' });
  ok(hits.length >= 1, 'has hit'); ok(/\$122/.test(hits[0].text), 'most relevant first'); ok(hits.every(h => h.chatId === '7'), 'scoped');
  return true;
});

// ── persistence: recordTurn rolls aged-out turns into the COLD archive ───────
check('recordTurn persists HOT and archives COLD', () => {
  reset();
  const now = Date.parse('2026-06-26T12:00:00Z');
  // seed 8 turns, the first 2 are 30 days old (cold), rest fresh
  for (let i = 0; i < 8; i++) {
    const ts = i < 2 ? now - 30 * DAY : now;
    mem.recordTurn('7', { role: 'host', text: `m${i}` }, ts);
  }
  const hot = mem.loadHot()['7'] || [];
  const arch = mem.loadArchive();
  ok(hot.length <= 8 && hot.length >= 6, `hot kept recent (${hot.length})`);
  ok(arch.some(a => a.text === 'm0' || a.text === 'm1'), 'old turns archived');
  ok(!hot.some(h => h.text === 'm0'), 'archived turn not in hot');
  return true;
});

// helper to drive handleUpdate as the owner
const OWNER = 7;
const upd = (text) => ({ message: { from: { id: OWNER }, chat: { id: OWNER }, text } });
const memDeps = () => ({
  getHistory: (id) => mem.getHistory(id), recordTurn: (id, t) => mem.recordTurn(id, t),
  isReachBack: (t) => mem.isReachBack(t), pending: new Map(), ownerId: OWNER,
});

// ── SCENARIO 1: clarify → answer resolves (no re-asking) ────────────────────
check('SCENARIO 1: answering a clarifying question resolves via HOT history (no re-ask)', async () => {
  reset();
  // fake parser: resolves "21-I" to an action ONLY when the history shows the prior "which unit?".
  const parse = async (text, history) => {
    if (/which unit/i.test(history || '') && /21-?i/i.test(text)) return { action: 'cleaning_override', unit: '21-I' };
    if (/cleaning/i.test(text)) return { action: 'clarify', reason: 'Which unit?' };
    return { action: 'clarify', reason: 'Which unit?' };
  };
  const fired = [];
  const deps = { ...memDeps(), parse, handlers: { cleaning_override: async (i) => { fired.push(i.unit); return `Added ${i.unit} to cleaning.`; } } };

  // control: without history, "21-I" alone re-clarifies
  ok((await parse('21-I', '')).action === 'clarify', 'control: no history → clarify');

  const r1 = await bot.handleUpdate(upd('add to cleaning tomorrow'), deps);
  ok(/which unit/i.test(r1.replies[0]), 'turn 1 asks which unit');
  const r2 = await bot.handleUpdate(upd('21-I'), deps);
  ok(r2.fired === 'cleaning_override' && fired[0] === '21-I', `turn 2 RESOLVED (fired=${r2.fired})`);
  ok(/Added 21-I/.test(r2.replies[0]), 'acted on the answer instead of re-asking');
  return true;
});

// ── SCENARIO 2: reach-back pulls an old fact from the COLD archive ───────────
check('SCENARIO 2: a reach-back query pulls an OLD fact from the cold archive', async () => {
  reset();
  // archive an old decision; ensure it is NOT in the hot buffer
  mem.saveArchive([{ chatId: String(OWNER), role: 'host', text: 'we decided 21-I stays at $122 for the World Cup nights', ts: new Date(Date.now() - 40 * DAY).toISOString() }]);
  ok(!/\$122/.test(mem.getHistory(OWNER)), 'old fact is NOT in hot buffer');

  const recall = async (chatId, query) => {  // retrieval proven without an LLM call
    const hits = mem.searchArchive(mem.loadArchive(), query, { chatId: String(chatId) });
    return hits.length ? `From the archive: ${hits[0].text}` : 'nothing found';
  };
  const deps = { ...memDeps(), parse: async () => ({ action: 'clarify', reason: 'n/a' }), handlers: {}, recall };

  const r = await bot.handleUpdate(upd('what did we decide about 21-I last month?'), deps);
  ok(/21-I/.test(r.replies[0]) && /\$122/.test(r.replies[0]), `pulled old fact: "${r.replies[0]}"`);
  return true;
});

setTimeout(() => {
  try { fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 300);
