// Mobility tab: one list of mobility / stabilizer / postural exercises, each
// tagged morning or night, with a per-week frequency and a starting dose — a
// number of sets, each set measured by a hold time (static stretch) or by reps
// (mobility drill).
//
// From that list the tab COMPILES a schedule: frequency is a pace, not fixed
// weekdays. Each exercise starts on evenly-spread, load-balanced days; a missed
// session moves to the next day that keeps the pattern's rest spacing, and the
// debt is worked off over the following weeks, spread to keep days even (see _mobSimulate). The tab shows
// today's Morning / Night routines as entry-point cards, plus a 7-day overview.
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
// 'dose' exercises grow their hold time / reps; 'fixed' ones (e.g. child's pose)
// stay at the same dose — no bump nudges, no gains.
const MOB_PROGRESS     = [['dose', 'Increase over time'], ['fixed', 'Keep the same']];

// ── Store: exercises ──
// MEM keeps the flat blob shape; persistence goes to the mobility_exercises /
// mobility_logs tables (see _syncMobExercises / _syncMobLog in js/main.js).
function getMobExercises()      { return MEM['mobility_exercises_v1'] || []; }
function saveMobExercises(list) { MEM['mobility_exercises_v1'] = list; _mobSchedMemo = null; _syncMobExercises(list); }

// ── Store: per-exercise session log ──
function getMobLog(id) { return MEM['mobility_progress:' + id] || []; }
function saveMobLog(id, list) {
  list.sort((a, b) => a.date.localeCompare(b.date));
  MEM['mobility_progress:' + id] = list;
  _syncMobLog(id, list);
}

