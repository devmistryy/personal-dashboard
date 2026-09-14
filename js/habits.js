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
function getHabitLog(dateStr)     { return MEM['habits:log:' + dateStr] || []; }
function saveHabitLog(dateStr, ids) { MEM['habits:log:' + dateStr] = ids; _syncHabitLog(dateStr, ids); }

// ── Voided (excused) habit-days ──
// A voided (habit, day) pair didn't count — illness, travel, a hospital stay.
// It never breaks a streak, never counts toward the day's completion %, and
// never increments the habit's "Day N". A habit you voided but still managed to
// do counts as a normal win: voiding only ever removes a penalty, never a
// completion — hence the `!getHabitLog(...)` guard in `_habitVoidedOn`, which is
// the single predicate every other site below asks.
function getHabitVoids(dateStr)      { return MEM['habits:void:' + dateStr] || []; }
function saveHabitVoids(dateStr, ids) { MEM['habits:void:' + dateStr] = ids; _syncHabitVoids(dateStr, ids); }

function _habitVoidedOn(habitId, ds) {
  return getHabitVoids(ds).includes(habitId) && !getHabitLog(ds).includes(habitId);
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

// ── Habit sort mode ──
function getHabitSort()      { return MEM['habit_sort_v1'] || 'custom'; }
function setHabitSort(mode)  { MEM['habit_sort_v1'] = mode; _syncSetting('habit_sort_v1', mode); renderHabits(); }

function _habitCreatedKey(h) { return h.createdAt || h.startDate || ''; }

// Returns a new array sorted for display. `MEM['habits:list']` is never mutated —
// its order is the canonical "custom" order and the tiebreak for the other modes.
function _sortHabitsForDisplay(list, mode) {
  const pos = new Map(list.map((h, i) => [h.id, i]));
  const byCustom = (a, b) => pos.get(a.id) - pos.get(b.id);
  const arr = [...list];
  if (mode === 'az') {
    arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || byCustom(a, b));
  } else if (mode === 'newest') {
    arr.sort((a, b) => _habitCreatedKey(b).localeCompare(_habitCreatedKey(a)) || byCustom(a, b));
  } else if (mode === 'oldest') {
    arr.sort((a, b) => _habitCreatedKey(a).localeCompare(_habitCreatedKey(b)) || byCustom(a, b));
  } else if (mode === 'area') {
    arr.sort((a, b) => {
      const aa = a.area || '', ba = b.area || '';
      if (!!aa !== !!ba) return aa ? -1 : 1;            // no-area group last
      return aa.localeCompare(ba, undefined, { sensitivity: 'base' }) || byCustom(a, b);
    });
  }
  return arr; // 'custom' / unknown → stored order
}

const _HABIT_SORT_MODES = [
  ['custom', 'Custom'], ['az', 'A–Z'], ['area', 'Area'], ['newest', 'Newest'], ['oldest', 'Oldest'],
];

function _habitSortBarHTML() {
  const mode = getHabitSort();
  return `<div class="habit-sort-bar"><span class="habit-sort-label">Sort By:</span>${
    _HABIT_SORT_MODES.map(([v, l]) =>
      `<button class="habit-sort-btn${v === mode ? ' active' : ''}" data-sort="${v}">${l}</button>`).join('')
  }</div>`;
}

function _syncHabitSortButtons() {
  const mode = getHabitSort();
  document.querySelectorAll('.habit-sort-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === mode));
}

// Shared drag-reorder handler for both the tracker list and the day-detail checklist.
// `fromEl`/`toEl` are the dragged and drop-target row elements (keyed by data-habit-id).
function _reorderHabitByDrag(fromEl, toEl) {
  const m = getHabitSort();
  if (m !== 'custom' && m !== 'area') return;
  const fromId = fromEl.dataset.habitId, toId = toEl.dataset.habitId;
  if (!fromId || !toId || fromId === toId) return;
  const list    = getHabits();
  const dragged = list.find(h => h.id === fromId);
  const target  = list.find(h => h.id === toId);
  if (!dragged || !target) return;
  if (m === 'area' && (dragged.area || null) !== (target.area || null)) return;
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
  const yesterday = _shiftDay(today, -1);
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
  delete MEM['habit_notes:' + habit.id];
  _syncPurgeHabit(habit.id);
  renderHabits();
}

function getCurrentWeekDates() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setDate(now.getDate() + diffToMonday + i);
    return _localDateStr(d);
  });
}

