// Habits tab: habit list, streaks, week check-ins, overview calendar,
// habit detail page. Loaded before main.js.

// ── Habit Tracker ──
function habitDateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return _localDateStr(d);
}

function getHabits()              { return MEM['habits:list'] || []; }
function saveHabits(h)            { MEM['habits:list'] = h; _syncHabits(h); }
// Lazily creates and persists the backing array on first access (rather than
// handing back a fresh `[]` fallback every call) so every caller shares the
// same reference from the start — including the very first check-in of a day,
// before anything has been saved yet. Callers rely on mutating this array in
// place; a throwaway fallback array would let two near-simultaneous first
// check-ins each hold their own copy instead of converging (see saveHabitVoids).
function getHabitLog(dateStr)     { return MEM['habits:log:' + dateStr] || (MEM['habits:log:' + dateStr] = []); }
function saveHabitLog(dateStr, ids) { MEM['habits:log:' + dateStr] = ids; _syncHabitLog(dateStr, ids); }

// ── Voided (excused) habit-days ──
// A voided (habit, day) pair didn't count — illness, travel, a hospital stay.
// It never breaks a streak, never counts toward the day's completion %, and
// never increments the habit's "Day N". A habit you voided but still managed to
// do counts as a normal win: voiding only ever removes a penalty, never a
// completion — hence the `!getHabitLog(...)` guard in `_habitVoidedOn`, which is
// the single predicate every other site below asks.
function getHabitVoids(dateStr)      { return MEM['habits:void:' + dateStr] || (MEM['habits:void:' + dateStr] = []); }
function saveHabitVoids(dateStr, ids) { MEM['habits:void:' + dateStr] = ids; _syncHabitVoids(dateStr, ids); }

function _habitVoidedOn(habitId, ds) {
  return getHabitVoids(ds).includes(habitId) && !getHabitLog(ds).includes(habitId);
}

// ── Increment (count) habits ──
// A 'checkbox' habit (the default) is done or not; an 'increment' habit is
// done N times a day against a `target` the user sets (e.g. "drink water 8
// times"). The raw daily tally lives here, keyed like the void log; whether
// the day counts as *done* still lives entirely in habits:log, kept in sync
// by setHabitCount below, so streaks/rings/history never need to know a
// count habit exists.
function getHabitCounts(dateStr)         { return MEM['habits:count:' + dateStr] || (MEM['habits:count:' + dateStr] = {}); }
function getHabitCount(dateStr, habitId) { return getHabitCounts(dateStr)[habitId] || 0; }
function _isIncrementHabit(habit)        { return habit.trackType === 'increment'; }
// `targets` holds per-date overrides ({ 'YYYY-MM-DD': n }) of the default
// `target`; pass `ds` to get that day's effective target.
function _habitTarget(habit, ds)         { return Math.max(1, (ds && habit.targets && habit.targets[ds]) || habit.target || 1); }

function setHabitCount(dateStr, habit, count) {
  const clamped = Math.max(0, Math.min(count, _habitTarget(habit, dateStr)));
  const counts  = getHabitCounts(dateStr);
  if (clamped > 0) counts[habit.id] = clamped; else delete counts[habit.id];
  MEM['habits:count:' + dateStr] = counts;
  _syncHabitCounts(dateStr, counts);

  const log = getHabitLog(dateStr);
  const wasDone = log.includes(habit.id);
  const isDone  = clamped >= _habitTarget(habit, dateStr);
  if (isDone && !wasDone) log.push(habit.id);
  else if (!isDone && wasDone) log.splice(log.indexOf(habit.id), 1);
  if (isDone !== wasDone) saveHabitLog(dateStr, log);
}

// Toggle a day fully done/undone — shared by every checkbox and calendar cell
// in the habits UI. A count habit toggles its tally between 0 and its target
// rather than touching the log directly, so the count store can never drift
// from the done-ness everything else reads off the log.
function _toggleHabitDone(ds, habit) {
  if (_isIncrementHabit(habit)) {
    setHabitCount(ds, habit, _habitDoneOn(habit, ds) ? 0 : _habitTarget(habit, ds));
    return;
  }
  const log = getHabitLog(ds);
  const i = log.indexOf(habit.id);
  if (i !== -1) log.splice(i, 1); else log.push(habit.id);
  saveHabitLog(ds, log);
}

// Did this habit count as done on `ds`? A retired day never does. Archiving can
// happen after you have already ticked the habit that morning, and that leaves a
// check-in behind in the log; since the archive day is out of play, the leftover
// must not credit a streak, tick a checkbox or count towards anything.
function _habitDoneOn(habit, ds) {
  return getHabitLog(ds).includes(habit.id) && !_habitRetiredOn(habit, ds);
}

// How many days in [from, to] were voided for this habit. Walks the void keys
// (usually a handful) rather than every date in the range.
function _habitVoidedCount(habitId, from, to) {
  let n = 0;
  storeListKeys('habits:void:').forEach(k => {
    const ds = k.slice('habits:void:'.length);
    if (ds >= from && ds <= to && _habitVoidedOn(habitId, ds)) n++;
  });
  return n;
}

// ── Earlier runs ──
// Archiving and starting again splits a habit into several active spans.
// `runs` records the ones that have finished; the current one is startDate
// onward. Keeping the real dates (rather than only a day tally) is what lets
// history stay intact across a restart: those days are still the habit's, so
// they keep their check-ins, their calendar colour and their place in each
// day's completion count.
function _habitRuns(h)            { return Array.isArray(h.runs) ? h.runs : []; }
function _habitInPriorRun(h, ds)  { return _habitRuns(h).some(r => ds >= r.from && ds <= r.to); }

// Days served in those earlier runs, voided days excluded.
function _habitPriorDays(h) {
  return _habitRuns(h).reduce((n, r) =>
    n + daysBetween(r.from, r.to) + 1 - _habitVoidedCount(h.id, r.from, r.to), 0);
}

// The habit's "Day N" — days elapsed in the current run, not counting voided
// ones, on top of the days it was already active before any archive/restart, so
// the count resumes where it left off: archive on day 15, start again, and the
// day you restart is day 15 again. The dormant stretch between runs is never
// counted — it wasn't active.
function _habitDayNum(habit, today) {
  const start = habit.startDate;
  const prior = _habitPriorDays(habit);
  if (!start) return prior + 1;
  return prior + daysBetween(start, today) + 1 - _habitVoidedCount(habit.id, start, today);
}

// A timed habit's full run length, likewise spanning its earlier runs, so a
// 30-day habit resumed on day 15 still reads "of 30" rather than "of 16".
function _habitTotalDays(habit) {
  if (!habit.endDate) return null;
  return daysBetween(habit.startDate, habit.endDate) + 1 + _habitPriorDays(habit);
}

// Total days this habit has been active, across every run — what the Completed
// tag reports once it is archived.
function _habitServedDays(habit) {
  const upTo = habit.archivedAt ? String(habit.archivedAt).slice(0, 10) : null;
  if (!upTo || !habit.startDate) return _habitPriorDays(habit);
  return _habitPriorDays(habit) + Math.max(0,
    daysBetween(habit.startDate, upTo) - _habitVoidedCount(habit.id, habit.startDate, upTo));
}

function getHabitNotes(id)        { return MEM['habit_notes:' + id] || []; }
function saveHabitNotes(id, notes) { MEM['habit_notes:' + id] = notes; _syncHabitNotes(id, notes); }

// ── Routines ──
// Morning / Anytime / Night / End of day. The three flags are mutually
// exclusive, so every habit sits in exactly one of these sections.
const HABIT_ROUTINES = [['morning', 'Morning'], ['anytime', 'Anytime'], ['night', 'Night'], ['eod', 'End of day']];
const HABIT_ROUTINE_TAG = { morning: 'Morning routine', night: 'Night routine', eod: 'End of day' };
function _habitRoutine(h) {
  return h.morningRoutine ? 'morning' : h.nightRoutine ? 'night' : h.endOfDay ? 'eod' : 'anytime';
}
function _setHabitRoutine(h, r) {
  h.morningRoutine = r === 'morning';
  h.nightRoutine   = r === 'night';
  h.endOfDay       = r === 'eod';
}
function _habitGroupRank(h) {
  return HABIT_ROUTINES.findIndex(([k]) => k === _habitRoutine(h));
}

// ── Schedules ──
// No schedule = every day. {type:'days', days:[0-6]} (0 = Sunday) only asks
// for those weekdays; {type:'weekly', times:N} asks for N days in each Mon–Sun
// week and keeps its streak in weeks.
function _habitSchedule(h) {
  const s = h.schedule;
  if (s && s.type === 'days' && Array.isArray(s.days) && s.days.length) return s;
  if (s && s.type === 'weekly' && s.times > 0) return s;
  return null;
}
function _habitIsWeekly(h) { const s = _habitSchedule(h); return !!s && s.type === 'weekly'; }
function _habitTimes(h)    { return Math.max(1, Math.min(7, (h.schedule && h.schedule.times) || 1)); }
function _dow(ds) { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d).getDay(); }
// A weekday a pick-days habit doesn't ask for: it can't be missed, and it
// neither extends nor breaks a streak.
function _habitOffDay(h, ds) {
  const s = _habitSchedule(h);
  return !!s && s.type === 'days' && !s.days.includes(_dow(ds));
}
const _DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function _habitScheduleLabel(h) {
  const s = _habitSchedule(h);
  if (!s) return 'Every day';
  if (s.type === 'weekly') return `${s.times}× a week`;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const days = order.filter(d => s.days.includes(d));
  if (days.length === 5 && !days.includes(0) && !days.includes(6)) return 'Weekdays';
  return days.map(d => _DOW_SHORT[d]).join(', ');
}

// Monday of the week `ds` falls in.
function _weekStart(ds) { return _shiftDay(ds, -((_dow(ds) + 6) % 7)); }

// One Mon–Sun week of a weekly habit, looked at up to `upTo`. Voided days each
// excuse one of the week's required days; days before the start or after
// archiving aren't available at all, so a part week asks for less.
function _habitWeekStatus(h, ws, upTo) {
  let done = 0, voided = 0, avail = 0;
  for (let i = 0; i < 7; i++) {
    const ds = _shiftDay(ws, i);
    const inPlay = _habitInPriorRun(h, ds) || (ds >= (h.startDate || '0000-00-00') && !_habitRetiredOn(h, ds));
    if (!inPlay) continue;
    avail++;
    if (ds > upTo) continue;
    if (_habitDoneOn(h, ds)) done++;
    else if (_habitVoidedOn(h.id, ds)) voided++;
  }
  const need = Math.max(0, Math.min(_habitTimes(h), avail) - voided);
  return { done, need, avail, met: avail > 0 && done >= need };
}

// Weeks in a row that hit the goal. The current week counts once it's met and
// never breaks the run while it's still in progress.
function _habitWeekStreak(h) {
  const today = habitDateStr(0);
  let ws = _weekStart(today), n = 0;
  if (_habitWeekStatus(h, ws, today).met) n++;
  const first = _habitFirstDay(h);
  for (let i = 0; i < 520; i++) {
    ws = _shiftDay(ws, -7);
    if (_shiftDay(ws, 6) < first) break;
    const st = _habitWeekStatus(h, ws, _shiftDay(ws, 6));
    if (st.avail === 0) continue;
    if (!st.met) break;
    n++;
  }
  return n;
}

// Earliest day the habit was ever active (its first run, or its start).
function _habitFirstDay(h) {
  let first = h.startDate || habitDateStr(0);
  _habitRuns(h).forEach(r => { if (r.from < first) first = r.from; });
  return first;
}

// ── Group + sort ──
// Group: Routine sections or Area sections. Sort: order inside a section.
// The old single setting ('area' was one of its sort modes) still reads right.
function getHabitGroup() {
  const g = MEM['habit_group_v1'];
  if (g === 'routine' || g === 'area') return g;
  return MEM['habit_sort_v1'] === 'area' ? 'area' : 'routine';
}
function setHabitGroup(g) { MEM['habit_group_v1'] = g; _syncSetting('habit_group_v1', g); renderHabits(); }
function getHabitSort() {
  const m = MEM['habit_sort_v1'];
  return ['custom', 'az', 'newest', 'oldest'].includes(m) ? m : 'custom';
}
function setHabitSort(m) { MEM['habit_sort_v1'] = m; _syncSetting('habit_sort_v1', m); renderHabits(); }

function _habitCreatedKey(h) { return h.createdAt || h.startDate || ''; }

// Section a habit belongs to under the current grouping.
function _habitGroupKey(h, group) {
  if (group === 'area') return getAreas().some(a => a.name === h.area) ? h.area : '';
  return _habitRoutine(h);
}
function _habitGroupIndex(h, group) {
  if (group === 'area') {
    const areas = getAreas();
    const i = areas.findIndex(a => a.name === h.area);
    return i < 0 ? areas.length : i;
  }
  return _habitGroupRank(h);
}

// Returns a new array sorted for display. `MEM['habits:list']` is never mutated —
// its order is the canonical "custom" order and the tiebreak for the other modes.
function _sortHabitsForDisplay(list, mode) {
  const pos = new Map(getHabits().map((h, i) => [h.id, i]));
  const p = h => pos.has(h.id) ? pos.get(h.id) : Infinity;
  const byCustom = (a, b) => p(a) - p(b);
  const arr = [...list];
  if (mode === 'az') {
    arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || byCustom(a, b));
  } else if (mode === 'newest') {
    arr.sort((a, b) => _habitCreatedKey(b).localeCompare(_habitCreatedKey(a)) || byCustom(a, b));
  } else if (mode === 'oldest') {
    arr.sort((a, b) => _habitCreatedKey(a).localeCompare(_habitCreatedKey(b)) || byCustom(a, b));
  } else {
    arr.sort(byCustom);
  }
  return arr;
}

