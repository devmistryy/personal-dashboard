// Goals tab-section: the goal list in "Areas & Goals". A goal is a long-term
// objective (distinct from a daily task) — a title, an optional area tag, a
// notes field revealed by expanding the row, and a done state. Completed goals
// drop into a collapsed "Completed" section. Loaded before main.js; declares
// functions + listeners only (no top-level calls — main.js owns those).

function _goalId() {
  return 'gl_' + ((crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

function getGoals()      { return MEM['goals:list'] || []; }
function saveGoals(list) { MEM['goals:list'] = list; _syncGoals(list); }

// Which goal rows are expanded (by id) + whether the Completed section is open —
// module state so a re-render keeps the UI where the user left it.
const _goalExpanded = new Set();
let _goalCompletedOpen = false;
let _goalDragFrom = null;

// ── Render ──
function renderGoals() {
  const list = document.getElementById('goalList');
  if (!list) return;
  const goals = getGoals();
  const active = goals.filter(g => !g.done);
  const done   = goals.filter(g => g.done)
    .sort((a, b) => String(b.doneAt || '').localeCompare(String(a.doneAt || '')));

  list.innerHTML = '';
  active.forEach(g => list.appendChild(buildGoalRow(g)));

  const empty = document.getElementById('goalEmptyState');
  if (empty) empty.style.display = active.length ? 'none' : 'block';

  const wrap   = document.getElementById('goalCompletedWrap');
  const toggle = document.getElementById('goalCompletedToggle');
  const dlist  = document.getElementById('goalCompletedList');
  if (wrap && toggle && dlist) {
    wrap.style.display = done.length ? 'block' : 'none';
    toggle.textContent = `${_goalCompletedOpen ? '▾' : '▸'} Completed · ${done.length}`;
    dlist.hidden = !_goalCompletedOpen;
    dlist.innerHTML = '';
    done.forEach(g => dlist.appendChild(buildGoalRow(g)));
  }
}

// Resolve a goal by id against the live list, mutate it, persist, re-render.
function _mutateGoal(id, fn) {
  const goals = getGoals();
  const g = goals.find(x => x.id === id);
  if (!g) return;
  fn(g, goals);
  saveGoals(goals);
  renderGoals();
}

function buildGoalRow(g) {
  const li = document.createElement('li');
  li.className = 'goal-row' + (g.done ? ' is-done' : '');
  li.dataset.id = g.id;

  // Drag-reorder (active goals only — stored order is the display order)
  if (!g.done) {
    li.draggable = true;
    const drag = document.createElement('span');
    drag.className = 'goal-drag-handle';
    drag.textContent = '⋮⋮';
    drag.setAttribute('aria-hidden', 'true');
    li.appendChild(drag);
    _wireGoalDrag(li, g.id);
  }

  // Checkbox
  const cbWrap = document.createElement('label');
  cbWrap.className = 'goal-cb-wrap';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!g.done;
  cb.addEventListener('change', () => {
    _mutateGoal(g.id, goal => {
      goal.done = cb.checked;
      goal.doneAt = cb.checked ? new Date().toISOString() : null;
    });
  });
  const cbBox = document.createElement('span');
  cbBox.className = 'goal-cb-box';
  cbWrap.appendChild(cb);
  cbWrap.appendChild(cbBox);
  li.appendChild(cbWrap);

  // Expand / collapse the notes drawer
  const exp = document.createElement('button');
  exp.className = 'goal-expand';
  exp.type = 'button';
  const isOpen = _goalExpanded.has(g.id);
  exp.textContent = isOpen ? '▾' : '▸';
  exp.title = 'Notes';
  exp.addEventListener('click', () => {
    if (_goalExpanded.has(g.id)) _goalExpanded.delete(g.id);
    else _goalExpanded.add(g.id);
    renderGoals();
  });
  li.appendChild(exp);

  // Title (inline-editable)
  const main = document.createElement('div');
  main.className = 'goal-main';
  const txt = document.createElement('span');
  txt.className = 'goal-text';
  txt.contentEditable = 'true';
  txt.spellcheck = false;
  txt.dataset.id = g.id;
  txt.textContent = g.title;
  main.appendChild(txt);
  if (g.notes && g.notes.trim() && !isOpen) {
    const dot = document.createElement('span');
    dot.className = 'goal-has-notes';
    dot.textContent = '·  note';
    main.appendChild(dot);
  }
  li.appendChild(main);

  // Area pill (optional — buildAreaPill handles null → "+ area")
  li.appendChild(buildAreaPill(g.area || null, newArea => {
    _mutateGoal(g.id, goal => { goal.area = newArea; });
  }));

  // Delete
  const del = document.createElement('button');
  del.className = 'goal-delete';
  del.type = 'button';
  del.textContent = '×';
  del.title = 'Delete goal';
  del.addEventListener('click', () => deleteGoal(g.id));
  li.appendChild(del);

  // Notes drawer (a second row spanning the flex container)
  if (isOpen) {
    const drawer = document.createElement('div');
    drawer.className = 'goal-notes-wrap';
    const ta = document.createElement('textarea');
    ta.className = 'goal-notes';
    ta.rows = 3;
    ta.placeholder = 'Notes for this goal…';
    ta.value = g.notes || '';
    ta.addEventListener('blur', () => {
      const v = ta.value.trim();
      if (v !== (g.notes || '')) _mutateGoal(g.id, goal => { goal.notes = v; });
    });
    drawer.appendChild(ta);
    li.appendChild(drawer);
  }

  return li;
}

function _wireGoalDrag(li, id) {
  li.addEventListener('dragstart', e => {
    _goalDragFrom = id;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => li.classList.add('dragging'), 0);
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    document.querySelectorAll('#goalList .goal-row').forEach(r => r.classList.remove('drag-over'));
  });
  li.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('#goalList .goal-row').forEach(r => r.classList.remove('drag-over'));
    if (id !== _goalDragFrom) li.classList.add('drag-over');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
  li.addEventListener('drop', e => {
    e.preventDefault();
    li.classList.remove('drag-over');
    if (_goalDragFrom == null || _goalDragFrom === id) return;
    const goals = getGoals();
    const from = goals.findIndex(x => x.id === _goalDragFrom);
    const to   = goals.findIndex(x => x.id === id);
    if (from < 0 || to < 0) return;
    const [moved] = goals.splice(from, 1);
    goals.splice(to, 0, moved);
    saveGoals(goals);
    _goalDragFrom = null;
    renderGoals();
  });
}

function deleteGoal(id) {
  const g = getGoals().find(x => x.id === id);
  if (!g) return;
  if (!confirm(`Delete goal "${g.title}"?`)) return;
  _goalExpanded.delete(id);
  saveGoals(getGoals().filter(x => x.id !== id));
  renderGoals();
}

function addGoal(title) {
  const t = title.trim();
  if (!t) return;
  const goals = getGoals();
  goals.unshift({
    id: _goalId(), title: t, area: null, notes: '',
    done: false, doneAt: null, createdAt: new Date().toISOString(),
  });
  saveGoals(goals);
  renderGoals();
}

// ── Listeners (parse-time; every id must exist in index.html) ──
document.getElementById('goalAddBtn').addEventListener('click', () => {
  const inp = document.getElementById('goalInput');
  addGoal(inp.value);
  inp.value = '';
  inp.focus();
});
document.getElementById('goalInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const t = e.target.value; e.target.value = ''; addGoal(t); }
});

document.getElementById('goalCompletedToggle').addEventListener('click', () => {
  _goalCompletedOpen = !_goalCompletedOpen;
  renderGoals();
});

// Inline title save (delegated, matches the Jobs company-name pattern)
document.addEventListener('blur', e => {
  if (!e.target.classList || !e.target.classList.contains('goal-text')) return;
  const id = e.target.dataset.id;
  const title = e.target.textContent.trim();
  const g = getGoals().find(x => x.id === id);
  if (!g) return;
  if (!title) { e.target.textContent = g.title; return; }   // don't allow empty
  if (title !== g.title) _mutateGoal(id, goal => { goal.title = title; });
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('goal-text')) {
    e.preventDefault(); e.target.blur();
  }
});

// Re-render when the Areas & Goals tab is opened (mirrors renderAreas hook)
document.querySelectorAll('.tab-btn').forEach(btn => {
  if (btn.dataset.tab === 'areas') btn.addEventListener('click', renderGoals);
});