function buildHabitRow(habit, allHabits, isArchived, canDrag) {
  const today    = habitDateStr(0);
  const todayLog = getHabitLog(today);
  const done     = _habitDoneOn(habit, today);
  const streak   = habitStreak(habit.id);
  const brokenN  = (!done && streak === 0) ? _habitRecentlyBroken(habit) : 0;
  const dormant  = (!done && streak === 0 && brokenN === 0) ? _habitDormantDays(habit) : null;

  const isTimed   = !!habit.endDate;
  const dayNum    = _habitDayNum(habit, today);
  const isVoided  = _habitVoidedOn(habit.id, today);
  const totalDays = isTimed ? _habitTotalDays(habit) : null;
  const pct       = isTimed ? Math.min(100, Math.max(0, (dayNum - 1) / Math.max(totalDays - 1, 1) * 100)) : null;
  const isExpired = isTimed && today > habit.endDate;

  const li = document.createElement('li');
  li.className = 'habit-row' + (done ? ' is-done' : '') + (isArchived ? ' is-archived' : '')
    + (isVoided ? ' is-voided' : '');
  li.dataset.habitId = habit.id;

  // Drag-to-reorder — only in Custom / By-area modes, not-done active habits
  if (!isArchived && canDrag && !done) {
    li.draggable = true;
    const drag = document.createElement('span');
    drag.className = 'habit-drag-handle';
    drag.textContent = '⋮⋮';
    drag.setAttribute('aria-hidden', 'true');
    li.appendChild(drag);
  }

  // Checkbox (disabled if archived)
  const cbWrap = document.createElement('label');
  cbWrap.className = 'habit-cb-wrap';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = done;
  if (isArchived) cb.disabled = true;
  const cbBox = document.createElement('span');
  cbBox.className = 'habit-cb-box';
  cbWrap.appendChild(cb);
  cbWrap.appendChild(cbBox);
  if (!isArchived) {
    cb.addEventListener('change', () => {
      const log = getHabitLog(today);
      if (cb.checked) { if (!log.includes(habit.id)) log.push(habit.id); }
      else { const i = log.indexOf(habit.id); if (i !== -1) log.splice(i, 1); }
      saveHabitLog(today, log);
      _flipRows(document.getElementById('habitList'), '.habit-row', renderHabits);
    });
  }
  li.appendChild(cbWrap);

  // Name column
  const nameCol = document.createElement('div');
  nameCol.className = 'habit-name-col';

  const name = document.createElement('span');
  name.className = 'habit-name';
  name.textContent = habit.name;

  nameCol.addEventListener('click', () => openHabitDetail(habit.id));
  nameCol.appendChild(name);

  // Meta line
  const meta = document.createElement('div');
  meta.className = 'habit-meta';

  const tag = document.createElement('span');
  if (isArchived) {
    tag.className = 'habit-meta-tag';
    const archivedDays = habit.archivedAt ? _habitServedDays(habit) : '?';
    tag.textContent = `Completed · ${archivedDays}d`;
  } else if (isTimed) {
    tag.className = isExpired ? 'habit-meta-tag expired' : 'habit-meta-tag timed';
    tag.textContent = isExpired
      ? `Expired · ${totalDays}d run`
      : `Day ${dayNum} of ${totalDays}`;
  } else {
    tag.className = 'habit-meta-tag ongoing';
    tag.textContent = `Day ${dayNum}`;
  }
  meta.appendChild(tag);
  if (isVoided) {
    const voidTag = document.createElement('span');
    voidTag.className = 'habit-meta-tag voided';
    voidTag.textContent = 'Voided today';
    voidTag.title = "This day is excused — it won't break the streak or count against you";
    meta.appendChild(voidTag);
  }
  if (habit.endOfDay) {
    const eodTag = document.createElement('span');
    eodTag.className = 'habit-meta-tag eod';
    eodTag.textContent = 'End of Day';
    meta.appendChild(eodTag);
  }
  if (habit.morningRoutine) {
    const morningTag = document.createElement('span');
    morningTag.className = 'habit-meta-tag morning';
    morningTag.textContent = 'Morning Routine';
    meta.appendChild(morningTag);
  }
  if (habit.nightRoutine) {
    const nightTag = document.createElement('span');
    nightTag.className = 'habit-meta-tag night';
    nightTag.textContent = 'Night Routine';
    meta.appendChild(nightTag);
  }
  nameCol.appendChild(meta);

  // Progress bar for timed habits
  if (isTimed && !isArchived) {
    const barWrap = document.createElement('div');
    barWrap.className = 'habit-progress-wrap';
    const fill = document.createElement('div');
    fill.className = 'habit-progress-fill' + (pct >= 100 ? ' complete' : '');
    fill.style.width = pct + '%';
    barWrap.appendChild(fill);
    nameCol.appendChild(barWrap);
  }

  li.appendChild(nameCol);

  // Area pill
  if (!isArchived) {
    li.appendChild(buildAreaPill(habit.area || null, newArea => {
      habit.area = newArea;
      saveHabits(allHabits);
      renderHabits();
    }));
  }

  // Weekly dots (Mon–Sun of current week)
  const last7 = getCurrentWeekDates();
  const week = document.createElement('div');
  week.className = 'habit-week';
  last7.forEach(ds => {
    const dot = document.createElement('div');
    const dotDone = _habitDoneOn(habit, ds);
    const dotVoided = _habitVoidedOn(habit.id, ds);
    const dotFuture = ds > today;
    const dotRetired = _habitRetiredOn(habit, ds);
    const dotBeforeStart = ds < (habit.startDate || today);
    const dotIsToday = ds === today;
    const dotStreakBroke = brokenN > 0 && ds === _shiftDay(today, -1);
    dot.className = 'habit-day-dot' +
      (dotRetired ? '' : dotDone ? ' done' : dotVoided ? ' voided'
        : (!dotFuture && !dotBeforeStart && !dotIsToday ? ' missed' : '')) +
      (dotStreakBroke ? ' streak-broke' : '') +
      (dotIsToday && !dotRetired ? ' today-dot' : '');
    if (dotVoided && !dotDone) dot.title = 'Voided';
    week.appendChild(dot);
  });
  li.appendChild(week);

  // Streak (also acts as today's check-in toggle)
  const streakEl = document.createElement('span');
  streakEl.className = 'habit-streak';
  const displayStreak = done ? streak + 1 : streak;   // habitStreak() stops at yesterday
  if (displayStreak > 0) {
    streakEl.innerHTML = _fireStreakBadgeHtml(displayStreak, { size: 'row' });
    streakEl.title = done ? 'Click to uncheck today' : 'Click to check in today';
  } else if (brokenN > 0) {
    streakEl.innerHTML = _fireStreakBadgeHtml(0, { size: 'row', ember: true });
    streakEl.title = `You had a ${brokenN}-day streak — it ended yesterday. Check in today to start a new one.`;
  } else if (dormant && dormant.days >= 2) {
    streakEl.innerHTML = _fireStreakBadgeHtml(dormant.days, { size: 'row', dormant: true });
    streakEl.title = dormant.everDone
      ? `You haven't done this in ${dormant.days} days. Check in today to start fresh.`
      : `You haven't started this yet — it's been sitting for ${dormant.days} days.`;
  } else {
    streakEl.textContent = '–';
    streakEl.title = 'Click to check in today';
  }
  if (!isArchived) {
    streakEl.style.cursor = 'pointer';
    streakEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const log = getHabitLog(today);
      if (log.includes(habit.id)) {
        log.splice(log.indexOf(habit.id), 1);
      } else {
        log.push(habit.id);
      }
      saveHabitLog(today, log);
      setTimeout(() => _flipRows(document.getElementById('habitList'), '.habit-row', renderHabits), 0);
    });
  }
  li.appendChild(streakEl);

  if (!isArchived) {
    // Archive button
    const archBtn = document.createElement('button');
    archBtn.className = 'habit-archive-btn';
    archBtn.textContent = '✓';
    archBtn.title = 'Mark as complete (archive without deleting)';
    archBtn.addEventListener('click', () => {
      if (!confirm(`Archive "${habit.name}"? It will be stored in Completed habits.`)) return;
      habit.archived   = true;
      habit.archivedAt = today;
      saveHabits(allHabits);
      renderHabits();
    });
    li.appendChild(archBtn);
  }

  if (isArchived) {
    // Restart button — the counterpart to the archive check on active rows
    const restartBtn = document.createElement('button');
    restartBtn.className = 'habit-restart-btn';
    restartBtn.textContent = '↺';
    restartBtn.title = 'Start this habit again from today';
    restartBtn.addEventListener('click', () => _restartHabit(habit, allHabits));
    li.appendChild(restartBtn);
  }

  // Delete
  const del = document.createElement('button');
  del.className = 'habit-delete';
  del.textContent = '×';
  del.title = 'Delete permanently';
  del.addEventListener('click', () => {
    if (!confirm(`Permanently delete "${habit.name}"?`)) return;
    _deleteHabit(habit, allHabits);
  });
  li.appendChild(del);

  return li;
}

