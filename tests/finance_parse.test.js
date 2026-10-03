// Run: node tests/finance_parse.test.js
const assert = require('assert');
const { _finParseReceipt, _finRowsFromOcr, _finSplitAmounts } = require('../js/finance.js');
const TODAY = '2026-09-26';

// Grocery receipt: merchant tidied, subtotal + tax cross-check the total.
let r = _finParseReceipt(`TRADER JOE'S
#118 · 3 New Montgomery St
(415) 555-0142
BANANAS 1.19
OAT MILK 3.99
DISH SOAP 3.49 F
SUBTOTAL 8.67
TAX 0.31
TOTAL 8.98
VISA ****4821 8.98
09/25/2026 14:02`, TODAY);
assert.strictEqual(r.merchant, "Trader Joe's");
assert.strictEqual(r.total, 8.98);
assert.strictEqual(r.date, '2026-09-25');
assert.deepStrictEqual(r.items.map(i => i.name), ['Bananas', 'Oat Milk', 'Dish Soap']);
assert.deepStrictEqual(r.conf, { merchant: 'high', total: 'high', date: 'high' });
assert.deepStrictEqual(r.rowIdx, { merchant: 0, total: 8, date: 10 });

// "Amount Due" beats a later tip line; value on the next row; ISO date.
r = _finParseReceipt(`Chipotle Mexican Grill
2026-09-19
Burrito 11.25
Subtotal 11.25
Tax 0.95
Amount Due
$12.20
Tip 1.25`, TODAY);
assert.strictEqual(r.total, 12.2);
assert.strictEqual(r.date, '2026-09-19');
assert.strictEqual(r.conf.total, 'high');

// No total label → largest amount, low confidence; no date → missing.
r = _finParseReceipt('Corner Shop\nThing 1,204.50\nOther 3.00', TODAY);
assert.strictEqual(r.total, 1204.5);
assert.strictEqual(r.conf.total, 'low');
assert.strictEqual(r.date, null);
assert.strictEqual(r.conf.date, 'missing');

// Month-name date; future date is flagged; date-looking numbers aren't amounts.
assert.strictEqual(_finParseReceipt('Shop\nSep 3, 2026\nTOTAL 5.00', TODAY).date, '2026-09-03');
assert.strictEqual(_finParseReceipt('Shop\n12/30/2026\nTOTAL 5.00', TODAY).conf.date, 'low');
assert.strictEqual(_finParseReceipt('Shop\n25.09.2026\nTOTAL 5.00', TODAY).date, '2026-09-25');

// OCR lines on the same visual row (name left, price far right) merge into one row.
const rows = _finRowsFromOcr({ lines: [
  { text: 'TOTAL', x0: 10, y0: 100, x1: 60, y1: 112 },
  { text: '64.12', x0: 200, y0: 101, x1: 240, y1: 113 },
  { text: 'VISA', x0: 10, y0: 120, x1: 50, y1: 132 },
] });
assert.deepStrictEqual(rows.map(x => x.text), ['TOTAL 64.12', 'VISA']);
assert.deepStrictEqual([rows[0].x0, rows[0].y0, rows[0].x1, rows[0].y1], [10, 100, 240, 113]);

// Costco: CA REDEMP VAL fees add to and discounts ("2.50-") subtract from the
// item above, so items still sum to the subtotal.
r = _finParseReceipt(`COSTCO WHOLESALE
LYTE BDY ARM 18.99 N
4544 CA REDEMP VAL N EE/1779098 0.90
7 @ 3.99
KSWTR40PK 27.93 N
4469 CA REDEMP VAL N EE/782796 14.00
1032422 PALMOLIVE 8.99 Y
393232 /1032422 2.50-
WHOLE MILK 6.37 N
SUBTOTAL 74.68
TAX 0.50
TOTAL 75.18`, TODAY);
assert.deepStrictEqual(r.items.map(i => [i.name, i.amount]),
  [['Lyte Bdy Arm', 19.89], ['Kswtr40pk', 41.93], ['Palmolive', 6.49], ['Whole Milk', 6.37]]);
assert.strictEqual(r.total, 75.18);

// Split: proportional, tax shared, sums to the total to the cent.
const parts = _finSplitAmounts([
  { amount: 30, category: 'Groceries' }, { amount: 18.52, category: 'Shopping' }, { amount: 3.49, category: 'Other' },
], 55.43);
assert.strictEqual(Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 100), 5543);
assert.ok(parts.Groceries > parts.Shopping && parts.Shopping > parts.Other);

console.log('finance parse: ok');
