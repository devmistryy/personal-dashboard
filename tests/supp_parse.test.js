// Run: node tests/supp_parse.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const el = { addEventListener() {} };
const ctx = { document: { getElementById: () => el, querySelectorAll: () => [] }, MEM: {}, console, _syncSetting() {} };
vm.createContext(ctx);
for (const f of ['diet.js', 'supplements.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', f), 'utf8'), ctx);
const plain = x => JSON.parse(JSON.stringify(x));
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

// A second photo adds to the list: blanks dropped, repeated names skipped, edits kept.
const { _suppMergeRows } = ctx;
const list = [{ name: 'Vitamin C', amount: 50, unit: 'mg' }, { name: '', amount: null, unit: 'mg' }];
const added = _suppMergeRows(list, [{ name: 'vitamin c', amount: 45, unit: 'mg' }, { name: 'Zinc', amount: 5, unit: 'mg' }]);
assert.strictEqual(added, 1);
assert.deepStrictEqual(JSON.parse(JSON.stringify(list)), [
  { name: 'Vitamin C', amount: 50, unit: 'mg' },
  { name: 'Zinc', amount: 5, unit: 'mg' },
]);

// The back half of a 2-gummy label has no serving line; the first photo's serving still applies.
r = _suppParseLabel({ lines: [], text: 'Zinc 10 mg' }, 2);
assert.strictEqual(r.servingFound, false);
assert.deepStrictEqual(JSON.parse(JSON.stringify(r.rows)), [{ name: 'Zinc', amount: 5, unit: 'mg' }]);

// Catalog: one entry per name; the latest log names it, a contents edit wins over the log's,
// time of day comes from when it's usually taken, archived ones drop out, meta alone is enough.
const logs = [
  { id: '1', name: 'NAC + ALA', date: '2026-10-01', time: '09:06', qty: 1, contents: [{ name: 'NAC', amount: 500, unit: 'mg' }] },
  { id: '2', name: 'NAC + ALA', date: '2026-10-02', time: '09:16', qty: 1, contents: [] },
  { id: '3', name: 'Magnesium Glycinate', date: '2026-09-26', time: '22:10', qty: 2, contents: [{ name: 'Magnesium Glycinate', amount: 120, unit: 'mg' }] },
  { id: '4', name: 'Old Thing', date: '2026-09-01', time: '08:00', qty: 1, contents: [] },
];
const cat = ctx._suppCatalogFrom(logs,
  { 'old thing': { archived: true }, 'sleep cap': { name: 'Sleep Cap', sched: 'prn', stock: 5, food: 'with' } },
  { 'nac + ala': [{ name: 'NAC', amount: 600, unit: 'mg' }] }, {}, { 'magnesium glycinate': 'Before bed' });
assert.deepStrictEqual(plain(cat.map(c => c.name)), ['Magnesium Glycinate', 'NAC + ALA', 'Sleep Cap']);
const [mag, nac, sleep] = plain(cat);
assert.deepStrictEqual([nac.slot, nac.usual, nac.first, nac.last.id, nac.contents[0].amount, nac.sched], ['morning', '09:15', '2026-10-01', '2', 600, 'daily']);
assert.deepStrictEqual([mag.slot, mag.qty, mag.note, mag.stock], ['night', 2, 'Before bed', '']);
assert.deepStrictEqual([sleep.sched, sleep.stock, sleep.last, sleep.food, nac.food], ['prn', 5, null, 'with', '']);

// Spacing: pending until the first one is logged, then counts down from its latest dose.
const after = { key: 'nac + ala', min: 30 };
assert.deepStrictEqual(plain(ctx._suppWaitState(after, [], 600)), { pending: true, min: 30 });
assert.deepStrictEqual(plain(ctx._suppWaitState(after, ['09:16'], 9 * 60 + 28)), { pending: false, min: 30, readyAt: '09:46', left: 18 });
assert.strictEqual(ctx._suppWaitState(after, ['07:00', '09:16'], 600).left, -14);
assert.strictEqual(ctx._suppGapBefore('09:41', ['09:06']), 35);
assert.strictEqual(ctx._suppGapBefore('09:00', ['09:06']), null);