function renderHabits() {
  const all      = getHabits();
  const mode     = getHabitSort();
  const canDrag  = mode === 'custom' || mode === 'area';
  const today     = habitDateStr(0);
  const doneToday = new Set(getHabitLog(today));
  let active     = _sortHabitsForDisplay(all.filter(h => !h.archived), mode);
  // Done rows slide to the bottom; voided-today rows sit just above them.
  const _rank = h => doneToday.has(h.id) ? 2 : _habitVoidedOn(h.id, today) ? 1 : 0;
  active = [...active].sort((a, b) => _rank(a) - _rank(b));
  const archived = _sortHabitsForDisplay(all.filter(h => h.archived), mode);
  const listEl   = document.getElementById('habitList');
  const emptyEl  = document.getElementById('habitEmpty');
  const archToggle = document.getElementById('archivedToggle');
  const archList   = document.getElementById('archivedList');

  _syncHabitSortButtons();
  listEl.innerHTML  = '';
  archList.innerHTML = '';

  if (active.length === 0) {
    emptyEl.style.display = 'block';
    listEl.style.display  = 'none';
  } else {
    emptyEl.style.display = 'none';
    listEl.style.display  = '';
    active.forEach(h => listEl.appendChild(buildHabitRow(h, all, false, canDrag)));
  }

  if (!listEl._dragWired) {
    listEl._dragWired = true;
    wireDragReorder(listEl, 'habit-row', _reorderHabitByDrag);
  }

  if (archived.length === 0) {
    archToggle.style.display = 'none';
  } else {
    archToggle.style.display = '';
    document.getElementById('archivedToggleLabel').textContent =
      `Completed habits (${archived.length})`;
    archived.forEach(h => archList.appendChild(buildHabitRow(h, all, true, false)));
  }

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
    && !_habitVoidedOn(h.id, ds));
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
    <span class="habit-flame-num">${count}</span>
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
  DAY_LABELS.forEach(l => { html += `<div class="hcal-day-label">${l}</div>`; });
  for (let i = 0; i < firstDow; i++) html += '<div class="hcal-empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = ds === today;
    const isFuture = ds > today;

    const scheduled = habits.filter(h => _habitScheduledOn(h, ds) && !(h.endOfDay && isToday));
    const counted   = _habitsCountedOn(habits, ds, today);
    const voidCount = scheduled.length - counted.length;
    const doneIds = getHabitLog(ds);
    const doneCount = counted.filter(h => doneIds.includes(h.id)).length;
    const pct = counted.length ? Math.round(doneCount / counted.length * 100) : 0;
    // A past day (not today) that had habits but none done is a "miss" — full red
    // ring. Voided habits are out of `counted`, so a fully voided day is never a miss.
    const isMissed = ds < today && counted.length > 0 && doneCount === 0;
    const allVoided = !counted.length && voidCount > 0;

    const hasVoid  = voidCount > 0 && !isFuture;
    const isFull   = pct >= 100 && counted.length > 0;
    // Void outranks every other state: a day carrying one is neither scored nor
    // failed, so it takes the slate treatment ahead of full-green or missed-red.
    const numColor = hasVoid ? _HCAL_VOID
      : isFull ? _hcalRingColor(100) : isMissed ? _HCAL_MISSED : null;

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

    const dayAttrs = isFuture ? '' : ` data-date="${ds}" role="button" tabindex="0"`;
    html += `<div class="${cls}${isFuture ? '' : ' is-clickable'}"${dayAttrs} title="${titleTxt}">
      <svg class="hcal-ring${hasVoid ? ' has-void' : ''}" viewBox="0 0 36 36">
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
let _detailMonth = null; // { year, month }
let _habitDetailTab = 'overview'; // 'overview' | 'notes'

function _setHabitDetailTab(tab) {
  _habitDetailTab = tab;
  document.querySelectorAll('#habitDetailPage .hd-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.hdtab === tab));
  document.getElementById('habitDetailOverview').style.display = tab === 'overview' ? '' : 'none';
  document.getElementById('habitDetailNotes').style.display    = tab === 'notes'    ? '' : 'none';
  document.getElementById('habitDetailPage').scrollTop = 0;
}

function openHabitDetail(habitId) {
  _detailHabitId = habitId;
  const now = new Date();
  _detailMonth = { year: now.getFullYear(), month: now.getMonth() };
  const all = getHabits();
  const habit = all.find(h => h.id === habitId);
  if (!habit) return;
  renderHabitDetailPage(habit, all);
  renderHabitNotesPanel(habit);
  _setHabitDetailTab('overview');
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

function renderHabitDetailPage(habit, allHabits) {
  const today = habitDateStr(0);
  const doneToday = _habitDoneOn(habit, today);
  const streak = habitStreak(habit.id);
  const displayStreak = doneToday ? streak + 1 : streak;
  const brokenN = (!doneToday && streak === 0) ? _habitRecentlyBroken(habit) : 0;
  const dormant = (!doneToday && streak === 0 && brokenN === 0) ? _habitDormantDays(habit) : null;
  const isTimed = !!habit.endDate;
  const startDate = habit.startDate || today;
  const dayNum = _habitDayNum(habit, today);
  const totalDays = isTimed ? _habitTotalDays(habit) : null;
  const pct = isTimed ? Math.min(100, Math.max(0, (dayNum - 1) / Math.max(totalDays - 1, 1) * 100)) : null;
  const isExpired = isTimed && today > habit.endDate;
  const isArchived = !!habit.archived;

  // Count total completions across the habit's tracked window. Check-ins live in
  // MEM ('habits:log:<date>'), not localStorage — the old localStorage scan never
  // matched, so this always read 0.
  // Completions in the current run, plus those banked from earlier runs — the
  // same span the cumulative day count covers, so the rate can't exceed 100%.
  let totalDone = 0;
  storeListKeys('habits:log:').forEach(k => {
    const ds = k.slice('habits:log:'.length);
    if (ds > today || !_habitDoneOn(habit, ds)) return;
    if (ds >= startDate || _habitInPriorRun(habit, ds)) totalDone++;
  });
  // Voided days drop out of the denominator, so an excused stretch can't drag the
  // completion rate down. Check-ins made on a voided day still count in totalDone.
  // The denominator is the same "Day N" shown above, so the rate is measured over
  // the days the habit was actually active across all of its runs.
  const voidedDays  = _habitVoidedCount(habit.id, startDate, today);
  const daysTracked = Math.max(1, dayNum);
  const rate = Math.round(totalDone / daysTracked * 100);

  // Name
  const nameEl = document.getElementById('habitDetailName');
  nameEl.textContent = habit.name;
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
    if (e.key === 'Escape') { nameEl.textContent = origName; nameEl.blur(); }
  };

  // Stats
  const streakBadgeHtml = displayStreak > 0
    ? _fireStreakBadgeHtml(displayStreak, { size: 'stat' })
    : brokenN > 0
      ? _fireStreakBadgeHtml(0, { size: 'stat', ember: true })
      : (dormant && dormant.days >= 2)
        ? _fireStreakBadgeHtml(dormant.days, { size: 'stat', dormant: true })
        : `<div class="habit-stat-val">–</div>`;
  const dormantTitle = dormant && dormant.days >= 2
    ? (dormant.everDone
        ? `You haven't done this in ${dormant.days} days. Check in today to start fresh.`
        : `You haven't started this yet — it's been sitting for ${dormant.days} days.`)
    : '';
  const streakTitleAttr = brokenN > 0
    ? ` title="You had a ${brokenN}-day streak — it ended yesterday. Check in today to start a new one."`
    : dormantTitle
      ? ` title="${dormantTitle}"`
      : '';

  document.getElementById('habitDetailStats').innerHTML = `
    <div class="habit-detail-stats-grid">
      <div class="habit-stat-card"${streakTitleAttr}>
        ${streakBadgeHtml}
        <div class="habit-stat-label">Current Streak</div>
      </div>
      <div class="habit-stat-card">
        <div class="habit-stat-val">${totalDone}</div>
        <div class="habit-stat-label">Total Done</div>
      </div>
      <div class="habit-stat-card">
        <div class="habit-stat-val">${rate}%</div>
        <div class="habit-stat-label">Completion Rate</div>
      </div>
    </div>
    ${voidedDays ? `<div class="habit-void-note">${voidedDays} voided day${voidedDays === 1 ? '' : 's'} excluded from the rate and the day count.</div>` : ''}
    ${isTimed ? `
    <div class="habit-detail-progress-section">
      <div class="habit-detail-section-title">Progress</div>
      <div class="habit-detail-progress-bar-wrap">
        <div class="habit-detail-progress-bar">
          <div class="habit-detail-progress-fill${pct >= 100 ? ' complete' : ''}" style="width:${pct}%"></div>
        </div>
        <span class="habit-detail-progress-label">${isExpired ? 'Completed' : `Day ${dayNum} of ${totalDays}`}</span>
      </div>
    </div>
    ` : ''}
  `;

  // History grid
  renderHabitHistoryGrid(habit);

  // Actions

  document.getElementById('habitDetailActions').innerHTML = `
    ${!isArchived ? `
    <div class="habit-detail-checkin">
      <div>
        <div class="habit-detail-checkin-label">Today's check-in</div>
        <div class="habit-detail-checkin-sub">${formatDate(today)}</div>
      </div>
      <label class="habit-cb-wrap" style="position:relative;width:22px;height:22px;flex-shrink:0;">
        <input type="checkbox" id="habitDetailCb" ${doneToday ? 'checked' : ''}>
        <span class="habit-cb-box"></span>
      </label>
    </div>
    <div class="habit-detail-row-split">
      <div class="habit-detail-row-field">
        <span class="habit-detail-start-label">Started</span>
        <input type="date" class="habit-detail-start-input" id="habitStartDateInput"
          value="${startDate}" max="${today}">
      </div>
    </div>
    <div class="habit-detail-row-split habit-detail-row-split-3">
      <label class="habit-toggle-compact" title="Excluded from the day's completion % until the day is over">
        <span class="habit-toggle-compact-label">End of Day</span>
        <span class="habit-cb-wrap" style="position:relative;width:22px;height:22px;flex-shrink:0;">
          <input type="checkbox" id="habitDetailEod" ${habit.endOfDay ? 'checked' : ''}>
          <span class="habit-cb-box"></span>
        </span>
      </label>
      <label class="habit-toggle-compact">
        <span class="habit-toggle-compact-label">Morning Routine</span>
        <span class="habit-cb-wrap" style="position:relative;width:22px;height:22px;flex-shrink:0;">
          <input type="checkbox" id="habitDetailMorning" ${habit.morningRoutine ? 'checked' : ''}>
          <span class="habit-cb-box"></span>
        </span>
      </label>
      <label class="habit-toggle-compact">
        <span class="habit-toggle-compact-label">Night Routine</span>
        <span class="habit-cb-wrap" style="position:relative;width:22px;height:22px;flex-shrink:0;">
          <input type="checkbox" id="habitDetailNight" ${habit.nightRoutine ? 'checked' : ''}>
          <span class="habit-cb-box"></span>
        </span>
      </label>
    </div>
    ` : `
    <div class="habit-detail-checkin">
      <div style="flex:1;">
        <div class="habit-detail-checkin-label">Completed habit</div>
        <div class="habit-detail-checkin-sub">${habit.archivedAt ? 'Archived ' + formatDate(habit.archivedAt) : 'Archived'}</div>
      </div>
      <button class="btn-restart" id="habitDetailRestart">Start again</button>
    </div>
    `}
    <div class="habit-detail-danger-row">
      ${!isArchived ? `<button class="btn-danger" id="habitDetailArchive">Archive</button>` : ''}
      <button class="btn-danger" id="habitDetailDelete">Delete</button>
    </div>
  `;

  if (isArchived) {
    // renderHabits() re-renders this page via its sync block, so the view flips
    // to the active layout in place rather than closing.
    document.getElementById('habitDetailRestart')
      .addEventListener('click', () => _restartHabit(habit, allHabits));
  }

  if (!isArchived) {
    document.getElementById('habitDetailCb').addEventListener('change', (e) => {
      const log = getHabitLog(today);
      if (e.target.checked) { if (!log.includes(habit.id)) log.push(habit.id); }
      else { const i = log.indexOf(habit.id); if (i !== -1) log.splice(i, 1); }
      saveHabitLog(today, log);
      renderHabits();
      renderHabitDetailPage(habit, allHabits);
    });

    const _startInput = document.getElementById('habitStartDateInput');
    const _saveStartDate = () => {
      const newDate = _startInput.value;
      if (!newDate || newDate > today || newDate === habit.startDate) return;
      habit.startDate = newDate;
      saveHabits(allHabits);
      renderHabitDetailPage(habit, allHabits);
    };
    _startInput.addEventListener('blur', _saveStartDate);
    _startInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _startInput.blur(); }
    });

    document.getElementById('habitDetailEod').addEventListener('change', (e) => {
      habit.endOfDay = e.target.checked;
      if (e.target.checked) { habit.morningRoutine = false; habit.nightRoutine = false; }
      saveHabits(allHabits);
      renderHabits();
      renderHabitOverviewCalendar();
      renderHabitDetailPage(habit, allHabits);
    });

    document.getElementById('habitDetailMorning').addEventListener('change', (e) => {
      habit.morningRoutine = e.target.checked;
      if (e.target.checked) { habit.endOfDay = false; habit.nightRoutine = false; }
      saveHabits(allHabits);
      renderHabits();
      renderHabitDetailPage(habit, allHabits);
    });

    document.getElementById('habitDetailNight').addEventListener('change', (e) => {
      habit.nightRoutine = e.target.checked;
      if (e.target.checked) { habit.endOfDay = false; habit.morningRoutine = false; }
      saveHabits(allHabits);
      renderHabits();
      renderHabitDetailPage(habit, allHabits);
    });

    document.getElementById('habitDetailArchive').addEventListener('click', () => {
      if (!confirm(`Archive "${habit.name}"?`)) return;
      habit.archived = true;
      habit.archivedAt = today;
      saveHabits(allHabits);
      renderHabits();
      closeHabitDetail();
    });
  }

  document.getElementById('habitDetailDelete').addEventListener('click', () => {
    if (!confirm(`Permanently delete "${habit.name}"?`)) return;
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

  panel.querySelectorAll('.area-note-entry').forEach(el => {
    const n = notes.find(x => x.id === el.dataset.noteId);
    el.querySelector('.area-note-body').textContent = n ? n.text : '';
    el.querySelector('.hd-note-del').addEventListener('click', () => {
      saveHabitNotes(habit.id, getHabitNotes(habit.id).filter(x => x.id !== el.dataset.noteId));
      renderHabitNotesPanel(habit);
    });
  });

  const inp = document.getElementById('habitNoteInput');
  const add = () => {
    const text = inp.value.trim();
    if (!text) return;
    saveHabitNotes(habit.id, getHabitNotes(habit.id).concat({ id: _noteId(), text, createdAt: Date.now() }));
    renderHabitNotesPanel(habit);
  };
  document.getElementById('habitNoteAdd').addEventListener('click', add);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add();
  });
}