// ── Link to Habits ──
// The premade Morning / Night Mobility habits (h_mob_<session>, see HABIT_PREMADE)
// tick for a day once any exercise in that session is logged, and untick when none is.
// Manual ticking in Habits is untouched. Sessions are independent.
// One-time: sessions that already have exercises get their habit switched on.
function _mobBackfillHabits() {
  if (MEM['habit_premade_backfill_v1']) return;
  getMobExercises().forEach(ex => _activatePremade('h_mob_' + (ex.session === 'night' ? 'night' : 'morning')));
  MEM['habit_premade_backfill_v1'] = true; _syncSetting('habit_premade_backfill_v1', true);
}
let _mobSchedMemo = null;
function _mobSchedFor(list, today) {
  if (!_mobSchedMemo || _mobSchedMemo.list !== list || _mobSchedMemo.today !== today)
    _mobSchedMemo = { list, today, sched: compileMobSchedule(list) };
  return _mobSchedMemo.sched;
}
// A session that has exercises but none due (or logged) that day: its habit sits out.
function _mobSessionOff(tod, date) {
  const list = getMobExercises();
  const mine = list.filter(ex => (ex.session === 'night' ? 'night' : 'morning') === tod);
  if (!mine.length) return false;
  // Before the session's first exercise existed nothing could be due, so the
  // habit stays an ordinary day (markable, missable) rather than sitting out.
  if (date < mine.reduce((m, ex) => { const s = _mobMade(ex); return s < m ? s : m; }, '9999-99-99')) return false;
  return !_mobSessionRows(date, tod, _mobSchedFor(list, getActiveDateString())).length;
}
function _mobSyncHabits(date) {
  const habits = getHabits(), list = getMobExercises();
  let changed = false;
  MOB_SESSIONS.forEach(([tod]) => {
    const hid = 'h_mob_' + tod;
    if (!habits.some(h => h.id === hid)) return;
    const any = list.some(ex => (ex.session === 'night' ? 'night' : 'morning') === tod && _mobLoggedOn(ex.id, date));
    const log = getHabitLog(date);
    if (any !== log.includes(hid)) { saveHabitLog(date, any ? [...log, hid] : log.filter(x => x !== hid)); changed = true; }
  });
  if (changed && typeof renderHabits === 'function') renderHabits();
}
// upsert one entry per (exercise, date)
function _mobUpsertEntry(id, date, vals) {
  const log = getMobLog(id).filter(e => e.date !== date);
  log.push({ id: _mobLogId(), date, sets: vals.sets, measure: vals.measure,
             holdSeconds: vals.holdSeconds, reps: vals.reps,
             setValues: vals.setValues || null, note: vals.note || '' });
  saveMobLog(id, log);
  _mobSyncHabits(date);
}
function _mobDeleteEntry(id, date) {
  saveMobLog(id, getMobLog(id).filter(e => e.date !== date));
  _mobSyncHabits(date);
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

// ── Archive ──
// Settings key mobility_archive_v1: id → { at: date } while archived, { resumed: date }
// once back. An archived exercise is off the schedule from its archive day on (no
// due days, so no misses) — the date can be set back, as far as the day it was
// added, to clear misses from when it couldn't be done. Days before it keep their
// history, and the log is kept. One that comes back is scheduled from that day,
// with no backlog for the time it was away.
function _mobArch(id)        { return (MEM['mobility_archive_v1'] || {})[id] || null; }
function _mobIsArchived(ex)  { return !!_mobArch(ex.id)?.at; }
function _mobMade(ex) { return _localDateStr(new Date(ex.createdAt || 0)); }
// First day an exercise is on the schedule: when it was added, or when it last came back.
function _mobStart(ex) {
  const made = _mobMade(ex), back = _mobArch(ex.id)?.resumed;
  return back && back > made ? back : made;
}
// A comeback only stays on record if it was before the new archive day; archiving
// back past it means the exercise was never really back.
function _mobStoreArchive(ids, on, date) {
  const all = { ...(MEM['mobility_archive_v1'] || {}) };
  ids.forEach(id => {
    const back = all[id]?.resumed;
    all[id] = !on ? { resumed: date } : back && back < date ? { at: date, resumed: back } : { at: date };
  });
  MEM['mobility_archive_v1'] = all; _syncSetting('mobility_archive_v1', all);
}
function setMobArchived(ids, on) {
  _mobStoreArchive(ids, on, getActiveDateString());
  renderMobility();
  if (_mobDetailId) renderMobExerciseDetail();
  if (document.getElementById('mobSessionPage').classList.contains('open')) renderMobSession();
}

// Archive-date picker (archived list row, exercise detail page): any day from when
// the exercise was added up to today.
function _mobArchDateInput(ex) {
  return `<input type="date" class="mob-arch-date" data-mobarch-date="${ex.id}" value="${_mobArch(ex.id).at}"
    min="${_mobMade(ex)}" max="${getActiveDateString()}" title="Day it came off the schedule">`;
}
function _mobOnArchDate(e) {
  const id = e.target.dataset.mobarchDate;
  const ex = id && getMobExercises().find(x => x.id === id);
  const v = e.target.value;
  if (!ex || !v) return;   // mid-edit (a part of the date cleared)
  const lo = _mobMade(ex), hi = getActiveDateString(), at = v < lo ? lo : v > hi ? hi : v;
  if (at !== v) e.target.value = at;
  _mobStoreArchive([id], true, at);
  // Redraw around the field, not the field itself — the date input fires on every
  // keystroke, and replacing it would drop focus mid-edit.
  const schedule = compileMobSchedule(getMobExercises());
  renderMobToday(schedule); renderMobWeek(schedule); renderMobRail(schedule);
  if (!e.target.closest('#mobList')) renderMobList();   // edited on the detail page: refresh the list behind it
}

function _mobId()    { return 's_'  + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function _mobLogId() { return 'mp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── UI state (not persisted) ──
let _mobFormSession = 'morning';
let _mobFormMeasure = 'hold';
let _mobFormFreq    = 3;
let _mobFormProgress = 'dose';
let _mobDraft       = null;     // unsaved edits on the exercise detail page
let _mobOpenDay     = null;     // week-strip day selected, or null for today
let _mobWeekOff     = 0;        // week strip: weeks from this one (negative = past)
let _mobArchOpen    = false;    // archived section expanded
let _mobSessionDate = null;     // 'YYYY-MM-DD' of the open session page
let _mobSessionTod  = 'morning';
let _mobDetailId    = null;     // exercise id open in the detail page, or null
let _mobFilter      = 'all';    // list filter: 'all' | 'morning' | 'night'
let _mobQuery       = '';       // list search text


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


// ── Name shortcuts ──
// "Couch stretch 2x60s night 4/wk #hips fixed" → { name: 'Couch stretch', fields: {...} }.
// The first word is always name, so "Night walk" stays a name.
function _mobParseName(str) {
  const f = {};
  const m0 = String(str || '').match(/^\s*\S+/);
  if (!m0) return { name: '', fields: f };
  let rest = ' ' + str.slice(m0[0].length) + ' ';
  const take = (re, fn) => { rest = rest.replace(re, (...m) => { fn(m); return ' '; }); };
  take(/\s(\d+)\s*[x×]\s*(\d+)\s*(s|secs?)?(?=\s)/i, m => {
    f.sets = +m[1];
    if (m[3]) { f.measure = 'hold'; f.holdSeconds = +m[2]; } else { f.measure = 'reps'; f.reps = +m[2]; }
  });
  take(/\s(\d+)\s*(?:s|secs?)(?=\s)/i, m => { f.measure = 'hold'; f.holdSeconds = +m[1]; });
  take(/\s(\d+)\s*reps?(?=\s)/i,      m => { f.measure = 'reps'; f.reps = +m[1]; });
  take(/\s(?:am|morning)(?=\s)/i,       () => { f.session = 'morning'; });
  take(/\s(?:pm|night)(?=\s)/i,         () => { f.session = 'night'; });
  take(/\s([1-7])\s*\/\s*w(?:k|eek)?(?=\s)/i, m => { f.frequency = +m[1]; });
  take(/\s#(\S+)(?=\s)/,                m => { f.group = m[1]; });
  take(/\sfixed(?=\s)/i,                 () => { f.progress = 'fixed'; });
  return { name: (m0[0] + rest).replace(/\s+/g, ' ').trim(), fields: f };
}


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

// Spacing limits of frequency f's own weekly pattern: the shortest gap between
// sessions and the longest run of back-to-back days. Catch-up never goes tighter.
// ponytail: 1×/wk would need a 7-day gap and could never recover a late session, so it's capped at 5.
function _mobSpacing(f) {
  const b = _mobBaseDays(f);
  const gaps = b.map((d, i) => (b[(i + 1) % b.length] - d + 7) % 7 || 7);
  let run = 0, maxRun = 0;
  for (let k = 0; k < 14; k++) { run = b.includes(k % 7) ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
  return { minGap: Math.min(5, ...gaps), maxRun: b.length === 7 ? Infinity : maxRun };
}

// Due dates for every unit (one exercise or a group), simulated together day by
// day. Frequency is a pace, not fixed weekdays: credit builds f/7 of a session a
// day (kept in sevenths), a session is due once a whole one has built up and the
// pattern's spacing allows it, and doing one spends it. A missed day moves to the
// next day that keeps its rest gap and the debt is worked off over the following
// weeks (capped at one week's worth; one early session is banked). Credit starts
// in the template's phase (weekday offset `off`), so perfect adherence lands on
// the template days.
// Load stays even: a unit on its template day always goes (the template is
// balanced), but catch-up sessions only fill a day up to `cap` exercises — most
// overdue first — so units that fell behind together spread out instead of moving
// in lockstep. A single exercise may go one over, so one missed exercise can come
// back the next day even when that day is already full; a group may not (moving
// a whole block early empties a later day).
// Days before today count what was logged; today on assumes each due session gets done.
//   units: [{ f, off, from, until?, logged: Set(date), tod: 'morning'|'night', n: exercises in it }]
//   (`until`: archive day — the unit is off the schedule from then on)
//   → per unit { due: Set(date), carried: Set(date), spare: Set(date) } — `carried`
//     are due days that only re-offer an earlier undone session (no new one came
//     due), so leaving one undone isn't another miss; `spare` are days a make-up
//     was allowed by its rest spacing but held back because the day was full —
//     offered as optional extras.
function _mobSimulate(units, to, today, cap = { morning: Infinity, night: Infinity }) {
  const st = units.map(u => {
    const f = Math.max(1, Math.min(7, u.f | 0));
    // c: owed credit (clamped); ph: the same pace unclamped, marking when a new session comes due.
    const c = (_mobDateIdx(u.from) - u.off + 7) % 7 * f % 7;
    return { u, f, ..._mobSpacing(f), c, ph: c, since: Infinity, run: 0, fresh: 0, due: new Set(), carried: new Set(), spare: new Set() };
  });
  const from = units.map(u => u.from).sort()[0];
  for (let d = from; d <= to; d = _shiftDay(d, 1)) {
    const live = st.filter(s => s.u.from <= d && !(s.u.until <= d));
    const load = { morning: 0, night: 0 }, catchUp = [];
    const pick = s => { s.due.add(d); if (s.fresh) s.fresh--; else s.carried.add(d); load[s.u.tod] += s.u.n; };
    live.forEach(s => {
      s.ph += s.f;
      const onDay = s.ph >= 7;
      if (onDay) { s.ph -= 7; s.fresh = Math.min(s.f, s.fresh + 1); }
      s.c += s.f; s.since++;
      if (s.c >= 7 && s.since >= s.minGap && (s.since > 1 || s.run < s.maxRun)) (onDay ? pick(s) : catchUp.push(s));
    });
    catchUp.sort((a, b) => b.c - a.c || b.since - a.since)
      .forEach(s => { if (load[s.u.tod] + s.u.n <= cap[s.u.tod] + (s.u.n === 1)) pick(s); else s.spare.add(d); });
    live.forEach(s => {
      if (s.u.logged.has(d) || (s.due.has(d) && d >= today)) { s.run = s.since === 1 ? s.run + 1 : 1; s.since = 0; s.c -= 7; }
      s.c = Math.max(-7, Math.min(7 * s.f, s.c));
    });
  }
  return st.map(s => ({ due: s.due, carried: s.carried, spare: s.spare }));
}

// Compile the whole list into due dates per exercise, through the end of this week
// (or of the future week the strip is showing).
//   → { due, carried, spare: Map(id → Set('YYYY-MM-DD')) }  (see _mobSimulate)
// The weekly template (evenly-spread, load-balanced weekdays) sets each unit's
// phase and the per-day load cap; _mobSimulate moves sessions around misses from there.
function compileMobSchedule(exercises) {
  const due = new Map(), carried = new Map(), spare = new Map();
  const today = getActiveDateString(), end = _shiftDay(_mobThisWeekMonday(), 7 * Math.max(0, _mobWeekOff) + 6);
  // ponytail: simulate at most ~14 months back; older history only matters to a very long streak.
  const floor = _shiftDay(today, -420);
  // Exercises placed per day, per session — balanced separately so morning and
  // night each stay even (a combined total let 5 morning + 1 night pass as "6").
  const totals = { morning: new Array(7).fill(0), night: new Array(7).fill(0) };
  const sessOf = ex => ex.session === 'night' ? 'night' : 'morning';
  const spread = t => {
    const mean = t.reduce((s, n) => s + n, 0) / 7;
    return (Math.max(...t) - Math.min(...t)) * 100 + t.reduce((s, n) => s + (n - mean) * (n - mean), 0);
  };

  // A group is scheduled as one unit; ungrouped exercises are units of one.
  // ponytail: members inherit the group's highest frequency; per-member frequency is ignored while grouped.
  const byGroup = new Map();
  const units = [];
  exercises.forEach(ex => {
    let g = (ex.group || '').trim().toLowerCase();
    if (!g) { units.push([ex]); return; }
    // Archived members only share a unit with others archived the same day.
    if (_mobIsArchived(ex)) g += '|' + _mobArch(ex.id).at;
    if (!byGroup.has(g)) { const u = []; byGroup.set(g, u); units.push(u); }
    byGroup.get(g).push(ex);
  });
  const uFreq = u => Math.max(...u.map(e => e.frequency || 1));
  const uMade = u => Math.min(...u.map(e => e.createdAt || 0));
  // Heaviest units first (members × days) — big groups are the hardest to fit, so
  // they claim days before the singles fill in around them.
  units.sort((a, b) => uFreq(b) * b.length - uFreq(a) * a.length || uFreq(b) - uFreq(a) || uMade(a) - uMade(b));

  const specs = units.map(unit => {
    const base = _mobBaseDays(uFreq(unit));

    let bestOff = 0, bestScore = Infinity;
    for (let off = 0; off < 7; off++) {
      const t = { morning: totals.morning.slice(), night: totals.night.slice() };
      unit.forEach(ex => base.forEach(d => { t[sessOf(ex)][(d + off) % 7]++; }));
      const both  = t.morning.map((n, i) => n + t.night[i]);
      const score = spread(t.morning) + spread(t.night) + spread(both) / 10;
      if (score < bestScore) { bestScore = score; bestOff = off; }
    }
    // An archived unit keeps its past days but doesn't shape today's balance or cap.
    const until = _mobArch(unit[0].id)?.at;
    if (!until) unit.forEach(ex => base.forEach(d => { totals[sessOf(ex)][(d + bestOff) % 7]++; }));

    const from = unit.map(_mobStart).sort()[0];
    return { f: uFreq(unit), off: bestOff, from: from < floor ? floor : from, until, tod: sessOf(unit[0]), n: unit.length,
      // A group session happened on any day one of its members was logged.
      logged: new Set(unit.flatMap(ex => getMobLog(ex.id).map(e => e.date))) };
  });

  // Catch-up never makes a session heavier than the template's heaviest day
  // (single exercises get one of slack, see _mobSimulate).
  const cap = { morning: Math.max(...totals.morning), night: Math.max(...totals.night) };
  _mobSimulate(specs, end, today, cap).forEach((r, i) =>
    units[i].forEach(ex => { due.set(ex.id, r.due); carried.set(ex.id, r.carried); spare.set(ex.id, r.spare); }));

  return { due, carried, spare };
}

// Whether a session row counts toward a day's tally: done, or a session that newly
// came due — an undone carry-over of an earlier miss isn't counted twice, and an
// optional make-up left undone isn't counted at all.
function _mobCounts(ex, date, schedule) {
  return _mobLoggedOn(ex.id, date) || (!!schedule.due.get(ex.id)?.has(date) && !schedule.carried.get(ex.id)?.has(date));
}

// ── Optional make-ups ──
// Settings key mobility_extra_v1: { date, ids } — make-ups added to today's routine
// by choice (from the schedule's `spare` list). Only today's list is used.
function _mobExtras(date) {
  const x = MEM['mobility_extra_v1'];
  return x && x.date === date && date === getActiveDateString() ? x.ids : [];
}
function toggleMobExtra(ids) {
  const today = getActiveDateString(), cur = _mobExtras(today);
  const on = !ids.every(id => cur.includes(id));
  const next = { date: today, ids: on ? [...new Set([...cur, ...ids])] : cur.filter(id => !ids.includes(id)) };
  MEM['mobility_extra_v1'] = next; _syncSetting('mobility_extra_v1', next);
  renderMobility();
  if (document.getElementById('mobSessionPage').classList.contains('open')) renderMobSession();
}

// Weekday indexes (0 = Mon) an exercise is due this week, misses and catch-ups included.
function _mobWeekDue(schedule, id) {
  const dates = schedule.due.get(id), mon = _mobThisWeekMonday();
  return [0, 1, 2, 3, 4, 5, 6].filter(i => dates && dates.has(_shiftDay(mon, i)));
}

// Order inside a session list.
function _mobRowCmp(a, b) {
  return (a.group || '').localeCompare(b.group || '') ||
    _mobByOrder(a, b) ||
    (b.frequency || 1) - (a.frequency || 1) ||
    (a.createdAt || 0) - (b.createdAt || 0);
}

// Manual order inside a group (set by dragging). Exercises never reordered have
// no `order` and follow the ordered ones.
function _mobByOrder(a, b) {
  const ao = a.order ?? null, bo = b.order ?? null;
  if (ao != null && bo != null) return ao - bo;
  return (ao == null) - (bo == null);
}
function _mobListCmp(a, b) {
  return (a.group ? 1 : 0) - (b.group ? 1 : 0) ||
    (a.group || '').localeCompare(b.group || '') ||
    _mobByOrder(a, b) ||
    (a.session === 'night' ? 1 : 0) - (b.session === 'night' ? 1 : 0) ||
    (b.frequency || 1) - (a.frequency || 1) ||
    (a.createdAt || 0) - (b.createdAt || 0);
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
  // Suggest only groups in the chosen session — groups never span morning and night.
  document.getElementById('mobGroupList').innerHTML =
    [...new Map(getMobExercises().filter(e => e.group && (e.session === 'night') === (_mobFormSession === 'night'))
      .map(e => [e.group.toLowerCase(), e.group])).values()]
      .map(g => `<option value="${_esc(g)}">`).join('');
  document.getElementById('mobMeasureBtns').innerHTML = seg(MOB_MEASURES, _mobFormMeasure, 'data-mobmeasure');
  document.getElementById('mobProgressBtns').innerHTML = seg(MOB_PROGRESS, _mobFormProgress, 'data-mobprogress');
  document.getElementById('mobProgressHint').textContent = _mobFormProgress === 'fixed'
    ? 'Stays at this dose. No progress tracking or nudges to go up.'
    : 'Hold longer or do more reps over time. You get a nudge when it\'s time to go up.';
  document.getElementById('mobFreqBtns').innerHTML    =
    seg([1, 2, 3, 4, 5, 6, 7].map(n => [n, n]), _mobFormFreq, 'data-mobfreq');

  document.getElementById('mobHoldField').hidden = _mobFormMeasure !== 'hold';
  document.getElementById('mobRepsField').hidden = _mobFormMeasure !== 'reps';
}


// ── History helpers ──
function _mobLoggedOn(id, date) { return getMobLog(id).some(e => e.date === date); }
function _mobDaysBetween(a, b) {
  const t = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  return Math.round((t(b) - t(a)) / 86400000);
}
function _mobAgo(date, today) {
  const n = _mobDaysBetween(date, today);
  return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n}d ago`;
}
// Everything due on a date (both sessions) and how much of it was logged.
function _mobDayStat(date, schedule) {
  const rows = [..._mobSessionRows(date, 'morning', schedule), ..._mobSessionRows(date, 'night', schedule)]
    .filter(ex => _mobCounts(ex, date, schedule));
  return { n: rows.length, done: rows.filter(ex => _mobLoggedOn(ex.id, date)).length };
}

// Dose to log next. A bump accepted from the nudge wins until a session after it is logged.
function _mobNext(ex) {
  const b = (MEM['mobility_bumps_v1'] || {})[ex.id];
  const last = getMobLog(ex.id).slice(-1)[0];
  return b && (!last || last.date < b.since) ? b : _mobCurrent(ex);
}

function _mobIsFixed(ex) { return ex.progress === 'fixed'; }

// Baseline → current change of the measured value; null when unchanged, the
// measure differs, or the exercise doesn't track progress.
function _mobGain(ex) {
  if (_mobIsFixed(ex)) return null;
  const cur = _mobCurrent(ex);
  const a = ex.measure === 'reps' ? ex.reps : ex.holdSeconds;
  const b = cur.measure === 'reps' ? cur.reps : cur.holdSeconds;
  if (!a || !b || a === b || cur.measure !== ex.measure) return null;
  return { a, b, d: b - a, pct: Math.round((b - a) / a * 100), unit: ex.measure === 'reps' ? '' : 's' };
}

// ponytail: rough time estimate — 3s per rep, 10s between sets; no real timing data.
function _mobSecs(ex) {
  const d = _mobNext(ex);
  return (d.sets || 1) * ((d.measure === 'reps' ? (d.reps || 10) * 3 : d.holdSeconds || 30) + 10);
}
function _mobMins(list) { return Math.max(1, Math.round(list.reduce((s, ex) => s + _mobSecs(ex), 0) / 60)); }

// Scheduled days in a row with everything logged, back from today (today counts
// once it's complete, and doesn't break the streak while it's still open).
function _mobStreak(schedule, today) {
  let n = 0, d = today;
  for (let i = 0; i < 400; i++, d = _shiftDay(d, -1)) {
    const s = _mobDayStat(d, schedule);
    if (!s.n) { if (!getMobExercises().some(ex => _localDateStr(new Date(ex.createdAt || 0)) <= d)) break; continue; }
    if (s.done < s.n) { if (d === today) continue; break; }
    n++;
  }
  return n;
}

// Progression nudge: the first exercise due today whose last 3 sessions used the same dose.
function _mobNudge(list, today) {
  const skip = MEM['mobility_nudge_skip_v1'] || {};
  for (const ex of list) {
    if (_mobIsFixed(ex)) continue;
    const log = getMobLog(ex.id).slice(-3);
    if (log.length < 3 || _mobLoggedOn(ex.id, today) || skip[ex.id] === log[2].date) continue;
    if (new Set(log.map(_mobDose)).size !== 1 || _mobDose(_mobNext(ex)) !== _mobDose(log[2])) continue;
    const e = log[2], to = { sets: e.sets, measure: e.measure, holdSeconds: e.holdSeconds, reps: e.reps };
    if (e.measure === 'reps') { if (!e.reps) continue; to.reps += 1; }
    else { if (!e.holdSeconds) continue; to.holdSeconds += 5; }
    return { ex, from: e, to };
  }
  return null;
}


// ── Render: today (header, nudge, the two session cards) ──
// Make-ups on offer for a session today: behind, and allowed by their rest days,
// but held back because today is already full. One chip per exercise or group.
function _mobMakeupsHTML(tod, date, schedule) {
  const extras = _mobExtras(date), chips = new Map();
  getMobExercises().filter(ex => (ex.session === 'night' ? 'night' : 'morning') === tod &&
      !_mobIsArchived(ex) && schedule.spare.get(ex.id)?.has(date))
    .sort(_mobRowCmp).forEach(ex => {
      const k = _mobGroupKey(ex.group) || ex.id;
      if (!chips.has(k)) chips.set(k, { label: ex.group || ex.name, ids: [] });
      chips.get(k).ids.push(ex.id);
    });
  if (!chips.size) return '';
  return `<div class="mob-makeups">
      <span class="mob-makeups-h" title="You're behind on these and their rest days allow today, but today is already full. Add any you feel like doing — skipping them isn't a miss.">Make-ups</span>
      ${[...chips.values()].map(c => { const on = c.ids.every(id => extras.includes(id));
        return `<button class="mob-makeup${on ? ' on' : ''}" type="button" data-mobextra="${c.ids.join(',')}" title="${on ? 'Remove from today' : 'Add to today (optional)'}">${on ? '✓' : '+'} ${_esc(c.label)}</button>`; }).join('')}
    </div>`;
}

function _mobSessionCardHTML(tod, list, date, schedule) {
  const label = tod === 'night' ? '☾ Night' : '☀ Morning';
  const done  = list.filter(ex => _mobLoggedOn(ex.id, date)).length;
  const rows  = list.map(ex => {
    const logged = _mobLoggedOn(ex.id, date);
    const d = logged ? getMobLog(ex.id).find(e => e.date === date) : _mobNext(ex);
    const bumped = !logged && _mobDose(d) !== _mobDose(_mobCurrent(ex));
    // Read-only status; logging happens on the session page the row opens.
    return `<button class="mob-trow${logged ? ' done' : ''}" type="button" data-mobsession-open="${tod}">
      <span class="mob-status" aria-label="${logged ? 'Done' : 'Not done yet'}">${logged ? '✓' : ''}</span>
      <span class="mob-tname">${_esc(ex.name)}${ex.group ? `<span class="mob-tgroup">${_esc(ex.group)}</span>` : ''}${schedule.due.get(ex.id)?.has(date) ? '' : '<span class="mob-tgroup">extra</span>'}</span>
      ${bumped ? `<span class="mob-tcue" title="New dose, up from ${_esc(_mobDose(_mobCurrent(ex)))}">↑</span>` : ''}
      <span class="mob-dose mob-dose-${_mobMeasureClass(d)}">${_esc(_mobDose(d))}</span>
    </button>`;
  }).join('');
  return `<div class="mob-sess-head">
      <span class="mob-sess-label ${tod}">${label}</span>
      <span class="mob-sess-meta">${list.length ? `${done}/${list.length} · ~${_mobMins(list)} min` : ''}</span>
      ${list.length ? `<button class="mob-btn" type="button" data-mobsession-open="${tod}" title="Open the session to adjust sets and doses">▶ Start</button>` : ''}
    </div>
    <div class="mob-sess-bar"><i style="width:${list.length ? done / list.length * 100 : 0}%"></i></div>
    <div class="mob-sess-list">${rows || '<div class="mob-empty">Rest — nothing scheduled.</div>'}</div>
    ${_mobMakeupsHTML(tod, date, schedule)}`;
}

function renderMobToday(schedule) {
  const dayEl = document.getElementById('mobTodayDay');
  if (!dayEl) return;
  const today = getActiveDateString();
  const am = _mobSessionRows(today, 'morning', schedule);
  const pm = _mobSessionRows(today, 'night', schedule);
  const all = [...am, ...pm];
  const left = all.filter(ex => !_mobLoggedOn(ex.id, today));
  const done = all.length - left.length;

  dayEl.textContent = MOB_DAYS_LONG[_mobTodayIdx()];
  const C = 169.6;   // 2πr for r = 27
  document.getElementById('mobRing').innerHTML = `<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="27" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="5"/>
      <circle cx="32" cy="32" r="27" fill="none" stroke="var(--success)" stroke-width="5" stroke-linecap="round"
        stroke-dasharray="${C}" stroke-dashoffset="${all.length ? C * (1 - done / all.length) : C}"/>
    </svg><span class="mob-ring-txt">${done}/${all.length}</span>`;

  const streak = getMobExercises().length ? _mobStreak(schedule, today) : 0;
  document.getElementById('mobTodaySub').innerHTML = !getMobExercises().length ? 'Add exercises to build your routines.' : [
    !all.length ? 'Rest day' : left.length ? `${left.length} left today` : 'All done today',
    streak ? `<span class="mob-ok">🔥 ${streak}-day streak</span>` : '',
    left.length ? `~${_mobMins(left)} min` : '',
  ].filter(Boolean).join('<span class="mob-sep">·</span>');

  const nudge = _mobNudge(all, today);
  document.getElementById('mobNudge').innerHTML = nudge ? `<div class="mob-nudge">
      <span class="mob-nudge-ic">↑</span>
      <span><b>${_esc(nudge.ex.name)}</b> — ${_esc(_mobDose(nudge.from))} for your last 3 sessions. Try <b>${_esc(_mobDose(nudge.to))}</b> today?</span>
      <span class="mob-spacer"></span>
      <button class="mob-btn" type="button" data-mobbump="${nudge.ex.id}">Bump to ${_esc(_mobDose(nudge.to))}</button>
      <button class="mob-link" type="button" data-mobskip="${nudge.ex.id}">Not yet</button>
    </div>` : '';

  document.getElementById('mobTodayMorning').innerHTML = _mobSessionCardHTML('morning', am, today, schedule);
  document.getElementById('mobTodayNight').innerHTML   = _mobSessionCardHTML('night', pm, today, schedule);
}


// Names for the selected day; a group's exercises sit together in parentheses.
function _mobWeekItemsHTML(list, date) {
  const item = ex => `<button type="button" class="mob-wd-item${_mobLoggedOn(ex.id, date) ? ' done' : ''}" data-mobdetail="${ex.id}">${_esc(ex.name)}</button>`;
  const chunks = [];
  list.forEach(ex => {
    const g = _mobGroupKey(ex.group), last = chunks[chunks.length - 1];
    if (g && last && last.g === g) last.list.push(ex);
    else chunks.push({ g, group: ex.group, list: [ex] });
  });
  // Each name is one unbreakable token carrying its own "(" / ")" and the dot after it,
  // so a line can only wrap after a dot — never between a parenthesis and its name.
  const paren = p => `<span class="mob-wd-paren">${p}</span>`;
  const tokens = chunks.flatMap(c => c.list.map((ex, i) =>
    (c.g && i === 0 ? paren('(') : '') + item(ex) + (c.g && i === c.list.length - 1 ? paren(')') : '')));
  return tokens.map((t, i) => `<span class="mob-wd-tok">${t}${i < tokens.length - 1 ? '<span class="mob-wd-dot">·</span>' : ''}</span>`).join('<wbr>');
}

// ── Render: week strip (logged share per session so far) + selected day ──
function renderMobWeek(schedule) {
  const grid = document.getElementById('mobWeekGrid');
  if (!grid) return;
  const off = _mobWeekOff, mon = _shiftDay(_mobThisWeekMonday(), 7 * off);
  // Today's index in the shown week: 7 for a past week (every day has passed), -1 for a future one.
  const ti = off < 0 ? 7 : off > 0 ? -1 : _mobTodayIdx();
  const sel = _mobOpenDay == null ? (off ? 0 : ti) : _mobOpenDay;

  const fmt = _mobShortDate;
  document.getElementById('mobWeekTitle').textContent =
    !off ? 'This Week' : off === -1 ? 'Last Week' : off === 1 ? 'Next Week' : `Week of ${fmt(mon)}`;
  document.getElementById('mobWeekRange').textContent = `${fmt(mon)} – ${fmt(_shiftDay(mon, 6))}`;
  document.getElementById('mobWeekNow').hidden = !off;
  // Nothing to go back to before the first exercise was added.
  const exs = getMobExercises();
  document.getElementById('mobWeekPrev').disabled =
    !exs.length || _localDateStr(new Date(Math.min(...exs.map(e => e.createdAt || 0)))) >= mon;

  // Each day's rows: what was due (past), is due (today) or is projected (later).
  const rows = MOB_DAYS.map((_, i) => {
    const date = _shiftDay(mon, i);
    return { date, morning: _mobSessionRows(date, 'morning', schedule), night: _mobSessionRows(date, 'night', schedule) };
  });
  // Share of a session logged; null when nothing was due.
  const share = (d, tod) => {
    const r = d[tod].filter(ex => _mobCounts(ex, d.date, schedule));
    return r.length ? r.filter(ex => _mobLoggedOn(ex.id, d.date)).length / r.length : null;
  };

  grid.innerHTML = rows.map((d, i) => {
    const date = d.date;
    const am = i <= ti ? share(d, 'morning') : 0, pm = i <= ti ? share(d, 'night') : 0;
    // Each session's count on its own: green once everything due is logged (today
    // included), red for a past session left unfinished.
    const mark = v => v == null || i > ti ? '' : v >= 1 ? ' class="done"' : i < ti ? ' class="miss"' : '';
    const pip = (tod, v, n) => `<span class="mob-pip ${tod}${n ? '' : ' none'}"><i style="width:${n ? v * 100 : 0}%"></i></span>`;
    return `<button class="mob-day${i === ti ? ' is-today' : ''}${i === sel ? ' is-open' : ''}" type="button" data-mobday="${i}">
      <span class="mob-day-top"><span class="mob-day-name">${MOB_DAYS[i]}</span><span class="mob-day-sep">-</span><span class="mob-day-num">${Number(date.slice(8))}</span></span>
      <span class="mob-day-pips">${pip('am', am, d.morning.length)}${pip('pm', pm, d.night.length)}</span>
      <span class="mob-day-count"><b${mark(am)}>${d.morning.length}</b><span class="mob-ic morning">☀</span> <b${mark(pm)}>${d.night.length}</b><span class="mob-ic night">☾</span></span>
    </button>`;
  }).join('');

  const date = _shiftDay(mon, sel);
  const col = (tod, label) => {
    const r = rows[sel][tod];
    return `<div class="mob-wd-col">
      <div class="mob-wd-h ${tod}"><span>${label} · ${r.length}</span>${sel <= ti && r.length ? `<button class="mob-link" type="button" data-mobweek-open="${tod}">open ›</button>` : ''}</div>
      <div class="mob-wd-items">${_mobWeekItemsHTML(r, date) || '<span class="mob-wd-empty">—</span>'}</div>
    </div>`;
  };
  const detail = document.getElementById('mobWeekDetail');
  detail.dataset.weekDate = date;
  detail.innerHTML = col('morning', 'Morning') + col('night', 'Night');
}


// ── Render: exercise list (one line per exercise) ──
function renderMobList() {
  const el = document.getElementById('mobList');
  if (!el) return;
  const list = getMobExercises();
  document.getElementById('mobListCols').hidden = !list.length;

  if (!list.length) {
    el.innerHTML = `<div class="mob-empty">No exercises yet — add stretches and mobility drills and the
      morning and night routines build themselves from this list.</div>`;
    return;
  }

  const schedule = compileMobSchedule(list);
  const today = getActiveDateString(), mon = _mobThisWeekMonday(), ti = _mobTodayIdx();
  const q = _mobQuery.trim().toLowerCase();
  const shown = list.filter(ex =>
      (_mobFilter === 'all' || (ex.session === 'night' ? 'night' : 'morning') === _mobFilter) &&
      (!q || ex.name.toLowerCase().includes(q) || (ex.group || '').toLowerCase().includes(q)))
    .sort(_mobListCmp);
  if (!shown.length) { el.innerHTML = '<div class="mob-empty">No matches.</div>'; return; }
  const sorted = shown.filter(ex => !_mobIsArchived(ex));
  const archived = shown.filter(_mobIsArchived);

  const row = ex => {
    const placed = _mobWeekDue(schedule, ex.id);
    const dayStr = MOB_DAY_INITIAL.map((ini, i) => {
      const done = i <= ti && _mobLoggedOn(ex.id, _shiftDay(mon, i));
      return `<span class="mob-di${placed.includes(i) ? ' on' : ''}${done ? ' done' : ''}">${ini}</span>`;
    }).join('');
    const cur  = _mobCurrent(ex);
    const gain = _mobGain(ex);
    const last = getMobLog(ex.id).slice(-1)[0];
    // Stale once it's gone about twice its usual gap without a session.
    const stale = !last || _mobDaysBetween(last.date, today) >= Math.ceil(14 / (ex.frequency || 1));
    const tod = ex.session === 'night' ? 'night' : 'morning';
    return `<div class="mob-row${ex.group ? ' in-group' : ''}" draggable="true" data-mobrow="${ex.id}">
      <span class="mob-grip" aria-hidden="true">⋮⋮</span>
      <span class="mob-name"><span class="mob-sdot ${tod}" title="${tod === 'night' ? 'Night' : 'Morning'}"></span><button class="mob-row-name" type="button" data-mobdetail="${ex.id}">${_esc(ex.name)}</button></span>
      <span class="mob-dosecell"><span class="mob-dose mob-dose-${_mobMeasureClass(cur)}">${_esc(_mobDose(cur))}</span>${_mobIsFixed(ex) ? '<span class="mob-fixedchip" title="Keeps the same dose — no progress tracking">fixed</span>'
        : gain && gain.d > 0 ? `<span class="mob-up" title="Up from ${_esc(_mobDose(ex))}">↑+${gain.d}${gain.unit}</span>` : ''}</span>
      <span class="mob-freq">${ex.frequency || 1}×/wk</span>
      <span class="mob-row-days">${dayStr}</span>
      <span class="mob-last${stale ? ' stale' : ''}">${last ? _mobAgo(last.date, today) : 'never'}</span>
      <span class="mob-row-actions">
        <button class="mob-row-btn" type="button" data-mobedit="${ex.id}" title="Edit">✎</button>
        <button class="mob-row-btn" type="button" data-mobarch="${ex.id}" title="Archive — take it off the schedule for now">⏸</button>
        <button class="mob-row-btn mob-row-del" type="button" data-mobdel="${ex.id}" title="Remove">×</button>
      </span>
    </div>`;
  };

  // Ungrouped exercises sit in an untitled zone; dropping an exercise anywhere in it removes it from its group.
  const solo = sorted.filter(ex => !ex.group);
  const groups = new Map();
  sorted.filter(ex => ex.group).forEach(ex => {
    const k = ex.group.trim().toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(ex);
  });
  const archRow = ex => `<div class="mob-arch-row">
      <span class="mob-sdot ${ex.session === 'night' ? 'night' : 'morning'}"></span>
      <button class="mob-row-name" type="button" data-mobdetail="${ex.id}">${_esc(ex.name)}</button>
      ${ex.group ? `<span class="mob-tgroup">${_esc(ex.group)}</span>` : ''}
      <span class="mob-arch-since">since ${_mobArchDateInput(ex)}</span>
      <span class="mob-spacer"></span>
      <button class="mob-btn" type="button" data-mobunarch="${ex.id}">Unarchive</button>
    </div>`;
  el.innerHTML = (sorted.length ? '' : '<div class="mob-empty">Everything here is archived.</div>') +
    (groups.size ? `<div class="mob-ungrouped" data-mobgroup="">${solo.map(row).join('')}</div>` : solo.map(row).join('')) +
    [...groups.values()].map(m => {
      const days = _mobWeekDue(schedule, m[0].id).map(i => MOB_DAYS[i]).join(' ');
      return `<div class="mob-group-head" data-mobgroup="${_esc(m[0].group)}">${_esc(m[0].group)}
          <span class="mob-group-meta">${m.length} · ${days}</span>${_mobFlowSeg(m[0].group, _mobFlowOf(m[0].group))}<span class="mob-group-line"></span>
          <button class="mob-link mob-group-arch" type="button" data-mobarch-group="${_esc(m[0].group)}" title="Take the whole group off the schedule for now">Archive group</button></div>` + m.map(row).join('');
    }).join('') +
    (archived.length ? `<details class="hab-archived mob-archived" id="mobArchived"${_mobArchOpen ? ' open' : ''}>
        <summary>Archived · ${archived.length}</summary>${archived.map(archRow).join('')}</details>` : '');
}

function _mobShortDate(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}


// ── Render: side column (consistency, gains, misses) ──
function renderMobRail(schedule) {
  const rail = document.getElementById('mobRail');
  if (!rail) return;
  const exs = getMobExercises();
  rail.hidden = !exs.length;
  if (!exs.length) return;
  const today = getActiveDateString();

  // Five Monday-aligned weeks ending this week. Today counts only what's logged so far.
  const start = _shiftDay(_mobThisWeekMonday(), -28);
  const rate = (from, count) => {
    let n = 0, done = 0;
    for (let i = 0; i < count; i++) {
      const d = _shiftDay(from, i);
      if (d > today) break;
      const s = _mobDayStat(d, schedule);
      n += d === today ? s.done : s.n; done += s.done;
    }
    return { n, done };
  };
  let cells = '';
  for (let i = 0; i < 35; i++) {
    const d = _shiftDay(start, i);
    if (d > today) { cells += '<i class="future"></i>'; continue; }
    const s = _mobDayStat(d, schedule);
    const lv = !s.n ? 'rest' : !s.done ? '' : s.done < s.n / 2 ? 'l1' : s.done < s.n ? 'l2' : 'l3';
    cells += `<i class="${lv}${d === today ? ' now' : ''}" title="${_fullDateLabel(d)} — ${s.n ? `${s.done} of ${s.n}` : 'rest day'}"></i>`;
  }
  const cur = rate(start, 35), prev = rate(_shiftDay(start, -35), 35);
  const pct = cur.n ? Math.round(cur.done / cur.n * 100) : 0;
  const delta = prev.n && cur.n ? pct - Math.round(prev.done / prev.n * 100) : null;

  const gains = exs.filter(ex => !_mobIsArchived(ex)).map(ex => ({ ex, g: _mobGain(ex) })).filter(x => x.g && x.g.d > 0)
    .sort((a, b) => b.g.pct - a.g.pct).slice(0, 4);

  // Misses over the last 7 days, not counting today.
  const miss = new Map();
  const lastDone = ex => getMobLog(ex.id).filter(e => e.date <= today).slice(-1)[0]?.date || '';
  for (let i = 7; i >= 1; i--) {
    const d = _shiftDay(today, -i);
    ['morning', 'night'].forEach(tod => _mobSessionRows(d, tod, schedule).forEach(ex => {
      if (!_mobCounts(ex, d, schedule) || _mobLoggedOn(ex.id, d)) return;
      const m = miss.get(ex.id) || { ex, n: 0 };
      m.n++; m.d = d; miss.set(ex.id, m);
    }));
  }
  const missed = [...miss.values()].sort((a, b) => b.n - a.n).slice(0, 5);

  rail.innerHTML = `
    <div class="card mob-rail-card">
      <div class="mob-rail-h"><span>Last 5 weeks</span><b>${pct}%</b></div>
      <div class="mob-heat-d">${MOB_DAY_INITIAL.map(c => `<span>${c}</span>`).join('')}</div>
      <div class="mob-heat">${cells}</div>
      <div class="mob-rail-foot"><span>${cur.done} of ${cur.n} logged</span>${delta ? `<span class="${delta > 0 ? 'mob-ok' : 'mob-warn'}">${delta > 0 ? '↑' : '↓'} ${Math.abs(delta)}% vs prior</span>` : ''}</div>
    </div>
    <div class="card mob-rail-card">
      <div class="mob-rail-h"><span>Biggest gains</span><span>since start</span></div>
      ${gains.length ? gains.map(({ ex, g }) => `<button class="mob-gain" type="button" data-mobdetail="${ex.id}">
          <span class="mob-gain-nm">${_esc(ex.name)}</span><span class="mob-gain-pct">+${g.pct}%</span>
          <span class="mob-gain-fr">${g.a}${g.unit}<span class="mob-gain-bar"><i class="${ex.measure === 'reps' ? 'reps' : 'hold'}" style="width:${Math.min(100, g.pct)}%"></i></span>${g.b}${g.unit}</span>
        </button>`).join('') : '<div class="mob-empty">Log a few sessions to see progress here.</div>'}
    </div>
    <div class="card mob-rail-card">
      <div class="mob-rail-h"><span>Falling behind</span><span>last 7 days</span></div>
      ${missed.length ? missed.map(({ ex, n, d }) => {
        const last = lastDone(ex);
        return `<button class="mob-behind" type="button" data-mobdetail="${ex.id}">
          <span class="mob-sdot ${ex.session === 'night' ? 'night' : 'morning'}"></span>
          <span class="mob-behind-txt"><span class="mob-behind-nm">${_esc(ex.name)}</span>
            <span class="mob-behind-why">${n > 1 ? `missed ${n}×` : `missed ${MOB_DAYS[_mobDateIdx(d)]}`} · ${last ? `last done ${_mobAgo(last, today)}` : 'never done'}</span></span>
        </button>`;
      }).join('') : '<div class="mob-empty">Nothing missed in the last 7 days.</div>'}
    </div>`;
}


function renderMobility() {
  if (!document.getElementById('tab-mobility')) return;
  const schedule = compileMobSchedule(getMobExercises());
  renderMobForm();
  renderMobToday(schedule);
  renderMobWeek(schedule);
  renderMobList();
  renderMobRail(schedule);
}


// ── Session detail page ──

// Rows for a (date, tod): exercises the current compile puts on that weekday+tod
// (minus any created after the date), plus any that already have an entry for
// exactly that date. The compile isn't stable over time, so the entry set is what
// keeps past sessions editable.
function _mobSessionRows(date, tod, schedule = compileMobSchedule(getMobExercises())) {
  // Due that day (once the exercise existed), plus anything logged off-schedule and
  // any make-ups added for today.
  const extras = _mobExtras(date);
  return getMobExercises().filter(ex =>
    (ex.session === 'night' ? 'night' : 'morning') === tod &&
    ((schedule.due.get(ex.id)?.has(date) && _mobStart(ex) <= date) ||
     _mobLoggedOn(ex.id, date) || extras.includes(ex.id))).sort(_mobRowCmp);
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
  clearInterval(_mobRestTimer); _mobRest = null;
  document.getElementById('mobSessionPage').classList.remove('open');
  _mobUnlockBodyIfClear();
}

// ── Set order ──
// Groups choose how their sets are ordered (settings key mobility_group_flow_v1):
//   'circuit' — every exercise once, then again: 1,2,3,1,2,3
//   'pairs'   — the same inside each run of two: 1,2,1,2,3,4,3,4 (an odd one out goes alone)
//   'straight'— every set of one exercise before the next: 1,1,2,2,3,3
// A group that hasn't picked yet runs as a circuit. An exercise with no group is straight sets.
function _mobGroupKey(g) { return (g || '').trim().toLowerCase(); }
function _mobFlowOf(g) { return (MEM['mobility_group_flow_v1'] || {})[_mobGroupKey(g)] || null; }
// Whether this exercise's group moves between exercises set by set (so switching
// is the break) rather than finishing each exercise first.
function _mobRotates(ex) { return !!ex.group && _mobFlowOf(ex.group) !== 'straight'; }
function _mobSetFlow(g, flow) {
  const all = { ...(MEM['mobility_group_flow_v1'] || {}), [_mobGroupKey(g)]: flow };
  MEM['mobility_group_flow_v1'] = all; _syncSetting('mobility_group_flow_v1', all);
}

// items: [{ ex, n }] (n = set rows) → steps [{ ex, i }] going through every item once per pass.
function _mobPasses(items) {
  const steps = [], rounds = Math.max(0, ...items.map(it => it.n));
  for (let r = 0; r < rounds; r++) items.forEach(it => { if (r < it.n) steps.push({ ex: it.ex, i: r, it }); });
  return steps;
}
// Session rows → units in list order: a group is one unit (placed where its first
// exercise is), an ungrouped exercise is its own unit. Each unit knows its steps.
function _mobUnits(items) {
  const units = [], byKey = new Map();
  items.forEach(it => {
    const k = _mobGroupKey(it.ex.group);
    if (!k) return units.push({ group: '', items: [it] });
    if (!byKey.has(k)) { const u = { group: it.ex.group, items: [] }; byKey.set(k, u); units.push(u); }
    byKey.get(k).items.push(it);
  });
  units.forEach(u => {
    const flow = u.group && _mobFlowOf(u.group);
    if (flow === 'straight') {
      u.steps = u.items.flatMap(it => Array.from({ length: it.n }, (_, i) => ({ ex: it.ex, i, it })));
    } else if (flow === 'pairs') {
      u.steps = [];
      for (let k = 0; k < u.items.length; k += 2) u.steps.push(..._mobPasses(u.items.slice(k, k + 2)));
    } else u.steps = _mobPasses(u.items);
  });
  return units;
}


// ── Session page: one table, a row per exercise and a column per set ──
function renderMobSession() {
  const body = document.getElementById('mobSessionBody');
  if (!body || !_mobSessionDate) return;
  const date = _mobSessionDate, tod = _mobSessionTod;
  const rows = _mobSessionRows(date, tod).map(ex => _mobSessionItem(ex, date));
  const units = _mobUnits(rows);
  const steps = units.flatMap(u => u.steps);
  const next = steps.find(s => !_mobSetDone(s, date)) || null;
  const totalSets = steps.length, doneSets = steps.length - steps.filter(s => !_mobSetDone(s, date)).length;
  const exDone = rows.filter(it => it.vals.filter(v => v != null).length >= it.n).length;
  const cols = Math.max(1, ...rows.map(it => it.n));

  const prevDisabled = date <= _dayDetailFloor();
  const nextDisabled = date >= getActiveDateString();
  const todBtns = MOB_SESSIONS.map(([v, l]) =>
    `<button class="mob-seg-btn${v === tod ? ' active' : ''}" data-mobtod="${v}">${l}</button>`).join('');

  const rowHTML = it => {
    const { ex } = it, reps = ex.measure === 'reps';
    const fmt = v => v == null ? '–' : reps ? `${v}` : `${v}s`;
    const cells = Array.from({ length: cols }, (_, i) => {
      if (i >= it.n) return '<td></td>';
      const done = it.vals[i] != null;
      const val = done ? it.vals[i] : it.draft.vals[i] ?? '';
      const isNext = next && next.ex === ex && next.i === i;
      return `<td><div class="mob-cell${isNext ? ' next' : ''}${done ? ' done' : ''}">
        <input class="mob-set-in" type="number" min="1" step="${reps ? 1 : 5}" inputmode="numeric"
          data-mobset="${ex.id}" data-i="${i}" value="${val}" placeholder="${it.goal ?? 0}" aria-label="${_esc(ex.name)} set ${i + 1}">
        <button class="mob-set-ok" type="button" data-mobsetok="${ex.id}" data-i="${i}" aria-label="${done ? 'Undo' : 'Done'} set ${i + 1}">✓</button>
      </div></td>`;
    }).join('');
    const rest = _mobRestFor(ex.id);
    const bumped = it.goal != null && !it.entry && it.target !== it.before && it.before && _mobDose(it.target) !== _mobDose(it.before);
    return `<tr class="${next && next.ex === ex ? 'is-now' : ''}${ex.group ? ' in-group' : ''}">
      <td><div class="mob-tex">
        ${_mobRingHTML(it.vals.filter(v => v != null).length / it.n)}
        <div class="mob-tex-main">
          <button class="mob-tex-name" type="button" data-mobdetail="${ex.id}">${_esc(ex.name)}</button>
          <div class="mob-tex-sub"><span>${it.n} × ${fmt(it.goal)}</span>
            ${bumped ? `<span class="mob-up">↑ from ${_esc(fmt(reps ? it.before.reps : it.before.holdSeconds))}</span>` : ''}
            ${_mobIsFixed(ex) ? '<span class="mob-fixedchip">fixed</span>' : ''}</div>
          <input class="mob-tex-note" data-mobnote="${ex.id}" value="${_esc(it.entry ? it.entry.note || '' : it.draft.note || '')}" placeholder="+ note" maxlength="300">
        </div>
      </div></td>
      <td class="mob-tlast">${Array.from({ length: Math.max(it.n, it.prev.length) }, (_, i) => fmt(it.prev[i])).join(' · ')}</td>
      ${cells}
      <td><button class="mob-tadd" type="button" data-mobaddset="${ex.id}" title="Add a set">+</button></td>
      <td>${_mobRotates(ex) ? '' : `<label class="mob-restsel" title="Rest between this exercise's sets">⏱
        <select data-mobrest="${ex.id}">${MOB_REST_OPTS.map(s => `<option value="${s}"${s === rest ? ' selected' : ''}>${s ? _mobRestLabel(s) : 'No rest'}</option>`).join('')}</select></label>`}</td>
    </tr>`;
  };

  const table = units.map(u => {
    if (!u.group) return rowHTML(u.items[0]);
    const flow = _mobFlowOf(u.group);
    return `<tr class="mob-tgrp"><td colspan="${cols + 4}"><div class="mob-tgrp-line">
        <span class="mob-tgrp-name">${_esc(u.group)}</span>
        ${_mobFlowSeg(u.group, flow)}
        ${u.steps.map(s => `<span class="mob-step${_mobSetDone(s, date) ? ' done' : next && next.ex === s.ex && next.i === s.i ? ' now' : ''}">${_esc(s.ex.name)}</span>`).join('<span class="mob-step-arrow">→</span>')}
      </div></td></tr>` + u.items.map(rowHTML).join('');
  }).join('');

  body.innerHTML = `
    <div class="mob-shead">
      <div class="mob-shead-row">
        <div class="day-detail-head mob-sdate">
          <button class="hcal-nav-btn" id="mobSessionPrev"${prevDisabled ? ' disabled' : ''}>‹</button>
          <h2 class="habit-detail-name day-detail-date">${_fullDateLabel(date)}</h2>
          <button class="hcal-nav-btn" id="mobSessionNext"${nextDisabled ? ' disabled' : ''}>›</button>
        </div>
        <div class="mob-seg" id="mobSessionTodBtns">${todBtns}</div>
        <span class="mob-spacer"></span>
        ${rows.length ? `<span class="mob-sprog"><b>${doneSets}</b>/${totalSets} sets · <b>${exDone}</b>/${rows.length} exercises</span>` : ''}
      </div>
      ${rows.length ? `<div class="mob-sbar"><i style="width:${totalSets ? doneSets / totalSets * 100 : 0}%"></i></div>
      <div class="mob-snext" id="mobNextStrip">${_mobNextStripHTML(next, units.some(u => u.group && _mobFlowOf(u.group) !== 'straight'))}</div>` : ''}
    </div>
    ${rows.length ? `<div class="mob-tcard"><table class="mob-table">
      <thead><tr><th>Exercise</th><th class="mob-tlast">Last time</th>${Array.from({ length: cols }, (_, i) => `<th>Set ${i + 1}</th>`).join('')}<th></th><th>Rest</th></tr></thead>
      <tbody>${table}</tbody>
    </table></div>` : '<div class="empty-state">Nothing scheduled for this session.</div>'}
  `;
}

// Everything the table needs about one exercise on one date.
function _mobSessionItem(ex, date) {
  const entry  = getMobLog(ex.id).find(e => e.date === date);
  const draft  = _mobSetDraftFor(ex.id, date);
  const before = [...getMobLog(ex.id)].reverse().find(e => e.date < date);
  // The plan for this session: a pending bump today, else the last session before it, else the baseline.
  const target = (date === getActiveDateString() && !entry ? _mobNext(ex) : before)
    || { sets: ex.sets, measure: ex.measure, holdSeconds: ex.holdSeconds, reps: ex.reps };
  const vals = _mobSetVals(entry);
  // Row count sticks once shown, so logging set 1 doesn't hide the planned set 2.
  const n = draft.rows = Math.max(draft.rows || 0, vals.length, entry && !Array.isArray(entry.setValues) ? 0 : target.sets || 1, 1);
  return { ex, entry, draft, before, target, vals, n,
           goal: ex.measure === 'reps' ? target.reps : target.holdSeconds, prev: _mobSetVals(before) };
}
function _mobSetDone(step, date) {
  const e = getMobLog(step.ex.id).find(x => x.date === date);
  return _mobSetVals(e)[step.i] != null;
}

function _mobRingHTML(f) {
  const C = 69.1;
  return `<span class="mob-sring"><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="13" cy="13" r="11" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="3"/>
    <circle cx="13" cy="13" r="11" fill="none" stroke="var(--success)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - Math.min(1, f))}"/>
  </svg><span>${f >= 1 ? '✓' : ''}</span></span>`;
}

function _mobFlowSeg(group, flow) {
  const b = (v, label, tip) => `<button type="button" class="${flow === v ? 'on' : ''}" data-mobflow="${_esc(group)}" data-v="${v}" title="${tip}">${label}</button>`;
  return `<span class="mob-flow">${b('circuit', 'Circuit', 'Every exercise in a row, then again: 1, 2, 3, 1, 2, 3')}${b('pairs', 'Pairs', 'Alternate in twos: 1, 2, 1, 2, then 3, 4, 3, 4')}${b('straight', 'Straight', 'All sets of one exercise, then the next: 1, 1, 2, 2, 3, 3')}</span>`;
}

function _mobNextStripHTML(next, hasGroups) {
  const roundRest = MEM['mobility_round_rest_v1'] || 0;
  const roundSel = hasGroups ? `<label class="mob-restsel">Rest between group rounds:
    <select data-mobroundrest>${MOB_REST_OPTS.map(s => `<option value="${s}"${s === roundRest ? ' selected' : ''}>${s ? _mobRestLabel(s) : 'none'}</option>`).join('')}</select></label>` : '';
  if (!next) return `<span class="mob-snext-tag done">All done</span><span>Every set is logged for this session.</span>`;
  const reps = next.ex.measure === 'reps', goal = next.it.goal;
  const where = `<b>${_esc(next.ex.name)}</b> · set ${next.i + 1}${goal ? ` · ${goal}${reps ? '' : 's'}` : ''}${next.ex.group ? ` <span class="mob-tgroup">${_esc(next.ex.group)}</span>` : ''}`;
  if (_mobRest && _mobRest.date === _mobSessionDate && _mobRestLeft()) {
    return `<span class="mob-snext-tag rest">${_mobRest.round ? 'Round done' : 'Rest'}</span>
      <span class="mob-clock" id="mobRestLeft">${_mobClock(_mobRestLeft())}</span><span>then ${where}</span>
      <span class="mob-spacer"></span><button class="mob-btn" type="button" data-mobrestadd>+15s</button>
      <button class="mob-link" type="button" data-mobrestskip>Skip</button>`;
  }
  return `<span class="mob-snext-tag">${_mobRotates(next.ex) ? '⇄ Up next' : 'Up next'}</span><span>${where}</span>
    <span class="mob-spacer"></span>${_mobRotates(next.ex) ? '<span class="mob-snext-hint">Switching exercise is your break</span>' : ''}${roundSel}`;
}

// Per-set values of a log entry: its own list, or — for entries logged before
// per-set tracking — `sets` copies of its single value. null = set not done.
function _mobSetVals(e) {
  if (!e) return [];
  if (Array.isArray(e.setValues)) return e.setValues;
  const v = e.measure === 'reps' ? e.reps : e.holdSeconds;
  return Array.from({ length: e.sets || 1 }, () => v || 0);
}

// Unsaved per-session UI: extra rows added, values typed into undone sets, a note
// typed before any set is done. Kept in memory so re-renders don't lose it.
const _mobSetDrafts = {};
function _mobSetDraftFor(id, date) {
  return _mobSetDrafts[date + '|' + id] || (_mobSetDrafts[date + '|' + id] = { rows: 0, vals: [], note: '' });
}

// Write a session's per-set values. The entry's sets / hold / reps summarise the
// done sets (count and best value), so progress, nudges and history keep working.
function _mobWriteSets(ex, date, vals, note) {
  const done = vals.filter(v => v != null);
  if (!done.length) {
    _mobSetDraftFor(ex.id, date).note = note || '';
    _mobDeleteEntry(ex.id, date);
    return;
  }
  const best = Math.max(...done);
  _mobUpsertEntry(ex.id, date, {
    sets: done.length, measure: ex.measure,
    holdSeconds: ex.measure === 'reps' ? null : best, reps: ex.measure === 'reps' ? best : null,
    setValues: vals, note: note || '',
  });
}

// Tick / untick one set. Returns true when a set was just completed.
function _mobToggleSet(exId, date, i) {
  const ex = getMobExercises().find(x => x.id === exId);
  if (!ex) return false;
  const entry = getMobLog(exId).find(e => e.date === date);
  const draft = _mobSetDraftFor(exId, date);
  const vals  = _mobSetVals(entry).slice();
  while (vals.length <= i) vals.push(null);
  let completed = false;
  if (vals[i] != null) {
    if (vals.filter(v => v != null).length === 1 && date !== getActiveDateString() &&
        !confirm("Remove this session's log entry?")) return false;
    draft.vals[i] = vals[i];
    vals[i] = null;
  } else {
    const input = document.querySelector(`#mobSessionBody [data-mobset="${exId}"][data-i="${i}"]`);
    const v = Math.round(Number(input && (input.value || input.placeholder)));
    vals[i] = v > 0 ? v : 1;
    delete draft.vals[i];
    completed = true;
  }
  draft.rows = Math.max(draft.rows, vals.length);
  _mobWriteSets(ex, date, vals, entry ? entry.note : draft.note);
  return completed;
}

// After a set is done (today only): ungrouped exercises rest before their own next
// set; inside a group there's no wait — switching exercise is the break — except the
// optional rest once a whole round of the group is done.
function _mobAfterSet(exId, i) {
  const date = _mobSessionDate;
  if (date !== getActiveDateString()) return;
  const ex = getMobExercises().find(x => x.id === exId);
  const steps = _mobUnits(_mobSessionRows(date, _mobSessionTod).map(e => _mobSessionItem(e, date))).flatMap(u => u.steps);
  const next = steps.find(s => !_mobSetDone(s, date));
  if (!ex || !next) { _mobStopRest(false); return; }
  if (!_mobRotates(ex)) {
    if (next.ex.id === ex.id && _mobRestFor(ex.id)) _mobStartRest(date, _mobRestFor(ex.id), false);
    else _mobStopRest(false);
  } else if (MEM['mobility_round_rest_v1'] && _mobSameGroup(next.ex.group, ex.group) && next.i > i) {
    _mobStartRest(date, MEM['mobility_round_rest_v1'], true);
  } else _mobStopRest(false);
}

// ── Rest timer (one per session; lengths stored in settings) ──
const MOB_REST_OPTS = [0, 15, 30, 45, 60, 90, 120, 180];
let _mobRest = null;   // { date, end, round } while a rest countdown runs
let _mobRestTimer = null;
function _mobRestFor(id) { const r = (MEM['mobility_rest_v1'] || {})[id]; return r == null ? 30 : r; }
function _mobRestLabel(s) { return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min${s % 60 ? ` ${s % 60}s` : ''}`; }
function _mobClock(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function _mobRestLeft() { return _mobRest ? Math.max(0, Math.ceil((_mobRest.end - Date.now()) / 1000)) : 0; }
function _mobStartRest(date, secs, round) {
  _mobRest = { date, end: Date.now() + secs * 1000, round };
  clearInterval(_mobRestTimer);
  _mobRestTimer = setInterval(() => {
    const left = _mobRestLeft();
    const el = document.getElementById('mobRestLeft');
    if (el) el.textContent = _mobClock(left);
    if (!left) { if (navigator.vibrate) navigator.vibrate(200); _mobStopRest(); }
  }, 250);
}
function _mobStopRest(rerender = true) {
  clearInterval(_mobRestTimer);
  _mobRest = null;
  if (rerender) renderMobSession();
}


// ── Per-exercise detail page ──
function openMobExerciseDetail(id) {
  const ex = getMobExercises().find(x => x.id === id);
  if (!ex) return;
  _mobDetailId = id;
  _mobDraft = _mobFieldsOf(ex);
  renderMobExerciseDetail();
  const p = document.getElementById('mobExerciseDetailPage');
  p.scrollTop = 0;
  p.classList.add('open');
  _mobLockBody();
}
function closeMobExerciseDetail() {
  const ex = getMobExercises().find(x => x.id === _mobDetailId);
  if (ex && _mobDraftDirty(ex) && !confirm('Discard your unsaved changes?')) return;
  document.getElementById('mobExerciseDetailPage').classList.remove('open');
  _mobDraft = null;
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
  if (!_mobDraft) _mobDraft = _mobFieldsOf(ex);

  const log     = getMobLog(ex.id);
  const baseline = { sets: ex.sets, measure: ex.measure, holdSeconds: ex.holdSeconds, reps: ex.reps };
  const dose = o => (o.measure === 'reps' ? o.reps : o.holdSeconds) ? _mobDose(o) : '–';   // nothing set yet
  const week    = _mobWeekDue(compileMobSchedule(getMobExercises()), ex.id);
  const dots    = MOB_DAY_INITIAL.map((ini, i) => {
    const placed = week.includes(i);
    return `<span class="mob-di${placed ? ' on' : ''}">${ini}</span>`;
  }).join('');

  const fixed = _mobIsFixed(ex);
  const trend = (() => {
    const recent = log.slice(-12);
    if (fixed || recent.length < 2) return '';
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
          <div class="area-note-body mob-logrow-dose">${_esc(_mobDose(e))}${e.note ? ` <span class="mob-logrow-note">· ${_esc(e.note)}</span>` : ''}</div>
        </div>`).join('')
    : '<div class="area-detail-empty">No sessions logged yet.</div>';

  const d = _mobDraft;
  const seg = (opts, active, attr) => opts.map(([v, l]) =>
    `<button class="mob-seg-btn${String(v) === String(active) ? ' active' : ''}" type="button" ${attr}="${v}">${l}</button>`).join('');
  const groups = [...new Map(getMobExercises().filter(e => e.group && e.id !== ex.id && (e.session === 'night') === (d.session === 'night'))
    .map(e => [e.group.toLowerCase(), e.group])).values()];

  body.innerHTML = `
    <input class="mob-exd-name" data-mobd="name" value="${_esc(d.name)}" aria-label="Exercise name" maxlength="80">
    <div class="mob-exd-meta">
      <span class="mob-row-days" title="Due this week">${dots}</span>
      ${fixed ? '<span class="mob-fixedchip">No progress tracking</span>' : ''}
    </div>

    <div class="mob-exd-form">
      <span class="mob-exd-label">When</span>
      <div class="mob-seg">${seg(MOB_SESSIONS, d.session, 'data-mobd-session')}</div>
      <span class="mob-exd-label">Dose</span>
      <div class="mob-exd-row">
        <input class="mob-exd-num" type="number" min="1" step="1" data-mobd="sets" value="${d.sets ?? ''}" aria-label="Sets"> sets ×
        <input class="mob-exd-num" type="number" min="1" step="${d.measure === 'reps' ? 1 : 5}" data-mobd="${d.measure === 'reps' ? 'reps' : 'holdSeconds'}"
          value="${(d.measure === 'reps' ? d.reps : d.holdSeconds) ?? ''}" aria-label="${d.measure === 'reps' ? 'Reps' : 'Hold seconds'}">
        <div class="mob-seg">${seg([['hold', 'sec'], ['reps', 'reps']], d.measure, 'data-mobd-measure')}</div>
      </div>
      <span class="mob-exd-label">Over time</span>
      <div class="mob-seg">${seg(MOB_PROGRESS, d.progress, 'data-mobd-progress')}</div>
      <span class="mob-exd-label">Per week</span>
      <div class="mob-seg">${seg([1, 2, 3, 4, 5, 6, 7].map(n => [n, n]), d.frequency, 'data-mobd-freq')}</div>
      <span class="mob-exd-label">Group</span>
      <div><input class="mob-exd-text" data-mobd="group" list="mobExGroupList" value="${_esc(d.group)}" placeholder="Optional — same-group exercises share days" maxlength="40">
        <datalist id="mobExGroupList">${groups.map(g => `<option value="${_esc(g)}">`).join('')}</datalist></div>
    </div>
    <div class="mob-exd-save">
      <button class="btn-add" type="button" id="mobExSave"${_mobDraftDirty(ex) ? '' : ' disabled'}>Save changes</button>
      <span class="polish-status" id="mobExStatus">${_esc(_mobDraftHint(ex))}</span>
    </div>

    ${fixed ? (() => {
      const last = log.slice(-1)[0];
      return `<div class="habit-detail-stats-grid">
      <div class="habit-stat-card">
        <div class="habit-stat-val mob-stat-dose">${_esc(dose(_mobCurrent(ex)))}</div>
        <div class="habit-stat-label">Dose</div>
      </div>
      <div class="habit-stat-card">
        <div class="habit-stat-val mob-stat-dose">${log.length}</div>
        <div class="habit-stat-label">Sessions</div>
      </div>
      <div class="habit-stat-card">
        <div class="habit-stat-val mob-stat-dose">${last ? _mobAgo(last.date, getActiveDateString()) : '–'}</div>
        <div class="habit-stat-label">Last done</div>
      </div>
    </div>`;
    })() : `<div class="habit-detail-stats-grid">
      <div class="habit-stat-card">
        <div class="habit-stat-val mob-stat-dose">${_esc(dose(baseline))}</div>
        <div class="habit-stat-label">Started</div>
      </div>
      <div class="habit-stat-card">
        <div class="habit-stat-val mob-stat-dose">${_esc(dose(_mobCurrent(ex)))}</div>
        <div class="habit-stat-label">Current</div>
      </div>
      <div class="habit-stat-card">
        <div class="habit-stat-val mob-stat-dose">${_esc(_mobChangeLabel(ex, log))}</div>
        <div class="habit-stat-label">Change</div>
      </div>
    </div>`}

    ${trend}

    <div class="habit-detail-section-title">Session log</div>
    <div class="hd-notes-list">${logList}</div>

    <div class="mob-exd-danger">
      ${_mobIsArchived(ex)
        ? `<button class="mob-btn" type="button" data-mobunarch="${ex.id}">Unarchive</button><span class="mob-exd-arch-note">Archived since ${_mobArchDateInput(ex)} — off the schedule from that day.</span>`
        : `<button class="mob-btn" type="button" data-mobarch="${ex.id}" title="Take it off the schedule for now — the log is kept">Archive</button>`}
      <span class="mob-spacer"></span>
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
    name: _mobParseName(document.getElementById('mobName').value).name,
    session: _mobFormSession === 'night' ? 'night' : 'morning',
    measure: _mobFormMeasure === 'reps' ? 'reps' : 'hold',
    sets: Math.max(1, Math.round(Number(document.getElementById('mobSets').value) || 1)),
    frequency: Math.max(1, Math.min(7, Number(_mobFormFreq) || 3)),
    group: document.getElementById('mobGroup').value.trim(),
    progress: _mobFormProgress === 'fixed' ? 'fixed' : 'dose',
    holdSeconds: null, reps: null,
  };
  if (data.measure === 'hold') data.holdSeconds = numOrNull('mobHold');
  else data.reps = numOrNull('mobReps');
  return data;
}

function _mobClearForm() {
  document.getElementById('mobName').value = '';
  document.getElementById('mobGroup').value = '';
  document.getElementById('mobHold').value = '';
  document.getElementById('mobReps').value = '';
  document.getElementById('mobSets').value = '1';
  _mobFormSession = 'morning';
  _mobFormMeasure = 'hold';
  _mobFormFreq = 3;
  _mobFormProgress = 'dose';
}

function _mobSameGroup(a, b) { return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase(); }

// Error text if `group` already belongs to the other session, else ''. Groups never span morning and night.
function _mobGroupClash(list, group, session, exceptId) {
  const g = (group || '').trim().toLowerCase();
  const hit = g && list.find(x => x.id !== exceptId && (x.group || '').trim().toLowerCase() === g && x.session !== session);
  return hit ? `"${hit.group}" is a ${hit.session === 'night' ? 'night' : 'morning'} group — only exercises in the same session can share a group.` : '';
}

// Create (id null) or update an exercise. Returns an error message, or '' on success.
function _mobSaveExercise(id, data) {
  if (!data.name) return 'Give the exercise a name first.';
  const list = getMobExercises();
  const orig = id && list.find(x => x.id === id);
  // Changing the time of a grouped exercise moves the whole group to it.
  const moveGroup = orig && data.group && _mobSameGroup(orig.group, data.group) && orig.session !== data.session;
  const clash = !moveGroup && _mobGroupClash(list, data.group, data.session, id);
  if (clash) return clash;
  if (moveGroup) list.forEach(x => { if (_mobSameGroup(x.group, data.group)) x.session = data.session; });
  if (orig) Object.assign(orig, data);
  else list.push({ id: _mobId(), createdAt: Date.now(), ...data });
  saveMobExercises(list);
  if (!orig && _activatePremade('h_mob_' + (data.session === 'night' ? 'night' : 'morning'))) renderHabits();
  return '';
}

function submitMobForm() {
  const err = _mobSaveExercise(null, _mobReadForm());
  if (err) { showStatus(document.getElementById('mobFormStatus'), err, 'var(--warning)'); return; }
  closeMobModal();
}

// ── Detail-page editor ──
// The editable fields of an exercise, normalised so a draft can be compared with it.
function _mobFieldsOf(o) {
  const reps = o.measure === 'reps';
  return {
    name: (o.name || '').trim(), session: o.session === 'night' ? 'night' : 'morning',
    measure: reps ? 'reps' : 'hold', sets: Math.max(1, Math.round(Number(o.sets) || 1)),
    holdSeconds: reps ? null : (Number(o.holdSeconds) > 0 ? Math.round(o.holdSeconds) : null),
    reps: reps ? (Number(o.reps) > 0 ? Math.round(o.reps) : null) : null,
    frequency: Math.max(1, Math.min(7, Number(o.frequency) || 3)),
    group: (o.group || '').trim(), progress: o.progress === 'fixed' ? 'fixed' : 'dose',
  };
}
function _mobDraftDirty(ex) {
  return !!_mobDraft && JSON.stringify(_mobFieldsOf(_mobDraft)) !== JSON.stringify(_mobFieldsOf(ex));
}
// Side effect worth knowing before saving: a new time moves the whole group.
function _mobDraftHint(ex) {
  if (!_mobDraft || !ex.group || !_mobSameGroup(ex.group, _mobDraft.group) || _mobDraft.session === ex.session) return '';
  const mates = getMobExercises().filter(x => x.id !== ex.id && _mobSameGroup(x.group, ex.group)).length;
  return mates ? `Saving also moves the ${mates} other exercise${mates > 1 ? 's' : ''} in "${ex.group}".` : '';
}
function _mobSyncSaveBtn() {
  const ex = getMobExercises().find(x => x.id === _mobDetailId);
  const btn = document.getElementById('mobExSave');
  if (!ex || !btn) return;
  btn.disabled = !_mobDraftDirty(ex);
  document.getElementById('mobExStatus').textContent = _mobDraftHint(ex);
}
function saveMobDraft() {
  const ex = getMobExercises().find(x => x.id === _mobDetailId);
  if (!ex || !_mobDraftDirty(ex)) return;
  const err = _mobSaveExercise(ex.id, _mobFieldsOf(_mobDraft));
  const status = document.getElementById('mobExStatus');
  if (err) { status.textContent = err; status.style.color = 'var(--warning)'; return; }
  _mobDraft = _mobFieldsOf(getMobExercises().find(x => x.id === ex.id));
  renderMobExerciseDetail();
  renderMobility();
  if (document.getElementById('mobSessionPage').classList.contains('open')) renderMobSession();
  showStatus(document.getElementById('mobExStatus'), 'Saved', 'var(--success)', 2000);
}

function deleteMobExercise(id) {
  const ex = getMobExercises().find(x => x.id === id);
  if (!ex || !confirm(`Remove "${ex.name}"? Its session log is deleted too.`)) return;
  delete MEM['mobility_progress:' + id];   // drop the log before the save that persists MEM
  saveMobExercises(getMobExercises().filter(x => x.id !== id));   // DB log rows go via FK on delete cascade
  if (_mobDetailId === id) { _mobDraft = null; closeMobExerciseDetail(); }
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


// ── Drag an exercise onto a group header / row to group it (onto "Ungrouped" to leave).
// Onto a grouped row, it lands just before or after that row (top / bottom half). ──
let _mobDragId = null;
let _mobDropAfter = false;
let _mobDropBeside = false;   // pointer is in a row's reorder zone (any grouped row; edges of an ungrouped one)

function _mobDropTarget(e) { return e.target.closest('[data-mobgroup], [data-mobrow]'); }

// Put `ex` into `other`'s group, just before or after `other`, and renumber the group.
function _mobPlaceBeside(list, ex, other, after) {
  const members = list.filter(x => x.id !== ex.id && _mobSameGroup(x.group, other.group)).sort(_mobListCmp);
  members.splice(members.indexOf(other) + (after ? 1 : 0), 0, ex);
  ex.group = other.group;
  members.forEach((m, i) => { m.order = i + 1; });
}

function _mobGroupExercise(id, group, besideId, after) {
  const list = getMobExercises();
  const ex = list.find(x => x.id === id);
  if (!ex) return;
  const clash = !_mobSameGroup(ex.group, group) && _mobGroupClash(list, group, ex.session, id);
  if (clash) { alert(clash); return; }
  const other = besideId && list.find(x => x.id === besideId);
  if (other) _mobPlaceBeside(list, ex, other, after);
  else {
    if (!_mobSameGroup(ex.group, group)) ex.order = null;   // joins at the end of the new group
    ex.group = group;
  }
  saveMobExercises(list);
  renderMobility();
}

function _mobDrop(target) {
  const list = getMobExercises();
  const ex = list.find(x => x.id === _mobDragId);
  if (!ex) return;
  if (target.dataset.mobgroup !== undefined) return _mobGroupExercise(ex.id, target.dataset.mobgroup);
  const other = list.find(x => x.id === target.dataset.mobrow);
  if (!other || other.id === ex.id) return;
  if (other.group || _mobDropBeside) return _mobGroupExercise(ex.id, other.group || '', other.id, _mobDropAfter);
  // Dropped on another ungrouped exercise: start a new group with both.
  if (ex.session !== other.session) { alert('Only exercises in the same session can share a group.'); return; }
  openMobGroupModal(ex, other);
}

// ── New-group dialog: a name plus Circuit or Pairs (no default — the user picks) ──
let _mobNewGroup = null;   // { ids: [dragged, target], flow }
function openMobGroupModal(ex, other) {
  _mobNewGroup = { ids: [ex.id, other.id], flow: null };
  document.getElementById('mobGroupSub').textContent = `${ex.name} + ${other.name}`;
  document.getElementById('mobGroupName').value = '';
  document.getElementById('mobGroupStatus').textContent = '';
  renderMobGroupModal();
  document.getElementById('mobGroupModal').classList.add('open');
  _mobLockBody();
  setTimeout(() => document.getElementById('mobGroupName').focus(), 0);
}
function closeMobGroupModal() {
  document.getElementById('mobGroupModal').classList.remove('open');
  _mobNewGroup = null;
  _mobUnlockBodyIfClear();
}
function renderMobGroupModal() {
  document.querySelectorAll('#mobGroupModal [data-gflow]').forEach(b => b.classList.toggle('active', b.dataset.gflow === _mobNewGroup.flow));
  document.getElementById('mobGroupCreate').disabled = !(_mobNewGroup.flow && document.getElementById('mobGroupName').value.trim());
}
function createMobGroup() {
  const name = document.getElementById('mobGroupName').value.trim();
  if (!_mobNewGroup || !name || !_mobNewGroup.flow) return;
  const list = getMobExercises();
  const [ex, other] = _mobNewGroup.ids.map(id => list.find(x => x.id === id));
  if (!ex || !other) { closeMobGroupModal(); return; }
  const clash = _mobGroupClash(list, name, ex.session, ex.id) || _mobGroupClash(list, name, other.session, other.id);
  if (clash) { document.getElementById('mobGroupStatus').textContent = clash; return; }
  ex.group = other.group = name;
  _mobSetFlow(name, _mobNewGroup.flow);
  saveMobExercises(list);
  closeMobGroupModal();
  renderMobility();
}


// ── Listeners ──
const _mobPanel = document.getElementById('tab-mobility');
const _mobModal = document.getElementById('mobModal');
const _mobGroupModal = document.getElementById('mobGroupModal');
_mobGroupModal.addEventListener('click', e => {
  const f = e.target.closest('[data-gflow]');
  if (f) { _mobNewGroup.flow = f.dataset.gflow; renderMobGroupModal(); return; }
  if (e.target.id === 'mobGroupCreate') { createMobGroup(); return; }
  if (e.target.closest('[data-close]') || e.target === _mobGroupModal) closeMobGroupModal();
});
_mobGroupModal.addEventListener('input', renderMobGroupModal);
_mobGroupModal.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); createMobGroup(); } });
const _mobSessionPage = document.getElementById('mobSessionPage');
const _mobExDetailPage = document.getElementById('mobExerciseDetailPage');

// Tab panel: today rows → session page, nudge, week strip, list filter / add / edit / delete, rail links.
const _mobList = document.getElementById('mobList');
_mobList.addEventListener('dragstart', e => {
  const row = e.target.closest('[data-mobrow]');
  if (!row) return;
  _mobDragId = row.dataset.mobrow;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', _mobDragId);   // Firefox needs data set to start a drag
  row.classList.add('is-dragging');
});
_mobList.addEventListener('dragover', e => {
  const t = _mobDropTarget(e);
  if (!t || !_mobDragId || t.dataset.mobrow === _mobDragId) return;
  e.preventDefault();
  // Grouped rows show where the exercise will land; everything else highlights as a whole.
  // Ungrouped rows only reorder at their top / bottom edge; the middle still starts a group.
  let beside = false;
  if (t.dataset.mobrow) {
    const r = t.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
    beside = t.classList.contains('in-group') || y < 0.3 || y > 0.7;
    _mobDropAfter = y > 0.5;
  }
  _mobDropBeside = beside;
  _mobList.querySelectorAll('.is-drop, .drop-before, .drop-after').forEach(x => x !== t && x.classList.remove('is-drop', 'drop-before', 'drop-after'));
  t.classList.toggle('is-drop', !beside);
  t.classList.toggle('drop-before', !!beside && !_mobDropAfter);
  t.classList.toggle('drop-after', !!beside && _mobDropAfter);
});
_mobList.addEventListener('drop', e => {
  const t = _mobDropTarget(e);
  if (!t || !_mobDragId) return;
  e.preventDefault();
  _mobDrop(t);
  _mobDragId = null;
});
_mobList.addEventListener('dragend', () => {
  _mobDragId = null;
  _mobList.querySelectorAll('.is-drop, .is-dragging, .drop-before, .drop-after').forEach(x => x.classList.remove('is-drop', 'is-dragging', 'drop-before', 'drop-after'));
});

_mobPanel.addEventListener('click', e => {
  const fl = e.target.closest('[data-mobflow]');
  if (fl) { _mobSetFlow(fl.dataset.mobflow, fl.dataset.v); renderMobList(); return; }

  const bump = e.target.closest('[data-mobbump]');
  if (bump) {
    const ex = getMobExercises().find(x => x.id === bump.dataset.mobbump);
    const n = ex && _mobNudge([ex], getActiveDateString());
    if (n) {
      const bumps = { ...(MEM['mobility_bumps_v1'] || {}), [ex.id]: { ...n.to, since: getActiveDateString() } };
      MEM['mobility_bumps_v1'] = bumps; _syncSetting('mobility_bumps_v1', bumps);
    }
    renderMobility();
    return;
  }
  const extra = e.target.closest('[data-mobextra]');
  if (extra) { toggleMobExtra(extra.dataset.mobextra.split(',')); return; }

  const skip = e.target.closest('[data-mobskip]');
  if (skip) {
    const last = getMobLog(skip.dataset.mobskip).slice(-1)[0];
    const skips = { ...(MEM['mobility_nudge_skip_v1'] || {}), [skip.dataset.mobskip]: last && last.date };
    MEM['mobility_nudge_skip_v1'] = skips; _syncSetting('mobility_nudge_skip_v1', skips);
    renderMobility();
    return;
  }

  const flt = e.target.closest('[data-mobfilter]');
  if (flt) {
    _mobFilter = flt.dataset.mobfilter;
    document.querySelectorAll('#mobFilter [data-mobfilter]').forEach(b => b.classList.toggle('active', b === flt));
    renderMobList();
    return;
  }

  // Checked before rows: names sit inside rows, which have their own click target.
  const det = e.target.closest('[data-mobdetail]');
  if (det) { openMobExerciseDetail(det.dataset.mobdetail); return; }

  const nav = e.target.closest('[data-mobweek-nav]');
  if (nav) {
    const n = Number(nav.dataset.mobweekNav);
    _mobWeekOff = n ? _mobWeekOff + n : 0;
    _mobOpenDay = null;
    renderMobWeek(compileMobSchedule(getMobExercises()));
    return;
  }

  const day = e.target.closest('[data-mobday]');
  if (day) { _mobOpenDay = Number(day.dataset.mobday); renderMobWeek(compileMobSchedule(getMobExercises())); return; }

  const wk = e.target.closest('[data-mobweek-open]');
  if (wk) {
    const wd = document.getElementById('mobWeekDetail').dataset.weekDate;
    if (wd) openMobSession(wd, wk.dataset.mobweekOpen);
    return;
  }

  const so = e.target.closest('[data-mobsession-open]');
  if (so) { openMobSession(getActiveDateString(), so.dataset.mobsessionOpen); return; }

  if (e.target.closest('[data-mobadd]')) { _mobClearForm(); openMobModal(); return; }

  const ed = e.target.closest('[data-mobedit]');
  if (ed) { openMobExerciseDetail(ed.dataset.mobedit); return; }

  const del = e.target.closest('[data-mobdel]');
  if (del) { deleteMobExercise(del.dataset.mobdel); return; }

  const arch = e.target.closest('[data-mobarch], [data-mobunarch]');
  if (arch) { setMobArchived([arch.dataset.mobarch || arch.dataset.mobunarch], !!arch.dataset.mobarch); return; }
  const archG = e.target.closest('[data-mobarch-group]');
  if (archG) {
    const g = _mobGroupKey(archG.dataset.mobarchGroup);
    setMobArchived(getMobExercises().filter(ex => _mobGroupKey(ex.group) === g && !_mobIsArchived(ex)).map(ex => ex.id), true);
    return;
  }

  const row = e.target.closest('[data-mobrow]');
  if (row) openMobExerciseDetail(row.dataset.mobrow);
});

// <details> toggle doesn't bubble — catch it on the way down so the list re-renders keep it open.
_mobPanel.addEventListener('toggle', e => { if (e.target.id === 'mobArchived') _mobArchOpen = e.target.open; }, true);

_mobPanel.addEventListener('change', _mobOnArchDate);
document.getElementById('mobSearch').addEventListener('input', e => { _mobQuery = e.target.value; renderMobList(); });

// Modal: segmented controls, submit, close.
_mobModal.addEventListener('click', e => {
  const s = e.target.closest('[data-mobsession]');
  if (s) { _mobFormSession = s.dataset.mobsession; renderMobForm(); return; }

  const m = e.target.closest('[data-mobmeasure]');
  if (m) { _mobFormMeasure = m.dataset.mobmeasure; renderMobForm(); return; }

  const pr = e.target.closest('[data-mobprogress]');
  if (pr) { _mobFormProgress = pr.dataset.mobprogress; renderMobForm(); return; }

  const f = e.target.closest('[data-mobfreq]');
  if (f) { _mobFormFreq = Number(f.dataset.mobfreq); renderMobForm(); return; }

  if (e.target.id === 'mobAddBtn')     { submitMobForm(); return; }
  if (e.target.id === 'mobModalClose') { closeMobModal(); return; }
  if (e.target.id === 'mobModal')      { closeMobModal(); return; }   // backdrop
});

// Shortcuts typed in the name fill the fields as you type; they're stripped from the name on save.
document.getElementById('mobName').addEventListener('input', e => {
  const f = _mobParseName(e.target.value).fields;
  if (f.session)     _mobFormSession = f.session;
  if (f.measure)     _mobFormMeasure = f.measure;
  if (f.progress)    _mobFormProgress = f.progress;
  if (f.frequency)   _mobFormFreq    = f.frequency;
  if (f.sets)        document.getElementById('mobSets').value  = f.sets;
  if (f.holdSeconds) document.getElementById('mobHold').value  = f.holdSeconds;
  if (f.reps)        document.getElementById('mobReps').value  = f.reps;
  if (f.group)       document.getElementById('mobGroup').value = f.group;
  renderMobForm();
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

  const ok = e.target.closest('[data-mobsetok]');
  if (ok) { _mobTickSet(ok.dataset.mobsetok, Number(ok.dataset.i)); return; }

  const add = e.target.closest('[data-mobaddset]');
  if (add) {
    const id = add.dataset.mobaddset;
    const shown = document.querySelectorAll(`#mobSessionBody [data-mobset="${id}"]`).length;
    _mobSetDraftFor(id, _mobSessionDate).rows = shown + 1;
    renderMobSession();
    return;
  }

  if (e.target.closest('[data-mobrestskip]')) { _mobStopRest(); return; }
  if (e.target.closest('[data-mobrestadd]') && _mobRest) { _mobRest.end += 15000; return; }

  const fl = e.target.closest('[data-mobflow]');
  if (fl) { _mobSetFlow(fl.dataset.mobflow, fl.dataset.v); _mobStopRest(false); renderMobSession(); renderMobList(); return; }

  const det = e.target.closest('[data-mobdetail]');
  if (det) { openMobExerciseDetail(det.dataset.mobdetail); return; }
});

