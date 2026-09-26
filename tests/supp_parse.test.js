// Run: node tests/supp_parse.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const el = { addEventListener() {} };
const ctx = { document: { getElementById: () => el, querySelectorAll: () => [] }, MEM: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/diet.js'), 'utf8'), ctx);
const { _suppParseLabel } = ctx;

// Name and amount columns come back as separate OCR lines on the same row.
let r = _suppParseLabel({ lines: [
  { text: 'Supplement Facts', top: 10, left: 10 },
  { text: 'Serving Size 1 Tablet', top: 30, left: 10 },
  { text: 'Amount Per Serving', top: 50, left: 10 },
  { text: '% Daily Value', top: 50, left: 200 },
  { text: 'Vitamin D3 (as cholecalciferol)', top: 70, left: 10 },
  { text: '25 mcg (1,000 IU)', top: 72, left: 180 },
  { text: '125%', top: 71, left: 260 },
  { text: 'Vitamin B12', top: 90, left: 10 },
  { text: '500 mcg', top: 91, left: 180 },
  { text: 'Folate 400 mcg DFE', top: 110, left: 10 },
  { text: 'Zinc (as zinc citrate) 11 mg 100%', top: 130, left: 10 },
  { text: 'Other ingredients: cellulose 2 mg', top: 150, left: 10 },
] });
assert.strictEqual(r.perServing, 1);
assert.deepStrictEqual(JSON.parse(JSON.stringify(r.rows)), [
  { name: 'Vitamin D3', amount: 25, unit: 'mcg' },
  { name: 'Vitamin B12', amount: 500, unit: 'mcg' },
  { name: 'Folate', amount: 400, unit: 'mcg' },
  { name: 'Zinc', amount: 11, unit: 'mg' },
]);

// A 2-gummy serving is divided down to one pill; µg and billion CFU normalize.
r = _suppParseLabel({ lines: [], text: 'Serving Size 2 Gummies\nVitamin C 90 mg\nBiotin 50 µg\nProbiotic Blend 1 billion CFU' });
assert.strictEqual(r.perServing, 2);
assert.deepStrictEqual(JSON.parse(JSON.stringify(r.rows)), [
  { name: 'Vitamin C', amount: 45, unit: 'mg' },
  { name: 'Biotin', amount: 25, unit: 'mcg' },
  { name: 'Probiotic Blend', amount: 500000000, unit: 'CFU' },
]);

// On/off cycle: 2 weeks on, 2 weeks off, starting Sep 1.
const { _suppCycleState } = ctx;
const boron = { on: 14, off: 14, start: '2026-09-01' };
const st = ds => JSON.parse(JSON.stringify(_suppCycleState(boron, ds)));
assert.deepStrictEqual(st('2026-09-01'), { on: true, day: 1, of: 14, until: '2026-09-15' });
assert.deepStrictEqual(st('2026-09-14'), { on: true, day: 14, of: 14, until: '2026-09-15' });
assert.deepStrictEqual(st('2026-09-15'), { on: false, until: '2026-09-29' });   // first off-day
assert.deepStrictEqual(st('2026-09-28'), { on: false, until: '2026-09-29' });
assert.deepStrictEqual(st('2026-09-29'), { on: true, day: 1, of: 14, until: '2026-10-13' });  // second cycle
assert.deepStrictEqual(st('2026-08-30'), { on: false, until: '2026-09-01' });   // before it starts
// Spans the Nov DST change without drifting a day.
assert.deepStrictEqual(st('2026-11-09'), { on: true, day: 14, of: 14, until: '2026-11-10' });
assert.deepStrictEqual(st('2026-11-10'), { on: false, until: '2026-11-24' });

console.log('supp_parse ok');
