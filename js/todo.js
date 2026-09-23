// To Do tab: rollover, streak, grouped task list (Focus / To do, or by
// priority / area), task rows (steps, due dates, estimates), drag-reorder,
// inline edit, the Add task modal + polish. Loaded before main.js.

// The task currently being dragged (id + origin day-key), while a task-row
// drag is in progress; null otherwise (including while a habit row, which
// has no dataset.taskId, is being dragged). Lets a drop-target card tell an
// in-list reorder apart from a genuine cross-day drag during dragover, when
// dataTransfer's own payload isn't readable yet for security reasons.
let _draggedTaskInfo = null;

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
// exact text match against an unfinished entry. The text arm is a display
// guard here (don't show the same wording twice on one day), and declining to
// carry costs nothing: the task stays in history and comes forward as soon as
// the row blocking it is done or gone.
function _taskInList(g, list) {
  return list.some(x =>
    (g.id && x.id && x.id === g.id) ||
    (!x.done && x.text === g.text));
}

// Same-task test for the DESTRUCTIVE paths (dismiss + purge). Identity is the
// stable id; the text fallback applies only when one side's id isn't stable —
// i.e. loadFromSupabase minted it this load and failed to persist it, so it will
// be different next load. Everywhere else, matching on text alone meant deleting
// today's "Laundry" also erased an unrelated "Laundry" from three weeks back.
function _taskIdUnstable(x) { return !!(x && x.idUnstable); }

function _sameTask(g, x) {
  if (g.id && x.id && x.id === g.id) return true;
  return !x.done && (_taskIdUnstable(g) || _taskIdUnstable(x)) && x.text === g.text;
}

// ── Upcoming (future-dated) tasks ──
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
  // Completed tasks always sink to the bottom (stable sort keeps their relative
  // order), so checking one off slides it down — see _flipTaskRows.
  arr.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
  return arr; // 'custom' / unknown → stored order, done last
}

