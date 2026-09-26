// Diet tab: meal log entry form, history, the Healthy Ingredients vs Unhealthy
// Foods lists + feedback, and the category breakdown. Loaded before main.js.
//
// Persistence: the diet_entries and diet_foods tables, via _syncDietEntries /
// _syncDietFoods in js/main.js (upsert + delete-missing, like _syncHabits).
// MEM still holds the flat blob shape (diet_entries_v1 / diet_healthy_v1 /
// diet_unhealthy_v1); LOCAL_MODE falls back to localStorage for free.
//
// Healthy things are tracked as *ingredients* (whole foods — eggs, kiwi, chicken)
// because that's what they are; unhealthy things are tracked as whole *foods*
// (a donut, a soda) with no ingredient breakdown.

// ── Categories ──
// Fast Food is a subset of Outside Food. That rollup lives ONLY in the stats
// layer (_dietCategoryCounts) — the entry form is a plain single-select.
const DIET_CATEGORIES = ['Homecooked Meal', 'Outside Food', 'Fast Food'];
const DIET_CATEGORY_STYLE = {
  'Homecooked Meal': { bg: 'rgba(82,201,122,0.18)', color: '#52C97A' },
  'Outside Food':    { bg: 'rgba(239,159,39,0.18)', color: '#EF9F27' },
  'Fast Food':       { bg: 'rgba(226,75,74,0.20)',  color: '#E24B4A' },
};

const DIET_RANGES = [['7', 'Week'], ['30', 'Month'], ['all', 'All time']];

// ── Store ──
// MEM keeps the flat blob shape; persistence goes to the diet_entries / diet_foods
// tables (see _syncDietEntries / _syncDietFoods in js/main.js).
function getDietEntries()      { return MEM['diet_entries_v1'] || []; }
function saveDietEntries(list) { MEM['diet_entries_v1'] = list; _syncDietEntries(list); }

function getHealthyIngredients()      { return MEM['diet_healthy_v1'] || []; }
function saveHealthyIngredients(list) { MEM['diet_healthy_v1'] = list; _syncDietFoods('healthy', list); }
function getUnhealthyFoods()          { return MEM['diet_unhealthy_v1'] || []; }
function saveUnhealthyFoods(list)     { MEM['diet_unhealthy_v1'] = list; _syncDietFoods('unhealthy', list); }

// ponytail: whole list in one settings row. Own table if the log gets long enough that rewriting it on every dose matters.
function getSupplements()      { return MEM['diet_supplements_v1'] || []; }
function saveSupplements(list) { MEM['diet_supplements_v1'] = list; _syncSetting('diet_supplements_v1', list); }

// On/off cycles, keyed by lowercase supplement name: { on: days, off: days, start: 'YYYY-MM-DD' }.
function getSuppCycles()      { return MEM['diet_supp_cycles_v1'] || {}; }
function saveSuppCycles(map)  { MEM['diet_supp_cycles_v1'] = map; _syncSetting('diet_supp_cycles_v1', map); }

// One-time move off the old model: priority foods + the healthy side of the old
// combined list → Healthy Ingredients; the unhealthy side → Unhealthy Foods.
function _dietMigrateFoodLists() {
  if (MEM['diet_healthy_v1'] || MEM['diet_unhealthy_v1']) return;
  if (!MEM['diet_hu_foods_v1'] && !MEM['diet_priority_foods_v1']) return;
  const hu = MEM['diet_hu_foods_v1'] || [];
  const healthy = [
    ...(MEM['diet_priority_foods_v1'] || []),
    ...hu.filter(f => f && f.kind === 'healthy').map(f => f.name),
  ];
  const unhealthy = hu.filter(f => f && f.kind === 'unhealthy').map(f => f.name);
  saveHealthyIngredients([...new Set(healthy)]);
  saveUnhealthyFoods([...new Set(unhealthy)]);
}

// Per-entry accessors, tolerant of meals logged under the old field names.
function _entHealthy(e) {
  if (Array.isArray(e.healthyIngredients)) return e.healthyIngredients;
  const H = new Set(getHealthyIngredients());
  return [
    ...(e.huFoods || []).filter(n => H.has(n)),
    ...(e.ingredients || []).map(i => i.name).filter(n => H.has(n)),
  ];
}
function _entUnhealthy(e) {
  if (Array.isArray(e.unhealthyFoods)) return e.unhealthyFoods;
  const U = new Set(getUnhealthyFoods());
  return (e.huFoods || []).filter(n => U.has(n));
}

// ── UI state (not persisted) ──
let _dietCategory      = DIET_CATEGORIES[0];
let _dietMealHealthy   = [];             // healthy-ingredient names tagged for the meal being entered
let _dietMealUnhealthy = [];             // unhealthy-food names tagged for the meal being entered
let _dietHistoryCat    = 'all';          // 'all' | a DIET_CATEGORIES value
let _dietFoodRange     = '30';           // '7' | '30' | 'all'
let _dietCatRange      = '30';
let _dietHistoryAll    = false;          // "show more" in the history list
let _dietView         = 'meals';         // 'meals' | 'supplements'
let _suppHistoryDays  = 7;             // day groups shown in the supplement log
let _suppPick         = '';             // existing supplement selected in the modal
let _suppCreating     = false;          // "+ New" chosen for the typed name
let _suppKind         = 'single';       // 'single' | 'label'
let _suppRows         = [];             // [{ name, amount, unit }] per pill, for 'label'
let _suppCycleOn      = false;          // modal's Schedule toggle: every day vs cycle

const SUPP_UNITS = ['mg', 'mcg', 'g', 'IU', 'CFU', 'mL'];

const DIET_HISTORY_LIMIT = 8;

// Screenshot import. Data comes from an external tracker (Cal AI, MyFitnessPal,
// …); this OCRs the numbers off a screenshot with OCR.space so they don't have
// to be retyped, then parses the plain text locally — no LLM. OCR.space free
// tier is 25k requests/month; the default 'helloworld' key works for light use.
// Get a free key at https://ocr.space/ocrapi/freekey and set OCR_SPACE_API_KEY
// in js/main.js.

function _dietId() {
  return 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function _dietToday() { return _localDateStr(new Date()); }

// First date included by a range: 'all' → null, N → N-1 days back (today counts).
function _dietRangeFloor(range) {
  if (range === 'all') return null;
  const d = new Date();
  d.setDate(d.getDate() - (Number(range) - 1));
  return _localDateStr(d);
}

function _dietEntriesInRange(range) {
  const floor = _dietRangeFloor(range);
  return getDietEntries().filter(e => !floor || e.date >= floor);
}

// Most recent first. Undated entries can't happen (the form requires a date),
// but sort defensively anyway.
function _dietSortedEntries() {
  return [...getDietEntries()].sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') ||
    (b.time || '').localeCompare(a.time || '') ||
    (b.id || '').localeCompare(a.id || ''));
}