// A supplement that waits on another sits right after it; a loop still lists both.
const A = { key: 'a' }, B = { key: 'b', after: { key: 'c', min: 30 } }, C = { key: 'c' }, D = { key: 'd', after: { key: 'gone', min: 5 } };
assert.deepStrictEqual(plain(ctx._suppChainOrder([A, B, C, D]).map(x => x.key)), ['a', 'c', 'b', 'd']);
const X = { key: 'x', after: { key: 'y', min: 1 } }, Y = { key: 'y', after: { key: 'x', min: 1 } };
assert.deepStrictEqual(plain(ctx._suppChainOrder([X, Y]).map(x => x.key)), ['x', 'y']);

// Intake: forms of one nutrient merge, mg/mcg convert, other units stay apart, blanks skip.
const t = plain(ctx._suppTotals([
  { name: 'Magnesium Glycinate', qty: 2, contents: [{ name: 'Magnesium Glycinate', amount: 120, unit: 'mg' }] },
  { name: 'Optimize Minerals', qty: 1, contents: [{ name: 'Magnesium Chelate', amount: 200, unit: 'mg' }, { name: 'Methylated B-12', amount: 2000, unit: 'mcg' },
    { name: 'Selenium Chelate', amount: 50, unit: 'mcg' }, { name: 'Probiotic', amount: 1e9, unit: 'CFU' }, { name: 'Taurine', amount: null, unit: 'mg' }] },
  { name: 'Multi', qty: 1, contents: [{ name: 'Selenium', amount: 0.05, unit: 'mg' }] },
]));
assert.deepStrictEqual(t.map(x => [x.name, Math.round(x.amount * 1000) / 1000, x.unit]),
  [['Magnesium', 440, 'mg'], ['Probiotic', 1e9, 'CFU'], ['Selenium', 100, 'mcg'], ['Vitamin B12', 2000, 'mcg']]);
assert.deepStrictEqual(t[0].src, ['Magnesium Glycinate 240 mg', 'Optimize Minerals 200 mg']);

// Rename moves the log, every map and spacing rules pointing at it; a case-only rename keeps the key.
Object.assign(ctx.MEM, {
  diet_supplements_v1: [{ id: '1', name: 'Nac', date: '2026-10-01', time: '09:00', qty: 1 }, { id: '2', name: 'Zinc', date: '2026-10-01', time: '09:00', qty: 1 }],
  diet_supp_meta_v1: { nac: { name: 'Nac', slot: 'morning' }, opt: { name: 'Opt', after: { key: 'nac', min: 30 } } },
  diet_supp_notes_v1: { nac: 'With food' }, diet_supp_contents_v1: {}, diet_supp_cycles_v1: {},
});
ctx._suppRename('nac', 'NAC + ALA');
assert.deepStrictEqual(plain(ctx.MEM.diet_supplements_v1.map(l => l.name)), ['NAC + ALA', 'Zinc']);
assert.deepStrictEqual(plain(ctx.MEM.diet_supp_notes_v1), { 'nac + ala': 'With food' });
assert.strictEqual(ctx.MEM.diet_supp_meta_v1['nac + ala'].name, 'NAC + ALA');
assert.strictEqual(ctx.MEM.diet_supp_meta_v1.opt.after.key, 'nac + ala');
ctx._suppRename('nac + ala', 'Nac + Ala');
assert.deepStrictEqual(plain(ctx.MEM.diet_supp_notes_v1), { 'nac + ala': 'With food' });
assert.strictEqual(ctx.MEM.diet_supplements_v1[0].name, 'Nac + Ala');

console.log('supp_parse ok');
