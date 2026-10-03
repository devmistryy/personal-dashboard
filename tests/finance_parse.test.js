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

// Costco two-line price cell (real OCR boxes): "65.98" sits above the name's
// center with its "N" flag below — still one row; the next item stays separate.
assert.deepStrictEqual(_finRowsFromOcr({ lines: [
  { text: '65.98', x0: 723, y0: 933, x1: 790, y1: 971 },
  { text: '1972488 OATSOVRN30CF', x0: 250, y0: 956, x1: 650, y1: 985 },
  { text: 'N', x0: 784, y0: 977, x1: 800, y1: 1003 },
  { text: '222 10 LB. SUGAR', x0: 319, y0: 1032, x1: 600, y1: 1067 },
  { text: '7.79 N', x0: 717, y0: 1032, x1: 800, y1: 1061 },
] }).map(x => x.text), ['1972488 OATSOVRN30CF 65.98 N', '222 10 LB. SUGAR 7.79 N']);

// Costco: CA REDEMP VAL fees add to and discounts ("2.50-") subtract from the
// item above, so items still sum to the subtotal.
r = _finParseReceipt(`COSTCO WHOLESALE
E 1779098 LYTE BDY ARM 18.99 N
4544 CA REDEMP VAL N EE/1779098 0.90
7 @ 3.99
E 782796 ***KSWTR40PK 27.93 N
7 @ 2.00
4469 CA REDEMP VAL N EE/782796 14.00
1032422 PALMOLIVE 8.99 Y
393232 /1032422 2.50-
E 2 WHOLE MILK 6.37 N
SUBTOTAL 74.68
TAX 0.50
TOTAL 75.18`, TODAY);
assert.deepStrictEqual(r.items.map(i => [i.name, i.amount]),
  [['Lyte Bdy Arm', 19.89], ['Kswtr40pk', 41.93], ['Palmolive', 6.49], ['Whole Milk', 6.37]]);
assert.strictEqual(r.total, 75.18);
assert.deepStrictEqual(r.items.map(i => i.qty), [undefined, 7, undefined, undefined]);   // "7 @ 2.00" deposit qty isn't carried to Palmolive

// "2 @ 32.99" above an item → qty 2 when it multiplies out to the item's price.
r = _finParseReceipt(`TUSTIN RANCH #122
2 @ 32.99
E 1972488 OATSOVRN30CF 65.98 N
E 222 10 LB. SUGAR 7.79 N
2 @ 13.99
E 24722 FOLGERS INST 27.98 N
E 2007065 PREMIERSTRAW 31.99 Y
SUBTOTAL 133.74`, TODAY);
assert.deepStrictEqual(r.items.map(i => [i.name, i.amount, i.qty]),
  [['Oatsovrn30cf', 65.98, 2], ['10 Lb. Sugar', 7.79, undefined], ['Folgers Inst', 27.98, 2], ['Premierstraw', 31.99, undefined]]);

// Costco app screenshots: the store name beats the app's header; with no store
// name in view (logo scrolled off) the merchant is left blank, not "Orders and Purchases".
r = _finParseReceipt(`9:00 64
Orders and Purchases
at Tustin Ranch | Delivering to 92867
COSTCO 12
WHOLESALE
TUSTIN RANCH #122
TOTAL 136.22`, TODAY);
assert.strictEqual(r.merchant, 'Costco');
assert.strictEqual(r.conf.merchant, 'high');
r = _finParseReceipt(`8:37 31
Orders and Purchases
at Tustin Ranch | Delivering to 92867
2700 PARK AVE
TUSTIN, CA 92782
TOTAL 75.18`, TODAY);
assert.strictEqual(r.merchant, '');
assert.strictEqual(r.conf.merchant, 'missing');

// Split: proportional, tax shared, sums to the total to the cent.
const parts = _finSplitAmounts([
  { amount: 30, category: 'Groceries' }, { amount: 18.52, category: 'Shopping' }, { amount: 3.49, category: 'Other' },
], 55.43);
assert.strictEqual(Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 100), 5543);
assert.ok(parts.Groceries > parts.Shopping && parts.Shopping > parts.Other);

console.log('finance parse: ok');