function _dietFmtDate(ds) {
  if (!ds) return '—';
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function _dietFmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Days since `ds`, as a short human label.
function _dietAgoLabel(ds) {
  const n = daysBetween(ds, _dietToday());
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return `${n}d ago`;
}

// Segmented range/filter bar. Deliberately NOT `.habit-sort-btn` / `.job-sort-btn`
// — those class names are claimed by document-level listeners in habits.js/jobs.js.
function _dietSegHTML(options, active, attr) {
  return options.map(([v, l]) =>
    `<button class="diet-seg-btn${v === active ? ' active' : ''}" ${attr}="${v}">${l}</button>`).join('');
}

// case-insensitive "is this name already in the list"
function _dietHas(list, name) {
  return list.some(n => n.toLowerCase() === name.toLowerCase());
}


// ── Entry form ──
function renderDietForm() {
  const dateInput = document.getElementById('dietDate');
  if (!dateInput) return;
  if (!dateInput.value) dateInput.value = _dietToday();
  dateInput.max = _dietToday();

  document.getElementById('dietCatBtns').innerHTML = DIET_CATEGORIES.map(c => {
    const s = DIET_CATEGORY_STYLE[c];
    const on = c === _dietCategory;
    return `<button class="diet-cat-btn${on ? ' active' : ''}" data-cat="${c}"
      style="${on ? `background:${s.bg};color:${s.color};border-color:${s.color}66` : ''}">${c}</button>`;
  }).join('');

  _dietRenderTagField('dietHealthyChips', 'healthy',
    getHealthyIngredients(), _dietMealHealthy,
    'No healthy ingredients yet — import a meal or add some below.');
  _dietRenderTagField('dietUnhealthyChips', 'unhealthy',
    getUnhealthyFoods(), _dietMealUnhealthy,
    'No unhealthy foods yet — add some below.');
}

// Chips = the master list plus anything selected-but-not-yet-saved, selected
// ones highlighted. Clicking toggles selection for this meal.
function _dietRenderTagField(elId, kind, master, selected, emptyHint) {
  const names = [...master];
  selected.forEach(n => { if (!_dietHas(names, n)) names.push(n); });
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = names.length
    ? names.map(n => {
        const on = selected.some(s => s.toLowerCase() === n.toLowerCase());
        return `<button class="diet-chip diet-chip-${kind}${on ? ' active' : ''}"
          data-${kind}tag="${_esc(n)}">${_esc(n)}</button>`;
      }).join('')
    : `<span class="diet-hint">${emptyHint}</span>`;
}

function addDietEntry() {
  const dateEl = document.getElementById('dietDate');
  const timeEl = document.getElementById('dietTime');
  const descEl = document.getElementById('dietDesc');
  const calEl  = document.getElementById('dietCalories');
  const status = document.getElementById('dietFormStatus');

  const desc = descEl.value.trim();
  if (!desc) { showStatus(status, 'Add a description first.', 'var(--warning)'); return; }
  if (!dateEl.value) { showStatus(status, 'Pick a date first.', 'var(--warning)'); return; }

  // Any tag still selected that isn't on its master list gets added to it now,
  // so it becomes a reusable chip next time.
  const healthy = getHealthyIngredients();
  const unhealthy = getUnhealthyFoods();
  let listsChanged = false;
  _dietMealHealthy.forEach(n => { if (!_dietHas(healthy, n)) { healthy.push(n); listsChanged = true; } });
  _dietMealUnhealthy.forEach(n => { if (!_dietHas(unhealthy, n)) { unhealthy.push(n); listsChanged = true; } });
  if (listsChanged) { saveHealthyIngredients(healthy); saveUnhealthyFoods(unhealthy); }

  const num = el => { const v = el.value.trim(); return v === '' ? null : Number(v); };
  const entries = getDietEntries();
  entries.push({
    id: _dietId(),
    date: dateEl.value,
    time: timeEl.value || '',
    desc,
    calories: num(calEl),
    protein: num(document.getElementById('dietProtein')),
    carbs:   num(document.getElementById('dietCarbs')),
    fats:    num(document.getElementById('dietFats')),
    category: _dietCategory,
    healthyIngredients: [..._dietMealHealthy],
    unhealthyFoods: [..._dietMealUnhealthy],
  });
  saveDietEntries(entries);

  descEl.value = '';
  timeEl.value = '';
  calEl.value  = '';
  ['dietProtein', 'dietCarbs', 'dietFats'].forEach(id => { document.getElementById(id).value = ''; });
  _dietMealHealthy = [];
  _dietMealUnhealthy = [];
  renderDiet();
  closeDietModal();
}


// ── History ──
function renderDietHistory() {
  const filterEl = document.getElementById('dietHistoryFilter');
  if (!filterEl) return;

  // "Outside" uses the same rollup as the stats layer, so it includes Fast Food.
  filterEl.innerHTML = '<span class="diet-seg-label">Show</span>' + _dietSegHTML([
    ['all', 'All'],
    ['Homecooked Meal', 'Homecooked'],
    ['Outside Food', 'Outside (incl. fast)'],
    ['Fast Food', 'Fast Food'],
  ], _dietHistoryCat, 'data-histcat');

  let list = _dietSortedEntries();
  if (_dietHistoryCat === 'Outside Food') {
    list = list.filter(e => e.category === 'Outside Food' || e.category === 'Fast Food');
  } else if (_dietHistoryCat !== 'all') {
    list = list.filter(e => e.category === _dietHistoryCat);
  }

  const wrap = document.getElementById('dietHistoryList');
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-state">No meals logged for this filter yet.</div>';
    return;
  }

  const visible = _dietHistoryAll ? list : list.slice(0, DIET_HISTORY_LIMIT);

  wrap.innerHTML = visible.map(e => {
    const s = DIET_CATEGORY_STYLE[e.category] || DIET_CATEGORY_STYLE['Outside Food'];
    const when = _dietFmtDate(e.date) + (e.time ? ' · ' + _dietFmtTime(e.time) : '');
    const macros = [
      e.protein != null ? `P&nbsp;${e.protein}g` : null,
      e.carbs   != null ? `C&nbsp;${e.carbs}g`   : null,
      e.fats    != null ? `F&nbsp;${e.fats}g`    : null,
    ].filter(Boolean).join(' · ');
    const tags = [
      ..._entHealthy(e).map(n => `<span class="diet-tag diet-tag-healthy">${_esc(n)}</span>`),
      ..._entUnhealthy(e).map(n => `<span class="diet-tag diet-tag-unhealthy">${_esc(n)}</span>`),
    ].join('');
    return `<div class="diet-entry" data-entry-id="${e.id}">
      <div class="diet-entry-main">
        <div class="diet-entry-head">
          <span class="diet-entry-desc">${_esc(e.desc)}</span>
          <span class="diet-pill" style="background:${s.bg};color:${s.color}">${_esc(e.category)}</span>
        </div>
        <div class="diet-entry-meta">
          <span>${when}</span>
          ${e.calories != null ? `<span class="diet-entry-cal">${e.calories} kcal</span>` : ''}
          ${macros ? `<span class="diet-entry-macros">${macros}</span>` : ''}
        </div>
        ${tags ? `<div class="diet-entry-tags">${tags}</div>` : ''}
      </div>
      <button class="diet-entry-del" data-del-entry="${e.id}" title="Delete entry">×</button>
    </div>`;
  }).join('');

  if (list.length > DIET_HISTORY_LIMIT) {
    wrap.innerHTML += `<div class="diet-history-more" id="dietHistoryMore">${
      _dietHistoryAll ? 'Show less ▴' : `Show ${list.length - DIET_HISTORY_LIMIT} more ▾`}</div>`;
  }
}


// ── Healthy Ingredients vs Unhealthy Foods (feedback + CRUD) ──
function renderDietFoodPanel() {
  const rangeEl = document.getElementById('dietFoodRange');
  if (!rangeEl) return;
  rangeEl.innerHTML = '<span class="diet-seg-label">Range</span>' +
    _dietSegHTML(DIET_RANGES, _dietFoodRange, 'data-foodrange');

  const healthyList   = getHealthyIngredients();
  const unhealthyList  = getUnhealthyFoods();
  const entries = _dietEntriesInRange(_dietFoodRange);
  const allEntries = getDietEntries();

  // In-range tag counts
  let healthyHits = 0, unhealthyHits = 0;
  const count = new Map();
  entries.forEach(e => {
    _entHealthy(e).forEach(n => { healthyHits++; count.set(n, (count.get(n) || 0) + 1); });
    _entUnhealthy(e).forEach(n => { unhealthyHits++; count.set(n, (count.get(n) || 0) + 1); });
  });
  const total = healthyHits + unhealthyHits;
  const hPct  = total ? Math.round(healthyHits / total * 100) : 0;

  document.getElementById('dietFoodFeedback').innerHTML = `
    <div class="diet-hu-summary">
      <div class="diet-hu-figure">
        <span class="diet-hu-count healthy">${healthyHits}</span>
        <span class="diet-hu-label">healthy ingredients</span>
      </div>
      <div class="diet-hu-figure">
        <span class="diet-hu-count unhealthy">${unhealthyHits}</span>
        <span class="diet-hu-label">unhealthy foods</span>
      </div>
      <div class="diet-hu-figure">
        <span class="diet-hu-count">${total ? hPct + '%' : '—'}</span>
        <span class="diet-hu-label">healthy share</span>
      </div>
    </div>
    ${total ? `<div class="diet-hu-bar">
      <div class="diet-hu-bar-fill healthy" style="width:${hPct}%"></div>
      <div class="diet-hu-bar-fill unhealthy" style="width:${100 - hPct}%"></div>
    </div>` : '<div class="empty-state">No tagged foods in this range yet.</div>'}`;

  _dietRenderFoodList('dietHealthyManage', 'healthy', healthyList, count, allEntries, _entHealthy);
  _dietRenderFoodList('dietUnhealthyManage', 'unhealthy', unhealthyList, count, allEntries, _entUnhealthy);
}

function _dietRenderFoodList(elId, kind, names, rangeCount, allEntries, pick) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!names.length) {
    el.innerHTML = `<div class="empty-state">Nothing here yet — add ${kind === 'healthy' ? 'an ingredient' : 'a food'} below.</div>`;
    return;
  }
  el.innerHTML = names.map(name => {
    const lastDate = allEntries.filter(e => pick(e).includes(name)).map(e => e.date).sort().pop();
    return `<div class="diet-stat-row">
      <span class="diet-stat-name">
        <span class="diet-kind-dot diet-kind-${kind}"></span>${_esc(name)}
      </span>
      <span class="diet-stat-nums">
        <span class="diet-stat-num"><b>${rangeCount.get(name) || 0}</b> <i>in range</i></span>
        <span class="diet-stat-last">${lastDate ? _dietAgoLabel(lastDate) : 'never'}</span>
      </span>
      <button class="diet-entry-del" data-del-${kind}="${_esc(name)}" title="Remove">×</button>
    </div>`;
  }).join('');
}


