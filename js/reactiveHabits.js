// Reactive Habits: cue-triggered habits (Situational or Internal) tracked
// per-occurrence rather than with a daily checkbox — each time the cue
// arises, log whether it was handled well or not. Lives inside the Habits
// tab's "Habit Calendar" card, in the column beside the calendar.

function getReactiveHabits() { return MEM['reactive_habits:list'] || (MEM['reactive_habits:list'] = []); }
function saveReactiveHabits(list) { MEM['reactive_habits:list'] = list; _syncReactiveHabits(list); }
function getReactiveOccurrences() { return MEM['reactive_habits:log'] || (MEM['reactive_habits:log'] = []); }
function saveReactiveOccurrences(list) { MEM['reactive_habits:log'] = list; _syncReactiveOccurrences(list); }

function _rhId() {
  return 'rh_' + ((crypto && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
}

function _rhCueLabel(cueType) { return cueType === 'internal' ? 'Internal' : 'Situational'; }

function _rhStats(habitId) {
  const occ = getReactiveOccurrences().filter(o => o.habitId === habitId);
  const good = occ.filter(o => o.outcome === 'good').length;
  return { total: occ.length, good, pct: occ.length ? Math.round(good / occ.length * 100) : 0 };
}

function _rhFmtTs(ts) {
  const d = new Date(ts);
  const day = _localDateStr(d);
  const today = _localDateStr(new Date());
  const yestD = new Date(); yestD.setDate(yestD.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const label = day === today ? 'Today'
    : day === _localDateStr(yestD) ? 'Yesterday'
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return label + ' · ' + time;
}

const _RH_CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#6BE3A4" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const _RH_X_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="#FF6B6B" stroke-width="3" stroke-linecap="round"/></svg>';

// ── Compact panel (beside the calendar) ──

function renderReactiveHabits() {
  const habits = getReactiveHabits();
  const listEl = document.getElementById('reactiveHabitList');
  const emptyEl = document.getElementById('reactiveHabitEmpty');
  if (!listEl) return;
  listEl.innerHTML = '';
  habits.forEach(h => listEl.appendChild(buildReactiveHabitRow(h)));
  emptyEl.style.display = habits.length ? 'none' : '';
  _renderRhCueBtns('rhCueBtns', _rhPanelCueType, 'panel');
  if (_reactiveDetailOpen) renderReactiveDetailPage();
}

// When it was last logged, in words: "today", "yesterday" or "Sep 14".
function _rhLastLabel(occ) {
  if (!occ) return 'not logged yet';
  const d = new Date(occ.ts);
  const day = _localDateStr(d);
  const today = _localDateStr(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (day === today) return 'today';
  if (day === _localDateStr(y)) return 'yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function buildReactiveHabitRow(habit) {
  const occ = getReactiveOccurrences().filter(o => o.habitId === habit.id)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const good = occ.filter(o => o.outcome === 'good').length;
  const dots = occ.slice(-6).map(o => `<u class="${o.outcome === 'good' ? 'g' : 'b'}"></u>`).join('');
  const li = document.createElement('li');
  li.className = 'rh-row';
  li.dataset.habitId = habit.id;
  li.innerHTML = `
    <div class="rh-name-col">
      <span class="rh-name">${_esc(habit.name)}</span>
      <span class="rh-sub">
        <span class="rh-badge rh-badge-${habit.cueType}">${_rhCueLabel(habit.cueType)}</span>
        ${dots ? `<span class="rh-outs" aria-hidden="true">${dots}</span>` : ''}
        <span>${occ.length ? `handled ${good} of ${occ.length}` : 'not logged yet'}${occ.length ? ' · ' + _rhLastLabel(occ[occ.length - 1]) : ''}</span>
      </span>
    </div>
    <button class="rh-log-btn good" data-action="good" type="button" title="Handled well" aria-label="Handled well">${_RH_CHECK_SVG}</button>
    <button class="rh-log-btn bad" data-action="bad" type="button" title="Slipped" aria-label="Slipped">${_RH_X_SVG}</button>
  `;
  return li;
}

document.getElementById('reactiveHabitList').addEventListener('click', e => {
  const btn = e.target.closest('.rh-log-btn');
  const row = e.target.closest('.rh-row');
  if (!row) return;
  if (btn) {
    const good = btn.dataset.action === 'good';
    logReactiveOccurrence(row.dataset.habitId, good ? 'good' : 'bad');
    showToast(good ? 'Logged: handled well' : 'Logged: slipped');
    return;
  }
  openReactiveDetail();
});

let _rhPanelCueType = 'situational';

function _renderRhCueBtns(containerId, selected, scope) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = ['situational', 'internal'].map(c => `
    <button type="button" class="rh-cue-btn${c === selected ? ' active on' : ''}" data-cue="${c}" data-scope="${scope}">${_rhCueLabel(c)}</button>
  `).join('');
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.rh-cue-btn');
  if (!btn) return;
  if (btn.dataset.scope === 'panel') { _rhPanelCueType = btn.dataset.cue; _renderRhCueBtns('rhCueBtns', _rhPanelCueType, 'panel'); }
  else { _rhDetailCueType = btn.dataset.cue; _renderRhCueBtns('rhDetailCueBtns', _rhDetailCueType, 'detail'); }
});

function _rhShowAddForm(show) {
  document.getElementById('rhAddForm').hidden = !show;
  document.getElementById('rhAddToggle').hidden = show;
  if (show) document.getElementById('rhNameInput').focus();
  else document.getElementById('rhNameInput').value = '';
}

function addReactiveHabit() {
  const input = document.getElementById('rhNameInput');
  const name = input.value.trim();
  if (!name) return;
  _createReactiveHabit(name, _rhPanelCueType);
  _rhShowAddForm(false);
  renderReactiveHabits();
  showToast('Reactive habit added');
}

document.getElementById('rhAddToggle').addEventListener('click', () => _rhShowAddForm(true));
document.getElementById('rhAddCancel').addEventListener('click', () => _rhShowAddForm(false));

function _createReactiveHabit(name, cueType) {
  const list = getReactiveHabits();
  list.push({ id: _rhId(), name, cueType, createdAt: new Date().toISOString() });
  saveReactiveHabits(list);
}

function logReactiveOccurrence(habitId, outcome) {
  const list = getReactiveOccurrences();
  list.push({ id: _rhId(), habitId, ts: new Date().toISOString(), outcome });
  saveReactiveOccurrences(list);
  renderReactiveHabits();
}

document.getElementById('rhAddBtn').addEventListener('click', addReactiveHabit);
document.getElementById('rhNameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') addReactiveHabit();
  if (e.key === 'Escape') _rhShowAddForm(false);
});