// FLIP-animate the `.task-row` children of `listEl` around a rebuild: measure
// where each row is, run `doReload()` to re-render, then slide every row from
// its old position to its new one. Rows are matched across the rebuild by
// `data-task-id`. Mirrors habits.js's _flipRows.
function _flipTaskRows(listEl, doReload) {
  if (!listEl || matchMedia('(prefers-reduced-motion: reduce)').matches) { doReload(); return; }
  const firstTop = new Map();
  listEl.querySelectorAll('.task-row').forEach(r => firstTop.set(r.dataset.taskId, r.getBoundingClientRect().top));
  doReload();
  listEl.querySelectorAll('.task-row').forEach(r => {
    const prev = firstTop.get(r.dataset.taskId);
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

function paintTaskSortBar(el, count, label) {
  if (!el) return;
  el.hidden = !(count > 1);           // nothing to sort with 0–1 tasks
  if (el.hidden) { el.innerHTML = ''; return; }
  const mode = getTaskSort();
  el.innerHTML = `<span class="task-sort-label">${label || 'Sort'}</span>` +
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
  // Completed rows render at the bottom of the list whatever their stored
  // position (sortTasksForDisplay sinks them), so dropping on one means "make
  // this the last open task". Moving to the done row's *stored* index instead
  // lands the row somewhere the list never shows — usually looking like the
  // drag did nothing at all.
  const dropLast = arr[to].done;
  const [item] = arr.splice(from, 1);
  if (dropLast) {
    let lastOpen = -1;
    arr.forEach((g, i) => { if (!g.done) lastOpen = i; });
    arr.splice(lastOpen + 1, 0, item);
  } else {
    // `to` was found before the splice above removed `from`'s row — dragging
    // forward (from < to) shifts every later index left by one, so it has to
    // be adjusted or the item lands one row past the intended drop target.
    arr.splice(to > from ? to - 1 : to, 0, item);
  }
  storeSet(key, arr);
  if (key === todayKey()) loadToday(); else loadUpcoming();
}

// Move a task from one day's stored array to another's, matched by stable id
// — the drop side of dragging a row onto the Upcoming card. No-ops if the
// dates are the same or the task can't be found, and skips the move (leaving
// the source alone) if the destination already has this exact task id — e.g.
// a rollover copy already carried onto that day. Matched by id only (not
// _taskInList's text fallback): two unrelated tasks that happen to share
// wording shouldn't block a drag that's clearly about a specific row.
function moveTaskToDate(fromKey, taskId, toDate) {
  const toKey = 'tasks:' + toDate;
  if (fromKey === toKey) return;
  const fromArr = storeGet(fromKey) || [];
  const idx = fromArr.findIndex(g => g.id === taskId);
  if (idx < 0) return;
  const toArr = storeGet(toKey) || [];
  if (toArr.some(x => x.id === taskId)) return;
  const [task] = fromArr.splice(idx, 1);
  storeSet(fromKey, fromArr);
  toArr.push(task);
  storeSet(toKey, toArr);
  if (fromKey === todayKey() || toKey === todayKey()) loadToday();
  loadUpcoming();
}

// Wire `card` as a cross-day drop target for rows dragged out of a different
// day's list (Today <-> Upcoming, or between two Upcoming days). The card
// element is static across loadToday()/loadUpcoming() rebuilds, so this is
// wired once per card. `resolveDate(e)` inspects the drop event and returns
// the destination date string.
function wireCrossDayDrop(card, resolveDate) {
  card.addEventListener('dragover', e => {
    e.preventDefault();
    // Hovering over the row's own day (an in-list reorder in progress, or a
    // task hovering the empty space of the day it's already on) would be a
    // no-op move — don't outline the whole card for it, only for a hover
    // that would actually reschedule the task.
    if (_draggedTaskInfo && 'tasks:' + resolveDate(e) === _draggedTaskInfo.fromKey) return;
    card.classList.add('drop-target-active');
  });
  card.addEventListener('dragleave', e => {
    if (!card.contains(e.relatedTarget)) card.classList.remove('drop-target-active');
  });
  // dragend always fires on the drag source, whatever ends the drag (a drop
  // wherever it landed, or the drag being cancelled entirely) — a document
  // listener guarantees the highlight can't get stuck if the drag ends
  // without a dragleave/drop ever reaching this card.
  document.addEventListener('dragend', () => card.classList.remove('drop-target-active'));
  card.addEventListener('drop', e => {
    e.preventDefault();
    card.classList.remove('drop-target-active');
    let payload = null;
    try { payload = JSON.parse(e.dataTransfer.getData('text/plain') || ''); } catch (err) { /* not a task drag */ }
    if (!payload || !payload.id || !payload.fromKey) return;
    moveTaskToDate(payload.fromKey, payload.id, resolveDate(e));
  });
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
//   • the same task (same id) is done on some later day — checking a carried
//     task off only marks the copy on the day you checked it, so its unfinished
//     originals stay unfinished in history and would otherwise carry forward
//     again the next morning, forever, or
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

  // Every task id that has been checked off on some day — the task is finished
  // even if older copies of it are still sitting unfinished in history.
  const completed = new Set();
  storeListKeys('tasks:').forEach(k =>
    (storeGet(k) || []).forEach(g => { if (g.done && g.id) completed.add(g.id); }));

  const todayTasks = storeGet(todayKey()) || [];
  let added = false;

  storeListKeys('tasks:')
    .filter(k => k.slice(6) < activeDate)
    .sort()
    .forEach(k => {
      (storeGet(k) || []).forEach(g => {
        if (g.done || !g.id) return;
        if (completed.has(g.id)) return;
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
// A stranded copy is any future-dated task whose id ALSO sits on today
// specifically (not just any earlier day — see below). Planner tasks get a
// fresh id, so they never match. Drop the future copy; the real one on today
// carries forward normally below.
//
// This used to match "today or an earlier day", but dragging a task forward
// (js/todo.js moveTaskToDate) legitimately creates that same shape on
// purpose: an old, chronically-overdue task keeps its original day's row as
// history (rollover never deletes it) while the drag removes it from today
// and places it on a future date. That's not a stranded clock-glitch copy —
// it's the point of the feature — but the old "<= activeDate" check couldn't
// tell the two apart and deleted the deliberate future placement every load,
// which let rollover's carry-forward put the task right back on today.
// Narrowing to "today exactly" keeps the clock-glitch case (rollover only
// ever strands copies by copying FROM today, so the genuine original is
// always still on today when the clock corrects) while leaving an
// intentionally-rescheduled task's older history rows alone.
function reclaimStrandedFutureTasks(activeDate) {
  const onToday = new Set();
  (storeGet('tasks:' + activeDate) || []).forEach(g => { if (g.id) onToday.add(g.id); });
  if (!onToday.size) return;

  storeListKeys('tasks:').forEach(k => {
    if (k.slice(6) <= activeDate) return;
    const arr = storeGet(k) || [];
    const kept = arr.filter(g => !g.id || !onToday.has(g.id));
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
// forward, so deleting it from today should dismiss + purge it.
function taskAppearsEarlier(g) {
  const active = getActiveDateString();
  return storeListKeys('tasks:').some(k =>
    k.slice(6) < active && (storeGet(k) || []).some(x => _sameTask(g, x)));
}

// Drop every earlier-day copy of a task being deleted off today — the ones
// rollover would otherwise carry straight back. Identity per _sameTask.
//
// Completed copies stay put as real history: rollover never carries a done task
// anyway, so removing them achieves nothing and rewrites days you already
// lived. The `x.done ||` guard is what enforces that — before it, the id arm
// deleted done rows too, so deleting a task off today (say, after finally
// finishing it) quietly erased every day you'd ticked it off, changing those
// days' counts in the History view.
function purgeTaskHistory(g) {
  const active = getActiveDateString();
  storeListKeys('tasks:').forEach(k => {
    if (k.slice(6) >= active) return;
    const arr = storeGet(k) || [];
    const next = arr.filter(x => x.done || !_sameTask(g, x));
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
  const stored = storeGet('task_streak_v1') || { count: 0, lastProcessedDate: null };
  const streak = { count: stored.count, lastProcessedDate: stored.lastProcessedDate };
  const keys = storeListKeys('tasks:')
    .filter(k => k.slice(6) < activeDate)
    .sort();
  let startFrom = streak.lastProcessedDate;
  for (const k of keys) {
    const date = k.slice(6);
    if (startFrom && date <= startFrom) continue;
    const tasks = storeGet(k) || [];
    if (tasks.length === 0) continue;
    // A day counts when its Focus tasks are all done. Days where nothing was
    // starred fall back to the old rule (every task done) — rollover keeps
    // stale tasks on every list, so that rule alone could almost never pass.
    const focus = tasks.filter(g => g.focus);
    if ((focus.length ? focus : tasks).every(g => g.done)) {
      streak.count++;
    } else {
      streak.count = 0;
    }
    streak.lastProcessedDate = date;
  }
  // Only persist when a day was actually scored. main.js's bootstrap calls this
  // once before any data has loaded, and an unconditional write there pushed
  // {count: 0, lastProcessedDate: null} into `settings` — racing
  // loadFromSupabase and wiping the real streak whenever it landed last.
  if (streak.count !== stored.count || streak.lastProcessedDate !== stored.lastProcessedDate)
    storeSet('task_streak_v1', streak);
  return streak;
}


// ── Render helpers ──
function renderTodayHeader() {
  const tasks = storeGet(todayKey()) || [];
  const total = tasks.length;
  const done  = tasks.filter(g => g.done).length;
  const focus = tasks.filter(g => g.focus);

  const labelEl = document.getElementById('tmProgressLabel');
  if (focus.length) {
    // Focus is the headline number; the full count rides along after it.
    document.getElementById('tmProgressNum').textContent = focus.filter(g => g.done).length;
    document.getElementById('tmProgressTotal').textContent = `/${focus.length}`;
    labelEl.textContent = `focus done · ${done}/${total} total`;
  } else {
    document.getElementById('tmProgressNum').textContent = done;
    document.getElementById('tmProgressTotal').textContent = `/${total}`;
    if (total === 0) labelEl.textContent = 'no tasks yet';
    else if (done === total) labelEl.textContent = 'all done — solid day';
    else labelEl.textContent = 'complete';
  }

  const card = document.getElementById('todayCard');
  card.classList.toggle('tm-all-done', total > 0 && done === total);
  if (typeof renderDayStripTasks === 'function') renderDayStripTasks();
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


// ── Task extras: steps, due date, estimate ──
// A task named like a checklist — "Hair (Nose, Ears, Neck)" or "Shopping Haul:
// Towel, Pink Salt" — shows its list as tickable steps without being rewritten:
// the name stays as typed (Sunday Reset matches its tasks by text), and step
// ticks are stored in `g.steps` once you tick one.
const _STEP_LIST_RES = [/^(.+?)\s*\(([^()]+)\)\s*$/, /^([^:]+):\s*(.+)$/];

function _parseStepList(text) {
  for (const re of _STEP_LIST_RES) {
    const m = String(text || '').match(re);
    if (!m) continue;
    const items = m[2].split(',').map(x => x.trim()).filter(Boolean);
    if (items.length >= 2) return { title: m[1].trim(), items };
  }
  return null;
}

// What a row shows: the title (the name minus a parsed list) and its steps.
function taskStepsView(g) {
  const parsed = _parseStepList(g.text);
  if (Array.isArray(g.steps) && g.steps.length) {
    const fromText = parsed && parsed.items.length === g.steps.length &&
      parsed.items.every((t, i) => t === g.steps[i].text);
    return { title: fromText ? parsed.title : g.text, steps: g.steps, fromText };
  }
  if (parsed) return { title: parsed.title, steps: parsed.items.map(text => ({ text, done: false })), fromText: true };
  return { title: g.text, steps: [], fromText: false };
}

// Steps for a renamed task: a list that came from the old name follows the new
// name (keeping ticks on items that survive); steps added by hand are kept.
function _stepsAfterRename(g, newText) {
  const view = taskStepsView(g);
  if (!view.fromText) return g.steps;
  const parsed = _parseStepList(newText);
  if (!parsed) return undefined;
  const was = new Map(view.steps.map(x => [x.text, x.done]));
  return parsed.items.map(text => ({ text, done: !!was.get(text) }));
}

function _fmtEst(min) {
  if (!(min > 0)) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// [label, urgent] for a due date relative to the active day.
function _dueLabel(due) {
  const d = _daysApart(getActiveDateString(), due);
  if (d < 0)  return ['past due', true];
  if (d === 0) return ['due today', true];
  if (d === 1) return ['due tomorrow', true];
  const pretty = formatDate(due);              // "Wed, Sep 30"
  return [d < 7 ? 'due ' + pretty.split(',')[0] : 'due ' + pretty.split(', ')[1], false];
}

// Star a task into (or out of) today's Focus — at most 3 open at once.
const FOCUS_MAX = 3;
function toggleTaskFocus(key, id) {
  const arr = storeGet(key) || [];
  const i = arr.findIndex(x => x.id === id);
  if (i < 0) return;
  if (!arr[i].focus && arr.filter(x => x.focus && !x.done).length >= FOCUS_MAX) {
    showToast(`Focus is full — unstar one first (max ${FOCUS_MAX})`);
    return;
  }
  arr[i] = Object.assign({}, arr[i]);
  if (arr[i].focus) delete arr[i].focus; else arr[i].focus = true;
  storeSet(key, arr);
  _flipTaskRows(document.getElementById('taskList'), loadToday);
}

// ── Toast ── one short confirmation at the bottom of the screen.
let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('appToast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// Left-edge priority colour: High red, Medium amber, Low green.
function _priClass(priority) {
  return { High: 'task-priority-high', Low: 'task-priority-low' }[priority] || 'task-priority-med';
}

// ── Build task row ──
// Handlers resolve the task by stable id against the live stored array, so they
// stay correct no matter how the visible list is grouped. `readOnly` locks the
// checkbox (future days); `draggable` enables drag-reorder (custom order only).
// Arrays on a task (steps) are always replaced, never mutated in place: rollover
// copies tasks shallowly, so the same array can sit on several days' copies.
function buildTaskRow(g, idx, tasks, key, readOnly, draggable) {
  const priority = g.priority || 'Medium';
  const isToday = key === todayKey();
  const isSR = isSundayResetTask(g);
  const view = taskStepsView(g);
  const li = document.createElement('li');
  li.className = 'task-row ' + _priClass(priority) + (g.done ? ' is-done' : '') +
    (isSR ? ' is-sr' : '') + (g.focus ? ' is-focus' : '');
  li.dataset.idx = idx;
  li.dataset.taskId = g.id || '';
  li.dataset.taskKey = key;
  li.draggable = !!draggable && !g.done;   // done rows sit in the Done section, no drag

  const reload = () => { if (isToday) loadToday(); else loadUpcoming(); };
  const mutate = fn => {
    const arr = storeGet(key) || [];
    const i = arr.findIndex(x => x.id === g.id);
    if (i < 0) return;
    arr[i] = Object.assign({}, arr[i]);
    fn(arr, i);
    storeSet(key, arr);
    reload();
  };
  const cyclePriority = () => {
    // Cycle by colour: High (red) → Low (green) → Medium (yellow) → High …
    const order = ['High', 'Low', 'Medium'];
    mutate((arr, i) => {
      const cur = arr[i].priority || 'Medium';
      arr[i].priority = order[(order.indexOf(cur) + 1) % order.length];
    });
  };

  // Priority click strip (invisible, covers left edge)
  const priBtn = document.createElement('button');
  priBtn.className = 'task-priority-btn';
  priBtn.title = `Priority: ${priority} — click to change`;
  priBtn.addEventListener('click', cyclePriority);
  li.appendChild(priBtn);

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
  cb.setAttribute('aria-label', 'Complete ' + g.text);
  if (readOnly) { cb.disabled = true; cb.title = 'Unlocks when this day starts (6 AM)'; }
  const cbBox = document.createElement('span');
  cbBox.className = 'task-cb-box';
  cbWrap.appendChild(cb);
  cbWrap.appendChild(cbBox);
  li.appendChild(cbWrap);

  cb.addEventListener('change', () => {
    const arr = storeGet(key) || [];
    const i = arr.findIndex(x => x.id === g.id);
    if (i < 0) return;
    const t = arr[i] = Object.assign({}, arr[i]);
    t.done = cb.checked;
    if (cb.checked) t.doneAt = new Date().toISOString();
    else delete t.doneAt;
    // Ticking the task ticks its steps; unticking a fully-ticked list clears it.
    if (view.steps.length) {
      if (cb.checked) t.steps = view.steps.map(x => ({ text: x.text, done: true }));
      else if (view.steps.every(x => x.done)) t.steps = view.steps.map(x => ({ text: x.text, done: false }));
    }
    storeSet(key, arr);
    if (isToday) _flipTaskRows(document.getElementById('taskList'), loadToday);
    else reload();
  });

  // Name + tags on one line (tags sit right after the name), steps underneath.
  const main = document.createElement('div');
  main.className = 'task-main';
  const line = document.createElement('div');
  line.className = 'task-line';

  const txt = document.createElement('span');
  txt.className = 'task-text';
  txt.textContent = view.title;
  makeInlineEdit(txt, g, key, reload, view.title);
  line.appendChild(txt);

  const overdueDays = readOnly ? 0 : taskOverdueDays(g);
  if (overdueDays > 0) {
    li.classList.add('is-overdue');
    const od = document.createElement('span');
    od.className = 'task-overdue-tag';
    od.textContent = `overdue · ${overdueDays}d`;
    od.title = `Carried over — first added ${overdueDays} day${overdueDays === 1 ? '' : 's'} ago`;
    line.appendChild(od);
  }

  if (g.due && !g.done) {
    const [label, urgent] = _dueLabel(g.due);
    const du = document.createElement('span');
    du.className = 'task-due-tag' + (urgent ? ' is-urgent' : '');
    du.textContent = label;
    du.title = 'Due ' + formatDate(g.due);
    line.appendChild(du);
  }

  if (isSR) {
    const tag = document.createElement('span');
    tag.className = 'task-sr-badge';
    tag.title = 'Added by Sunday Reset — comes back every Sunday';
    tag.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>Sunday reset';
    line.appendChild(tag);
  }

  if (view.steps.length) {
    const ct = document.createElement('span');
    ct.className = 'task-steps-count';
    ct.textContent = `${view.steps.filter(x => x.done).length}/${view.steps.length}`;
    line.appendChild(ct);
  }
  main.appendChild(line);

  if (view.steps.length) {
    const steps = document.createElement('div');
    steps.className = 'task-steps';
    view.steps.forEach((st, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'task-step' + (st.done ? ' is-done' : '');
      b.textContent = st.text;
      b.setAttribute('aria-pressed', st.done ? 'true' : 'false');
      if (readOnly) b.disabled = true;
      b.addEventListener('click', () => {
        const next = view.steps.map((x, j) => ({ text: x.text, done: j === k ? !x.done : !!x.done }));
        const allDone = next.every(x => x.done);
        mutate((arr, i) => {
          arr[i].steps = next;
          if (allDone && !arr[i].done) { arr[i].done = true; arr[i].doneAt = new Date().toISOString(); }
          else if (!allDone && arr[i].done) { arr[i].done = false; delete arr[i].doneAt; }
        });
      });
      steps.appendChild(b);
    });
    main.appendChild(steps);
  }
  li.appendChild(main);

  // Right side: hover actions, area pill, estimate.
  const side = document.createElement('div');
  side.className = 'task-side';
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  const action = (label, title, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'task-action' + (cls ? ' ' + cls : '');
    b.innerHTML = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    actions.appendChild(b);
  };
  if (isToday && !g.done) {
    action(g.focus ? '★' : '☆', g.focus ? 'Remove from Focus' : 'Add to Focus', g.focus ? 'is-on' : '',
      () => toggleTaskFocus(key, g.id));
    action('↷', 'Move to tomorrow', '', () => {
      moveTaskToDate(key, g.id, getTomorrowDateString());
      showToast('Moved to tomorrow');
    });
  }
  action(`<span class="task-pri-dot pri-${priority.toLowerCase()}"></span>`, `Priority: ${priority} — click to change`, '', cyclePriority);

  // Delete
  action('×', 'Delete task', 'task-delete', () => { deleteTask(key, g); reload(); });
  side.appendChild(actions);

  // Area pill + dropdown
  side.appendChild(buildAreaPill(g.area, newArea => {
    mutate((arr, i) => { arr[i].area = newArea; });
  }));

  if (g.est > 0) {
    const est = document.createElement('span');
    est.className = 'task-est';
    est.textContent = _fmtEst(g.est);
    est.title = 'Estimate';
    side.appendChild(est);
  }
  li.appendChild(side);

  return li;
}

// Delete a task from one day's list so it stays gone. Shared by the row's ×,
// triage's Drop and "move to Someday".
function deleteTask(key, g) {
  // A carried-over task also lives on earlier days — including one that's
  // since been dragged onto a future Upcoming date, which is why this isn't
  // gated to `key === todayKey()`. Dismiss its id AND purge those copies, so
  // rollover can't resurrect it after a reload even if the dismissed id no
  // longer matches (pre-id rows drift on each load).
  const isSR = isSundayResetTask(g);
  if (taskAppearsEarlier(g)) {
    dismissTask(g.id);
    if (!isSR) purgeTaskHistory(g);
  }
  // A Sunday Reset task deleted on a Sunday must stay deleted — otherwise the
  // next refresh re-injects it.
  if (key === todayKey() && isSR) noteSundayResetTaskRemoved(g);
  const arr = storeGet(key) || [];
  const i = arr.findIndex(x => x.id === g.id);
  if (i < 0) return;
  arr.splice(i, 1);
  storeSet(key, arr);
}

// Click-to-edit a task's name. The row may show a shortened title (a name whose
// list became steps), so editing always starts from the full stored name.
function makeInlineEdit(el, g, key, reload, shown) {
  let original = '';
  el.addEventListener('click', () => {
    if (el.contentEditable === 'true') return;
    original = g.text;
    el.textContent = g.text;
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
    if (e.key === 'Escape') { el.contentEditable = 'false'; el.textContent = shown || original; }
  });
  function commit() {
    if (el.contentEditable !== 'true') return;
    const val = el.textContent.trim();
    el.contentEditable = 'false';
    if (val && val !== original) {
      const arr = storeGet(key) || [];
      const i = arr.findIndex(x => x.id === g.id);
      if (i >= 0) {
        const steps = _stepsAfterRename(arr[i], val);
        arr[i] = Object.assign({}, arr[i], { text: val });
        if (steps && steps.length) arr[i].steps = steps; else delete arr[i].steps;
        storeSet(key, arr);
        reload();
      }
    } else {
      el.textContent = shown || original;
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
    row.classList.add('dragging');
    _draggedTaskInfo = row.dataset.taskId ? { id: row.dataset.taskId, fromKey: row.dataset.taskKey } : null;
    if (_draggedTaskInfo) {
      // 'text/plain' rather than a custom MIME type — Safari (desktop and
      // iOS) is known to silently drop custom dataTransfer types, which
      // would make a cross-day drop read back nothing on drop.
      e.dataTransfer.setData('text/plain', JSON.stringify(_draggedTaskInfo));
    }
  });
  listEl.addEventListener('dragend', e => {
    const row = e.target.closest(sel);
    if (row) row.classList.remove('dragging');
    clearOver();
    dragFromEl = null;
    _draggedTaskInfo = null;
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

// ── Today list: grouped sections ──
// The Custom / Priority / Area switch groups today's open tasks into sections
// instead of re-sorting one flat list:
//   custom   → Focus (starred, max 3) then To do — stored order, draggable
//   priority → High / Medium / Low
//   area     → one section per area (Areas tab order) with its total estimate,
//              then No area
// Done tasks collapse into a Done section at the bottom in every mode, next to
// the Someday count (both built in js/todoPlan.js).
const _PRI_COLORS = { High: '#E24B4A', Medium: '#EF9F27', Low: '#52C97A' };

function _todayGroups(open, mode) {
  const estSum = list => list.reduce((n, g) => n + (g.est || 0), 0);
  const withEst = (n, list) => estSum(list) ? `${n} · ${_fmtEst(estSum(list))}` : String(n);
  if (mode === 'priority') {
    return ['High', 'Medium', 'Low'].map(p => {
      const items = open.filter(g => (g.priority || 'Medium') === p);
      return { title: p, meta: String(items.length), color: _PRI_COLORS[p], items };
    });
  }
  if (mode === 'area') {
    const areas = getAreas();
    const groups = areas.map(a => {
      const items = open.filter(g => g.area === a.name);
      return { title: a.name, meta: withEst(items.length, items), color: a.color, items };
    });
    const known = new Set(areas.map(a => a.name));
    const none = open.filter(g => !g.area || !known.has(g.area));
    groups.push({ title: 'No area', meta: withEst(none.length, none), color: '#4C4B47', items: none });
    return groups;
  }
  const focus = open.filter(g => g.focus);
  const rest  = open.filter(g => !g.focus);
  return [
    { title: 'Focus', meta: `${focus.length} of ${FOCUS_MAX}`, items: focus, keepEmpty: open.length > 0,
      hint: 'Star ☆ up to 3 tasks you most need to finish today.' },
    { title: 'To do', meta: String(rest.length), items: rest },
  ];
}

function _buildTaskGroup(group, key, canDrag) {
  const sec = document.createElement('section');
  sec.className = 'task-group';
  const head = document.createElement('div');
  head.className = 'task-group-head';
  if (group.color) {
    const dot = document.createElement('span');
    dot.className = 'task-group-dot';
    dot.style.background = group.color;
    head.appendChild(dot);
  }
  const h = document.createElement('h3');
  h.textContent = group.title;
  const meta = document.createElement('span');
  meta.className = 'task-group-meta';
  meta.textContent = group.meta;
  const rule = document.createElement('span');
  rule.className = 'task-group-rule';
  head.append(h, meta, rule);
  sec.appendChild(head);

  if (!group.items.length && group.hint) {
    const hint = document.createElement('div');
    hint.className = 'task-group-hint';
    hint.textContent = group.hint;
    sec.appendChild(hint);
    return sec;
  }
  const ul = document.createElement('ul');
  ul.className = 'task-list';
  group.items.forEach((g, i) => ul.appendChild(buildTaskRow(g, i, group.items, key, false, canDrag)));
  if (canDrag) wireDragReorder(ul, 'task-row', (fromEl, toEl) => reorderTaskByDrag(key, fromEl, toEl));
  sec.appendChild(ul);
  return sec;
}

function loadToday() {
  const key   = todayKey();
  const tasks = storeGet(key) || [];
  const mode  = getTaskSort();
  const wrap  = document.getElementById('taskList');
  const emptyEl = document.getElementById('emptyState');
  wrap.innerHTML = '';
  emptyEl.style.display = tasks.length ? 'none' : 'block';

  // Within a section, custom order is the stored order; sortTasksForDisplay
  // already handles priority/area ordering for the other modes.
  const open = sortTasksForDisplay(tasks.filter(g => !g.done), mode);
  const done = tasks.filter(g => g.done);
  const canDrag = mode === 'custom';
  if (mode === 'custom') {                       // js/todoPlan.js
    const nudge = buildBatchNudge();
    if (nudge) wrap.appendChild(nudge);
  }
  _todayGroups(open, mode)
    .filter(gr => gr.items.length || gr.keepEmpty)
    .forEach(gr => wrap.appendChild(_buildTaskGroup(gr, key, canDrag)));

  if (tasks.length || getSomeday().length) wrap.appendChild(buildTodayFooter(done, key));   // Done + Someday (js/todoPlan.js)

  paintTaskSortBar(document.getElementById('todaySortBar'), tasks.length, 'Group');
  paintTriageLink(document.getElementById('todaySortBar'));
  renderTodayHeader();

  const card = document.getElementById('todayCard');
  if (card && !card._crossDropWired) {
    card._crossDropWired = true;
    wireCrossDayDrop(card, () => getActiveDateString());
  }
}

// The "Upcoming" card: every future day that has tasks, grouped by date,
// soonest first. Rows are read-only (checkbox locked until the day starts)
// but priority / area / text / delete stay editable.
function loadUpcoming() {
  const wrap    = document.getElementById('upcomingList');
  const emptyEl = document.getElementById('tomorrowEmptyState');
  if (!wrap) return;
  wrap.innerHTML = '';

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
    ul.dataset.date = date;
    sortTasksForDisplay(tasks, mode).forEach((g, i) =>
      ul.appendChild(buildTaskRow(g, i, tasks, key, true, canDrag)));
    if (canDrag) wireDragReorder(ul, 'task-row', (fromEl, toEl) => reorderTaskByDrag(key, fromEl, toEl));
    wrap.appendChild(ul);
  });

  const card = document.getElementById('tomorrowCard');
  if (card && !card._crossDropWired) {
    card._crossDropWired = true;
    wireCrossDayDrop(card, e => {
      const dayEl = e.target.closest('.task-list[data-date]');
      return dayEl ? dayEl.dataset.date : getTomorrowDateString();
    });
  }
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

// ── Sunday Reset — weekly recurring to-dos ─────────────────────────────────
// A fixed Sunday-only checklist. Entries are managed in a slide-in view and
// auto-injected into Sunday's To Do list, rolling over normally if unfinished.
// Persisted as two `settings` keys (rehydrated generically in loadFromSupabase):
//   sunday_reset_v1         – [{ id, text, area }] templates
//   sunday_reset_removed_v1 – { "<Sunday YYYY-MM-DD>": [entry ids you deleted
//                              off that Sunday's list] }
//
// The removal map is the ONLY thing that suppresses an injection; whether an
// entry is already on the list is read from the list itself. The old
// sunday_reset_log_v1 recorded "injected" ids up front instead, which made a
// lost write permanent: if the tasks write failed or was clobbered, the log
// still said "done" and the entry never came back. (master.sql drops that key.)

function getSundayReset()      { return MEM['sunday_reset_v1'] || []; }
// What Sunday does with last week's unfinished copy: 'replace' (default) swaps
// in a fresh task; 'keep' leaves the old one, overdue count and all.
function getSundayResetMode()  { return MEM['sunday_reset_mode_v1'] === 'keep' ? 'keep' : 'replace'; }
function setSundayResetMode(m) { MEM['sunday_reset_mode_v1'] = m; _syncSetting('sunday_reset_mode_v1', m); }
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

function _srRemovedMap()      { return MEM['sunday_reset_removed_v1'] || {}; }
function _srRemovedToday(ds)  { return _srRemovedMap()[ds] || []; }

// Remember that an entry was taken off this Sunday's list, so the next refresh
// doesn't put it straight back.
function _srMarkRemoved(ds, id) {
  if (!id || !_isSunday(ds)) return;
  const map = _srRemovedMap();
  const day = map[ds] || [];
  if (day.includes(id)) return;
  map[ds] = day.concat(id);
  Object.keys(map).sort().slice(0, -8).forEach(k => delete map[k]); // keep ~8 Sundays
  MEM['sunday_reset_removed_v1'] = map;
  _syncSetting('sunday_reset_removed_v1', map);
}

// Called when a task is deleted off the active day: if it came from a Sunday
// Reset entry and today is a Sunday, that's a removal, not a plain delete.
function noteSundayResetTaskRemoved(g) {
  const ds = getActiveDateString();
  if (!_isSunday(ds)) return;
  const entry = getSundayReset().find(it => it.text === g.text);
  if (entry) _srMarkRemoved(ds, entry.id);
}

// Inject Sunday Reset entries that aren't on the active day's list yet, but only
// when the active day is a Sunday. Idempotent because it re-derives what's
// missing from the list every time: an entry is injected unless a task with its
// text is already there (open, done, or carried over from a previous Sunday) or
// you removed it from this Sunday's list. So an entry added mid-Sunday still
// lands in today's list, a removed one stays gone, and a load that failed to
// save fixes itself on the next one.
function applySundayReset() {
  const ds = getActiveDateString();
  if (!_isSunday(ds)) return;
  const items = getSundayReset();
  if (!items.length) return;

  const removed = _srRemovedToday(ds);
  const tasks   = storeGet('tasks:' + ds) || [];
  const replace = getSundayResetMode() === 'replace';

  let added = false;
  items.forEach(it => {
    if (removed.includes(it.id)) return;
    const i = tasks.findIndex(g => g.text === it.text);
    let keepFocus = false;
    if (i >= 0) {
      // Last week's copy is still open and was carried onto today. In
      // "replace" mode it's retired (dismissed, so rollover stops carrying
      // it) and a fresh one takes its place — a weekly routine shouldn't show
      // up as a week overdue. Its history rows stay as they were. The fresh
      // copy first appears today, so later loads leave it alone.
      const old = tasks[i];
      if (!replace || old.done || !taskAppearsEarlier(old)) return;
      dismissTask(old.id);
      tasks.splice(i, 1);
      keepFocus = !!old.focus;             // a starred routine stays starred
    }
    const fresh = makeTask({ text: it.text, area: it.area || null });
    if (keepFocus) fresh.focus = true;
    tasks.push(fresh);
    added = true;
  });

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
// today's To Do list (matched by text, the same way injection dedups). Nothing
// to record in the removal map — the entry itself is about to be gone.
function _removeInjectedTask(entry) {
  const ds = getActiveDateString();
  if (!_isSunday(ds)) return;

  const tasks = storeGet('tasks:' + ds) || [];
  const next  = tasks.filter(g => g.text !== entry.text);
  if (next.length !== tasks.length) storeSet('tasks:' + ds, next);
}

// Carry an edit to an entry through to the task it already injected into today's
// list (matched by its pre-edit text). Without this, renaming an entry on a
// Sunday leaves the old task sitting there and applySundayReset() adds the new
// text alongside it as a second task; re-tagging an entry's area leaves the
// already-injected task on the old one.
// Applies on any day, not just Sunday: a carried copy sitting on today's list
// would otherwise keep the old wording and lose its Sunday Reset badge.
function _updateInjectedTask(oldText, fields) {
  const ds = getActiveDateString();
  const tasks = storeGet('tasks:' + ds) || [];
  const i = tasks.findIndex(g => g.text === oldText && !g.done);
  if (i < 0) return;
  tasks[i] = Object.assign({}, tasks[i], fields);
  if (fields.text) {
    const steps = _stepsAfterRename(Object.assign({}, tasks[i], { text: oldText }), fields.text);
    if (steps && steps.length) tasks[i].steps = steps; else delete tasks[i].steps;
  }
  storeSet('tasks:' + ds, tasks);
}

// Rename an entry (and the copy on today's list) in one place.
function _srRename(item, text) {
  const oldText = item.text;
  if (!text || text === oldText) return;
  item.text = text;
  saveSundayReset(getSundayReset());
  _updateInjectedTask(oldText, { text });
  _afterSundayResetChange();
}

// An entry's steps are the list in its name — "Hair (Nose, Ears)" — so step
// edits rewrite the name, which keeps Sunday Reset's match-by-text working.
function _srWithSteps(item, steps) {
  const parsed = _parseStepList(item.text);
  const title = parsed ? parsed.title : item.text;
  return steps.length ? `${title} (${steps.join(', ')})` : title;
}

function renderSundayResetPage() {
  const body = document.getElementById('sundayResetBody');
  if (!body) return;
  const items = getSundayReset();
  const onToday = new Set((storeGet(todayKey()) || []).map(g => g.text));
  const next = _nextSundayLabel();

  body.innerHTML = `
    <p class="sunday-reset-intro">
      Added to your To&nbsp;Do list every Sunday. Next reset: <strong>${next}</strong>.
    </p>
    <ul class="sr-list" id="sundayResetList"></ul>
    <div id="sundayResetEmpty" class="empty-state"${items.length ? ' style="display:none;"' : ''}>No weekly tasks yet — add one below.</div>
    <form class="sr-add" id="sundayResetForm" autocomplete="off">
      <input type="text" class="task-input" id="sundayResetInput" placeholder="Add a weekly task — steps after a colon: Laundry: clothes, sheets" aria-label="New weekly task">
      <button class="btn-add" type="submit">Add</button>
    </form>
    <div class="sr-setting">
      <span>If last week’s copy isn’t finished on Sunday</span>
      <div class="at-seg" id="sundayResetMode">
        <button type="button" data-v="replace">Replace it</button>
        <button type="button" data-v="keep">Keep it</button>
      </div>
    </div>`;

  const list = document.getElementById('sundayResetList');
  items.forEach(it => {
    const parsed = _parseStepList(it.text);
    const title = parsed ? parsed.title : it.text;
    const steps = parsed ? parsed.items : [];

    const li = document.createElement('li');
    li.className = 'sr-item';
    const main = document.createElement('div');
    main.className = 'sr-item-main';

    const name = document.createElement('input');
    name.className = 'sr-name';
    name.value = title;
    name.setAttribute('aria-label', 'Task name');
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (!v) { name.value = title; return; }
      _srRename(it, steps.length ? `${v} (${steps.join(', ')})` : v);
    });
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
    main.appendChild(name);

    const stepsEl = document.createElement('div');
    stepsEl.className = 'sr-steps';
    steps.forEach((st, k) => {
      const chip = document.createElement('span');
      chip.className = 'sr-step';
      chip.textContent = st;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', 'Remove step ' + st);
      x.addEventListener('click', () => _srRename(it, _srWithSteps(it, steps.filter((_, j) => j !== k))));
      chip.appendChild(x);
      stepsEl.appendChild(chip);
    });
    const add = document.createElement('input');
    add.className = 'sr-addstep';
    add.placeholder = '+ step';
    add.setAttribute('aria-label', 'Add step');
    add.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = add.value.trim().replace(/[(),]/g, ' ').trim();
      if (!v) return;
      _srRename(it, _srWithSteps(it, steps.concat(v)));
      const again = document.querySelector(`#sundayResetList .sr-item[data-id="${it.id}"] .sr-addstep`);
      if (again) again.focus();
    });
    stepsEl.appendChild(add);
    main.appendChild(stepsEl);
    li.dataset.id = it.id;
    li.appendChild(main);

    const side = document.createElement('div');
    side.className = 'sr-item-side';
    const when = document.createElement('span');
    when.className = 'sr-when' + (onToday.has(it.text) ? '' : ' is-next');
    when.textContent = onToday.has(it.text) ? 'on today’s list' : 'starts ' + next;
    side.appendChild(when);
    side.appendChild(buildAreaPill(it.area || null, newArea => {
      it.area = newArea;
      saveSundayReset(getSundayReset());
      _updateInjectedTask(it.text, { area: newArea });
      _afterSundayResetChange();
    }));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-delete';
    del.textContent = '×';
    del.title = 'Remove from Sunday Reset';
    del.setAttribute('aria-label', 'Remove ' + title + ' from Sunday Reset');
    del.addEventListener('click', () => {
      _removeInjectedTask(it);
      saveSundayReset(getSundayReset().filter(x => x.id !== it.id));
      _afterSundayResetChange();
    });
    side.appendChild(del);
    li.appendChild(side);
    list.appendChild(li);
  });

  const mode = getSundayResetMode();
  document.querySelectorAll('#sundayResetMode button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === mode);
    b.addEventListener('click', () => { setSundayResetMode(b.dataset.v); renderSundayResetPage(); });
  });

  document.getElementById('sundayResetForm').addEventListener('submit', e => {
    e.preventDefault();
    const inp = document.getElementById('sundayResetInput');
    let text = inp.value.trim();
    if (!text) return;
    // "Laundry: clothes, sheets" is stored as "Laundry (clothes, sheets)".
    const p = _parseStepList(text);
    if (p) text = `${p.title} (${p.items.join(', ')})`;
    saveSundayReset(getSundayReset().concat({ id: _srId(), text, area: null }));
    _afterSundayResetChange();
    document.getElementById('sundayResetInput').focus();
  });
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
      const li = document.createElement('li');
      li.className = 'task-row ' + _priClass(g.priority) + (g.done ? ' is-done' : '');

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

// ── Add task modal ─────────────────────────────────────────────────────────
// "+ Add task" (or N on the To Do tab) opens a form with every field in one
// place. Shortcuts typed into the name fill the fields and are stripped from
// the saved name:  !h !m !l  priority · #area · ~30m / ~1h estimate ·
// tmr / today  day · *  Focus.
const _AT = { day: 'today', due: '', pri: 'Medium', area: null, est: 0 };
let _atReturnFocus = null;

function _atEl(id) { return document.getElementById(id); }

function _addDays(ds, n) {
  const [y, m, d] = ds.split('-').map(Number);
  return _localDateStr(new Date(y, m - 1, d + n));
}
// The coming Friday after the active day (a week out when today is Friday).
function _nextFriday() {
  const ds = getActiveDateString();
  const [y, m, d] = ds.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return _addDays(ds, ((5 - dow + 7) % 7) || 7);
}

function _atSeg(field, value) {
  _AT[field] = value;
  document.querySelectorAll(`#addTaskForm .at-seg[data-f="${field}"] button`).forEach(b =>
    b.classList.toggle('on', b.dataset.v === String(value)));
  if (field === 'day') { _atEl('atDate').hidden = value !== 'pick'; _atFocusState(); }
  if (field === 'due') _atEl('atDue').hidden = value !== 'pick';
}

function _atPaintAreas() {
  const wrap = _atEl('atAreas');
  const areas = getAreas();
  wrap.innerHTML = '';
  if (!areas.length) {
    wrap.innerHTML = '<span class="at-none">No areas yet — add them in the Areas tab.</span>';
    return;
  }
  const pill = (name, color) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'task-area-pill' + (name ? '' : ' is-empty') + (_AT.area === name ? ' is-picked' : '');
    b.textContent = name || 'No area';
    if (color) { b.style.background = color + 'BF'; b.style.color = '#fff'; }
    b.addEventListener('click', () => { _AT.area = name; _atPaintAreas(); });
    wrap.appendChild(b);
  };
  pill(null, null);
  areas.forEach(a => pill(a.name, a.color));
}

function _atFocusState() {
  const box = _atEl('atFocus');
  const today = storeGet(todayKey()) || [];
  const used = today.filter(g => g.focus && !g.done).length;
  const label = _atEl('atFocusLabel');
  if (_AT.day !== 'today') {
    box.checked = false; box.disabled = true;
    label.textContent = 'Focus is for today’s tasks';
  } else if (used >= FOCUS_MAX) {
    box.checked = false; box.disabled = true;
    label.textContent = `Focus is full (${used} of ${FOCUS_MAX})`;
  } else {
    box.disabled = false;
    label.textContent = `Add to Focus (${used} of ${FOCUS_MAX} used)`;
  }
  box.closest('.at-check').classList.toggle('is-disabled', box.disabled);
}

const _AT_TOKEN = /^(![hml]|#\S+|~\d+(?:m|h)|\*|tmr|tomorrow|today)$/i;

function _atCleanName() {
  return _atEl('atName').value.split(/\s+/).filter(w => w && !_AT_TOKEN.test(w)).join(' ').trim();
}

// Read shortcut tokens out of the name and apply them to the form.
function _atParse() {
  const chips = [];
  _atEl('atName').value.split(/\s+/).forEach(w => {
    let m;
    if ((m = w.match(/^!([hml])$/i))) {
      const p = { h: 'High', m: 'Medium', l: 'Low' }[m[1].toLowerCase()];
      _atSeg('pri', p); chips.push(['pri', p + ' priority']);
    } else if ((m = w.match(/^#(\S+)$/))) {
      const a = getAreas().find(x => x.name.toLowerCase().startsWith(m[1].toLowerCase()));
      if (a) { _AT.area = a.name; _atPaintAreas(); chips.push(['area', a.name]); }
      else chips.push(['miss', `no area “${m[1]}”`]);
    } else if ((m = w.match(/^~(\d+)(m|h)$/i))) {
      const min = +m[1] * (m[2].toLowerCase() === 'h' ? 60 : 1);
      _atSeg('est', min); _AT.est = min; chips.push(['est', 'est ' + _fmtEst(min)]);
    } else if (/^(tmr|tomorrow)$/i.test(w)) {
      _atSeg('day', 'tmr'); chips.push(['day', 'tomorrow']);
    } else if (/^today$/i.test(w)) {
      _atSeg('day', 'today'); chips.push(['day', 'today']);
    } else if (w === '*') {
      if (!_atEl('atFocus').disabled) { _atEl('atFocus').checked = true; chips.push(['focus', '★ focus']); }
    }
  });
  const box = _atEl('atTokens');
  box.innerHTML = '';
  chips.forEach(([k, label]) => {
    const c = document.createElement('span');
    c.className = 'at-token at-token-' + k;
    c.textContent = label;
    box.appendChild(c);
  });
  _atEl('atSubmit').disabled = !_atCleanName();
}

function openAddTask(startDay) {
  _atReturnFocus = document.activeElement;
  const form = _atEl('addTaskForm');
  form.reset();
  Object.assign(_AT, { day: startDay === 'tmr' ? 'tmr' : 'today', due: '', pri: 'Medium', area: null, est: 0 });
  ['day', 'due', 'pri', 'est'].forEach(f => _atSeg(f, _AT[f]));
  const tmr = getTomorrowDateString();
  _atEl('atDate').min = tmr;
  _atEl('atDate').value = tmr;
  _atEl('atDue').min = getActiveDateString();
  _atEl('atDue').value = _addDays(getActiveDateString(), 7);
  const fri = _nextFriday();
  _atEl('atDueFri').title = formatDate(fri);
  _atEl('atTokens').innerHTML = '';
  _atEl('atStatus').textContent = '';
  _atEl('atSubmit').disabled = true;
  _atPaintAreas();
  _atFocusState();
  _atEl('addTaskModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  _atEl('atName').focus();
}

function closeAddTask() {
  _atEl('addTaskModal').classList.remove('open');
  document.body.style.overflow = '';
  if (_atReturnFocus && _atReturnFocus.focus) _atReturnFocus.focus();
}

function _atSubmit() {
  const text = _atCleanName();
  if (!text) return;
  let date;
  if (_AT.day === 'today') date = getActiveDateString();
  else if (_AT.day === 'tmr') date = getTomorrowDateString();
  else {
    date = _atEl('atDate').value;
    if (!date || date < getTomorrowDateString()) { _atEl('atStatus').textContent = 'Pick a day from tomorrow on.'; return; }
  }
  let due = '';
  if (_AT.due === 'fri') due = _nextFriday();
  else if (_AT.due === 'week') due = _addDays(getActiveDateString(), 7);
  else if (_AT.due === 'pick') due = _atEl('atDue').value;

  const fields = { text, priority: _AT.pri, area: _AT.area };
  if (_AT.est > 0) fields.est = _AT.est;
  if (due) fields.due = due;
  const steps = _atEl('atSteps').value.split(',').map(x => x.trim()).filter(Boolean);
  if (steps.length) fields.steps = steps.map(t => ({ text: t, done: false }));
  if (_AT.day === 'today' && _atEl('atFocus').checked) fields.focus = true;

  const key = 'tasks:' + date;
  const task = makeTask(fields);
  const arr = (storeGet(key) || []).slice();
  arr.push(task);
  storeSet(key, arr);
  closeAddTask();

  if (date === getActiveDateString()) {
    loadToday();
    const row = document.querySelector(`#taskList .task-row[data-task-id="${task.id}"]`);
    if (row) { row.classList.add('is-new'); row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    showToast(task.focus ? 'Added to Focus' : 'Added to today');
  } else {
    loadUpcoming();
    showToast(`Added to Upcoming · ${date === getTomorrowDateString() ? 'Tomorrow' : formatDate(date)}` +
      (due ? ' · ' + _dueLabel(due)[0] : ''));
  }
}

document.getElementById('addTaskBtn').addEventListener('click', () => openAddTask());
document.getElementById('addLaterBtn').addEventListener('click', () => openAddTask('tmr'));
document.getElementById('atName').addEventListener('input', _atParse);
document.getElementById('addTaskForm').addEventListener('submit', e => { e.preventDefault(); _atSubmit(); });
document.getElementById('addTaskForm').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-close')) { closeAddTask(); return; }
  const seg = b.closest('.at-seg');
  if (seg) _atSeg(seg.dataset.f, seg.dataset.f === 'est' ? +b.dataset.v : b.dataset.v);
});
document.getElementById('atPolish').addEventListener('click', async () => {
  const raw = _atCleanName();
  if (!raw) return;
  const status = _atEl('atStatus');
  if (!ANTHROPIC_API_KEY) { status.textContent = 'Polish needs an Anthropic API key.'; return; }
  const btn = _atEl('atPolish');
  btn.disabled = true; btn.textContent = '✨ Polishing…';
  const polished = await polishTask(raw, status);
  btn.disabled = false; btn.textContent = '✨ Polish';
  if (!polished) { status.textContent = 'Polish failed — kept as typed.'; return; }
  // Keep any shortcut tokens the name still carries.
  const tokens = _atEl('atName').value.split(/\s+/).filter(w => _AT_TOKEN.test(w));
  _atEl('atName').value = [polished].concat(tokens).join(' ');
  _atParse();
});
document.getElementById('addTaskModal').addEventListener('click', e => {
  if (e.target.id === 'addTaskModal') closeAddTask(); // backdrop click only
});
document.addEventListener('keydown', e => {
  const modal = document.getElementById('addTaskModal');
  if (e.key === 'Escape' && modal.classList.contains('open')) { closeAddTask(); return; }
  // N opens it — on the To Do tab, when nothing else has the keyboard.
  if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey &&
      document.getElementById('tab-tasks').classList.contains('active') &&
      !document.querySelector('.sr-modal.open') &&
      !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) &&
      !document.activeElement.isContentEditable) {
    e.preventDefault();
    openAddTask();
  }
});
