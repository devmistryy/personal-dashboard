// Diet tab → Supplements view. Loaded after diet.js (uses its date, time and OCR
// helpers) and before main.js. Declares functions + registers listeners only.
//
//   Header     ring of today's due doses, what's next, spacing countdowns
//   Today      checklist by time of day; tap the circle to take a dose
//   14 days    grid; tap a square to backfill or remove a dose
//   Dose log   one line per dose
//   Rail       running low (stock) + today's intake, merged by nutrient
//   Page       slide-in editor per supplement (#suppDrawer)
//
// Storage: settings rows via _syncSetting; every map is keyed by lowercase name.
//   diet_supplements_v1    dose log [{ id, name, date, time, qty, contents }]
//   diet_supp_contents_v1  { key: [{ name, amount, unit }] } per pill; wins over the latest log's
//   diet_supp_cycles_v1    { key: { on, off, start } } on/off cycle, in days
//   diet_supp_notes_v1     { key: text }
//   diet_supp_meta_v1      { key: { name, slot, sched, qty, form, food, stock, bottle, after: { key, min }, group, archived } }
//                          group = name shared by supplements taken together (Today shows them linked; same time slot only)
// A supplement exists while it has a log entry or a meta row, and isn't archived.

// ponytail: each list/map is one settings row rewritten on every change. Own tables if the log grows enough for that to matter.
const SUPP_LOG = 'diet_supplements_v1', SUPP_CONTENTS = 'diet_supp_contents_v1',
  SUPP_CYCLES = 'diet_supp_cycles_v1', SUPP_NOTES = 'diet_supp_notes_v1', SUPP_META = 'diet_supp_meta_v1';
function getSupplements()      { return MEM[SUPP_LOG] || []; }
function saveSupplements(list) { MEM[SUPP_LOG] = list; _syncSetting(SUPP_LOG, list); }
function _suppMap(k)           { return MEM[k] || {}; }
function _suppSaveMap(k, map)  { MEM[k] = map; _syncSetting(k, map); }

const SUPP_SLOTS = [['morning', 'Morning'], ['midday', 'Midday'], ['night', 'Night'], ['any', 'Anytime']];
const SUPP_FORMS = ['pill', 'cap', 'tab', 'softgel', 'gummy', 'scoop', 'serving', 'drop'];
const SUPP_UNITS = ['mg', 'mcg', 'g', 'IU', 'CFU', 'mL'];
const SUPP_FOOD = [['', 'Doesn’t matter'], ['with', 'With food'], ['empty', 'Empty stomach']];
const SUPP_LOW_DAYS = 14;        // shows in "Running low" at this many days of stock

// ── UI state (not persisted) ──
let _suppLogDays     = 4;        // day groups shown in the dose log
let _suppIntakeMode  = 'plan';   // 'plan' (everything due today) | 'taken'
let _suppDraft       = null;     // supplement page being edited
let _suppDraftKey    = '';       // its key when opened ('' = new)
let _suppDirty       = false;
let _suppShowAllIng  = false;
let _suppScanning    = false;
let _suppScanServing = 0;        // serving size read from an earlier photo of the same label
let _suppTick        = null;     // countdown refresh
let _suppRenderedDay = '';


