// Areas tab: area grid, area detail page, area creation modal.
// Loaded before main.js.

// ── Areas ──
function getAllGoalAreas() {
  const all = [];
  const keys = [todayKey(), tomorrowKey()];
  keys.forEach(k => {
    (storeGet(k) || []).forEach(g => { if (g.area) all.push(g.area); });
  });
  return all;
}

// ── Area detail ──
let _currentAreaName = null;

function getAreaNotes(name) { return (MEM['area_notes:' + name] || []); }
function saveAreaNotes(name, notes) { MEM['area_notes:' + name] = notes; }

function openAreaDetail(name) {
  _currentAreaName = name;
  document.getElementById('areaDetailPage').classList.add('open');
  renderAreaDetail();
}

function closeAreaDetail() {
  document.getElementById('areaDetailPage').classList.remove('open');
  _currentAreaName = null;
  renderAreas();
}

function renderAreaDetail() {
  if (!_currentAreaName) return;
  const name = _currentAreaName;

  // Name
  const nameEl = document.getElementById('areaDetailName');
  nameEl.textContent = name;
  nameEl.onblur = () => {
    const newName = nameEl.textContent.trim();
    if (!newName || newName === name) { nameEl.textContent = name; return; }
    const areas = getAreas();
    const idx = areas.findIndex(a => a.name === name);
    if (idx === -1) return;
    areas[idx] = { ...areas[idx], name: newName };
    saveAreas(areas);
    // rename notes key
    const notes = getAreaNotes(name);
    saveAreaNotes(newName, notes);
    MEM['area_notes:' + name] = undefined;
    // update goals
    [todayKey(), tomorrowKey()].forEach(k => {
      const goals = storeGet(k) || [];
      let changed = false;
      goals.forEach(g => { if (g.area === name) { g.area = newName; changed = true; } });
      if (changed) storeSet(k, goals);
    });
    _currentAreaName = newName;
  };
  nameEl.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = _currentAreaName; nameEl.blur(); }
  };

  // Color swatches
  const colorRow = document.getElementById('areaDetailColorRow');
  colorRow.innerHTML = '';
  const areas = getAreas();
  const areaObj = areas.find(a => a.name === name) || {};
  const usedColors = new Set(areas.filter(a => a.name !== name).map(a => a.color));
  AREA_COLORS.forEach(c => {
    const taken = usedColors.has(c);
    const sw = document.createElement('div');
    sw.className = 'area-color-swatch' + (c === areaObj.color ? ' selected' : '') + (taken ? ' taken' : '');
    sw.style.cssText = `background:${c};width:22px;height:22px;border-radius:50%;flex-shrink:0;border:2px solid transparent;box-sizing:border-box;transition:transform 0.12s,border-color 0.12s;position:relative;overflow:hidden;`;
    if (c === areaObj.color) { sw.style.borderColor = '#fff'; sw.style.transform = 'scale(1.15)'; }
    if (taken) { sw.style.cursor = 'not-allowed'; sw.style.borderColor = 'rgba(160,160,160,0.9)'; sw.title = 'Already in use'; }
    else {
      sw.style.cursor = 'pointer';
      sw.addEventListener('click', () => {
        const areas = getAreas();
        const idx = areas.findIndex(a => a.name === _currentAreaName);
        if (idx === -1) return;
        areas[idx] = { ...areas[idx], color: c };
        saveAreas(areas);
        colorRow.querySelectorAll('.area-color-swatch').forEach(s => { s.classList.remove('selected'); s.style.borderColor = 'transparent'; s.style.transform = ''; if (s.classList.contains('taken')) s.style.borderColor = 'rgba(160,160,160,0.9)'; });
        sw.classList.add('selected'); sw.style.borderColor = '#fff'; sw.style.transform = 'scale(1.15)';
      });
    }
    colorRow.appendChild(sw);
  });

  renderAreaGoals();
  renderAreaHabits();
  renderAreaNotes();
}

