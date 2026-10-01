// Run: node tests/mob_parse.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const el = { addEventListener() {}, classList: { contains: () => false } };
const ctx = { document: { getElementById: () => el, querySelector: () => el, querySelectorAll: () => [], addEventListener() {} },
  ResizeObserver: class { observe() {} }, MEM: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/mobility.js'), 'utf8'), ctx);
const { _mobParseName: p } = ctx;
const fields = s => JSON.parse(JSON.stringify(p(s).fields));

assert.strictEqual(p('Couch stretch 2x60s night 4/wk #hips').name, 'Couch stretch');
assert.deepStrictEqual(fields('Couch stretch 2x60s night 4/wk #hips'),
  { sets: 2, measure: 'hold', holdSeconds: 60, session: 'night', frequency: 4, group: 'hips' });
assert.deepStrictEqual(fields('Wall slides 3x12'), { sets: 3, measure: 'reps', reps: 12 });
assert.deepStrictEqual(fields('Dead hang 45s am'), { measure: 'hold', holdSeconds: 45, session: 'morning' });
assert.deepStrictEqual(fields('Neck CARs 5 reps'), { measure: 'reps', reps: 5 });
// The first word is always part of the name; plain names are untouched.
assert.strictEqual(p('Night walk').name, 'Night walk');
assert.deepStrictEqual(fields('Night walk'), {});
assert.strictEqual(p('90/90 hip switch').name, '90/90 hip switch');
assert.deepStrictEqual(fields('90/90 hip switch'), {});
assert.strictEqual(p('').name, '');
assert.deepStrictEqual(fields("Child's pose 60s fixed"), { measure: 'hold', holdSeconds: 60, progress: 'fixed' });
console.log('mob_parse ok');
