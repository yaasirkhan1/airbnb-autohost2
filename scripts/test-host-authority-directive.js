// The host-in-thread-authority directive must (a) make host statements override stored
// rules/amenities/policies and (b) be bounded — never override money/refunds or safety.
// Run: node scripts/test-host-authority-directive.js
'use strict';
const assert = require('assert');
const { HOST_AUTHORITY_DIRECTIVE } = require('../src/server');

let pass = 0;
const ok = (n, f) => { f(); console.log('✓', n); pass++; };

ok('directive exists and is a non-empty string', () => {
  assert.strictEqual(typeof HOST_AUTHORITY_DIRECTIVE, 'string');
  assert.ok(HOST_AUTHORITY_DIRECTIVE.length > 50, 'directive has real content');
});

ok('directive asserts host statements OVERRIDE stored rules and must not be contradicted', () => {
  const t = HOST_AUTHORITY_DIRECTIVE.toLowerCase();
  assert.ok(t.includes('override'), 'mentions override');
  assert.ok(t.includes('house rules') || t.includes('rules'), 'scopes to rules/policies');
  assert.ok(t.includes('contradict'), 'forbids contradicting the host');
});

ok('directive carves out money/refunds and safety', () => {
  const t = HOST_AUTHORITY_DIRECTIVE.toLowerCase();
  assert.ok(t.includes('refund') || t.includes('money'), 'money/refund carve-out present');
  assert.ok(t.includes('safe'), 'safety carve-out present');
});

console.log(`\n${pass} passed`);
