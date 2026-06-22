// DRY-RUN transcript for the Telegram ops bot. Drives REAL code — telegram-intent.normalizeIntent
// + telegram-bot.handleUpdate (owner lock, confirmation gating, front-desk resolution) — with the
// Haiku parse step SIMULATED (canned JSON per command, since no ANTHROPIC_API_KEY here) and ALL
// live handlers STUBBED to print "[would …]" instead of sending/changing anything.
// Run: node scripts/telegram-dryrun.js
'use strict';
const intent = require('../src/telegram-intent');
const bot = require('../src/telegram-bot');
const { isAffirmative, isNegative } = require('../src/telegram-actions');

const OWNER = 5550001111;
const upd = (text, fromId = OWNER) => ({ update_id: Math.random(), message: { from: { id: fromId }, chat: { id: OWNER }, text } });

// Simulated Haiku: map each demo command to the JSON the parser prompt asks the model to emit.
// (In production this is a real claude-haiku-4-5 call; the normalizer/validator below is identical.)
const CANNED = {
  'take 24-L off cleaning tomorrow and add 21-i urgent, ready by 4pm':
    { action: 'cleaning_override', confidence: 0.97, ops: [{ op: 'remove', unit: '24-L' }, { op: 'add', unit: '21-I', urgent: true, deadline: '4:00PM' }] },
  'text Veronica: please bring 2 extra towel sets to 7-B':
    { action: 'cleaner_message', confidence: 0.96, message: 'please bring 2 extra towel sets to 7-B' },
  'checkin status today':
    { action: 'checkin_status', confidence: 0.95 },
  'resend checkin to 21-D':
    { action: 'checkin_resend', confidence: 0.95, target: '21-D' },
  'send front desk form for Jordan':
    { action: 'frontdesk_form', confidence: 0.95, name: 'Jordan' },
  'send front desk form for John':
    { action: 'frontdesk_form', confidence: 0.95, name: 'John' },
  'tell Jamie the late checkout at 1:30 is approved, no charge':
    { action: 'guest_message', confidence: 0.95, guest: 'Jamie', gist: 'late checkout at 1:30 approved, no charge' },
  'lower prices June 20-29 5%':
    { action: 'pricing_adjust', confidence: 0.95, pct: -5, start: '2026-06-20', end: '2026-06-29', units: 'all' },
  'turn off decay up to 7 days out so I can set prices manually':
    { action: 'pricing_decay_freeze', confidence: 0.95, enable: true, days: 7 },
  'uhh do the thing with the stuff':
    { action: 'clarify', confidence: 0.2, reason: 'I’m not sure what you mean — what would you like me to do?' },
};

const fakeHaiku = async (_model, _sys, user) => {
  const text = user.split('Host message: ')[1] || '';
  return JSON.stringify(CANNED[text.trim()] || { action: 'clarify', confidence: 0.1, reason: 'unrecognized' });
};

// Stub deps — every live action is replaced with a print-only no-op.
function makeDeps() {
  const pending = new Map();
  const stub = (label) => async (arg) => `   ↪ [would ${label}] ${summarize(arg)}`;
  return {
    ownerId: OWNER, pending, log: { log() {}, error() {} },
    parse: (text) => intent.parseIntent({ text, callClaude: fakeHaiku, today: '2026-06-22' }),
    compose: async ({ guest, gist }) => `Hi ${guest.name.split(' ')[0]}! Quick note — ${gist}. Anything you need, just say the word. Warmly, Cal`,
    resolveGuest: async (name) => ({ status: 'one', guest: { label: `${name} Rivera — 21-I, in 2026-06-22`, name: `${name} Rivera`, id: 'res_demo', resourceType: 'reservation', propertyName: '21-I' } }),
    handlers: {
      cleaning_override: async (i) => `   ↪ [would POST /api/cleaning-override] ${i.ops.map(o => `${o.op} ${o.unit}${o.urgent ? ' urgent' : ''}`).join(', ')}`,
      cleaner_message: async (i) => `   ↪ [would POST /api/cleaner-message] "${i.message}"`,
      checkin_status: async () => `   ↪ [would run check-in sweep DRY-RUN] summary: 2 arriving, 1 already sent, 1 to send`,
      checkin_resend: async (i) => `   ↪ [would resend check-in] target=${i.target}`,
      frontdesk_form: async (i) => i.name === 'John'
        ? `More than one arrival matches “John” today: John Smith (21-I), John Doe (4-L). Which one?`
        : `   ↪ [would fire concierge/front-desk contingency] for ${i.name} (single arrival match)`,
      guest_message_send: async ({ guest, text }) => `   ↪ [would POST guest message to ${guest.name}'s thread] "${text}"`,
      pricing_adjust: async (i) => `   ↪ [would POST /api/pricing/adjust] ${i.pct}% ${i.start}→${i.end} units=${i.units}`,
      pricing_decay_freeze: async (i) => `   ↪ [would POST /api/pricing/decay-freeze] enable=${i.enable} days=${i.days}`,
    },
  };
}
function summarize(a) { return typeof a === 'object' ? JSON.stringify(a) : String(a); }

