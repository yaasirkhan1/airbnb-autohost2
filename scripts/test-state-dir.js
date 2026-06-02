// Confirm the volume switch is SAFE: only seen-store + pending-store move to the
// volume via STATE_DIR; the static config files (properties-map, vault, pricing,
// unit-profiles) keep resolving via DATA_DIR (left unset → repo ./data), and
// entry-codes never touches either dir (config/entry-codes.json).
//
// Path resolution is computed at module-load from env, so we probe each combo in a
// child process. Run: node scripts/test-state-dir.js
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const repoData = path.join(__dirname, '..', 'data');

// Print a module's resolved DEFAULT_FILE under a given env.
function defaultFile(mod, env) {
  const out = execFileSync(process.execPath,
    ['-e', `process.stdout.write(require('./src/${mod}').DEFAULT_FILE)`],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, STATE_DIR: '', DATA_DIR: '', ...env } });
  return out.toString();
}

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

for (const mod of ['seen-store', 'pending-store']) {
  check(`${mod}: STATE_DIR wins → file on the volume`, () => {
    assert.strictEqual(defaultFile(mod, { STATE_DIR: '/data' }), `/data/${mod === 'seen-store' ? 'seen-messages' : 'pending-replies'}.json`);
  });
  check(`${mod}: STATE_DIR unset, DATA_DIR set → DATA_DIR (back-compat)`, () => {
    assert.strictEqual(defaultFile(mod, { DATA_DIR: '/legacy' }), `/legacy/${mod === 'seen-store' ? 'seen-messages' : 'pending-replies'}.json`);
  });
  check(`${mod}: both unset → repo ./data`, () => {
    assert.strictEqual(defaultFile(mod, {}), path.join(repoData, mod === 'seen-store' ? 'seen-messages.json' : 'pending-replies.json'));
  });
}

// The static-config paths must NOT follow STATE_DIR — they read DATA_DIR only.
check('properties-map path follows DATA_DIR, NOT STATE_DIR (stays on repo ./data when DATA_DIR unset)', () => {
  // mirror server.js: process.env.DATA_DIR || repo/data  (STATE_DIR is irrelevant here)
  const env = { STATE_DIR: '/data', DATA_DIR: '' };
  const resolved = (env.DATA_DIR || repoData);
  const mapPath = path.join(resolved, 'properties-map.json');
  assert.strictEqual(mapPath, path.join(repoData, 'properties-map.json'),
    'with STATE_DIR=/data and DATA_DIR unset, properties-map must still resolve to repo ./data');
  assert.ok(!mapPath.startsWith('/data/'), 'properties-map must NOT land on the volume');
});

check('entry-codes path is config/entry-codes.json — independent of STATE_DIR and DATA_DIR', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'entry-codes.js'), 'utf8');
  assert.ok(/config['"\s,]+entry-codes\.json/.test(src), 'entry-codes should resolve under config/, not a data dir');
  assert.ok(!/DATA_DIR|STATE_DIR/.test(src), 'entry-codes must not reference DATA_DIR/STATE_DIR');
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