// ── Category breakdown ──
// Fast Food rolls into Outside Food here; it's also shown on its own.
function _dietCategoryCounts(entries) {
  const home        = entries.filter(e => e.category === 'Homecooked Meal').length;
  const outsideOnly = entries.filter(e => e.category === 'Outside Food').length;
  const fast        = entries.filter(e => e.category === 'Fast Food').length;
  return { home, outsideOnly, fast, outside: outsideOnly + fast, total: entries.length };
}

function renderDietCategoryPanel() {
  const rangeEl = document.getElementById('dietCatRange');
  if (!rangeEl) return;
  rangeEl.innerHTML = '<span class="diet-seg-label">Range</span>' +
    _dietSegHTML(DIET_RANGES, _dietCatRange, 'data-catrange');

  const c = _dietCategoryCounts(_dietEntriesInRange(_dietCatRange));
  const wrap = document.getElementById('dietCatBreakdown');

  if (!c.total) {
    wrap.innerHTML = '<div class="empty-state">No meals logged in this range yet.</div>';
    return;
  }

  const bar = (label, count, color, note) => {
    const pct = Math.round(count / c.total * 100);
    return `<div class="diet-bar-row">
      <div class="diet-bar-head">
        <span class="diet-bar-label">${label}${note ? `<i>${note}</i>` : ''}</span>
        <span class="diet-bar-val">${count} <i>· ${pct}%</i></span>
      </div>
      <div class="diet-bar"><div class="diet-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    </div>`;
  };

  wrap.innerHTML =
    bar('Homecooked', c.home, DIET_CATEGORY_STYLE['Homecooked Meal'].color) +
    bar('Outside Food', c.outside, DIET_CATEGORY_STYLE['Outside Food'].color, 'incl. fast food') +
    bar('Fast Food', c.fast, DIET_CATEGORY_STYLE['Fast Food'].color, 'on its own') +
    `<div class="diet-hint diet-breakdown-note">
      ${c.total} meal${c.total === 1 ? '' : 's'} logged · Outside Food counts the
      ${c.outsideOnly} non-fast outside meal${c.outsideOnly === 1 ? '' : 's'} plus all ${c.fast} fast-food one${c.fast === 1 ? '' : 's'}.
    </div>`;
}


function renderDiet() {
  _dietMigrateFoodLists();
  renderDietForm();
  renderDietHistory();
  renderDietFoodPanel();
  renderDietCategoryPanel();
  renderSupplements();
}

function _dietNowTime() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function _suppSorted() {
  return [...getSupplements()].sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') ||
    (b.time || '').localeCompare(a.time || '') ||
    (b.id || '').localeCompare(a.id || ''));
}

// One entry per supplement name, from its most recent log — so re-logging a
// name with new contents (or a new usual dose) updates the shelf and picker.
function _suppCatalog() {
  const seen = new Set();
  const out = [];
  _suppSorted().forEach(s => {
    const k = (s.name || '').toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ name: s.name, contents: Array.isArray(s.contents) ? s.contents : [], qty: s.qty || 1, date: s.date });
  });
  return out;
}
function _suppFind(name) {
  const k = String(name || '').trim().toLowerCase();
  return k ? _suppCatalog().find(c => c.name.toLowerCase() === k) : null;
}

// ── On/off cycles ──
// Day numbers in UTC so the math never trips over DST.
function _suppDayNum(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}
function _suppAddDays(ds, n) {
  return new Date((_suppDayNum(ds) + n) * 86400000).toISOString().slice(0, 10);
}

function _suppCycleFor(name) {
  return getSuppCycles()[String(name || '').trim().toLowerCase()] || null;
}

function _suppWriteCycle(name, cycle) {
  const k = String(name || '').trim().toLowerCase();
  if (!k) return;
  const map = { ...getSuppCycles() };
  if (cycle) map[k] = cycle; else delete map[k];
  saveSuppCycles(map);
}

// Where `ds` falls in the cycle. on: { on, day, of, until = first off-day };
// off: { on: false, until = next on-day }. Before the start date counts as off.
function _suppCycleState(cycle, ds) {
  const len = cycle.on + cycle.off;
  const diff = _suppDayNum(ds) - _suppDayNum(cycle.start);
  if (diff < 0) return { on: false, until: cycle.start };
  const pos = diff % len;
  if (pos < cycle.on) return { on: true, day: pos + 1, of: cycle.on, until: _suppAddDays(ds, cycle.on - pos) };
  return { on: false, until: _suppAddDays(ds, len - pos) };
}

function _suppCycleLen(days) { return days % 7 === 0 ? `${days / 7} wk` : `${days} d`; }
function _suppCycleLabel(cycle) { return `${_suppCycleLen(cycle.on)} on · ${_suppCycleLen(cycle.off)} off`; }
function _suppCycleText(st) {
  return st.on ? `On · day ${st.day} of ${st.of}` : `Off · back ${_dietFmtDate(st.until)}`;
}

function _suppLoadCycle(cycle) {
  _suppCycleOn = !!cycle;
  const put = (days, nId, uId) => {
    const weeks = days % 7 === 0;
    document.getElementById(nId).value = weeks ? days / 7 : days;
    document.getElementById(uId).value = weeks ? '7' : '1';
  };
  put(cycle ? cycle.on : 14, 'suppCycOn', 'suppCycOnUnit');
  put(cycle ? cycle.off : 14, 'suppCycOff', 'suppCycOffUnit');
  document.getElementById('suppCycStart').value = cycle ? cycle.start : _dietToday();
}

function _suppReadCycle() {
  if (!_suppCycleOn) return null;
  const days = (nId, uId) => Math.round(Number(document.getElementById(nId).value) * Number(document.getElementById(uId).value));
  const on = days('suppCycOn', 'suppCycOnUnit');
  const off = days('suppCycOff', 'suppCycOffUnit');
  const start = document.getElementById('suppCycStart').value;
  return on >= 1 && off >= 1 && start ? { on, off, start } : null;
}

function renderSuppCycle() {
  document.getElementById('suppCycleBar').innerHTML =
    _dietSegHTML([['daily', 'Every day'], ['cycle', 'Cycle on / off']], _suppCycleOn ? 'cycle' : 'daily', 'data-supp-cycle');
  document.getElementById('suppCycleBody').hidden = !_suppCycleOn;
  const cyc = _suppReadCycle();
  const status = document.getElementById('suppCycStatus');
  if (!_suppCycleOn) { status.textContent = ''; return; }
  if (!cyc) { status.textContent = 'Enter how long each phase lasts.'; return; }
  const today = _dietToday();
  const st = _suppCycleState(cyc, today);
  status.textContent = _suppCycleLabel(cyc) + ' — ' + (
    cyc.start > today ? `starts ${_dietFmtDate(cyc.start)}`
    : st.on ? `today is day ${st.day} of ${st.of}, off from ${_dietFmtDate(st.until)}`
    : `off today, back on ${_dietFmtDate(st.until)}`);
}