// Group order first, then the chosen sort inside each group.
function _orderHabits(list) {
  const group = getHabitGroup();
  const sorted = _sortHabitsForDisplay(list, getHabitSort());
  const idx = new Map(sorted.map((h, i) => [h.id, i]));
  return sorted.sort((a, b) => _habitGroupIndex(a, group) - _habitGroupIndex(b, group) || idx.get(a.id) - idx.get(b.id));
}

// Shared drag-reorder handler for both the tracker list and the day-detail checklist.
// `fromEl`/`toEl` are the dragged and drop-target row elements (keyed by data-habit-id).
function _reorderHabitByDrag(fromEl, toEl) {
  if (getHabitSort() !== 'custom') return;
  const fromId = fromEl.dataset.habitId, toId = toEl.dataset.habitId;
  if (!fromId || !toId || fromId === toId) return;
  const list    = getHabits();
  const dragged = list.find(h => h.id === fromId);
  const target  = list.find(h => h.id === toId);
  if (!dragged || !target) return;
  const group = getHabitGroup();
  if (_habitGroupKey(dragged, group) !== _habitGroupKey(target, group)) return;
  const next = list.filter(h => h.id !== fromId);
  next.splice(next.indexOf(target), 0, dragged);
  saveHabits(next);
  renderHabits();
}