async function feed(deps, text, fromId = OWNER) {
  const out = await bot.handleUpdate(upd(text, fromId), deps);
  const who = fromId === OWNER ? 'OWNER' : `USER ${fromId}`;
  console.log(`\n📲 ${who}: ${text}`);
  if (out.ignored) { console.log('   ⛔ IGNORED (not the owner / no text)'); return out; }
  // Show the parsed action only for fresh commands — a "yes"/"no" is a confirmation, not a command.
  if (!isAffirmative(text) && !isNegative(text)) {
    const parsed = await deps.parse(text).catch(() => null);
    if (parsed) console.log(`   ⟶ parsed action: ${parsed.action}${parsed.confidence != null ? ` (conf ${parsed.confidence})` : ''}`);
  } else {
    console.log(`   ⟶ (confirmation reply)`);
  }
  for (const reply of out.replies) console.log(`   🤖 ${reply.replace(/\n/g, '\n      ')}`);
  if (out.fired) console.log(`   ✅ fired: ${out.fired}`);
  return out;
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' TELEGRAM OPS BOT — DRY RUN (no real sends / no price changes)');
  console.log('═══════════════════════════════════════════════════════════════');

  console.log('\n── SECURITY: non-owner is ignored entirely ──');
  await feed(makeDeps(), 'add 21-I urgent', 999999 /* attacker */);

  console.log('\n\n── IMMEDIATE commands (fire, then confirm) ──');
  await feed(makeDeps(), 'take 24-L off cleaning tomorrow and add 21-i urgent, ready by 4pm');
  await feed(makeDeps(), 'text Veronica: please bring 2 extra towel sets to 7-B');
  await feed(makeDeps(), 'checkin status today');
  await feed(makeDeps(), 'resend checkin to 21-D');
  await feed(makeDeps(), 'send front desk form for Jordan');
  console.log('\n   (front-desk name that is ambiguous → asks, does NOT fire)');
  await feed(makeDeps(), 'send front desk form for John');

  console.log('\n\n── CONFIRM-FIRST: guest message (compose → echo → send on "yes") ──');
  {
    const d = makeDeps();
    await feed(d, 'tell Jamie the late checkout at 1:30 is approved, no charge');
    await feed(d, 'yes');
  }

  console.log('\n\n── CONFIRM-FIRST: pricing adjust (echo → apply on "yes") ──');
  {
    const d = makeDeps();
    await feed(d, 'lower prices June 20-29 5%');
    await feed(d, 'yes');
  }

  console.log('\n\n── CONFIRM-FIRST: decay freeze (echo → cancel on "no") ──');
  {
    const d = makeDeps();
    await feed(d, 'turn off decay up to 7 days out so I can set prices manually');
    await feed(d, 'no');
  }

  console.log('\n\n── AMBIGUOUS: bot asks rather than guessing ──');
  await feed(makeDeps(), 'uhh do the thing with the stuff');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' END DRY RUN — nothing was sent, no price moved.');
  console.log('═══════════════════════════════════════════════════════════════');
})();
