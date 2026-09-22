// To Do tab — keeping the list honest: stale-task triage, the Someday list,
// and the "same area, all waiting" batch suggestion. Loaded after todo.js,
// before main.js. Only declares functions + registers listeners.

// ── Someday ─────────────────────────────────────────────────────────────────
// Tasks you want to keep but not see every day. They live outside the dated
// lists (so rollover never touches them) in one `settings` row:
//   task_someday_v1 – [{ id, text, area, priority, est, due, steps, addedAt }]
function getSomeday()      { return MEM['task_someday_v1'] || []; }
function saveSomeday(list) { MEM['task_someday_v1'] = list; _syncSetting('task_someday_v1', list); }

// Take a task off a day's list and park it in Someday. deleteTask() dismisses
// and purges its history, so rollover can't carry it back.
function moveTaskToSomeday(key, g) {
  const item = { id: g.id, text: g.text, area: g.area || null, priority: g.priority || 'Medium',
                 addedAt: new Date().toISOString() };
  if (g.est > 0) item.est = g.est;
  if (g.due) item.due = g.due;
  if (Array.isArray(g.steps) && g.steps.length) item.steps = g.steps.map(x => ({ text: x.text, done: !!x.done }));
  saveSomeday(getSomeday().concat(item));
  deleteTask(key, g);
}

// Bring one back onto today. It gets a fresh id: the old one is in
// task_dismissed_v1, and reusing it would stop rollover carrying it later.
function restoreSomedayTask(id) {
  const list = getSomeday();
  const item = list.find(x => x.id === id);
  if (!item) return;
  const fields = { text: item.text, area: item.area, priority: item.priority };
  if (item.est) fields.est = item.est;
  if (item.due) fields.due = item.due;
  if (item.steps) fields.steps = item.steps;
  const arr = (storeGet(todayKey()) || []).slice();
  arr.push(makeTask(fields));
  storeSet(todayKey(), arr);
  saveSomeday(list.filter(x => x.id !== id));
}

function renderSomeday() {
  const body = document.getElementById('somedayBody');
  if (!body) return;
  const list = getSomeday();
  body.innerHTML = '';
  const intro = document.createElement('p');
  intro.className = 'sunday-reset-intro';
  intro.textContent = list.length
    ? 'Parked tasks. They don’t roll over or count toward today. Bring one back when it’s time.'
    : 'Nothing parked. Triage sends tasks here when they’re not for this week.';
  body.appendChild(intro);
  if (!list.length) return;
  const ul = document.createElement('ul');
  ul.className = 'task-list someday-list';
  list.forEach(item => {
    const li = document.createElement('li');
    li.className = 'task-row someday-row';
    const txt = document.createElement('span');
    txt.className = 'task-text';
    txt.textContent = item.text;
    li.appendChild(txt);
    const pill = _historyAreaPill(item.area || null);
    if (pill) li.appendChild(pill);
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'sunday-reset-btn someday-back';
    back.textContent = '→ Today';
    back.addEventListener('click', () => {
      restoreSomedayTask(item.id);
      renderSomeday(); loadToday();
      showToast('Moved to today');
    });
    li.appendChild(back);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-delete';
    del.textContent = '×';
    del.title = 'Delete';
    del.setAttribute('aria-label', 'Delete ' + item.text);
    del.addEventListener('click', () => {
      saveSomeday(getSomeday().filter(x => x.id !== item.id));
      renderSomeday(); loadToday();
    });
    li.appendChild(del);
    ul.appendChild(li);
  });
  body.appendChild(ul);
}