// FLIP-animate `rowSel` rows inside `containerEl` (a node that survives `mutate`)
// around a DOM rebuild. Rows are matched across the rebuild by `data-habit-id`.
function _flipRows(containerEl, rowSel, mutate) {
  if (!containerEl || matchMedia('(prefers-reduced-motion: reduce)').matches) { mutate(); return; }
  const firstTop = new Map();
  containerEl.querySelectorAll(rowSel).forEach(r => firstTop.set(r.dataset.habitId, r.getBoundingClientRect().top));
  mutate();
  containerEl.querySelectorAll(rowSel).forEach(r => {
    const prev = firstTop.get(r.dataset.habitId);
    if (prev == null) return;
    const dy = prev - r.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    r.style.transition = 'none';
    r.style.transform  = `translateY(${dy}px)`;
    void r.offsetHeight; // reflow so the next line animates from here
    r.style.transition = 'transform 0.34s cubic-bezier(0.22,1,0.36,1)';
    r.style.transform  = '';
  });
}
// Habit ids key the check-in log, the void log and the notes, and they are the
// upsert key in Supabase — so two habits must never share one. The old
// `Date.now().toString(36)` collided whenever two were added in the same
// millisecond, which silently fused their histories.
function _habitId() {
  return 'h_' + ((crypto && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
}

// Escape text that is interpolated into an HTML template. The tracker rows build
// their nodes with textContent and are safe by construction; the day-detail view
// renders from a string, so anything user-typed has to come through here.
function _esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _noteId() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// Streak ending on an arbitrary date (inclusive), walking backward. Shared by
// habitStreak() (anchored on yesterday) and _habitRecentlyBroken() (anchored
// one day earlier), so the "was there a real streak before this miss" question
// reuses the exact same rules rather than a second copy of them.
function _habitStreakEndingOn(habit, endDs) {
  let streak = 0;
  let ds = endDs;
  for (let i = 0; i < 365; i++) {
    // Retired day — the habit was already archived, so the day is out of play
    // entirely: it can't extend the streak and it can't end one either.
    if (_habitRetiredOn(habit, ds)) { ds = _shiftDay(ds, -1); }
    else if (_habitDoneOn(habit, ds)) { streak++; ds = _shiftDay(ds, -1); }
    // Voided day — excused, so carry the streak across it without crediting it.
    else if (_habitVoidedOn(habit.id, ds)) { ds = _shiftDay(ds, -1); }
    // Off day of a pick-days habit — it wasn't asked for, so it carries too.
    else if (_habitOffDay(habit, ds) && ds >= (habit.startDate || ds)) { ds = _shiftDay(ds, -1); }
    else break;
  }
  return streak;
}

function habitStreak(habitId) {
  const habit = getHabits().find(h => h.id === habitId) || { id: habitId };
  return _habitStreakEndingOn(habit, _shiftDay(habitDateStr(0), -1));
}

// Purely a display nudge, never fed back into the streak count itself: if
// yesterday was a genuine (non-voided/non-retired) miss that snuffed out an
// actual streak, returns how long that streak was — so the badge can show a
// "just went out" ember instead of a flat, indistinguishable "–". Returns 0
// whenever there's nothing to report (yesterday was fine, or nothing preceded it).
function _habitRecentlyBroken(habit) {
  const today = habitDateStr(0);
  let yesterday = _shiftDay(today, -1);
  for (let i = 0; i < 6 && _habitOffDay(habit, yesterday); i++) yesterday = _shiftDay(yesterday, -1);
  if (!_habitScheduledOn(habit, yesterday)) return 0;
  if (_habitDoneOn(habit, yesterday)) return 0;
  if (_habitVoidedOn(habit.id, yesterday)) return 0;
  return _habitStreakEndingOn(habit, _shiftDay(yesterday, -1));
}

// Consecutive inactive days ending yesterday — the inverse of
// _habitStreakEndingOn: walks backward counting scheduled days that were
// neither done nor voided, stopping (not counting) at the first done day, or
// at the point the habit stops being scheduled at all (its start date, or a
// prior-run boundary). Voided days are skipped transparently, same as the
// streak walk. `everDone` tells the caller whether the walk found a real
// completion (true) or ran off the habit's schedule having never found one
// (false) — the two dormant-tooltip variants need exactly this distinction.
// Capped well past a plausible habit lifetime, since unlike a streak a
// dormant stretch has no natural bound of its own.
function _habitDormantDays(habit) {
  let days = 0;
  let ds = _shiftDay(habitDateStr(0), -1);
  for (let i = 0; i < 3650; i++) {
    if (_habitOffDay(habit, ds) && ds >= (habit.startDate || ds)) { ds = _shiftDay(ds, -1); continue; }
    if (!_habitScheduledOn(habit, ds)) return { days, everDone: false };
    if (_habitDoneOn(habit, ds)) return { days, everDone: true };
    if (_habitVoidedOn(habit.id, ds)) { ds = _shiftDay(ds, -1); continue; }
    days++;
    ds = _shiftDay(ds, -1);
  }
  return { days, everDone: false };
}

// Move an archived habit back into the active list, picking its day count up
// where it stopped rather than starting over. The days already served are banked
// as a finished run; the dormant stretch since archiving is simply skipped.
function _restartHabit(habit, allHabits) {
  const today = habitDateStr(0);
  const upTo  = habit.archivedAt ? String(habit.archivedAt).slice(0, 10) : null;
  // The archive day is already out of play, so the run that just ended closes
  // the day before it.
  const runEnd = upTo ? _shiftDay(upTo, -1) : null;
  const hasRun = !!(habit.startDate && runEnd && runEnd >= habit.startDate);
  const resumeDay = _habitServedDays(habit) + 1;
  const total = _habitTotalDays(habit);

  if (!confirm(`Start "${habit.name}" again?\n\n` +
    `It picks up at day ${resumeDay}${total ? ' of ' + total : ''} from ${formatDate(today)}. ` +
    `The time it spent archived isn't counted.`)) return false;

  // Keep the finished span so its check-ins, calendar colours and share of each
  // day's completion count survive the restart.
  if (hasRun) habit.runs = _habitRuns(habit).concat({ from: habit.startDate, to: runEnd });

  // A timed habit keeps its original total: it resumes with only the days it
  // has left, so the end date lands that many days from today.
  if (habit.endDate && total) {
    habit.endDate = _shiftDay(today, Math.max(0, total - _habitPriorDays(habit) - 1));
  }
  habit.archived   = false;
  habit.archivedAt = null;
  habit.startDate  = today;
  saveHabits(allHabits);
  renderHabits();
  return true;
}

// Remove a habit and everything keyed to it. Both delete buttons route through
// here — the row one used to leave notes behind, and neither cleared the habit's
// check-ins or voids, which then sat unreachable in the store forever.
function _deleteHabit(habit, allHabits) {
  const idx = allHabits.indexOf(habit);
  if (idx !== -1) allHabits.splice(idx, 1);
  saveHabits(allHabits);

  ['habits:log:', 'habits:void:'].forEach(prefix => {
    storeListKeys(prefix).forEach(k => {
      const ids = MEM[k] || [];
      const i = ids.indexOf(habit.id);
      if (i !== -1) { ids.splice(i, 1); MEM[k] = ids; }
    });
  });
  storeListKeys('habits:count:').forEach(k => {
    const counts = MEM[k];
    if (counts && habit.id in counts) { delete counts[habit.id]; MEM[k] = counts; }
  });
  delete MEM['habit_notes:' + habit.id];
  _syncPurgeHabit(habit.id);
  renderHabits();
}

// The last 7 days, oldest first, ending today.
function _habitLast7() {
  const today = habitDateStr(0);
  return Array.from({ length: 7 }, (_, i) => _shiftDay(today, i - 6));
}

// Is today's row done? A weekly habit also counts as done for the day once its
// week's goal is met.
function _habitRowDone(h, today) {
  return _habitDoneOn(h, today) ||
    (_habitIsWeekly(h) && _habitWeekStatus(h, _weekStart(today), today).met);
}

function _habitDayLabel(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const _HAB_RING_R = 10.5;
function _habitRingHtml(count, target) {
  const C = 2 * Math.PI * _HAB_RING_R;
  const p = Math.min(1, count / target);
  const full = count >= target;
  return `<svg viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="13" cy="13" r="${_HAB_RING_R}" class="hab-ring-track${full ? ' is-full' : ''}"></circle>
      <circle cx="13" cy="13" r="${_HAB_RING_R}" class="hab-ring-fill" stroke-dasharray="${p * C} ${C}"></circle>
    </svg><b>${full ? '✓' : '+'}</b>`;
}

// One row of the Today list. `opts.inDone` marks a row in the Done today group
// (it then shows its routine tag); `opts.preview` builds an inert copy for the
// add-habit modal.
function buildHabitRow(habit, allHabits, opts) {
  opts = opts || {};
  const preview = !!opts.preview;
  const today     = habitDateStr(0);
  const weekly    = _habitIsWeekly(habit);
  const doneToday = _habitDoneOn(habit, today);
  const rowDone   = _habitRowDone(habit, today);
  const isVoided  = _habitVoidedOn(habit.id, today);
  const streak    = weekly ? 0 : habitStreak(habit.id);
  const brokenN   = (!weekly && !doneToday && streak === 0) ? _habitRecentlyBroken(habit) : 0;
  const dormant   = (!weekly && !doneToday && streak === 0 && brokenN === 0) ? _habitDormantDays(habit) : null;
  const isIncrement = _isIncrementHabit(habit);
  const target    = _habitTarget(habit, today);
  const count     = isIncrement ? getHabitCount(today, habit.id) : 0;

  const isTimed   = !!habit.endDate;
  const dayNum    = _habitDayNum(habit, today);
  const totalDays = isTimed ? _habitTotalDays(habit) : null;
  const pct       = isTimed ? Math.min(100, Math.max(0, (dayNum - 1) / Math.max(totalDays - 1, 1) * 100)) : null;
  const isExpired = isTimed && today > habit.endDate;

  const li = document.createElement('li');
  li.className = 'hab-row' + (rowDone ? ' is-done' : '') + (isVoided && !rowDone ? ' is-voided' : '');
  li.dataset.habitId = habit.id;

  const refresh = () => _flipRows(document.getElementById('habitList'), '.hab-row', renderHabits);

  if (opts.canDrag && !preview) {
    li.draggable = true;
    const drag = document.createElement('span');
    drag.className = 'habit-drag-handle';
    drag.textContent = '⋮⋮';
    drag.setAttribute('aria-hidden', 'true');
    li.appendChild(drag);
  }

  // Check-in control: a checkbox, or a progress ring that adds one per click.
  if (isIncrement) {
    const ring = document.createElement('button');
    ring.type = 'button';
    ring.className = 'hab-ring';
    ring.innerHTML = _habitRingHtml(count, target);
    ring.setAttribute('aria-label', `Add one to ${habit.name} (${count} of ${target})`);
    ring.title = count >= target ? 'Click to reset to 0' : 'Click for +1';
    if (preview) ring.tabIndex = -1;
    else ring.addEventListener('click', () => {
      const next = count >= target ? 0 : count + 1;
      setHabitCount(today, habit, next);
      refresh();
      if (next === target) showToast(`${habit.name} · ${target}/${target} done`);
    });
    li.appendChild(ring);
  } else {
    const cbWrap = document.createElement('label');
    cbWrap.className = 'habit-cb-wrap';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = doneToday;
    cb.setAttribute('aria-label', (doneToday ? 'Uncheck ' : 'Check off ') + habit.name);
    if (preview) { cb.tabIndex = -1; cb.disabled = true; }
    const cbBox = document.createElement('span');
    cbBox.className = 'habit-cb-box';
    cbWrap.appendChild(cb);
    cbWrap.appendChild(cbBox);
    if (!preview) cb.addEventListener('change', () => { _toggleHabitDone(today, habit); refresh(); });
    li.appendChild(cbWrap);
  }

  // Name, day badge and states
  const main = document.createElement('div');
  main.className = 'hab-main';
  const line = document.createElement('div');
  line.className = 'hab-line';
  const name = document.createElement('span');
  name.className = 'hab-name';
  name.textContent = habit.name;
  if (!preview) name.addEventListener('click', () => openHabitDetail(habit.id));
  line.appendChild(name);
  if (isIncrement) {
    const step = document.createElement('span');
    step.className = 'hab-step';
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.setAttribute('aria-label', 'Remove one');
    minus.disabled = preview || count <= 0;
    if (!preview) minus.addEventListener('click', () => { setHabitCount(today, habit, count - 1); refresh(); });
    step.appendChild(minus);
    step.appendChild(document.createTextNode(`${count}/${target}`));
    line.appendChild(step);
  }
  const rt = HABIT_ROUTINE_TAG[_habitRoutine(habit)];
  if (opts.inDone && rt) {
    const t = document.createElement('span');
    t.className = 'habit-meta-tag rt-' + _habitRoutine(habit);
    t.textContent = rt;
    line.appendChild(t);
  }
  main.appendChild(line);

  const meta = document.createElement('div');
  meta.className = 'habit-meta';
  const tag = (cls, text, title) => {
    const t = document.createElement('span');
    t.className = 'habit-meta-tag ' + cls;
    t.textContent = text;
    if (title) t.title = title;
    meta.appendChild(t);
  };
  if (isTimed) tag(isExpired ? 'expired' : 'timed', isExpired ? `Expired · ${totalDays}d run` : `Day ${dayNum} of ${totalDays}`);
  else tag('ongoing', `Day ${dayNum}`);
  if (weekly) {
    const st = _habitWeekStatus(habit, _weekStart(today), today);
    const bars = document.createElement('span');
    bars.className = 'hab-wkgoal';
    bars.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < _habitTimes(habit); i++) {
      const u = document.createElement('u');
      if (i < st.done) u.className = 'f';
      bars.appendChild(u);
    }
    meta.appendChild(bars);
    const t = document.createElement('span');
    t.className = 'hab-meta-text';
    t.textContent = `${Math.min(st.done, _habitTimes(habit))} of ${_habitTimes(habit)} this week`;
    meta.appendChild(t);
  } else if (_habitSchedule(habit)) {
    tag('sched', _habitScheduleLabel(habit));
  }
  if (isVoided && !rowDone) tag('voided', 'Voided today', "This day is excused — it won't break the streak or count against you");
  else if (!rowDone && brokenN > 0) tag('ended', `streak ended at ${brokenN}`, `You had a ${brokenN}-day streak — it ended yesterday. Check in today to start a new one.`);
  else if (!rowDone && dormant && dormant.days >= 2) tag('idle', `${dormant.days}d idle`, dormant.everDone
    ? `You haven't done this in ${dormant.days} days.`
    : `You haven't started this yet — it's been sitting for ${dormant.days} days.`);
  else if (!rowDone && !weekly && dayNum === 1 && streak === 0) tag('new', 'new');
  if (isIncrement && !rowDone && count < target) {
    const t = document.createElement('span');
    t.className = 'hab-meta-text';
    t.textContent = `${target - count} to go`;
    meta.appendChild(t);
  }
  main.appendChild(meta);

  if (isTimed && !rowDone) {
    const bar = document.createElement('div');
    bar.className = 'habit-progress-wrap';
    const fill = document.createElement('div');
    fill.className = 'habit-progress-fill' + (pct >= 100 ? ' complete' : '');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    main.appendChild(bar);
  }

  if (!preview) {
    const hov = document.createElement('div');
    hov.className = 'hab-hover';
    const vBtn = document.createElement('button');
    vBtn.type = 'button';
    vBtn.textContent = isVoided ? 'Un-void' : '∅ Void today';
    vBtn.addEventListener('click', () => {
      const ids = getHabitVoids(today);
      const i = ids.indexOf(habit.id);
      if (i === -1) ids.push(habit.id); else ids.splice(i, 1);
      saveHabitVoids(today, ids);
      refresh();
      showToast(i === -1 ? `Voided ${habit.name} for today` : `${habit.name} counts again today`);
    });
    const dBtn = document.createElement('button');
    dBtn.type = 'button';
    dBtn.textContent = 'Details →';
    dBtn.addEventListener('click', () => openHabitDetail(habit.id));
    hov.appendChild(vBtn);
    hov.appendChild(dBtn);
    main.appendChild(hov);
  }
  li.appendChild(main);

  // Area pill — in its old spot, just before the week strip
  const areaCell = document.createElement('span');
  areaCell.className = 'hab-area';
  if (preview) {
    const a = getAreas().find(x => x.name === habit.area);
    if (a) {
      const pill = document.createElement('span');
      pill.className = 'task-area-pill';
      pill.textContent = a.name;
      pill.style.background = a.color + 'BF';
      pill.style.color = '#fff';
      areaCell.appendChild(pill);
    }
  } else {
    areaCell.appendChild(buildAreaPill(habit.area || null, newArea => {
      habit.area = newArea;
      saveHabits(allHabits);
      renderHabits();
    }));
  }
  li.appendChild(areaCell);

  // Last 7 days, today last
  const week = document.createElement('span');
  week.className = 'hab-week';
  week.setAttribute('aria-label', 'Last 7 days');
  _habitLast7().forEach(ds => {
    const dot = document.createElement('u');
    const inPlay = _habitInPriorRun(habit, ds) || (ds >= (habit.startDate || today) && !_habitRetiredOn(habit, ds));
    let cls = '';
    if (!inPlay || _habitOffDay(habit, ds)) cls = 'off';
    else if (_habitDoneOn(habit, ds)) cls = 'done';
    else if (_habitVoidedOn(habit.id, ds)) cls = 'voided';
    else if (ds !== today && !weekly) cls = 'missed';
    if (ds === today) cls += ' today';
    dot.className = cls.trim();
    dot.title = _habitDayLabel(ds);
    week.appendChild(dot);
  });
  li.appendChild(week);

  // Streak
  const streakEl = document.createElement('span');
  streakEl.className = 'hab-streak';
  if (weekly) {
    const w = _habitWeekStreak(habit);
    streakEl.innerHTML = w > 0 ? _fireStreakBadgeHtml(w, { size: 'row', suffix: 'w' })
      : '<span class="hab-streak-none">–</span>';
    streakEl.title = w > 0 ? `${w} week${w === 1 ? '' : 's'} in a row at ${_habitTimes(habit)}×` : 'No full weeks yet';
  } else {
    const displayStreak = doneToday ? streak + 1 : streak;   // habitStreak() stops at yesterday
    if (displayStreak > 0) {
      streakEl.innerHTML = _fireStreakBadgeHtml(displayStreak, { size: 'row' });
      streakEl.title = `${displayStreak}-day streak`;
    } else if (brokenN > 0) {
      streakEl.innerHTML = _fireStreakBadgeHtml(0, { size: 'row', ember: true });
      streakEl.title = `A ${brokenN}-day streak ended yesterday`;
    } else if (dormant && dormant.days >= 2) {
      streakEl.innerHTML = _fireStreakBadgeHtml(dormant.days, { size: 'row', dormant: true });
      streakEl.title = `Not done in ${dormant.days} days`;
    } else {
      streakEl.innerHTML = '<span class="hab-streak-none">–</span>';
    }
  }
  li.appendChild(streakEl);

  return li;
}

// A finished (archived) habit: its run, and a way to start it again.
function _buildArchivedRow(habit, allHabits) {
  const li = document.createElement('li');
  li.className = 'hab-arow';
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'hab-arow-name';
  name.textContent = habit.name;
  name.addEventListener('click', () => openHabitDetail(habit.id));
  const tag = document.createElement('span');
  tag.className = 'habit-meta-tag';
  const days = habit.archivedAt ? _habitServedDays(habit) : '?';
  tag.textContent = `${days} days` + (habit.startDate && habit.archivedAt
    ? ` · ${_habitDayLabel(_habitFirstDay(habit))}–${_habitDayLabel(_shiftDay(String(habit.archivedAt).slice(0, 10), -1))}` : '');
  const restart = document.createElement('button');
  restart.type = 'button';
  restart.className = 'hab-restart';
  restart.textContent = '↺ Start again';
  restart.addEventListener('click', () => _restartHabit(habit, allHabits));
  li.append(name, tag, restart);
  return li;
}

function _habitSectionHead(label, doneN, totalN, opts) {
  opts = opts || {};
  const head = document.createElement('div');
  head.className = 'hab-group-head';
  if (opts.color) {
    const dot = document.createElement('span');
    dot.className = 'hab-group-dot';
    dot.style.background = opts.color;
    head.appendChild(dot);
  }
  const h3 = document.createElement('h3');
  h3.textContent = label;
  if (opts.routine) h3.className = 'rt-' + opts.routine;
  if (opts.color) h3.style.color = opts.color;
  head.appendChild(h3);
  const ct = document.createElement('span');
  ct.className = 'hab-group-ct' + (totalN && doneN >= totalN ? ' all' : '');
  ct.textContent = totalN == null ? String(doneN) : `${doneN}/${totalN}`;
  head.appendChild(ct);
  if (opts.note) {
    const n = document.createElement('span');
    n.className = 'hab-group-note';
    n.textContent = opts.note;
    head.appendChild(n);
  }
  const rule = document.createElement('span');
  rule.className = 'hab-group-rule';
  head.appendChild(rule);
  return head;
}

// Share of counted habits done on `ds`, or null if nothing counted that day.
function _habitDayPct(habits, ds, today) {
  const counted = _habitsCountedOn(habits, ds, today);
  if (!counted.length) return null;
  const done = counted.filter(h => _habitDoneOn(h, ds)).length;
  return Math.round(done / counted.length * 100);
}

function _renderHabitHeader(all, active, today) {
  const counted = _habitsCountedOn(active, today, today);
  const done    = counted.filter(h => _habitDoneOn(h, today)).length;
  const num = document.getElementById('habCountNum');
  num.textContent = `${done}/${counted.length}`;
  document.getElementById('habitCard').classList.toggle('hab-all-done', counted.length > 0 && done === counted.length);

  const morningLeft = active.filter(h => _habitRoutine(h) === 'morning' && !_habitOffDay(h, today) &&
    !_habitRowDone(h, today) && !_habitVoidedOn(h.id, today)).length;
  const voids = active.filter(h => _habitVoidedOn(h.id, today)).length;
  const eod   = active.filter(h => h.endOfDay && _habitScheduledOn(h, today) && !_habitDoneOn(h, today));
  const bits = [];
  if (counted.length && done === counted.length) bits.push('<em class="ok">All done for today</em>');
  else if (morningLeft) bits.push(`<em>${morningLeft} left from your morning routine</em>`);
  if (voids) bits.push(`${voids} voided`);
  if (eod.length === 1) bits.push(`“${_esc(eod[0].name)}” counts once the day ends`);
  else if (eod.length > 1) bits.push(`${eod.length} end-of-day habits count once the day ends`);
  document.getElementById('habSub').innerHTML = bits.join(' · ');

  // Last 7 days, same counting rule as the calendar rings.
  const days = _habitLast7().map(ds => _habitDayPct(all, ds, today));
  const vals = days.filter(v => v != null);
  const pill = document.getElementById('habWeekPill');
  pill.hidden = !vals.length;
  document.getElementById('habWeekBars').innerHTML = days.map(v =>
    `<u style="height:${Math.max(2, Math.round((v || 0) / 100 * 14))}px"${v == null ? ' class="none"' : ''}></u>`).join('');
  document.getElementById('habWeekPct').textContent = vals.length
    ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) + '%' : '–';
}

function renderHabits() {
  const all     = getHabits();
  const today   = habitDateStr(0);
  const group   = getHabitGroup();
  const sort    = getHabitSort();
  const active  = all.filter(h => !h.archived);
  const archived = _sortHabitsForDisplay(all.filter(h => h.archived), sort);
  const listEl  = document.getElementById('habitList');
  const emptyEl = document.getElementById('habitEmpty');

  document.querySelectorAll('.hab-group-btn').forEach(b => {
    const on = b.dataset.group === group;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  document.getElementById('habSortSel').value = sort;
  document.getElementById('habColDays').innerHTML = _habitLast7().map((ds, i) =>
    `<span${i === 6 ? ' class="today"' : ''}>${'SMTWTFS'[_dow(ds)]}</span>`).join('');

  _renderHabitHeader(all, active, today);

  // A pick-days habit on one of its off days sits out of today's list.
  const offToday = active.filter(h => _habitOffDay(h, today) && !_habitDoneOn(h, today));
  const shown    = active.filter(h => !offToday.includes(h));
  const isDone   = h => _habitRowDone(h, today);
  const canDrag  = sort === 'custom';

  listEl.innerHTML = '';
  emptyEl.style.display = active.length ? 'none' : 'block';
  document.getElementById('habCols').style.display = shown.length ? '' : 'none';
  document.getElementById('habStreakKey').style.display = shown.length ? '' : 'none';

  const sections = group === 'area'
    ? getAreas().map(a => ({ key: a.name, label: a.name, color: a.color })).concat({ key: '', label: 'No area' })
    : HABIT_ROUTINES.map(([k, l]) => ({ key: k, label: l, routine: k }));

  sections.forEach(sec => {
    const members = shown.filter(h => _habitGroupKey(h, group) === sec.key);
    const open = _sortHabitsForDisplay(members.filter(h => !isDone(h)), sort);
    if (!open.length) return;
    // Voided-today rows sit at the bottom of their section.
    open.sort((a, b) => _habitVoidedOn(a.id, today) - _habitVoidedOn(b.id, today));
    const counting = members.filter(h => !(_habitVoidedOn(h.id, today) && !isDone(h)));
    const wrap = document.createElement('div');
    wrap.className = 'hab-group';
    wrap.appendChild(_habitSectionHead(sec.label, counting.filter(isDone).length, counting.length, {
      routine: sec.routine, color: sec.color,
      note: sec.key === 'eod' && group === 'routine' ? 'counts once the day ends' : '',
    }));
    const ul = document.createElement('ul');
    ul.className = 'hab-list';
    open.forEach(h => ul.appendChild(buildHabitRow(h, all, { canDrag: canDrag && !_habitVoidedOn(h.id, today) })));
    wrap.appendChild(ul);
    listEl.appendChild(wrap);
  });

  // Done today — everything finished drops all the way down, in section order.
  const doneRows = _orderHabits(shown.filter(isDone));
  if (doneRows.length) {
    const wrap = document.createElement('div');
    wrap.className = 'hab-group hab-group-done';
    wrap.appendChild(_habitSectionHead('Done today', doneRows.length, null));
    const ul = document.createElement('ul');
    ul.className = 'hab-list';
    doneRows.forEach(h => ul.appendChild(buildHabitRow(h, all, { inDone: true })));
    wrap.appendChild(ul);
    listEl.appendChild(wrap);
  }

  if (offToday.length) {
    const off = document.createElement('div');
    off.className = 'hab-offday';
    off.append('Not scheduled today: ');
    _orderHabits(offToday).forEach((h, i) => {
      if (i) off.append(', ');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = h.name;
      b.title = _habitScheduleLabel(h);
      b.addEventListener('click', () => openHabitDetail(h.id));
      off.appendChild(b);
    });
    listEl.appendChild(off);
  }

  if (!listEl._dragWired) {
    listEl._dragWired = true;
    wireDragReorder(listEl, 'hab-row', _reorderHabitByDrag);
  }

  const archDetails = document.getElementById('archivedToggle');
  const archList = document.getElementById('archivedList');
  archList.innerHTML = '';
  archDetails.hidden = !archived.length;
  document.getElementById('archivedToggleLabel').textContent = `Completed habits · ${archived.length}`;
  archived.forEach(h => archList.appendChild(_buildArchivedRow(h, all)));

  renderHabitOverviewCalendar();

  // Keep detail page in sync if open
  if (_detailHabitId && document.getElementById('habitDetailPage').classList.contains('open')) {
    const habit = all.find(h => h.id === _detailHabitId);
    if (habit) renderHabitDetailPage(habit, all);
  }
  if (_detailDay && document.getElementById('dayDetailPage').classList.contains('open')) {
    renderDayDetail(_detailDay);
  }
}

// ── Habits-tab overview calendar ──
// One ring per day; the ring fills to the share of that day's scheduled
// habits that were completed. Mirrors the detail-view calendar's month grid.
let _hcalMonth = null; // { year, month }

// Was this habit scheduled on date `ds`? (started, not yet ended, not yet archived)
function _habitScheduledOn(h, ds) {
  if (_habitOffDay(h, ds)) return false;       // a weekday a pick-days habit skips
  if (_habitInPriorRun(h, ds)) return true;   // a finished run — its history stands
  const start = h.startDate || '0000-00-00';
  if (ds < start) return false;
  if (h.endDate && ds > h.endDate) return false;
  if (_habitRetiredOn(h, ds)) return false;
  return true;
}

// True from the archive day onward. Archiving retires a habit then and there —
// the day you archive it is already out of play, so it is neither scheduled nor
// markable from that point. Retired days render inert, the way future days do.
function _habitRetiredOn(h, ds) {
  return !!h.archivedAt && ds >= String(h.archivedAt).slice(0, 10);
}

// The habits that actually count on `ds`: scheduled that day, not an End-of-Day
// habit on a day still in progress, and not voided. Shared by the overview
// calendar ring and the day-detail view so the two can never disagree.
function _habitsCountedOn(habits, ds, today) {
  return habits.filter(h => _habitScheduledOn(h, ds)
    && !(h.endOfDay && ds === today)
    && !_habitVoidedOn(h.id, ds)
    && !(_habitIsWeekly(h) && !_habitDoneOn(h, ds)));
}

// Completion-ring colour: a continuous ramp through four regions — red, orange,
// yellow (each dark → light as the day fills), then green (light → dark) — with
// the region seams blended over ~12% around each of 25 / 50 / 75.
const _HCAL_STOPS = [
  [  0, [ 74,  14,  14]],  // red    · darkest
  [ 19, [255,  90,  90]],  // red    · lightest
  [ 31, [192, 106,  30]],  // orange · darkest
  [ 44, [255, 174,  99]],  // orange · lightest
  [ 56, [196, 165,  46]],  // yellow · darkest
  [ 69, [255, 232, 107]],  // yellow · lightest
  [ 81, [ 88, 217, 142]],  // green  · lightest
  [100, [ 31, 122,  76]],  // green  · darkest
];
function _hcalRingColor(pct) {
  const p = Math.max(0, Math.min(100, pct));
  let i = 1;
  while (i < _HCAL_STOPS.length - 1 && _HCAL_STOPS[i][0] < p) i++;
  const [p0, c0] = _HCAL_STOPS[i - 1];
  const [p1, c1] = _HCAL_STOPS[i];
  return `rgb(${lerpColor(c0, c1, (p - p0) / (p1 - p0)).join(',')})`;
}

// Dark red for a past day that had habits but zero completed (ring + day number).
const _HCAL_MISSED = 'rgb(120,26,26)';

// A day with any voided habit: slate blue, deliberately outside the completion
// ramp so a voided day reads as its own state rather than as a score.
const _HCAL_VOID = 'rgb(124,147,184)';

// The prohibition-sign bar across a ring. Endpoints sit on the r=15.5 circle
// (18 ± 15.5/√2 ≈ 7.04 / 28.96), so it spans the ring edge to edge at both sizes.
const _HCAL_SLASH_SVG = '<line class="hcal-ring-slash" x1="7" y1="7" x2="29" y2="29"></line>';

// ── Streak flame badge ──
// Which pre-rendered flame art a streak count gets — yellow to blue as it
// grows, matching real fire (hotter = bluer). Just thresholds; retune freely.
const _FIRE_TIERS = [[4, 'yellow'], [13, 'orange'], [29, 'red']];
function _fireStreakTier(count) {
  for (const [max, name] of _FIRE_TIERS) if (count <= max) return name;
  return 'blue';
}

// Which pre-rendered icy-skull art a dormant stretch gets — a bare skull
// icing over as the inactivity grows. Only checked once a habit is already
// dormant (2+ inactive days), so the floor here is implicit, not encoded in
// the array. Deliberately stricter pacing than the hot-streak tiers: fully
// iced by day 10 rather than day 30, since missing habits should sting.
const _DORMANT_TIERS = [[4, 'bare'], [9, 'frost']];
function _dormantTier(days) {
  for (const [max, name] of _DORMANT_TIERS) if (days <= max) return name;
  return 'iced';
}

// The flame icon plus its count, side by side — not baked into one image, so
// this stays a plain flex row rather than needing the overlay math a
// number-inside-the-flame treatment would.
function _fireStreakBadgeHtml(count, opts) {
  opts = opts || {};
  const sizeClass = 'habit-flame-badge--' + (opts.size || 'row');
  if (opts.ember) {
    return `<span class="habit-flame-badge ${sizeClass} habit-flame-badge--ember">
      <img class="habit-flame-img" src="img/flames/flame-ember.png" alt="">
      <span class="habit-flame-num"></span>
    </span>`;
  }
  if (opts.dormant) {
    const dTier = _dormantTier(count);
    return `<span class="habit-flame-badge ${sizeClass} habit-flame-badge--dormant habit-flame-badge--${dTier}">
      <img class="habit-flame-img" src="img/flames/flame-${dTier}.png" alt="">
      <span class="habit-flame-num"></span>
    </span>`;
  }
  const tier = _fireStreakTier(count);
  return `<span class="habit-flame-badge ${sizeClass} habit-flame-badge--${tier}">
    <img class="habit-flame-img" src="img/flames/flame-${tier}.png" alt="">
    <span class="habit-flame-num">${count}${opts.suffix ? `<small>${opts.suffix}</small>` : ''}</span>
  </span>`;
}

function renderHabitOverviewCalendar() {
  const grid = document.getElementById('hcalGrid');
  if (!grid) return;

  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];
  const DAY_LABELS = ['M','T','W','T','F','S','S'];

  const now = new Date();
  if (!_hcalMonth) _hcalMonth = { year: now.getFullYear(), month: now.getMonth() };
  const { year, month } = _hcalMonth;
  const today = habitDateStr(0);
  const habits = getHabits();

  // Bounds: back up to 12 months, no further forward than the current month
  const limitDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const atStart = year < limitDate.getFullYear() ||
                  (year === limitDate.getFullYear() && month <= limitDate.getMonth());
  const atCurrent = year === now.getFullYear() && month === now.getMonth();
  document.getElementById('hcalPrev').disabled = atStart;
  document.getElementById('hcalNext').disabled = atCurrent;
  document.getElementById('hcalMonthHeader').textContent = `${MONTH_NAMES[month]} ${year}`;

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;

  const R = 15.5;
  const C = 2 * Math.PI * R;

  let html = '';
  const monthPcts = [];
  DAY_LABELS.forEach(l => { html += `<div class="hcal-day-label">${l}</div>`; });
  for (let i = 0; i < firstDow; i++) html += '<div class="hcal-empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = ds === today;
    const isFuture = ds > today;

    const scheduled = habits.filter(h => _habitScheduledOn(h, ds) && !(h.endOfDay && isToday));
    const counted   = _habitsCountedOn(habits, ds, today);
    const voidCount = scheduled.filter(h => _habitVoidedOn(h.id, ds)).length;
    const doneIds = getHabitLog(ds);
    const doneCount = counted.filter(h => doneIds.includes(h.id)).length;
    const pct = counted.length ? Math.round(doneCount / counted.length * 100) : 0;
    // A past day (not today) that had habits but none done is a "miss" — full red
    // ring. Voided habits are out of `counted`, so a fully voided day is never a miss.
    const isMissed = ds < today && counted.length > 0 && doneCount === 0;
    const allVoided = !counted.length && voidCount > 0;

    const hasVoid  = voidCount > 0 && !isFuture;
    const isFull   = pct >= 100 && counted.length > 0;
    if (!isFuture && counted.length) monthPcts.push(pct);

    let cls = 'hcal-day';
    if (isToday) cls += ' today';
    if (isFuture) cls += ' future';
    else if (!hasVoid && !counted.length) cls += ' none-sched';
    if (isFull && !hasVoid) cls += ' full';
    if (isMissed && !hasVoid) cls += ' missed';
    if (hasVoid) cls += ' has-void';

    // A day voided in full has no counted habits and so no arc of its own — draw
    // the ring whole, so the slash lands on a complete circle rather than a gap.
    const arcPct = allVoided ? 100 : pct;
    const dash = `${(arcPct / 100) * C} ${C}`;
    const voidNote = voidCount > 0 ? ` · ${voidCount} voided` : '';
    const titleTxt = isFuture ? ds
      : allVoided ? `${ds} — all ${voidCount} habits voided`
      : `${ds} — ${doneCount}/${counted.length} habits (${pct}%)${voidNote}`;
    // transform: rotate start point to 12 o'clock, then mirror horizontally so
    // the arc grows counter-clockwise.
    const fill = hasVoid
      ? (arcPct > 0
        ? `<circle class="hcal-ring-fill" cx="18" cy="18" r="${R}" style="stroke:${_HCAL_VOID}"
             stroke-dasharray="${dash}" transform="translate(36 0) scale(-1 1) rotate(-90 18 18)"></circle>`
        : '')
      : doneCount > 0
      ? `<circle class="hcal-ring-fill" cx="18" cy="18" r="${R}" style="stroke:${_hcalRingColor(pct)}"
           stroke-dasharray="${dash}" transform="translate(36 0) scale(-1 1) rotate(-90 18 18)"></circle>`
      : isMissed
      ? `<circle class="hcal-ring-fill" cx="18" cy="18" r="${R}" style="stroke:${_HCAL_MISSED}"
           stroke-dasharray="${C} ${C}"></circle>`
      : '';

    // Void outranks every other state: a day carrying one is neither scored nor
    // failed, so it takes the slate treatment ahead of full-green or missed-red.
    // Today is the one exception on top of that: its blue halo already marks it
    // out, so its number stays plain white rather than taking any of these.
    const numColor = isToday ? null : hasVoid ? _HCAL_VOID
      : isFull ? _hcalRingColor(100) : isMissed ? _HCAL_MISSED : null;

    // The circle's interior is filled with whatever colour the ring itself is
    // drawn in above — same branches as `fill` — at any %, not just the 0/100
    // extremes, so the day reads as "how far along" even before you look at the
    // arc. A day with no arc yet (e.g. today before anything's checked off)
    // gets no fill, matching its neutral ring.
    const bgFill = hasVoid
      ? (arcPct > 0
        ? `<circle class="hcal-ring-bg" cx="18" cy="18" r="13" fill="${_HCAL_VOID}" fill-opacity="0.28"></circle>`
        : '')
      : doneCount > 0
      ? `<circle class="hcal-ring-bg" cx="18" cy="18" r="13" fill="${_hcalRingColor(pct)}" fill-opacity="0.28"></circle>`
      : isMissed
      ? `<circle class="hcal-ring-bg" cx="18" cy="18" r="13" fill="${_HCAL_MISSED}" fill-opacity="0.28"></circle>`
      : '';

    const dayAttrs = isFuture ? '' : ` data-date="${ds}" role="button" tabindex="0"`;
    html += `<div class="${cls}${isFuture ? '' : ' is-clickable'}"${dayAttrs} title="${titleTxt}">
      <svg class="hcal-ring${hasVoid ? ' has-void' : ''}" viewBox="0 0 36 36">
        ${bgFill}
        <circle class="hcal-ring-track" cx="18" cy="18" r="${R}"></circle>
        ${fill}
        ${hasVoid ? _HCAL_SLASH_SVG : ''}
      </svg>
      <span class="hcal-day-num"${numColor ? ` style="color:${numColor}"` : ''}>${d}</span>
    </div>`;
  }

  const totalCells = firstDow + daysInMonth;
  const trailing = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 0; i < trailing; i++) html += '<div class="hcal-empty"></div>';

  grid.innerHTML = html;
  const avg = document.getElementById('hcalAvg');
  if (avg) avg.textContent = monthPcts.length
    ? Math.round(monthPcts.reduce((x, y) => x + y, 0) / monthPcts.length) + '%' : '–';
}