// Tick / untick a set from the table and refresh everything that shows it.
function _mobTickSet(exId, i) {
  if (_mobToggleSet(exId, _mobSessionDate, i)) _mobAfterSet(exId, i);
  else _mobStopRest(false);
  renderMobSession();
  renderMobility();
  if (_mobDetailId === exId && _mobExDetailPage.classList.contains('open')) renderMobExerciseDetail();
}

// Enter saves. In a set box: logs the set and jumps to the next one (a set that's
// already logged just saves its edited value). In a note: saves the note.
_mobSessionPage.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const inp = e.target.closest('[data-mobset], [data-mobnote]');
  if (!inp) return;
  e.preventDefault();
  if (inp.dataset.mobset === undefined) { inp.blur(); return; }   // blur fires change, which saves
  const exId = inp.dataset.mobset, i = Number(inp.dataset.i);
  if (_mobSetVals(getMobLog(exId).find(x => x.date === _mobSessionDate))[i] != null) { inp.blur(); return; }
  _mobTickSet(exId, i);
  const next = document.querySelector('#mobSessionBody .mob-cell.next .mob-set-in');
  if (next) next.focus();
});

_mobSessionPage.addEventListener('change', e => {
  const date = _mobSessionDate;
  const after = exId => {
    renderMobSession();
    renderMobility();
    if (_mobDetailId === exId && _mobExDetailPage.classList.contains('open')) renderMobExerciseDetail();
  };

  // A set's value: saved straight away if the set is done, else kept as a draft.
  const inp = e.target.closest('[data-mobset]');
  if (inp) {
    const exId = inp.dataset.mobset, i = Number(inp.dataset.i);
    const ex = getMobExercises().find(x => x.id === exId);
    const entry = getMobLog(exId).find(en => en.date === date);
    const vals = _mobSetVals(entry).slice();
    const v = Math.round(Number(inp.value));
    if (ex && vals[i] != null && v > 0) { vals[i] = v; _mobWriteSets(ex, date, vals, entry.note); after(exId); }
    else _mobSetDraftFor(exId, date).vals[i] = inp.value;
    return;
  }

  const note = e.target.closest('[data-mobnote]');
  if (note) {
    const exId = note.dataset.mobnote;
    const entry = getMobLog(exId).find(en => en.date === date);
    if (entry) { entry.note = note.value.trim(); saveMobLog(exId, getMobLog(exId)); }
    else _mobSetDraftFor(exId, date).note = note.value.trim();
    return;
  }

  if (e.target.matches('[data-mobroundrest]')) {
    MEM['mobility_round_rest_v1'] = Number(e.target.value);
    _syncSetting('mobility_round_rest_v1', Number(e.target.value));
    return;
  }

  const rest = e.target.closest('[data-mobrest]');
  if (rest) {
    const all = { ...(MEM['mobility_rest_v1'] || {}), [rest.dataset.mobrest]: Number(rest.value) };
    MEM['mobility_rest_v1'] = all; _syncSetting('mobility_rest_v1', all);
  }
});

