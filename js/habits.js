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

function _syncHabitSortButtons() {
  const mode = getHabitSort();
  document.querySelectorAll('.habit-sort-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === mode));
}
function _noteId() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function habitStreak(habitId) {
  let streak = 0;
  let d = new Date();
  d.setDate(d.getDate() - 1);
  for (let i = 0; i < 365; i++) {
    const ds = _localDateStr(d);
    if (getHabitLog(ds).includes(habitId)) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
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
  const done     = todayLog.includes(habit.id);
  const streak   = habitStreak(habit.id);

  const isTimed   = !!habit.endDate;
  const dayNum    = habit.startDate ? daysBetween(habit.startDate, today) + 1 : 1;
  const totalDays = isTimed ? daysBetween(habit.startDate, habit.endDate) + 1 : null;
  const pct       = isTimed ? Math.min(100, Math.max(0, (dayNum - 1) / (totalDays - 1) * 100)) : null;
  const isExpired = isTimed && today > habit.endDate;

  const li = document.createElement('li');
  li.className = 'habit-row' + (done ? ' is-done' : '') + (isArchived ? ' is-archived' : '');
  li.dataset.habitId = habit.id;

  // Drag-to-reorder — only in Custom / By-area modes, active habits only
  if (!isArchived && canDrag) {
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
      renderHabits();
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
    const archivedDays = habit.archivedAt ? daysBetween(habit.startDate || habit.archivedAt, habit.archivedAt) + 1 : '?';
    tag.textContent = `Completed · ${archivedDays}d`;
  } else if (isTimed) {
    tag.className = isExpired ? 'habit-meta-tag expired' : 'habit-meta-tag timed';
    tag.textContent = isExpired
      ? `Expired · ${totalDays}d run`
      : `Day ${dayNum} of ${totalDays}`;
  } else {
    tag.className = 'habit-meta-tag ongoing';
    tag.textContent = `Day ${dayNum} · ongoing`;
  }
  meta.appendChild(tag);
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
    const dotDone = getHabitLog(ds).includes(habit.id);
    const dotFuture = ds > today;
    const dotBeforeStart = ds < (habit.startDate || today);
    const dotIsToday = ds === today;
    dot.className = 'habit-day-dot' +
      (dotDone ? ' done' : (!dotFuture && !dotBeforeStart && !dotIsToday ? ' missed' : '')) +
      (dotIsToday ? ' today-dot' : '');
    week.appendChild(dot);
  });
  li.appendChild(week);

  // Streak (also acts as today's check-in toggle)
  const streakEl = document.createElement('span');
  streakEl.className = 'habit-streak' + (streak >= 3 ? ' hot' : '');
  streakEl.textContent = done ? (streak > 0 ? streak + '🔥' : '1') : (streak > 0 ? streak + '🔥' : '–');
  streakEl.title = done ? 'Click to uncheck today' : 'Click to check in today';
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
      setTimeout(renderHabits, 0);
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

  // Delete
  const del = document.createElement('button');
  del.className = 'habit-delete';
  del.textContent = '×';
  del.title = 'Delete permanently';
  del.addEventListener('click', () => {
    if (!confirm(`Permanently delete "${habit.name}"?`)) return;
    const idx = allHabits.indexOf(habit);
    if (idx !== -1) allHabits.splice(idx, 1);
    saveHabits(allHabits);
    renderHabits();
  });
  li.appendChild(del);

  return li;
}