document.getElementById('hcalPrev').addEventListener('click', () => {
  const { year, month } = _hcalMonth;
  _hcalMonth = month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
  renderHabitOverviewCalendar();
});
document.getElementById('hcalNext').addEventListener('click', () => {
  const { year, month } = _hcalMonth;
  _hcalMonth = month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
  renderHabitOverviewCalendar();
});

// Click / keyboard on a calendar day → open that day's detail view. Delegated on
// the stable #hcalGrid element (only its innerHTML is swapped each render).
const _hcalGrid = document.getElementById('hcalGrid');
_hcalGrid.addEventListener('click', e => {
  const cell = e.target.closest('.hcal-day[data-date]');
  if (cell) openDayDetail(cell.dataset.date);
});
_hcalGrid.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const cell = e.target.closest('.hcal-day[data-date]');
  if (cell) { e.preventDefault(); openDayDetail(cell.dataset.date); }
});

// ── Habit Detail Page ──
let _detailHabitId = null;
let _detailWeekOffset = 0;        // 0 = the 13 weeks ending this week
const _HD_WEEKS = 13;
function openHabitDetail(habitId) {
  _detailHabitId = habitId;
  _detailWeekOffset = 0;
  const all = getHabits();
  const habit = all.find(h => h.id === habitId);
  if (!habit) return;
  renderHabitDetailPage(habit, all);
  renderHabitNotesPanel(habit);
  const page = document.getElementById('habitDetailPage');
  page.scrollTop = 0;
  page.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeHabitDetail() {
  document.getElementById('habitDetailPage').classList.remove('open');
  document.body.style.overflow = '';
  _detailHabitId = null;
}

// Is `ds` a day this habit was asked for? (in a run, not an off day, not voided)
function _habitExpectedOn(h, ds) {
  return _habitScheduledOn(h, ds) && !_habitVoidedOn(h.id, ds);
}

// Longest run ever, by the same rules as the live streak: voided, off and
// archived days carry it, a scheduled miss ends it.
function _habitBestStreak(h) {
  const today = habitDateStr(0);
  if (_habitIsWeekly(h)) {
    let run = 0, best = 0;
    const first = _weekStart(_habitFirstDay(h));
    for (let ws = first; ws <= today; ws = _shiftDay(ws, 7)) {
      const current = ws === _weekStart(today);
      const st = _habitWeekStatus(h, ws, current ? today : _shiftDay(ws, 6));
      if (st.avail === 0) continue;
      if (st.met) { run++; best = Math.max(best, run); }
      else if (!current) run = 0;
    }
    return best;
  }
  let run = 0, best = 0;
  for (let ds = _habitFirstDay(h); ds <= today; ds = _shiftDay(ds, 1)) {
    if (_habitDoneOn(h, ds)) { run++; best = Math.max(best, run); }
    else if (ds === today || !_habitExpectedOn(h, ds)) continue;
    else run = 0;
  }
  return best;
}

// Completion over the last 30 days, plus a running rate per day for the sparkline.
function _habitRate30(h) {
  const today = habitDateStr(0);
  const pts = [];
  let done = 0, expected = 0;
  for (let i = 29; i >= 0; i--) {
    const ds = _shiftDay(today, -i);
    const d = _habitDoneOn(h, ds);
    if (_habitIsWeekly(h)) {
      if (_habitScheduledOn(h, ds)) { expected += _habitTimes(h) / 7; if (d) done++; }
    } else if (d) { done++; expected++; }
    else if (ds !== today && _habitExpectedOn(h, ds)) expected++;
    if (expected > 0) pts.push(Math.min(1, done / expected));
  }
  return { pct: expected > 0 ? Math.min(100, Math.round(done / expected * 100)) : null, pts };
}

function _sparkSvg(pts) {
  if (pts.length < 2) return '';
  const xy = pts.map((p, i) => `${(i / (pts.length - 1) * 100).toFixed(1)},${(20 - p * 18).toFixed(1)}`);
  const last = xy[xy.length - 1].split(',');
  return `<svg class="hd-spark" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${xy.join(' ')}" fill="none" stroke="#6BE3A4" stroke-width="1.5" vector-effect="non-scaling-stroke"></polyline>
    <circle cx="${last[0]}" cy="${last[1]}" r="2" fill="#6BE3A4"></circle></svg>`;
}

function _hdSeg(key, options, current) {
  return `<div class="at-seg" data-set="${key}">${options.map(([v, l]) =>
    `<button type="button" data-v="${v}"${v === current ? ' class="on"' : ''}>${l}</button>`).join('')}</div>`;
}

function _hdDayPicker(days) {
  return [1, 2, 3, 4, 5, 6, 0].map(d =>
    `<button type="button" data-dow="${d}"${days.includes(d) ? ' class="on"' : ''} aria-pressed="${days.includes(d)}">${'SMTWTFS'[d]}</button>`).join('');
}

function renderHabitDetailPage(habit, allHabits) {
  const today = habitDateStr(0);
  const weekly = _habitIsWeekly(habit);
  const doneToday = _habitDoneOn(habit, today);
  const voidedToday = _habitVoidedOn(habit.id, today);
  const streak = weekly ? 0 : habitStreak(habit.id);
  const displayStreak = weekly ? _habitWeekStreak(habit) : (doneToday ? streak + 1 : streak);
  const brokenN = (!weekly && !doneToday && streak === 0) ? _habitRecentlyBroken(habit) : 0;
  const dormant = (!weekly && !doneToday && streak === 0 && brokenN === 0) ? _habitDormantDays(habit) : null;
  const isTimed = !!habit.endDate;
  const startDate = habit.startDate || today;
  const dayNum = _habitDayNum(habit, today);
  const totalDays = isTimed ? _habitTotalDays(habit) : null;
  const pct = isTimed ? Math.min(100, Math.max(0, (dayNum - 1) / Math.max(totalDays - 1, 1) * 100)) : null;
  const isExpired = isTimed && today > habit.endDate;
  const isArchived = !!habit.archived;
  const isIncrement = _isIncrementHabit(habit);
  const target = _habitTarget(habit, today);
  const todayCount = isIncrement ? getHabitCount(today, habit.id) : 0;
  const routine = _habitRoutine(habit);
  const sched = _habitSchedule(habit);
  const offToday = _habitOffDay(habit, today);

  // Completions in the current run, plus those banked from earlier runs.
  let totalDone = 0;
  storeListKeys('habits:log:').forEach(k => {
    const ds = k.slice('habits:log:'.length);
    if (ds > today || !_habitDoneOn(habit, ds)) return;
    if (ds >= startDate || _habitInPriorRun(habit, ds)) totalDone++;
  });
  const voidedDays = _habitVoidedCount(habit.id, startDate, today);

  // Name
  const nameEl = document.getElementById('habitDetailName');
  if (document.activeElement !== nameEl) nameEl.textContent = habit.name;
  nameEl.contentEditable = isArchived ? 'false' : 'true';
  let origName = habit.name;
  nameEl.onblur = isArchived ? null : () => {
    const val = nameEl.textContent.trim();
    if (val && val !== origName) {
      habit.name = val;
      origName = val;
      saveHabits(allHabits);
      renderHabits();
    } else if (!val) {
      nameEl.textContent = origName;
    }
  };
  nameEl.onkeydown = isArchived ? null : (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { e.stopPropagation(); nameEl.textContent = origName; nameEl.blur(); }
  };

  // Sub line: area · routine · schedule · day
  const areaObj = getAreas().find(a => a.name === habit.area);
  const subBits = [];
  if (areaObj) subBits.push(`<span class="task-area-pill" style="background:${_esc(areaObj.color)}BF;color:#fff">${_esc(areaObj.name)}</span>`);
  subBits.push(`<span>${routine === 'anytime' ? 'Anytime' : HABIT_ROUTINE_TAG[routine]}</span>`);
  subBits.push(`<span>${_esc(_habitScheduleLabel(habit))}</span>`);
  subBits.push(isArchived
    ? `<span>Completed · ${_habitServedDays(habit)} days</span>`
    : `<span>Day ${dayNum}${isTimed ? ' of ' + totalDays : ''}, since ${_habitDayLabel(_habitFirstDay(habit))}</span>`);
  document.getElementById('habitDetailSub').innerHTML = subBits.join('<span class="hd-sub-dot">·</span>');

  // Stats
  const best = _habitBestStreak(habit);
  const rate = _habitRate30(habit);
  const unit = weekly ? 'w' : '';
  const streakVal = displayStreak > 0
    ? _fireStreakBadgeHtml(displayStreak, { size: 'stat', suffix: unit })
    : brokenN > 0 ? _fireStreakBadgeHtml(0, { size: 'stat', ember: true })
    : (dormant && dormant.days >= 2) ? _fireStreakBadgeHtml(dormant.days, { size: 'stat', dormant: true })
    : '<span class="hd-stat-num">–</span>';
  const streakSub = weekly ? 'weeks in a row'
    : displayStreak > 0 ? (doneToday ? 'days, incl. today' : 'days, through yesterday')
    : brokenN > 0 ? `ended at ${brokenN}`
    : (dormant && dormant.days >= 2) ? `${dormant.days}d idle` : 'not started';
  const onIt = displayStreak > 0 && displayStreak >= best;
  document.getElementById('habitDetailStats').innerHTML = `
    <div class="hd-stats">
      <div class="hd-stat"><span class="hd-stat-label">Streak</span><span class="hd-stat-val">${streakVal}</span><span class="hd-stat-sub">${streakSub}</span></div>
      <div class="hd-stat"><span class="hd-stat-label">Best</span><span class="hd-stat-val"><span class="hd-stat-num">${best}${best ? unit : ''}</span></span>
        <span class="hd-stat-sub${onIt ? ' good' : ''}">${!best ? '–' : onIt ? "you're on it" : `${best - displayStreak}${unit} to beat it`}</span></div>
      <div class="hd-stat"><span class="hd-stat-label">30 days</span><span class="hd-stat-val"><span class="hd-stat-num">${rate.pct == null ? '–' : rate.pct}<small>${rate.pct == null ? '' : '%'}</small></span></span>${_sparkSvg(rate.pts)}</div>
      <div class="hd-stat"><span class="hd-stat-label">Total</span><span class="hd-stat-val"><span class="hd-stat-num">${totalDone}</span></span>
        <span class="hd-stat-sub">${voidedDays ? `${voidedDays} voided` : 'check-ins'}</span></div>
    </div>
    ${isTimed ? `
    <div class="hd-progress">
      <div class="hd-progress-bar"><div class="habit-progress-fill${pct >= 100 ? ' complete' : ''}" style="width:${pct}%"></div></div>
      <span>${isExpired ? 'Completed' : `Day ${dayNum} of ${totalDays}`}</span>
    </div>` : ''}`;

  // Check-in, settings, archive/delete
  let checkin;
  if (isArchived) {
    checkin = `
      <div class="hd-checkin is-archived">
        <div class="hd-checkin-tx"><b>Completed habit</b><span>${habit.archivedAt ? 'Archived ' + formatDate(habit.archivedAt) : 'Archived'}</span></div>
        <button class="btn-add" id="habitDetailRestart" type="button">Start again</button>
      </div>`;
  } else {
    const wk = weekly ? _habitWeekStatus(habit, _weekStart(today), today) : null;
    const title = voidedToday && !doneToday ? 'Voided today'
      : doneToday ? 'Done for today' : 'Check in for today';
    const sub = voidedToday && !doneToday ? `${formatDate(today)} · excused, the streak carries over`
      : weekly ? `${formatDate(today)} · ${Math.min(wk.done, _habitTimes(habit))} of ${_habitTimes(habit)} this week`
      : offToday && !doneToday ? `${formatDate(today)} · not scheduled today — ticking it still counts`
      : doneToday ? `${formatDate(today)} · streak is ${displayStreak} day${displayStreak === 1 ? '' : 's'}`
      : streak > 0 ? `${formatDate(today)} · keeps the ${streak}-day streak going` : formatDate(today);
    const ctl = isIncrement ? `
        <div class="habit-stepper">
          <button class="habit-stepper-btn" id="habitCountMinus" type="button" ${todayCount <= 0 ? 'disabled' : ''} aria-label="Remove one">−</button>
          <span class="habit-stepper-count${todayCount >= target ? ' complete' : ''}">${todayCount} / ${target}</span>
          <button class="habit-stepper-btn" id="habitCountPlus" type="button" ${todayCount >= target ? 'disabled' : ''} aria-label="Add one">+</button>
        </div>`
      : `<button class="hd-cb" id="habitDetailCb" type="button" aria-pressed="${doneToday}" aria-label="${doneToday ? 'Uncheck today' : 'Check in for today'}"></button>`;
    checkin = `
      <div class="hd-checkin${doneToday ? ' is-done' : ''}${voidedToday && !doneToday ? ' is-voided' : ''}">
        ${isIncrement ? '' : ctl}
        <div class="hd-checkin-tx"><b>${title}</b><span>${sub}</span></div>
        ${isIncrement ? ctl : ''}
        <button class="hab-chip hab-chip-void" id="hdVoidToday" type="button">${voidedToday ? 'Un-void' : '∅ Void today'}</button>
      </div>`;
  }

  const days = sched && sched.type === 'days' ? sched.days : [1, 3, 5];
  const times = sched && sched.type === 'weekly' ? sched.times : 3;
  const settings = isArchived ? '' : `
    <div class="hd-settings">
      <div class="hd-set"><span class="hd-set-k">Routine</span>
        ${_hdSeg('routine', HABIT_ROUTINES, routine)}</div>
      <div class="hd-set"><span class="hd-set-k">Tracking</span><div class="at-row">
        ${_hdSeg('track', [['checkbox', 'Check off'], ['increment', 'Count']], isIncrement ? 'increment' : 'checkbox')}
        ${isIncrement ? `<span class="at-row"><input type="number" min="1" step="1" class="task-date-input hab-num" id="habitTargetInput" value="${_habitTarget(habit)}" aria-label="Target per day"><span class="at-none">a day</span></span>` : ''}
      </div></div>
      ${isIncrement ? `<div class="hd-set"><span class="hd-set-k">Target on</span><div class="at-row">
        <input type="date" class="task-date-input" id="hdTargetDate" value="${today}" min="${startDate}" aria-label="Day to change the target for">
        <input type="number" min="1" step="1" class="task-date-input hab-num" id="hdTargetDay" value="${target}" aria-label="Target that day">
        <span class="at-none" id="hdTargetNote">${habit.targets && habit.targets[today] ? 'that day only' : 'default'}</span>
      </div></div>` : ''}
      <div class="hd-set"><span class="hd-set-k">Schedule</span><div class="at-row">
        ${_hdSeg('sched', [['daily', 'Every day'], ['days', 'Pick days'], ['weekly', '× a week']], sched ? sched.type : 'daily')}
        ${sched && sched.type === 'days' ? `<span class="hab-daypick" id="hdDays">${_hdDayPicker(days)}</span>` : ''}
        ${sched && sched.type === 'weekly' ? `<span class="at-row"><input type="number" min="1" max="6" step="1" class="task-date-input hab-num" id="hdTimes" value="${times}" aria-label="Times per week"><span class="at-none">times</span></span>` : ''}
      </div></div>
      <div class="hd-set"><span class="hd-set-k">Area</span><div class="at-areas" id="hdAreas">
        <button type="button" class="task-area-pill is-empty${habit.area ? '' : ' is-picked'}" data-area="">No area</button>
        ${getAreas().map(a => `<button type="button" class="task-area-pill${habit.area === a.name ? ' is-picked' : ''}" data-area="${_esc(a.name)}" style="background:${_esc(a.color)}BF;color:#fff">${_esc(a.name)}</button>`).join('')}
      </div></div>
      <div class="hd-set"><span class="hd-set-k">Dates</span><div class="at-row">
        <input type="date" class="task-date-input" id="habitStartDateInput" value="${startDate}" max="${today}" aria-label="Start date">
        <span class="at-none">→</span>
        ${_hdSeg('len', [['ongoing', 'Ongoing'], ['ends', 'Ends…']], habit.endDate ? 'ends' : 'ongoing')}
        ${habit.endDate ? `<input type="date" class="task-date-input" id="hdEndDate" value="${habit.endDate}" min="${startDate}" aria-label="End date">` : ''}
      </div></div>
    </div>`;

  document.getElementById('habitDetailActions').innerHTML = `
    ${checkin}
    ${settings}
    <div class="hd-danger">
      ${isArchived ? '<span></span>' : '<button class="hd-archive" id="habitDetailArchive" type="button">Archive as completed</button>'}
      <button class="hd-delete" id="habitDetailDelete" type="button">Delete habit…</button>
    </div>`;

  renderHabitHistoryGrid(habit);

  const save = () => { saveHabits(allHabits); renderHabits(); };

  if (isArchived) {
    // renderHabits() re-renders this page via its sync block, so the view flips
    // to the active layout in place rather than closing.
    document.getElementById('habitDetailRestart')
      .addEventListener('click', () => _restartHabit(habit, allHabits));
  } else {
    if (isIncrement) {
      document.getElementById('habitCountPlus').addEventListener('click', () => {
        setHabitCount(today, habit, getHabitCount(today, habit.id) + 1);
        renderHabits();
      });
      document.getElementById('habitCountMinus').addEventListener('click', () => {
        setHabitCount(today, habit, getHabitCount(today, habit.id) - 1);
        renderHabits();
      });
    } else {
      document.getElementById('habitDetailCb').addEventListener('click', () => {
        _toggleHabitDone(today, habit);
        renderHabits();
      });
    }
    document.getElementById('hdVoidToday').addEventListener('click', () => {
      const ids = getHabitVoids(today);
      const i = ids.indexOf(habit.id);
      if (i === -1) ids.push(habit.id); else ids.splice(i, 1);
      saveHabitVoids(today, ids);
      renderHabits();
    });

    const actions = document.getElementById('habitDetailActions');
    actions.querySelectorAll('.at-seg[data-set]').forEach(seg => seg.addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b || b.classList.contains('on')) return;
      const v = b.dataset.v;
      const key = seg.dataset.set;
      if (key === 'routine') _setHabitRoutine(habit, v);
      else if (key === 'track') {
        habit.trackType = v;
        if (v === 'increment' && !habit.target) habit.target = 1;
      } else if (key === 'sched') {
        if (v === 'daily') delete habit.schedule;
        else if (v === 'days') habit.schedule = { type: 'days', days: [1, 3, 5] };
        else habit.schedule = { type: 'weekly', times: 3 };
      } else if (key === 'len') {
        if (v === 'ongoing') delete habit.endDate;
        else habit.endDate = _shiftDay(today > startDate ? today : startDate, 29);
      }
      save();
    }));

    const dayPick = document.getElementById('hdDays');
    if (dayPick) dayPick.addEventListener('click', e => {
      const b = e.target.closest('button[data-dow]');
      if (!b) return;
      const d = +b.dataset.dow;
      const set = new Set(habit.schedule.days);
      if (set.has(d)) { if (set.size === 1) return; set.delete(d); } else set.add(d);
      habit.schedule = { type: 'days', days: [...set].sort() };
      save();
    });
    const numInput = (id, apply) => {
      const el = document.getElementById(id);
      if (!el) return;
      const commit = () => apply(parseInt(el.value, 10));
      el.addEventListener('change', commit);
      el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    };
    numInput('hdTimes', v => {
      const t = Math.max(1, Math.min(6, v || 1));
      if (t === habit.schedule.times) return;
      habit.schedule = { type: 'weekly', times: t };
      save();
    });
    numInput('habitTargetInput', v => {
      const t = Math.max(1, v || 1);
      if (t === _habitTarget(habit)) return;
      habit.target = t;
      saveHabits(allHabits);
      // Re-check today's done-ness against the new target without changing the tally.
      setHabitCount(today, habit, getHabitCount(today, habit.id));
      renderHabits();
    });
    // One-day override of the target. Setting it back to the default clears it.
    const tDate = document.getElementById('hdTargetDate');
    const tDay  = document.getElementById('hdTargetDay');
    if (tDate && tDay) {
      const showDay = () => {
        tDay.value = _habitTarget(habit, tDate.value);
        document.getElementById('hdTargetNote').textContent =
          habit.targets && habit.targets[tDate.value] ? 'that day only' : 'default';
      };
      tDate.addEventListener('change', () => { if (tDate.value) showDay(); });
      numInput('hdTargetDay', v => {
        const ds = tDate.value;
        if (!ds) return;
        const t = Math.max(1, v || 1);
        if (t === _habitTarget(habit, ds)) return;
        const targets = { ...(habit.targets || {}) };
        if (t === _habitTarget(habit)) delete targets[ds]; else targets[ds] = t;
        if (Object.keys(targets).length) habit.targets = targets; else delete habit.targets;
        saveHabits(allHabits);
        setHabitCount(ds, habit, getHabitCount(ds, habit.id));
        renderHabits();
      });
    }

    document.getElementById('hdAreas').addEventListener('click', e => {
      const b = e.target.closest('button[data-area]');
      if (!b) return;
      habit.area = b.dataset.area || null;
      save();
    });

    const startInput = document.getElementById('habitStartDateInput');
    startInput.addEventListener('change', () => {
      const v = startInput.value;
      if (!v || v > today || v === habit.startDate) return;
      if (habit.endDate && v > habit.endDate) return;
      habit.startDate = v;
      save();
    });
    const endInput = document.getElementById('hdEndDate');
    if (endInput) endInput.addEventListener('change', () => {
      const v = endInput.value;
      if (!v || v < startDate || v === habit.endDate) return;
      habit.endDate = v;
      save();
    });

    document.getElementById('habitDetailArchive').addEventListener('click', () => {
      if (!confirm(`Archive "${habit.name}"? It moves to Completed habits, and you can start it again later.`)) return;
      habit.archived = true;
      habit.archivedAt = today;
      saveHabits(allHabits);
      renderHabits();
      closeHabitDetail();
    });
  }

  document.getElementById('habitDetailDelete').addEventListener('click', () => {
    if (!confirm(`Permanently delete "${habit.name}" and all of its check-ins?`)) return;
    _deleteHabit(habit, allHabits);
    closeHabitDetail();
  });
}