// Exercise detail page.
_mobExDetailPage.addEventListener('click', e => {
  if (e.target.id === 'mobExDetailBack') { closeMobExerciseDetail(); return; }
  if (e.target.id === 'mobExSave')       { saveMobDraft(); return; }

  const opt = e.target.closest('[data-mobd-session], [data-mobd-measure], [data-mobd-progress], [data-mobd-freq]');
  if (opt && _mobDraft) {
    const ds = opt.dataset;
    if (ds.mobdSession)  _mobDraft.session   = ds.mobdSession;
    if (ds.mobdMeasure)  _mobDraft.measure   = ds.mobdMeasure;
    if (ds.mobdProgress) _mobDraft.progress  = ds.mobdProgress;
    if (ds.mobdFreq)     _mobDraft.frequency = Number(ds.mobdFreq);
    renderMobExerciseDetail();
    return;
  }
  if (e.target.id === 'mobExDelete')     { deleteMobExercise(_mobDetailId); return; }
  const arch = e.target.closest('[data-mobarch], [data-mobunarch]');
  if (arch) { setMobArchived([_mobDetailId], !!arch.dataset.mobarch); return; }

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

// Detail-page editor: typing updates the draft and the Save button, without a re-render (keeps focus).
_mobExDetailPage.addEventListener('change', _mobOnArchDate);
_mobExDetailPage.addEventListener('input', e => {
  const f = e.target.dataset.mobd;
  if (!f || !_mobDraft) return;
  _mobDraft[f] = e.target.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value;
  _mobSyncSaveBtn();
});
_mobExDetailPage.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset.mobd) { e.preventDefault(); saveMobDraft(); }
});

