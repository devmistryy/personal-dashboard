// Mobility tab: one list of mobility / stabilizer / postural exercises, each
// tagged morning or night, with a per-week frequency and a starting dose — a
// number of sets, each set measured by a hold time (static stretch) or by reps
// (mobility drill).
//
// From that list the tab COMPILES a weekly schedule (every exercise on exactly
// `frequency` evenly-spread, load-balanced days) and shows today's Morning / Night
// routines as entry-point cards, plus a 7-day overview.
//
// PROGRESSION: the creation dose is only a starting point. Each exercise has a
// dated session log. Doing a routine = opening that session's detail page, where
// each exercise is prefilled from its most recent log entry; tick it done to
// write/update the entry for that date. The dose shown in the routine / list /
// week views is the latest logged dose, falling back to the creation baseline.
// A per-exercise detail page shows baseline → current, a trend, and the full log.
//
// Persistence: the mobility_exercises and mobility_logs tables, via
// _syncMobExercises / _syncMobLog in js/main.js. MEM still holds the flat blob
// shape (mobility_exercises_v1 / mobility_progress:<id>); LOCAL_MODE uses
// localStorage. Deleting an exercise cascades its logs server-side (FK).
//
// Loaded before main.js: this file only declares functions and attaches listeners.

// ── Constants ──
const MOB_SESSIONS     = [['morning', 'Morning'], ['night', 'Night']];
const MOB_MEASURES     = [['hold', 'Hold time'], ['reps', 'Reps']];
const MOB_DAYS         = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MOB_DAYS_LONG    = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MOB_DAY_INITIAL  = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const MOB_DOSE_COLOR   = { hold: '#7FBBFF', reps: '#BCA6FB' };

// ── Store: exercises ──
// MEM keeps the flat blob shape; persistence goes to the mobility_exercises /
// mobility_logs tables (see _syncMobExercises / _syncMobLog in js/main.js).
function getMobExercises()      { return MEM['mobility_exercises_v1'] || []; }
function saveMobExercises(list) { MEM['mobility_exercises_v1'] = list; _syncMobExercises(list); }

// ── Store: per-exercise session log ──
function getMobLog(id) { return MEM['mobility_progress:' + id] || []; }
function saveMobLog(id, list) {
  list.sort((a, b) => a.date.localeCompare(b.date));
  MEM['mobility_progress:' + id] = list;
  _syncMobLog(id, list);
}
// upsert one entry per (exercise, date)
function _mobUpsertEntry(id, date, vals) {
  const log = getMobLog(id).filter(e => e.date !== date);
  log.push({ id: _mobLogId(), date, sets: vals.sets, measure: vals.measure,
             holdSeconds: vals.holdSeconds, reps: vals.reps });
  saveMobLog(id, log);
}
function _mobDeleteEntry(id, date) {
  saveMobLog(id, getMobLog(id).filter(e => e.date !== date));
}
// latest entry with date <= ref (inclusive); null if none
function _mobEntryAsOf(id, ref) {
  const log = getMobLog(id);
  for (let i = log.length - 1; i >= 0; i--) if (log[i].date <= ref) return log[i];
  return null;
}
// dose values to show / prefill "now": last entry ever, else the creation baseline
function _mobCurrent(ex) {
  const e = getMobLog(ex.id).slice(-1)[0];
  return e ? e
    : { sets: ex.sets, measure: ex.measure, holdSeconds: ex.holdSeconds, reps: ex.reps };
}