function renderHabitNotesPanel(habit) {
  const panel = document.getElementById('habitDetailNotes');
  if (!panel) return;
  const notes = getHabitNotes(habit.id);
  const fmt = ts => new Date(ts).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  panel.innerHTML = `
    <div class="habit-detail-section-title">Notes</div>
    <div class="hd-notes-list">${
      notes.length === 0
        ? '<div class="area-detail-empty">No notes yet.</div>'
        : [...notes].reverse().map(n => `
          <div class="area-note-entry" data-note-id="${n.id}">
            <div class="hd-note-head">
              <span class="area-note-date">${fmt(n.createdAt)}</span>
              <button class="hd-note-del" title="Delete note" aria-label="Delete note">×</button>
            </div>
            <div class="area-note-body"></div>
          </div>`).join('')
    }</div>
    <div class="area-note-input-wrap">
      <textarea id="habitNoteInput" class="area-note-input" placeholder="Add a note…" rows="3"></textarea>
      <button id="habitNoteAdd" class="area-note-add-btn">Add note</button>
    </div>`;

  const refresh = () => renderHabitNotesPanel(habit);
  panel.querySelectorAll('.area-note-entry').forEach(el => {
    const n = notes.find(x => x.id === el.dataset.noteId);
    el.querySelector('.area-note-body').textContent = n ? n.text : '';
    el.querySelector('.hd-note-del').addEventListener('click', () => {
      saveHabitNotes(habit.id, getHabitNotes(habit.id).filter(x => x.id !== el.dataset.noteId));
      refresh();
    });
  });

  const inp = document.getElementById('habitNoteInput');
  const add = () => {
    const text = inp.value.trim();
    if (!text) return;
    saveHabitNotes(habit.id, getHabitNotes(habit.id).concat({ id: _noteId(), text, createdAt: Date.now() }));
    refresh();
  };
  document.getElementById('habitNoteAdd').addEventListener('click', add);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add();
  });
}