function _suppDayLabel(ds) {
  const n = daysBetween(ds, _dietToday());
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Sum of every ingredient across the day's doses, merged by name + unit.
function _suppDayTotal(items) {
  const m = new Map();
  items.forEach(s => (s.contents || []).forEach(c => {
    if (!c || !c.name || c.amount == null) return;
    const k = c.name.toLowerCase() + '|' + (c.unit || '');
    const cur = m.get(k) || { name: c.name, unit: c.unit, amount: 0 };
    cur.amount += c.amount * (s.qty || 1);
    m.set(k, cur);
  }));
  return _suppContentsText([...m.values()], 1);
}

function _suppFmtNum(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// "Vitamin D3 25 mcg · Zinc 11 mg", each amount scaled by `qty`.
function _suppContentsText(contents, qty) {
  return (contents || [])
    .filter(c => c && c.name)
    .map(c => c.amount != null ? `${c.name} ${_suppFmtNum(c.amount * qty)} ${c.unit || ''}`.trim() : c.name)
    .join(' · ');
}

function _suppUnitOptions(selected) {
  const units = SUPP_UNITS.includes(selected) || !selected ? SUPP_UNITS : [...SUPP_UNITS, selected];
  return units.map(u => `<option value="${_esc(u)}"${u === selected ? ' selected' : ''}>${_esc(u)}</option>`).join('');
}

function _suppNormUnit(u) {
  const s = String(u || '').trim();
  if (/^(?:µg|ug|mcg)/i.test(s)) return 'mcg';
  if (/^iu$/i.test(s)) return 'IU';
  if (/^ml$/i.test(s)) return 'mL';
  if (/cfu/i.test(s)) return 'CFU';
  return s.toLowerCase();
}

function renderSuppRows() {
  const wrap = document.getElementById('suppRows');
  wrap.innerHTML = _suppRows.length ? _suppRows.map((r, i) => `<div class="supp-row">
      <input type="text" class="task-input" data-supp-row="${i}" data-supp-field="name" value="${_esc(r.name)}" placeholder="Ingredient">
      <input type="number" class="habit-date-input supp-amt" data-supp-row="${i}" data-supp-field="amount" value="${r.amount ?? ''}" min="0" step="any" placeholder="Amount">
      <select class="habit-date-input supp-unit" data-supp-row="${i}" data-supp-field="unit">${_suppUnitOptions(r.unit || 'mg')}</select>
      <button type="button" class="diet-entry-del" data-supp-del-row="${i}" title="Remove">×</button>
    </div>`).join('')
    : '<span class="diet-hint">Scan the label, or add ingredients by hand.</span>';
}

function _dietSetView(view) {
  _dietView = view === 'supplements' ? 'supplements' : 'meals';
  document.getElementById('dietViewMeals').hidden = _dietView !== 'meals';
  document.getElementById('dietViewSupps').hidden = _dietView !== 'supplements';
  document.querySelectorAll('[data-diet-view]').forEach(b => {
    const on = b.dataset.dietView === _dietView;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

// ── Supplement modal ──
function _suppQty() {
  const q = Number(document.getElementById('suppQty').value);
  return q > 0 ? q : 0;
}

// The typed name is a new supplement when nothing is picked and either "+ New"
// was chosen or nothing on the shelf matches what's typed.
function _suppIsNew() {
  const q = document.getElementById('suppName').value.trim().toLowerCase();
  if (_suppPick || !q) return false;
  return _suppCreating || !_suppCatalog().some(c => c.name.toLowerCase().includes(q));
}

// Per-pill contents of whatever the form currently describes.
function _suppDraftContents() {
  if (_suppPick) return (_suppFind(_suppPick) || {}).contents || [];
  if (_suppKind === 'label') {
    return _suppRows
      .map(r => ({ name: (r.name || '').trim(), amount: r.amount > 0 ? Number(r.amount) : null, unit: r.unit || 'mg' }))
      .filter(r => r.name);
  }
  const name = document.getElementById('suppName').value.trim();
  const amt = Number(document.getElementById('suppAmount').value);
  return name && amt > 0 ? [{ name, amount: amt, unit: document.getElementById('suppUnit').value }] : [];
}

function renderSuppSummary() {
  const qty = _suppQty();
  const txt = qty ? _suppContentsText(_suppDraftContents(), qty) : '';
  const cyc = _suppReadCycle();
  const doseDate = document.getElementById('suppDate').value;
  const st = cyc && doseDate ? _suppCycleState(cyc, doseDate) : null;
  const warn = st && !st.on ? `That day is in the off period. Next on-day: ${_dietFmtDate(st.until)}.` : '';
  const el = document.getElementById('suppSummary');
  el.hidden = !txt && !warn;
  el.classList.toggle('warn', !!warn);
  el.innerHTML = (txt ? `<span class="diet-field-label">This dose</span><span>${_esc(txt)}</span>` : '') +
    (warn ? `<span class="supp-warn">${_esc(warn)}</span>` : '');
  document.getElementById('suppAddBtn').textContent =
    qty ? `Log ${_suppFmtNum(qty)} pill${qty === 1 ? '' : 's'}` : 'Log';
}

function renderSuppForm() {
  const q = document.getElementById('suppName').value.trim();
  const ql = q.toLowerCase();
  const catalog = _suppCatalog();
  const matches = ql ? catalog.filter(c => c.name.toLowerCase().includes(ql)) : catalog;
  const exact = catalog.some(c => c.name.toLowerCase() === ql);
  const isNew = _suppIsNew();

  document.getElementById('suppPickChips').innerHTML = matches.map(c => {
    const on = c.name.toLowerCase() === _suppPick.toLowerCase();
    return `<button type="button" class="diet-chip${on ? ' active' : ''}" data-supp-pick="${_esc(c.name)}">${_esc(c.name)}</button>`;
  }).join('') + (q && (!exact || isNew)
    ? `<button type="button" class="diet-chip supp-chip-new${isNew ? ' active' : ''}" data-supp-create>${exact ? '✎ Updating' : '+ New'} “${_esc(q)}”</button>`
    : '');

  const picked = _suppPick && _suppFind(_suppPick);
  const info = document.getElementById('suppPickInfo');
  info.hidden = !picked;
  if (picked) {
    const per = _suppContentsText(picked.contents, 1);
    info.innerHTML = `<span>${per ? 'Per pill: ' + _esc(per) : 'No amounts saved for this one.'}</span>
      <button type="button" class="supp-link" id="suppEditContents">${per ? 'Edit contents' : 'Add amounts'}</button>`;
  }

  document.getElementById('suppNewField').hidden = !isNew;
  document.getElementById('suppCycleField').hidden = !picked && !isNew;
  renderSuppCycle();
  document.getElementById('suppKindBar').innerHTML =
    _dietSegHTML([['single', 'Single ingredient'], ['label', 'Multi-ingredient']], _suppKind, 'data-supp-kind');
  document.getElementById('suppSingleField').hidden = _suppKind !== 'single';
  document.getElementById('suppLabelField').hidden = _suppKind !== 'label';
  if (_suppKind === 'label') renderSuppRows();
  renderSuppSummary();
}

// Switch a picked supplement into the new-supplement editor, prefilled, so
// the next log saves its updated contents.
function _suppEditPicked() {
  const hit = _suppFind(_suppPick);
  if (!hit) return;
  _suppPick = '';
  _suppCreating = true;
  const c = hit.contents;
  if (c.length === 1 && c[0].name.toLowerCase() === hit.name.toLowerCase()) {
    _suppKind = 'single';
    document.getElementById('suppAmount').value = c[0].amount ?? '';
    document.getElementById('suppUnit').innerHTML = _suppUnitOptions(c[0].unit || 'mg');
  } else {
    _suppKind = c.length ? 'label' : 'single';
    _suppRows = c.map(x => ({ ...x }));
  }
  renderSuppForm();
}

function _suppPickName(name) {
  const hit = _suppFind(name);
  if (!hit) return;
  _suppPick = hit.name;
  _suppCreating = false;
  document.getElementById('suppName').value = hit.name;
  document.getElementById('suppQty').value = hit.qty;
  _suppLoadCycle(_suppCycleFor(hit.name));
  renderSuppForm();
}


// ── Supplements view: shelf + day-grouped log ──
function renderSupplements() {
  const shelf = document.getElementById('suppShelf');
  if (!shelf) return;
  const today = _dietToday();
  const all = _suppSorted();
  const catalog = _suppCatalog();
  const week = [...Array(7)].map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return _localDateStr(d);
  });

  shelf.innerHTML = [...catalog].sort((a, b) => a.name.localeCompare(b.name)).map(c => {
    const k = c.name.toLowerCase();
    const mine = all.filter(s => s.name.toLowerCase() === k);
    const days = new Set(mine.map(s => s.date));
    const todayDose = mine.find(s => s.date === today);
    const last = todayDose
      ? '✓ Today' + (todayDose.time ? ' · ' + _dietFmtTime(todayDose.time) : '')
      : 'Last ' + _dietAgoLabel(c.date);
    const per = _suppContentsText(c.contents, 1);
    const n7 = week.filter(d => days.has(d)).length;
    const cyc = _suppCycleFor(c.name);
    const st = cyc && _suppCycleState(cyc, today);
    const resting = st && !st.on;
    const dot = d => {
      const cls = [days.has(d) && 'on', cyc && !_suppCycleState(cyc, d).on && 'off'].filter(Boolean).join(' ');
      return `<i${cls ? ` class="${cls}"` : ''}></i>`;
    };
    return `<div class="supp-tile${todayDose ? ' taken' : ''}${resting ? ' resting' : ''}" data-supp-open="${_esc(c.name)}" role="button" tabindex="0" aria-label="Log ${_esc(c.name)}">
      <div class="supp-tile-head">
        <span class="supp-tile-name">${_esc(c.name)}</span>
        <span class="supp-tile-last">${_esc(last)}</span>
      </div>
      <div class="supp-tile-contents" title="${_esc(per)}">${per ? _esc(per) : 'No amounts saved'}</div>
      ${st ? `<div class="supp-cycle-badge ${st.on ? 'on' : 'off'}" title="${_esc(_suppCycleLabel(cyc))}">⟳ ${_esc(_suppCycleText(st))}</div>` : ''}
      <div class="supp-tile-foot">
        <span class="supp-dots" title="Taken ${n7} of the last 7 days${cyc ? ' · rings are off-days' : ''}">${week.map(dot).join('')}</span>
        <button type="button" class="supp-take" data-supp-take="${_esc(c.name)}">${resting ? 'Off' : '+ Take ' + _suppFmtNum(c.qty)}</button>
      </div>
    </div>`;
  }).join('') + `<button type="button" class="supp-tile supp-tile-new" id="suppLogOpen">
      <span class="supp-tile-plus">+</span>${catalog.length ? 'New supplement' : 'Log your first supplement'}
    </button>`;

  const wrap = document.getElementById('suppHistoryList');
  if (!all.length) {
    wrap.innerHTML = '<div class="empty-state">Nothing logged yet. Once you log a supplement, it lands on your shelf above for one-tap logging.</div>';
    return;
  }
  const groups = [];
  all.forEach(s => {
    let g = groups[groups.length - 1];
    if (!g || g.date !== s.date) groups.push(g = { date: s.date, items: [] });
    g.items.push(s);
  });
  wrap.innerHTML = groups.slice(0, _suppHistoryDays).map(g => {
    const total = g.items.length > 1 ? _suppDayTotal(g.items) : '';
    return `<div class="supp-day">
      <div class="supp-day-head">
        <span>${_suppDayLabel(g.date)}</span>
        <span class="supp-day-count">${g.items.length} dose${g.items.length === 1 ? '' : 's'}</span>
      </div>
      ${g.items.map(s => {
        const qty = s.qty || 1;
        const amt = _suppContentsText(s.contents, qty);
        return `<div class="supp-log-row">
          <span class="supp-log-time">${s.time ? _dietFmtTime(s.time) : '—'}</span>
          <span class="supp-log-name">${_esc(s.name)}<b>× ${_suppFmtNum(qty)}</b></span>
          <span class="supp-log-amt" title="${_esc(amt)}">${_esc(amt)}</span>
          <button type="button" class="diet-entry-del" data-del-supp="${s.id}" title="Delete" aria-label="Delete ${_esc(s.name)}">×</button>
        </div>`;
      }).join('')}
      ${total ? `<div class="supp-day-total"><span>Day total</span>${_esc(total)}</div>` : ''}
    </div>`;
  }).join('') + (groups.length > _suppHistoryDays
    ? '<div class="diet-history-more" id="suppHistoryMore">Show earlier days ▾</div>' : '');
}

function _suppSave(entry, title) {
  saveSupplements([...getSupplements(), entry]);
  renderSupplements();
  _finToast(_esc(title), _esc(_suppContentsText(entry.contents, entry.qty)), () => {
    saveSupplements(getSupplements().filter(x => x.id !== entry.id));
    renderSupplements();
  });
}

function suppQuickTake(name) {
  const hit = _suppFind(name);
  if (!hit) return;
  const cyc = _suppCycleFor(hit.name);
  const st = cyc && _suppCycleState(cyc, _dietToday());
  if (st && !st.on && !confirm(`${hit.name} is in its off period (back on ${_dietFmtDate(st.until)}). Log it anyway?`)) return;
  _suppSave({ id: _dietId(), name: hit.name, date: _dietToday(), time: _dietNowTime(), qty: hit.qty, contents: hit.contents },
    `Took ${_suppFmtNum(hit.qty)} × ${hit.name}`);
}

function openSuppModal(name) {
  const dateEl = document.getElementById('suppDate');
  dateEl.value = _dietToday();
  dateEl.max = _dietToday();
  document.getElementById('suppTime').value = _dietNowTime();
  document.getElementById('suppName').value = '';
  document.getElementById('suppAmount').value = '';
  document.getElementById('suppUnit').innerHTML = _suppUnitOptions('mg');
  document.getElementById('suppQty').value = '1';
  document.getElementById('suppFormStatus').textContent = '';
  document.getElementById('suppScanStatus').textContent = '';
  _suppPick = '';
  _suppCreating = false;
  _suppKind = 'single';
  _suppRows = [];
  _suppLoadCycle(null);
  if (name) _suppPickName(name); else renderSuppForm();
  const modal = document.getElementById('suppModal');
  modal.classList.add('open');
  modal.querySelector('.sr-modal-card').scrollTop = 0;
  _mobLockBody();
  if (!_suppPick) setTimeout(() => document.getElementById('suppName').focus(), 0);
}

function closeSuppModal() {
  const modal = document.getElementById('suppModal');
  if (!modal.classList.contains('open')) return;
  modal.classList.remove('open');
  _mobUnlockBodyIfClear();
}

function addSupplement() {
  const dateEl = document.getElementById('suppDate');
  const status = document.getElementById('suppFormStatus');
  const typed = document.getElementById('suppName').value.trim();
  if (!_suppPick && !_suppIsNew()) {
    showStatus(status, typed ? 'Pick one from the list, or tap “+ New”.' : 'Pick or type a supplement.', 'var(--warning)');
    return;
  }
  if (!dateEl.value) { showStatus(status, 'Pick a date first.', 'var(--warning)'); return; }
  const qty = _suppQty();
  if (!qty) { showStatus(status, 'Enter how many pills.', 'var(--warning)'); return; }

  if (_suppCycleOn && !_suppReadCycle()) { showStatus(status, 'Finish the cycle lengths, or switch to Every day.', 'var(--warning)'); return; }

  const known = _suppFind(_suppPick || typed);
  const name = known ? known.name : typed;
  const entry = { id: _dietId(), name, date: dateEl.value, time: document.getElementById('suppTime').value || '', qty, contents: _suppDraftContents() };
  _suppWriteCycle(name, _suppReadCycle());
  closeSuppModal();
  _suppSave(entry, `Logged ${_suppFmtNum(qty)} × ${name}`);
}


// ── Listeners (delegated on the tab panel where possible) ──
const _dietPanel = document.getElementById('tab-diet');

function _dietToggleMealTag(list, name) {
  const i = list.findIndex(n => n.toLowerCase() === name.toLowerCase());
  if (i === -1) list.push(name); else list.splice(i, 1);
}

function openDietModal() {
  renderDietForm();
  const modal = document.getElementById('dietModal');
  modal.classList.add('open');
  modal.querySelector('.sr-modal-card').scrollTop = 0;
  _mobLockBody();
  document.getElementById('dietFormStatus').textContent = '';
  setTimeout(() => document.getElementById('dietDesc').focus(), 0);
}

function closeDietModal() {
  const modal = document.getElementById('dietModal');
  if (!modal.classList.contains('open')) return;
  modal.classList.remove('open');
  _mobUnlockBodyIfClear();
}

function _dietOnClick(e) {
  const view = e.target.closest('[data-diet-view]');
  if (view) { _dietSetView(view.dataset.dietView); return; }

  if (e.target.id === 'dietLogOpen') { openDietModal(); return; }
  if (e.target.id === 'dietModalClose' || e.target.id === 'dietModal') { closeDietModal(); return; }
  const take = e.target.closest('[data-supp-take]');
  if (take) { suppQuickTake(take.dataset.suppTake); return; }
  if (e.target.closest('#suppLogOpen')) { openSuppModal(); return; }
  const tile = e.target.closest('[data-supp-open]');
  if (tile) { openSuppModal(tile.dataset.suppOpen); return; }
  if (e.target.id === 'suppModalClose' || e.target.id === 'suppModal') { closeSuppModal(); return; }
  if (e.target.id === 'suppAddBtn') { addSupplement(); return; }
  if (e.target.id === 'suppEditContents') { _suppEditPicked(); return; }
  if (e.target.id === 'suppNowBtn') {
    document.getElementById('suppDate').value = _dietToday();
    document.getElementById('suppTime').value = _dietNowTime();
    return;
  }
  const step = e.target.closest('[data-supp-step]');
  if (step) {
    const q = _suppQty() || 1;
    document.getElementById('suppQty').value = Math.max(0.5, q + Number(step.dataset.suppStep));
    renderSuppSummary();
    return;
  }

  const cycleSeg = e.target.closest('[data-supp-cycle]');
  if (cycleSeg) {
    _suppCycleOn = cycleSeg.dataset.suppCycle === 'cycle';
    renderSuppCycle();
    renderSuppSummary();
    _suppSavePickedCycle();
    return;
  }
  const pick = e.target.closest('[data-supp-pick]');
  if (pick) { _suppPickName(pick.dataset.suppPick); return; }
  if (e.target.closest('[data-supp-create]')) {
    _suppCreating = true;
    _suppPick = '';
    renderSuppForm();
    document.getElementById(_suppKind === 'single' ? 'suppAmount' : 'suppName').focus();
    return;
  }
  const kind = e.target.closest('[data-supp-kind]');
  if (kind) { _suppKind = kind.dataset.suppKind === 'label' ? 'label' : 'single'; renderSuppForm(); return; }
  if (e.target.id === 'suppAddRow') {
    _suppRows.push({ name: '', amount: null, unit: 'mg' });
    renderSuppRows();
    document.querySelector(`[data-supp-row="${_suppRows.length - 1}"][data-supp-field="name"]`).focus();
    return;
  }
  const delRow = e.target.closest('[data-supp-del-row]');
  if (delRow) { _suppRows.splice(Number(delRow.dataset.suppDelRow), 1); renderSuppRows(); renderSuppSummary(); return; }
  if (e.target.id === 'suppScanBtn') { document.getElementById('suppScanFile').click(); return; }

  const cat = e.target.closest('[data-cat]');
  if (cat) { _dietCategory = cat.dataset.cat; renderDietForm(); return; }

  const hTag = e.target.closest('[data-healthytag]');
  if (hTag) { _dietToggleMealTag(_dietMealHealthy, hTag.dataset.healthytag); renderDietForm(); return; }

  const uTag = e.target.closest('[data-unhealthytag]');
  if (uTag) { _dietToggleMealTag(_dietMealUnhealthy, uTag.dataset.unhealthytag); renderDietForm(); return; }

  const histCat = e.target.closest('[data-histcat]');
  if (histCat) { _dietHistoryCat = histCat.dataset.histcat; _dietHistoryAll = false; renderDietHistory(); return; }

  if (e.target.id === 'dietHistoryMore') { _dietHistoryAll = !_dietHistoryAll; renderDietHistory(); return; }
  if (e.target.id === 'suppHistoryMore') { _suppHistoryDays += 14; renderSupplements(); return; }

  const foodRange = e.target.closest('[data-foodrange]');
  if (foodRange) { _dietFoodRange = foodRange.dataset.foodrange; renderDietFoodPanel(); return; }

  const catRange = e.target.closest('[data-catrange]');
  if (catRange) { _dietCatRange = catRange.dataset.catrange; renderDietCategoryPanel(); return; }

  const delSupp = e.target.closest('[data-del-supp]');
  if (delSupp) {
    const row = getSupplements().find(x => x.id === delSupp.dataset.delSupp);
    if (!row) return;
    saveSupplements(getSupplements().filter(x => x.id !== row.id));
    renderSupplements();
    _finToast(`Deleted ${_esc(row.name)}`, _esc(_suppDayLabel(row.date) + (row.time ? ' · ' + _dietFmtTime(row.time) : '')), () => {
      saveSupplements([...getSupplements(), row]);
      renderSupplements();
    });
    return;
  }

  const delEntry = e.target.closest('[data-del-entry]');
  if (delEntry) {
    const id = delEntry.dataset.delEntry;
    const entry = getDietEntries().find(x => x.id === id);
    if (!entry || !confirm(`Delete "${entry.desc}"?`)) return;
    saveDietEntries(getDietEntries().filter(x => x.id !== id));
    renderDiet();
    return;
  }

  const delH = e.target.closest('[data-del-healthy]');
  if (delH) {
    const name = delH.dataset.delHealthy;
    if (!confirm(`Remove "${name}" from Healthy Ingredients? Past meal tags are kept.`)) return;
    saveHealthyIngredients(getHealthyIngredients().filter(n => n !== name));
    _dietMealHealthy = _dietMealHealthy.filter(n => n !== name);
    renderDiet();
    return;
  }

  const delU = e.target.closest('[data-del-unhealthy]');
  if (delU) {
    const name = delU.dataset.delUnhealthy;
    if (!confirm(`Remove "${name}" from Unhealthy Foods? Past meal tags are kept.`)) return;
    saveUnhealthyFoods(getUnhealthyFoods().filter(n => n !== name));
    _dietMealUnhealthy = _dietMealUnhealthy.filter(n => n !== name);
    renderDiet();
    return;
  }

  if (e.target.id === 'dietAddBtn')          { addDietEntry(); return; }
  if (e.target.id === 'dietHealthyAdd')      { _dietAddFood('healthy', 'dietHealthyInput', true); return; }
  if (e.target.id === 'dietUnhealthyAdd')    { _dietAddFood('unhealthy', 'dietUnhealthyInput', true); return; }
  if (e.target.id === 'dietHealthyListAdd')  { _dietAddFood('healthy', 'dietHealthyListInput', false); return; }
  if (e.target.id === 'dietUnhealthyListAdd'){ _dietAddFood('unhealthy', 'dietUnhealthyListInput', false); return; }
  if (e.target.id === 'dietImportBtn')       { document.getElementById('dietImportFile').click(); return; }
}
_dietPanel.addEventListener('click', _dietOnClick);
document.getElementById('dietModal').addEventListener('click', _dietOnClick);
document.getElementById('suppModal').addEventListener('click', _dietOnClick);

// Add a name to a master list. `selectForMeal` also tags it on the meal being
// entered (used by the form inputs, not the manage-list inputs).
function _dietAddFood(kind, inputId, selectForMeal) {
  const inp = document.getElementById(inputId);
  const name = inp.value.trim();
  if (!name) return;
  const master = kind === 'healthy' ? getHealthyIngredients() : getUnhealthyFoods();
  if (!_dietHas(master, name)) {
    master.push(name);
    (kind === 'healthy' ? saveHealthyIngredients : saveUnhealthyFoods)(master);
  }
  if (selectForMeal) {
    const meal = kind === 'healthy' ? _dietMealHealthy : _dietMealUnhealthy;
    if (!_dietHas(meal, name)) meal.push(name);
  }
  inp.value = '';
  renderDiet();
}

function _dietOnKey(e) {
  if (e.key === 'Escape') { closeDietModal(); closeSuppModal(); return; }
  if (e.key !== 'Enter') return;
  if (e.target.dataset && e.target.dataset.suppOpen) { openSuppModal(e.target.dataset.suppOpen); return; }
  if (e.target.id === 'suppName') {
    const q = e.target.value.trim().toLowerCase();
    const matches = q ? _suppCatalog().filter(c => c.name.toLowerCase().includes(q)) : [];
    if (!_suppPick && matches.length === 1) _suppPickName(matches[0].name);
    else addSupplement();
    return;
  }
  if (['suppAmount', 'suppQty'].includes(e.target.id)) { addSupplement(); return; }
  if (e.target.id === 'dietDesc' || e.target.id === 'dietCalories') { addDietEntry(); }
  else if (e.target.id === 'dietHealthyInput')       { _dietAddFood('healthy', 'dietHealthyInput', true); }
  else if (e.target.id === 'dietUnhealthyInput')     { _dietAddFood('unhealthy', 'dietUnhealthyInput', true); }
  else if (e.target.id === 'dietHealthyListInput')   { _dietAddFood('healthy', 'dietHealthyListInput', false); }
  else if (e.target.id === 'dietUnhealthyListInput') { _dietAddFood('unhealthy', 'dietUnhealthyListInput', false); }
}
_dietPanel.addEventListener('keydown', _dietOnKey);
document.getElementById('dietModal').addEventListener('keydown', _dietOnKey);
document.getElementById('suppModal').addEventListener('keydown', _dietOnKey);

// A picked supplement already exists, so its schedule saves as soon as it's
// valid. A new one's is saved with its first log.
function _suppSavePickedCycle() {
  if (!_suppPick) return;
  const cyc = _suppReadCycle();
  if (_suppCycleOn && !cyc) return;
  _suppWriteCycle(_suppPick, cyc);
  renderSupplements();
  showStatus(document.getElementById('suppFormStatus'), 'Schedule saved.', 'var(--success)', 2000);
}

function _suppOnInput(e) {
  if (e.target.closest('#suppCycleField')) {
    renderSuppCycle();
    renderSuppSummary();
    if (e.type === 'change') _suppSavePickedCycle();
    return;
  }
  if (e.target.id === 'suppName') {
    const hit = _suppFind(e.target.value);
    _suppPick = hit && !_suppCreating ? hit.name : '';
    if (!e.target.value.trim()) _suppCreating = false;
    renderSuppForm();
    return;
  }
  const el = e.target.closest('[data-supp-row]');
  if (el) {
    const row = _suppRows[Number(el.dataset.suppRow)];
    if (row) {
      const f = el.dataset.suppField;
      row[f] = f === 'amount' ? (el.value === '' ? null : Number(el.value)) : el.value;
    }
  }
  renderSuppSummary();
}
document.getElementById('suppModal').addEventListener('input', _suppOnInput);
document.getElementById('suppModal').addEventListener('change', _suppOnInput);

// Re-render when the tab is opened (mirrors the Areas tab). Leaving the tab
// closes the meal modal so it doesn't sit over another section.
document.querySelectorAll('.tab-btn').forEach(btn => {
  if (btn.dataset.tab === 'diet') btn.addEventListener('click', renderDiet);
  else btn.addEventListener('click', () => { closeDietModal(); closeSuppModal(); });
});


// ═══════════════════════════════════════════════════════════════════════════
//  Screenshot import
// ═══════════════════════════════════════════════════════════════════════════
function _dietFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
}

// Decode the file, downscale to <=1600px on the long side, re-encode as JPEG.
// Keeps the upload under OCR.space's 1 MB free-tier limit, sharpens text a bit,
// and converts odd formats (e.g. HEIC on Safari). Returns a JPEG data URL, or
// null if the browser can't decode the file (caller then sends the raw bytes).
async function _dietNormalizeImage(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch (e) { return null; }
  const MAX = 1600;
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close && bitmap.close();
  let q = 0.85, dataUrl = canvas.toDataURL('image/jpeg', q);
  while (dataUrl.length > 1_000_000 && q > 0.4) {   // stay under the 1 MB limit
    q -= 0.15;
    dataUrl = canvas.toDataURL('image/jpeg', q);
  }
  return dataUrl;
}

// OCR a data-URL image via OCR.space. Returns { text, lines } — each line is
// { text, top, left } from the word overlay, so the parser can pair a label with
// its value across the different column layouts trackers use.
async function _dietOcr(dataUrl) {
  const body = new URLSearchParams({
    base64Image: dataUrl,
    language: 'eng',
    isOverlayRequired: 'true',
    OCREngine: '2',
    scale: 'true',
  });

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { apikey: OCR_SPACE_API_KEY || 'helloworld' },
      body,
    });
    if (res.ok) break;
    if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
      await new Promise(r => setTimeout(r, 900 * (attempt + 1)));
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error('OCR service error ' + res.status);

  const j = await res.json();
  if (j.IsErroredOnProcessing) {
    const m = Array.isArray(j.ErrorMessage) ? j.ErrorMessage.join(' ') : j.ErrorMessage;
    throw new Error(m || 'OCR could not read the image');
  }
  const r = (j.ParsedResults || [])[0] || {};
  const text = (r.ParsedText || '').trim();
  if (!text) throw new Error('no text found in the image');

  // x0/y0/x1/y1: the line's bounding box (finance.js draws receipt highlights from it).
  const lines = ((r.TextOverlay && r.TextOverlay.Lines) || []).map(ln => {
    const ws = ln.Words || [];
    const w = ws[0] || {};
    const box = ws.length ? {
      x0: Math.min(...ws.map(v => +v.Left || 0)),
      y0: Math.min(...ws.map(v => +v.Top || 0)),
      x1: Math.max(...ws.map(v => (+v.Left || 0) + (+v.Width || 0))),
      y1: Math.max(...ws.map(v => (+v.Top || 0) + (+v.Height || 0))),
    } : {};
    return { text: (ln.LineText || '').trim(), top: +w.Top || 0, left: +w.Left || 0, ...box };
  }).filter(l => l.text);

  return { text, lines };
}