// ═══════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════
const _suppKey = n => String(n || '').trim().toLowerCase();
const _suppToMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const _suppFromMin = n => { n = ((Math.round(n) % 1440) + 1440) % 1440; return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); };
const _suppMins = n => n >= 60 ? `${Math.floor(n / 60)} hr${n % 60 ? ' ' + (n % 60) + ' min' : ''}` : `${n} min`;
function _suppFmtNum(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
const _suppPlural = (n, w) => `${_suppFmtNum(n)} ${w}${n === 1 ? '' : 's'}`;
const _suppFormLabel = (form, n) => n === 1 ? form : form === 'gummy' ? 'gummies' : form + 's';
const _suppGroup = it => it.sched === 'prn' ? 'prn' : it.slot;
const _suppSlotLabel = slot => (SUPP_SLOTS.find(s => s[0] === slot) || ['', 'Anytime'])[1];

// Day numbers in UTC so date math never trips over DST.
function _suppDayNum(ds) { const [y, m, d] = ds.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; }
function _suppAddDays(ds, n) { return new Date((_suppDayNum(ds) + n) * 86400000).toISOString().slice(0, 10); }
function _suppDayLabel(ds, today = _dietToday()) {
  const n = _suppDayNum(today) - _suppDayNum(ds);
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function _suppNormUnit(u) {
  const s = String(u || '').trim();
  if (/^(?:µg|ug|mcg)/i.test(s)) return 'mcg';
  if (/^iu$/i.test(s)) return 'IU';
  if (/^ml$/i.test(s)) return 'mL';
  if (/cfu/i.test(s)) return 'CFU';
  return s.toLowerCase();
}
function _suppUnitOptions(selected) {
  const units = SUPP_UNITS.includes(selected) || !selected ? SUPP_UNITS : [...SUPP_UNITS, selected];
  return units.map(u => `<option value="${_esc(u)}"${u === selected ? ' selected' : ''}>${_esc(u)}</option>`).join('');
}
// ["Vitamin D3 25 mcg", …], each amount scaled by `qty`.
function _suppContentsParts(contents, qty) {
  return (contents || []).filter(c => c && c.name)
    .map(c => c.amount != null ? `${c.name} ${_suppFmtNum(c.amount * qty)} ${c.unit || ''}`.trim() : c.name);
}

// Median of the most recent dose times, rounded to 5 min — "usually 9:15 AM".
function _suppMedianTime(times) {
  const m = times.filter(t => /^\d\d:\d\d$/.test(t || '')).slice(0, 20).map(_suppToMin).sort((a, b) => a - b);
  return m.length ? _suppFromMin(Math.round(m[Math.floor(m.length / 2)] / 5) * 5) : '';
}
const _suppSlotFor = t => !t || t < '12:00' ? 'morning' : t < '17:00' ? 'midday' : 'night';


// ═══════════════════════════════════════════════════════════════════════════
//  Model
// ═══════════════════════════════════════════════════════════════════════════
// One entry per supplement, A–Z. Logs give the display name, first/last dose and the
// default dose + contents; meta (set on the supplement's page) overrides them. With no
// meta yet, the time of day comes from when it's usually taken.
function _suppCatalogFrom(logs, meta, contents, cycles, notes) {
  const by = new Map();
  [...logs].sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || ''))).forEach(l => {
    const k = _suppKey(l.name);
    if (!k) return;
    const c = by.get(k);
    if (c) { c.times.push(l.time); c.first = l.date; }
    else by.set(k, { key: k, name: l.name, last: l, first: l.date, times: [l.time] });
  });
  Object.entries(meta).forEach(([k, m]) => {
    if (!by.has(k) && m && m.name) by.set(k, { key: k, name: m.name, last: null, first: '', times: [] });
  });
  const out = [];
  by.forEach(c => {
    const m = meta[c.key] || {};
    if (m.archived) return;
    const usual = _suppMedianTime(c.times);
    const cycle = cycles[c.key] || null;
    out.push({
      key: c.key, name: m.name || c.name, last: c.last, first: c.first, usual,
      contents: Array.isArray(contents[c.key]) ? contents[c.key] : (c.last && Array.isArray(c.last.contents) ? c.last.contents : []),
      qty: Number(m.qty) || (c.last && Number(c.last.qty)) || 1,
      form: m.form || 'pill',
      food: m.food === 'with' || m.food === 'empty' ? m.food : '',
      slot: m.slot || _suppSlotFor(usual),
      sched: m.sched === 'prn' ? 'prn' : cycle ? 'cycle' : 'daily',
      cycle, note: notes[c.key] || '',
      stock: m.stock == null ? '' : m.stock,
      bottle: m.bottle == null ? '' : m.bottle,
      after: m.after && m.after.key && m.after.key !== c.key ? m.after : null,
      group: m.group || '',
    });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
function _suppCatalog(logs = getSupplements()) {
  return _suppCatalogFrom(logs, _suppMap(SUPP_META), _suppMap(SUPP_CONTENTS), _suppMap(SUPP_CYCLES), _suppMap(SUPP_NOTES));
}

// Where `ds` falls in an on/off cycle. on: { on, day, of, until = first off-day };
// off: { on: false, until = next on-day }. Before the start date counts as off.
function _suppCycleState(cycle, ds) {
  const len = cycle.on + cycle.off;
  const diff = _suppDayNum(ds) - _suppDayNum(cycle.start);
  if (diff < 0) return { on: false, until: cycle.start };
  const pos = diff % len;
  if (pos < cycle.on) return { on: true, day: pos + 1, of: cycle.on, until: _suppAddDays(ds, cycle.on - pos) };
  return { on: false, until: _suppAddDays(ds, len - pos) };
}
const _suppIsOff = (it, ds) => !!it.cycle && !_suppCycleState(it.cycle, ds).on;
const _suppIsDue = (it, ds) => it.sched !== 'prn' && !_suppIsOff(it, ds);
const _suppDaysLeft = it => Math.floor(it.stock / it.qty);
const _suppIsLow = it => it.stock !== '' && (it.sched === 'prn' ? it.stock <= 7 : _suppDaysLeft(it) <= SUPP_LOW_DAYS);

// Spacing: after = { key, min } means take it at least `min` minutes after that
// supplement. `depTimes` = that supplement's dose times today. Pending until one
// is logged; then readyAt + minutes left (≤ 0 = ready now).
function _suppWaitState(after, depTimes, nowMin) {
  if (!after) return null;
  const last = depTimes.filter(Boolean).sort().pop();
  if (!last) return { pending: true, min: after.min };
  const ready = _suppToMin(last) + after.min;
  return { pending: false, min: after.min, readyAt: _suppFromMin(ready), left: ready - nowMin };
}
// Minutes between a dose at `t` and the latest earlier one in `depTimes`, or null.
function _suppGapBefore(t, depTimes) {
  const before = depTimes.filter(x => x && x <= t).sort().pop();
  return before ? _suppToMin(t) - _suppToMin(before) : null;
}

// A supplement that waits on another sits right after it in its time slot.
function _suppChainOrder(list) {
  const out = [];
  const add = s => { if (out.includes(s)) return; out.push(s); list.filter(x => x.after && x.after.key === s.key).forEach(add); };
  list.filter(s => !s.after || !list.some(x => x.key === s.after.key)).forEach(add);
  list.forEach(add);   // a loop (A after B after A) falls through in list order
  return out;
}

// Today's intake: every ingredient added up, A–Z. The same nutrient in different
// forms merges (Magnesium Chelate + Magnesium Glycinate → Magnesium); mass units
// convert so mcg and mg of one nutrient add up.
// ponytail: form words + aliases are a name heuristic; extend the lists as new labels need them.
const _SUPP_FORM_RE = /\s+(chelate|glycinate|bisglycinate|citrate|oxide|picolinate|malate|chloride|carbonate|gluconate)$/i;
const _SUPP_ALIAS = { 'methylated b-12': 'Vitamin B12', 'methylcobalamin': 'Vitamin B12', 'methylfolate': 'Folate' };
const _SUPP_TO_MG = { mg: 1, mcg: 0.001, g: 1000 };
function _suppNutrient(n) { const t = String(n).trim(); return _SUPP_ALIAS[t.toLowerCase()] || t.replace(_SUPP_FORM_RE, ''); }
// entries: [{ name, qty, contents }] → [{ name, amount, unit, src: ["NAC + ALA 500 mg"] }]
function _suppTotals(entries) {
  const m = new Map();
  entries.forEach(e => (e.contents || []).forEach(c => {
    if (!c || !c.name || c.amount == null) return;
    const name = _suppNutrient(c.name), f = _SUPP_TO_MG[c.unit];
    const k = name.toLowerCase() + (f ? '' : '|' + c.unit);
    const cur = m.get(k) || { name, unit: c.unit, f, val: 0, src: [] };
    const amt = c.amount * (e.qty || 1);
    cur.val += f ? amt * f : amt;
    cur.src.push(`${e.name} ${_suppFmtNum(amt)} ${c.unit || ''}`.trim());
    m.set(k, cur);
  }));
  return [...m.values()]
    .map(t => ({ name: t.name, unit: t.unit, amount: t.f ? t.val / t.f : t.val, src: t.src }))
    .sort((a, b) => a.name.localeCompare(b.name));
}


// ═══════════════════════════════════════════════════════════════════════════
//  Writes
// ═══════════════════════════════════════════════════════════════════════════
// Rename everywhere a supplement is keyed by name: its log entries, the four maps,
// and any spacing rule pointing at it.
function _suppRename(oldKey, newName) {
  const nk = _suppKey(newName);
  saveSupplements(getSupplements().map(l => _suppKey(l.name) === oldKey ? { ...l, name: newName } : l));
  [SUPP_CONTENTS, SUPP_CYCLES, SUPP_NOTES, SUPP_META].forEach(K => {
    const map = { ..._suppMap(K) };
    if (nk !== oldKey && oldKey in map) { map[nk] = map[oldKey]; delete map[oldKey]; }
    if (K === SUPP_META) {
      Object.keys(map).forEach(k => { const a = map[k] && map[k].after; if (a && a.key === oldKey) map[k] = { ...map[k], after: { ...a, key: nk } }; });
      if (map[nk]) map[nk] = { ...map[nk], name: newName };
    }
    _suppSaveMap(K, map);
  });
}

function _suppWriteItem(key, it) {
  _suppSaveMap(SUPP_META, { ..._suppMap(SUPP_META), [key]: {
    name: it.name, slot: it.slot, sched: it.sched, qty: it.qty, form: it.form, food: it.food, stock: it.stock, bottle: it.bottle, after: it.after, group: it.group || '',
  } });
  _suppSaveMap(SUPP_CONTENTS, { ..._suppMap(SUPP_CONTENTS), [key]: it.contents });
  const cycles = { ..._suppMap(SUPP_CYCLES) };
  if (it.cycle) cycles[key] = it.cycle; else delete cycles[key];
  _suppSaveMap(SUPP_CYCLES, cycles);
  const notes = { ..._suppMap(SUPP_NOTES) };
  if (it.note) notes[key] = it.note; else delete notes[key];
  _suppSaveMap(SUPP_NOTES, notes);
}

function _suppAdjustStock(key, delta) {
  const meta = _suppMap(SUPP_META), m = meta[key];
  if (!m || m.stock === '' || m.stock == null) return;
  _suppSaveMap(SUPP_META, { ...meta, [key]: { ...m, stock: Math.max(0, Number(m.stock) + delta) } });
}

// Log a dose (taken from stock when stock is tracked). Returns an undo.
function _suppLogDose(it, date, time, qty) {
  const e = { id: _dietId(), name: it.name, date, time: time || '', qty, contents: it.contents };
  saveSupplements([...getSupplements(), e]);
  _suppAdjustStock(it.key, -qty);
  return () => { saveSupplements(getSupplements().filter(x => x.id !== e.id)); _suppAdjustStock(it.key, qty); renderSupplements(); };
}
// ponytail: deleting any dose puts it back in stock, even one logged before stock was counted.
function _suppRemoveDose(e) {
  const k = _suppKey(e.name), q = e.qty || 1;
  saveSupplements(getSupplements().filter(x => x.id !== e.id));
  _suppAdjustStock(k, q);
  return () => { saveSupplements([...getSupplements(), e]); _suppAdjustStock(k, -q); renderSupplements(); };
}


// ═══════════════════════════════════════════════════════════════════════════
//  Render
// ═══════════════════════════════════════════════════════════════════════════
function _suppCtx() {
  const logs = getSupplements();
  const ix = new Map();
  logs.forEach(l => { const k = _suppKey(l.name) + '|' + l.date; (ix.get(k) || ix.set(k, []).get(k)).push(l); });
  const today = _dietToday(), now = _dietNowTime();
  const cat = _suppCatalog(logs);
  return {
    logs, today, now, nowMin: _suppToMin(now), cat,
    byKey: k => cat.find(x => x.key === k),
    doses: (key, d = today) => (ix.get(key + '|' + d) || []).slice().sort((a, b) => (a.time || '').localeCompare(b.time || '')),
  };
}
function _suppWait(c, it) {
  const dep = it.after && c.byKey(it.after.key);
  const st = dep && _suppWaitState(it.after, c.doses(dep.key).map(l => l.time), c.nowMin);
  return st ? { ...st, dep } : null;
}

function renderSupplements() {
  if (!document.getElementById('suppHead')) return;
  const c = _suppCtx();
  _suppRenderHead(c); _suppRenderToday(c); _suppRenderGrid(c); _suppRenderLog(c); _suppRenderLow(c); _suppRenderIntake(c);
  _suppRenderedDay = c.today;
  if (!_suppTick) _suppTick = setInterval(_suppRefreshLive, 15000);
}
// Countdowns tick while the view is on screen; a new day re-renders everything.
function _suppRefreshLive() {
  if (document.getElementById('dietViewSupps').hidden || !document.getElementById('tab-diet').classList.contains('active')) return;
  if (_dietToday() !== _suppRenderedDay) return renderSupplements();
  const c = _suppCtx();
  _suppRenderHead(c); _suppRenderToday(c);
}

function _suppRenderHead(c) {
  const due = c.cat.filter(it => _suppIsDue(it, c.today));
  const done = due.filter(it => c.doses(it.key).length);
  const order = SUPP_SLOTS.map(s => s[0]);
  const left = due.filter(it => !c.doses(it.key).length).sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
  const waiting = left.map(it => [it, _suppWait(c, it)]).filter(([, w]) => w && !w.pending && w.left > 0);
  const C = 2 * Math.PI * 28;
  const frac = due.length ? done.length / due.length : 0;
  document.getElementById('suppHead').innerHTML = `
    <div class="supp-ring">
      <svg width="64" height="64" aria-hidden="true"><circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="5"/>
        <circle cx="32" cy="32" r="28" fill="none" stroke="var(--supp-ok)" stroke-width="5" stroke-linecap="round"
          stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/></svg>
      <div class="supp-ring-txt">${done.length}/${due.length}</div>
    </div>
    <div class="supp-head-main">
      <div class="supp-head-title">Supplements</div>
      <div class="supp-head-sub">
        ${!c.cat.length ? '<span>Add what you take, then tick it off each day.</span>'
          : left.length ? `<span>${_suppSlotLabel(left[0].slot)}: ${left.filter(it => it.slot === left[0].slot).map(it => _esc(it.name)).join(', ')}</span>`
          : due.length ? '<span class="ok">✓ Everything due today is taken</span>' : '<span>Nothing due today</span>'}
        ${waiting.map(([it, w]) => `<span class="warn">⏱ ${_esc(it.name)} in ${_suppMins(w.left)}</span>`).join('')}
      </div>
    </div>
    <div class="supp-head-actions"><button type="button" class="supp-btn primary" data-supp-new>+ Add supplement</button></div>`;
}

function _suppRenderToday(c) {
  document.getElementById('suppTodayDate').textContent =
    new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const el = document.getElementById('suppToday');
  if (!c.cat.length) {
    el.innerHTML = `<div class="supp-empty">No supplements yet. <button type="button" class="supp-link" data-supp-new>Add your first one</button> — a photo of the label fills in what's in it.</div>`;
    return;
  }
  el.innerHTML = [...SUPP_SLOTS, ['prn', 'As needed']].map(([g, label]) => {
    const list = _suppChainOrder(c.cat.filter(it => _suppGroup(it) === g));
    if (!list.length) return '';
    const blocks = [], byGroup = new Map();   // supplements sharing a group sit together; a lone member shows as a plain row
    list.forEach(it => {
      const gk = _suppKey(it.group);
      if (!gk) return blocks.push([it]);
      if (byGroup.has(gk)) return byGroup.get(gk).push(it);
      const b = [it]; byGroup.set(gk, b); blocks.push(b);
    });
    const due = list.filter(it => _suppIsDue(it, c.today));
    const done = due.filter(it => c.doses(it.key).length).length;
    return `<div class="supp-slot">
      <div class="supp-slot-h ${g}">${label}${g === 'prn' ? '<span class="hint">doesn’t count toward today</span>' : `<span class="n">${done}/${due.length}</span>`}</div>
      ${blocks.map(b => b.length > 1 ? _suppGroupHTML(c, b, g) : _suppRowHTML(c, b[0])).join('')}
    </div>`;
  }).join('');
}

// Members keep their own rows (take one, some or all); the footer takes whatever is left.
function _suppGroupHTML(c, b, g) {
  const gk = _suppKey(b[0].group);
  const todo = b.filter(it => !c.doses(it.key).length && !_suppIsOff(it, c.today));
  const taken = b.filter(it => c.doses(it.key).length).length;
  return `<div class="supp-group ${g}" data-supp-grp="${_esc(gk)}">${b.map(it => _suppRowHTML(c, it)).join('')}
    <div class="supp-grp-f"><button type="button" class="supp-name-btn" data-supp-grprename="${_esc(gk)}" title="Rename group">${_esc(b[0].group)}</button>
      <span>${taken}/${b.length}</span>
      ${todo.length ? `<button type="button" class="supp-link" data-supp-takegrp="${_esc(gk)}" data-g="${g}">${taken ? 'Take rest' : 'Take all'}</button>` : '<span class="ok">✓ all taken</span>'}
      <button type="button" class="supp-link mute" data-supp-ungroup="${_esc(gk)}">Ungroup</button></div>
  </div>`;
}

function _suppRowHTML(c, it) {
  const ds = c.doses(it.key);
  const done = ds.length > 0;
  const off = _suppIsOff(it, c.today);
  const st = it.cycle ? _suppCycleState(it.cycle, c.today) : null;
  const w = !done && _suppWait(c, it);
  const waiting = !!w && !w.pending && w.left > 0, ready = !!w && !w.pending && !waiting;
  const when = done ? '✓ ' + ds.map(l => _dietFmtTime(l.time) || 'logged').join(', ')
    : off ? '' : waiting ? 'ready ' + _dietFmtTime(w.readyAt) : ready ? 'ready now'
    : it.usual ? 'usually ' + _dietFmtTime(it.usual) : '';
  const parts = _suppContentsParts(it.contents, it.qty);
  const state = waiting ? ' wait' : ready ? ' ready' : '';
  return _suppGapHTML(c, it, ds, w) + `<div class="supp-row${done ? ' done' : ''}${off ? ' resting' : ''}" data-supp-open="${_esc(it.key)}" data-supp-key="${_esc(it.key)}" draggable="true">
    <button type="button" class="supp-chk ${_suppGroup(it)}${state}" data-supp-take="${_esc(it.key)}" aria-label="${done ? 'Undo' : 'Take'} ${_esc(it.name)}"><span>${waiting ? (w.left > 99 ? Math.ceil(w.left / 60) + 'h' : w.left) : '✓'}</span></button>
    <div class="supp-row-main">
      <div class="supp-name"><button type="button" class="supp-name-btn">${_esc(it.name)}</button><span class="dose">${_suppFmtNum(it.qty)} ${_suppFormLabel(it.form, it.qty)}</span></div>
      <div class="supp-sub"><span class="tx">${it.food ? `<span class="fd ${it.food}">${it.food === 'with' ? '🍽 With food' : 'Empty stomach'}</span> · ` : ''}${it.note ? `<span class="nt">${_esc(it.note)}</span> · ` : ''}${_esc(parts.slice(0, 3).join(' · ') || 'No contents saved')}</span>${parts.length > 3 ? `<span class="more">+${parts.length - 3} more</span>` : ''}</div>
    </div>
    <div class="supp-side">
      ${st ? `<span class="supp-pill cyc${st.on ? '' : ' off'}">⟳ ${st.on ? `day ${st.day}/${st.of}` : 'off till ' + _dietFmtDate(st.until)}</span>` : ''}
      ${it.stock !== '' ? `<span class="supp-pill${_suppIsLow(it) ? ' low' : ''}">${_suppFmtNum(it.stock)} left</span>` : ''}
      <span class="supp-when${state}">${when}</span>
    </div>
  </div>`;
}

// The dashed link above a supplement that waits on another one.
function _suppGapHTML(c, it, ds, w) {
  const dep = it.after && c.byKey(it.after.key);
  if (!dep) return '';
  const min = it.after.min, name = _esc(dep.name);
  let cls = '', txt = `${_suppMins(min)} after ${name}`;
  const first = ds.map(l => l.time).filter(Boolean)[0];
  const gap = first ? _suppGapBefore(first, c.doses(dep.key).map(l => l.time)) : null;
  if (gap != null) {
    cls = gap >= min ? 'ok' : 'early';
    txt = gap >= min ? `✓ waited ${_suppMins(gap)} after ${name}` : `only ${_suppMins(gap)} after ${name}, aim for ${_suppMins(min)}`;
  } else if (ds.length) txt = `logged without ${name} first`;
  else if (w && w.pending) txt += ' · starts when you take it';
  else if (w) { cls = w.left > 0 ? 'wait' : 'ready'; txt += w.left > 0 ? ` · ${_suppMins(w.left)} left` : ' · ready now'; }
  return `<div class="supp-gap ${cls}"><span class="ln"></span><span>⏱ ${txt}</span></div>`;
}

function _suppRenderGrid(c) {
  const el = document.getElementById('suppGrid');
  if (!c.cat.length) { el.innerHTML = '<div class="supp-empty">Your last two weeks show up here.</div>'; return; }
  const days = [...Array(14)].map((_, i) => _suppAddDays(c.today, i - 13));
  const head = '<div></div>' + days.map((d, i) => {
    const [y, m, dd] = d.split('-').map(Number);
    return `<div class="supp-gh${d === c.today ? ' today' : ''}${i < 7 ? ' old' : ''}">${'SMTWTFS'[new Date(y, m - 1, dd).getDay()]}<b>${dd}</b></div>`;
  }).join('') + '<div></div>';
  const rows = c.cat.map(it => {
    const prn = it.sched === 'prn';
    let taken = 0, due = 0;
    const cells = days.map((d, i) => {
      const ds = c.doses(it.key, d), n = ds.length;
      const pre = !n && (!it.first || d < it.first);   // before it was first taken: not "missed"
      const off = !pre && _suppIsOff(it, d);
      if (n) taken++;
      if (!prn && !off && !pre) due++;
      const tip = _suppDayLabel(d, c.today) + ' · ' + (n ? ds.map(l => _dietFmtTime(l.time) || 'logged').join(', ') + ' — tap to remove'
        : off ? 'off-cycle' : `tap to log at ${_dietFmtTime(d === c.today ? c.now : it.usual || '09:00')}`);
      const cls = ['supp-cell', n && 't', (prn || pre) && 'quiet', off && 'off', d === c.today && 'today', i < 7 && 'old'].filter(Boolean).join(' ');
      return `<button type="button" class="${cls}" data-supp-cell="${_esc(it.key)}|${d}" title="${_esc(tip)}" aria-label="${_esc(it.name + ', ' + tip)}">${n > 1 ? n : ''}</button>`;
    }).join('');
    const rate = prn ? `${taken}×<small>as needed</small>` : `${Math.round(100 * Math.min(taken, due) / (due || 1))}%<small>${taken}/${due}</small>`;
    return `<button type="button" class="supp-gl" data-supp-open="${_esc(it.key)}"><i class="${_suppGroup(it)}"></i><span>${_esc(it.name)}</span></button>${cells}<div class="supp-gr">${rate}</div>`;
  }).join('');
  el.innerHTML = head + rows;
}

function _suppRenderLog(c) {
  const el = document.getElementById('suppLog');
  if (!c.logs.length) { el.innerHTML = '<div class="supp-empty">Nothing logged yet.</div>'; return; }
  const groups = [];
  [...c.logs].sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || ''))).forEach(l => {
    let g = groups[groups.length - 1];
    if (!g || g.d !== l.date) groups.push(g = { d: l.date, items: [] });
    g.items.push(l);
  });
  el.innerHTML = groups.slice(0, _suppLogDays).map(g => `<div class="supp-day">
      <div class="supp-day-h">${_suppDayLabel(g.d, c.today)}<span>${_suppPlural(g.items.length, 'dose')}</span></div>
      ${g.items.reverse().map(l => _suppLogRowHTML(c, l)).join('')}
    </div>`).join('') +
    (groups.length > _suppLogDays ? '<button type="button" class="supp-btn supp-more-btn" data-supp-more>Show earlier days</button>' : '');
}
function _suppLogRowHTML(c, l) {
  const k = _suppKey(l.name), it = c.byKey(k);
  const dep = it && it.after && c.byKey(it.after.key);
  const gap = dep && l.time ? _suppGapBefore(l.time, c.doses(dep.key, l.date).map(x => x.time)) : null;
  const note = gap != null && gap <= it.after.min + 180
    ? `<span class="gp ${gap >= it.after.min ? 'ok' : 'early'}">${gap >= it.after.min ? '✓' : '⚠'} ${_suppMins(gap)} after ${_esc(dep.name)}</span>` : '';
  return `<div class="supp-log">
    <span class="tm">${l.time ? _dietFmtTime(l.time) : '—'}</span><i class="${it ? _suppGroup(it) : ''}"></i>
    <span class="nm">${it ? `<button type="button" class="supp-name-btn" data-supp-open="${_esc(k)}">${_esc(l.name)}</button>` : _esc(l.name)}${note}</span>
    <span class="q">× ${_suppFmtNum(l.qty || 1)}</span>
    <button type="button" class="x" data-supp-del="${_esc(l.id)}" aria-label="Delete ${_esc(l.name)} dose">×</button>
  </div>`;
}

