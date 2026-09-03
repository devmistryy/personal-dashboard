// To Do tab: rollover, streak, goal rows, drag-reorder, inline edit,
// quick-add + polish. Loaded before main.js.

// ── Rollover ──
function rollover() {
  const activeDate = getActiveDateString();
  const keys = storeListKeys('goals:').filter(k => k.slice(6) < activeDate);
  keys.forEach(k => {
    const goals = storeGet(k) || [];
    const undone = goals.filter(g => !g.done);
    if (undone.length > 0) {
      const todayGoals = storeGet(todayKey()) || [];
      const existingTexts = new Set(todayGoals.map(g => g.text));
      undone.forEach(g => { if (!existingTexts.has(g.text)) todayGoals.push({ text: g.text, done: false }); });
      storeSet(todayKey(), todayGoals);
    }
    storeDelete(k);
  });
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

function renderTomorrowCount() {
  const goals = storeGet(tomorrowKey()) || [];
  document.getElementById('gmTomorrowCount').textContent = `${goals.length} planned`;
  document.getElementById('tomorrowLabel').textContent = `Plan tomorrow — ${formatDate(getTomorrowDateString())}`;
}


// ── Build goal row ──
function buildGoalRow(g, idx, goals, key, readOnly) {
  const priority = g.priority || 'Medium';
  const priClass = { High: 'goal-priority-high', Medium: 'goal-priority-med', Low: 'goal-priority-low' }[priority] || 'goal-priority-med';
  const li = document.createElement('li');
  li.className = 'goal-row ' + priClass + (g.done ? ' is-done' : '') + (g.queued && !g.done ? ' is-queued' : '');
  li.dataset.idx = idx;
  li.draggable = !readOnly;

  // Priority click strip (invisible, covers left border area)
  const priBtn = document.createElement('button');
  priBtn.className = 'goal-priority-btn';
  priBtn.title = `Priority: ${priority} — click to change`;
  priBtn.addEventListener('click', () => {
    const order = ['High', 'Medium', 'Low'];
    const cur = goals[idx].priority || 'Medium';
    goals[idx].priority = order[(order.indexOf(cur) + 1) % order.length];
    storeSet(key, goals);
    reload();
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
  if (readOnly) { cb.disabled = true; cb.title = 'Activates at 6 AM tomorrow'; }
  const cbBox = document.createElement('span');
  cbBox.className = 'goal-cb-box';
  cbWrap.appendChild(cb);
  cbWrap.appendChild(cbBox);
  li.appendChild(cbWrap);

  cb.addEventListener('change', () => {
    goals[idx].done = cb.checked;
    if (cb.checked) goals[idx].doneAt = Date.now();
    else delete goals[idx].doneAt;
    storeSet(key, goals);
    reload();
  });

  // Text
  const txt = document.createElement('span');
  txt.className = 'goal-text';
  txt.textContent = g.text;
  makeInlineEdit(txt, idx, goals, key, reload);
  li.appendChild(txt);

  // Area pill + dropdown
  li.appendChild(buildAreaPill(g.area, newArea => {
    goals[idx].area = newArea;
    storeSet(key, goals);
    reload();
  }));

  // Queue button
  const qBtn = document.createElement('button');
  qBtn.className = 'gm-queue-btn' + (g.queued ? ' is-queued' : '');
  qBtn.textContent = '⚡';
  qBtn.title = 'Toggle productivity queue';
  if (readOnly) qBtn.disabled = true;
  qBtn.addEventListener('click', () => {
    goals[idx].queued = !goals[idx].queued;
    storeSet(key, goals);
    li.classList.add('is-queue-flashing');
    setTimeout(reload, 480);
  });
  li.appendChild(qBtn);

  // Delete
  const del = document.createElement('button');
  del.className = 'goal-delete';
  del.textContent = '×';
  del.title = 'Delete goal';
  del.addEventListener('click', () => {
    goals.splice(idx, 1);
    storeSet(key, goals);
    reload();
  });
  li.appendChild(del);

  return li;

  function reload() {
    if (key === todayKey()) loadToday();
    else loadTomorrow();
  }
}

function makeInlineEdit(el, idx, goals, key, reload) {
  let original = '';
  el.addEventListener('click', () => {
    if (el.contentEditable === 'true') return;
    original = goals[idx].text;
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
      goals[idx].text = val;
      storeSet(key, goals);
      reload();
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

    const visible = (goals.length > LIMIT && !showAll) ? goals.slice(0, LIMIT) : goals;
    visible.forEach((g, i) => {
      listEl.appendChild(buildGoalRow(g, i, goals, key, readOnly));
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
    wireDragReorder(listEl, 'goal-row', (fromEl, toEl) => {
      const from = parseInt(fromEl.dataset.idx);
      const to   = parseInt(toEl.dataset.idx);
      const arr = storeGet(key) || [];
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item);
      storeSet(key, arr);
      if (key === todayKey()) loadToday(); else loadTomorrow();
    });
  }

  if (key === todayKey()) renderTodayHeader();
  else renderTomorrowCount();
}

function loadToday() {
  const goals = storeGet(todayKey()) || [];
  renderListInto(goals,
    document.getElementById('goalList'),
    document.getElementById('emptyState'),
    todayKey(), false);
}

function loadTomorrow() {
  const goals = storeGet(tomorrowKey()) || [];
  renderListInto(goals,
    document.getElementById('tomorrowList'),
    document.getElementById('tomorrowEmptyState'),
    tomorrowKey(), true);
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
    goals.push({ text, done: false, priority: 'Medium', area: null });
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
  const existingTexts = new Set(tomorrowGoals.map(g => g.text));
  const unchecked = todayGoals.filter(g => !g.done);
  unchecked.forEach(g => { if (!existingTexts.has(g.text)) tomorrowGoals.push({ text: g.text, done: false, priority: g.priority || 'Medium', area: g.area || null }); });
  storeSet(tomorrowKey(), tomorrowGoals);
  const remaining = todayGoals.filter(g => g.done);
  storeSet(todayKey(), remaining);
  loadToday();
  loadTomorrow();
});


// ── Sunday Reset — weekly recurring to-dos ─────────────────────────────────
// A fixed Sunday-only checklist. Entries are managed in a slide-in view and
// auto-injected into Sunday's To Do list, rolling over normally if unfinished.
// Persisted as two `settings` keys (rehydrated generically in loadFromSupabase):
//   sunday_reset_v1     – [{ id, text, area }] templates
//   sunday_reset_log_v1 – { "<Sunday YYYY-MM-DD>": [injected template ids] }

function getSundayReset()      { return MEM['sunday_reset_v1'] || []; }
function saveSundayReset(list) { MEM['sunday_reset_v1'] = list; _syncSetting('sunday_reset_v1', list); }

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
      goals.push({ text: it.text, done: false, priority: 'Medium', area: it.area || null });
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