const _DIET_NUM_LINE = /^[^\d]{0,3}(\d[\d,]*(?:\.\d+)?)\s*(?:g|mg|kg|kcal|cal|kj|%)?[^\da-z]{0,3}$/i;
const _DIET_JUNK_LINE = /^(?:\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?|[\d\s]*(?:5g|4g|3g|lte|wi-?fi)\+?[\d\s%]*|nutrition(?:\s*facts)?|ingredients|add\s*more|edit|done|fix\s*issue|share|back|close|overview|results?|analysis|summary|details|health\s*score|daily\s*values?|amount\s*per\s*serving|serving\s*size|[|<>/\\_-]+|\d{1,3}\s*%|\d{1,2}\s*\/\s*\d{1,2}|[\d.,:]+\s*(?:g|mg|kcal|cal|%)?)$/i;
const _DIET_MACRO_WORD = /^(?:total\s+)?(?:protein|carb|fat|fibre|fiber|sugar|sodium|cholesterol|saturated|calor)/i;

// Numeric value for a label line: same-row-to-the-right first (label | value
// layout), else the nearest line below in roughly the same column (label above
// value), else a number already inline on the label line.
function _dietValueForLabel(label, lines) {
  const nums = lines
    .filter(l => l !== label && _DIET_NUM_LINE.test(l.text))
    .map(l => {
      const m = l.text.match(/(\d[\d,]*(?:\.\d+)?)/);
      return { l, n: m ? Number(m[1].replace(/,/g, '')) : null };
    })
    .filter(x => x.n != null);

  const sameRow = nums
    .filter(x => Math.abs(x.l.top - label.top) <= 12 && x.l.left > label.left + 20)
    .sort((a, b) => a.l.left - b.l.left)[0];
  if (sameRow) return sameRow.n;

  const below = nums
    .filter(x => x.l.top - label.top > 0 && x.l.top - label.top <= 70 && Math.abs(x.l.left - label.left) <= 70)
    .sort((a, b) => (a.l.top - label.top) - (b.l.top - label.top))[0];
  if (below) return below.n;

  const inline = label.text.match(/[:\s](\d[\d,]*(?:\.\d+)?)\s*(?:g|mg|kcal|cal)?\b/i);
  return inline ? Number(inline[1].replace(/,/g, '')) : null;
}

