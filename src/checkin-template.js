'use strict';
// Check-in-instructions message template. PURE / no side effects.
//
// resolveCheckin() pulls the reservation + property fields and binds the door code to the
// reservation's OWN unit (propertyId → propsMap label → that unit's code via door-codes.getDoorCode),
// so the rendered message can never carry another unit's code. It also reports `missing` for any
// field it could not fill — we leave those blank and flag them rather than fabricate (esp. Wi-Fi,
// which is NOT available from the Hospitable reservation/properties-map today).
//
// ⚠️ WORDING: the body of renderCheckinInstructions() is a DRAFT reconstruction of the host's
// standard check-in message (building front-desk + Schlage keypad format). Confirm/replace the
// exact wording before this is ever sent.
const doorCodes = require('./door-codes');

// "16:00" → "4:00 PM"; passes through anything it can't parse.
function fmtTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return t || null;
  let h = parseInt(m[1], 10); const min = m[2];
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${h}:${min} ${ap}`;
}

const propertyIdOf = r =>
  r.listing_id || r.property_id || r.propertyId || (r.listing && r.listing.id) || null;

const firstName = r => {
  const n = (r.guest && (r.guest.first_name || r.guest.name)) || r.guest_name || '';
  return String(n).trim().split(/\s+/)[0] || null;
};

/**
 * Resolve all template fields for a reservation. Returns { fields, missing }.
 * The door code is looked up ONLY for this reservation's unit — never a default/other unit.
 */
function resolveCheckin(reservation, propsMap, doorCodeStore, opts = {}) {
  const propertyId = propertyIdOf(reservation);
  const prop = (propsMap || {})[propertyId] || {};
  const unit = prop.label || prop.unit || null;
  const dc = unit ? doorCodes.getDoorCode(doorCodeStore, unit) : null;   // bound to THIS unit only
  const wifi = unit ? doorCodes.getWifi(doorCodeStore, unit) : null;     // bound to THIS unit only

  const fields = {
    guestName: firstName(reservation),
    // Sign-off name varies by the responding host ACCOUNT — supplied by the caller (the sweep,
    // which knows which account is replying); falls back to a per-property/reservation host name
    // if present. Never hardcoded. Flagged missing if no source resolves it.
    hostName: opts.hostName || prop.host_name
      || (reservation.host && (reservation.host.first_name || reservation.host.name)) || null,
    propertyName: prop.public_name || (reservation.listing && reservation.listing.name) || null,
    address: prop.address || null,
    unit,
    doorCode: dc ? dc.code : null,
    checkInDate: reservation.check_in || reservation.arrival_date || reservation.arrival || null,
    checkOutDate: reservation.check_out || reservation.departure_date || reservation.departure || null,
    checkInTime: prop.checkin || null,
    checkOutTime: prop.checkout || null,
    // Wi-Fi from the per-unit store (default rule: SSID = unit label, password = shared; explicit
    // per-unit values override). Bound to this reservation's unit only.
    wifiName: wifi ? wifi.name : null,
    wifiPassword: wifi ? wifi.password : null,
  };

  const required = ['guestName', 'hostName', 'propertyName', 'unit', 'doorCode', 'checkInDate', 'checkOutDate'];
  const missing = required.filter(k => !fields[k]);
  if (!fields.wifiName || !fields.wifiPassword) missing.push('wifi');
  return { fields, missing };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// ISO date ("2026-06-20") → "Saturday, June 20" (noon-UTC anchor avoids a TZ off-by-one). Anything
// not an ISO date passes through unchanged.
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return iso || null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const MISSING = '⚠️ [missing]';
// The host's template hardcodes this address; it is NOT taken from properties-map and never changes.
const FIXED_ADDRESS = '300 Peachtree Street Northeast, Atlanta, GA 30308, United States';

/**
 * Render the host's EXACT check-in template, filling ONLY the {bracketed} variables. Every fixed
 * line (address, Access Instructions, Important Notes, sign-off) and all spacing/line breaks are
 * verbatim. Any unfilled variable renders a visible ⚠️ flag — never fabricated (esp. Wi-Fi, which
 * has no source today).
 */
function renderCheckinInstructions(f) {
  const v = x => (x == null || x === '' ? MISSING : x);
  const doorCode = v(f.doorCode);
  return `Hi ${v(f.guestName)},
We're excited to host you! Here are the details for your stay:

📍 Property: ${v(f.propertyName)}
📍 Address: ${FIXED_ADDRESS}
📅 Stay Dates: ${v(fmtDate(f.checkInDate))} to ${v(fmtDate(f.checkOutDate))}
⏰ Check-in: ${v(fmtTime(f.checkInTime))}
⏰ Check-out: ${v(fmtTime(f.checkOutTime))}
📶 Wi-Fi: ${v(f.wifiName)} | Password: ${v(f.wifiPassword)}
🔑 Door Code: ${doorCode}

Access Instructions: When you arrive to the building, check in with front desk to register (provide them your unit number and government ID). After that, you head on up to the unit and enter your unique door code below to access your condo. To lock the door when you exit, enter the same code.

Unit Number: ${v(f.unit)}
Door Code: ${doorCode}

Important Notes:
✔ ID is required for check-in. The reservation holder must be present—no exceptions.
✔ Late check-in (after 10:30 PM): If you arrive late, host support may be unavailable until 10 AM. However, the building concierge is available 24/7 to assist with check-in and parking details.

If you have any questions, feel free to reach out. Safe travels, and we look forward to your stay!

All the Best,
${v(f.hostName)}`;
}

module.exports = { resolveCheckin, renderCheckinInstructions, fmtTime };