// 13 weeks of history, Monday rows down, one column per week, with the date in
// each square: green done, red missed, a dashed outline for a voided day.
function renderHabitHistoryGrid(habit) {
  const today = habitDateStr(0);
  const startDate = habit.startDate || today;
  const isArchived = !!habit.archived;
  const isIncrement = _isIncrementHabit(habit);
  const weekly = _habitIsWeekly(habit);

  const lastWeek = _shiftDay(_weekStart(today), -7 * _detailWeekOffset);
  const first = _shiftDay(lastWeek, -7 * (_HD_WEEKS - 1));
  const floor = _dayDetailFloor();
  const atStart = first <= floor;
  const atCurrent = _detailWeekOffset === 0;
  const lastDay = _shiftDay(lastWeek, 6);

  let html = `<div class="hd-hist">
    <div class="hd-hist-head">
      <span class="hab-eyebrow">${atCurrent ? 'Last 13 weeks' : `${_habitDayLabel(first)} – ${_habitDayLabel(lastDay)}`}</span>
      <span class="hd-hist-hint">Click a past day to toggle it</span>
      <span class="hd-hist-nav">
        <button class="hcal-nav-btn" id="habitCalPrev" type="button" aria-label="Earlier weeks" ${atStart ? 'disabled' : ''}>‹</button>
        <button class="hcal-nav-btn" id="habitCalNext" type="button" aria-label="Later weeks" ${atCurrent ? 'disabled' : ''}>›</button>
      </span>
    </div>
    <div class="hd-heat-wrap"><div class="hd-heat">`;

  // Month label on the week that holds the 1st of that month.
  html += '<span></span>';
  for (let w = 0; w < _HD_WEEKS; w++) {
    const [y, m, d] = _shiftDay(first, w * 7).split('-').map(Number);
    const mon = d <= 7 ? new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' }) : '';
    html += `<span class="hd-heat-month" style="grid-column:${w + 2}">${mon}</span>`;
  }
  ['M', '', 'W', '', 'F', '', 'S'].forEach((label, r) => {
    html += `<span class="hd-heat-dow" style="grid-row:${r + 2}">${label}</span>`;
    for (let w = 0; w < _HD_WEEKS; w++) {
      const ds = _shiftDay(first, w * 7 + r);
      const isFuture = ds > today;
      const isRetired = _habitRetiredOn(habit, ds);
      const isBeforeStart = ds < startDate && !_habitInPriorRun(habit, ds);
      const done = _habitDoneOn(habit, ds);
      const voided = _habitVoidedOn(habit.id, ds);
      const off = _habitOffDay(habit, ds);
      let cls = 'hd-cell';
      let title = _fullDateLabel(ds);
      if (isFuture) cls += ' fut';
      else if (isBeforeStart || isRetired) { cls += ' pre'; title += isRetired ? ' — archived' : ''; }
      else if (done) { cls += ' done'; title += ' — done'; }
      else if (voided) { cls += ' void'; title += ' — voided'; }
      else if (off) { cls += ' off'; title += ' — not scheduled'; }
      else if (ds === today || weekly) { title += ds === today ? ' — today' : ''; }
      else { cls += ' miss'; title += ' — missed'; }
      if (ds === today) cls += ' today';
      if (isIncrement && !isFuture && !isBeforeStart && !isRetired) title += ` · ${getHabitCount(ds, habit.id)}/${_habitTarget(habit, ds)}`;
      // An archived habit is a frozen record, and a count habit only changes
      // through its stepper — so neither gets clickable squares.
      const clickable = !isFuture && !isBeforeStart && !isRetired && !isArchived && !isIncrement;
      html += `<span class="${cls}${clickable ? ' clk' : ''}" style="grid-row:${r + 2};grid-column:${w + 2}"` +
        `${clickable ? ` data-date="${ds}" role="button" tabindex="0"` : ''} title="${title}">${+ds.slice(8)}</span>`;
    }
  });
  html += `</div></div>
    <div class="hd-heat-key">
      <span><i class="k-done"></i>done</span><span><i class="k-miss"></i>missed</span><span><i class="k-void"></i>voided</span>
    </div></div>`;
  document.getElementById('habitDetailHistory').innerHTML = html;

  const heat = document.querySelector('#habitDetailHistory .hd-heat');
  const toggle = cell => {
    _toggleHabitDone(cell.dataset.date, habit);
    renderHabits();
  };
  heat.addEventListener('click', e => { const c = e.target.closest('[data-date]'); if (c) toggle(c); });
  heat.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const c = e.target.closest('[data-date]');
    if (c) { e.preventDefault(); toggle(c); }
  });
  if (!atStart) document.getElementById('habitCalPrev').addEventListener('click', () => {
    _detailWeekOffset += _HD_WEEKS; renderHabitHistoryGrid(habit);
  });
  if (!atCurrent) document.getElementById('habitCalNext').addEventListener('click', () => {
    _detailWeekOffset = Math.max(0, _detailWeekOffset - _HD_WEEKS); renderHabitHistoryGrid(habit);
  });
}

