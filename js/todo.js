// To Do tab: rollover, streak, goal rows, drag-reorder, inline edit,
// quick-add + polish. Loaded before main.js.

// Stable client-side goal id (mirrors the habits `h_…` convention).
function _goalId() {
  return 'g_' + ((crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

// A goal object created right now, with a stable id + ISO creation stamp.
function makeGoal(fields) {
  return Object.assign({
    id: _goalId(),
    text: '',
    done: false,
    priority: 'Medium',
    area: null,
    createdAt: new Date().toISOString(),
  }, fields);
}

// True when `list` already contains `g` — by stable id, falling back to an
// exact text match against an unfinished entry (covers pre-id rows).
function _goalInList(g, list) {
  return list.some(x =>
    (g.id && x.id && x.id === g.id) ||
    (!x.done && x.text === g.text));
}

// ── Upcoming (future-dated) goals ──
// The planner card creates goals for tomorrow or later only. `plannerDate` is
// the target date for new goals; it lazily defaults to tomorrow and is never
// allowed to point at today or the past.
let plannerDate = null;
function plannerTargetDate() {
  const min = getTomorrowDateString();
  if (!plannerDate || plannerDate < min) plannerDate = min;
  return plannerDate;
}

// Dates strictly after the active day that currently hold goals, ascending.
function upcomingDateKeys() {
  const active = getActiveDateString();
  return storeListKeys('goals:')
    .map(k => k.slice(6))
    .filter(d => d > active)
    .sort();
}

// Every goal list a user can currently edit: today + all future days.
// Used by the Areas tab so area rename/delete/tagging reaches future goals.
function goalScopeKeys() {
  return [todayKey()].concat(upcomingDateKeys().map(d => 'goals:' + d));
}

// ── Goal sort mode ── (shared by the Today and Upcoming lists)
// 'custom' = the stored array order, reorderable by drag. 'priority' and 'area'
// are display-only views; the stored order is never mutated by them.
const _GOAL_SORT_MODES = [['custom', 'Custom'], ['priority', 'Priority'], ['area', 'Area']];
const _GOAL_PRI_RANK = { High: 0, Medium: 1, Low: 2 };

function getGoalSort()     { return MEM['goal_sort_v1'] || 'custom'; }
function setGoalSort(mode) {
  MEM['goal_sort_v1'] = mode;
  _syncSetting('goal_sort_v1', mode);
  loadToday();
  loadUpcoming();
}

// Returns a new array ordered for display. Never mutates the input — the stored
// order stays canonical (it's the 'custom' order and the tiebreak for the rest).
function sortGoalsForDisplay(goals, mode) {
  const pos = new Map(goals.map((g, i) => [g, i]));
  const byCustom = (a, b) => pos.get(a) - pos.get(b);
  const arr = [...goals];
  if (mode === 'priority') {
    arr.sort((a, b) =>
      (_GOAL_PRI_RANK[a.priority || 'Medium'] - _GOAL_PRI_RANK[b.priority || 'Medium']) || byCustom(a, b));
  } else if (mode === 'area') {
    arr.sort((a, b) => {
      const aa = a.area || '', ba = b.area || '';
      if (!!aa !== !!ba) return aa ? -1 : 1;            // no-area group last
      return aa.localeCompare(ba, undefined, { sensitivity: 'base' }) || byCustom(a, b);
    });
  }
  return arr; // 'custom' / unknown → stored order
}

function paintGoalSortBar(el, count) {
  if (!el) return;
  el.hidden = !(count > 1);           // nothing to sort with 0–1 goals
  if (el.hidden) { el.innerHTML = ''; return; }
  const mode = getGoalSort();
  el.innerHTML = `<span class="goal-sort-label">Sort</span>` +
    _GOAL_SORT_MODES.map(([v, l]) =>
      `<button class="goal-sort-btn${v === mode ? ' active' : ''}" data-sort="${v}">${l}</button>`).join('');
}

// One delegated listener covers both cards' sort bars.
document.addEventListener('click', e => {
  const btn = e.target.closest('.goal-sort-btn');
  if (btn && btn.dataset.sort !== getGoalSort()) setGoalSort(btn.dataset.sort);
});

// Move a goal within its stored day array, matched by stable id (so it works
// regardless of the current display sort). Bails unless sort is 'custom'.
function reorderGoalByDrag(key, fromEl, toEl) {
  if (getGoalSort() !== 'custom') return;
  const arr = storeGet(key) || [];
  const from = arr.findIndex(g => g.id === fromEl.dataset.goalId);
  const to   = arr.findIndex(g => g.id === toEl.dataset.goalId);
  if (from < 0 || to < 0 || from === to) return;
  const [item] = arr.splice(from, 1);
  arr.splice(to, 0, item);
  storeSet(key, arr);
  if (key === todayKey()) loadToday(); else loadUpcoming();
}

// ── Rollover ──
// Carry every unfinished goal from days between the last processed date and
// today into today's list, preserving the whole object (id, priority, area,
// createdAt). Past days are left intact as history; a `goal_rollover_v1`
// marker keeps this idempotent so retained history isn't re-carried on reload.
function rollover() {
  const activeDate = getActiveDateString();
  const marker = storeGet('goal_rollover_v1') || { lastProcessedDate: null };
  const from = marker.lastProcessedDate;

  const keys = storeListKeys('goals:')
    .filter(k => {
      const d = k.slice(6);
      return d < activeDate && (!from || d > from);
    })
    .sort();
  if (keys.length === 0) return;

  const todayGoals = storeGet(todayKey()) || [];
  let added = false;

  keys.forEach(k => {
    (storeGet(k) || []).filter(g => !g.done).forEach(g => {
      if (_goalInList(g, todayGoals)) return;
      todayGoals.push(Object.assign({}, g, { done: false }));
      delete todayGoals[todayGoals.length - 1].doneAt;
      added = true;
    });
  });

  if (added) storeSet(todayKey(), todayGoals);

  const newest = keys[keys.length - 1].slice(6);
  if (newest !== from) {
    marker.lastProcessedDate = newest;
    storeSet('goal_rollover_v1', marker);
  }
}

// ── Streak check ──
function checkStreak() {
  const activeDate = getActiveDateString();
  let streak = storeGet('goal_streak_v1') || { count: 0, lastProcessedDate: null };
  const keys = storeListKeys('goals:')
    .filter(k => k.slice(6) < activeDate)
    .sort();
  let startFrom = streak.lastProcessedDate;
  for (const k of keys) {
    const date = k.slice(6);
    if (startFrom && date <= startFrom) continue;
    const goals = storeGet(k) || [];
    if (goals.length === 0) continue;
    if (goals.every(g => g.done)) {
      streak.count++;
    } else {
      streak.count = 0;
    }
    streak.lastProcessedDate = date;
  }
  storeSet('goal_streak_v1', streak);
  return streak;
}


// ── Render helpers ──
function renderTodayHeader() {
  const goals = storeGet(todayKey()) || [];
  const total = goals.length;
  const done  = goals.filter(g => g.done).length;

  document.getElementById('todayLabel').textContent = `Today — ${formatDate(getActiveDateString())}`;
  document.getElementById('gmProgressNum').textContent = done;
  document.getElementById('gmProgressTotal').textContent = `/ ${total}`;

  const labelEl = document.getElementById('gmProgressLabel');
  if (total === 0) labelEl.textContent = 'no goals yet';
  else if (done === total) labelEl.textContent = 'all done — solid day';
  else labelEl.textContent = 'complete';

  const bar = document.getElementById('gmBar');
  bar.innerHTML = '';
  goals.forEach(g => {
    const seg = document.createElement('div');
    seg.className = 'gm-bar-seg' + (g.done ? ' gm-bar-seg-done' : '');
    bar.appendChild(seg);
  });

  const card = document.getElementById('todayCard');
  if (total > 0 && done === total) card.classList.add('gm-all-done');
  else card.classList.remove('gm-all-done');

  const pushBtn = document.getElementById('gmPushBtn');
  pushBtn.style.display = (goals.some(g => !g.done) && total > 0) ? 'block' : 'none';
}

function renderStreak() {
  const streak = storeGet('goal_streak_v1') || { count: 0 };
  document.getElementById('gmStreakNum').textContent = streak.count;
  const el = document.getElementById('gmStreak');
  if (streak.count > 0) el.classList.add('gm-streak-active');
  else el.classList.remove('gm-streak-active');
}

function renderUpcomingCount() {
  const total = upcomingDateKeys()
    .reduce((n, d) => n + (storeGet('goals:' + d) || []).length, 0);
  document.getElementById('gmTomorrowCount').textContent = `${total} planned`;
}


// ── Build goal row ──
// Handlers resolve the goal by stable id against the live stored array, so they
// stay correct no matter how the visible list is sorted. `readOnly` locks the
// checkbox (future days); `draggable` enables drag-reorder (custom sort only).
function buildGoalRow(g, idx, goals, key, readOnly, draggable) {
  const priority = g.priority || 'Medium';
  const priClass = { High: 'goal-priority-high', Medium: 'goal-priority-med', Low: 'goal-priority-low' }[priority] || 'goal-priority-med';
  const li = document.createElement('li');
  li.className = 'goal-row ' + priClass + (g.done ? ' is-done' : '');
  li.dataset.idx = idx;
  li.dataset.goalId = g.id || '';
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
  priBtn.className = 'goal-priority-btn';
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
  drag.className = 'goal-drag-handle';
  drag.textContent = '⋮⋮';
  drag.setAttribute('aria-hidden', 'true');
  li.appendChild(drag);

  // Checkbox
  const cbWrap = document.createElement('label');
  cbWrap.className = 'goal-cb-wrap';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!g.done;
  if (readOnly) { cb.disabled = true; cb.title = 'Unlocks when this day starts (6 AM)'; }
  const cbBox = document.createElement('span');
  cbBox.className = 'goal-cb-box';
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

  // Text + its optional "sunday reset" tag share one flex wrapper, so the tag
  // sits right after the goal name instead of out by the area pill.
  const main = document.createElement('div');
  main.className = 'goal-main';

  const txt = document.createElement('span');
  txt.className = 'goal-text';
  txt.textContent = g.text;
  makeInlineEdit(txt, g, key, reload);
  main.appendChild(txt);

  if (isSundayResetGoal(g)) {
    const tag = document.createElement('span');
    tag.className = 'goal-source-tag';
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
  del.className = 'goal-delete';
  del.textContent = '×';
  del.title = 'Delete goal';
  del.addEventListener('click', () => {
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
// persist + re-render. Used by goals and habits.
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

function renderListInto(goals, listEl, emptyEl, key, readOnly) {
  listEl.innerHTML = '';
  const LIMIT = 5;
  let showAll = listEl._showAll || false;

  if (goals.length === 0) {
    emptyEl.style.display = 'block';
    listEl.style.display = 'none';
  } else {
    emptyEl.style.display = 'none';
    listEl.style.display = '';

    const canDrag = !readOnly && getGoalSort() === 'custom';
    const visible = (goals.length > LIMIT && !showAll) ? goals.slice(0, LIMIT) : goals;
    visible.forEach((g, i) => {
      listEl.appendChild(buildGoalRow(g, i, goals, key, readOnly, canDrag));
    });

    if (goals.length > LIMIT && !showAll) {
      const more = document.createElement('div');
      more.className = 'show-more-row';
      more.textContent = `Show ${goals.length - LIMIT} more ▾`;
      more.addEventListener('click', () => {
        listEl._showAll = true;
        renderListInto(goals, listEl, emptyEl, key, readOnly);
      });
      listEl.appendChild(more);
    } else if (goals.length > LIMIT && showAll) {
      const less = document.createElement('div');
      less.className = 'show-more-row';
      less.textContent = 'Show less ▴';
      less.addEventListener('click', () => {
        listEl._showAll = false;
        renderListInto(goals, listEl, emptyEl, key, readOnly);
      });
      listEl.appendChild(less);
    }
  }

  if (!readOnly && !listEl._dragWired) {
    listEl._dragWired = true;
    wireDragReorder(listEl, 'goal-row', (fromEl, toEl) =>
      reorderGoalByDrag(todayKey(), fromEl, toEl));
  }

  if (key === todayKey()) renderTodayHeader();
  else renderUpcomingCount();
}

function loadToday() {
  const goals = storeGet(todayKey()) || [];
  renderListInto(sortGoalsForDisplay(goals, getGoalSort()),
    document.getElementById('goalList'),
    document.getElementById('emptyState'),
    todayKey(), false);
  paintGoalSortBar(document.getElementById('todaySortBar'), goals.length);
}

// The "Upcoming" card: every future day that has goals, grouped by date,
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
  if (inp) inp.placeholder = `Add a goal for ${formatDate(target)}…`;

  document.getElementById('tomorrowLabel').textContent = 'Upcoming';

  const mode = getGoalSort();
  const canDrag = mode === 'custom';
  const days = upcomingDateKeys().filter(d => (storeGet('goals:' + d) || []).length > 0);
  const totalUpcoming = days.reduce((n, d) => n + storeGet('goals:' + d).length, 0);
  paintGoalSortBar(document.getElementById('upcomingSortBar'), totalUpcoming);
  renderUpcomingCount();
  emptyEl.style.display = days.length ? 'none' : 'block';

  days.forEach(date => {
    const key   = 'goals:' + date;
    const goals = storeGet(key) || [];
    const head = document.createElement('div');
    head.className = 'upcoming-day';
    head.innerHTML = `<span>${formatDate(date)}</span>` +
      `<span class="upcoming-day-count">${goals.length}</span>`;
    wrap.appendChild(head);

    const ul = document.createElement('ul');
    ul.className = 'goal-list';
    sortGoalsForDisplay(goals, mode).forEach((g, i) =>
      ul.appendChild(buildGoalRow(g, i, goals, key, true, canDrag)));
    if (canDrag) wireDragReorder(ul, 'goal-row', (fromEl, toEl) => reorderGoalByDrag(key, fromEl, toEl));
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
async function polishGoal(text, statusEl) {
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
          content: `Clean up and improve this single goal into a concise, actionable task. Return ONLY a one-element JSON array of strings with no extra text, no markdown fences. Goal: "${text}"`
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
  function addGoal(text) {
    if (!text) return;
    const goals = storeGet(getKey()) || [];
    goals.push(makeGoal({ text }));
    storeSet(getKey(), goals);
    inputEl.value = '';
    reload();
  }

  addBtn.addEventListener('click', () => addGoal(inputEl.value.trim()));
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') addGoal(inputEl.value.trim());
  });

  polishBtn.addEventListener('click', async () => {
    const raw = inputEl.value.trim();
    if (!raw) return;
    if (!ANTHROPIC_API_KEY) {
      addGoal(raw);
      showStatus(statusEl, 'Polish needs an Anthropic API key — added as-typed.', 'var(--text-tertiary)', 3500);
      return;
    }
    polishBtn.disabled = true;
    polishBtn.textContent = '✨ Polishing…';
    const polished = await polishGoal(raw, statusEl);
    polishBtn.disabled = false;
    polishBtn.textContent = '✨ Polish';
    if (polished) {
      addGoal(polished);
    } else {
      addGoal(raw);
      showStatus(statusEl, 'Polish failed — added as-typed.', 'var(--danger)', 3500);
    }
  });
}

// ── Push remaining ──
document.getElementById('gmPushBtn').addEventListener('click', () => {
  if (!confirm('Push all unchecked goals to tomorrow?')) return;
  const todayGoals    = storeGet(todayKey()) || [];
  const tomorrowGoals = storeGet(tomorrowKey()) || [];
  const unchecked = todayGoals.filter(g => !g.done);
  unchecked.forEach(g => {
    if (_goalInList(g, tomorrowGoals)) return;
    const carried = Object.assign({}, g, { done: false });
    delete carried.doneAt;
    tomorrowGoals.push(carried);
  });
  storeSet(tomorrowKey(), tomorrowGoals);
  const remaining = todayGoals.filter(g => g.done);
  storeSet(todayKey(), remaining);
  loadToday();
  loadUpcoming();
});

// ── Upcoming card: date picker for the target day of new goals ──
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

// True when a goal came from a Sunday Reset template — matched by text, the same
// identity applySundayReset() and _removeInjectedGoal() use. Drives the row tag.
function isSundayResetGoal(g) {
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

// Inject not-yet-added Sunday Reset entries into the active day's goals, but only
// when the active day is a Sunday. Idempotent per (Sunday date × entry id) via
// the log map, so deleting an injected goal doesn't resurrect it on the next
// refresh, while an entry added mid-Sunday still lands in today's list.
function applySundayReset() {
  const ds = getActiveDateString();
  if (!_isSunday(ds)) return;
  const items = getSundayReset();
  if (!items.length) return;

  const log   = MEM['sunday_reset_log_v1'] || {};
  const done  = log[ds] || [];
  const goals = storeGet('goals:' + ds) || [];
  const texts = new Set(goals.map(g => g.text));

  let added = false;
  items.forEach(it => {
    if (done.includes(it.id)) return;
    if (!texts.has(it.text)) {
      goals.push(makeGoal({ text: it.text, area: it.area || null }));
      texts.add(it.text);
      added = true;
    }
    done.push(it.id);
  });

  log[ds] = done;
  Object.keys(log).sort().slice(0, -8).forEach(k => delete log[k]); // keep ~8 Sundays
  MEM['sunday_reset_log_v1'] = log;
  _syncSetting('sunday_reset_log_v1', log);

  if (added) storeSet('goals:' + ds, goals); // persists + fires goals-changed
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

// When an entry is deleted on a Sunday, also pull the goal it injected out of
// today's To Do list (matched by text, the same way injection dedups) and drop
// its id from today's injection log so state stays consistent.
function _removeInjectedGoal(entry) {
  const ds = getActiveDateString();
  if (!_isSunday(ds)) return;

  const goals = storeGet('goals:' + ds) || [];
  const next  = goals.filter(g => g.text !== entry.text);
  if (next.length !== goals.length) storeSet('goals:' + ds, next);

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
    <div class="goal-input-wrap gm-input-wrap">
      <input type="text" class="goal-input" id="sundayResetInput" placeholder="Add a weekly task…">
      <button class="btn-add" id="sundayResetAdd">+ Add</button>
    </div>`;

  const list = document.getElementById('sundayResetList');
  items.forEach(it => {
    const li = document.createElement('li');
    li.className = 'goal-row sunday-reset-row';

    const txt = document.createElement('span');
    txt.className = 'goal-text';
    txt.textContent = it.text;
    _srInlineEdit(txt, it);
    li.appendChild(txt);

    li.appendChild(buildAreaPill(it.area || null, newArea => {
      it.area = newArea;
      saveSundayReset(getSundayReset());
      _afterSundayResetChange();
    }));

    const del = document.createElement('button');
    del.className = 'goal-delete';
    del.textContent = '×';
    del.title = 'Remove from Sunday Reset';
    del.addEventListener('click', () => {
      _removeInjectedGoal(it);
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


// ── Goal history — read-only view of past days ─────────────────────────────
// Past days' `goals:` entries are retained (rollover no longer deletes them);
// this lists them newest-first so you can see what was set and what got done.
const GOAL_HISTORY_DAYS = 90; // matches loadFromSupabase's 90-day window

// Display-only area pill (buildAreaPill always wires a click-to-edit dropdown).
// Returns null when the goal has no (known) area, so history rows stay clean.
function _historyAreaPill(areaName) {
  if (!areaName) return null;
  const areaObj = getAreas().find(a => a.name === areaName);
  if (!areaObj) return null;
  const pill = document.createElement('span');
  pill.className = 'goal-area-pill';
  pill.textContent = areaName;
  pill.style.background = areaObj.color + 'BF';
  pill.style.color = '#fff';
  return pill;
}

function renderGoalHistory() {
  const body = document.getElementById('goalHistoryBody');
  if (!body) return;
  body.innerHTML = '';

  const activeDate = getActiveDateString();
  const days = storeListKeys('goals:')
    .map(k => k.slice(6))
    .filter(d => d < activeDate)
    .sort()
    .reverse()
    .slice(0, GOAL_HISTORY_DAYS);

  if (days.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No past days yet — history builds up as days roll over.';
    body.appendChild(empty);
    return;
  }

  days.forEach(date => {
    const goals = storeGet('goals:' + date) || [];
    const done  = goals.filter(g => g.done).length;

    const head = document.createElement('div');
    head.className = 'goal-history-day';
    head.innerHTML = `<span>${formatDate(date)}</span>` +
      `<span class="goal-history-count">${done}/${goals.length}</span>`;
    body.appendChild(head);

    if (goals.length === 0) return;

    const ul = document.createElement('ul');
    ul.className = 'goal-list goal-history-list';
    goals.forEach(g => {
      const priClass = { High: 'goal-priority-high', Medium: 'goal-priority-med', Low: 'goal-priority-low' }[g.priority || 'Medium'] || 'goal-priority-med';
      const li = document.createElement('li');
      li.className = 'goal-row ' + priClass + (g.done ? ' is-done' : '');

      const mark = document.createElement('span');
      mark.className = 'goal-history-mark';
      mark.textContent = g.done ? '✓' : '○';
      li.appendChild(mark);

      const txt = document.createElement('span');
      txt.className = 'goal-text';
      txt.textContent = g.text;
      li.appendChild(txt);

      const pill = _historyAreaPill(g.area || null);
      if (pill) li.appendChild(pill);
      ul.appendChild(li);
    });
    body.appendChild(ul);
  });
}

function openGoalHistory() {
  renderGoalHistory();
  const modal = document.getElementById('goalHistoryModal');
  modal.classList.add('open');
  modal.querySelector('.sr-modal-card').scrollTop = 0;
  document.body.style.overflow = 'hidden';
}
function closeGoalHistory() {
  document.getElementById('goalHistoryModal').classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('goalHistoryBtn').addEventListener('click', openGoalHistory);
document.getElementById('goalHistoryClose').addEventListener('click', closeGoalHistory);
document.getElementById('goalHistoryModal').addEventListener('click', e => {
  if (e.target.id === 'goalHistoryModal') closeGoalHistory(); // backdrop click only
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('goalHistoryModal').classList.contains('open')) closeGoalHistory();
});