function renderHabitHistoryGrid(habit) {
  const today = habitDateStr(0);
  const startDate = habit.startDate || today;
  const isArchived = !!habit.archived;
  const brokenN = _habitRecentlyBroken(habit);
  const now = new Date();

  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];
  const DAY_LABELS = ['M','T','W','T','F','S','S'];

  const { year, month } = _detailMonth;

  // Bounds: can go back up to 12 months before today; can't go past current month
  const limitDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const atStart = year < limitDate.getFullYear() ||
                  (year === limitDate.getFullYear() && month <= limitDate.getMonth());
  const atCurrent = year === now.getFullYear() && month === now.getMonth();

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;

  let html = '<div class="habit-history-section"><div class="habit-detail-section-title">History</div>';
  html += '<div class="habit-cal-month">';
  html += `<div class="habit-cal-nav">
    <button class="habit-cal-nav-btn" id="habitCalPrev" ${atStart ? 'disabled' : ''}>←</button>
    <div class="habit-cal-month-header">${MONTH_NAMES[month]} ${year}</div>
    <button class="habit-cal-nav-btn" id="habitCalNext" ${atCurrent ? 'disabled' : ''}>→</button>
  </div>`;
  html += '<div class="habit-cal-grid">';

  DAY_LABELS.forEach(l => { html += `<div class="habit-cal-day-label">${l}</div>`; });

  for (let i = 0; i < firstDow; i++) {
    html += `<div class="habit-cal-empty"></div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const done = _habitDoneOn(habit, ds);
    const voided = _habitVoidedOn(habit.id, ds);
    const isToday = ds === today;
    const isFuture = ds > today;
    const isRetired = _habitRetiredOn(habit, ds);
    const isBeforeStart = ds < startDate && !_habitInPriorRun(habit, ds);
    const isStreakBroke = brokenN > 0 && ds === _shiftDay(today, -1);

    let cls = 'habit-cal-day';
    // A retired day gets the same inert treatment as a future one — the habit
    // was no longer running, so it is neither a win nor a miss.
    if (isFuture || isRetired) cls += ' future';
    else if (isBeforeStart) cls += ' before-start';
    else if (done) cls += ' done';
    else if (voided) cls += ' voided';
    else if (!isToday) cls += ' missed';
    if (isStreakBroke) cls += ' streak-broke';
    if (isToday && !isRetired) cls += ' today';

    // An archived habit is a frozen record: nothing about it can be re-marked.
    const clickable = !isFuture && !isBeforeStart && !isArchived;
    const cellTitle = isRetired ? `${ds} — archived` : voided ? `${ds} — voided` : ds;
    html += `<div class="${cls}"${clickable ? ` data-date="${ds}" style="cursor:pointer;"` : ''} title="${cellTitle}"><span class="habit-cal-day-num">${d}</span></div>`;
  }

  // Fill trailing cells to complete the last row
  const totalCells = firstDow + daysInMonth;
  const trailing = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 0; i < trailing; i++) {
    html += `<div class="habit-cal-empty"></div>`;
  }

  html += '</div></div></div>';
  document.getElementById('habitDetailHistory').innerHTML = html;

  // Wire day-toggle clicks
  document.querySelector('.habit-cal-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-date]');
    if (!cell) return;
    const ds = cell.dataset.date;
    const log = getHabitLog(ds);
    const idx = log.indexOf(habit.id);
    if (idx !== -1) log.splice(idx, 1);
    else log.push(habit.id);
    saveHabitLog(ds, log);
    renderHabits();
    const allH = getHabits();
    renderHabitDetailPage(allH.find(h => h.id === habit.id) || habit, allH);
  });

  // Wire nav buttons
  const prevBtn = document.getElementById('habitCalPrev');
  const nextBtn = document.getElementById('habitCalNext');

  if (!atStart) {
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (month === 0) _detailMonth = { year: year - 1, month: 11 };
      else _detailMonth = { year, month: month - 1 };
      renderHabitHistoryGrid(habit);
    });
  }

  if (!atCurrent) {
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (month === 11) _detailMonth = { year: year + 1, month: 0 };
      else _detailMonth = { year, month: month + 1 };
      renderHabitHistoryGrid(habit);
    });
  }
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

  const mode    = getHabitSort();
  const canDrag = mode === 'custom' || mode === 'area';

  const areas   = getAreas();
  const sorted  = _sortHabitsForDisplay(scheduled, mode);
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
    return `
    <div class="day-detail-habit-row${isDone ? ' is-done' : ''}${voidActive ? ' is-voided' : ''}${isLocked ? ' is-locked' : ''}"${rowDrag ? ' draggable="true"' : ''} data-habit-id="${h.id}"${isLocked ? ' title="Archived — its check-ins are locked"' : ''}>
      ${rowDrag ? '<span class="habit-drag-handle" aria-hidden="true">⋮⋮</span>' : ''}
      <label class="habit-cb-wrap">
        <input type="checkbox" data-habit-id="${h.id}"${isDone ? ' checked' : ''}${isLocked ? ' disabled' : ''}>
        <span class="habit-cb-box"></span>
      </label>
      <span class="day-detail-habit-name">${_esc(h.name)}</span>
      ${isLocked ? '<span class="habit-meta-tag archived-tag">Archived</span>' : ''}
      ${voidActive ? '<span class="habit-meta-tag voided">Voided</span>' : ''}
      ${h.endOfDay ? '<span class="habit-meta-tag eod">End of Day</span>' : ''}
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
      ${_dayVoidMode ? '' : _habitSortBarHTML()}
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

  body.querySelectorAll('[data-void-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ids = [...getHabitVoids(ds)];
      const i = ids.indexOf(btn.dataset.voidId);
      if (i === -1) ids.push(btn.dataset.voidId); else ids.splice(i, 1);
      _saveVoids(ids);
    });
  });

  const allBtn  = document.getElementById('dayVoidAll');
  const noneBtn = document.getElementById('dayVoidNone');
  if (allBtn)  allBtn.addEventListener('click',  () => _saveVoids(scheduled.map(h => h.id)));
  if (noneBtn) noneBtn.addEventListener('click', () => _saveVoids([]));

  body.querySelectorAll('input[data-habit-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.disabled) return;
      const id  = cb.dataset.habitId;
      const log = getHabitLog(ds);
      const i   = log.indexOf(id);
      if (cb.checked) { if (i === -1) log.push(id); }
      else if (i !== -1) log.splice(i, 1);
      saveHabitLog(ds, log);
      // renderHabits re-renders the open day view via its sync block
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

// ── Archived section toggle
document.getElementById('archivedToggle').addEventListener('click', () => {
  const toggle = document.getElementById('archivedToggle');
  const list   = document.getElementById('archivedList');
  toggle.classList.toggle('open');
  list.classList.toggle('open');
});

document.getElementById('habitAddBtn').addEventListener('click', addHabit);
document.getElementById('habitInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') addHabit();
});