function _dietFindLabelValue(lines, labelRe) {
  const cands = lines.filter(l => labelRe.test(l.text)).sort((a, b) => a.text.length - b.text.length);
  for (const c of cands) {
    const v = _dietValueForLabel(c, lines);
    if (v != null) return v;
  }
  return null;
}

// Format-specific parsers get first crack; each returns null when it doesn't
// recognise the screenshot, and we fall back to the generic reader.
function _dietParseNutrition(ocr) {
  return _dietParseCalAI(ocr) || _dietParseGeneric(ocr);
}

// The Cal AI "Nutrition" screen: nav bar → big title → Calories card → three
// Protein/Carbs/Fats cards → an "Ingredients" list → "How did Cal AI do?".
function _dietParseCalAI(ocr) {
  const lines = ocr.lines || [];
  const txt = ocr.text || '';
  if (!lines.length) return null;

  const isCalAI = /how\s*did\s*cal\s*a[il]/i.test(txt) ||
    (/(^|\n)\s*nutrition\s*(\n|$)/i.test(txt) && /(^|\n)\s*ingredients\s*(\n|$)/i.test(txt) && /add\s*more/i.test(txt));
  if (!isCalAI) return null;

  const find = re => lines.find(l => re.test(l.text));
  const nav = find(/^nutrition$/i);
  const calLabel = find(/^calories$/i) || find(/\bcalor/i);
  const navY = nav ? nav.top : 0;
  const calY = calLabel ? calLabel.top : Infinity;

  // Title: the wordy lines that sit between the nav bar and the Calories card
  // (this skips the status bar, the "10:44 AM" pill and the servings number).
  let description = lines
    .filter(l => l.top > navY + 8 && l.top < calY - 8)
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .map(l => l.text.replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 1 && /[a-z]{2,}/i.test(t) && !/^\d/.test(t) &&
      !_DIET_JUNK_LINE.test(t) && !/^(?:5g|4g|lte|wi-?fi|\d+%)\b/i.test(t))
    .slice(0, 4).join(' ').replace(/\s+/g, ' ').trim();
  if (description.length > 90) description = description.slice(0, 90).trim();

  const numBelow = (label, dy, dx) => {
    if (!label) return null;
    const c = lines
      .filter(l => l !== label && _DIET_NUM_LINE.test(l.text) &&
        l.top - label.top > 0 && l.top - label.top <= dy && Math.abs(l.left - label.left) <= dx)
      .sort((a, b) => (a.top - label.top) - (b.top - label.top))[0];
    const m = c && c.text.match(/(\d[\d,]*(?:\.\d+)?)/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  const calories = numBelow(calLabel, 48, 60);
  const protein  = numBelow(find(/^protein$/i), 40, 45);
  const carbs    = numBelow(find(/^carbs?$/i),  40, 45);
  const fats     = numBelow(find(/^fats?$/i),   40, 45);

  // Ingredients: "Name • NNN cal" on the left, amount ("2 egg", "25g") on the
  // right of the same row, between the "Ingredients" header and the feedback bar.
  const ingLabel = find(/^ingredients$/i);
  const endLine  = find(/how\s*did\s*cal|fix\s*issue|^done$/i);
  const ingredients = [];
  if (ingLabel) {
    const endY = endLine ? endLine.top : Infinity;
    const rows = lines.filter(l => l.top > ingLabel.top + 10 && l.top < endY);
    rows.forEach(l => {
      const m = l.text.match(/^(.+?)[\s•·・.|]+(\d[\d,]*)\s*(?:kcal|cal)\b/i);
      if (!m) return;
      const name = m[1].replace(/\s+/g, ' ').trim();
      if (!name || /add\s*more/i.test(name)) return;
      ingredients.push(name);
    });
  }

  if (!description && calories == null && !ingredients.length) return null;
  return { description, calories, protein, carbs, fats, category: null, ingredients };
}

// Generic positioned-line parser (fallback for unknown apps).
function _dietParseGeneric(ocr) {
  const lines = ocr.lines || [];
  const out = { description: '', calories: null, protein: null, carbs: null, fats: null, category: null, ingredients: [] };

  if (lines.length) {
    out.calories = _dietFindLabelValue(lines, /calor/i);
    out.protein  = _dietFindLabelValue(lines, /\bprotein\b/i);
    out.carbs    = _dietFindLabelValue(lines, /\bcarb/i);
    out.fats     = _dietFindLabelValue(lines, /(?:^|\s)(?:total\s+)?fats?\b/i);

    const calLine = lines.find(l => /calor/i.test(l.text));
    const head = calLine ? lines.filter(l => l.top < calLine.top - 4) : lines.slice(0, 6);
    const nameLines = [];
    for (const l of head) {
      const s = l.text.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
      if (s.length < 2) continue;
      if (_DIET_JUNK_LINE.test(s) || _DIET_MACRO_WORD.test(s) || _DIET_NUM_LINE.test(s)) continue;
      nameLines.push(s);
      if (nameLines.length === 2) break;
    }
    out.description = nameLines.join(' ').trim();
  }

  if (out.calories == null && out.protein == null && out.carbs == null && out.fats == null) {
    const t = (ocr.text || '').replace(/\s+/g, ' ');
    const g = re => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
    out.calories = g(/calor(?:ie|ies)\b[^\d]{0,10}([\d,]{2,5})/i);
    out.protein  = g(/protein\b[^\d]{0,10}(\d{1,4}(?:\.\d+)?)\s*g/i);
    out.carbs    = g(/carb\w*\b[^\d]{0,10}(\d{1,4}(?:\.\d+)?)\s*g/i);
    out.fats     = g(/fats?\b[^\d]{0,10}(\d{1,4}(?:\.\d+)?)\s*g/i);
  }

  return out;
}

function _dietApplyExtraction(x) {
  const set = (id, v) => { if (v != null && v !== '') document.getElementById(id).value = v; };
  set('dietDesc', x.description);
  set('dietCalories', x.calories);
  set('dietProtein', x.protein);
  set('dietCarbs', x.carbs);
  set('dietFats', x.fats);
  if (x.category && DIET_CATEGORIES.includes(x.category)) _dietCategory = x.category;
  // Parsed whole-food ingredients are healthy-ingredient candidates — pre-select
  // them for this meal; the user prunes any that don't belong, and the keepers
  // join the master list when the meal is logged.
  const ing = Array.isArray(x.ingredients) ? x.ingredients.slice(0, 40) : [];
  ing.forEach(n => { if (!_dietHas(_dietMealHealthy, n)) _dietMealHealthy.push(n); });
  renderDietForm();
}

async function dietImport(file) {
  const status = document.getElementById('dietImportStatus');
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/i.test(file.name)) {
    showStatus(status, 'Pick an image file.', 'var(--warning)');
    return;
  }
  if (file.size > 20 * 1024 * 1024) { showStatus(status, 'Image is over 20 MB — use a smaller screenshot.', 'var(--warning)', 5000); return; }

  const btn = document.getElementById('dietImportBtn');
  btn.disabled = true;
  btn.textContent = '⬆ Reading…';
  try {
    const dataUrl = (await _dietNormalizeImage(file)) || (await _dietFileToDataUrl(file));
    const parsed  = _dietParseNutrition(await _dietOcr(dataUrl));
    const gotSomething = parsed.description || parsed.calories != null ||
      parsed.protein != null || parsed.carbs != null || parsed.fats != null;
    if (!gotSomething) throw new Error("couldn't find nutrition info in that image");
    _dietApplyExtraction(parsed);
    const nIng = (parsed.ingredients || []).length;
    showStatus(status,
      (parsed.description ? 'Imported' : 'Read the numbers') +
        (nIng ? ` + ${nIng} ingredient${nIng === 1 ? '' : 's'}` : '') +
        (parsed.description ? ' — review, then Log meal.' : ' — add a description, then Log meal.'),
      'var(--success)', 5000);
  } catch (err) {
    console.error('[diet] screenshot import failed:', err);
    showStatus(status, 'Import failed: ' + (err.message || 'try again') + ' — or enter it manually.', 'var(--danger)', 9000);
  } finally {
    btn.disabled = false;
    btn.textContent = '⬆ Import from screenshot';
  }
}

document.getElementById('dietImportFile').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';        // allow re-picking the same file
  dietImport(file);
});