function renderHabits() {
  const all      = getHabits();
  const mode     = getHabitSort();
  const canDrag  = mode === 'custom' || mode === 'area';
  const active   = _sortHabitsForDisplay(all.filter(h => !h.archived), mode);
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
    wireDragReorder(listEl, 'habit-row', (fromEl, toEl) => {
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
    });
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
  const start = h.startDate || '0000-00-00';
  if (ds < start) return false;
  if (h.endDate && ds > h.endDate) return false;
  if (h.archivedAt && ds > String(h.archivedAt).slice(0, 10)) return false;
  return true;
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

    const scheduled = habits.filter(h => _habitScheduledOn(h, ds));
    const doneIds = getHabitLog(ds);
    const doneCount = scheduled.filter(h => doneIds.includes(h.id)).length;
    const pct = scheduled.length ? Math.round(doneCount / scheduled.length * 100) : 0;
    // A past day (not today) that had habits but none done is a "miss" — full red ring.
    const isMissed = ds < today && scheduled.length > 0 && doneCount === 0;

    const isFull = pct >= 100 && scheduled.length > 0;
    const numColor = isFull ? _hcalRingColor(100) : isMissed ? _HCAL_MISSED : null;

    let cls = 'hcal-day';
    if (isToday) cls += ' today';
    if (isFuture) cls += ' future';
    else if (!scheduled.length) cls += ' none-sched';
    if (isFull) cls += ' full';
    if (isMissed) cls += ' missed';

    const dash = `${(pct / 100) * C} ${C}`;
    const titleTxt = isFuture ? ds
      : `${ds} — ${doneCount}/${scheduled.length} habits (${pct}%)`;
    // transform: rotate start point to 12 o'clock, then mirror horizontally so
    // the arc grows counter-clockwise.
    const fill = doneCount > 0
      ? `<circle class="hcal-ring-fill" cx="18" cy="18" r="${R}" style="stroke:${_hcalRingColor(pct)}"
           stroke-dasharray="${dash}" transform="translate(36 0) scale(-1 1) rotate(-90 18 18)"></circle>`
      : isMissed
      ? `<circle class="hcal-ring-fill" cx="18" cy="18" r="${R}" style="stroke:${_HCAL_MISSED}"
           stroke-dasharray="${C} ${C}"></circle>`
      : '';

    const dayAttrs = isFuture ? '' : ` data-date="${ds}" role="button" tabindex="0"`;
    html += `<div class="${cls}${isFuture ? '' : ' is-clickable'}"${dayAttrs} title="${titleTxt}">
      <svg class="hcal-ring" viewBox="0 0 36 36">
        <circle class="hcal-ring-track" cx="18" cy="18" r="${R}"></circle>
        ${fill}
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
  const doneToday = getHabitLog(today).includes(habit.id);
  const streak = habitStreak(habit.id);
  const displayStreak = doneToday ? streak + 1 : streak;
  const isTimed = !!habit.endDate;
  const startDate = habit.startDate || today;
  const dayNum = daysBetween(startDate, today) + 1;
  const totalDays = isTimed ? daysBetween(startDate, habit.endDate) + 1 : null;
  const pct = isTimed ? Math.min(100, Math.max(0, (dayNum - 1) / Math.max(totalDays - 1, 1) * 100)) : null;
  const isExpired = isTimed && today > habit.endDate;
  const isArchived = !!habit.archived;

  // Count total completions across all log keys
  let totalDone = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('habits:log:')) {
      const ds = k.replace('habits:log:', '');
      if (ds >= startDate && ds <= today && getHabitLog(ds).includes(habit.id)) totalDone++;
    }
  }
  const daysTracked = Math.max(1, daysBetween(startDate, today) + 1);
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
  document.getElementById('habitDetailStats').innerHTML = `
    <div class="habit-detail-stats-grid">
      <div class="habit-stat-card">
        <div class="habit-stat-val">${displayStreak > 0 ? displayStreak + '🔥' : '–'}</div>
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
    <div class="habit-detail-start-card">
      <span class="habit-detail-start-label">Started</span>
      <input type="date" class="habit-detail-start-input" id="habitStartDateInput"
        value="${startDate}" max="${today}">
    </div>
    <div class="habit-detail-danger">
      <span class="habit-detail-danger-label">Archive this habit</span>
      <button class="btn-danger" id="habitDetailArchive">Archive</button>
    </div>
    ` : ''}
    <div class="habit-detail-danger">
      <span class="habit-detail-danger-label">Permanently delete this habit</span>
      <button class="btn-danger" id="habitDetailDelete">Delete</button>
    </div>
  `;

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
    const idx = allHabits.indexOf(habit);
    if (idx !== -1) allHabits.splice(idx, 1);
    saveHabits(allHabits);
    if (getHabitNotes(habit.id).length) saveHabitNotes(habit.id, []);
    renderHabits();
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
    const done = getHabitLog(ds).includes(habit.id);
    const isToday = ds === today;
    const isFuture = ds > today;
    const isBeforeStart = ds < startDate;

    let cls = 'habit-cal-day';
    if (isFuture) cls += ' future';
    else if (isBeforeStart) cls += ' before-start';
    else if (done) cls += ' done';
    else if (!isToday) cls += ' missed';
    if (isToday) cls += ' today';

    const clickable = !isFuture && !isBeforeStart;
    html += `<div class="${cls}"${clickable ? ` data-date="${ds}" style="cursor:pointer;"` : ''} title="${ds}"><span class="habit-cal-day-num">${d}</span></div>`;
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
  const doneIds   = getHabitLog(ds);
  const doneCount = scheduled.filter(h => doneIds.includes(h.id)).length;
  const pct       = scheduled.length ? Math.round(doneCount / scheduled.length * 100) : 0;
  const isMissed  = ds < today && scheduled.length > 0 && doneCount === 0;

  const R = 15.5, C = 2 * Math.PI * R;
  const arc = doneCount > 0
    ? `<circle class="hcal-ring-fill" cx="18" cy="18" r="${R}" style="stroke:${_hcalRingColor(pct)}"
         stroke-dasharray="${(pct / 100) * C} ${C}" transform="translate(36 0) scale(-1 1) rotate(-90 18 18)"></circle>`
    : isMissed
    ? `<circle class="hcal-ring-fill" cx="18" cy="18" r="${R}" style="stroke:${_HCAL_MISSED}"
         stroke-dasharray="${C} ${C}"></circle>`
    : '';

  const prevDisabled = ds <= _dayDetailFloor();
  const nextDisabled = ds >= today;

  const summary = scheduled.length
    ? `${doneCount} of ${scheduled.length} habit${scheduled.length === 1 ? '' : 's'} completed`
    : 'No habits were active on this day.';

  const areas = getAreas();
  const rows = scheduled.map(h => {
    const areaObj = h.area && areas.find(a => a.name === h.area);
    const areaTag = areaObj
      ? `<span class="day-detail-habit-area" style="background:${areaObj.color}BF">${areaObj.name}</span>`
      : '';
    return `
    <div class="day-detail-habit-row">
      <label class="habit-cb-wrap">
        <input type="checkbox" data-habit-id="${h.id}"${doneIds.includes(h.id) ? ' checked' : ''}>
        <span class="habit-cb-box"></span>
      </label>
      <span class="day-detail-habit-name">${h.name}</span>
      ${areaTag}
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="day-detail-head">
      <button class="hcal-nav-btn" id="dayDetailPrev"${prevDisabled ? ' disabled' : ''}>‹</button>
      <h2 class="habit-detail-name day-detail-date">${_fullDateLabel(ds)}</h2>
      <button class="hcal-nav-btn" id="dayDetailNext"${nextDisabled ? ' disabled' : ''}>›</button>
    </div>
    <div class="day-detail-summary-card">
      <div class="day-detail-ring-wrap">
        <svg class="hcal-ring day-detail-ring" viewBox="0 0 36 36">
          <circle class="hcal-ring-track" cx="18" cy="18" r="${R}"></circle>
          ${arc}
        </svg>
        <span class="day-detail-ring-pct">${pct}%</span>
      </div>
      <div class="day-detail-summary-text">${summary}</div>
    </div>
    ${scheduled.length ? `
      <div class="habit-detail-section-title">Habits</div>
      <div class="day-detail-habit-list">${rows}</div>` : ''}
  `;

  body.querySelectorAll('input[data-habit-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id  = cb.dataset.habitId;
      const log = getHabitLog(ds);
      const i   = log.indexOf(id);
      if (cb.checked) { if (i === -1) log.push(id); }
      else if (i !== -1) log.splice(i, 1);
      saveHabitLog(ds, log);
      renderHabits(); // repaints the calendar + this open day view
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
  const entry   = { id: Date.now().toString(36), name, startDate: today, archived: false, createdAt: new Date().toISOString() };
  if (endDate.value && endDate.value > today) entry.endDate = endDate.value;
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