document.addEventListener('click', e => {
  const btn = e.target.closest('.habit-sort-btn');
  if (btn) setHabitSort(btn.dataset.sort);
});

function addHabit() {
  const input   = document.getElementById('habitInput');
  const endDate = document.getElementById('habitEndDate');
  const name    = input.value.trim();
  if (!name) return;
  const today   = habitDateStr(0);
  const entry   = { id: _habitId(), name, startDate: today, archived: false, endOfDay: false, morningRoutine: false, nightRoutine: false, createdAt: new Date().toISOString() };
  if (endDate.value && endDate.value <= today) {
    alert('The end date has to be after today. Clear it for an ongoing habit.');
    return;                       // keep what was typed so it can be corrected
  }
  if (endDate.value) entry.endDate = endDate.value;
  const habits = getHabits();
  habits.push(entry);
  saveHabits(habits);
  input.value    = '';
  endDate.value  = '';
  renderHabits();
}

document.getElementById('habitDetailBack').addEventListener('click', closeHabitDetail);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('habitDetailPage').classList.contains('open')) closeHabitDetail();
});
document.querySelectorAll('#habitDetailPage .hd-tab').forEach(btn => {
  btn.addEventListener('click', () => _setHabitDetailTab(btn.dataset.hdtab));
});

document.getElementById('dayDetailBack').addEventListener('click', closeDayDetail);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('dayDetailPage').classList.contains('open')) closeDayDetail();
});