function _suppRenderLow(c) {
  const low = c.cat.filter(_suppIsLow).sort((a, b) => a.stock - b.stock);
  const tracked = c.cat.some(it => it.stock !== '');
  document.getElementById('suppLow').innerHTML = low.length ? low.map(it => `<div class="supp-low">
      <div class="nm"><div>${_esc(it.name)}</div><small>${_suppFmtNum(it.stock)} ${_suppFormLabel(it.form, it.stock)} left${it.sched === 'prn' ? '' : ` · ~${_suppDaysLeft(it)} days`}</small></div>
      ${it.bottle ? `<button type="button" class="supp-btn" data-supp-restock="${_esc(it.key)}">+${_suppFmtNum(it.bottle)} restocked</button>`
        : `<button type="button" class="supp-btn" data-supp-open="${_esc(it.key)}">Update</button>`}
    </div>`).join('')
    : `<div class="supp-rail-foot">${tracked ? `Nothing under ${SUPP_LOW_DAYS} days of stock.` : 'Add how many you have on a supplement’s page to track it here.'}</div>`;
}

function _suppRenderIntake(c) {
  const entries = _suppIntakeMode === 'taken'
    ? c.logs.filter(l => l.date === c.today).map(l => ({ name: l.name, qty: l.qty || 1, contents: l.contents }))
    : c.cat.filter(it => _suppIsDue(it, c.today) || c.doses(it.key).length).map(it => ({
        name: it.name, contents: it.contents,
        qty: Math.max(it.qty, c.doses(it.key).reduce((a, l) => a + (l.qty || 1), 0)),
      }));
  const t = _suppTotals(entries);
  document.querySelectorAll('[data-supp-intake]').forEach(b => b.classList.toggle('on', b.dataset.suppIntake === _suppIntakeMode));
  document.getElementById('suppIntake').innerHTML = !t.length
    ? `<div class="supp-rail-foot">${_suppIntakeMode === 'taken' ? 'Nothing taken yet today.' : 'Nothing due today.'}</div>`
    : `<div class="supp-plain">${t.map(x => `<span title="${_esc(x.src.join(' + '))}">${_esc(x.name)}</span><span>${_suppFmtNum(x.amount)} ${_esc(x.unit || '')}</span>`).join('')}</div>
      <div class="supp-rail-foot">${_suppPlural(t.length, 'ingredient')} from ${_suppPlural(new Set(entries.map(e => _suppKey(e.name))).size, 'supplement')}.
        The same nutrient in different forms is added together (Magnesium Chelate + Glycinate → Magnesium). Hover one to see where it comes from.</div>`;
}


