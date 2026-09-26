// Finance tab: spending vs budget for a month/quarter/year, receipt scanning
// with a review step, per-category budgets and recurring bills.
// Loaded after diet.js (reuses its OCR call, _dietOcr) and before main.js.
//
// Persistence (js/main.js):
//   transactions → finance_transactions via _syncFinance (upsert + delete-missing)
//   receipts     → finance_receipts via _finPutReceipt / _finGetReceipt / _finDeleteReceipt
//                  (image + parsed line items; fetched only when a transaction is opened)
//   budgets      → settings row 'finance_budgets_v1' ({ category: monthlyLimit })
// Amounts are always positive; category 'Income' marks money in.

const FIN_CATEGORIES = [
  { name: 'Bills',         color: '#7FD1D1', icon: '🧾' },
  { name: 'Groceries',     color: '#52C97A', icon: '🛒' },
  { name: 'Dining',        color: '#EF9F27', icon: '🍜' },
  { name: 'Shopping',      color: '#B18CFF', icon: '🛍' },
  { name: 'Transport',     color: '#4A9EFF', icon: '⛽' },
  { name: 'Entertainment', color: '#F2C063', icon: '🎬' },
  { name: 'Health',        color: '#FF8FA3', icon: '💊' },
  { name: 'Other',         color: '#8E8C86', icon: '•' },
  { name: 'Income',        color: '#6BE3A4', icon: '↓' },
];
const FIN_CAT = Object.fromEntries(FIN_CATEGORIES.map(c => [c.name, c]));
const FIN_EXPENSE_CATS = FIN_CATEGORIES.map(c => c.name).filter(n => n !== 'Income');
const FIN_PERIOD_MONTHS = { month: 1, quarter: 3, year: 12 };
const FIN_TX_LIMIT = 30;
const FIN_UPCOMING_DAYS = 14;
const FIN_BOX_COLORS = { merchant: '#4A9EFF', total: '#52C97A', date: '#F2C063' };


// ═══════════════════════════════════════════════════════════════════════════
//  Receipt parsing — pure, no DOM (tests/finance_parse.test.js)
// ═══════════════════════════════════════════════════════════════════════════
const _FIN_AMT_RE = /(-?\d{1,3}(?:,\d{3})+|-?\d+)\.(\d{2})(?!\d)/g;
const _FIN_DATE_LIKE = /\b\d{1,4}[./-]\d{1,2}[./-]\d{2,4}\b/g;
const _FIN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const _FIN_MON_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const _FIN_NOT_ITEM = /\b(?:sub\s*-?\s*total|total|tax|change|cash|visa|master\s*card|amex|discover|debit|credit|card|balance|tender(?:ed)?|tip|gratuity|payment|paid|auth\w*|approv\w*|saving|saved|discount|coupon|points|member|reward|refund|due|amount)\b|@|\blb\b|\bkg\b/i;
const _FIN_NOT_MERCHANT = /receipt|welcome|thank|store\s*#|\btel\b|phone|www\.|http|\.com\b|@|\d{3}[-.) ]\d{3}[-. ]\d{4}|^\d|^#|\b(?:ave|blvd|street|road|suite|hwy)\b|\bst\.?$|customer|order\s*#|server|table|guest|cashier|transaction|register/i;