function renderAreaGoals() {
  const name = _currentAreaName;
  const wrap = document.getElementById('areaDetailGoals');
  wrap.innerHTML = '';
  const titleEl = document.createElement('div');
  titleEl.className = 'habit-detail-section-title';
  titleEl.style.marginBottom = '16px';
  titleEl.textContent = 'Goals';
  wrap.appendChild(titleEl);
  const all = [];
  [{ k: todayKey(), label: 'Today' }, { k: tomorrowKey(), label: 'Tomorrow' }].forEach(({ k, label }) => {
    (storeGet(k) || []).filter(g => g.area === name).forEach(g => all.push({ g, label }));
  });
  if (all.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'area-detail-empty';
    empty.textContent = 'No goals assigned to this area yet.';
    wrap.appendChild(empty);
    return;
  }
  all.forEach(({ g, label }) => {
    const row = document.createElement('div');
    row.className = 'area-detail-goal-row';
    const cb = document.createElement('div');
    cb.className = 'area-detail-goal-cb' + (g.done ? ' done' : '');
    const txt = document.createElement('span');
    txt.className = 'area-detail-goal-text' + (g.done ? ' done' : '');
    txt.textContent = g.text;
    const key = document.createElement('span');
    key.className = 'area-detail-goal-key';
    key.textContent = label;
    row.appendChild(cb); row.appendChild(txt); row.appendChild(key);
    wrap.appendChild(row);
  });
}

function renderAreaHabits() {
  const name = _currentAreaName;
  const wrap = document.getElementById('areaDetailHabits');
  wrap.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'habit-detail-section-title';
  title.style.marginBottom = '16px';
  title.textContent = 'Habits';
  wrap.appendChild(title);

  const today = habitDateStr(0);
  const todayLog = getHabitLog(today);
  const habits = getHabits().filter(h => !h.archived && h.area === name);

  if (habits.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'area-detail-empty';
    empty.textContent = 'No habits assigned to this area yet.';
    wrap.appendChild(empty);
    return;
  }

  habits.forEach(h => {
    const row = document.createElement('div');
    row.className = 'area-detail-goal-row';
    const cb = document.createElement('div');
    const done = todayLog.includes(h.id);
    cb.className = 'area-detail-goal-cb' + (done ? ' done' : '');
    const txt = document.createElement('span');
    txt.className = 'area-detail-goal-text' + (done ? ' done' : '');
    txt.textContent = h.name;
    row.appendChild(cb);
    row.appendChild(txt);
    wrap.appendChild(row);
  });
}

function renderAreaNotes() {
  const name = _currentAreaName;
  const notes = getAreaNotes(name);
  const wrap = document.getElementById('areaNotesEntries');
  wrap.innerHTML = '';
  if (notes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'area-detail-empty';
    empty.textContent = 'No notes yet.';
    wrap.appendChild(empty);
    return;
  }
  [...notes].reverse().forEach(note => {
    const entry = document.createElement('div');
    entry.className = 'area-note-entry';
    const dateEl = document.createElement('div');
    dateEl.className = 'area-note-date';
    dateEl.textContent = new Date(note.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const body = document.createElement('div');
    body.className = 'area-note-body';
    body.textContent = note.text;
    entry.appendChild(dateEl); entry.appendChild(body);
    wrap.appendChild(entry);
  });
}

document.getElementById('areaDetailBack').addEventListener('click', closeAreaDetail);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('areaDetailPage').classList.contains('open')) closeAreaDetail();
});


// Add note
document.getElementById('areaNoteAdd').addEventListener('click', () => {
  const inp = document.getElementById('areaNoteInput');
  const text = inp.value.trim();
  if (!text || !_currentAreaName) return;
  const notes = getAreaNotes(_currentAreaName);
  notes.push({ text, createdAt: Date.now() });
  saveAreaNotes(_currentAreaName, notes);
  inp.value = '';
  renderAreaNotes();
});
document.getElementById('areaNoteInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) document.getElementById('areaNoteAdd').click();
});

document.getElementById('areaDetailDelete').addEventListener('click', () => {
  if (!_currentAreaName) return;
  if (!confirm(`Delete area "${_currentAreaName}"? Goals assigned to it will lose their area tag.`)) return;
  const name = _currentAreaName;
  const areas = getAreas();
  const idx = areas.findIndex(a => a.name === name);
  if (idx !== -1) { areas.splice(idx, 1); saveAreas(areas); }
  [todayKey(), tomorrowKey()].forEach(k => {
    const goals = storeGet(k) || [];
    let changed = false;
    goals.forEach(g => { if (g.area === name) { g.area = null; changed = true; } });
    if (changed) storeSet(k, goals);
  });
  closeAreaDetail();
});