// ═══════════════════════════════════════════════════════════════════════════
//  Actions on the view
// ═══════════════════════════════════════════════════════════════════════════
function _suppTake(key) {
  const c = _suppCtx(), it = c.byKey(key);
  if (!it) return;
  const ds = c.doses(key);
  if (ds.length) {
    const undo = _suppRemoveDose(ds[ds.length - 1]);
    renderSupplements();
    _finToast(`Removed ${_esc(it.name)}`, 'Today', undo);
    return;
  }
  if (_suppIsOff(it, c.today) && !confirm(`${it.name} is in its off period. Log it anyway?`)) return;
  const w = _suppWait(c, it);
  if (w && w.pending && !confirm(`${it.name} goes ${_suppMins(w.min)} after ${w.dep.name}, which isn't logged yet today. Take it anyway?`)) return;
  if (w && !w.pending && w.left > 0 && !confirm(`${_suppMins(w.left)} to go — ${it.name} goes ${_suppMins(w.min)} after ${w.dep.name}. Take it now anyway?`)) return;
  const undo = _suppLogDose(it, c.today, c.now, it.qty);
  const next = c.cat.filter(f => f.after && f.after.key === key && !c.doses(f.key).length)
    .map(f => `${_esc(f.name)} ready at ${_dietFmtTime(_suppFromMin(c.nowMin + f.after.min))}`);
  renderSupplements();
  _finToast(`Took ${_suppFmtNum(it.qty)} × ${_esc(it.name)}`, next.length ? '⏱ ' + next.join(' · ') : '', undo);
}