function openSomeday() {
  renderSomeday();
  document.getElementById('somedayModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSomeday() {
  document.getElementById('somedayModal').classList.remove('open');
  document.body.style.overflow = '';
}

// Bottom of the Today card: the collapsible Done section on the left, the
// Someday count on the right.
let _doneOpen = false;
function buildTodayFooter(done, key) {
  const foot = document.createElement('div');
  foot.className = 'task-foot';
  if (done.length) {
    const det = document.createElement('details');
    det.className = 'task-done-group';
    det.open = _doneOpen;
    det.addEventListener('toggle', () => { _doneOpen = det.open; });
    const sum = document.createElement('summary');
    sum.textContent = `Done today · ${done.length}`;
    det.appendChild(sum);
    const ul = document.createElement('ul');
    ul.className = 'task-list';
    done.forEach((g, i) => ul.appendChild(buildTaskRow(g, i, done, key, false, false)));
    det.appendChild(ul);
    foot.appendChild(det);
  } else {
    const none = document.createElement('span');
    none.className = 'task-foot-note';
    none.textContent = 'Done today · 0';
    foot.appendChild(none);
  }
  const n = getSomeday().length;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'task-foot-someday';
  btn.textContent = `Someday · ${n}`;
  btn.addEventListener('click', openSomeday);
  foot.appendChild(btn);
  return foot;
}


// ── Stale-task triage ───────────────────────────────────────────────────────
// A task that's been carried over for a week or more gets a decision instead
// of another day on the list: do it today, move it, park it, break it down, or
// drop it. One card at a time.
const STALE_DAYS = 7;

function staleTasks() {
  return (storeGet(todayKey()) || [])
    .filter(g => !g.done && !g.focus)
    .map(g => ({ g, days: taskOverdueDays(g) }))
    .filter(x => x.days >= STALE_DAYS)
    .sort((a, b) => b.days - a.days);
}

// "Triage N stale →" at the end of the Group bar.
function paintTriageLink(bar) {
  if (!bar || bar.hidden) return;
  const n = staleTasks().length;
  if (!n) return;
  const sp = document.createElement('span');
  sp.className = 'task-sort-spacer';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'task-triage-link';
  b.textContent = `Triage ${n} stale →`;
  b.title = `Tasks carried over ${STALE_DAYS}+ days`;
  b.addEventListener('click', openTriage);
  bar.append(sp, b);
}

let _triage = { ids: [], i: 0, log: [], mode: null };

function openTriage() {
  _triage = { ids: staleTasks().map(x => x.g.id), i: 0, log: [], mode: null };
  renderTriage();
  document.getElementById('triageModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeTriage() {
  document.getElementById('triageModal').classList.remove('open');
  document.body.style.overflow = '';
  loadToday(); loadUpcoming();
}

// The last 14 days (oldest first), filled from the day it was first added.
// Rollover only writes a copy on days the app is opened, so the stored rows
// have gaps; the task was waiting on every one of those days regardless.
function _triageHistory(g) {
  const waited = taskOverdueDays(g);
  const days = [];
  for (let k = 13; k >= 0; k--) days.push(k <= waited);
  return days;
}

function _triageCurrent() {
  while (_triage.i < _triage.ids.length) {
    const g = (storeGet(todayKey()) || []).find(x => x.id === _triage.ids[_triage.i]);
    if (g && !g.done) return g;
    _triage.i++;                          // finished or removed meanwhile
  }
  return null;
}

// Record the decision for `g` and move to the next card. `g` is passed in
// because the action has usually just taken it off today's list.
function _triageDone(label, g) {
  _triage.log.push([taskStepsView(g).title, label]);
  _triage.i++;
  _triage.mode = null;
  renderTriage();
}

function renderTriage() {
  const body = document.getElementById('triageBody');
  const count = document.getElementById('triageCount');
  const total = _triage.ids.length;
  const g = _triageCurrent();
  body.innerHTML = '';

  const dots = document.createElement('div');
  dots.className = 'triage-dots';
  for (let k = 0; k < total; k++) {
    const d = document.createElement('i');
    if (k <= _triage.i) d.className = 'on';
    dots.appendChild(d);
  }

  if (!g) {
    count.textContent = total ? 'All sorted' : 'Nothing stale';
    const done = document.createElement('div');
    done.className = 'triage-done';
    const h = document.createElement('b');
    h.textContent = total ? 'Backlog cleared' : `No task has been carried over ${STALE_DAYS}+ days.`;
    done.appendChild(h);
    if (_triage.log.length) {
      const ul = document.createElement('ul');
      _triage.log.forEach(([name, what]) => {
        const li = document.createElement('li');
        li.textContent = `${name} → ${what}`;
        ul.appendChild(li);
      });
      done.appendChild(ul);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-add';
    close.textContent = 'Done';
    close.addEventListener('click', closeTriage);
    done.appendChild(close);
    body.appendChild(done);
    return;
  }

  count.textContent = `${_triage.i + 1} of ${total}`;
  body.appendChild(dots);
  const days = taskOverdueDays(g);
  const isSR = isSundayResetTask(g);
  const card = document.createElement('div');
  card.className = 'triage-card';
  const title = document.createElement('h3');
  title.textContent = taskStepsView(g).title;
  const facts = document.createElement('div');
  facts.className = 'triage-facts';
  const first = _addDays(getActiveDateString(), -days);
  facts.innerHTML = `<span>carried <b>${days} days</b></span><span>first added ${formatDate(first)}</span>` +
    (g.area ? `<span>${g.area.replace(/[&<>]/g, '')}</span>` : '') + (isSR ? '<span>weekly · Sunday Reset</span>' : '');
  const hist = document.createElement('div');
  hist.className = 'triage-hist';
  hist.title = 'Last 14 days — filled = waiting on the list';
  _triageHistory(g).forEach(on => { const u = document.createElement('u'); if (on) u.className = 'x'; hist.appendChild(u); });
  card.append(title, facts, hist);
  body.appendChild(card);

  // Follow-up inputs for "Pick a day" and "Break down"
  if (_triage.mode === 'pick' || _triage.mode === 'break') {
    const row = document.createElement('form');
    row.className = 'triage-follow';
    const inp = document.createElement('input');
    const go = document.createElement('button');
    go.type = 'submit';
    go.className = 'btn-add';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn-polish';
    back.textContent = 'Back';
    back.addEventListener('click', () => { _triage.mode = null; renderTriage(); });
    if (_triage.mode === 'pick') {
      inp.type = 'date';
      inp.className = 'task-date-input';
      inp.min = getTomorrowDateString();
      inp.value = _addDays(getActiveDateString(), 7);
      inp.setAttribute('aria-label', 'Move to day');
      go.textContent = 'Move';
    } else {
      inp.type = 'text';
      inp.className = 'task-input';
      inp.placeholder = 'Steps, comma separated: measure desk, order stand';
      inp.setAttribute('aria-label', 'Steps');
      go.textContent = 'Save steps';
    }
    row.append(inp, back, go);
    row.addEventListener('submit', e => {
      e.preventDefault();
      if (_triage.mode === 'pick') {
        if (!inp.value || inp.value < getTomorrowDateString()) return;
        moveTaskToDate(todayKey(), g.id, inp.value);
        _triageDone('moved to ' + formatDate(inp.value), g);
      } else {
        const steps = inp.value.split(',').map(x => x.trim()).filter(Boolean);
        if (steps.length < 2) { inp.placeholder = 'Add at least two steps'; inp.value = ''; return; }
        const arr = (storeGet(todayKey()) || []).slice();
        const i = arr.findIndex(x => x.id === g.id);
        if (i >= 0) { arr[i] = Object.assign({}, arr[i], { steps: steps.map(t => ({ text: t, done: false })) }); storeSet(todayKey(), arr); }
        _triageDone(`broken into ${steps.length} steps`, g);
      }
    });
    body.appendChild(row);
    inp.focus();
    return;
  }

  const focusFull = (storeGet(todayKey()) || []).filter(x => x.focus && !x.done).length >= FOCUS_MAX;
  const opts = [
    ['1', focusFull ? 'Keep for today' : 'Today ★', focusFull ? 'Focus is full' : 'into Focus', () => {
      if (!focusFull) toggleTaskFocus(todayKey(), g.id);
      _triageDone(focusFull ? 'kept for today' : 'Focus', g);
    }],
    ['2', 'Tomorrow', 'first thing', () => { moveTaskToDate(todayKey(), g.id, getTomorrowDateString()); _triageDone('tomorrow', g); }],
    ['3', 'Pick a day', 'calendar', () => { _triage.mode = 'pick'; renderTriage(); }],
    isSR
      ? ['4', 'Skip this week', 'comes back Sunday', () => { deleteTask(todayKey(), g); _triageDone('skipped this week', g); }]
      : ['4', 'Someday', 'off the daily list', () => { moveTaskToSomeday(todayKey(), g); _triageDone('Someday', g); }],
    ['5', 'Break down', 'split into steps', () => { _triage.mode = 'break'; renderTriage(); }],
    ['6', 'Drop', 'delete it', () => { deleteTask(todayKey(), g); _triageDone('dropped', g); }, 'is-drop'],
  ];
  const grid = document.createElement('div');
  grid.className = 'triage-opts';
  opts.forEach(([k, label, sub, fn, cls]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'triage-opt' + (cls ? ' ' + cls : '');
    b.dataset.key = k;
    b.innerHTML = `<kbd>${k}</kbd><b></b><span></span>`;
    b.querySelector('b').textContent = label;
    b.querySelector('span').textContent = sub;
    b.addEventListener('click', fn);
    grid.appendChild(b);
  });
  body.appendChild(grid);
}


// ── Batch suggestion ────────────────────────────────────────────────────────
// When three or more open tasks in one area have all been waiting 5+ days,
// they're usually one trip or one sitting. Offer to plan them for the coming
// Saturday together. "Not now" hides it for the rest of the day.
const BATCH_MIN = 3, BATCH_WAIT = 5;
const BATCH_DISMISS_KEY = 'todo_batch_dismissed';   // localStorage: "<date>|<area>"

function _comingSaturday() {
  const ds = getActiveDateString();
  const [y, m, d] = ds.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return _addDays(ds, ((6 - dow + 7) % 7) || 7);
}

function batchSuggestion() {
  const open = (storeGet(todayKey()) || []).filter(g => !g.done && g.area);
  let dismissed = '';
  try { dismissed = localStorage.getItem(BATCH_DISMISS_KEY) || ''; } catch (e) {}
  const byArea = new Map();
  open.forEach(g => {
    const days = taskOverdueDays(g);
    if (days < BATCH_WAIT) return;
    if (!byArea.has(g.area)) byArea.set(g.area, []);
    byArea.get(g.area).push({ g, days });
  });
  for (const [area, list] of byArea) {
    if (list.length < BATCH_MIN) continue;
    if (dismissed === getActiveDateString() + '|' + area) continue;
    return { area, list };
  }
  return null;
}

function buildBatchNudge() {
  const s = batchSuggestion();
  if (!s) return null;
  const sat = _comingSaturday();
  // Focus tasks and ones due before Saturday stay on today — moving them would
  // undo a choice or make them late.
  const movable = s.list.filter(x => !x.g.focus && (!x.g.due || x.g.due >= sat));
  const days = s.list.map(x => x.days);
  const box = document.createElement('div');
  box.className = 'task-nudge';
  const msg = document.createElement('span');
  msg.className = 'task-nudge-msg';
  const lo = Math.min(...days), hi = Math.max(...days);
  msg.innerHTML = `<b></b> have been waiting ${lo === hi ? lo : lo + '–' + hi} days. Do them in one go?`;
  msg.querySelector('b').textContent = `${s.list.length} ${s.area} tasks`;
  box.appendChild(msg);
  const sp = document.createElement('span');
  sp.className = 'task-nudge-sp';
  box.appendChild(sp);
  if (movable.length >= 2) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'task-nudge-go';
    go.textContent = `Plan ${movable.length} for ${formatDate(sat).split(',')[0]}`;
    go.title = movable.length < s.list.length
      ? `Moves ${movable.length} to ${formatDate(sat)}; the rest are in Focus or due sooner and stay on today`
      : `Moves them all to ${formatDate(sat)}`;
    go.addEventListener('click', () => {
      movable.forEach(x => moveTaskToDate(todayKey(), x.g.id, sat));
      showToast(`${movable.length} ${s.area} tasks planned for ${formatDate(sat)}`);
    });
    box.appendChild(go);
  }
  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'task-nudge-ghost';
  star.textContent = 'Not now';
  star.addEventListener('click', () => {
    try { localStorage.setItem(BATCH_DISMISS_KEY, getActiveDateString() + '|' + s.area); } catch (e) {}
    box.remove();
  });
  box.appendChild(star);
  return box;
}


// ── Listeners ──
document.getElementById('triageClose').addEventListener('click', closeTriage);
document.getElementById('triageModal').addEventListener('click', e => {
  if (e.target.id === 'triageModal') closeTriage();
});
document.getElementById('somedayClose').addEventListener('click', closeSomeday);
document.getElementById('somedayModal').addEventListener('click', e => {
  if (e.target.id === 'somedayModal') closeSomeday();
});
document.addEventListener('keydown', e => {
  const tri = document.getElementById('triageModal');
  if (tri.classList.contains('open')) {
    if (e.key === 'Escape') { closeTriage(); return; }
    if (/^[1-6]$/.test(e.key) && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      const b = tri.querySelector(`.triage-opt[data-key="${e.key}"]`);
      if (b) { e.preventDefault(); b.click(); }
    }
    return;
  }
  if (e.key === 'Escape' && document.getElementById('somedayModal').classList.contains('open')) closeSomeday();
});