const _FIN_CATEGORY_HINTS = [
  ['Groceries',     /trader\s*joe|whole\s*foods|safeway|kroger|aldi|costco|publix|wegmans|sprouts|grocery|supermarket|\bmarket\b|h-?e-?b\b|food\s*lion|giant\s*eagle|albertsons|ralphs|vons/i],
  ['Dining',        /restaurant|cafe|café|coffee|starbucks|chipotle|mcdonald|burger|pizza|taco|grill|kitchen|diner|bistro|sushi|ramen|bakery|gratuity|\bserver\b|\btable\s*\d/i],
  ['Transport',     /\bshell\b|chevron|exxon|mobil|\bbp\b|arco|valero|fuel|gasoline|\bgas\b|uber|lyft|parking|transit|toll/i],
  ['Health',        /pharmacy|cvs|walgreens|rite\s*aid|\brx\b|clinic|medical|dental|optometr/i],
  ['Bills',         /comcast|xfinity|pg\s*&\s*e|verizon|at\s*&\s*t|t-?mobile|electric|utility|utilities|insurance|\brent\b|internet|water\s*dept/i],
  ['Entertainment', /cinema|theat(?:er|re)|\bamc\b|netflix|spotify|steam|ticket|concert|museum|bowling/i],
  ['Shopping',      /target|walmart|amazon|best\s*buy|home\s*depot|lowe'?s|ikea|macy|nordstrom|\bgap\b|old\s*navy|uniqlo|apple\s*store/i],
];
const _FIN_ITEM_HINTS = [
  ['Other',    /soap|detergent|paper\s*towel|toilet|tissue|trash|sponge|bleach|cleaner|foil|plastic\s*wrap|batter(?:y|ies)|light\s*bulb/i],
  ['Shopping', /flower|bouquet|greeting|gift|candle|toy|shirt|sock|mug|plant|charger|cable/i],
  ['Health',   /vitamin|ibuprofen|advil|tylenol|aspirin|bandage|allergy|cough|medicine|sunscreen/i],
];

function _finHintCategory(text, hints = _FIN_CATEGORY_HINTS) {
  const h = hints.find(([, re]) => re.test(text || ''));
  return h ? h[0] : null;
}

function _finAmounts(s) {
  const clean = String(s).replace(_FIN_DATE_LIKE, ' ');
  return [...clean.matchAll(_FIN_AMT_RE)].map(m => Number(m[1].replace(/,/g, '') + '.' + m[2]));
}

function _finYmd(y, m, d) {
  if (!(y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  if (new Date(y, m - 1, d).getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function _finDateIn(s) {
  let m;
  if ((m = s.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/))) return _finYmd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/))) {
    const a = +m[1], b = +m[2];
    let y = +m[3]; if (y < 100) y += 2000;
    return a > 12 ? _finYmd(y, b, a) : _finYmd(y, a, b);    // US M/D/Y unless the first part can't be a month
  }
  if ((m = s.match(new RegExp(`\\b${_FIN_MON_RE}\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, 'i'))))
    return _finYmd(+m[3], _FIN_MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  if ((m = s.match(new RegExp(`\\b(\\d{1,2})\\s+${_FIN_MON_RE},?\\s+(20\\d{2})\\b`, 'i'))))
    return _finYmd(+m[3], _FIN_MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  return null;
}

// ALL-CAPS receipt text → readable. `allWords` also title-cases short words
// (item names); merchants keep short all-caps words like "BP" or "CVS".
function _finTidy(s, allWords) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (/[a-z]/.test(s)) return s;
  const small = /^(?:the|and|of|at|on|in|for|to|a|an)$/i;
  return s.split(' ').map(w => (allWords || w.length > 3 || small.test(w))
    ? w.charAt(0) + w.slice(1).toLowerCase() : w).join(' ');
}

// OCR overlay lines → visual rows. Receipts put the price in a far-right
// column, which OCR often returns as a separate line on the same row.
function _finRowsFromOcr(ocr) {
  const lines = ((ocr && ocr.lines) || []).filter(l => l.x1 > l.x0 && l.y1 > l.y0);
  if (!lines.length) {
    return String((ocr && ocr.text) || '').split(/\r?\n/).map(t => ({ text: t.trim() })).filter(r => r.text);
  }
  const sorted = [...lines].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const rows = [];
  for (const l of sorted) {
    const cy = (l.y0 + l.y1) / 2, h = l.y1 - l.y0;
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy - row.cy) < Math.min(h, row.h) * 0.5) {
      row.parts.push(l);
      row.x0 = Math.min(row.x0, l.x0); row.y0 = Math.min(row.y0, l.y0);
      row.x1 = Math.max(row.x1, l.x1); row.y1 = Math.max(row.y1, l.y1);
    } else {
      rows.push({ cy, h, parts: [l], x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 });
    }
  }
  return rows.map(r => ({
    text: r.parts.sort((a, b) => a.x0 - b.x0).map(p => p.text).join(' '),
    x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1,
  }));
}

// rows: string (newline-separated) or [{ text, ...box }]. Returns the fields,
// a confidence per field ('high' | 'medium' | 'low' | 'missing') and the row
// index each came from (for drawing highlights).
function _finParseReceipt(input, today) {
  today = today || (() => { const d = new Date(); return _finYmd(d.getFullYear(), d.getMonth() + 1, d.getDate()); })();
  const rows = (typeof input === 'string' ? input.split(/\r?\n/) : input || [])
    .map(r => (typeof r === 'string' ? { text: r } : r))
    .map(r => ({ ...r, text: String(r.text || '').replace(/\s+/g, ' ').trim() }))
    .filter(r => r.text);
  const lines = rows.map(r => r.text);
  const rowIdx = { merchant: null, total: null, date: null };
  const last = arr => (arr.length ? arr[arr.length - 1] : null);

  // Subtotal + tax (used to cross-check the total).
  let subtotal = null, tax = null, firstTotalRow = -1;
  lines.forEach((l, i) => {
    if (/sub\s*-?\s*total/i.test(l)) { subtotal = subtotal ?? last(_finAmounts(l)); if (firstTotalRow < 0) firstTotalRow = i; }
    else if (/\b(?:sales\s*)?tax\b/i.test(l) && !/total/i.test(l)) tax = tax ?? last(_finAmounts(l));
  });

  // Total: strongest label wins; value on the same row, else the next row.
  let total = null, labelled = false;
  const skip = /sub\s*-?\s*total|total\s*(?:tax|savings|discount|items?|qty|number)|\btax\b|saved/i;
  for (const re of [/grand\s*total|amount\s*due|balance\s*due|total\s*due/i, /\btotal\b/i]) {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]) || skip.test(lines[i])) continue;
      const here = _finAmounts(lines[i]);
      const next = i + 1 < lines.length ? _finAmounts(lines[i + 1]) : [];
      const v = here.length ? last(here) : (next.length ? next[0] : null);
      if (v == null) continue;
      total = v; labelled = true; rowIdx.total = i;
      if (firstTotalRow < 0 || i < firstTotalRow) firstTotalRow = i;
      break;
    }
    if (labelled) break;
  }
  if (total == null) {
    let best = -1;
    lines.forEach((l, i) => _finAmounts(l).forEach(a => { if (a > best) { best = a; rowIdx.total = i; } }));
    if (best > 0) total = best;
  }

  // Merchant: first wordy, non-boilerplate row near the top.
  let merchant = '';
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const l = lines[i];
    if ((l.match(/[a-z]/gi) || []).length < 3 || _FIN_NOT_MERCHANT.test(l)) continue;
    if (_finAmounts(l).length) continue;
    merchant = _finTidy(l.replace(/\s*#\s*\d+.*$/, '').replace(/[*=_~]+/g, ' ')).slice(0, 60).trim();
    rowIdx.merchant = i;
    break;
  }

  // Date: first row containing one.
  let date = null;
  for (let i = 0; i < lines.length && !date; i++) {
    const d = _finDateIn(lines[i]);
    if (d) { date = d; rowIdx.date = i; }
  }

  // Line items: priced rows between the merchant and the first total row.
  const itemEnd = firstTotalRow < 0 ? lines.length : firstTotalRow;
  const items = [];
  for (let i = (rowIdx.merchant ?? -1) + 1; i < itemEnd; i++) {
    const m = lines[i].match(/^(.*?[a-z]{2}.*?)\s+\$?(\d{1,3}(?:,\d{3})*\.\d{2})\s*[a-z]{0,2}$/i);
    if (!m || _FIN_NOT_ITEM.test(m[1]) || i === rowIdx.date) continue;
    const name = _finTidy(m[1].replace(/^\d{4,}\s+/, '').replace(/[*]+/g, ' '), true).trim();
    if (name.length < 2) continue;
    items.push({ name: name.slice(0, 50), amount: Number(m[2].replace(/,/g, '')) });
  }

  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.02;
  const itemsSum = Math.round(items.reduce((s, it) => s + it.amount, 0) * 100) / 100;
  const consistent = near((subtotal ?? NaN) + (tax ?? 0), total) ||
    (items.length > 0 && (near(itemsSum + (tax ?? 0), total) || near(itemsSum, total)));

  const minYear = Number(today.slice(0, 4)) - 1;
  const conf = {
    merchant: !merchant ? 'missing' : rowIdx.merchant <= 2 ? 'high' : 'medium',
    total: total == null ? 'missing' : !labelled ? 'low' : consistent ? 'high' : 'medium',
    date: !date ? 'missing' : (date > today || Number(date.slice(0, 4)) < minYear) ? 'low' : 'high',
  };
  return { merchant, total, date, subtotal, tax, items, conf, rowIdx };
}

// Split a receipt total across the categories of its line items, in
// proportion to each category's item sum (so tax is shared). Sums to `total`
// exactly, in cents.
function _finSplitAmounts(items, total) {
  const sums = {};
  items.forEach(it => { sums[it.category] = (sums[it.category] || 0) + it.amount; });
  const cats = Object.keys(sums).sort((a, b) => sums[b] - sums[a]);
  const itemTotal = cats.reduce((s, c) => s + sums[c], 0);
  if (!cats.length || !itemTotal) return { [cats[0] || 'Other']: total };
  const cents = Math.round(total * 100);
  const out = {};
  let used = 0;
  cats.forEach((c, i) => {
    const v = i === cats.length - 1 ? cents - used : Math.round(cents * sums[c] / itemTotal);
    out[c] = v / 100;
    used += v;
  });
  return out;
}


// ═══════════════════════════════════════════════════════════════════════════
//  Store + helpers
// ═══════════════════════════════════════════════════════════════════════════
function getFinTransactions()      { return MEM['finance_tx_v1'] || []; }
function saveFinTransactions(list) { MEM['finance_tx_v1'] = list; _syncFinance(list); }
function getFinBudgets()           { return MEM['finance_budgets_v1'] || {}; }
function saveFinBudgets(b)         { MEM['finance_budgets_v1'] = b; _syncSetting('finance_budgets_v1', b); }

const _finReceiptCache = new Map();
async function _finReceipt(id) {
  if (!_finReceiptCache.has(id)) _finReceiptCache.set(id, await _finGetReceipt(id));
  return _finReceiptCache.get(id);
}
// A receipt can back several transactions (a split); drop it once none are left.
function _finCleanupReceipt(id) {
  if (!id || getFinTransactions().some(t => t.receiptId === id)) return;
  _finReceiptCache.delete(id);
  _finDeleteReceipt(id);
}

function _finId() { return 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
const _r2 = n => Math.round(n * 100) / 100;
const _finIsIncome = t => t.category === 'Income';
const _finCat = name => FIN_CAT[name] || FIN_CAT.Other;
const _finMerchantKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const _finToday = () => _localDateStr(new Date());

function _finMoney(n, cents = true) {
  return '$' + Math.abs(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
}
function _finParseAmount(v) {
  const n = Number(String(v || '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? _r2(n) : NaN;
}
function _finDate(ds) { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d); }
function _finAddDays(ds, n) { const d = _finDate(ds); d.setDate(d.getDate() + n); return _localDateStr(d); }
function _finAddMonths(ds, n) {
  const d = _finDate(ds);
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  t.setDate(Math.min(d.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
  return _localDateStr(t);
}
function _finFmtDay(ds) { return _finDate(ds).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
function _finMonShort(ds) { return _finDate(ds).toLocaleDateString('en-US', { month: 'short' }); }


// ── Periods ──
let _finPeriod = 'month';
let _finAnchor = (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })();

function _finRange(anchor = _finAnchor, period = _finPeriod) {
  const months = FIN_PERIOD_MONTHS[period];
  const m0 = period === 'month' ? anchor.m : period === 'quarter' ? Math.floor(anchor.m / 3) * 3 : 0;
  const start = new Date(anchor.y, m0, 1), end = new Date(anchor.y, m0 + months, 0);
  return {
    period, months, y: anchor.y, m0,
    start: _localDateStr(start), end: _localDateStr(end),
    days: Math.round((end - start) / 86400000) + 1,
  };
}
function _finShift(anchor, period, dir) {
  const d = new Date(anchor.y, anchor.m + dir * FIN_PERIOD_MONTHS[period], 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}
function _finRangeTitle(r) {
  if (r.period === 'month') return new Date(r.y, r.m0, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  if (r.period === 'quarter') return `Q${r.m0 / 3 + 1} ${r.y}`;
  return String(r.y);
}
function _finRangeShort(r) {
  if (r.period === 'month') return new Date(r.y, r.m0, 1).toLocaleDateString('en-US', { month: 'short' });
  if (r.period === 'quarter') return `Q${r.m0 / 3 + 1}`;
  return String(r.y);
}
function _finRangeNoun(r) {
  return r.period === 'month' ? new Date(r.y, r.m0, 1).toLocaleDateString('en-US', { month: 'long' }) : _finRangeTitle(r);
}

function _finSummary(r) {
  const list = getFinTransactions().filter(t => t.date >= r.start && t.date <= r.end);
  let spent = 0, income = 0, deposits = 0;
  const byCat = {};
  list.forEach(t => {
    if (_finIsIncome(t)) { income += t.amount; deposits++; return; }
    spent += t.amount;
    byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  });
  const monthly = Object.values(getFinBudgets()).reduce((s, v) => s + (Number(v) || 0), 0);
  return { list, spent: _r2(spent), income: _r2(income), net: _r2(income - spent), deposits, byCat, budget: monthly * r.months };
}

function _finPace(r, s) {
  const today = _finToday();
  if (today < r.start) return { state: 'future' };
  if (today > r.end) return { state: 'past' };
  const dayIdx = daysBetween(r.start, today) + 1;
  return { state: 'current', dayIdx, frac: dayIdx / r.days, daysLeft: r.days - dayIdx + 1, pace: s.budget * dayIdx / r.days };
}

// Spend on `cat` in the month of `date`, plus `extra`, ignoring transaction `excludeId`.
function _finCatMonth(cat, date, extra, excludeId) {
  const month = date.slice(0, 7);
  const spent = getFinTransactions()
    .filter(t => t.id !== excludeId && t.category === cat && t.date.startsWith(month))
    .reduce((s, t) => s + t.amount, 0) + (extra || 0);
  return { spent: _r2(spent), budget: Number(getFinBudgets()[cat]) || 0 };
}

function _finBudgetSentence(cat, date) {
  if (cat === 'Income') return '';
  const { spent, budget } = _finCatMonth(cat, date, 0);
  if (!budget) return `${_finMoney(spent)} on ${cat} in ${_finMonShort(date)}`;
  return spent > budget
    ? `${cat} is now ${_finMoney(spent - budget, false)} over budget`
    : `${cat} is now ${Math.round(spent / budget * 100)}% of its budget`;
}

function _finGuessCategory(merchant, text, fallback) {
  const key = _finMerchantKey(merchant);
  if (key) {
    const counts = {};
    getFinTransactions().forEach(t => { if (_finMerchantKey(t.merchant) === key) counts[t.category] = (counts[t.category] || 0) + 1; });
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best) return { cat: best[0], why: `You’ve filed ${merchant} under ${best[0]} ${best[1] === 1 ? 'once' : best[1] + ' times'} before.` };
  }
  const hint = _finHintCategory(`${merchant || ''}\n${text || ''}`);
  if (hint) return { cat: hint, why: text ? 'Guessed from the receipt.' : 'Guessed from the name.' };
  return { cat: fallback, why: fallback ? 'Couldn’t tell — pick a category.' : '' };
}


// ═══════════════════════════════════════════════════════════════════════════
//  Render
// ═══════════════════════════════════════════════════════════════════════════
let _finFilter = 'all';          // 'all' | 'expense' | 'income' | 'scan' | 'review'
let _finCatFilter = null;
let _finSearch = '';
let _finTxAll = false;
let _finBudgetEditing = false;
let _finChart = null;            // geometry for chart hover

function renderFinance() {
  if (typeof document === 'undefined' || !document.getElementById('tab-finance')) return;
  const r = _finRange();
  const s = _finSummary(r);
  const p = _finPace(r, s);
  renderFinHeader(r);
  renderFinHero(r, s, p);
  renderFinChart(r, s, p);
  renderFinTx(r, s);
  renderFinReviewList();
  renderFinCats(r, s);
  renderFinUpcoming();
}

function renderFinHeader(r) {
  document.getElementById('finTitle').textContent = _finRangeTitle(r);
  const isCurrent = _finToday() >= r.start && _finToday() <= r.end;
  document.getElementById('finNext').disabled = r.end >= _finToday();
  document.getElementById('finToday').hidden = isCurrent;
  document.querySelectorAll('[data-fin-period]').forEach(b => {
    b.classList.toggle('on', b.dataset.finPeriod === _finPeriod);
    b.setAttribute('aria-pressed', b.dataset.finPeriod === _finPeriod);
  });
}

function renderFinHero(r, s, p) {
  const prevR = _finRange(_finShift(_finAnchor, _finPeriod, -1));
  const prev = _finSummary(prevR);
  const prevLbl = _finRangeShort(prevR);
  const dollars = n => {
    const [a, b] = Math.abs(n).toFixed(2).split('.');
    return `$${Number(a).toLocaleString('en-US')}<small>.${b}</small>`;
  };

  let eyebrow, big, line, bar = '';
  if (s.budget > 0) {
    const left = _r2(s.budget - s.spent);
    eyebrow = left >= 0 ? 'Left to spend' : 'Over budget';
    big = `<div class="fin-big${left < 0 ? ' down' : ''}">${dollars(left)}</div>`;
    if (p.state === 'current') {
      const diff = _r2(p.pace - s.spent);
      line = (left > 0 ? `≈ <span class="fin-mono">${_finMoney(left / p.daysLeft, false)}</span>/day for the ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left · ` : '') +
        (diff >= 0 ? `<b class="up">${_finMoney(diff, false)} under pace</b>` : `<b class="warn">${_finMoney(-diff, false)} over pace</b>`);
    } else if (p.state === 'past') {
      line = left >= 0 ? `Finished <b class="up">${_finMoney(left, false)} under budget</b>` : `Ended <b class="down">${_finMoney(-left, false)} over budget</b>`;
    } else {
      line = 'This period hasn’t started yet.';
    }
    const pct = Math.min(100, s.spent / s.budget * 100);
    const color = s.spent > s.budget ? 'var(--danger)' : (p.state === 'current' && s.spent > p.pace) ? 'var(--warning)' : '';
    bar = `<div class="fin-pace">
      <div class="fin-pace-track">
        <div class="fin-pace-fill" style="width:${pct}%${color ? `;background:${color}` : ''}"></div>
        ${p.state === 'current' ? `<div class="fin-pace-mark" style="left:${(p.frac * 100).toFixed(1)}%" data-label="Today’s pace"></div>` : ''}
      </div>
      <div class="fin-pace-legend"><span><span class="fin-mono">${_finMoney(s.spent, false)}</span> spent</span><span><span class="fin-mono">${_finMoney(s.budget, false)}</span> budget</span></div>
    </div>`;
  } else {
    eyebrow = 'Spent';
    big = `<div class="fin-big">${dollars(s.spent)}</div>`;
    line = `No budget yet — <button class="fin-link" type="button" data-fin-set-budgets>set monthly budgets</button> to see what’s left.`;
  }

  const delta = (cur, prv, fmt, unit = '') => {
    const d = _r2(cur - prv);
    if (Math.abs(d) < 0.005) return `<span class="fin-muted">Same as ${prevLbl}</span>`;
    return `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${fmt(Math.abs(d))}${unit} vs ${prevLbl}</span>`;
  };
  const rate = s.income > 0 ? Math.round(s.net / s.income * 100) : null;
  const prevRate = prev.income > 0 ? Math.round(prev.net / prev.income * 100) : null;
  const scanned = new Set(s.list.filter(t => t.source === 'scan').map(t => t.receiptId || t.id)).size;
  const review = s.list.filter(t => t.needsReview).length;

  const kpi = (label, val, cls, sub) => `<div class="fin-kpi">
    <div class="fin-kpi-label">${label}</div><div class="fin-kpi-val ${cls}">${val}</div><div class="fin-kpi-delta">${sub}</div></div>`;

  document.getElementById('finHero').innerHTML = `<div class="fin-hero">
    <div>
      <div class="fin-eyebrow">${eyebrow}</div>
      ${big}
      <div class="fin-hero-line">${line}</div>
      ${bar}
    </div>
    <div class="fin-kpis">
      ${kpi('Income', _finMoney(s.income, false), s.income ? 'up' : '',
        `<span class="fin-muted">${s.deposits ? `${s.deposits} deposit${s.deposits === 1 ? '' : 's'}` : 'None yet'}</span>`)}
      ${kpi('Net', (s.net < 0 ? '−' : s.net > 0 ? '+' : '') + _finMoney(s.net, false), s.net < 0 ? 'down' : s.net > 0 ? 'up' : '',
        (s.list.length || prev.list.length) ? delta(s.net, prev.net, v => _finMoney(v, false)) : '<span class="fin-muted">—</span>')}
      ${kpi('Savings rate', rate == null ? '—' : rate + '%', '',
        rate != null && prevRate != null ? delta(rate, prevRate, v => v, ' pts') : '<span class="fin-muted">Needs income</span>')}
      ${kpi('Receipts', String(scanned), '',
        review ? `<span class="warn">${review} need${review === 1 ? 's' : ''} review</span>` : `<span class="fin-muted">${scanned ? 'All reviewed' : 'None scanned'}</span>`)}
    </div>
  </div>`;
}


// ── Chart ──
// Axis top + gridline step: 3–5 round gridlines that just clear `v`.
function _finNiceMax(v) {
  v = Math.max(v, 100);
  const raw = v / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(x => x >= raw);
  return { step, max: Math.ceil(v / step) * step };
}

function renderFinChart(r, s, p) {
  const svg = document.getElementById('finChart');
  // Drawn at its on-screen width so labels stay 10px on phones instead of scaling down.
  const W = Math.max(300, Math.round(svg.getBoundingClientRect().width) || 640);
  const H = W < 480 ? 190 : 220, L = 46, R = 14, T = 14, B = 26;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const endIdx = p.state === 'current' ? p.dayIdx : p.state === 'past' ? r.days : 0;

  const daily = new Array(r.days).fill(0);
  s.list.forEach(t => { if (!_finIsIncome(t)) daily[daysBetween(r.start, t.date)] += t.amount; });
  let acc = 0;
  const cum = daily.slice(0, endIdx).map(v => (acc += v));

  const { step, max } = _finNiceMax(Math.max(s.budget, acc) * 1.06);
  const x = d => L + (d / r.days) * (W - L - R);
  const y = v => T + (1 - v / max) * (H - T - B);

  const fmtAxis = v => v >= 1000 ? '$' + +(v / 1000).toFixed(1) + 'k' : '$' + v;
  let grid = '';
  for (let v = 0; v <= max + 0.001; v += step) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,0.05)"/>` +
      `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="fin-axis">${v ? fmtAxis(v) : '0'}</text>`;
  }
  let ticks;
  if (r.period === 'month') {
    const mon = _finMonShort(r.start);
    ticks = (W < 480 ? [1, 15, r.days] : [1, 8, 15, 22, r.days]).map(d => [x(d), `${mon} ${d}`]);
  } else {
    ticks = [];
    for (let i = 0; i < r.months; i += r.period === 'year' ? 2 : 1) {
      const ms = _localDateStr(new Date(r.y, r.m0 + i, 1));
      ticks.push([x(daysBetween(r.start, ms)), _finMonShort(ms)]);
    }
  }
  const xs = ticks.map(([px, t]) => `<text x="${px}" y="${H - 6}" text-anchor="middle" class="fin-axis">${t}</text>`).join('');

  let body = '';
  if (s.budget > 0) {
    body += `<line x1="${L}" x2="${W - R}" y1="${y(s.budget)}" y2="${y(s.budget)}" stroke="#FF6B6B" stroke-opacity="0.55" stroke-width="1.5"/>
      <text x="${W - R}" y="${y(s.budget) - 6}" text-anchor="end" font-size="10" fill="#FF6B6B" fill-opacity="0.85">Budget ${_finMoney(s.budget, false)}</text>
      <line x1="${x(0)}" y1="${y(0)}" x2="${x(r.days)}" y2="${y(s.budget)}" stroke="#76746E" stroke-dasharray="4 4"/>`;
  }
  if (endIdx > 0) {
    const pts = [[0, 0], ...cum.map((v, i) => [i + 1, v])];
    const line = pts.map(([d, v], i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)},${y(v).toFixed(1)}`).join('');
    body += `<path d="${line}L${x(endIdx)},${y(0)}L${x(0)},${y(0)}Z" fill="url(#finChartFill)"/>
      <path d="${line}" fill="none" stroke="#6BE3A4" stroke-width="2.2" stroke-linejoin="round"/>`;
  } else {
    body += `<text x="${(L + W - R) / 2}" y="${(T + H - B) / 2}" text-anchor="middle" class="fin-axis">Nothing spent yet</text>`;
  }

  svg.innerHTML = `<defs><linearGradient id="finChartFill" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#6BE3A4" stop-opacity="0.28"/><stop offset="1" stop-color="#6BE3A4" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}${xs}${body}<g id="finChartMarker"></g>
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="finChartHit"/>`;

  document.getElementById('finChartLegend').innerHTML =
    `<span><i style="background:#6BE3A4"></i>Spent</span>` +
    (s.budget > 0 ? `<span><i style="background:repeating-linear-gradient(90deg,#76746E 0 4px,transparent 4px 7px)"></i>Pace</span><span><i style="background:#FF6B6B;opacity:.6"></i>Budget</span>` : '');
  document.getElementById('finChartSub').textContent = s.budget > 0
    ? 'Cumulative, against an even pace to your budget' : 'Cumulative spending';

  _finChart = { r, s, cum, endIdx, x, y, L, T, W, H, B, R, todayIdx: p.state === 'current' ? p.dayIdx : null };
  _finDrawMarker(endIdx);
}

function _finDrawMarker(d) {
  const c = _finChart, g = document.getElementById('finChartMarker');
  if (!c || !g) return;
  if (!d) { g.innerHTML = ''; return; }
  const v = c.cum[d - 1] || 0;
  const px = c.x(d), py = c.y(v);
  const label = (d === c.todayIdx ? 'Today · ' : '') + _finFmtDay(_finAddDays(c.r.start, d - 1));
  const val = _finMoney(v, false) + (c.s.budget ? ` · pace ${_finMoney(c.s.budget * d / c.r.days, false)}` : '');
  const w = Math.max(label.length, val.length) * 6.6 + 22;
  let bx = px - w - 10; if (bx < c.L) bx = px + 10;
  let by = py - 46; if (by < 2) by = py + 12;
  g.innerHTML = `<line x1="${px}" x2="${px}" y1="${c.y(0)}" y2="${py}" stroke="rgba(255,255,255,0.2)" stroke-dasharray="2 3"/>
    <circle cx="${px}" cy="${py}" r="5" fill="#050506" stroke="#6BE3A4" stroke-width="2.2"/>
    <g transform="translate(${bx.toFixed(1)},${by.toFixed(1)})">
      <rect width="${w.toFixed(0)}" height="36" rx="8" fill="#1e1e22" stroke="rgba(255,255,255,0.12)"/>
      <text x="11" y="14" font-size="10" fill="#B8B6B0">${label}</text>
      <text x="11" y="28" font-size="11" fill="#FAFAFA" font-family="ui-monospace,monospace" font-weight="600">${val}</text>
    </g>`;
}


// ── Transactions ──
function _finFilteredTx(list) {
  const q = _finSearch.trim().toLowerCase();
  return list.filter(t => {
    if (_finFilter === 'expense' && _finIsIncome(t)) return false;
    if (_finFilter === 'income' && !_finIsIncome(t)) return false;
    if (_finFilter === 'scan' && t.source !== 'scan') return false;
    if (_finFilter === 'review' && !t.needsReview) return false;
    if (_finCatFilter && t.category !== _finCatFilter) return false;
    if (q && ![t.merchant, t.category, t.note, t.amount.toFixed(2)].some(v => String(v || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

function _finDayLabel(ds) {
  const today = _finToday();
  if (ds === today) return 'Today';
  const d = _finDate(ds);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  const lbl = d.toLocaleDateString('en-US', opts);
  return ds === _finAddDays(today, -1) ? 'Yesterday · ' + lbl : lbl;
}

function renderFinTx(r, s) {
  const reviewN = s.list.filter(t => t.needsReview).length;
  const chips = [['all', 'All'], ['expense', 'Expenses'], ['income', 'Income'], ['scan', 'Scanned'], ['review', 'Needs review']];
  document.getElementById('finChips').innerHTML = chips.map(([v, l]) =>
    `<button type="button" class="fin-chip${_finFilter === v ? ' on' : ''}" data-fin-filter="${v}">${l}${v === 'review' && reviewN ? `<span class="n">${reviewN}</span>` : ''}</button>`).join('') +
    (_finCatFilter ? `<button type="button" class="fin-chip on fin-chip-cat" data-fin-cat-clear style="--c:${_finCat(_finCatFilter).color}">${_esc(_finCatFilter)} ×</button>` : '');
  document.getElementById('finTxCount').textContent = `${s.list.length} in ${_finRangeNoun(r)}`;
  renderFinTxList(r, s);
}

function renderFinTxList(r, s) {
  const wrap = document.getElementById('finTxList');
  const list = _finFilteredTx(s.list).sort((a, b) => b.date.localeCompare(a.date) || (b.id || '').localeCompare(a.id || ''));
  if (!list.length) {
    const filtered = _finSearch || _finFilter !== 'all' || _finCatFilter;
    wrap.innerHTML = `<div class="fin-empty">${filtered
      ? 'Nothing matches. <button class="fin-link" type="button" data-fin-clear-filters>Clear filters</button>'
      : `No transactions in ${_esc(_finRangeNoun(r))} yet — scan a receipt or add one manually.`}</div>`;
    return;
  }
  const visible = _finTxAll ? list : list.slice(0, FIN_TX_LIMIT);
  const groups = [];
  visible.forEach(t => {
    const g = groups[groups.length - 1];
    if (g && g.date === t.date) g.rows.push(t); else groups.push({ date: t.date, rows: [t] });
  });
  const badges = t => [
    t.receiptId || t.source === 'scan' ? '<span class="fin-badge scan">🧾 Receipt</span>' : '',
    t.needsReview ? '<span class="fin-badge review">Needs review</span>' : '',
    t.recurring ? '<span class="fin-badge recur">↻ Recurring</span>' : '',
  ].join('');
  wrap.innerHTML = groups.map(g => {
    const net = _r2(g.rows.reduce((sum, t) => sum + (_finIsIncome(t) ? t.amount : -t.amount), 0));
    return `<div class="fin-day"><span>${_finDayLabel(g.date)}</span><span class="fin-mono">${net < 0 ? '−' : '+'}${_finMoney(net)}</span></div>` +
      g.rows.map(t => {
        const c = _finCat(t.category), inc = _finIsIncome(t);
        return `<button type="button" class="fin-tx" data-fin-edit="${t.id}">
          <span class="fin-tx-icon" style="background:${c.color}22;color:${c.color}">${c.icon}</span>
          <span class="fin-tx-main">
            <span class="fin-tx-name${t.merchant ? '' : ' fin-muted'}">${_esc(t.merchant || (t.source === 'scan' ? 'Unknown merchant' : t.category))}</span>
            <span class="fin-tx-meta"><span>${_esc(t.category)}</span>${badges(t)}${t.note ? `<span class="fin-tx-note">${_esc(t.note)}</span>` : ''}</span>
          </span>
          <span class="fin-tx-amt${inc ? ' in' : ''}">${inc ? '+' : '−'}${_finMoney(t.amount)}</span>
          <span class="fin-tx-more" aria-hidden="true">›</span>
        </button>`;
      }).join('');
  }).join('') +
    (list.length > FIN_TX_LIMIT ? `<button type="button" class="fin-day fin-more" data-fin-more>${
      _finTxAll ? 'Show less ▴' : `Show ${list.length - FIN_TX_LIMIT} more ▾`}</button>` : '');
}


// ── Scan card: receipts that need a second look (any period) ──
function renderFinReviewList() {
  const flagged = getFinTransactions().filter(t => t.needsReview).sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById('finReviewList').innerHTML = flagged.length
    ? flagged.slice(0, 5).map(t => `<button type="button" class="fin-review" data-fin-edit="${t.id}">
        <span class="fin-review-thumb"></span>
        <span class="fin-review-body"><span><b>${_esc(t.merchant || 'Unknown merchant')}</b> · <span class="fin-mono">${_finMoney(t.amount)}</span></span>
          <span class="fin-review-why">${_esc(t.reviewReason || 'Check the details')}</span></span>
        <span class="fin-muted">›</span></button>`).join('') +
      (flagged.length > 5 ? `<div class="fin-scan-tip">+${flagged.length - 5} more — filter by “Needs review”</div>` : '')
    : `<div class="fin-scan-tip">Tip: you can also paste a receipt image (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}V)</div>`;
}


// ── Categories: donut + budget bars ──
function renderFinCats(r, s) {
  document.getElementById('finCatSub').textContent = r.months === 1 ? 'vs monthly budget' : `vs budget × ${r.months} months`;
  document.getElementById('finBudgetEdit').textContent = _finBudgetEditing ? 'Done' : 'Edit budgets';
  document.getElementById('finDonutTotal').textContent = _finMoney(s.spent, false);

  const budgets = getFinBudgets();
  const rows = FIN_EXPENSE_CATS.map(name => ({
    name, color: _finCat(name).color,
    spent: _r2(s.byCat[name] || 0),
    monthly: Number(budgets[name]) || 0,
    budget: (Number(budgets[name]) || 0) * r.months,
  }));

  const R = 66, C = 2 * Math.PI * R;
  let off = 0;
  document.getElementById('finDonut').innerHTML =
    `<circle cx="85" cy="85" r="${R}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="18"/>` +
    (s.spent > 0 ? rows.filter(c => c.spent > 0).sort((a, b) => b.spent - a.spent).map(c => {
      const len = c.spent / s.spent * C;
      const seg = `<circle cx="85" cy="85" r="${R}" fill="none" stroke="${c.color}" stroke-width="18"
        stroke-dasharray="${Math.max(0.5, len - 2.5)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 85 85)"><title>${c.name}: ${_finMoney(c.spent)}</title></circle>`;
      off += len;
      return seg;
    }).join('') : '');

  const shown = rows.filter(c => _finBudgetEditing || c.spent > 0 || c.budget > 0)
    .sort((a, b) => b.spent - a.spent || b.budget - a.budget);
  const el = document.getElementById('finCats');
  if (!shown.length) {
    el.innerHTML = `<div class="fin-empty">Spending by category shows up here. <button class="fin-link" type="button" data-fin-set-budgets>Set budgets</button></div>`;
    return;
  }
  el.innerHTML = shown.map(c => {
    if (_finBudgetEditing) {
      return `<div class="fin-cat editing">
        <span class="fin-dot" style="background:${c.color}"></span><span>${c.name}</span>
        <label class="fin-budget-edit">$<input type="number" inputmode="decimal" min="0" step="10" placeholder="0"
          data-fin-budget="${c.name}" value="${c.monthly || ''}" aria-label="${c.name} monthly budget"><span>/mo</span></label>
      </div>`;
    }
    const pct = c.budget ? c.spent / c.budget : 0;
    const over = c.budget && pct > 1, warn = c.budget && pct >= 0.8;
    const barColor = over ? 'var(--danger)' : warn ? 'var(--warning)' : c.color;
    const flag = over ? `<span class="fin-cat-flag down">+${_finMoney(c.spent - c.budget, false)} over</span>`
      : warn ? `<span class="fin-cat-flag warn">${Math.round(pct * 100)}%</span>` : '';
    return `<button type="button" class="fin-cat${_finCatFilter === c.name ? ' active' : ''}" data-fin-cat-filter="${c.name}" title="Show ${c.name} transactions">
      <span class="fin-dot" style="background:${c.color}"></span>
      <span>${c.name}${flag}</span>
      <span class="fin-cat-amt"><b>${_finMoney(c.spent, false)}</b>${c.budget ? ` / ${_finMoney(c.budget, false)}` : ' <i>no budget</i>'}</span>
      <span class="fin-cat-bar"><span style="width:${c.budget ? Math.min(100, pct * 100) : 0}%;background:${barColor}"></span></span>
    </button>`;
  }).join('');
}


// ── Coming up: next occurrence of each recurring series ──
function _finUpcoming() {
  const latest = new Map();
  getFinTransactions().filter(t => t.recurring).forEach(t => {
    const k = _finMerchantKey(t.merchant) + '|' + t.category;
    const cur = latest.get(k);
    if (!cur || t.date > cur.date) latest.set(k, t);
  });
  const horizon = _finAddDays(_finToday(), FIN_UPCOMING_DAYS);
  return [...latest.values()]
    .map(t => ({ t, due: _finAddMonths(t.date, 1) }))
    .filter(x => x.due <= horizon)
    .sort((a, b) => a.due.localeCompare(b.due));
}

function renderFinUpcoming() {
  const el = document.getElementById('finUpcoming');
  const hasRecurring = getFinTransactions().some(t => t.recurring);
  const list = _finUpcoming();
  if (!list.length) {
    el.innerHTML = `<div class="fin-empty">${hasRecurring
      ? `Nothing due in the next ${FIN_UPCOMING_DAYS} days.`
      : 'Turn on “Repeats monthly” for rent, subscriptions or paychecks and the next one shows up here.'}</div>`;
    return;
  }
  const today = _finToday();
  el.innerHTML = list.map(({ t, due }) => {
    const d = _finDate(due), overdue = due < today, inc = _finIsIncome(t);
    return `<div class="fin-bill">
      <span class="fin-bill-date${overdue ? ' overdue' : ''}"><b>${String(d.getDate()).padStart(2, '0')}</b><span>${_finMonShort(due).toUpperCase()}</span></span>
      <button type="button" class="fin-bill-name" data-fin-edit="${t.id}" title="Open the last one">${_esc(t.merchant || t.category)}
        <span class="fin-card-sub">${_esc(t.category)}${overdue ? ' · <span class="warn">Due</span>' : due === today ? ' · Today' : ''}</span></button>
      <span class="fin-mono${inc ? ' up' : ''}">${inc ? '+' : ''}${_finMoney(t.amount)}</span>
      <button type="button" class="fin-log-btn" data-fin-log="${t.id}" data-fin-due="${due}" title="Record this ${inc ? 'deposit' : 'payment'}">Log</button>
    </div>`;
  }).join('');
}


// ═══════════════════════════════════════════════════════════════════════════
//  Add / edit / scan modal
// ═══════════════════════════════════════════════════════════════════════════
let _finDraft = null;

function _finNewDraft(mode) {
  return {
    mode,                                   // 'scan' | 'manual' | 'edit'
    fields: { merchant: '', amount: '', date: _finToday(), category: null, note: '', recurring: false },
    touched: {}, conf: {}, items: [], split: false, boxes: [], image: null,
    ocr: mode === 'scan' ? 'reading' : null, error: '', guessWhy: '', reviewReason: '',
  };
}

function finOpenManual() {
  _finDraft = _finNewDraft('manual');
  _finOpenModal();
}

async function finOpenEdit(id) {
  const t = getFinTransactions().find(x => x.id === id);
  if (!t) return;
  const d = _finDraft = _finNewDraft('edit');
  d.txId = id;
  d.fields = { merchant: t.merchant || '', amount: t.amount.toFixed(2), date: t.date, category: t.category, note: t.note || '', recurring: !!t.recurring };
  d.touched = { category: true };
  d.receiptId = t.receiptId || null;
  d.reviewReason = t.needsReview ? (t.reviewReason || 'Check the details') : '';
  d.loadingReceipt = !!t.receiptId;
  _finOpenModal();
  if (!t.receiptId) return;
  const rec = await _finReceipt(t.receiptId);
  if (_finDraft !== d) return;
  d.loadingReceipt = false;
  if (rec) {
    d.image = rec.image || null;
    d.boxes = (rec.data && rec.data.boxes) || [];
    d.items = (rec.data && rec.data.items) || [];
    d.subtotal = rec.data && rec.data.subtotal;
    d.tax = rec.data && rec.data.tax;
  }
  renderFinPane();
  renderFinItems();
}

function _finOpenModal() {
  const m = document.getElementById('finModal');
  m.hidden = false;
  document.body.classList.add('fin-modal-open');
  renderFinModal();
  if (_finDraft.mode !== 'scan' && matchMedia('(pointer: fine)').matches) {
    const f = document.getElementById(_finDraft.mode === 'edit' ? 'finF-amount' : 'finF-merchant');
    if (f) f.focus();
  }
}

function _finCloseModal(force) {
  const d = _finDraft;
  if (!force && d && d.mode === 'scan' && d.ocr !== 'reading' && !confirm('Discard this receipt?')) return;
  _finDraft = null;
  document.getElementById('finModal').hidden = true;
  document.body.classList.remove('fin-modal-open');
}

// Receipt photo → an OCR-sized JPEG (under OCR.space's 1 MB limit) and a smaller
// one to keep with the transaction. Returns null if the browser can't decode it.
async function _finPrepImage(file, rotation) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { return null; }
  const draw = maxSide => {
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const sideways = rotation % 180 !== 0;
    const c = document.createElement('canvas');
    c.width = sideways ? h : w; c.height = sideways ? w : h;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
    return c;
  };
  let ocrCanvas, ocrUrl;
  for (const side of [2000, 1600, 1200]) {
    ocrCanvas = draw(side);
    for (let q = 0.85; q >= 0.45; q -= 0.2) {
      ocrUrl = ocrCanvas.toDataURL('image/jpeg', q);
      if (ocrUrl.length <= 1_000_000) break;
    }
    if (ocrUrl.length <= 1_000_000) break;
  }
  const thumbUrl = draw(1000).toDataURL('image/jpeg', 0.7);
  bmp.close && bmp.close();
  return { ocrUrl, thumbUrl, w: ocrCanvas.width, h: ocrCanvas.height };
}

function finStartScan(file) {
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/i.test(file.name)) {
    _finToast('That isn’t an image', 'Pick a photo or screenshot of the receipt.');
    return;
  }
  if (file.size > 20 * 1024 * 1024) { _finToast('Image is over 20 MB', 'Try a smaller photo.'); return; }
  const d = _finDraft = _finNewDraft('scan');
  d.file = file;
  d.rotation = 0;
  _finOpenModal();
  _finRunOcr(d);
}

async function _finRunOcr(d) {
  const run = d.run = (d.run || 0) + 1;
  const live = () => _finDraft === d && d.run === run;
  Object.assign(d, { ocr: 'reading', error: '', conf: {}, items: [], boxes: [], split: false, image: null });
  d.touched = {};
  renderFinModal();
  try {
    const img = await _finPrepImage(d.file, d.rotation);
    if (!live()) return;
    d.image = img ? img.thumbUrl : null;
    renderFinPane();
    const ocr = await _dietOcr(img ? img.ocrUrl : await _dietFileToDataUrl(d.file));
    if (!live()) return;
    const rows = _finRowsFromOcr(ocr);
    const p = _finParseReceipt(rows);
    const f = d.fields;
    if (!d.touched.merchant && p.merchant) f.merchant = p.merchant;
    if (!d.touched.amount && p.total != null) f.amount = p.total.toFixed(2);
    if (!d.touched.date && p.date) f.date = p.date;
    d.conf = p.conf;
    d.subtotal = p.subtotal;
    d.tax = p.tax;
    const g = _finGuessCategory(f.merchant, ocr.text, 'Other');
    if (!d.touched.category) { f.category = g.cat; d.guessWhy = g.why; }
    d.items = p.items.map(it => ({ ...it, category: f.category }));
    if (img) d.boxes = _finBoxes(rows, p.rowIdx, img.w, img.h);
    d.ocr = 'done';
  } catch (err) {
    if (!live()) return;
    console.error('[finance] receipt scan failed:', err);
    d.ocr = 'error';
    d.error = err.message || 'try again';
    d.conf = { merchant: 'missing', total: 'missing', date: 'missing' };
    if (!d.touched.category) { d.fields.category = 'Other'; d.guessWhy = ''; }
  }
  renderFinModal();
}

// Highlight rectangles (percent of the image) for the rows the fields came from.
function _finBoxes(rows, rowIdx, w, h) {
  const pad = Math.max(w, h) * 0.006;
  return Object.entries(rowIdx).filter(([, i]) => i != null && rows[i] && rows[i].x1 != null).map(([kind, i]) => {
    const r = rows[i];
    const x0 = Math.max(0, r.x0 - pad), y0 = Math.max(0, r.y0 - pad);
    const x1 = Math.min(w, r.x1 + pad), y1 = Math.min(h, r.y1 + pad);
    return { kind, x: x0 / w * 100, y: y0 / h * 100, w: (x1 - x0) / w * 100, h: (y1 - y0) / h * 100 };
  });
}

const _FIN_CONF_LABEL = {
  high: ['up', 'High'], medium: ['warn', 'Check'], low: ['warn', 'Guess'], missing: ['down', 'Not found'],
};
function _finConfKey(field) { return field === 'amount' ? 'total' : field; }
function _finConfHTML(field) {
  const d = _finDraft;
  if (d.mode !== 'scan' || d.ocr !== 'done' && d.ocr !== 'error') return '';
  if (d.touched[field]) return '<span class="fin-muted">● Edited</span>';
  const c = _FIN_CONF_LABEL[d.conf[_finConfKey(field)]];
  return c ? `<span class="${c[0]}">● ${c[1]}</span>` : '';
}
function _finFieldFlagged(field) {
  const d = _finDraft;
  return d.mode === 'scan' && d.ocr !== 'reading' && !d.touched[field] &&
    ['medium', 'low', 'missing'].includes(d.conf[_finConfKey(field)]);
}

function renderFinModal() {
  const d = _finDraft;
  if (!d) return;
  const f = d.fields;
  const reading = d.ocr === 'reading';
  const hasPane = d.mode === 'scan' || !!d.receiptId;
  const sw = d.mode === 'scan' && d.boxes.length ? k => {
    const b = d.boxes.find(x => x.kind === k);
    return b ? `<span class="sw" style="background:${FIN_BOX_COLORS[k]}"></span>` : '';
  } : () => '';
  const field = (key, label, input, wide, swKind) => `
    <div class="fin-field${wide ? ' wide' : ''}${_finFieldFlagged(key) ? ' check' : ''}" id="finFW-${key}">
      <label for="finF-${key}">${swKind ? sw(swKind) : ''}${label}<span class="conf" id="finConf-${key}">${_finConfHTML(key)}</span></label>
      ${input}
    </div>`;
  const dis = reading ? 'disabled' : '';
  const merchants = [...new Set(getFinTransactions().map(t => t.merchant).filter(Boolean))].slice(0, 200);

  const top = d.mode === 'scan'
    ? `<div class="fin-steps" id="finModalTitle" aria-label="Scan receipt: review step">
        <span class="s done"><i>✓</i>Capture</span><span class="sep"></span>
        <span class="s on"><i>2</i>Review</span><span class="sep"></span>
        <span class="s"><i>3</i>Saved</span>
      </div>`
    : `<h2 class="fin-modal-title" id="finModalTitle">${d.mode === 'edit' ? 'Edit transaction' : 'New transaction'}</h2>`;

  document.getElementById('finModalCard').innerHTML = `
    <div class="fin-modal-top">${top}<button type="button" class="fin-icon-btn" data-fin-close aria-label="Close">×</button></div>
    <div class="fin-modal-body${hasPane ? '' : ' single'}">
      ${hasPane ? '<div class="fin-pane" id="finPane"></div>' : ''}
      <div class="fin-form">
        ${d.reviewReason ? `<div class="fin-banner warn">⚠ ${_esc(d.reviewReason)} — saving marks it reviewed.</div>` : ''}
        ${d.ocr === 'error' ? `<div class="fin-banner down">Couldn’t read this receipt (${_esc(d.error)}). Fill it in below, or rescan.</div>` : ''}
        <div class="fin-fields${reading ? ' reading' : ''}">
          ${field('merchant', 'Merchant', `<input class="task-input" id="finF-merchant" data-fin-field="merchant" list="finMerchantList"
              value="${_esc(f.merchant)}" placeholder="${reading ? 'Reading…' : 'e.g. Trader Joe’s'}" autocomplete="off" ${dis}>
              <datalist id="finMerchantList">${merchants.map(m => `<option value="${_esc(m)}">`).join('')}</datalist>`, true, 'merchant')}
          ${field('amount', 'Total', `<div class="fin-amount-wrap"><span>$</span><input class="task-input fin-amount" id="finF-amount" data-fin-field="amount"
              inputmode="decimal" value="${_esc(f.amount)}" placeholder="${reading ? '…' : '0.00'}" autocomplete="off" ${dis}></div>`, false, 'total')}
          ${field('date', 'Date', `<input class="task-input fin-mono" type="date" id="finF-date" data-fin-field="date" value="${f.date}" ${dis}>`, false, 'date')}
          <div class="fin-field wide${d.split ? ' muted' : ''}">
            <label>Category</label>
            <div class="fin-cat-pick" id="finCatPick"></div>
            <div class="fin-guess" id="finGuess"></div>
          </div>
          ${field('note', 'Note <span class="fin-muted">(optional)</span>', `<input class="task-input" id="finF-note" data-fin-field="note" value="${_esc(f.note)}" placeholder="e.g. dinner party" autocomplete="off" ${dis}>`, true)}
          <div class="fin-field wide" id="finRecurringRow" ${d.split ? 'hidden' : ''}>
            <div class="fin-toggle-row">
              <button type="button" class="fin-toggle${f.recurring ? ' on' : ''}" data-fin-recurring role="switch" aria-checked="${!!f.recurring}" aria-label="Repeats monthly" ${dis}></button>
              <span>Repeats monthly <span class="fin-muted">— the next one shows in Coming up</span></span>
            </div>
          </div>
        </div>
        <div id="finItemsWrap"></div>
        <div id="finImpact"></div>
        <div class="fin-modal-err" id="finModalErr" role="alert"></div>
      </div>
    </div>
    <div class="fin-modal-foot">
      <div class="left">${d.mode === 'edit'
        ? '<button type="button" class="fin-link danger" data-fin-delete>Delete transaction</button>'
        : d.mode === 'scan' ? 'Nothing is saved until you confirm.' : ''}</div>
      <div class="right">
        <button type="button" class="btn-polish" data-fin-close>${d.mode === 'scan' ? 'Discard' : 'Cancel'}</button>
        <button type="button" class="btn-add" data-fin-save ${dis}>${d.mode === 'edit' ? 'Save changes' : 'Save transaction'}</button>
      </div>
    </div>`;
  renderFinPane();
  renderFinCatPick();
  renderFinItems();
  renderFinImpact();
}

function renderFinPane() {
  const pane = document.getElementById('finPane');
  const d = _finDraft;
  if (!pane || !d) return;
  const reading = d.ocr === 'reading';
  let inner;
  if (d.image) {
    const boxes = reading ? '' : d.boxes.map(b =>
      `<span class="fin-box" style="left:${b.x}%;top:${b.y}%;width:${b.w}%;height:${b.h}%;--c:${FIN_BOX_COLORS[b.kind]}" title="${b.kind}"></span>`).join('');
    inner = `<div class="fin-receipt${reading ? ' reading' : ''}"><img src="${d.image}" alt="Receipt photo">${boxes}${reading ? '<span class="fin-scanline"></span>' : ''}</div>`;
  } else if (reading || d.loadingReceipt) {
    inner = `<div class="fin-pane-empty"><span class="fin-spinner"></span>${reading ? 'Reading receipt…' : 'Loading receipt…'}</div>`;
  } else {
    inner = `<div class="fin-pane-empty">${d.mode === 'scan' ? 'No preview for this image type' : 'Receipt image not available'}</div>`;
  }
  const cap = reading ? 'Reading receipt…' : d.image ? (d.mode === 'scan' ? 'Image kept with transaction' : 'Saved receipt') : '';
  pane.innerHTML = `<div class="fin-paper-wrap">${inner}</div>
    <div class="fin-paper-cap">
      ${d.mode === 'scan' ? `<button type="button" data-fin-rescan>Rescan</button><button type="button" data-fin-rotate ${reading || !d.file ? 'disabled' : ''}>Rotate</button>` : ''}
      <span>${cap}</span>
    </div>`;
}

function renderFinCatPick() {
  const d = _finDraft, el = document.getElementById('finCatPick');
  if (!el) return;
  const on = d.fields.category;
  const disabled = d.ocr === 'reading' || d.split;
  el.innerHTML = FIN_CATEGORIES.map(c =>
    `<button type="button" class="${c.name === on ? 'on' : ''}" data-fin-cat="${c.name}" ${disabled ? 'disabled' : ''}
      style="${c.name === on ? `background:${c.color}` : `--c:${c.color}`}" aria-pressed="${c.name === on}">${c.name}</button>`).join('');
  const guess = document.getElementById('finGuess');
  guess.textContent = d.split ? 'Categories come from the line items while the receipt is split.' : (d.touched.category && d.mode !== 'edit' ? '' : d.guessWhy);
}

function renderFinItems() {
  const d = _finDraft, el = document.getElementById('finItemsWrap');
  if (!el) return;
  if (!d.items.length) { el.innerHTML = ''; return; }
  const itemsSum = _r2(d.items.reduce((s, it) => s + it.amount, 0));
  const total = _finParseAmount(d.fields.amount);
  const expected = _r2(itemsSum + (d.tax || 0));
  const canSplit = d.mode === 'scan' && d.items.length >= 2 && d.fields.category !== 'Income';
  const differing = d.items.map(it => [it.name, _finHintCategory(it.name, _FIN_ITEM_HINTS)])
    .filter(([, c]) => c && c !== d.fields.category).slice(0, 2);
  const hint = differing.length
    ? `<span class="fin-muted">(${differing.map(([n, c]) => `${_esc(n.toLowerCase())} → ${c}`).join(', ')})</span>` : '';
  const catCell = (it, i) => {
    const cat = d.split ? it.category : (d.mode === 'edit' ? it.category : d.fields.category) || 'Other';
    const col = _finCat(cat).color;
    if (d.split) {
      return `<select class="fin-item-cat" data-fin-item="${i}" style="--c:${col}" aria-label="Category for ${_esc(it.name)}">
        ${FIN_EXPENSE_CATS.map(c => `<option${c === cat ? ' selected' : ''}>${c}</option>`).join('')}</select>`;
    }
    return `<span class="fin-mini-tag" style="background:${col}22;color:${col}">${cat}</span>`;
  };
  el.innerHTML = `<details class="fin-items" open>
    <summary><span>Line items · ${d.items.length} detected</span>
      <span class="fin-mono fin-muted">${_finMoney(d.subtotal ?? itemsSum)}${d.tax ? ` + ${_finMoney(d.tax)} tax` : ''}</span></summary>
    <div class="fin-items-list">${d.items.map((it, i) => `<div class="fin-item">
      <span>${_esc(it.name)}</span>${catCell(it, i)}<span class="fin-mono">${it.amount.toFixed(2)}</span></div>`).join('')}</div>
    ${total > 0 && Math.abs(expected - total) > 0.05 && d.mode === 'scan'
      ? `<div class="fin-items-note">Items add up to ${_finMoney(expected)} — some lines may not have been read. The total is what gets saved.</div>` : ''}
    ${canSplit ? `<div class="fin-split">
      <button type="button" class="fin-toggle${d.split ? ' on' : ''}" data-fin-split role="switch" aria-checked="${d.split}" aria-label="Split by category"></button>
      <span>Split this receipt by category ${hint}</span></div>` : ''}
  </details>`;
}

function renderFinImpact() {
  const d = _finDraft, el = document.getElementById('finImpact');
  if (!el) return;
  const amount = _finParseAmount(d.fields.amount);
  if (!(amount > 0) || d.ocr === 'reading') { el.innerHTML = ''; return; }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d.fields.date) ? d.fields.date : _finToday();
  const parts = d.split ? _finSplitAmounts(d.items, amount) : (d.fields.category ? { [d.fields.category]: amount } : {});
  el.innerHTML = Object.entries(parts).filter(([c]) => c !== 'Income').map(([cat, amt]) => {
    const { spent, budget } = _finCatMonth(cat, date, amt, d.txId);
    if (!budget) {
      return `<div class="fin-impact"><span>${cat} after saving</span>
        <span class="fin-muted fin-impact-right"><span class="fin-mono">${_finMoney(spent)}</span> in ${_finMonShort(date)} · no budget</span></div>`;
    }
    const pct = spent / budget;
    const col = pct > 1 ? 'var(--danger)' : pct >= 0.8 ? 'var(--warning)' : 'var(--success)';
    return `<div class="fin-impact"><span>${cat} after saving</span>
      <span class="fin-cat-bar"><span style="width:${Math.min(100, pct * 100)}%;background:${col}"></span></span>
      <span class="fin-mono">${_finMoney(spent, false)} / ${_finMoney(budget, false)}</span></div>`;
  }).join('');
}

function _finModalError(msg) {
  const el = document.getElementById('finModalErr');
  if (el) el.textContent = msg;
}

function _finSave() {
  const d = _finDraft;
  if (!d || d.ocr === 'reading') return;
  const f = d.fields;
  const amount = _finParseAmount(f.amount);
  if (!(amount > 0)) { _finModalError('Enter an amount above $0.'); document.getElementById('finF-amount').focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) { _finModalError('Pick a date.'); return; }
  if (!d.split && !f.category) { _finModalError('Pick a category.'); return; }
  const merchant = f.merchant.trim(), note = f.note.trim();
  const list = getFinTransactions();
  const where = merchant ? ` at ${_esc(merchant)}` : '';

  if (d.mode === 'edit') {
    const i = list.findIndex(t => t.id === d.txId);
    if (i < 0) { _finCloseModal(true); return; }
    const prev = list[i];
    const next = { ...prev, merchant, amount, date: f.date, category: f.category, note, recurring: !!f.recurring, needsReview: false, reviewReason: '' };
    saveFinTransactions(list.map(t => (t.id === d.txId ? next : t)));
    _finCloseModal(true);
    _finShowDate(next.date);
    renderFinance();
    _finToast(`Saved ${_finMoney(amount)}${where}`, _finBudgetSentence(next.category, next.date), () => {
      saveFinTransactions(getFinTransactions().map(t => (t.id === prev.id ? prev : t)));
      renderFinance();
    });
    return;
  }

  let receiptId = null;
  if (d.mode === 'scan' && (d.image || d.items.length)) {
    receiptId = 'r_' + _finId().slice(2);
    const rec = { image: d.image, data: { boxes: d.boxes, items: d.items.map(it => ({ ...it, category: d.split ? it.category : f.category })), subtotal: d.subtotal ?? null, tax: d.tax ?? null } };
    _finReceiptCache.set(receiptId, rec);
    _finPutReceipt(receiptId, rec.image, rec.data);
  }
  const reasons = [];
  if (d.mode === 'scan') {
    if (!merchant) reasons.push('Merchant not found — add a name');
    if (['low', 'missing'].includes(d.conf.date) && !d.touched.date) reasons.push('Date unreadable — confirm it');
    if (['low', 'missing'].includes(d.conf.total) && !d.touched.amount) reasons.push('Total was a guess — check it');
  }
  const base = {
    date: f.date, merchant, note, source: d.mode === 'scan' ? 'scan' : 'manual', receiptId,
    needsReview: reasons.length > 0, reviewReason: reasons[0] || '',
  };
  const created = d.split && d.items.length >= 2
    ? Object.entries(_finSplitAmounts(d.items, amount)).map(([category, amt]) => ({ id: _finId(), ...base, amount: amt, category, recurring: false }))
    : [{ id: _finId(), ...base, amount, category: f.category, recurring: !!f.recurring }];
  saveFinTransactions([...list, ...created]);
  _finCloseModal(true);
  _finShowDate(f.date);
  renderFinance();
  const ids = new Set(created.map(t => t.id));
  _finToast(`Saved ${_finMoney(amount)}${where}`,
    created.length > 1 ? `Split across ${created.map(t => t.category).join(', ')}` : _finBudgetSentence(created[0].category, f.date),
    () => {
      saveFinTransactions(getFinTransactions().filter(t => !ids.has(t.id)));
      _finCleanupReceipt(receiptId);
      renderFinance();
    });
}

function _finDelete() {
  const d = _finDraft;
  const t = d && getFinTransactions().find(x => x.id === d.txId);
  if (!t) return;
  saveFinTransactions(getFinTransactions().filter(x => x.id !== t.id));
  _finCloseModal(true);
  renderFinance();
  _finToast(`Deleted ${_finMoney(t.amount)}${t.merchant ? ' at ' + _esc(t.merchant) : ''}`, '',
    () => { saveFinTransactions([...getFinTransactions(), t]); renderFinance(); },
    () => _finCleanupReceipt(t.receiptId));
}

// Jump the view to the period containing `ds` if it's outside the current one.
function _finShowDate(ds) {
  const r = _finRange();
  if (ds >= r.start && ds <= r.end) return;
  const d = _finDate(ds);
  _finAnchor = { y: d.getFullYear(), m: d.getMonth() };
  _finTxAll = false;
}

function _finLogRecurring(id, due) {
  const src = getFinTransactions().find(t => t.id === id);
  if (!src) return;
  const t = { id: _finId(), date: due, merchant: src.merchant, amount: src.amount, category: src.category,
    note: '', source: 'manual', receiptId: null, recurring: true, needsReview: false, reviewReason: '' };
  saveFinTransactions([...getFinTransactions(), t]);
  renderFinance();
  _finToast(`Logged ${_finMoney(t.amount)}${t.merchant ? ' · ' + _esc(t.merchant) : ''}`, _finBudgetSentence(t.category, t.date), () => {
    saveFinTransactions(getFinTransactions().filter(x => x.id !== t.id));
    renderFinance();
  });
}


// ── Toast with undo ──
let _finToastTimer = null, _finToastExpire = null;
function _finToast(title, sub, onUndo, onExpire) {
  const el = document.getElementById('finToast');
  if (_finToastExpire) { const fn = _finToastExpire; _finToastExpire = null; fn(); }
  clearTimeout(_finToastTimer);
  el.innerHTML = `<span class="fin-toast-check">${onUndo ? '✓' : '!'}</span>
    <span class="fin-toast-body"><span>${title}</span>${sub ? `<span class="fin-muted">${sub}</span>` : ''}</span>
    ${onUndo ? '<button type="button" class="fin-toast-undo">Undo</button>' : ''}`;
  el.hidden = false;
  _finToastExpire = onExpire || null;
  const finish = () => {
    el.hidden = true;
    const fn = _finToastExpire; _finToastExpire = null;
    if (fn) fn();
  };
  _finToastTimer = setTimeout(finish, onUndo ? 7000 : 4000);
  if (onUndo) {
    el.querySelector('.fin-toast-undo').onclick = () => {
      clearTimeout(_finToastTimer);
      el.hidden = true;
      _finToastExpire = null;
      onUndo();
    };
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  Listeners
// ═══════════════════════════════════════════════════════════════════════════
if (typeof document !== 'undefined') {
  const panel = document.getElementById('tab-finance');
  const modal = document.getElementById('finModal');
  const fileInput = document.getElementById('finScanFile');
  const rerender = () => renderFinance();

  panel.addEventListener('click', e => {
    const t = e.target.closest('button, [data-fin-drop]');
    if (!t) return;
    if (t.id === 'finScanBtn' || t.hasAttribute('data-fin-drop')) { fileInput.click(); return; }
    if (t.id === 'finManualBtn') { finOpenManual(); return; }
    if (t.id === 'finPrev' || t.id === 'finNext') {
      _finAnchor = _finShift(_finAnchor, _finPeriod, t.id === 'finPrev' ? -1 : 1);
      _finTxAll = false; rerender(); return;
    }
    if (t.id === 'finToday') {
      const n = new Date(); _finAnchor = { y: n.getFullYear(), m: n.getMonth() };
      _finTxAll = false; rerender(); return;
    }
    if (t.dataset.finPeriod) { _finPeriod = t.dataset.finPeriod; _finTxAll = false; rerender(); return; }
    if (t.dataset.finFilter) { _finFilter = t.dataset.finFilter; _finTxAll = false; rerender(); return; }
    if (t.hasAttribute('data-fin-cat-clear')) { _finCatFilter = null; rerender(); return; }
    if (t.dataset.finCatFilter) {
      _finCatFilter = _finCatFilter === t.dataset.finCatFilter ? null : t.dataset.finCatFilter;
      _finTxAll = false; rerender();
      if (_finCatFilter && window.innerWidth <= 1100) document.getElementById('finTxCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (t.hasAttribute('data-fin-clear-filters')) {
      _finFilter = 'all'; _finCatFilter = null; _finSearch = '';
      document.getElementById('finSearch').value = '';
      rerender(); return;
    }
    if (t.hasAttribute('data-fin-more')) { _finTxAll = !_finTxAll; rerender(); return; }
    if (t.dataset.finEdit) { finOpenEdit(t.dataset.finEdit); return; }
    if (t.dataset.finLog) { _finLogRecurring(t.dataset.finLog, t.dataset.finDue); return; }
    if (t.id === 'finBudgetEdit' || t.hasAttribute('data-fin-set-budgets')) {
      _finBudgetEditing = t.id === 'finBudgetEdit' ? !_finBudgetEditing : true;
      rerender();
      if (_finBudgetEditing) {
        const card = document.getElementById('finCatCard');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const first = card.querySelector('[data-fin-budget]');
        if (first && matchMedia('(pointer: fine)').matches) first.focus();
      }
    }
  });

  panel.addEventListener('input', e => {
    if (e.target.id === 'finSearch') { _finSearch = e.target.value; _finTxAll = false; const r = _finRange(); renderFinTxList(r, _finSummary(r)); }
  });

  panel.addEventListener('change', e => {
    const cat = e.target.dataset && e.target.dataset.finBudget;
    if (!cat) return;
    const b = { ...getFinBudgets() };
    const v = _r2(Number(e.target.value));
    if (v > 0) b[cat] = v; else delete b[cat];
    saveFinBudgets(b);
    const r = _finRange(), s = _finSummary(r), p = _finPace(r, s);
    renderFinHero(r, s, p);
    renderFinChart(r, s, p);
  });

  panel.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.finBudget) e.target.blur();
  });

  // Chart hover: follow the pointer, snap back to today on leave.
  const chart = document.getElementById('finChart');
  chart.addEventListener('pointermove', e => {
    const c = _finChart;
    if (!c || !c.endIdx) return;
    const rect = chart.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (c.W / rect.width);
    const d = Math.round((px - c.L) / (c.W - c.L - c.R) * c.r.days);
    _finDrawMarker(Math.max(1, Math.min(c.endIdx, d)));
  });
  chart.addEventListener('pointerleave', () => _finChart && _finDrawMarker(_finChart.endIdx));
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!panel.classList.contains('active')) return;
      const r = _finRange(), s = _finSummary(r);
      renderFinChart(r, s, _finPace(r, s));
    }, 150);
  });

  // Drop zone
  const drop = document.getElementById('finDrop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    finStartScan(e.dataTransfer.files[0]);
  });
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });

  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    finStartScan(file);
  });

  document.addEventListener('paste', e => {
    if (!panel.classList.contains('active') || (_finDraft && _finDraft.mode !== 'scan')) return;
    const file = [...((e.clipboardData && e.clipboardData.files) || [])].find(f => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); finStartScan(file); }
  });

  // Modal
  modal.addEventListener('click', e => {
    if (e.target === modal) { _finCloseModal(false); return; }
    const t = e.target.closest('button');
    if (!t || !_finDraft) return;
    const d = _finDraft;
    if (t.hasAttribute('data-fin-close')) { _finCloseModal(true); return; }
    if (t.hasAttribute('data-fin-save')) { _finSave(); return; }
    if (t.hasAttribute('data-fin-delete')) { _finDelete(); return; }
    if (t.hasAttribute('data-fin-rescan')) { fileInput.click(); return; }
    if (t.hasAttribute('data-fin-rotate')) { d.rotation = ((d.rotation || 0) + 90) % 360; _finRunOcr(d); return; }
    if (t.dataset.finCat) {
      d.fields.category = t.dataset.finCat;
      d.touched.category = true;
      if (!d.split) d.items.forEach(it => { it.category = d.fields.category; });
      renderFinCatPick(); renderFinItems(); renderFinImpact();
      _finModalError('');
      return;
    }
    if (t.hasAttribute('data-fin-recurring')) {
      d.fields.recurring = !d.fields.recurring;
      t.classList.toggle('on', d.fields.recurring);
      t.setAttribute('aria-checked', d.fields.recurring);
      return;
    }
    if (t.hasAttribute('data-fin-split')) {
      d.split = !d.split;
      d.items.forEach(it => { it.category = d.split ? (_finHintCategory(it.name, _FIN_ITEM_HINTS) || d.fields.category || 'Other') : d.fields.category; });
      if (d.split) d.fields.recurring = false;
      document.getElementById('finRecurringRow').hidden = d.split;
      t.closest('.fin-modal-body').querySelector('#finCatPick').parentElement.classList.toggle('muted', d.split);
      renderFinCatPick(); renderFinItems(); renderFinImpact();
    }
  });

  modal.addEventListener('input', e => {
    const key = e.target.dataset && e.target.dataset.finField;
    const d = _finDraft;
    if (!key || !d) return;
    d.fields[key] = e.target.value;
    d.touched[key] = true;
    const conf = document.getElementById('finConf-' + key);
    if (conf) conf.innerHTML = _finConfHTML(key);
    const wrap = document.getElementById('finFW-' + key);
    if (wrap) wrap.classList.remove('check');
    _finModalError('');
    if (key === 'merchant' && !d.touched.category) {
      const g = _finGuessCategory(d.fields.merchant, '', d.mode === 'scan' ? 'Other' : null);
      d.fields.category = g.cat;
      d.guessWhy = g.why;
      if (!d.split) d.items.forEach(it => { it.category = g.cat; });
      renderFinCatPick(); renderFinItems();
    }
    if (key === 'amount' || key === 'date' || key === 'merchant') renderFinImpact();
    if (key === 'amount') renderFinItems();
  });

  modal.addEventListener('change', e => {
    const i = e.target.dataset && e.target.dataset.finItem;
    if (i == null || !_finDraft) return;
    _finDraft.items[+i].category = e.target.value;
    e.target.style.setProperty('--c', _finCat(e.target.value).color);
    renderFinImpact();
  });

  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); _finCloseModal(false); return; }
    if (e.key === 'Enter' && e.target.matches('input[data-fin-field]')) { e.preventDefault(); _finSave(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _finDraft && !modal.hidden && !modal.contains(document.activeElement)) _finCloseModal(false);
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.dataset.tab === 'finance') btn.addEventListener('click', () => setTimeout(rerender));
  });
}

if (typeof module !== 'undefined') module.exports = { _finParseReceipt, _finRowsFromOcr, _finSplitAmounts };