// Take every member of a group not taken yet today (off-cycle ones are skipped), as one undo.
function _suppTakeGroup(gk, g) {
  const c = _suppCtx();
  const todo = _suppChainOrder(c.cat.filter(it => _suppKey(it.group) === gk && _suppGroup(it) === g && !c.doses(it.key).length && !_suppIsOff(it, c.today)));
  if (!todo.length) return;
  const early = todo.filter(it => { const w = _suppWait(c, it); return w && !todo.includes(w.dep) && (w.pending || w.left > 0); });
  if (early.length && !confirm(`${early.map(it => it.name).join(', ')} ${early.length > 1 ? 'have' : 'has'} a spacing rule that isn't met yet. Take the group anyway?`)) return;
  const undos = todo.map(it => _suppLogDose(it, c.today, c.now, it.qty));
  renderSupplements();
  _finToast(`Took ${todo.map(it => _esc(it.name)).join(' + ')}`, '', () => { undos.forEach(u => u()); });
}

// Set (or clear, with '') the group of some supplements; undo restores the meta map.
function _suppSetGroup(keys, group, title) {
  const meta = _suppMap(SUPP_META), cat = _suppCatalog(), next = { ...meta };
  keys.forEach(k => { const it = cat.find(x => x.key === k); if (it) next[k] = { ...(meta[k] || {}), name: it.name, group }; });
  _suppSaveMap(SUPP_META, next);
  renderSupplements();
  _finToast(title, '', () => { _suppSaveMap(SUPP_META, meta); renderSupplements(); });
}
const _suppGroupKeys = (gk, g) => _suppCatalog().filter(it => _suppKey(it.group) === gk && (!g || _suppGroup(it) === g)).map(it => it.key);

// Drag a supplement onto another (same time slot): joins its group, or starts one.
function _suppDropOn(aKey, bKey) {
  const cat = _suppCatalog(), a = cat.find(x => x.key === aKey), b = cat.find(x => x.key === bKey);
  if (!a || !b || a === b) return;
  if (_suppGroup(a) !== _suppGroup(b)) return _finToast('Groups stay within one time slot', `${_esc(a.name)} is ${_suppSlotLabel(a.slot)}, ${_esc(b.name)} is ${_suppSlotLabel(b.slot)}`);
  if (a.group && _suppKey(a.group) === _suppKey(b.group)) return;
  let name = b.group;
  if (!name) {
    name = (prompt('Name this group', `${_suppSlotLabel(b.slot)} stack`) || '').trim();
    if (!name) return;
  }
  _suppSetGroup(b.group ? [aKey] : [aKey, bKey], name, `Grouped ${_esc(a.name)} with ${_esc(b.name)}`);
}

// A square in the 14-day grid: remove that day's dose, or log one at the usual time.
function _suppCell(v) {
  const i = v.lastIndexOf('|'), key = v.slice(0, i), d = v.slice(i + 1);
  const c = _suppCtx(), it = c.byKey(key);
  if (!it) return;
  const ds = c.doses(key, d), label = _suppDayLabel(d, c.today);
  if (ds.length) {
    const undo = _suppRemoveDose(ds[ds.length - 1]);
    renderSupplements();
    _finToast(`Removed ${_esc(it.name)}`, _esc(label), undo);
    return;
  }
  const t = d === c.today ? c.now : it.usual || '09:00';
  const undo = _suppLogDose(it, d, t, it.qty);
  renderSupplements();
  _finToast(`Logged ${_esc(it.name)}`, _esc(`${label} · ${_dietFmtTime(t)}`), undo);
}

function _suppDeleteDose(id) {
  const e = getSupplements().find(x => x.id === id);
  if (!e) return;
  const undo = _suppRemoveDose(e);
  renderSupplements();
  _finToast(`Deleted ${_esc(e.name)}`, _esc(_suppDayLabel(e.date) + (e.time ? ' · ' + _dietFmtTime(e.time) : '')), undo);
}

function _suppRestock(key) {
  const it = _suppCatalog().find(x => x.key === key);
  if (!it || !it.bottle) return;
  _suppAdjustStock(key, it.bottle);
  renderSupplements();
  _finToast(`${_esc(it.name)} restocked`, `${_suppFmtNum(Number(it.stock) + Number(it.bottle))} left`,
    () => { _suppAdjustStock(key, -it.bottle); renderSupplements(); });
}

function _suppOnViewClick(e) {
  const T = sel => e.target.closest(sel);
  let el;
  if ((el = T('[data-supp-take]')))    return _suppTake(el.dataset.suppTake);
  if ((el = T('[data-supp-takegrp]'))) return _suppTakeGroup(el.dataset.suppTakegrp, el.dataset.g);
  if ((el = T('[data-supp-ungroup]'))) return _suppSetGroup(_suppGroupKeys(el.dataset.suppUngroup), '', 'Group removed');
  if ((el = T('[data-supp-grprename]'))) {
    const gk = el.dataset.suppGrprename, cur = el.textContent;
    const name = (prompt('Rename group', cur) || '').trim();
    return name && name !== cur ? _suppSetGroup(_suppGroupKeys(gk), name, `Renamed to ${_esc(name)}`) : undefined;
  }
  if ((el = T('[data-supp-cell]')))    return _suppCell(el.dataset.suppCell);
  if ((el = T('[data-supp-del]')))     return _suppDeleteDose(el.dataset.suppDel);
  if ((el = T('[data-supp-restock]'))) return _suppRestock(el.dataset.suppRestock);
  if ((el = T('[data-supp-intake]')))  { _suppIntakeMode = el.dataset.suppIntake; return _suppRenderIntake(_suppCtx()); }
  if (T('[data-supp-more]'))           { _suppLogDays += 7; return _suppRenderLog(_suppCtx()); }
  if (T('[data-supp-new]'))            return openSuppPage('');
  if ((el = T('[data-supp-open]')))    return openSuppPage(el.dataset.suppOpen);
}


// ═══════════════════════════════════════════════════════════════════════════
//  Supplement page (slide-in editor; edits apply on Save)
// ═══════════════════════════════════════════════════════════════════════════
function openSuppPage(key) {
  const it = key ? _suppCatalog().find(x => x.key === key) : null;
  _suppDraftKey = it ? it.key : '';
  _suppDraft = it
    ? { name: it.name, slot: it.slot, sched: it.sched, qty: it.qty, form: it.form, food: it.food, stock: it.stock, bottle: it.bottle, note: it.note,
        after: it.after ? { ...it.after } : null, contents: it.contents.map(x => ({ ...x })), cycle: it.cycle ? { ...it.cycle } : null }
    : { name: '', slot: 'morning', sched: 'daily', qty: 1, form: 'pill', food: '', stock: '', bottle: '', note: '',
        after: null, contents: [{ name: '', amount: null, unit: 'mg' }], cycle: null };
  if (!_suppDraft.cycle) _suppDraft.cycle = { on: 56, off: 14, start: _dietToday() };
  _suppDirty = false; _suppShowAllIng = false; _suppScanServing = 0;
  renderSuppPage();
  const page = document.getElementById('suppDrawer');
  page.querySelector('.supp-dr-body').scrollTop = 0;
  page.classList.add('open');
  document.getElementById('suppScrim').classList.add('open');
  _mobLockBody();
  setTimeout(() => (it ? page : page.querySelector('.supp-dr-name')).focus(), 50);
}

function closeSuppPage(force) {
  const page = document.getElementById('suppDrawer');
  if (!page.classList.contains('open')) return;
  if (!force && _suppDirty && !confirm('Discard your changes?')) return;
  page.classList.remove('open');
  document.getElementById('suppScrim').classList.remove('open');
  _suppDraft = null;
  _mobUnlockBodyIfClear();
}

