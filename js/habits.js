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

function buildHabitRow(habit, allHabits, isArchived, activeIdx) {
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

  // Drag-to-reorder (active habits only)
  if (!isArchived) {
    li.draggable = true;
    li.dataset.idx = activeIdx;
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
  const active   = all.filter(h => !h.archived);
  const archived = all.filter(h => h.archived);
  const listEl   = document.getElementById('habitList');
  const emptyEl  = document.getElementById('habitEmpty');
  const archToggle = document.getElementById('archivedToggle');
  const archList   = document.getElementById('archivedList');

  listEl.innerHTML  = '';
  archList.innerHTML = '';

  if (active.length === 0) {
    emptyEl.style.display = 'block';
    listEl.style.display  = 'none';
  } else {
    emptyEl.style.display = 'none';
    listEl.style.display  = '';
    active.forEach((h, i) => listEl.appendChild(buildHabitRow(h, all, false, i)));
  }

  if (!listEl._dragWired) {
    listEl._dragWired = true;
    wireDragReorder(listEl, 'habit-row', (from, to) => {
      const habits  = getHabits();
      const actives = habits.filter(h => !h.archived);
      const rest    = habits.filter(h => h.archived);
      const [moved] = actives.splice(from, 1);
      actives.splice(to, 0, moved);
      saveHabits([...actives, ...rest]);
      renderHabits();
    });
  }

  if (archived.length === 0) {
    archToggle.style.display = 'none';
  } else {
    archToggle.style.display = '';
    document.getElementById('archivedToggleLabel').textContent =
      `Completed habits (${archived.length})`;
    archived.forEach(h => archList.appendChild(buildHabitRow(h, all, true)));
  }

  renderHabitOverviewCalendar();

  // Keep detail page in sync if open
  if (_detailHabitId && document.getElementById('habitDetailPage').classList.contains('open')) {
    const habit = all.find(h => h.id === _detailHabitId);
    if (habit) renderHabitDetailPage(habit, all);
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

    html += `<div class="${cls}" title="${titleTxt}">
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

// ── Habit Detail Page ──
let _detailHabitId = null;
let _detailMonth = null; // { year, month }

function openHabitDetail(habitId) {
  _detailHabitId = habitId;
  const now = new Date();
  _detailMonth = { year: now.getFullYear(), month: now.getMonth() };
  const all = getHabits();
  const habit = all.find(h => h.id === habitId);
  if (!habit) return;
  renderHabitDetailPage(habit, all);
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
    renderHabits();
    closeHabitDetail();
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

function addHabit() {
  const input   = document.getElementById('habitInput');
  const endDate = document.getElementById('habitEndDate');
  const name    = input.value.trim();
  if (!name) return;
  const today   = habitDateStr(0);
  const entry   = { id: Date.now().toString(36), name, startDate: today, archived: false };
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
