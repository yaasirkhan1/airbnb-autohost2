// Battle-test harness: mocks global.fetch so the REAL runner runs against simulated
// Hospitable responses. No real network. usage: node scripts/battle-mock.js <scenario>
'use strict';
const scenario = process.argv[2];
const path = require('path');

const ARGS = {
  noop:       ['--unit','4-L','--start','2026-11-04','--end','2026-11-05','--confirm','--batch','30','--override-sanity'],
  r429:       ['--unit','4-L','--start','2026-11-04','--end','2026-11-05','--confirm','--override-sanity'],
  r500:       ['--unit','4-L','--start','2026-11-04','--end','2026-11-05','--confirm','--override-sanity'],
  netdrop:    ['--unit','4-L','--start','2026-11-04','--end','2026-11-05','--confirm','--override-sanity'],
  currency:   ['--unit','4-L','--start','2026-11-04','--end','2026-11-05'], // dry-run: show misread
  partial422: ['--unit','4-L,7-B','--start','2026-11-04','--end','2026-11-05','--confirm','--override-sanity'],
  minstay:    ['--unit','4-L','--start','2026-09-04','--end','2026-09-04','--confirm','--batch','30','--override-sanity'],
};
process.argv = ['node','runner', ...(ARGS[scenario]||[])];

const qs = url => Object.fromEntries(new URL('http://x'+url.slice(url.indexOf('/'))).searchParams);
const daysInclusive = (s,e) => { const out=[]; let d=new Date(s+'T00:00:00Z'); const end=new Date(e+'T00:00:00Z'); for(;d<=end;d.setUTCDate(d.getUTCDate()+1)) out.push(d.toISOString().slice(0,10)); return out; };
const mk = (status, obj) => ({ ok: status>=200&&status<300, status, text: async()=>JSON.stringify(obj) });
const calOf = (dates, amountCents, minStay=null, avail=true) => ({ data: { days: dates.map(date=>({ date, price:{amount:amountCents,currency:'USD'}, status:{available:avail,reason:avail?'AVAILABLE':'RESERVED'}, min_stay:minStay })) } });

let getN = 0, lastPut = null;
global.fetch = async (url, opts={}) => {
  const method = opts.method || 'GET';
  if (method === 'GET') {
    getN++;
    const { start_date, end_date } = qs(url);
    const ds = daysInclusive(start_date, end_date);
    // currency scenario: return amounts in DOLLARS (100) instead of cents (10000)
    if (scenario === 'currency') return mk(200, calOf(ds, 100));            // $100 stored as "100" → runner reads 100/100=$1
    // read-back GET (the 2nd+ GET, after a PUT)
    if (lastPut && getN >= 2) {
      if (scenario === 'noop')    return mk(200, calOf(ds, 10000));         // PUT "succeeded" but calendar UNCHANGED ($100)
      if (scenario === 'minstay') return mk(200, { data: { days: lastPut.map(d=>({ date:d.date, price:{amount:d.price.amount,currency:'USD'}, status:{available:true}, min_stay:null })) } }); // price took, min_stay dropped
    }
    return mk(200, calOf(ds, 10000)); // initial fetch: current = $100, available
  }
  // PUT
  if (method === 'PUT') {
    try { lastPut = JSON.parse(opts.body).dates; } catch {}
    if (scenario === 'r429')    return mk(429, { status_code:429, reason_phrase:'rate limited' });
    if (scenario === 'r500')    return mk(500, { status_code:500, reason_phrase:'internal error' });
    if (scenario === 'netdrop') throw new Error('socket hang up');
    if (scenario === 'partial422') return url.includes('bbe43523') /*4-L*/ ? mk(422,{status_code:422,reason_phrase:'This property has dynamic pricing enabled, and price updates can not be made via the API.'}) : mk(200,{ok:true});
    return mk(200, { ok: true }); // noop/minstay PUT "succeeds"
  }
  return mk(400, {});
};

require('./pricing-engine-run.js');