// ── Supplement Facts label → per-pill contents ──
const _SUPP_ROW_RE = /^(.*?[a-z].*?)\s+(\d[\d,]*(?:\.\d+)?)\s*(mcg(?:\s*(?:DFE|RAE))?|µg|ug|mg|g|IU|(?:billion\s*|million\s*)?CFU|mL)\b/i;
const _SUPP_SKIP_RE = /serving|servings|amount\s*per|daily\s*value|calories|other\s*ingredients|supplement\s*facts|^%/i;

// Rows of a Supplement Facts panel: "Vitamin D3 (as cholecalciferol) 25 mcg 125%".
// OCR often splits the name and amount columns into separate lines, so lines
// sharing a baseline are joined left-to-right before matching. Amounts are per
// serving; when the label's serving is N pills they're divided down to one pill.
function _suppParseLabel(ocr) {
  const lines = [...(ocr.lines || [])].sort((a, b) => a.top - b.top || a.left - b.left);
  const rows = [];
  lines.forEach(l => {
    const row = rows.find(r => Math.abs(r.top - l.top) <= 10);
    if (row) row.parts.push(l); else rows.push({ top: l.top, parts: [l] });
  });
  let texts = rows.map(r => r.parts.sort((a, b) => a.left - b.left).map(p => p.text).join(' '));
  if (!texts.length) texts = (ocr.text || '').split(/\n+/);

  const joined = texts.join('\n');
  const serving = joined.match(/serving\s*size[^\d\n]{0,12}(\d+(?:\.\d+)?)/i);
  const perServing = serving ? Number(serving[1]) : 1;
  const div = perServing > 0 ? perServing : 1;

  const out = [];
  texts.forEach(t => {
    const s = t.replace(/\s+/g, ' ').trim();
    if (!s || _SUPP_SKIP_RE.test(s)) return;
    const m = s.match(_SUPP_ROW_RE);
    if (!m) return;
    const name = m[1].replace(/\(.*$/, '').replace(/[†*‡.:•·]+$/g, '').replace(/[†*‡]/g, '').trim();
    if (name.length < 2) return;
    let amount = Number(m[2].replace(/,/g, ''));
    let unit = m[3];
    if (/billion/i.test(unit)) { amount *= 1e9; unit = 'CFU'; }
    else if (/million/i.test(unit)) { amount *= 1e6; unit = 'CFU'; }
    out.push({ name, amount: Math.round((amount / div) * 100) / 100, unit: _suppNormUnit(unit) });
  });
  return { rows: out, perServing: div };
}

async function suppScan(file) {
  const status = document.getElementById('suppScanStatus');
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/i.test(file.name)) {
    showStatus(status, 'Pick an image file.', 'var(--warning)');
    return;
  }
  if (file.size > 20 * 1024 * 1024) { showStatus(status, 'Image is over 20 MB — use a smaller photo.', 'var(--warning)', 5000); return; }

  const btn = document.getElementById('suppScanBtn');
  btn.disabled = true;
  btn.textContent = '📷 Reading…';
  try {
    const dataUrl = (await _dietNormalizeImage(file)) || (await _dietFileToDataUrl(file));
    const { rows, perServing } = _suppParseLabel(await _dietOcr(dataUrl));
    if (!rows.length) throw new Error("couldn't find ingredient amounts on that label");
    _suppRows = rows;
    renderSuppRows();
    renderSuppSummary();
    showStatus(status,
      `Found ${rows.length} ingredient${rows.length === 1 ? '' : 's'}` +
        (perServing > 1 ? ` (label serving is ${perServing} pills — amounts divided to 1 pill)` : '') +
        ' — review before logging.',
      'var(--success)', 7000);
  } catch (err) {
    console.error('[diet] supplement scan failed:', err);
    showStatus(status, 'Scan failed: ' + (err.message || 'try again') + ' — or add them by hand.', 'var(--danger)', 9000);
  } finally {
    btn.disabled = false;
    btn.textContent = '📷 Scan supplement facts';
  }
}

document.getElementById('suppScanFile').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  suppScan(file);
});
