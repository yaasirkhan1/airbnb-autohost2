// Knowledge-base loader for the concierge/event intelligence layer.
// Loaded from DATA_DIR (repo ./data — NOT the volume; it's static reference content).
// Run: node scripts/test-knowledge-base.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadKnowledgeBase } = require('../src/knowledge-base');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

check('loads data/knowledge-base.md with the real concierge facts', () => {
  const kb = loadKnowledgeBase();
  assert.ok(kb.length > 1000, 'KB should be substantial');
  for (const fact of ['Mercedes-Benz Stadium', 'MARTA', 'Peachtree Center', 'AmericasMart', 'Georgia World Congress Center', '15-20 minute walk'])
    assert.ok(kb.includes(fact), `KB missing "${fact}"`);
});

check('PROPERTY & BUILDING facts present (verbatim confirmed facts)', () => {
  const kb = loadKnowledgeBase();
  for (const fact of [
    '300 Peachtree Street NE', 'Atlanta, Georgia 30308',
    '4:00 PM', '11:00 AM', '$45',
    'does NOT provide luggage storage', 'centralized seasonal HVAC',
    '$10-$20 range', 'Never quote a fixed parking price',
    'directly across the street',
  ]) assert.ok(kb.includes(fact), `property facts missing "${fact}"`);
});

check('Event-layer distances: MBS = ~15 min via Centennial Olympic Park (old 20-25 gone everywhere)', () => {
  const kb = loadKnowledgeBase();
  // MBS section reframed to a ~15-min walk through Centennial Olympic Park
  assert.ok(/MERCEDES-BENZ STADIUM\s*\n\nDistance:\nAbout a 15-minute walk/.test(kb), 'MBS section should be ~15 min');
  assert.ok(/Mercedes-Benz Stadium[\s\S]{0,60}?Centennial Olympic Park/i.test(kb), 'MBS framed via Centennial Olympic Park');
  assert.ok(/CENTENNIAL OLYMPIC PARK\s*\n\nDistance:\nApproximately 12-15 minute walk/.test(kb), 'Centennial should be 12-15');
  // no stale 20-25 figure anywhere (Q-and-example mentions corrected too)
  assert.ok(!/20[- ]?(to )?25 ?minute walk/i.test(kb), 'no stale 20-25 MBS figure should remain anywhere');
  assert.ok(/Mercedes-Benz Stadium is about a 15-minute walk from the property/i.test(kb), 'MBS Q corrected to ~15 min');
  assert.ok(/Mercedes-Benz Stadium is about a 15-minute walk from the building/i.test(kb), 'MBS example corrected to ~15 min');
  // GWCC + State Farm unchanged at 15-20 (exactly two standalone lines)
  assert.strictEqual((kb.match(/^Approximately 15-20 minute walk$/gm) || []).length, 2, 'GWCC + State Farm = two 15-20 lines');
});

check('missing file → empty string (no throw)', () => {
  assert.strictEqual(loadKnowledgeBase(path.join(os.tmpdir(), 'nope-kb-' + Date.now() + '.md')), '');
});

check('explicit file path is honored', () => {
  const tmp = path.join(os.tmpdir(), 'kb-' + Date.now() + '.md');
  fs.writeFileSync(tmp, '# test kb\nMercedes-Benz Stadium 15-20 minute walk');
  assert.ok(loadKnowledgeBase(tmp).includes('Mercedes-Benz'));
  fs.unlinkSync(tmp);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