function renderAreas() {
  const wrap = document.getElementById('areasListWrap');
  if (!wrap) return;
  const areas = getAreas();
  wrap.innerHTML = '';
  if (areas.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'area-empty-state';
    empty.textContent = 'No Areas Created';
    wrap.appendChild(empty);
    return;
  }
  const allGoalAreas = getAllGoalAreas();
  let _areaDragFrom = null;

  areas.forEach((area, idx) => {
    const count = allGoalAreas.filter(a => a === area.name).length;
    const card = document.createElement('div');
    card.className = 'area-card';
    card.dataset.idx = idx;
    card.draggable = true;
    card.style.borderColor = area.color + 'BF';

    card.addEventListener('click', () => openAreaDetail(area.name));

    card.addEventListener('dragstart', e => {
      _areaDragFrom = idx;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      wrap.querySelectorAll('.area-card').forEach(c => c.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      wrap.querySelectorAll('.area-card').forEach(c => c.classList.remove('drag-over'));
      if (idx !== _areaDragFrom) card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', e => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (_areaDragFrom === null || _areaDragFrom === idx) return;
      const areas = getAreas();
      const [moved] = areas.splice(_areaDragFrom, 1);
      areas.splice(idx, 0, moved);
      saveAreas(areas);
      _areaDragFrom = null;
      renderAreas();
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'area-card-name';
    nameEl.textContent = area.name;
    card.appendChild(nameEl);

    const countEl = document.createElement('span');
    countEl.className = 'area-card-count';
    countEl.textContent = count === 1 ? '1 task' : `${count} tasks`;
    card.appendChild(countEl);

    wrap.appendChild(card);
  });
}

// ── Area creation modal ──
// Set in openAreaCreateModal() before the modal is shown; AREA_COLORS lives in
// main.js which loads after this file, so don't reference it at parse time.
let _areaCreateColor = null;

function openAreaCreateModal(prefill) {
  const modal = document.getElementById('areaCreateModal');
  const nameInp = document.getElementById('areaCreateName');
  nameInp.value = prefill || '';

  const usedColors = new Set(getAreas().map(a => a.color));
  const firstAvailable = AREA_COLORS.find(c => !usedColors.has(c)) || AREA_COLORS[0];
  _areaCreateColor = firstAvailable;

  const colorsWrap = document.getElementById('areaCreateColors');
  colorsWrap.innerHTML = '';
  AREA_COLORS.forEach(c => {
    const taken = usedColors.has(c);
    const sw = document.createElement('div');
    sw.className = 'area-color-swatch' + (c === _areaCreateColor ? ' selected' : '') + (taken ? ' taken' : '');
    sw.style.background = c;
    if (taken) {
      sw.title = 'Already in use';
    } else {
      sw.addEventListener('click', () => {
        _areaCreateColor = c;
        colorsWrap.querySelectorAll('.area-color-swatch').forEach(s => s.classList.remove('selected'));
        sw.classList.add('selected');
      });
    }
    colorsWrap.appendChild(sw);
  });

  modal.style.display = 'flex';
  setTimeout(() => nameInp.focus(), 50);
}

function closeAreaCreateModal() {
  document.getElementById('areaCreateModal').style.display = 'none';
  document.getElementById('areaCreateError').style.display = 'none';
}

document.getElementById('areaCreateCancel').addEventListener('click', closeAreaCreateModal);
document.getElementById('areaCreateModal').addEventListener('click', e => {
  if (e.target === document.getElementById('areaCreateModal')) closeAreaCreateModal();
});

document.getElementById('areaCreateSave').addEventListener('click', () => {
  const name = document.getElementById('areaCreateName').value.trim();
  const errEl = document.getElementById('areaCreateError');
  if (!name) return;
  const areas = getAreas();
  const duplicate = areas.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    errEl.textContent = 'Project already exists';
    errEl.style.display = 'block';
    return;
  }
  areas.push({ name, color: _areaCreateColor });
  saveAreas(areas);
  closeAreaCreateModal();
  renderAreas();
  openAreaDetail(name);
});

document.getElementById('areaCreateName').addEventListener('input', () => {
  const errEl = document.getElementById('areaCreateError');
  errEl.style.display = 'none';
});

document.getElementById('areaCreateName').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('areaCreateSave').click();
  if (e.key === 'Escape') closeAreaCreateModal();
});

document.getElementById('areaAddBtn').addEventListener('click', () => openAreaCreateModal(''));

// re-render areas when the tab is opened
document.querySelectorAll('.tab-btn').forEach(btn => {
  if (btn.dataset.tab === 'areas') btn.addEventListener('click', renderAreas);
});