function renderSuppPage() {
  const s = _suppDraft;
  if (!s) return;
  const page = document.getElementById('suppDrawer');
  const oldBody = page.querySelector('.supp-dr-body');
  const scroll = oldBody ? oldBody.scrollTop : 0;
  const c = _suppCtx();
  const isNew = !_suppDraftKey;
  const it = isNew ? null : c.byKey(_suppDraftKey);
  const days30 = [...Array(30)].map((_, i) => _suppAddDays(c.today, i - 29));
  const taken30 = it ? days30.filter(d => c.doses(it.key, d).length).length : 0;
  const due30 = it ? days30.filter(d => it.first && d >= it.first && _suppIsDue(it, d)).length : 0;
  const last = it && it.last;
  const followers = it ? c.cat.filter(x => x.after && x.after.key === it.key) : [];
  const deps = c.cat.filter(x => x.key !== _suppDraftKey && !(it && x.after && x.after.key === it.key));
  const many = s.contents.length > 8 && !_suppShowAllIng;
  const shown = many ? s.contents.slice(0, 6) : s.contents;
  const pl = _suppFormLabel(s.form, 2);
  const seg = (attr, opts, cur, colored) => opts.map(([v, l]) =>
    `<button type="button" data-${attr}="${v}" class="${v === cur ? 'on ' : ''}${colored ? v : ''}">${l}</button>`).join('');
  const cycIn = k => {
    const d = s.cycle[k], wk = d % 7 === 0;
    return `<input class="supp-in num" data-cyc="${k}" value="${wk ? d / 7 : d}" inputmode="numeric" aria-label="${k} length">
      <select class="supp-in" data-cyc-unit="${k}" aria-label="${k} unit"><option value="7"${wk ? ' selected' : ''}>weeks</option><option value="1"${wk ? '' : ' selected'}>days</option></select>`;
  };
  const scanLabel = _suppScanning ? 'Reading the label…' : null;
  const statLast = !last ? '—' : last.date === c.today ? _dietFmtTime(last.time) || 'Today' : _dietFmtDate(last.date);

  page.innerHTML = `
  <div class="supp-dr-body">
    <div class="supp-dr-top">
      <input class="supp-dr-name" value="${_esc(s.name)}" placeholder="Supplement name" data-f="name" aria-label="Name" maxlength="80">
      <button type="button" class="supp-x" data-supp-close aria-label="Close">×</button>
    </div>
    ${isNew ? `<div class="supp-f">
      <button type="button" class="supp-scan" data-supp-scan ${_suppScanning ? 'disabled' : ''}><span class="ic">📷</span>
        <span>${scanLabel || 'Scan the Supplement Facts label'}<small>Fills in every ingredient and amount, per ${_esc(s.form)}</small></span></button>
      <span class="polish-status" id="suppScanStatus"></span>
    </div>` : `
    <div class="supp-dr-stats">
      <div class="supp-stat"><b>${s.sched === 'prn' ? taken30 + '×' : Math.round(100 * Math.min(taken30, due30) / (due30 || 1)) + '%'}</b><span>last 30 days</span></div>
      <div class="supp-stat"><b>${_esc(statLast)}</b><span>${last && last.date === c.today ? 'taken today' : last ? 'last taken' : 'not taken yet'}</span></div>
      <div class="supp-stat"><b class="${it && _suppIsLow(it) ? 'low' : ''}">${it && it.stock !== '' ? _suppFmtNum(it.stock) : '—'}</b><span>${it && it.stock !== '' ? (it.sched === 'prn' ? `${_suppFormLabel(it.form, 2)} left` : `~${_suppDaysLeft(it)} days left`) : 'stock not tracked'}</span></div>
    </div>
    <div class="supp-dr-mini">${days30.map(d => `<i class="${c.doses(it.key, d).length ? 't' : ''}" title="${_esc(_suppDayLabel(d, c.today))}"></i>`).join('')}</div>
    <div class="supp-dr-mini-l"><span>${_esc(_dietFmtDate(days30[0]))}</span><span>Today</span></div>`}

    <div class="supp-f">
      <div class="supp-f-l">Dose</div>
      <div class="supp-f-row">
        <span class="supp-stepper"><button type="button" data-supp-step="-0.5" aria-label="Less">−</button><input data-f="qty" value="${_esc(s.qty)}" inputmode="decimal" aria-label="Amount per dose"><button type="button" data-supp-step="0.5" aria-label="More">+</button></span>
        <select class="supp-in" data-f="form" aria-label="Form">${SUPP_FORMS.map(f => `<option${f === s.form ? ' selected' : ''}>${f}</option>`).join('')}</select>
        <span>per dose</span>
      </div>
    </div>

    <div class="supp-f">
      <div class="supp-f-l">When</div>
      <div class="supp-segs">${seg('supp-slot', SUPP_SLOTS, s.slot, true)}</div>
    </div>

    <div class="supp-f">
      <div class="supp-f-l">Food</div>
      <div class="supp-segs">${seg('supp-food', SUPP_FOOD, s.food)}</div>
    </div>

    <div class="supp-f">
      <div class="supp-f-l">Spacing</div>
      <div class="supp-f-row">
        Wait <input class="supp-in num" data-after-min value="${s.after ? s.after.min : 30}" inputmode="numeric" aria-label="Minutes" ${s.after ? '' : 'disabled'}> min after
        <select class="supp-in" data-after-key aria-label="Supplement to wait after">
          <option value="">— no wait —</option>
          ${deps.map(x => `<option value="${_esc(x.key)}"${s.after && s.after.key === x.key ? ' selected' : ''}>${_esc(x.name)}</option>`).join('')}
        </select>
      </div>
      <div class="supp-hint">${s.after && c.byKey(s.after.key)
        ? `Once ${_esc(c.byKey(s.after.key).name)} is logged, today's list counts down until this one is ready. Doses taken too soon are flagged in the log.`
        : 'For things like “Optimize Minerals 30 min after NAC + ALA”. Today’s list shows a countdown.'}
        ${followers.map(f => `<br>${_esc(f.name)} waits ${_suppMins(f.after.min)} after this one.`).join('')}</div>
    </div>

    <div class="supp-f">
      <div class="supp-f-l">Schedule</div>
      <div class="supp-segs">${seg('supp-sched', [['daily', 'Every day'], ['cycle', 'Cycle on / off'], ['prn', 'As needed']], s.sched)}</div>
      ${s.sched === 'cycle' ? `<div class="supp-cyc">
        <div class="supp-f-row">On for ${cycIn('on')} then off for ${cycIn('off')}</div>
        <div class="supp-f-row">First on-day <input class="supp-in" type="date" data-cyc-start value="${_esc(s.cycle.start)}" aria-label="Cycle start date"></div>
        <div class="supp-cyc-st" id="suppCycStatus">${_suppCycleText(s.cycle, c.today)}</div>
      </div>` : ''}
      ${s.sched === 'prn' ? '<div class="supp-hint">Shows under “As needed”. Days you skip never count as missed.</div>' : ''}
    </div>

    <div class="supp-f">
      <div class="supp-f-l"><span>Contents per ${_esc(s.form)}</span>${isNew ? '' : `<button type="button" class="supp-link" data-supp-scan ${_suppScanning ? 'disabled' : ''}>📷 ${scanLabel || 'Rescan label'}</button>`}</div>
      ${isNew ? '' : '<span class="polish-status" id="suppScanStatus"></span>'}
      ${shown.map((r, i) => `<div class="supp-ing">
        <input class="supp-in" data-ing="${i}|name" value="${_esc(r.name)}" placeholder="Ingredient" aria-label="Ingredient">
        <input class="supp-in mono" data-ing="${i}|amount" value="${r.amount ?? ''}" inputmode="decimal" placeholder="Amount" aria-label="Amount">
        <select class="supp-in" data-ing="${i}|unit" aria-label="Unit">${_suppUnitOptions(r.unit || 'mg')}</select>
        <button type="button" class="del" data-ing-del="${i}" aria-label="Remove ingredient">×</button>
      </div>`).join('')}
      <div class="supp-f-row">
        ${many ? `<button type="button" class="supp-link" data-ing-all>Show all ${s.contents.length} ingredients</button><span class="supp-dim">·</span>` : ''}
        <button type="button" class="supp-link" data-ing-add>+ Add ingredient</button>
      </div>
    </div>

    <div class="supp-f">
      <div class="supp-f-l">Stock</div>
      <div class="supp-f-row">
        <input class="supp-in num" data-f="stock" value="${_esc(s.stock)}" inputmode="numeric" placeholder="—" aria-label="How many left"> ${pl} left · bottle of
        <input class="supp-in num" data-f="bottle" value="${_esc(s.bottle)}" inputmode="numeric" placeholder="—" aria-label="Bottle size">
        ${isNew || !Number(s.bottle) ? '' : `<button type="button" class="supp-btn" data-supp-restock-draft>+${_suppFmtNum(s.bottle)} restocked</button>`}
      </div>
      <div class="supp-hint">Each dose you log takes from this. It shows in “Running low” at ${SUPP_LOW_DAYS} days left. Leave it blank to not track stock.</div>
    </div>

    <div class="supp-f">
      <div class="supp-f-l">Notes</div>
      <textarea class="supp-in" rows="2" data-f="note" placeholder="e.g. Take with food" aria-label="Notes">${_esc(s.note)}</textarea>
    </div>

    ${isNew ? '' : `<div class="supp-f">
      <div class="supp-f-l">Log a past dose</div>
      <div class="supp-past">
        <input class="supp-in" type="date" id="suppPastD" value="${_suppAddDays(c.today, -1)}" max="${c.today}" aria-label="Date">
        <input class="supp-in" type="time" id="suppPastT" value="${(it && it.usual) || '09:00'}" aria-label="Time">
        <span class="supp-stepper"><button type="button" data-supp-pstep="-0.5" aria-label="Less">−</button><input id="suppPastQ" value="${_esc(it ? it.qty : s.qty)}" inputmode="decimal" aria-label="How many"><button type="button" data-supp-pstep="0.5" aria-label="More">+</button></span>
        <button type="button" class="supp-btn" data-supp-past>Log</button>
      </div>
    </div>
    <div class="supp-f"><button type="button" class="supp-link danger" data-supp-delete>Delete supplement…</button></div>`}
  </div>
  <div class="supp-dr-foot">
    ${isNew
      ? `<label><input type="checkbox" id="suppLogNow" checked> Log a dose now</label><span class="grow"></span>
         <button type="button" class="supp-btn" data-supp-close>Cancel</button>
         <button type="button" class="supp-btn primary" data-supp-save ${String(s.name).trim() ? '' : 'disabled'}>Add supplement</button>`
      : `<span class="grow supp-dim">${_suppDirty ? 'Unsaved changes' : 'Edit any field above'}</span>
         <button type="button" class="supp-btn primary" data-supp-save ${_suppDirty && String(s.name).trim() ? '' : 'disabled'}>Save changes</button>`}
    <span class="polish-status supp-page-status" id="suppPageStatus"></span>
  </div>`;
  page.querySelector('.supp-dr-body').scrollTop = scroll;
}

function _suppCycleText(cyc, today) {
  if (!(cyc.on >= 1 && cyc.off >= 1 && cyc.start)) return 'Enter how long each phase lasts.';
  const st = _suppCycleState(cyc, today);
  return cyc.start > today ? `Starts ${_dietFmtDate(cyc.start)}`
    : st.on ? `Today is day ${st.day} of ${st.of} · off from ${_dietFmtDate(st.until)}`
    : `Off today · back on ${_dietFmtDate(st.until)}`;
}

function _suppTouch() {
  _suppDirty = true;
  const page = document.getElementById('suppDrawer');
  const save = page.querySelector('[data-supp-save]');
  if (save) save.disabled = !String(_suppDraft.name).trim();
  const note = page.querySelector('.supp-dr-foot .grow');
  if (note && _suppDraftKey) note.textContent = 'Unsaved changes';
}

function _suppSavePage() {
  const s = _suppDraft, status = document.getElementById('suppPageStatus');
  const name = String(s.name).trim().replace(/\s+/g, ' ');
  if (!name) return showStatus(status, 'Give it a name.', 'var(--warning)');
  const key = _suppKey(name);
  const clash = _suppCatalog().find(x => x.key === key && x.key !== _suppDraftKey);
  if (clash) return showStatus(status, `You already have ${clash.name}.`, 'var(--warning)', 5000);
  const cyc = s.sched === 'cycle' ? s.cycle : null;
  if (cyc && !(cyc.on >= 1 && cyc.off >= 1 && cyc.start)) return showStatus(status, 'Finish the cycle, or pick Every day.', 'var(--warning)', 5000);
  const num = v => v === '' || v == null || isNaN(Number(v)) ? '' : Math.max(0, Number(v));
  const old = _suppDraftKey ? _suppCatalog().find(x => x.key === _suppDraftKey) : null;
  const item = {
    // changing slot (or going as-needed) takes it out of its group: groups stay within one slot
    group: old && _suppGroup(old) === _suppGroup(s) ? old.group : '',
    name, slot: s.slot, sched: s.sched, qty: Math.max(0.5, Number(s.qty) || 1), form: s.form, food: s.food,
    stock: num(s.stock), bottle: num(s.bottle), note: String(s.note || '').trim(), cycle: cyc,
    after: s.after && s.after.key ? { key: s.after.key, min: Math.max(1, Math.round(Number(s.after.min) || 30)) } : null,
    contents: s.contents.map(r => ({
      name: String(r.name || '').trim(),
      amount: r.amount === '' || r.amount == null || isNaN(Number(r.amount)) ? null : Number(r.amount),
      unit: r.unit || 'mg',
    })).filter(r => r.name),
  };
  const isNew = !_suppDraftKey;
  if (old && old.name !== name) _suppRename(_suppDraftKey, name);
  _suppWriteItem(key, item);
  const logNow = isNew && document.getElementById('suppLogNow').checked;
  closeSuppPage(true);
  const undo = logNow && _suppLogDose({ key, name, contents: item.contents }, _dietToday(), _dietNowTime(), item.qty);
  renderSupplements();
  if (undo) _finToast(`Took ${_suppFmtNum(item.qty)} × ${_esc(name)}`, 'Added to your supplements', undo);
}

function _suppLogPast() {
  const it = _suppCatalog().find(x => x.key === _suppDraftKey);
  if (!it) return;
  const d = document.getElementById('suppPastD').value, t = document.getElementById('suppPastT').value;
  const q = Number(document.getElementById('suppPastQ').value) || it.qty;
  if (!d || d > _dietToday()) return showStatus(document.getElementById('suppPageStatus'), 'Pick a date up to today.', 'var(--warning)');
  const undo = _suppLogDose(it, d, t, q);
  _finToast(`Logged ${_suppFmtNum(q)} × ${_esc(it.name)}`, _esc(_suppDayLabel(d) + (t ? ' · ' + _dietFmtTime(t) : '')), undo);
  renderSupplements();
  // An untouched stock field follows what was just taken from it.
  const fresh = _suppCatalog().find(x => x.key === _suppDraftKey);
  if (fresh && String(_suppDraft.stock) === String(it.stock)) _suppDraft.stock = fresh.stock;
  renderSuppPage();
}

// Archive: it leaves the lists, its doses stay in the log. Adding the same name again brings it back.
function _suppDelete() {
  const key = _suppDraftKey, name = _suppDraft.name;
  if (!confirm(`Delete ${name}? Its past doses stay in the log.`)) return;
  const meta = _suppMap(SUPP_META), before = meta[key];
  _suppSaveMap(SUPP_META, { ...meta, [key]: { ...(before || { name }), archived: true } });
  closeSuppPage(true);
  renderSupplements();
  _finToast(`Deleted ${_esc(name)}`, 'Past doses stay in the log', () => {
    const m = { ..._suppMap(SUPP_META) };
    if (before) m[key] = before; else delete m[key];
    _suppSaveMap(SUPP_META, m);
    renderSupplements();
  });
}

function _suppOnPageClick(e) {
  const s = _suppDraft;
  if (!s) return;
  const T = sel => e.target.closest(sel);
  let el;
  if (T('[data-supp-close]')) return closeSuppPage();
  if ((el = T('[data-supp-slot]')))  { s.slot = el.dataset.suppSlot; _suppTouch(); return renderSuppPage(); }
  if ((el = T('[data-supp-food]')))  { s.food = el.dataset.suppFood; _suppTouch(); return renderSuppPage(); }
  if ((el = T('[data-supp-sched]'))) { s.sched = el.dataset.suppSched; _suppTouch(); return renderSuppPage(); }
  if ((el = T('[data-supp-step]')))  { s.qty = Math.max(0.5, (Number(s.qty) || 1) + Number(el.dataset.suppStep)); _suppTouch(); return renderSuppPage(); }
  if ((el = T('[data-supp-pstep]'))) {
    const q = document.getElementById('suppPastQ');
    q.value = Math.max(0.5, (Number(q.value) || 1) + Number(el.dataset.suppPstep));
    return;
  }
  if (T('[data-ing-all]')) { _suppShowAllIng = true; return renderSuppPage(); }
  if (T('[data-ing-add]')) {
    s.contents.push({ name: '', amount: null, unit: 'mg' });
    _suppShowAllIng = true; _suppTouch(); renderSuppPage();
    const ins = document.querySelectorAll('#suppDrawer [data-ing$="|name"]');
    ins[ins.length - 1].focus();
    return;
  }
  if ((el = T('[data-ing-del]'))) { s.contents.splice(Number(el.dataset.ingDel), 1); _suppTouch(); return renderSuppPage(); }
  if (T('[data-supp-scan]'))          return document.getElementById('suppScanFile').click();
  if (T('[data-supp-restock-draft]')) { s.stock = (Number(s.stock) || 0) + (Number(s.bottle) || 0); _suppTouch(); return renderSuppPage(); }
  if (T('[data-supp-past]'))          return _suppLogPast();
  if (T('[data-supp-delete]'))        return _suppDelete();
  if (T('[data-supp-save]'))          return _suppSavePage();
}

function _suppOnPageInput(e) {
  const s = _suppDraft, t = e.target;
  if (!s) return;
  if (t.matches('[data-after-key]')) {
    const min = Number(document.querySelector('#suppDrawer [data-after-min]').value);
    s.after = t.value ? { key: t.value, min: min > 0 ? Math.round(min) : 30 } : null;
    _suppTouch();
    return renderSuppPage();
  }
  if (t.matches('[data-after-min]')) {
    if (s.after && Number(t.value) > 0) s.after.min = Math.round(Number(t.value));
    return _suppTouch();
  }
  if (t.dataset.f) {
    s[t.dataset.f] = t.value;
    _suppTouch();
    if (t.dataset.f === 'form') renderSuppPage();
    return;
  }
  if (t.dataset.ing) {
    const [i, f] = t.dataset.ing.split('|');
    s.contents[i][f] = f === 'amount' ? (t.value === '' ? null : Number(t.value)) : t.value;
    return _suppTouch();
  }
  if (t.matches('[data-cyc], [data-cyc-unit]')) {
    const k = t.dataset.cyc || t.dataset.cycUnit;
    const n = Number(document.querySelector(`#suppDrawer [data-cyc="${k}"]`).value);
    const unit = Number(document.querySelector(`#suppDrawer [data-cyc-unit="${k}"]`).value);
    s.cycle[k] = n > 0 ? Math.round(n * unit) : 0;
  } else if (t.matches('[data-cyc-start]')) s.cycle.start = t.value;
  else return;
  _suppTouch();
  document.getElementById('suppCycStatus').textContent = _suppCycleText(s.cycle, _dietToday());
}