// ── Day Detail Page (opened from the overview calendar) ──
let _detailDay = null; // ISO YYYY-MM-DD
// While true, each habit row shows a void toggle. Reset whenever the page opens,
// so you never void a day you only meant to look at — but kept across the ‹ ›
// day arrows, since voiding a run of days is the common case.
let _dayVoidMode = false;

// Earliest day the ‹ arrow can reach — the ISO form of the calendar's 12-month floor.
function _dayDetailFloor() {
  const n = new Date();
  return _localDateStr(new Date(n.getFullYear(), n.getMonth() - 11, 1));
}

// Shift an ISO date by whole days using the local-time constructor (matches formatDate).
function _shiftDay(ds, delta) {
  const [y, m, d] = ds.split('-').map(Number);
  return _localDateStr(new Date(y, m - 1, d + delta));
}

function _fullDateLabel(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric' });
}

function openDayDetail(ds) {
  _detailDay = ds;
  _dayVoidMode = false;
  renderDayDetail(ds);
  const page = document.getElementById('dayDetailPage');
  page.scrollTop = 0;
  page.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeDayDetail() {
  document.getElementById('dayDetailPage').classList.remove('open');
  _detailDay = null;
  const other = document.getElementById('habitDetailPage').classList.contains('open') ||
                document.getElementById('areaDetailPage').classList.contains('open');
  if (!other) document.body.style.overflow = '';
}

function renderDayDetail(ds) {
  const body = document.getElementById('dayDetailBody');
  if (!body) return;

  const today     = habitDateStr(0);
  const habits    = getHabits();
  const scheduled = habits.filter(h => _habitScheduledOn(h, ds));
  const counted   = _habitsCountedOn(habits, ds, today);
  const doneIds   = getHabitLog(ds);
  const voidIds   = getHabitVoids(ds);
  const voidCount = scheduled.filter(h => _habitVoidedOn(h.id, ds)).length;
  const doneCount = counted.filter(h => doneIds.includes(h.id)).length;
  const pct       = counted.length ? Math.round(doneCount / counted.length * 100) : 0;
  const isMissed  = ds < today && counted.length > 0 && doneCount === 0;
  const allVoided = !counted.length && voidCount > 0;

  const R = 15.5, C = 2 * Math.PI * R;
  // Mirrors the calendar ring: a day carrying any void drops its completion
  // colour and becomes one slate mark — arc, slash and label together. The
  // percentage comes off entirely, since on a voided day the number is the
  // misleading part; the summary line below still spells out the counts.
  const hasVoid = voidCount > 0;
  const arcPct  = allVoided ? 100 : pct;
  const arc = hasVoid
    ? (arcPct > 0
      ? `<circle class="hcal-ring-fill" cx="18" cy="18" r="${R}" style="stroke:${_HCAL_VOID}"
           stroke-dasharray="${(arcPct / 100) * C} ${C}" transform="translate(36 0) scale(-1 1) rotate(-90 18 18)"></circle>`
      : '')
    : doneCount > 0
    ? `<circle class="hcal-ring-fill" cx="18" cy="18" r="${R}" style="stroke:${_hcalRingColor(pct)}"
         stroke-dasharray="${(pct / 100) * C} ${C}" transform="translate(36 0) scale(-1 1) rotate(-90 18 18)"></circle>`
    : isMissed
    ? `<circle class="hcal-ring-fill" cx="18" cy="18" r="${R}" style="stroke:${_HCAL_MISSED}"
         stroke-dasharray="${C} ${C}"></circle>`
    : '';

  // rotate(45) lays the word along the slash; the translate pushes it clear of
  // the bar, into the lower-left half of the ring.
  const voidMark = hasVoid ? `${_HCAL_SLASH_SVG}
        <text class="hcal-ring-void-label" x="18" y="18" text-anchor="middle"
          transform="rotate(45 18 18) translate(0 8.6)">VOIDED</text>` : '';

  const prevDisabled = ds <= _dayDetailFloor();
  const nextDisabled = ds >= today;

  const summary = allVoided
    ? `Day voided — ${voidCount} habit${voidCount === 1 ? '' : 's'} excused, nothing counted against you.`
    : counted.length
    ? `${doneCount} of ${counted.length} habit${counted.length === 1 ? '' : 's'} completed` +
      (voidCount ? ` · ${voidCount} voided` : '')
    : 'No habits were active on this day.';

  const canDrag = getHabitSort() === 'custom';

  const areas   = getAreas();
  const sorted  = _orderHabits(scheduled);
  // Out-of-play rows sink: voided below active, done below that. Held still while
  // picking in void mode, so a row never jumps out from under the cursor.
  const _rank = h => doneIds.includes(h.id) ? 2 : voidIds.includes(h.id) ? 1 : 0;
  const ordered = _dayVoidMode ? sorted : [...sorted].sort((a, b) => _rank(a) - _rank(b));
  const rows = ordered.map(h => {
    const isDone   = doneIds.includes(h.id);
    const isVoided = voidIds.includes(h.id);
    // A voided habit you managed to do anyway just reads as done — the void is
    // dormant. The ∅ toggle still shows it, so it stays visible and undoable.
    const voidActive = isVoided && !isDone;
    // An archived habit is a frozen record — its check-ins can't be changed from
    // any day, so the row renders inert rather than offering a live checkbox.
    const isLocked = !!h.archived;
    const rowDrag  = canDrag && !isDone && !_dayVoidMode && !isLocked;
    const areaObj = h.area && areas.find(a => a.name === h.area);
    const areaTag = areaObj
      ? `<span class="day-detail-habit-area" style="background:${_esc(areaObj.color)}BF">${_esc(areaObj.name)}</span>`
      : '';
    const isIncrement = _isIncrementHabit(h);
    const count  = isIncrement ? getHabitCount(ds, h.id) : 0;
    const target = isIncrement ? _habitTarget(h, ds) : 0;
    // Any day (not just today) gets its own exact count here — the stepper
    // writes straight through setHabitCount(ds, ...), same as the "Today's
    // check-in" card on the habit's own detail page.
    const doneCtl = isIncrement ? `
      <div class="habit-stepper habit-stepper--compact">
        <button class="habit-stepper-btn" data-count-op="dec" data-habit-id="${h.id}"${(isLocked || count <= 0) ? ' disabled' : ''} aria-label="Decrement">−</button>
        <span class="habit-stepper-count${count >= target ? ' complete' : ''}">${count} / ${target}</span>
        <button class="habit-stepper-btn" data-count-op="inc" data-habit-id="${h.id}"${(isLocked || count >= target) ? ' disabled' : ''} aria-label="Increment">+</button>
      </div>` : `
      <label class="habit-cb-wrap">
        <input type="checkbox" data-habit-id="${h.id}"${isDone ? ' checked' : ''}${isLocked ? ' disabled' : ''}>
        <span class="habit-cb-box"></span>
      </label>`;
    return `
    <div class="day-detail-habit-row${isDone ? ' is-done' : ''}${voidActive ? ' is-voided' : ''}${isLocked ? ' is-locked' : ''}"${rowDrag ? ' draggable="true"' : ''} data-habit-id="${h.id}"${isLocked ? ' title="Archived — its check-ins are locked"' : ''}>
      ${rowDrag ? '<span class="habit-drag-handle" aria-hidden="true">⋮⋮</span>' : ''}
      ${doneCtl}
      <span class="day-detail-habit-name">${_esc(h.name)}</span>
      ${isLocked ? '<span class="habit-meta-tag archived-tag">Archived</span>' : ''}
      ${voidActive ? '<span class="habit-meta-tag voided">Voided</span>' : ''}
      ${h.endOfDay ? '<span class="habit-meta-tag eod">End of Day</span>' : ''}
      ${h.morningRoutine ? '<span class="habit-meta-tag morning">Morning Routine</span>' : ''}
      ${h.nightRoutine ? '<span class="habit-meta-tag night">Night Routine</span>' : ''}
      ${areaTag}
      ${_dayVoidMode && !isLocked ? `<button class="day-void-toggle${isVoided ? ' active' : ''}" data-void-id="${h.id}"
        title="${isVoided ? 'Un-void this habit' : "Void this habit — it won't count on this day"}"
        aria-pressed="${isVoided}">∅</button>` : ''}
    </div>`;
  }).join('');

  const voidBar = _dayVoidMode ? `
    <div class="day-void-bar">
      <span class="day-void-hint">Pick the habits that didn't count on this day.</span>
      <button class="day-void-bulk" id="dayVoidAll">Void all</button>
      <button class="day-void-bulk" id="dayVoidNone">Clear</button>
    </div>` : '';

  body.innerHTML = `
    <div class="day-detail-head">
      <button class="hcal-nav-btn" id="dayDetailPrev"${prevDisabled ? ' disabled' : ''}>‹</button>
      <h2 class="habit-detail-name day-detail-date">${_fullDateLabel(ds)}</h2>
      <button class="hcal-nav-btn" id="dayDetailNext"${nextDisabled ? ' disabled' : ''}>›</button>
    </div>
    <div class="day-detail-summary-card">
      <div class="day-detail-ring-wrap">
        <svg class="hcal-ring day-detail-ring${hasVoid ? ' has-void' : ''}" viewBox="0 0 36 36">
          <circle class="hcal-ring-track" cx="18" cy="18" r="${R}"></circle>
          ${arc}
          ${voidMark}
        </svg>
        ${hasVoid ? '' : `<span class="day-detail-ring-pct">${pct}%</span>`}
      </div>
      <div class="day-detail-summary-text">${summary}</div>
    </div>
    ${scheduled.length ? `
      <div class="day-detail-list-head">
        <div class="habit-detail-section-title">Habits</div>
        <button class="day-void-btn${_dayVoidMode ? ' active' : ''}" id="dayVoidModeBtn">
          ${_dayVoidMode ? 'Done' : 'Void'}
        </button>
      </div>
      ${voidBar}
      <div class="day-detail-habit-list${_dayVoidMode ? ' is-void-mode' : ''}">${rows}</div>` : ''}
  `;

  const dlist = body.querySelector('.day-detail-habit-list');
  if (dlist && canDrag && !_dayVoidMode) wireDragReorder(dlist, 'day-detail-habit-row', _reorderHabitByDrag);

  const modeBtn = document.getElementById('dayVoidModeBtn');
  if (modeBtn) modeBtn.addEventListener('click', () => {
    _dayVoidMode = !_dayVoidMode;
    renderDayDetail(ds);
  });

  // Voids are stored per day as a habit-id list, mirroring the check-in log.
  // renderHabits() re-renders this page (and the rings and streaks) via its sync block.
  const _saveVoids = ids => { saveHabitVoids(ds, ids); renderHabits(); };

  // Mutate the array MEM already holds for `ds`, in place, rather than
  // building a new array (spread/map/[]) — saveHabitLog's call sites all do
  // this too. Two _syncHabitVoids calls for the same day both do "upsert
  // mine, delete everything else"; sharing the same live reference means a
  // second in-flight call sees the first call's addition already applied by
  // the time it actually runs, instead of each holding a stale snapshot that
  // can delete what the other just wrote.
  body.querySelectorAll('[data-void-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ids = getHabitVoids(ds);
      const i = ids.indexOf(btn.dataset.voidId);
      if (i === -1) ids.push(btn.dataset.voidId); else ids.splice(i, 1);
      _saveVoids(ids);
    });
  });

  const allBtn  = document.getElementById('dayVoidAll');
  const noneBtn = document.getElementById('dayVoidNone');
  if (allBtn) allBtn.addEventListener('click', () => {
    const ids = getHabitVoids(ds);
    ids.length = 0;
    scheduled.forEach(h => ids.push(h.id));
    _saveVoids(ids);
  });
  if (noneBtn) noneBtn.addEventListener('click', () => {
    const ids = getHabitVoids(ds);
    ids.length = 0;
    _saveVoids(ids);
  });

  body.querySelectorAll('input[data-habit-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.disabled) return;
      const h = habits.find(x => x.id === cb.dataset.habitId);
      if (h) _toggleHabitDone(ds, h);
      // renderHabits re-renders the open day view via its sync block
      _flipRows(document.getElementById('dayDetailBody'), '.day-detail-habit-row', renderHabits);
    });
  });

  body.querySelectorAll('[data-count-op]').forEach(btn => {
    btn.addEventListener('click', () => {
      const h = habits.find(x => x.id === btn.dataset.habitId);
      if (!h) return;
      const delta = btn.dataset.countOp === 'inc' ? 1 : -1;
      setHabitCount(ds, h, getHabitCount(ds, h.id) + delta);
      _flipRows(document.getElementById('dayDetailBody'), '.day-detail-habit-row', renderHabits);
    });
  });

  if (!prevDisabled) document.getElementById('dayDetailPrev').addEventListener('click', () => {
    _detailDay = _shiftDay(ds, -1);
    document.getElementById('dayDetailPage').scrollTop = 0;
    renderDayDetail(_detailDay);
  });
  if (!nextDisabled) document.getElementById('dayDetailNext').addEventListener('click', () => {
    _detailDay = _shiftDay(ds, 1);
    document.getElementById('dayDetailPage').scrollTop = 0;
    renderDayDetail(_detailDay);
  });
}