// ── Detail overlay ("View all") ──

let _reactiveDetailOpen = false;
let _rhDetailCueType = 'situational';

function openReactiveDetail() {
  _reactiveDetailOpen = true;
  renderReactiveDetailPage();
  document.getElementById('reactiveDetailPage').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeReactiveDetail() {
  _reactiveDetailOpen = false;
  document.getElementById('reactiveDetailPage').classList.remove('open');
  document.body.style.overflow = '';
}

function renderReactiveDetailPage() {
  const body = document.getElementById('reactiveDetailBody');
  if (!body) return;

  const habits = getReactiveHabits();
  const occAll = getReactiveOccurrences();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const loggedThisWeek = occAll.filter(o => new Date(o.ts).getTime() >= weekAgo).length;
  const good = occAll.filter(o => o.outcome === 'good').length;
  const pct = occAll.length ? Math.round(good / occAll.length * 100) : 0;

  const statRow = `
    <div class="habit-detail-stats-grid" style="grid-template-columns: repeat(2, 1fr);">
      <div class="habit-stat-card"><span class="habit-stat-val">${loggedThisWeek}</span><span class="habit-stat-label">Logged This Week</span></div>
      <div class="habit-stat-card"><span class="habit-stat-val">${pct}%</span><span class="habit-stat-label">Handled Well</span></div>
    </div>`;

  const listHtml = habits.length ? habits.map(h => {
    const s = _rhStats(h.id);
    return `
    <div class="rh-detail-row" data-habit-id="${h.id}">
      <div class="rh-detail-row-main">
        <div class="rh-detail-row-head">
          <span class="rh-name">${_esc(h.name)}</span>
          <span class="rh-badge rh-badge-${h.cueType}">${_rhCueLabel(h.cueType)}</span>
        </div>
        <div class="rh-bar-wrap"><div class="rh-bar-fill" style="width:${s.pct}%;"></div></div>
      </div>
      <span class="rh-stat mono">${s.total} logged · ${s.pct}%</span>
      <button class="rh-detail-btn good" data-action="good">&#10003; Handled well</button>
      <button class="rh-detail-btn bad" data-action="bad">&#10005; Slipped</button>
      <button class="rh-detail-delete" data-action="delete-habit" title="Delete this reactive habit">&times;</button>
    </div>`;
  }).join('') : '<div class="empty-state">No reactive habits yet — add one below.</div>';

  const recent = occAll.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 20);
  const timelineHtml = recent.length ? recent.map(o => {
    const h = habits.find(x => x.id === o.habitId);
    return `
    <div class="rh-timeline-row" data-occ-id="${o.id}">
      <span class="mono rh-timeline-ts">${_rhFmtTs(o.ts)}</span>
      <span class="rh-timeline-name">${h ? _esc(h.name) : '(deleted habit)'}</span>
      ${h ? `<span class="rh-badge rh-badge-${h.cueType}">${_rhCueLabel(h.cueType)}</span>` : ''}
      <span class="rh-pill rh-pill-${o.outcome === 'good' ? 'good' : 'bad'}">${o.outcome === 'good' ? 'Handled well' : 'Slipped'}</span>
      <button class="rh-timeline-delete" data-action="delete-occ" title="Remove this entry">&times;</button>
    </div>`;
  }).join('') : '<div class="empty-state">Nothing logged yet.</div>';

  body.innerHTML = `
    ${statRow}
    <div class="habit-detail-section-title" style="margin-top:24px;">Watching For</div>
    <div class="rh-detail-list">${listHtml}</div>
    <div class="habit-detail-section-title" style="margin-top:24px;">Recent Occurrences</div>
    <div class="rh-timeline">${timelineHtml}</div>
    <div class="habit-add-form">
      <div class="habit-add-row">
        <input type="text" class="task-input" id="rhDetailNameInput" placeholder="Add a reactive habit…" style="flex:1;">
        <button class="btn-add" id="rhDetailAddBtn">+ Add</button>
      </div>
      <div class="habit-date-wrap">
        <span class="habit-date-label">Cue type:</span>
        <div id="rhDetailCueBtns" style="display:flex; gap:8px;"></div>
      </div>
    </div>
  `;
  _renderRhCueBtns('rhDetailCueBtns', _rhDetailCueType, 'detail');

  document.getElementById('rhDetailAddBtn').addEventListener('click', () => {
    const input = document.getElementById('rhDetailNameInput');
    const name = input.value.trim();
    if (!name) return;
    _createReactiveHabit(name, _rhDetailCueType);
    renderReactiveHabits();
  });
  document.getElementById('rhDetailNameInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('rhDetailAddBtn').click();
  });
}