// ── Supplement Facts label → per-pill contents ──
const _SUPP_ROW_RE = /^(.*?[a-z].*?)\s+(\d[\d,]*(?:\.\d+)?)\s*(mcg(?:\s*(?:DFE|RAE))?|µg|ug|mg|g|IU|(?:billion\s*|million\s*)?CFU|mL)\b/i;
const _SUPP_SKIP_RE = /serving|servings|amount\s*per|daily\s*value|calories|other\s*ingredients|supplement\s*facts|^%/i;

// Rows of a Supplement Facts panel: "Vitamin D3 (as cholecalciferol) 25 mcg 125%".
// OCR often splits the name and amount columns into separate lines, so lines
// sharing a baseline are joined left-to-right before matching. Amounts are per
// serving; when the label's serving is N pills they're divided down to one pill.
// `fallbackServing` covers a second photo of the same label that doesn't show
// the serving size line.
function _suppParseLabel(ocr, fallbackServing) {
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
  const perServing = serving ? Number(serving[1]) : (fallbackServing || 1);
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
  return { rows: out, perServing: div, servingFound: !!serving };
}

// Add scanned rows to what's already entered, skipping names already listed
// (overlapping photos) so earlier edits aren't overwritten. Returns how many were added.
function _suppMergeRows(existing, incoming) {
  const have = new Set(existing.map(r => String(r.name || '').trim().toLowerCase()).filter(Boolean));
  const kept = existing.filter(r => String(r.name || '').trim());
  const added = incoming.filter(r => {
    const k = r.name.trim().toLowerCase();
    if (have.has(k)) return false;
    have.add(k);
    return true;
  });
  existing.splice(0, existing.length, ...kept, ...added);
  return added.length;
}