// One Escape handler for all three mobility overlays — close the topmost only.
document.addEventListener('keydown', e => {
  // N opens the add modal — on the Mobility tab, when nothing else has the keyboard.
  if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey &&
      _mobPanel.classList.contains('active') &&
      !document.querySelector('.sr-modal.open') &&
      !document.querySelector('.habit-detail-page.open') &&
      !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) &&
      !document.activeElement.isContentEditable) {
    e.preventDefault();
    _mobClearForm();
    openMobModal();
    return;
  }
  if (e.key !== 'Escape') return;
  if (_mobGroupModal.classList.contains('open'))     { closeMobGroupModal(); return; }
  if (_mobModal.classList.contains('open'))          { closeMobModal(); return; }
  if (_mobExDetailPage.classList.contains('open'))   { closeMobExerciseDetail(); return; }
  if (_mobSessionPage.classList.contains('open'))    { closeMobSession(); return; }
});

// Wide tabs scale the whole layout up, like enlarging an image, instead of
// stretching rows. 1094 = 820px main + 14px gap + 260px side column — the
// width the two-column layout (css/mobility.css) is designed at.
const MOB_BASE_WIDTH = 1094;
const _mobLayoutEl = document.querySelector('#tab-mobility .mob-layout');
new ResizeObserver(([e]) => {
  const w = e.contentRect.width;
  _mobLayoutEl.style.zoom = w > MOB_BASE_WIDTH ? (w / MOB_BASE_WIDTH).toFixed(4) : '';
}).observe(document.querySelector('#tab-mobility .mob-section'));

// Re-render when the tab is opened (mirrors the Diet / Areas tabs).
document.querySelectorAll('.tab-btn').forEach(btn => {
  if (btn.dataset.tab === 'mobility') btn.addEventListener('click', renderMobility);
});