document.getElementById('reactiveDetailBody').addEventListener('click', e => {
  const logBtn = e.target.closest('.rh-detail-btn');
  const delHabitBtn = e.target.closest('.rh-detail-delete');
  const delOccBtn = e.target.closest('.rh-timeline-delete');

  if (logBtn) {
    const habitId = logBtn.closest('.rh-detail-row').dataset.habitId;
    logReactiveOccurrence(habitId, logBtn.dataset.action === 'good' ? 'good' : 'bad');
    return;
  }
  if (delHabitBtn) {
    const habitId = delHabitBtn.closest('.rh-detail-row').dataset.habitId;
    deleteReactiveHabit(habitId);
    return;
  }
  if (delOccBtn) {
    const occId = delOccBtn.closest('.rh-timeline-row').dataset.occId;
    deleteReactiveOccurrence(occId);
  }
});

function deleteReactiveHabit(habitId) {
  if (!confirm('Delete this reactive habit? This also removes its logged history.')) return;
  saveReactiveHabits(getReactiveHabits().filter(h => h.id !== habitId));
  saveReactiveOccurrences(getReactiveOccurrences().filter(o => o.habitId !== habitId));
  _syncPurgeReactiveHabit(habitId);
  renderReactiveHabits();
}

function deleteReactiveOccurrence(occId) {
  saveReactiveOccurrences(getReactiveOccurrences().filter(o => o.id !== occId));
  renderReactiveHabits();
}

document.getElementById('rhViewAllLink').addEventListener('click', openReactiveDetail);

document.getElementById('reactiveDetailBack').addEventListener('click', closeReactiveDetail);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('reactiveDetailPage').classList.contains('open')) closeReactiveDetail();
});
