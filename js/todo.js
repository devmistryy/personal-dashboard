// To Do tab: rollover, streak, task rows, drag-reorder, inline edit,
// quick-add + polish. Loaded before main.js.

// Stable client-side task id (mirrors the habits `h_…` convention).
function _taskId() {
  return 'g_' + ((crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

// A task object created right now, with a stable id + ISO creation stamp.
function makeTask(fields) {
  return Object.assign({
    id: _taskId(),
    text: '',
    done: false,
    priority: 'Medium',
    area: null,
    createdAt: new Date().toISOString(),
  }, fields);
}

// True when `list` already contains `g` — by stable id, falling back to an
// exact text match against an unfinished entry (covers pre-id rows).
function _taskInList(g, list) {
  return list.some(x =>
    (g.id && x.id && x.id === g.id) ||
    (!x.done && x.text === g.text));
}

// ── Upcoming (future-dated) tasks ──
// The planner card creates tasks for tomorrow or later only. `plannerDate` is
// the target date for new tasks; it lazily defaults to tomorrow and is never
// allowed to point at today or the past.
let plannerDate = null;
function plannerTargetDate() {
  const min = getTomorrowDateString();
  if (!plannerDate || plannerDate < min) plannerDate = min;
  return plannerDate;
}

// Dates strictly after the active day that currently hold tasks, ascending.
function upcomingDateKeys() {
  const active = getActiveDateString();
  return storeListKeys('tasks:')
    .map(k => k.slice(6))
    .filter(d => d > active)
    .sort();
}

// Every task list a user can currently edit: today + all future days.
// Used by the Areas tab so area rename/delete/tagging reaches future tasks.
function taskScopeKeys() {
  return [todayKey()].concat(upcomingDateKeys().map(d => 'tasks:' + d));
}

// ── Task sort mode ── (shared by the Today and Upcoming lists)
// 'custom' = the stored array order, reorderable by drag. 'priority' and 'area'
// are display-only views; the stored order is never mutated by them.
const _TASK_SORT_MODES = [['custom', 'Custom'], ['priority', 'Priority'], ['area', 'Area']];
const _TASK_PRI_RANK = { High: 0, Medium: 1, Low: 2 };

function getTaskSort()     { return MEM['task_sort_v1'] || 'custom'; }
function setTaskSort(mode) {
  MEM['task_sort_v1'] = mode;
  _syncSetting('task_sort_v1', mode);
  loadToday();
  loadUpcoming();
}

// Returns a new array ordered for display. Never mutates the input — the stored
// order stays canonical (it's the 'custom' order and the tiebreak for the rest).
function sortTasksForDisplay(tasks, mode) {
  const pos = new Map(tasks.map((g, i) => [g, i]));
  const byCustom = (a, b) => pos.get(a) - pos.get(b);
  const arr = [...tasks];
  if (mode === 'priority') {
    arr.sort((a, b) =>
      (_TASK_PRI_RANK[a.priority || 'Medium'] - _TASK_PRI_RANK[b.priority || 'Medium']) || byCustom(a, b));
  } else if (mode === 'area') {
    arr.sort((a, b) => {
      const aa = a.area || '', ba = b.area || '';
      if (!!aa !== !!ba) return aa ? -1 : 1;            // no-area group last
      return aa.localeCompare(ba, undefined, { sensitivity: 'base' }) || byCustom(a, b);
    });
  }
  return arr; // 'custom' / unknown → stored order
}

function paintTaskSortBar(el, count) {
  if (!el) return;
  el.hidden = !(count > 1);           // nothing to sort with 0–1 tasks
  if (el.hidden) { el.innerHTML = ''; return; }
  const mode = getTaskSort();
  el.innerHTML = `<span class="task-sort-label">Sort</span>` +
    _TASK_SORT_MODES.map(([v, l]) =>
      `<button class="task-sort-btn${v === mode ? ' active' : ''}" data-sort="${v}">${l}</button>`).join('');
}

// One delegated listener covers both cards' sort bars.
document.addEventListener('click', e => {
  const btn = e.target.closest('.task-sort-btn');
  if (btn && btn.dataset.sort !== getTaskSort()) setTaskSort(btn.dataset.sort);
});

// Move a task within its stored day array, matched by stable id (so it works
// regardless of the current display sort). Bails unless sort is 'custom'.
function reorderTaskByDrag(key, fromEl, toEl) {
  if (getTaskSort() !== 'custom') return;
  const arr = storeGet(key) || [];
  const from = arr.findIndex(g => g.id === fromEl.dataset.taskId);
  const to   = arr.findIndex(g => g.id === toEl.dataset.taskId);
  if (from < 0 || to < 0 || from === to) return;
  const [item] = arr.splice(from, 1);
  arr.splice(to, 0, item);
  storeSet(key, arr);
  if (key === todayKey()) loadToday(); else loadUpcoming();
}

// ── Rollover + overdue ──
// Any unfinished task from a past day that you haven't finished or dismissed
// rides forward onto today's list — shown as overdue — until you do one or the
// other, no matter how old it is. Past days keep their copies as history.
//
// There is deliberately NO "last processed" marker: a stale one used to strand
// tasks when a carry-forward write failed (the Sept 2026 data-loss bug). The
// guards are per-task instead. A past-day task is carried onto today unless:
//   • it's done, or
//   • its id is already placed on today or any later day (so future-dated
//     planner tasks aren't yanked back), or
//   • its id is in task_dismissed_v1 — set when you delete a carried task off
//     today's list, so rollover leaves it alone from then on.
// (The old goal_rollover_v1 settings row from before this rework is dropped by
//  master.sql and no longer read.)
function rollover() {
  const activeDate = getActiveDateString();
  const dismissed = new Set(storeGet('task_dismissed_v1') || []);

  reclaimStrandedFutureTasks(activeDate);

  // Every task id already scheduled for today or a future day.
  const placedAhead = new Set();
  storeListKeys('tasks:').forEach(k => {
    if (k.slice(6) >= activeDate)
      (storeGet(k) || []).forEach(g => { if (g.id) placedAhead.add(g.id); });
  });

  const todayTasks = storeGet(todayKey()) || [];
  let added = false;

  storeListKeys('tasks:')
    .filter(k => k.slice(6) < activeDate)
    .sort()
    .forEach(k => {
      (storeGet(k) || []).forEach(g => {
        if (g.done || !g.id) return;
        if (placedAhead.has(g.id) || dismissed.has(g.id)) return;
        if (_taskInList(g, todayTasks)) return;
        const carried = Object.assign({}, g, { done: false });
        delete carried.doneAt;
        todayTasks.push(carried);
        placedAhead.add(g.id);
        added = true;
      });
    });

  if (added) storeSet(todayKey(), todayTasks);
  _pruneDismissedTasks();
}

// Undo the damage a backward clock/timezone jump does: if the device clock is
// briefly ahead, rollover() runs with a future day as "today" and copies that
// day's unfinished tasks onto it. When the clock corrects, those copies are
// stranded on a future date — they surface in the Upcoming planner as if they
// were deliberately scheduled, and (sharing an id with the real past-day task)
// they stop rollover from carrying the real one forward.
//
// A stranded copy is any future-dated task whose id also sits on today or an
// earlier day. Planner tasks get a fresh id, so they never match. Drop the
// future copy; the earlier one carries forward normally below.
function reclaimStrandedFutureTasks(activeDate) {
  const behindOrToday = new Set();
  storeListKeys('tasks:').forEach(k => {
    if (k.slice(6) <= activeDate)
      (storeGet(k) || []).forEach(g => { if (g.id) behindOrToday.add(g.id); });
  });
  if (!behindOrToday.size) return;

  storeListKeys('tasks:').forEach(k => {
    if (k.slice(6) <= activeDate) return;
    const arr = storeGet(k) || [];
    const kept = arr.filter(g => !g.id || !behindOrToday.has(g.id));
    if (kept.length !== arr.length) storeSet(k, kept);
  });
}

// Keep task_dismissed_v1 bounded: drop ids that no longer appear on any loaded
// day (their history aged out of loadFromSupabase's window), since rollover
// can't reach them anyway.
function _pruneDismissedTasks() {
  const dismissed = storeGet('task_dismissed_v1') || [];
  if (!dismissed.length) return;
  const live = new Set();
  storeListKeys('tasks:').forEach(k =>
    (storeGet(k) || []).forEach(g => { if (g.id) live.add(g.id); }));
  const kept = dismissed.filter(id => live.has(id));
  if (kept.length !== dismissed.length) storeSet('task_dismissed_v1', kept);
}

// Record a task id as dismissed so rollover stops carrying it forward.
function dismissTask(id) {
  const list = storeGet('task_dismissed_v1') || [];
  if (!id || list.includes(id)) return;
  storeSet('task_dismissed_v1', list.concat(id));
}

// True when this task also sits on an earlier day — i.e. it was carried
// forward, so deleting it from today should dismiss + purge it. Matches the
// same way _taskInList does (id, or an unfinished text match) so it still
// fires when a pre-id row's id drifted between loads.
function taskAppearsEarlier(g) {
  const active = getActiveDateString();
  return storeListKeys('tasks:').some(k =>
    k.slice(6) < active && (storeGet(k) || []).some(x =>
      (g.id && x.id && x.id === g.id) || (!x.done && x.text === g.text)));
}

// Drop every earlier-day copy of a task being deleted off today — the ones
// rollover would otherwise carry straight back. Matches by id, and by text for
// unfinished copies whose id drifted (pre-id rows are re-minted each load).
// Completed copies stay put as real history.
function purgeTaskHistory(g) {
  const active = getActiveDateString();
  storeListKeys('tasks:').forEach(k => {
    if (k.slice(6) >= active) return;
    const arr = storeGet(k) || [];
    const next = arr.filter(x =>
      !((g.id && x.id && x.id === g.id) || (!x.done && x.text === g.text)));
    if (next.length !== arr.length) storeSet(k, next);
  });
}

// Whole days a still-unfinished task has already spent on earlier lists — how
// overdue it is. 0 when it isn't overdue (first appears today or later, or done).
function taskOverdueDays(g) {
  if (!g.id || g.done) return 0;
  const active = getActiveDateString();
  let earliest = null;
  storeListKeys('tasks:').forEach(k => {
    const d = k.slice(6);
    if (d >= active) return;
    if ((storeGet(k) || []).some(x => x.id === g.id) && (!earliest || d < earliest)) earliest = d;
  });
  return earliest ? _daysApart(earliest, active) : 0;
}

function _daysApart(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// ── Streak check ──
function checkStreak() {
  const activeDate = getActiveDateString();
  let streak = storeGet('task_streak_v1') || { count: 0, lastProcessedDate: null };
  const keys = storeListKeys('tasks:')
    .filter(k => k.slice(6) < activeDate)
    .sort();
  let startFrom = streak.lastProcessedDate;
  for (const k of keys) {
    const date = k.slice(6);
    if (startFrom && date <= startFrom) continue;
    const tasks = storeGet(k) || [];
    if (tasks.length === 0) continue;
    if (tasks.every(g => g.done)) {
      streak.count++;
    } else {
      streak.count = 0;
    }
    streak.lastProcessedDate = date;
  }
  storeSet('task_streak_v1', streak);
  return streak;
}


// ── Render helpers ──
function renderTodayHeader() {
  const tasks = storeGet(todayKey()) || [];
  const total = tasks.length;
  const done  = tasks.filter(g => g.done).length;

  document.getElementById('todayLabel').textContent = `Today — ${formatDate(getActiveDateString())}`;
  document.getElementById('tmProgressNum').textContent = done;
  document.getElementById('tmProgressTotal').textContent = `/${total}`;

  const labelEl = document.getElementById('tmProgressLabel');
  if (total === 0) labelEl.textContent = 'no tasks yet';
  else if (done === total) labelEl.textContent = 'all done — solid day';
  else labelEl.textContent = 'complete';

  const bar = document.getElementById('tmBar');
  bar.innerHTML = '';
  tasks.forEach(g => {
    const seg = document.createElement('div');
    seg.className = 'tm-bar-seg' + (g.done ? ' tm-bar-seg-done' : '');
    bar.appendChild(seg);
  });

  const card = document.getElementById('todayCard');
  if (total > 0 && done === total) card.classList.add('tm-all-done');
  else card.classList.remove('tm-all-done');
}

function renderStreak() {
  const streak = storeGet('task_streak_v1') || { count: 0 };
  document.getElementById('tmStreakNum').textContent = streak.count;
  const el = document.getElementById('tmStreak');
  if (streak.count > 0) el.classList.add('tm-streak-active');
  else el.classList.remove('tm-streak-active');
}

function renderUpcomingCount() {
  const total = upcomingDateKeys()
    .reduce((n, d) => n + (storeGet('tasks:' + d) || []).length, 0);
  document.getElementById('tmTomorrowCount').textContent = `${total} planned`;
}


// ── Build task row ──
// Handlers resolve the task by stable id against the live stored array, so they
// stay correct no matter how the visible list is sorted. `readOnly` locks the
// checkbox (future days); `draggable` enables drag-reorder (custom sort only).
function buildTaskRow(g, idx, tasks, key, readOnly, draggable) {
  const priority = g.priority || 'Medium';
  const priClass = { High: 'task-priority-high', Medium: 'task-priority-med', Low: 'task-priority-low' }[priority] || 'task-priority-med';
  const li = document.createElement('li');
  li.className = 'task-row ' + priClass + (g.done ? ' is-done' : '');
  li.dataset.idx = idx;
  li.dataset.taskId = g.id || '';
  li.draggable = !!draggable;

  const reload = () => { if (key === todayKey()) loadToday(); else loadUpcoming(); };
  const mutate = fn => {
    const arr = storeGet(key) || [];
    const i = arr.findIndex(x => x.id === g.id);
    if (i < 0) return;
    fn(arr, i);
    storeSet(key, arr);
    reload();
  };

  // Priority click strip (invisible, covers left border area)
  const priBtn = document.createElement('button');
  priBtn.className = 'task-priority-btn';
  priBtn.title = `Priority: ${priority} — click to change`;
  priBtn.addEventListener('click', () => {
    // Cycle by colour: High (red) → Low (green) → Medium (yellow) → High …
    const order = ['High', 'Low', 'Medium'];
    mutate((arr, i) => {
      const cur = arr[i].priority || 'Medium';
      arr[i].priority = order[(order.indexOf(cur) + 1) % order.length];
    });
  });
  li.appendChild(priBtn);

  // Drag handle
  const drag = document.createElement('span');
  drag.className = 'task-drag-handle';
  drag.textContent = '⋮⋮';
  drag.setAttribute('aria-hidden', 'true');
  li.appendChild(drag);

  // Checkbox
  const cbWrap = document.createElement('label');
  cbWrap.className = 'task-cb-wrap';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!g.done;
  if (readOnly) { cb.disabled = true; cb.title = 'Unlocks when this day starts (6 AM)'; }
  const cbBox = document.createElement('span');
  cbBox.className = 'task-cb-box';
  cbWrap.appendChild(cb);
  cbWrap.appendChild(cbBox);
  li.appendChild(cbWrap);

  cb.addEventListener('change', () => {
    mutate((arr, i) => {
      arr[i].done = cb.checked;
      if (cb.checked) arr[i].doneAt = new Date().toISOString();
      else delete arr[i].doneAt;
    });
  });

  // Text + its optional tags (overdue, sunday reset) share one flex wrapper, so
  // they sit right after the task name instead of out by the area pill.
  const main = document.createElement('div');
  main.className = 'task-main';

  const txt = document.createElement('span');
  txt.className = 'task-text';
  txt.textContent = g.text;
  makeInlineEdit(txt, g, key, reload);
  main.appendChild(txt);

  const overdueDays = readOnly ? 0 : taskOverdueDays(g);
  if (overdueDays > 0) {
    li.classList.add('is-overdue');
    const od = document.createElement('span');
    od.className = 'task-overdue-tag';
    od.textContent = `overdue · ${overdueDays}d`;
    od.title = `Carried over — first added ${overdueDays} day${overdueDays === 1 ? '' : 's'} ago`;
    main.appendChild(od);
  }

  if (isSundayResetTask(g)) {
    const tag = document.createElement('span');
    tag.className = 'task-source-tag';
    tag.textContent = 'sunday reset';
    main.appendChild(tag);
  }
  li.appendChild(main);

  // Area pill + dropdown
  li.appendChild(buildAreaPill(g.area, newArea => {
    mutate((arr, i) => { arr[i].area = newArea; });
  }));

  // Delete
  const del = document.createElement('button');
  del.className = 'task-delete';
  del.textContent = '×';
  del.title = 'Delete task';
  del.addEventListener('click', () => {
    // A carried-over task also lives on earlier days. Dismiss its id AND purge
    // those copies, so rollover can't resurrect it after a reload even if the
    // dismissed id no longer matches (pre-id rows drift on each load).
    if (key === todayKey() && taskAppearsEarlier(g)) {
      dismissTask(g.id);
      if (!isSundayResetTask(g)) purgeTaskHistory(g);
    }
    mutate((arr, i) => { arr.splice(i, 1); });
  });
  li.appendChild(del);

  return li;
}

function makeInlineEdit(el, g, key, reload) {
  let original = '';
  el.addEventListener('click', () => {
    if (el.contentEditable === 'true') return;
    original = g.text;
    el.contentEditable = 'true';
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  el.addEventListener('blur', () => commit());
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { el.textContent = original; el.contentEditable = 'false'; }
  });
  function commit() {
    const val = el.textContent.trim();
    el.contentEditable = 'false';
    if (val && val !== original) {
      const arr = storeGet(key) || [];
      const i = arr.findIndex(x => x.id === g.id);
      if (i >= 0) { arr[i].text = val; storeSet(key, arr); reload(); }
    } else if (!val) {
      el.textContent = original;
    }
  }
}

// Generic drag-to-reorder for a <ul>/<ol> of `.${rowClass}` rows. Wire once per
// list element. `onReorder(fromEl, toEl)` receives the dragged row element and
// the drop-target row element (guaranteed distinct) and owns the array move +
// persist + re-render. Used by tasks and habits.
function wireDragReorder(listEl, rowClass, onReorder) {
  const sel = '.' + rowClass;
  const clearOver = () => listEl.querySelectorAll(sel).forEach(r => r.classList.remove('drag-over'));
  let dragFromEl = null;
  listEl.addEventListener('dragstart', e => {
    const row = e.target.closest(sel);
    if (!row) return;
    dragFromEl = row;
    e.dataTransfer.effectAllowed = 'move';
  });
  listEl.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest(sel);
    clearOver();
    if (row) row.classList.add('drag-over');
  });
  listEl.addEventListener('dragleave', clearOver);
  listEl.addEventListener('drop', e => {
    e.preventDefault();
    clearOver();
    const row = e.target.closest(sel);
    if (!row || !dragFromEl) return;
    const fromEl = dragFromEl;
    dragFromEl = null;
    if (row !== fromEl) onReorder(fromEl, row);
  });
}

function renderListInto(tasks, listEl, emptyEl, key, readOnly) {
  listEl.innerHTML = '';

  if (tasks.length === 0) {
    emptyEl.style.display = 'block';
    listEl.style.display = 'none';
  } else {
    emptyEl.style.display = 'none';
    listEl.style.display = '';

    const canDrag = !readOnly && getTaskSort() === 'custom';
    tasks.forEach((g, i) => {
      listEl.appendChild(buildTaskRow(g, i, tasks, key, readOnly, canDrag));
    });
  }

  if (!readOnly && !listEl._dragWired) {
    listEl._dragWired = true;
    wireDragReorder(listEl, 'task-row', (fromEl, toEl) =>
      reorderTaskByDrag(todayKey(), fromEl, toEl));
  }

  if (key === todayKey()) renderTodayHeader();
  else renderUpcomingCount();
}

function loadToday() {
  const tasks = storeGet(todayKey()) || [];
  renderListInto(sortTasksForDisplay(tasks, getTaskSort()),
    document.getElementById('taskList'),
    document.getElementById('emptyState'),
    todayKey(), false);
  paintTaskSortBar(document.getElementById('todaySortBar'), tasks.length);
}

// The "Upcoming" card: every future day that has tasks, grouped by date,
// soonest first. Rows are read-only (checkbox locked until the day starts)
// but priority / area / text / delete stay editable.
function loadUpcoming() {
  const wrap    = document.getElementById('upcomingList');
  const emptyEl = document.getElementById('tomorrowEmptyState');
  if (!wrap) return;
  wrap.innerHTML = '';

  const target = plannerTargetDate();
  const dateInput = document.getElementById('plannerDateInput');
  if (dateInput) {
    dateInput.min = getTomorrowDateString();
    if (dateInput.value !== target) dateInput.value = target;
  }
  const inp = document.getElementById('tomorrowInput');
  if (inp) inp.placeholder = `Add a task for ${formatDate(target)}…`;

  document.getElementById('tomorrowLabel').textContent = 'Upcoming';

  const mode = getTaskSort();
  const canDrag = mode === 'custom';
  const days = upcomingDateKeys().filter(d => (storeGet('tasks:' + d) || []).length > 0);
  const totalUpcoming = days.reduce((n, d) => n + storeGet('tasks:' + d).length, 0);
  paintTaskSortBar(document.getElementById('upcomingSortBar'), totalUpcoming);
  renderUpcomingCount();
  emptyEl.style.display = days.length ? 'none' : 'block';

  days.forEach(date => {
    const key   = 'tasks:' + date;
    const tasks = storeGet(key) || [];
    const head = document.createElement('div');
    head.className = 'upcoming-day';
    head.innerHTML = `<span>${formatDate(date)}</span>` +
      `<span class="upcoming-day-count">${tasks.length}</span>`;
    wrap.appendChild(head);

    const ul = document.createElement('ul');
    ul.className = 'task-list';
    sortTasksForDisplay(tasks, mode).forEach((g, i) =>
      ul.appendChild(buildTaskRow(g, i, tasks, key, true, canDrag)));
    if (canDrag) wireDragReorder(ul, 'task-row', (fromEl, toEl) => reorderTaskByDrag(key, fromEl, toEl));
    wrap.appendChild(ul);
  });
}

// ── Status message helper ──
function showStatus(el, msg, color, ms) {
  el.textContent = msg;
  el.style.color = color || 'var(--text-tertiary)';
  setTimeout(() => { el.textContent = ''; el.style.color = ''; }, ms || 3500);
}

// ── Polish via Claude API ──
async function polishTask(text, statusEl) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Clean up and improve this single task into a concise, actionable task. Return ONLY a one-element JSON array of strings with no extra text, no markdown fences. Task: "${text}"`
        }]
      })
    });
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    const raw = data.content[0].text.trim();
    const parsed = JSON.parse(raw);
    return parsed[0];
  } catch (e) {
    return null;
  }
}

// ── Add + Polish handlers ──
function makeAddHandlers(inputEl, addBtn, polishBtn, getKey, statusEl, reload) {
  function addTask(text) {
    if (!text) return;
    const tasks = storeGet(getKey()) || [];
    tasks.push(makeTask({ text }));
    storeSet(getKey(), tasks);
    inputEl.value = '';
    reload();
  }

  addBtn.addEventListener('click', () => addTask(inputEl.value.trim()));
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') addTask(inputEl.value.trim());
  });

  polishBtn.addEventListener('click', async () => {
    const raw = inputEl.value.trim();
    if (!raw) return;
    if (!ANTHROPIC_API_KEY) {
      addTask(raw);
      showStatus(statusEl, 'Polish needs an Anthropic API key — added as-typed.', 'var(--text-tertiary)', 3500);
      return;
    }
    polishBtn.disabled = true;
    polishBtn.textContent = '✨ Polishing…';
    const polished = await polishTask(raw, statusEl);
    polishBtn.disabled = false;
    polishBtn.textContent = '✨ Polish';
    if (polished) {
      addTask(polished);
    } else {
      addTask(raw);
      showStatus(statusEl, 'Polish failed — added as-typed.', 'var(--danger)', 3500);
    }
  });
}

// ── Upcoming card: date picker for the target day of new tasks ──
// (min/value are seeded by loadUpcoming(), which runs after main.js loads the
// date helpers; here we only wire the change handler.)
document.getElementById('plannerDateInput').addEventListener('change', e => {
  const input = e.target;
  const min = getTomorrowDateString();
  if (!input.value || input.value < min) input.value = min;
  plannerDate = input.value;
  loadUpcoming();
});


// ── Sunday Reset — weekly recurring to-dos ─────────────────────────────────
// A fixed Sunday-only checklist. Entries are managed in a slide-in view and
// auto-injected into Sunday's To Do list, rolling over normally if unfinished.
// Persisted as two `settings` keys (rehydrated generically in loadFromSupabase):
//   sunday_reset_v1     – [{ id, text, area }] templates
//   sunday_reset_log_v1 – { "<Sunday YYYY-MM-DD>": [injected template ids] }

function getSundayReset()      { return MEM['sunday_reset_v1'] || []; }
function saveSundayReset(list) { MEM['sunday_reset_v1'] = list; _syncSetting('sunday_reset_v1', list); }

// True when a task came from a Sunday Reset template — matched by text, the same
// identity applySundayReset() and _removeInjectedTask() use. Drives the row tag.
function isSundayResetTask(g) {
  return getSundayReset().some(it => it.text === g.text);
}

function _srId() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function _isSunday(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).getDay() === 0;
}

// Inject not-yet-added Sunday Reset entries into the active day's tasks, but only
// when the active day is a Sunday. Idempotent per (Sunday date × entry id) via
// the log map, so deleting an injected task doesn't resurrect it on the next
// refresh, while an entry added mid-Sunday still lands in today's list.
function applySundayReset() {
  const ds = getActiveDateString();
  if (!_isSunday(ds)) return;
  const items = getSundayReset();
  if (!items.length) return;

  const log   = MEM['sunday_reset_log_v1'] || {};
  const done  = log[ds] || [];
  const tasks = storeGet('tasks:' + ds) || [];
  const texts = new Set(tasks.map(g => g.text));

  let added = false;
  items.forEach(it => {
    if (done.includes(it.id)) return;
    if (!texts.has(it.text)) {
      tasks.push(makeTask({ text: it.text, area: it.area || null }));
      texts.add(it.text);
      added = true;
    }
    done.push(it.id);
  });

  log[ds] = done;
  Object.keys(log).sort().slice(0, -8).forEach(k => delete log[k]); // keep ~8 Sundays
  MEM['sunday_reset_log_v1'] = log;
  _syncSetting('sunday_reset_log_v1', log);

  if (added) storeSet('tasks:' + ds, tasks); // persists + fires tasks-changed
}

// ── Sunday Reset slide-in view ──
function _syncSundayResetBtn() {
  const btn = document.getElementById('sundayResetBtn');
  if (!btn) return;
  const n = getSundayReset().length;
  btn.textContent = n ? `↻ Sunday Reset · ${n}` : '↻ Sunday Reset';
}

function _nextSundayLabel() {
  const ds = getActiveDateString();
  if (_isSunday(ds)) return 'Today';
  const [y, m, d] = ds.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  base.setDate(base.getDate() + ((7 - base.getDay()) % 7));
  return formatDate(_localDateStr(base));
}

function _afterSundayResetChange() {
  renderSundayResetPage();
  _syncSundayResetBtn();
  if (_isSunday(getActiveDateString())) { applySundayReset(); loadToday(); }
}

// When an entry is deleted on a Sunday, also pull the task it injected out of
// today's To Do list (matched by text, the same way injection dedups) and drop
// its id from today's injection log so state stays consistent.
function _removeInjectedTask(entry) {
  const ds = getActiveDateString();
  if (!_isSunday(ds)) return;

  const tasks = storeGet('tasks:' + ds) || [];
  const next  = tasks.filter(g => g.text !== entry.text);
  if (next.length !== tasks.length) storeSet('tasks:' + ds, next);

  const log = MEM['sunday_reset_log_v1'] || {};
  if (log[ds] && log[ds].includes(entry.id)) {
    log[ds] = log[ds].filter(id => id !== entry.id);
    MEM['sunday_reset_log_v1'] = log;
    _syncSetting('sunday_reset_log_v1', log);
  }
}

// Small inline text editor for a Sunday Reset row (the shared makeInlineEdit is
// coupled to storeSet's key-based persistence, which these entries don't use).
function _srInlineEdit(el, item) {
  let original = '';
  el.addEventListener('click', () => {
    if (el.contentEditable === 'true') return;
    original = item.text;
    el.contentEditable = 'true';
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  el.addEventListener('blur', commit);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { el.textContent = item.text; el.contentEditable = 'false'; }
  });
  function commit() {
    const val = el.textContent.trim();
    el.contentEditable = 'false';
    if (val && val !== item.text) {
      item.text = val;
      saveSundayReset(getSundayReset());
      _afterSundayResetChange();
    } else if (!val) {
      el.textContent = item.text;
    }
  }
}

function renderSundayResetPage() {
  const body = document.getElementById('sundayResetBody');
  if (!body) return;
  const items = getSundayReset();

  body.innerHTML = `
    <p class="sunday-reset-intro">
      These tasks drop into your To&nbsp;Do list every Sunday and roll over if you
      don't finish them. Next reset: <strong>${_nextSundayLabel()}</strong>.
    </p>
    <ul class="sunday-reset-list" id="sundayResetList"></ul>
    <div id="sundayResetEmpty" class="empty-state"${items.length ? ' style="display:none;"' : ''}>No weekly tasks yet — add one below.</div>
    <div class="task-input-wrap tm-input-wrap">
      <input type="text" class="task-input" id="sundayResetInput" placeholder="Add a weekly task…">
      <button class="btn-add" id="sundayResetAdd">+ Add</button>
    </div>`;

  const list = document.getElementById('sundayResetList');
  items.forEach(it => {
    const li = document.createElement('li');
    li.className = 'task-row sunday-reset-row';

    const txt = document.createElement('span');
    txt.className = 'task-text';
    txt.textContent = it.text;
    _srInlineEdit(txt, it);
    li.appendChild(txt);

    li.appendChild(buildAreaPill(it.area || null, newArea => {
      it.area = newArea;
      saveSundayReset(getSundayReset());
      _afterSundayResetChange();
    }));

    const del = document.createElement('button');
    del.className = 'task-delete';
    del.textContent = '×';
    del.title = 'Remove from Sunday Reset';
    del.addEventListener('click', () => {
      _removeInjectedTask(it);
      saveSundayReset(getSundayReset().filter(x => x.id !== it.id));
      _afterSundayResetChange();
    });
    li.appendChild(del);

    list.appendChild(li);
  });

  const inp = document.getElementById('sundayResetInput');
  const add = () => {
    const text = inp.value.trim();
    if (!text) return;
    saveSundayReset(getSundayReset().concat({ id: _srId(), text, area: null }));
    _afterSundayResetChange();
    document.getElementById('sundayResetInput').focus();
  };
  document.getElementById('sundayResetAdd').addEventListener('click', add);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
}

function openSundayReset() {
  renderSundayResetPage();
  const modal = document.getElementById('sundayResetModal');
  modal.classList.add('open');
  modal.querySelector('.sr-modal-card').scrollTop = 0;
  document.body.style.overflow = 'hidden';
}
function closeSundayReset() {
  document.getElementById('sundayResetModal').classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('sundayResetBtn').addEventListener('click', openSundayReset);
document.getElementById('sundayResetClose').addEventListener('click', closeSundayReset);
document.getElementById('sundayResetModal').addEventListener('click', e => {
  if (e.target.id === 'sundayResetModal') closeSundayReset(); // backdrop click only
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('sundayResetModal').classList.contains('open')) closeSundayReset();
});


// ── Task history — read-only view of past days ─────────────────────────────
// Past days' `tasks:` entries are retained (rollover no longer deletes them);
// this lists them newest-first so you can see what was set and what got done.
const TASK_HISTORY_DAYS = 90; // matches loadFromSupabase's 90-day window

// Display-only area pill (buildAreaPill always wires a click-to-edit dropdown).
// Returns null when the task has no (known) area, so history rows stay clean.
function _historyAreaPill(areaName) {
  if (!areaName) return null;
  const areaObj = getAreas().find(a => a.name === areaName);
  if (!areaObj) return null;
  const pill = document.createElement('span');
  pill.className = 'task-area-pill';
  pill.textContent = areaName;
  pill.style.background = areaObj.color + 'BF';
  pill.style.color = '#fff';
  return pill;
}

function renderTaskHistory() {
  const body = document.getElementById('taskHistoryBody');
  if (!body) return;
  body.innerHTML = '';

  const activeDate = getActiveDateString();
  const days = storeListKeys('tasks:')
    .map(k => k.slice(6))
    .filter(d => d < activeDate)
    .sort()
    .reverse()
    .slice(0, TASK_HISTORY_DAYS);

  if (days.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No past days yet — history builds up as days roll over.';
    body.appendChild(empty);
    return;
  }

  days.forEach(date => {
    const tasks = storeGet('tasks:' + date) || [];
    const done  = tasks.filter(g => g.done).length;

    const head = document.createElement('div');
    head.className = 'task-history-day';
    head.innerHTML = `<span>${formatDate(date)}</span>` +
      `<span class="task-history-count">${done}/${tasks.length}</span>`;
    body.appendChild(head);

    if (tasks.length === 0) return;

    const ul = document.createElement('ul');
    ul.className = 'task-list task-history-list';
    tasks.forEach(g => {
      const priClass = { High: 'task-priority-high', Medium: 'task-priority-med', Low: 'task-priority-low' }[g.priority || 'Medium'] || 'task-priority-med';
      const li = document.createElement('li');
      li.className = 'task-row ' + priClass + (g.done ? ' is-done' : '');

      const mark = document.createElement('span');
      mark.className = 'task-history-mark';
      mark.textContent = g.done ? '✓' : '○';
      li.appendChild(mark);

      const txt = document.createElement('span');
      txt.className = 'task-text';
      txt.textContent = g.text;
      li.appendChild(txt);

      const pill = _historyAreaPill(g.area || null);
      if (pill) li.appendChild(pill);
      ul.appendChild(li);
    });
    body.appendChild(ul);
  });
}

function openTaskHistory() {
  renderTaskHistory();
  const modal = document.getElementById('taskHistoryModal');
  modal.classList.add('open');
  modal.querySelector('.sr-modal-card').scrollTop = 0;
  document.body.style.overflow = 'hidden';
}
function closeTaskHistory() {
  document.getElementById('taskHistoryModal').classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('taskHistoryBtn').addEventListener('click', openTaskHistory);
document.getElementById('taskHistoryClose').addEventListener('click', closeTaskHistory);
document.getElementById('taskHistoryModal').addEventListener('click', e => {
  if (e.target.id === 'taskHistoryModal') closeTaskHistory(); // backdrop click only
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('taskHistoryModal').classList.contains('open')) closeTaskHistory();
});