// ── Group / sort controls ──
document.querySelectorAll('.hab-group-btn').forEach(b =>
  b.addEventListener('click', () => { if (b.dataset.group !== getHabitGroup()) setHabitGroup(b.dataset.group); }));
document.getElementById('habSortSel').addEventListener('change', e => setHabitSort(e.target.value));

// ── Add habit modal ──
const _AH = { area: null, routine: 'anytime', track: 'checkbox', sched: 'daily', days: [1, 3, 5], len: '0' };
let _ahReturnFocus = null;
const _ahEl = id => document.getElementById(id);

function _ahSeg(f, v) {
  _AH[f] = v;
  document.querySelectorAll(`#addHabitForm .at-seg[data-f="${f}"] button`).forEach(b =>
    b.classList.toggle('on', b.dataset.v === v));
  _ahEl('ahTargetWrap').hidden = _AH.track !== 'increment';
  _ahEl('ahDays').hidden = _AH.sched !== 'days';
  _ahEl('ahTimesWrap').hidden = _AH.sched !== 'weekly';
  _ahEl('ahEnd').hidden = _AH.len !== 'pick';
}

function _ahPaintAreas() {
  const box = _ahEl('ahAreas');
  box.innerHTML = `<button type="button" class="task-area-pill is-empty${_AH.area ? '' : ' is-picked'}" data-area="">No area</button>` +
    getAreas().map(a => `<button type="button" class="task-area-pill${_AH.area === a.name ? ' is-picked' : ''}" data-area="${_esc(a.name)}" style="background:${_esc(a.color)}BF;color:#fff">${_esc(a.name)}</button>`).join('');
}

function _ahPaintDays() {
  _ahEl('ahDays').innerHTML = _hdDayPicker(_AH.days);
}

function _ahDraft() {
  const today = habitDateStr(0);
  const h = {
    id: '__preview', name: _ahEl('ahName').value.trim() || 'New habit',
    startDate: today, archived: false, endOfDay: false, morningRoutine: false, nightRoutine: false,
    area: _AH.area, createdAt: new Date().toISOString(),
  };
  _setHabitRoutine(h, _AH.routine);
  if (_AH.track === 'increment') { h.trackType = 'increment'; h.target = Math.max(1, parseInt(_ahEl('ahTarget').value, 10) || 1); }
  if (_AH.sched === 'days') h.schedule = { type: 'days', days: _AH.days.slice() };
  if (_AH.sched === 'weekly') h.schedule = { type: 'weekly', times: Math.max(1, Math.min(6, parseInt(_ahEl('ahTimes').value, 10) || 1)) };
  if (_AH.len === '30' || _AH.len === '66') h.endDate = _shiftDay(today, +_AH.len - 1);
  if (_AH.len === 'pick' && _ahEl('ahEnd').value) h.endDate = _ahEl('ahEnd').value;
  return h;
}

function _ahPreview() {
  const ul = _ahEl('ahPreview');
  ul.innerHTML = '';
  ul.appendChild(buildHabitRow(_ahDraft(), [], { preview: true }));
  _ahEl('ahSubmit').disabled = !_ahEl('ahName').value.trim();
}

function openAddHabit() {
  _ahReturnFocus = document.activeElement;
  _ahEl('addHabitForm').reset();
  Object.assign(_AH, { area: null, routine: 'anytime', track: 'checkbox', sched: 'daily', days: [1, 3, 5], len: '0' });
  ['routine', 'track', 'sched', 'len'].forEach(f => _ahSeg(f, _AH[f]));
  const tomorrow = _shiftDay(habitDateStr(0), 1);
  _ahEl('ahEnd').min = tomorrow;
  _ahEl('ahEnd').value = _shiftDay(habitDateStr(0), 29);
  _ahEl('ahStatus').textContent = '';
  _ahPaintAreas();
  _ahPaintDays();
  _ahPreview();
  _ahEl('addHabitModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  _ahEl('ahName').focus();
}

function closeAddHabit() {
  _ahEl('addHabitModal').classList.remove('open');
  document.body.style.overflow = '';
  if (_ahReturnFocus && _ahReturnFocus.focus) _ahReturnFocus.focus();
}

function _ahSubmit() {
  const name = _ahEl('ahName').value.trim();
  if (!name) return;
  const today = habitDateStr(0);
  if (_AH.len === 'pick' && (!_ahEl('ahEnd').value || _ahEl('ahEnd').value <= today)) {
    _ahEl('ahStatus').textContent = 'Pick an end date after today.';
    return;
  }
  const entry = _ahDraft();
  entry.id = _habitId();
  entry.name = name;
  const habits = getHabits();
  habits.push(entry);
  saveHabits(habits);
  closeAddHabit();
  renderHabits();
  const row = document.querySelector(`#habitList .hab-row[data-habit-id="${entry.id}"]`);
  if (row) { row.classList.add('is-new'); row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  showToast(_habitOffDay(entry, today) ? `Habit added · starts ${_habitScheduleLabel(entry)}` : 'Habit added');
}

_ahEl('habAddBtn').addEventListener('click', openAddHabit);
_ahEl('ahName').addEventListener('input', _ahPreview);
_ahEl('ahTarget').addEventListener('input', _ahPreview);
_ahEl('ahTimes').addEventListener('input', _ahPreview);
_ahEl('ahEnd').addEventListener('change', _ahPreview);
_ahEl('addHabitForm').addEventListener('submit', e => { e.preventDefault(); _ahSubmit(); });
_ahEl('addHabitForm').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-close')) { closeAddHabit(); return; }
  if (b.dataset.area !== undefined) { _AH.area = b.dataset.area || null; _ahPaintAreas(); _ahPreview(); return; }
  if (b.dataset.dow !== undefined) {
    const d = +b.dataset.dow;
    const i = _AH.days.indexOf(d);
    if (i === -1) _AH.days.push(d); else if (_AH.days.length > 1) _AH.days.splice(i, 1);
    _ahPaintDays(); _ahPreview();
    return;
  }
  const seg = b.closest('.at-seg');
  if (seg) { _ahSeg(seg.dataset.f, b.dataset.v); _ahPreview(); }
});
_ahEl('addHabitModal').addEventListener('click', e => { if (e.target.id === 'addHabitModal') closeAddHabit(); });

// ── Void a day ──
let _vdSel = new Set();
let _vdWhen = 'today';

function _vdDates() {
  const today = habitDateStr(0);
  if (_vdWhen === 'today') return [today];
  if (_vdWhen === 'yday') return [_shiftDay(today, -1)];
  let from = _ahEl('vdFrom').value, to = _ahEl('vdTo').value;
  if (!from || !to) return [];
  if (from > to) [from, to] = [to, from];
  if (to > today) to = today;
  const out = [];
  for (let ds = from; ds <= to && out.length < 62; ds = _shiftDay(ds, 1)) out.push(ds);
  return out;
}

function _vdPaint() {
  const active = _orderHabits(getHabits().filter(h => !h.archived));
  _ahEl('vdPick').innerHTML = active.map(h =>
    `<button type="button" data-hid="${h.id}" class="${_vdSel.has(h.id) ? 'on' : ''}" aria-pressed="${_vdSel.has(h.id)}">${_esc(h.name)}</button>`).join('');
  document.querySelectorAll('#voidDayForm .at-seg[data-f="when"] button').forEach(b =>
    b.classList.toggle('on', b.dataset.v === _vdWhen));
  _ahEl('vdRange').hidden = _vdWhen !== 'range';
  const n = _vdSel.size;
  _ahEl('vdSubmit').textContent = n ? `Void ${n} habit${n === 1 ? '' : 's'}` : 'Void';
  _ahEl('vdSubmit').disabled = !n;
}

function openVoidDay() {
  const today = habitDateStr(0);
  _vdWhen = 'today';
  _vdSel = new Set(getHabits().filter(h => !h.archived && !_habitDoneOn(h, today)).map(h => h.id));
  _ahEl('vdFrom').value = _shiftDay(today, -2);
  _ahEl('vdTo').value = today;
  [_ahEl('vdFrom'), _ahEl('vdTo')].forEach(el => { el.min = _dayDetailFloor(); el.max = today; });
  _ahEl('vdStatus').textContent = '';
  _vdPaint();
  _ahEl('voidDayModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeVoidDay() {
  _ahEl('voidDayModal').classList.remove('open');
  document.body.style.overflow = '';
}

function _vdSubmit() {
  const dates = _vdDates();
  if (!dates.length) { _ahEl('vdStatus').textContent = 'Pick the days to void.'; return; }
  const habits = getHabits().filter(h => _vdSel.has(h.id));
  let n = 0;
  dates.forEach(ds => {
    // Mutate the day's live array in place (see renderDayDetail for why).
    const ids = getHabitVoids(ds);
    let changed = false;
    habits.forEach(h => {
      if (_habitScheduledOn(h, ds) && !ids.includes(h.id)) { ids.push(h.id); changed = true; n++; }
    });
    if (changed) saveHabitVoids(ds, ids);
  });
  closeVoidDay();
  renderHabits();
  const when = _vdWhen === 'today' ? 'today' : _vdWhen === 'yday' ? 'yesterday'
    : dates.length === 1 ? _habitDayLabel(dates[0]) : `${_habitDayLabel(dates[0])}–${_habitDayLabel(dates[dates.length - 1])}`;
  showToast(n ? `Voided ${habits.length} habit${habits.length === 1 ? '' : 's'} for ${when}` : 'Nothing to void on those days');
}

_ahEl('habVoidBtn').addEventListener('click', openVoidDay);
_ahEl('voidDayForm').addEventListener('submit', e => { e.preventDefault(); _vdSubmit(); });
_ahEl('voidDayForm').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-close')) { closeVoidDay(); return; }
  if (b.id === 'vdAll') {
    const all = getHabits().filter(h => !h.archived).map(h => h.id);
    _vdSel = _vdSel.size === all.length ? new Set() : new Set(all);
    _vdPaint();
    return;
  }
  if (b.dataset.hid) { _vdSel.has(b.dataset.hid) ? _vdSel.delete(b.dataset.hid) : _vdSel.add(b.dataset.hid); _vdPaint(); return; }
  const seg = b.closest('.at-seg');
  if (seg) { _vdWhen = b.dataset.v; _vdPaint(); }
});
_ahEl('voidDayModal').addEventListener('click', e => { if (e.target.id === 'voidDayModal') closeVoidDay(); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (_ahEl('addHabitModal').classList.contains('open')) { closeAddHabit(); return; }
    if (_ahEl('voidDayModal').classList.contains('open')) { closeVoidDay(); return; }
  }
  // N opens the add modal — on the Habits tab, when nothing else has the keyboard.
  if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey &&
      document.getElementById('tab-habits').classList.contains('active') &&
      !document.querySelector('.sr-modal.open') &&
      !document.querySelector('.habit-detail-page.open') &&
      !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) &&
      !document.activeElement.isContentEditable) {
    e.preventDefault();
    openAddHabit();
  }
});

document.getElementById('habitDetailBack').addEventListener('click', closeHabitDetail);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('habitDetailPage').classList.contains('open') &&
      !document.querySelector('.sr-modal.open')) closeHabitDetail();
});

document.getElementById('dayDetailBack').addEventListener('click', closeDayDetail);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('dayDetailPage').classList.contains('open')) closeDayDetail();
});
