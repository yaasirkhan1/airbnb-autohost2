// Stateful Hospitable mock, loaded via `node --require`. Unlike battle-mock (stateless),
// this PERSISTS the calendar to a JSON file so a PUT in one process is visible to the GET
// in the next — letting us prove rollback across separate runner invocations.
// State lives at data/.rollback-mock-state.json (seeded by rollback-proof.js).
'use strict';
const fs = require('fs');
const path = require('path');
const STATE = path.join(__dirname, '..', 'data', '.rollback-mock-state.json');
const PROP_4L = 'bbe43523-c42a-46b0-8235-7ad08ae990c9';

const load = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = s => fs.writeFileSync(STATE, JSON.stringify(s));
const mk = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });

global.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  // property GET (pre-flight mapping check): 4-L is a 1BR, no dynamic pricing
  if (method === 'GET' && /\/properties\/[^/]+$/.test(url) && !url.includes('calendar')) {
    return mk(200, { data: { id: PROP_4L, capacity: { bedrooms: 1 } } });
  }
  if (method === 'GET') { // calendar GET — reflect current persisted state in range
    const u = new URL(url);
    const s = u.searchParams.get('start_date'), e = u.searchParams.get('end_date');
    const cal = load().cal;
    const days = Object.keys(cal).filter(d => d >= s && d <= e).sort()
      .map(d => ({ date: d, price: { amount: cal[d].price * 100, currency: 'USD' }, status: { available: true }, min_stay: cal[d].minStay }));
    return mk(200, { data: { days } });
  }
  if (method === 'PUT') { // apply the write to persisted state (this is what makes rollback testable)
    const st = load();
    for (const d of JSON.parse(opts.body).dates) {
      const prev = st.cal[d.date] || {};
      st.cal[d.date] = { price: Math.round(d.price.amount / 100), minStay: d.min_stay != null ? d.min_stay : (prev.minStay ?? null) };
    }
    save(st);
    return mk(200, { ok: true });
  }
  return mk(400, {});
};