function _mobId()    { return 's_'  + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function _mobLogId() { return 'mp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── UI state (not persisted) ──
let _mobFormSession = 'morning';
let _mobFormMeasure = 'hold';
let _mobFormFreq    = 3;
let _mobEditId      = null;     // exercise open in the modal for editing, or null
let _mobOpenDay     = null;     // week-grid column expanded, or null
let _mobSessionDate = null;     // 'YYYY-MM-DD' of the open session page
let _mobSessionTod  = 'morning';
let _mobDetailId    = null;     // exercise id open in the detail page, or null


// ── Dose label ──
// sets === 1 reads naturally ("Hold 30s" / "12 reps"); sets > 1 uses the
// compact "3 × 30s" / "3 × 12" form. Takes any {sets, measure, holdSeconds, reps}.
function _mobDose(o) {
  const sets = o.sets > 1 ? o.sets : 1;
  if (o.measure === 'reps') {
    if (!o.reps) return sets > 1 ? `${sets} sets` : 'Reps';
    return sets > 1 ? `${sets} × ${o.reps}` : `${o.reps} reps`;
  }
  if (!o.holdSeconds) return sets > 1 ? `${sets} sets` : 'Hold';
  return sets > 1 ? `${sets} × ${o.holdSeconds}s` : `Hold ${o.holdSeconds}s`;
}
function _mobDoseFor(ex)     { return _mobDose(_mobCurrent(ex)); }
function _mobMeasureClass(o) { return o.measure === 'reps' ? 'reps' : 'hold'; }


// ── Schedule compiler ──

// Weekdays (0 = Mon … 6 = Sun) an exercise of frequency f lands on before any
// balancing rotation. Euclidean / Bresenham spread — as evenly spaced as f allows.
function _mobBaseDays(f) {
  f = Math.max(1, Math.min(7, f | 0));
  const days = [];
  for (let k = 0; k < 7; k++) {
    if (Math.floor((k + 1) * f / 7) > Math.floor(k * f / 7)) days.push(k);
  }
  return days;
}

// Compile the whole list into a 7-day schedule.
//   → { days: [ { morning: [ex], night: [ex] } × 7 ],   // index 0 = Monday
//       dayFor: Map(id → [dayIdx…]) }
function compileMobSchedule(exercises) {
  const days   = Array.from({ length: 7 }, () => ({ morning: [], night: [] }));
  const dayFor = new Map();
  const totals = new Array(7).fill(0);   // exercises placed per day (both sessions)

  const ordered = [...exercises].sort((a, b) =>
    (b.frequency || 1) - (a.frequency || 1) ||
    (a.createdAt || 0) - (b.createdAt || 0));

  ordered.forEach(ex => {
    const base = _mobBaseDays(ex.frequency || 1);

    let bestOff = 0, bestScore = Infinity;
    for (let off = 0; off < 7; off++) {
      const t = totals.slice();
      base.forEach(d => t[(d + off) % 7]++);
      const max  = Math.max(...t);
      const min  = Math.min(...t);
      const mean = t.reduce((s, n) => s + n, 0) / 7;
      const varc = t.reduce((s, n) => s + (n - mean) * (n - mean), 0);
      const score = (max - min) * 100 + varc;
      if (score < bestScore) { bestScore = score; bestOff = off; }
    }

    const placed  = base.map(d => (d + bestOff) % 7).sort((a, b) => a - b);
    const session = ex.session === 'night' ? 'night' : 'morning';
    dayFor.set(ex.id, placed);
    placed.forEach(d => { days[d][session].push(ex); totals[d]++; });
  });

  const cmp = (a, b) =>
    (b.frequency || 1) - (a.frequency || 1) ||
    (a.createdAt || 0) - (b.createdAt || 0);
  days.forEach(d => { d.morning.sort(cmp); d.night.sort(cmp); });

  return { days, dayFor };
}

// Monday-indexed weekday (0 = Mon … 6 = Sun) of an ISO date string.
function _mobDateIdx(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}
function _mobTodayIdx()      { return _mobDateIdx(getActiveDateString()); }
function _mobThisWeekMonday() { const t = getActiveDateString(); return _shiftDay(t, -_mobDateIdx(t)); }


// ── Render: modal form ──
function renderMobForm() {
  const nameEl = document.getElementById('mobName');
  if (!nameEl) return;

  const seg = (opts, active, attr) => opts.map(([v, l]) =>
    `<button class="mob-seg-btn${String(v) === String(active) ? ' active' : ''}" ${attr}="${v}">${l}</button>`).join('');

  document.getElementById('mobSessionBtns').innerHTML = seg(MOB_SESSIONS, _mobFormSession, 'data-mobsession');
  document.getElementById('mobMeasureBtns').innerHTML = seg(MOB_MEASURES, _mobFormMeasure, 'data-mobmeasure');
  document.getElementById('mobFreqBtns').innerHTML    =
    seg([1, 2, 3, 4, 5, 6, 7].map(n => [n, n]), _mobFormFreq, 'data-mobfreq');

  document.getElementById('mobHoldField').hidden = _mobFormMeasure !== 'hold';
  document.getElementById('mobRepsField').hidden = _mobFormMeasure !== 'reps';

  document.getElementById('mobModalTitle').textContent = _mobEditId ? 'Edit exercise' : 'Add exercise';
  document.getElementById('mobAddBtn').textContent     = _mobEditId ? 'Save changes' : '+ Add exercise';
}


// ── Render: today's routine (entry-point cards) ──
function _mobSessionCardHTML(tod, list, date) {
  if (!list.length) {
    return `<div class="empty-state">No ${tod} mobility work scheduled today.</div>`;
  }
  const logged = list.filter(ex => getMobLog(ex.id).some(e => e.date === date)).length;
  const rows = list.map(ex => {
    const cur = _mobCurrent(ex);
    const done = getMobLog(ex.id).some(e => e.date === date);
    return `<div class="mob-scard-row${done ? ' is-logged' : ''}">
      <span>${done ? '<span class="mob-scard-tick">✓</span>' : ''}${_esc(ex.name)}</span>
      <span class="mob-dose mob-dose-${_mobMeasureClass(cur)}">${_esc(_mobDose(cur))}</span>
    </div>`;
  }).join('');
  return `<button class="mob-session-card" type="button" data-mobsession-open="${tod}">
    <div class="mob-scard-items">${rows}</div>
    <div class="mob-scard-foot">
      <span>${logged} of ${list.length} logged</span>
      <span class="mob-scard-go">Open ›</span>
    </div>
  </button>`;
}

function renderMobToday(schedule) {
  const dayEl = document.getElementById('mobTodayDay');
  if (!dayEl) return;

  const idx   = _mobTodayIdx();
  const day   = schedule.days[idx];
  const total = day.morning.length + day.night.length;
  const today = getActiveDateString();

  dayEl.textContent = MOB_DAYS_LONG[idx];
  document.getElementById('mobTodaySub').textContent =
    getMobExercises().length ? `${total} exercise${total === 1 ? '' : 's'} today` : '';
  document.getElementById('mobTodayMorning').innerHTML = _mobSessionCardHTML('morning', day.morning, today);
  document.getElementById('mobTodayNight').innerHTML   = _mobSessionCardHTML('night', day.night, today);
}


// ── Render: week overview ──
function renderMobWeek(schedule) {
  const grid = document.getElementById('mobWeekGrid');
  if (!grid) return;
  const today = _mobTodayIdx();

  grid.innerHTML = schedule.days.map((d, i) => {
    const tot = d.morning.length + d.night.length;
    return `<button class="mob-day${i === today ? ' is-today' : ''}${i === _mobOpenDay ? ' is-open' : ''}${tot ? '' : ' is-empty'}" data-mobday="${i}">
      <span class="mob-day-name">${MOB_DAYS[i]}</span>
      <span class="mob-day-count">${tot || '·'}</span>
      <span class="mob-day-split">${d.morning.length} · ${d.night.length}</span>
    </button>`;
  }).join('');

  const detail = document.getElementById('mobWeekDetail');
  if (_mobOpenDay == null) { detail.hidden = true; detail.innerHTML = ''; return; }

  const d = schedule.days[_mobOpenDay];
  const weekDate = _shiftDay(_mobThisWeekMonday(), _mobOpenDay);
  const col = (tod, label, arr) => `<div class="mob-wd-col">
    <button class="mob-wd-label" type="button" data-mobweek-open="${tod}">${label} <span class="mob-wd-open">open ›</span></button>
    ${arr.length
      ? arr.map(ex => `<div class="mob-wd-row"><span>${_esc(ex.name)}</span><span class="mob-dose mob-dose-${_mobMeasureClass(_mobCurrent(ex))}">${_esc(_mobDoseFor(ex))}</span></div>`).join('')
      : '<div class="mob-wd-empty">—</div>'}
  </div>`;

  detail.hidden = false;
  detail.dataset.weekDate = weekDate;
  detail.innerHTML = `<div class="mob-wd-title">${MOB_DAYS_LONG[_mobOpenDay]}
      <span class="mob-wd-legend">count shown as morning · night</span></div>
    <div class="mob-wd-cols">${col('morning', 'Morning', d.morning)}${col('night', 'Night', d.night)}</div>`;
}


// ── Render: exercise list ──
function renderMobList() {
  const el = document.getElementById('mobList');
  if (!el) return;
  const list = getMobExercises();

  if (!list.length) {
    el.innerHTML = `<div class="empty-state">No exercises yet — add stretches and mobility drills and the
      morning and night routines build themselves from this list.</div>`;
    return;
  }

  const { dayFor } = compileMobSchedule(list);
  const sorted = [...list].sort((a, b) =>
    (a.session === 'night' ? 1 : 0) - (b.session === 'night' ? 1 : 0) ||
    (b.frequency || 1) - (a.frequency || 1) ||
    (a.createdAt || 0) - (b.createdAt || 0));

  el.innerHTML = sorted.map(ex => {
    const placed = dayFor.get(ex.id) || [];
    const dayStr = MOB_DAY_INITIAL.map((ini, i) =>
      `<span class="mob-di${placed.includes(i) ? ' on' : ''}">${ini}</span>`).join('');
    const cur  = _mobCurrent(ex);
    const grew = getMobLog(ex.id).length && _mobDose(cur) !== _mobDose(ex);
    return `<div class="mob-row${ex.id === _mobEditId ? ' is-editing' : ''}">
      <div class="mob-row-main">
        <div class="mob-row-head">
          <button class="mob-row-name" type="button" data-mobdetail="${ex.id}">${_esc(ex.name)}</button>
          <span class="mob-tag mob-tag-${ex.session === 'night' ? 'night' : 'morning'}">${ex.session === 'night' ? 'Night' : 'Morning'}</span>
          <span class="mob-dose mob-dose-${_mobMeasureClass(cur)}">${_esc(_mobDose(cur))}</span>
        </div>
        <div class="mob-row-meta">
          <span class="mob-row-freq">${ex.frequency || 1}× / week</span>
          ${grew ? `<span class="mob-row-from">from ${_esc(_mobDose(ex))}</span>` : ''}
          <span class="mob-row-days">${dayStr}</span>
        </div>
      </div>
      <div class="mob-row-actions">
        <button class="mob-row-btn" data-mobedit="${ex.id}" title="Edit">✎</button>
        <button class="mob-row-btn mob-row-del" data-mobdel="${ex.id}" title="Remove">×</button>
      </div>
    </div>`;
  }).join('');
}


function renderMobility() {
  if (!document.getElementById('tab-mobility')) return;
  const schedule = compileMobSchedule(getMobExercises());
  renderMobForm();
  renderMobToday(schedule);
  renderMobWeek(schedule);
  renderMobList();
}


// ── Session detail page ──

// Rows for a (date, tod): exercises the current compile puts on that weekday+tod
// (minus any created after the date), plus any that already have an entry for
// exactly that date. The compile isn't stable over time, so the entry set is what
// keeps past sessions editable.
function _mobSessionRows(date, tod) {
  const exs   = getMobExercises();
  const idx   = _mobDateIdx(date);
  const sched = compileMobSchedule(exs).days[idx][tod]
    .filter(ex => _localDateStr(new Date(ex.createdAt || 0)) <= date);
  const seen  = new Set(sched.map(e => e.id));
  const extra = exs.filter(ex =>
    (ex.session === 'night' ? 'night' : 'morning') === tod &&
    !seen.has(ex.id) &&
    getMobLog(ex.id).some(e => e.date === date));
  return [...sched, ...extra];
}

function openMobSession(date, tod) {
  _mobSessionDate = date;
  _mobSessionTod  = tod === 'night' ? 'night' : 'morning';
  renderMobSession();
  const p = document.getElementById('mobSessionPage');
  p.scrollTop = 0;
  p.classList.add('open');
  _mobLockBody();
}
function closeMobSession() {
  document.getElementById('mobSessionPage').classList.remove('open');
  _mobUnlockBodyIfClear();
}

function renderMobSession() {
  const body = document.getElementById('mobSessionBody');
  if (!body || !_mobSessionDate) return;
  const date = _mobSessionDate, tod = _mobSessionTod;
  const rows = _mobSessionRows(date, tod);
  const logged = rows.filter(ex => getMobLog(ex.id).some(e => e.date === date)).length;

  const prevDisabled = date <= _dayDetailFloor();
  const nextDisabled = date >= getActiveDateString();

  const todBtns = MOB_SESSIONS.map(([v, l]) =>
    `<button class="mob-seg-btn${v === tod ? ' active' : ''}" data-mobtod="${v}">${l}</button>`).join('');

  const rowsHTML = rows.length ? rows.map(ex => {
    const pre  = _mobEntryAsOf(ex.id, date) || { sets: ex.sets, holdSeconds: ex.holdSeconds, reps: ex.reps };
    const done = getMobLog(ex.id).some(e => e.date === date);
    const doseField = ex.measure === 'reps'
      ? `<label class="mob-srow-f">reps <input type="number" min="1" step="1" data-mobf="reps" data-ex="${ex.id}" value="${pre.reps != null ? pre.reps : ''}"></label>`
      : `<label class="mob-srow-f">hold <input type="number" min="1" step="5" data-mobf="hold" data-ex="${ex.id}" value="${pre.holdSeconds != null ? pre.holdSeconds : ''}"><span>s</span></label>`;
    return `<div class="mob-srow${done ? ' is-logged' : ''}">
      <label class="habit-cb-wrap">
        <input type="checkbox" data-mobrowcheck="${ex.id}"${done ? ' checked' : ''}>
        <span class="habit-cb-box"></span>
      </label>
      <div class="mob-srow-body">
        <button class="mob-srow-name" type="button" data-mobdetail="${ex.id}">${_esc(ex.name)}</button>
        <div class="mob-srow-inputs">
          <label class="mob-srow-f">sets <input type="number" min="1" step="1" data-mobf="sets" data-ex="${ex.id}" value="${pre.sets || 1}"></label>
          ${doseField}
        </div>
      </div>
    </div>`;
  }).join('') : `<div class="empty-state">Nothing scheduled for this session.</div>`;

  body.innerHTML = `
    <div class="day-detail-head">
      <button class="hcal-nav-btn" id="mobSessionPrev"${prevDisabled ? ' disabled' : ''}>‹</button>
      <h2 class="habit-detail-name day-detail-date">${_fullDateLabel(date)}</h2>
      <button class="hcal-nav-btn" id="mobSessionNext"${nextDisabled ? ' disabled' : ''}>›</button>
    </div>
    <div class="mob-session-sub">
      <div class="mob-seg" id="mobSessionTodBtns">${todBtns}</div>
      <span class="mob-session-count">${rows.length ? `${logged} of ${rows.length} logged` : ''}</span>
    </div>
    <div class="mob-srow-list">${rowsHTML}</div>
  `;
}


// ── Per-exercise detail page ──
function openMobExerciseDetail(id) {
  _mobDetailId = id;
  renderMobExerciseDetail();
  const p = document.getElementById('mobExerciseDetailPage');
  p.scrollTop = 0;
  p.classList.add('open');
  _mobLockBody();
}
function closeMobExerciseDetail() {
  document.getElementById('mobExerciseDetailPage').classList.remove('open');
  _mobDetailId = null;
  _mobUnlockBodyIfClear();
}

function _mobChangeLabel(ex, log) {
  if (!log.length) return '–';
  const last = log[log.length - 1];
  const baseVal = last.measure === 'reps' ? ex.reps : ex.holdSeconds;
  const curVal  = last.measure === 'reps' ? last.reps : last.holdSeconds;
  if (!baseVal || !curVal || ex.measure !== last.measure) return '—';
  const d   = curVal - baseVal;
  const pct = Math.round(d / baseVal * 100);
  const unit = last.measure === 'reps' ? (Math.abs(d) === 1 ? ' rep' : ' reps') : 's';
  return d === 0 ? 'no change' : `${d > 0 ? '+' : ''}${d}${unit} (${pct > 0 ? '+' : ''}${pct}%)`;
}

function renderMobExerciseDetail() {
  const body = document.getElementById('mobExDetailBody');
  if (!body || !_mobDetailId) return;
  const ex = getMobExercises().find(x => x.id === _mobDetailId);
  if (!ex) { closeMobExerciseDetail(); return; }

  const log     = getMobLog(ex.id);
  const baseline = { sets: ex.sets, measure: ex.measure, holdSeconds: ex.holdSeconds, reps: ex.reps };
  const dots    = MOB_DAY_INITIAL.map((ini, i) => {
    const placed = (compileMobSchedule(getMobExercises()).dayFor.get(ex.id) || []).includes(i);
    return `<span class="mob-di${placed ? ' on' : ''}">${ini}</span>`;
  }).join('');

  const trend = (() => {
    const recent = log.slice(-12);
    if (recent.length < 2) return '';
    const vals = recent.map(e => e.measure === 'reps' ? (e.reps || 0) : (e.holdSeconds || 0));
    const max  = Math.max(...vals, 1);
    const fmtD = ds => { const [y, m, d] = ds.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    return `<div class="habit-detail-section-title">Trend</div>
      <div class="mob-trend">${recent.map((e, i) => `
        <div class="diet-bar-row">
          <div class="diet-bar-head">
            <span class="diet-bar-label">${fmtD(e.date)}</span>
            <span class="diet-bar-val">${_esc(_mobDose(e))}</span>
          </div>
          <div class="diet-bar"><div class="diet-bar-fill" style="width:${Math.round(vals[i] / max * 100)}%;background:${MOB_DOSE_COLOR[e.measure] || MOB_DOSE_COLOR.hold}"></div></div>
        </div>`).join('')}</div>`;
  })();

  const logList = log.length
    ? [...log].reverse().map(e => `
        <div class="area-note-entry mob-logrow" data-mob-logdate="${e.date}">
          <div class="hd-note-head">
            <span class="area-note-date">${_fullDateLabel(e.date)}</span>
            <button class="hd-note-del" data-mobdel-entry="${e.date}" title="Delete entry" aria-label="Delete entry">×</button>
          </div>
          <div class="area-note-body mob-logrow-dose">${_esc(_mobDose(e))}</div>
        </div>`).join('')
    : '<div class="area-detail-empty">No sessions logged yet.</div>';

  body.innerHTML = `
    <div class="mob-exd-head">
      <h2 class="habit-detail-name" style="margin:0;flex:1;">${_esc(ex.name)}</h2>
      <button class="mob-row-btn" id="mobExEdit" title="Edit exercise">✎ Edit</button>
    </div>
    <div class="mob-exd-meta">
      <span class="mob-tag mob-tag-${ex.session === 'night' ? 'night' : 'morning'}">${ex.session === 'night' ? 'Night' : 'Morning'}</span>
      <span class="mob-row-freq">${ex.frequency || 1}× / week</span>
      <span class="mob-row-days">${dots}</span>
    </div>

    <div class="habit-detail-stats-grid">
      <div class="habit-stat-card">
        <div class="habit-stat-val mob-stat-dose">${_esc(_mobDose(baseline))}</div>
        <div class="habit-stat-label">Started</div>
      </div>
      <div class="habit-stat-card">
        <div class="habit-stat-val mob-stat-dose">${_esc(_mobDoseFor(ex))}</div>
        <div class="habit-stat-label">Current</div>
      </div>
      <div class="habit-stat-card">
        <div class="habit-stat-val mob-stat-dose">${_esc(_mobChangeLabel(ex, log))}</div>
        <div class="habit-stat-label">Change</div>
      </div>
    </div>

    ${trend}

    <div class="habit-detail-section-title">Session log</div>
    <div class="hd-notes-list">${logList}</div>

    <div class="mob-exd-danger">
      <button class="area-detail-delete-btn" id="mobExDelete">Delete exercise</button>
    </div>
  `;
}


// ── Modal ──
function openMobModal() {
  renderMobForm();
  const modal = document.getElementById('mobModal');
  modal.classList.add('open');
  modal.querySelector('.sr-modal-card').scrollTop = 0;
  _mobLockBody();
  document.getElementById('mobFormStatus').textContent = '';
  setTimeout(() => document.getElementById('mobName').focus(), 0);
}

function closeMobModal() {
  document.getElementById('mobModal').classList.remove('open');
  _mobClearForm();
  _mobUnlockBodyIfClear();
  renderMobility();
  if (document.getElementById('mobExerciseDetailPage').classList.contains('open')) renderMobExerciseDetail();
  if (document.getElementById('mobSessionPage').classList.contains('open'))       renderMobSession();
}


// ── Form actions ──
function _mobReadForm() {
  const numOrNull = id => { const v = Number(document.getElementById(id).value); return v > 0 ? Math.round(v) : null; };
  const data = {
    name: document.getElementById('mobName').value.trim(),
    session: _mobFormSession === 'night' ? 'night' : 'morning',
    measure: _mobFormMeasure === 'reps' ? 'reps' : 'hold',
    sets: Math.max(1, Math.round(Number(document.getElementById('mobSets').value) || 1)),
    frequency: Math.max(1, Math.min(7, Number(_mobFormFreq) || 3)),
    holdSeconds: null, reps: null,
  };
  if (data.measure === 'hold') data.holdSeconds = numOrNull('mobHold');
  else data.reps = numOrNull('mobReps');
  return data;
}

function _mobClearForm() {
  document.getElementById('mobName').value = '';
  document.getElementById('mobHold').value = '';
  document.getElementById('mobReps').value = '';
  document.getElementById('mobSets').value = '1';
  _mobEditId = null;
  _mobFormSession = 'morning';
  _mobFormMeasure = 'hold';
  _mobFormFreq = 3;
}

function submitMobForm() {
  const status = document.getElementById('mobFormStatus');
  const data = _mobReadForm();
  if (!data.name) { showStatus(status, 'Give the exercise a name first.', 'var(--warning)'); return; }

  const list = getMobExercises();
  if (_mobEditId) {
    const i = list.findIndex(x => x.id === _mobEditId);
    if (i !== -1) list[i] = { ...list[i], ...data };
  } else {
    list.push({ id: _mobId(), createdAt: Date.now(), ...data });
  }
  saveMobExercises(list);
  closeMobModal();
}

function editMobExercise(id) {
  const ex = getMobExercises().find(x => x.id === id);
  if (!ex) return;
  _mobEditId = id;
  _mobFormSession = ex.session === 'night' ? 'night' : 'morning';
  _mobFormMeasure = ex.measure === 'reps' ? 'reps' : 'hold';
  _mobFormFreq    = ex.frequency || 3;
  document.getElementById('mobName').value = ex.name || '';
  document.getElementById('mobSets').value = ex.sets || 1;
  document.getElementById('mobHold').value = ex.holdSeconds || '';
  document.getElementById('mobReps').value = ex.reps || '';
  openMobModal();
}

function deleteMobExercise(id) {
  const ex = getMobExercises().find(x => x.id === id);
  if (!ex || !confirm(`Remove "${ex.name}"? Its session log is deleted too.`)) return;
  delete MEM['mobility_progress:' + id];   // drop the log before the save that persists MEM
  saveMobExercises(getMobExercises().filter(x => x.id !== id));   // DB log rows go via FK on delete cascade
  if (_mobEditId === id) _mobClearForm();
  if (_mobDetailId === id) closeMobExerciseDetail();
  renderMobility();
  if (document.getElementById('mobSessionPage').classList.contains('open')) renderMobSession();
}


// ── Body-scroll lock (shared across modal + two slide-in pages) ──
function _mobLockBody() { document.body.style.overflow = 'hidden'; }
function _mobUnlockBodyIfClear() {
  if (!document.querySelector('.habit-detail-page.open') && !document.querySelector('.sr-modal.open')) {
    document.body.style.overflow = '';
  }
}


// ── Session row: read the inputs, commit / auto-save ──
function _mobReadSrow(exId) {
  const ex = getMobExercises().find(x => x.id === exId);
  if (!ex) return null;
  const q = f => document.querySelector(`#mobSessionBody [data-mobf="${f}"][data-ex="${exId}"]`);
  const n = (el, fb) => { const v = Math.round(Number(el && el.value)); return v > 0 ? v : fb; };
  const out = { sets: n(q('sets'), 1), measure: ex.measure, holdSeconds: null, reps: null };
  if (ex.measure === 'reps') out.reps = n(q('reps'), ex.reps || 1);
  else out.holdSeconds = n(q('hold'), ex.holdSeconds || 1);
  return out;
}


// ── Listeners ──
const _mobPanel = document.getElementById('tab-mobility');
const _mobModal = document.getElementById('mobModal');
const _mobSessionPage = document.getElementById('mobSessionPage');
const _mobExDetailPage = document.getElementById('mobExerciseDetailPage');

// Tab panel: week grid, add button, exercise name → detail, edit / delete, session cards.
_mobPanel.addEventListener('click', e => {
  const day = e.target.closest('[data-mobday]');
  if (day) {
    const i = Number(day.dataset.mobday);
    _mobOpenDay = _mobOpenDay === i ? null : i;
    renderMobWeek(compileMobSchedule(getMobExercises()));
    return;
  }

  const wk = e.target.closest('[data-mobweek-open]');
  if (wk) {
    const wd = document.getElementById('mobWeekDetail').dataset.weekDate;
    if (wd) openMobSession(wd, wk.dataset.mobweekOpen);
    return;
  }

  const so = e.target.closest('[data-mobsession-open]');
  if (so) { openMobSession(getActiveDateString(), so.dataset.mobsessionOpen); return; }

  if (e.target.id === 'mobOpenAddBtn') { _mobClearForm(); openMobModal(); return; }

  const ed = e.target.closest('[data-mobedit]');
  if (ed) { editMobExercise(ed.dataset.mobedit); return; }

  const del = e.target.closest('[data-mobdel]');
  if (del) { deleteMobExercise(del.dataset.mobdel); return; }

  const det = e.target.closest('[data-mobdetail]');
  if (det) { openMobExerciseDetail(det.dataset.mobdetail); return; }
});

// Modal: segmented controls, submit, close.
_mobModal.addEventListener('click', e => {
  const s = e.target.closest('[data-mobsession]');
  if (s) { _mobFormSession = s.dataset.mobsession; renderMobForm(); return; }

  const m = e.target.closest('[data-mobmeasure]');
  if (m) { _mobFormMeasure = m.dataset.mobmeasure; renderMobForm(); return; }

  const f = e.target.closest('[data-mobfreq]');
  if (f) { _mobFormFreq = Number(f.dataset.mobfreq); renderMobForm(); return; }

  if (e.target.id === 'mobAddBtn')     { submitMobForm(); return; }
  if (e.target.id === 'mobModalClose') { closeMobModal(); return; }
  if (e.target.id === 'mobModal')      { closeMobModal(); return; }   // backdrop
});

_mobModal.addEventListener('keydown', e => {
  if (e.key === 'Enter' && ['mobName', 'mobSets', 'mobHold', 'mobReps'].includes(e.target.id)) {
    e.preventDefault();
    submitMobForm();
  }
});

// Session page.
_mobSessionPage.addEventListener('click', e => {
  if (e.target.id === 'mobSessionBack') { closeMobSession(); return; }

  const tod = e.target.closest('[data-mobtod]');
  if (tod) { _mobSessionTod = tod.dataset.mobtod; renderMobSession(); return; }

  if (e.target.id === 'mobSessionPrev' && !e.target.disabled) {
    _mobSessionDate = _shiftDay(_mobSessionDate, -1);
    _mobSessionPage.scrollTop = 0; renderMobSession(); return;
  }
  if (e.target.id === 'mobSessionNext' && !e.target.disabled) {
    _mobSessionDate = _shiftDay(_mobSessionDate, 1);
    _mobSessionPage.scrollTop = 0; renderMobSession(); return;
  }

  const det = e.target.closest('[data-mobdetail]');
  if (det) { openMobExerciseDetail(det.dataset.mobdetail); return; }
});

_mobSessionPage.addEventListener('change', e => {
  const date = _mobSessionDate;

  const chk = e.target.closest('[data-mobrowcheck]');
  if (chk) {
    const exId = chk.dataset.mobrowcheck;
    if (chk.checked) {
      const vals = _mobReadSrow(exId);
      if (vals) _mobUpsertEntry(exId, date, vals);
    } else {
      if (date !== getActiveDateString() && !confirm("Remove this session's log entry?")) {
        chk.checked = true; return;
      }
      _mobDeleteEntry(exId, date);
    }
    renderMobSession();
    renderMobility();
    if (_mobDetailId === exId && _mobExDetailPage.classList.contains('open')) renderMobExerciseDetail();
    return;
  }

  const fld = e.target.closest('[data-mobf]');
  if (fld) {
    const exId = fld.dataset.ex;
    if (!getMobLog(exId).some(en => en.date === date)) return;   // not committed — wait for the tick
    const vals = _mobReadSrow(exId);
    if (vals) _mobUpsertEntry(exId, date, vals);
    renderMobSession();
    renderMobility();
    if (_mobDetailId === exId && _mobExDetailPage.classList.contains('open')) renderMobExerciseDetail();
  }
});

// Exercise detail page.
_mobExDetailPage.addEventListener('click', e => {
  if (e.target.id === 'mobExDetailBack') { closeMobExerciseDetail(); return; }
  if (e.target.id === 'mobExEdit')       { editMobExercise(_mobDetailId); return; }
  if (e.target.id === 'mobExDelete')     { deleteMobExercise(_mobDetailId); return; }

  const delEntry = e.target.closest('[data-mobdel-entry]');
  if (delEntry) {
    if (!confirm('Delete this session entry?')) return;
    _mobDeleteEntry(_mobDetailId, delEntry.dataset.mobdelEntry);
    renderMobExerciseDetail();
    renderMobility();
    return;
  }

  const logrow = e.target.closest('[data-mob-logdate]');
  if (logrow) {
    const ex = getMobExercises().find(x => x.id === _mobDetailId);
    if (ex) openMobSession(logrow.dataset.mobLogdate, ex.session);
    return;
  }
});

// One Escape handler for all three mobility overlays — close the topmost only.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (_mobModal.classList.contains('open'))          { closeMobModal(); return; }
  if (_mobExDetailPage.classList.contains('open'))   { closeMobExerciseDetail(); return; }
  if (_mobSessionPage.classList.contains('open'))    { closeMobSession(); return; }
});

// Re-render when the tab is opened (mirrors the Diet / Areas tabs).
document.querySelectorAll('.tab-btn').forEach(btn => {
  if (btn.dataset.tab === 'mobility') btn.addEventListener('click', renderMobility);
});
