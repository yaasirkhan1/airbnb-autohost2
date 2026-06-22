'use strict';
// Pure helpers for the Telegram ops bot: which actions require an explicit "yes" before firing,
// how to echo the interpreted change back to the host, and affirmative/negative detection.

// Actions that MUST be confirmed by the host before anything live happens. Everything else fires
// immediately (it's a read or a low-risk, already-reversible cleaning/checkin op).
const CONFIRM_ACTIONS = new Set(['guest_message', 'pricing_adjust', 'pricing_decay_freeze']);

function requiresConfirmation(action) { return CONFIRM_ACTIONS.has(action); }

const AFFIRM = /^(y|ya|yes|yep|yeah|yup|ok|okay|sure|send|send it|do it|go|confirm|confirmed|approved|👍|✅)\.?$/i;
const NEGATE = /^(n|no|nope|nah|cancel|stop|don'?t|do not|abort|never ?mind|nvm|❌)\.?$/i;
const isAffirmative = (t) => AFFIRM.test(String(t || '').trim());
const isNegative = (t) => NEGATE.test(String(t || '').trim());

// One-line echo of a pricing/decay intent so the host sees EXACTLY what will happen before "yes".
function confirmText(intent) {
  switch (intent.action) {
    case 'pricing_adjust': {
      const dir = intent.pct < 0 ? 'Lower' : 'Raise';
      const units = intent.units === 'all' ? 'all 7 units' : intent.units.join(', ');
      return `${dir} prices ${Math.abs(intent.pct)}% for ${units}, ${intent.start} → ${intent.end} (floors/ceilings still apply, reversible). Reply "yes" to apply.`;
    }
    case 'pricing_decay_freeze': {
      return intent.enable
        ? `Freeze automated price decay for the next ${intent.days} day(s) from today — prices you set by hand won't be ratcheted or overwritten. Reply "yes" to apply.`
        : `Turn automated price decay back ON (lift the manual freeze). Reply "yes" to apply.`;
    }
    case 'guest_message':
      return `Draft for ${intent.guest}:`; // the composed text is appended by the caller
    default:
      return 'Reply "yes" to confirm.';
  }
}

module.exports = { CONFIRM_ACTIONS, requiresConfirmation, confirmText, isAffirmative, isNegative };