async function suppScan(file) {
  const draft = _suppDraft;
  if (!file || !draft) return;
  const say = (msg, color, ms) => { const el = document.getElementById('suppScanStatus'); if (el) showStatus(el, msg, color, ms); };
  if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/i.test(file.name)) return say('Pick an image file.', 'var(--warning)');
  if (file.size > 20 * 1024 * 1024) return say('Image is over 20 MB — use a smaller photo.', 'var(--warning)', 5000);
  _suppScanning = true;
  renderSuppPage();
  let parsed = null, err = null;
  try {
    const dataUrl = (await _dietNormalizeImage(file)) || (await _dietFileToDataUrl(file));
    parsed = _suppParseLabel(await _dietOcr(dataUrl), _suppScanServing);
    if (!parsed.rows.length) throw new Error("couldn't find ingredient amounts on that label");
  } catch (e) {
    err = e;
    console.error('[supp] label scan failed:', e);
  }
  _suppScanning = false;
  if (_suppDraft !== draft) return;   // page closed or switched meanwhile
  if (err) { renderSuppPage(); return say('Scan failed: ' + (err.message || 'try again') + ' — or type them in.', 'var(--danger)', 9000); }
  if (parsed.servingFound) _suppScanServing = parsed.perServing;
  const n = _suppMergeRows(draft.contents, parsed.rows);
  _suppShowAllIng = true;
  if (n) _suppTouch();
  renderSuppPage();
  say((n ? `Added ${_suppPlural(n, 'ingredient')}` : 'No new ingredients in that photo') +
    (parsed.perServing > 1 ? ` (the label's serving is ${parsed.perServing}, so amounts are per one)` : '') +
    ' — check them, then save.', 'var(--success)', 7000);
}


// ── Listeners ──
document.getElementById('dietViewSupps').addEventListener('click', _suppOnViewClick);
// Drag a row onto another to group them, or onto empty space in its slot to leave its group.
let _suppDragKey = '';
const _suppTodayEl = document.getElementById('suppToday');
const _suppClearDrop = () => _suppTodayEl.querySelectorAll('.drop-on').forEach(x => x.classList.remove('drop-on'));
_suppTodayEl.addEventListener('dragstart', e => {
  const row = e.target.closest && e.target.closest('.supp-row[data-supp-key]');
  if (!row) return;
  _suppDragKey = row.dataset.suppKey;
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', _suppDragKey);
});
_suppTodayEl.addEventListener('dragover', e => {
  if (!_suppDragKey) return;
  e.preventDefault(); _suppClearDrop();
  const row = e.target.closest('.supp-row[data-supp-key]');
  if (row && row.dataset.suppKey !== _suppDragKey) row.classList.add('drop-on');
});
_suppTodayEl.addEventListener('dragend', () => { _suppDragKey = ''; _suppClearDrop(); });
_suppTodayEl.addEventListener('drop', e => {
  if (!_suppDragKey) return;
  e.preventDefault(); _suppClearDrop();
  const key = _suppDragKey; _suppDragKey = '';
  const row = e.target.closest('.supp-row[data-supp-key]');
  if (row) return _suppDropOn(key, row.dataset.suppKey);
  const it = _suppCatalog().find(x => x.key === key), slot = e.target.closest('.supp-slot');
  if (it && it.group && slot && slot.querySelector('.supp-slot-h.' + _suppGroup(it))) _suppSetGroup([key], '', `Removed ${_esc(it.name)} from its group`);
});
document.getElementById('suppDrawer').addEventListener('click', _suppOnPageClick);
document.getElementById('suppDrawer').addEventListener('input', _suppOnPageInput);
document.getElementById('suppDrawer').addEventListener('keydown', e => { if (e.key === 'Escape') closeSuppPage(); });
document.getElementById('suppScrim').addEventListener('click', () => closeSuppPage());
document.getElementById('suppScanFile').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  suppScan(file);
});
// Leaving the tab closes the page so it doesn't sit over another section.
document.querySelectorAll('.tab-btn').forEach(btn => {
  if (btn.dataset.tab !== 'diet') btn.addEventListener('click', () => closeSuppPage(true));
});
