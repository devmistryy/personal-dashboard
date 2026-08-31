// ══════════════════════════════════════════════════════════════════════════
//  main.js — core + page shell + bootstrap.
//
//  Load order (see index.html): todo.js, habits.js, jobs.js, areas.js, then
//  THIS FILE LAST. Feature files only declare functions and attach listeners;
//  main.js holds every bare top-level call (the "Bootstrap" section at the
//  bottom), which is why it must load after the others. Do not add top-level
//  invocations to the feature files.
// ══════════════════════════════════════════════════════════════════════════

const ANTHROPIC_API_KEY = '';
const WAKE_HOUR  = 8;
const SLEEP_HOUR = 24;

// ── Supabase ──
const SUPABASE_URL = 'https://tlqjmlocxxsdlxseumxw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRscWptbG9jeHhzZGx4c2V1bXh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5NzQzNTEsImV4cCI6MjA5NDU1MDM1MX0.AQ-MSRnfCCj-2AghxHZUh8iDtw_8yHYrCiqdSowD4F0';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Local test-user mode (no database) ──
// Sign in with email "test@local" (any password) to use a purely local
// account. All data lives in localStorage on this browser only.
const LOCAL_TEST_EMAIL = 'test@local';
const LOCAL_STORE_KEY  = 'dashboard_local_v1';
const LOCAL_FLAG_KEY   = 'dashboard_local_mode';
let LOCAL_MODE = false;

function _saveLocal() {
  try { localStorage.setItem(LOCAL_STORE_KEY, JSON.stringify(MEM)); }
  catch (e) { console.error('[local] save failed:', e); }
}
function _loadLocal() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(LOCAL_STORE_KEY) || '{}'); }
  catch (e) { console.error('[local] load failed:', e); }
  if (!data || Object.keys(data).length === 0) data = _seedLocalData();
  Object.keys(MEM).forEach(k => delete MEM[k]);
  Object.assign(MEM, data);
  _saveLocal();
}
function _seedLocalData() {
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  const h1 = 'h_' + Math.random().toString(36).slice(2, 10);
  const h2 = 'h_' + Math.random().toString(36).slice(2, 10);
  return {
    'areas:list': [
      { name: 'Health', color: '#52C97A' },
      { name: 'Work',   color: '#4A9EFF' },
    ],
    'habits:list': [
      { id: h1, name: 'Read 20 minutes', startDate: today, endDate: null, archived: false, archivedAt: null, area: 'Health' },
      { id: h2, name: 'Morning walk',    startDate: today, endDate: null, archived: false, archivedAt: null, area: 'Health' },
    ],
    ['habits:log:' + today]: [h1],
    ['goals:' + today]: [
      { text: 'Try out the local test account', done: true,  doneAt: new Date().toISOString(), queued: false },
      { text: 'Add my own goal',                done: false, doneAt: null, queued: false },
    ],
    'goal_streak_v1': { count: 0, lastProcessedDate: null },
    'jobs:list': [
      { id: 'j_' + Math.random().toString(36).slice(2, 10), company: 'Example Corp', platform: 'LinkedIn', dateApplied: today, status: 'Applied', locationType: 'Remote', locationCity: '' },
    ],
  };
}

// ── In-memory store (synced from/to Supabase) ──
const MEM = {};

function storeGet(key) { return MEM.hasOwnProperty(key) ? MEM[key] : null; }
const AREA_COLORS = ['#E24B4A','#EF9F27','#F5D558','#52C97A','#30D6C0','#4A9EFF','#A78BFA','#E879A9','#FF8C5A','#94A3B8'];
function getAreas() {
  const raw = MEM['areas:list'] || [];
  return raw.map(a => typeof a === 'string' ? { name: a, color: AREA_COLORS[0] } : a);
}
function saveAreas(areas) { MEM['areas:list'] = areas; }
function storeSet(key, value) {
  MEM[key] = value;
  if (key.startsWith('goals:')) {
    window.dispatchEvent(new CustomEvent('goals-changed'));
    _syncGoals(key.slice(6), value);
  } else if (key === 'goal_streak_v1') {
    _syncSetting('goal_streak_v1', value);
  }
}
function storeDelete(key) {
  delete MEM[key];
  if (key.startsWith('goals:')) _syncGoals(key.slice(6), []);
}
function storeListKeys(prefix) {
  return Object.keys(MEM).filter(k => k.startsWith(prefix));
}

// ── Date helpers ──
function _localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function getActiveDateString() {
  const now = new Date();
  if (now.getHours() < 6) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return _localDateStr(d);
  }
  return _localDateStr(now);
}

function getTomorrowDateString() {
  const now = new Date();
  if (now.getHours() < 6) {
    return _localDateStr(now);
  }
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  return _localDateStr(d);
}

function formatDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()];
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()];
  return `${wd}, ${mo} ${d}`;
}

const todayKey    = () => 'goals:' + getActiveDateString();
const tomorrowKey = () => 'goals:' + getTomorrowDateString();


// ── Ticker ──
let tickerItems = [];
let cycleIdx = 0;
let tickerInterval = null;
let tickerLeaveTimer = null;

function buildTickerItems() {
  const goals = storeGet(todayKey()) || [];
  const total = goals.length;
  const done  = goals.filter(g => g.done).length;
  const meta  = `${done}/${total}`;
  document.getElementById('goalTickerMeta').textContent = meta;
  if (total === 0) {
    return [{ status: 'empty', text: 'No goals set for today — add one to get rolling.' }];
  }
  if (done === total) {
    return [{ status: 'done', text: '✓ All goals done — solid day.' }];
  }
  return goals.filter(g => !g.done).map(g => ({ status: 'pending', text: g.text }));
}

function glyphFor(status) {
  if (status === 'done') return '✓';
  if (status === 'pending') return '○';
  return '·';
}

function tick(first) {
  tickerItems = buildTickerItems();
  if (tickerItems.length === 0) return;
  const item = tickerItems[cycleIdx % tickerItems.length];
  cycleIdx = (cycleIdx + 1) % tickerItems.length;

  const stage = document.getElementById('goalTickerStage');
  const existingRows = [...stage.querySelectorAll('.goal-ticker-row')];

  // Drop any leftover rows from an interrupted transition, keeping only the
  // most recent one to animate out.
  if (tickerLeaveTimer) { clearTimeout(tickerLeaveTimer); tickerLeaveTimer = null; }
  const currentRow = existingRows.pop() || null;
  existingRows.forEach(r => r.remove());

  const newRow = document.createElement('div');
  newRow.className = 'goal-ticker-row';
  newRow.innerHTML = `<span class="goal-ticker-status" data-status="${item.status}">${glyphFor(item.status)}</span><span class="goal-ticker-text">${item.text}</span>`;

  if (currentRow && !first) {
    currentRow.classList.remove('is-entering');
    currentRow.classList.add('is-leaving');
    newRow.classList.add('is-entering');
    stage.appendChild(newRow);
    tickerLeaveTimer = setTimeout(() => { currentRow.remove(); tickerLeaveTimer = null; }, 460);
  } else {
    if (currentRow) currentRow.remove();
    stage.appendChild(newRow);
  }
}

function startTicker() {
  tick(true);
  if (tickerInterval) clearInterval(tickerInterval);
  tickerInterval = setInterval(() => tick(false), 5000);
}

window.addEventListener('goals-changed', () => {
  cycleIdx = 0;
  tick(false);
  // Re-space the auto-advance so it doesn't fire right on top of this update.
  if (tickerInterval) {
    clearInterval(tickerInterval);
    tickerInterval = setInterval(() => tick(false), 5000);
  }
});

// ── Day Ring ──
const SUN_PALETTE = [
  [255,216,158],[255,205,121],[255,227,143],[255,183,106],
  [255,149,89],[243,111,79],[226,93,122],[123,91,176],[47,58,102]
];

function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0]-a[0])*t),
    Math.round(a[1] + (b[1]-a[1])*t),
    Math.round(a[2] + (b[2]-a[2])*t)
  ];
}

function sunColor(pct) {
  const n = SUN_PALETTE.length - 1;
  const pos = pct / 100 * n;
  const i = Math.min(Math.floor(pos), n - 1);
  const [r,g,b] = lerpColor(SUN_PALETTE[i], SUN_PALETTE[i+1], pos - i);
  return `rgb(${r},${g},${b})`;
}

function fmtHM(hours) {
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function fmtClock(date) {
  let h = date.getHours();
  const m = date.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function updateDayBar() {
  const now = new Date();
  const C = 2 * Math.PI * 52;
  const ring  = document.getElementById('ringFill');
  const pctEl = document.getElementById('ringPct');
  const phaseEl = document.getElementById('ringPhase');
  const clockEl = document.getElementById('ringClock');
  const statusEl = document.getElementById('ringStatus');
  const remainEl = document.getElementById('ringRemain');

  ring.style.strokeDasharray = C;
  clockEl.textContent = fmtClock(now);

  const h = now.getHours() + now.getMinutes()/60 + now.getSeconds()/3600;

  if (h < WAKE_HOUR) {
    ring.style.strokeDashoffset = C;
    ring.style.stroke = '#4D4B47';
    pctEl.textContent = '—';
    phaseEl.textContent = 'SLEEPING';
    statusEl.textContent = '😴 Still sleeping';
    const until = WAKE_HOUR - h;
    remainEl.textContent = `${fmtHM(until)} until wake-up`;
  } else if (h < SLEEP_HOUR) {
    const pct = (h - WAKE_HOUR) / (SLEEP_HOUR - WAKE_HOUR) * 100;
    ring.style.strokeDashoffset = C * (1 - pct/100);
    ring.style.stroke = '#4A9EFF';
    pctEl.textContent = Math.round(pct) + '%';
    const left = SLEEP_HOUR - h;
    remainEl.textContent = `${fmtHM(left)} awake time left`;
    if (pct < 25) { phaseEl.textContent='MORNING'; statusEl.textContent='☀️ Morning — fresh start'; }
    else if (pct < 50) { phaseEl.textContent='MIDDAY'; statusEl.textContent='⚡ Midday — keep moving'; }
    else if (pct < 75) { phaseEl.textContent='AFTERNOON'; statusEl.textContent='🔥 Afternoon — push it'; }
    else if (pct < 90) { phaseEl.textContent='EVENING'; statusEl.textContent='⏳ Evening — wrap up'; }
    else { phaseEl.textContent='BEDTIME'; statusEl.textContent='🌙 Bedtime soon'; }
  } else {
    ring.style.strokeDashoffset = 0;
    ring.style.stroke = '#E25D7A';
    pctEl.textContent = '100%';
    phaseEl.textContent = 'PAST BEDTIME';
    statusEl.textContent = '⚠️ Past bedtime';
    remainEl.textContent = 'Sleep!';
  }
}


// ── Shared area pill + dropdown ──
function buildAreaPill(currentArea, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'goal-area-wrap';

  const areas = getAreas();
  const areaObj = areas.find(a => a.name === currentArea);
  const hasArea = !!currentArea && !!areaObj;

  const pill = document.createElement('span');
  pill.className = 'goal-area-pill' + (hasArea ? '' : ' is-empty');
  if (hasArea) {
    pill.textContent = currentArea;
    pill.style.background = areaObj.color + 'BF';
    pill.style.color = '#fff';
  } else {
    pill.textContent = '+ area';
  }
  wrap.appendChild(pill);

  pill.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.goal-area-dd').forEach(d => d.remove());

    const freshAreas = getAreas();
    const dd = document.createElement('div');
    dd.className = 'goal-area-dd';

    if (freshAreas.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'goal-area-dd-empty';
      empty.textContent = 'No Areas Created';
      dd.appendChild(empty);
    } else {
      freshAreas.forEach(a => {
        const item = document.createElement('div');
        item.className = 'goal-area-dd-item';
        const dpill = document.createElement('span');
        dpill.className = 'goal-area-pill';
        dpill.textContent = a.name;
        dpill.style.background = a.color + 'BF';
        dpill.style.color = '#fff';
        if (currentArea === a.name) dpill.style.outline = '2px solid #fff';
        item.appendChild(dpill);
        item.addEventListener('click', ev => {
          ev.stopPropagation();
          const newArea = currentArea === a.name ? null : a.name;
          onChange(newArea);
          currentArea = newArea;
          dd.remove();
        });
        dd.appendChild(item);
      });
    }

    wrap.appendChild(dd);
    const closeOnOutside = ev => {
      if (!dd.contains(ev.target) && ev.target !== pill) {
        dd.remove();
        document.removeEventListener('click', closeOnOutside);
      }
    };
    setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
  });

  return wrap;
}


// ── Supabase sync (fire-and-forget) ──
async function _uid() { return (await sb.auth.getSession()).data.session?.user?.id; }

async function _syncHabits(habits) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _uid(); if (!uid) return;
  if (habits.length) {
    const { error } = await sb.from('habits').upsert(habits.map(h => ({
      id: h.id, user_id: uid, name: h.name,
      start_date: h.startDate || null, end_date: h.endDate || null,
      archived: h.archived || false, archived_at: h.archivedAt || null,
    })), { onConflict: 'id' });
    if (error) console.error('[sync] habits upsert failed:', error);
  }
  const { data: existing = [], error: selErr } = await sb.from('habits').select('id').eq('user_id', uid);
  if (selErr) { console.error('[sync] habits select failed:', selErr); return; }
  const currentIds = new Set(habits.map(h => h.id));
  const toDelete = (existing || []).filter(r => !currentIds.has(r.id)).map(r => r.id);
  if (toDelete.length) {
    const { error: delErr } = await sb.from('habits').delete().eq('user_id', uid).in('id', toDelete);
    if (delErr) console.error('[sync] habits delete failed:', delErr);
  }
}

async function _syncHabitLog(dateStr, ids) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _uid(); if (!uid) return;
  const { error: delErr } = await sb.from('habit_logs').delete().eq('user_id', uid).eq('date', dateStr);
  if (delErr) { console.error('[sync] habit_logs delete failed:', delErr); return; }
  if (ids.length) {
    const { error } = await sb.from('habit_logs').insert(ids.map(id => ({ user_id: uid, habit_id: id, date: dateStr })));
    if (error) console.error('[sync] habit_logs insert failed:', error);
  }
}

async function _syncGoals(dateStr, goals) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _uid(); if (!uid) return;
  const { error: delErr } = await sb.from('goals').delete().eq('user_id', uid).eq('date', dateStr);
  if (delErr) { console.error('[sync] goals delete failed:', delErr); return; }
  if (goals.length) {
    const { error } = await sb.from('goals').insert(goals.map(g => ({
      user_id: uid, date: dateStr, text: g.text,
      done: g.done || false, done_at: g.doneAt || null, queued: g.queued || false,
    })));
    if (error) console.error('[sync] goals insert failed:', error);
  }
}

async function _syncSetting(key, value) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _uid(); if (!uid) return;
  const { error } = await sb.from('settings').upsert({ user_id: uid, key, value }, { onConflict: 'user_id,key' });
  if (error) console.error('[sync] settings upsert failed:', error);
}

async function _syncHabitNotes(habitId, notes) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _uid(); if (!uid) return;
  const { error: delErr } = await sb.from('habit_notes').delete().eq('user_id', uid).eq('habit_id', habitId);
  if (delErr) { console.error('[sync] habit_notes delete failed:', delErr); return; }
  if (notes.length) {
    const { error } = await sb.from('habit_notes').insert(notes.map(n => ({
      user_id: uid, habit_id: habitId, text: n.text,
      created_at: new Date(n.createdAt).toISOString(),
    })));
    if (error) console.error('[sync] habit_notes insert failed:', error);
  }
}

// ── Load all data from Supabase into MEM (parallel) ──
async function loadFromSupabase() {
  if (LOCAL_MODE) return _loadLocal();
  const uid = await _uid(); if (!uid) return;

  const from = new Date(); from.setDate(from.getDate() - 90);
  const to   = new Date(); to.setDate(to.getDate() + 1);
  const fromStr = from.toISOString().slice(0,10);
  const toStr   = to.toISOString().slice(0,10);

  const results = await Promise.all([
    sb.from('habits').select('*').eq('user_id', uid).order('created_at'),
    sb.from('habit_logs').select('*').eq('user_id', uid),
    sb.from('goals').select('*').eq('user_id', uid).gte('date', fromStr).lte('date', toStr).order('id'),
    sb.from('settings').select('value').eq('user_id', uid).eq('key', 'goal_streak_v1').maybeSingle(),
    sb.from('job_applications').select('*').eq('user_id', uid).order('created_at', { ascending: false }),
    sb.from('habit_notes').select('*').eq('user_id', uid).order('created_at'),
  ]);

  results.forEach((r, i) => { if (r.error) console.error('Query', i, 'failed:', r.error); });

  const habits  = results[0].data || [];
  const logs    = results[1].data || [];
  const goals   = results[2].data || [];
  const setting = results[3].data;
  const jobs    = results[4].data || [];
  const hNotes  = results[5].data || [];

  MEM['habits:list'] = habits.map(h => ({
    id: h.id, name: h.name, startDate: h.start_date || h.created_at?.slice(0,10), endDate: h.end_date,
    archived: h.archived, archivedAt: h.archived_at,
  }));

  logs.forEach(l => {
    const k = 'habits:log:' + l.date;
    if (!MEM[k]) MEM[k] = [];
    MEM[k].push(l.habit_id);
  });

  goals.forEach(g => {
    const k = 'goals:' + g.date;
    if (!MEM[k]) MEM[k] = [];
    MEM[k].push({ text: g.text, done: g.done, doneAt: g.done_at, queued: g.queued });
  });

  if (setting) MEM['goal_streak_v1'] = setting.value;

  MEM['jobs:list'] = jobs.map(j => ({
    id: j.id, company: j.company, platform: j.platform || '',
    dateApplied: j.date_applied || '', status: j.status || 'Applied',
    locationType: j.location_type || '', locationCity: j.location_city || '',
  }));

  hNotes.forEach(n => {
    const k = 'habit_notes:' + n.habit_id;
    (MEM[k] = MEM[k] || []).push({ id: n.id, text: n.text, createdAt: Date.parse(n.created_at) });
  });
}


// ── Tab switching ──
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// Console helpers for the local test account:
//   exitLocalMode()  – sign out of the local account (keeps saved data)
//   resetLocalData() – wipe the local account's data and reseed samples
window.exitLocalMode = function () {
  localStorage.removeItem(LOCAL_FLAG_KEY);
  location.reload();
};
window.resetLocalData = function () {
  localStorage.removeItem(LOCAL_STORE_KEY);
  location.reload();
};

function _enterApp() {
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('signOutBtn').style.display = '';
  rollover(); checkStreak(); renderHabits(); loadToday(); loadTomorrow(); renderStreak(); renderJobs();
  tick(true); // refresh the goal ticker immediately with the loaded data
}

async function signOut() {
  try { if (!LOCAL_MODE) await sb.auth.signOut(); } catch (e) { console.error('sign out error:', e); }
  localStorage.removeItem(LOCAL_FLAG_KEY);
  location.reload();
}
document.getElementById('signOutBtn').addEventListener('click', signOut);

async function initApp() {
  if (localStorage.getItem(LOCAL_FLAG_KEY)) {
    LOCAL_MODE = true;
    await loadFromSupabase();
    _enterApp();
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await loadFromSupabase();
    _enterApp();
  }
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const pw    = document.getElementById('loginPassword').value;
  const btn   = document.getElementById('loginBtn');
  const err   = document.getElementById('loginError');
  btn.textContent = 'Signing in…'; btn.disabled = true; err.style.display = 'none';

  // Local test-user mode — no database, data stays in this browser.
  if (email.toLowerCase() === LOCAL_TEST_EMAIL) {
    LOCAL_MODE = true;
    localStorage.setItem(LOCAL_FLAG_KEY, '1');
    btn.textContent = 'Loading local data…';
    try {
      await loadFromSupabase();
      _enterApp();
    } catch (e) {
      err.textContent = 'Load failed: ' + e.message;
      err.style.display = 'block';
      btn.textContent = 'Sign In'; btn.disabled = false;
      console.error('local load error:', e);
    }
    return;
  }

  const { error } = await sb.auth.signInWithPassword({ email, password: pw });
  if (error) {
    err.textContent = error.message; err.style.display = 'block';
    btn.textContent = 'Sign In'; btn.disabled = false;
  } else {
    btn.textContent = 'Loading your data…';
    try {
      await loadFromSupabase();
      _enterApp();
    } catch(e) {
      err.textContent = 'Load failed: ' + e.message;
      err.style.display = 'block';
      btn.textContent = 'Sign In'; btn.disabled = false;
      console.error('loadFromSupabase error:', e);
    }
  }
});

document.getElementById('loginPassword').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

// ── Bootstrap — runs after every file above has defined its functions.
//    The only bare top-level calls in the codebase live here. Keep last. ──
rollover();
checkStreak();

makeAddHandlers(
  document.getElementById('goalInput'),
  document.getElementById('goalAddBtn'),
  document.getElementById('goalPolishBtn'),
  todayKey,
  document.getElementById('polishStatus'),
  loadToday
);

makeAddHandlers(
  document.getElementById('tomorrowInput'),
  document.getElementById('tomorrowAddBtn'),
  document.getElementById('tomorrowPolishBtn'),
  tomorrowKey,
  document.getElementById('tomorrowStatus'),
  loadTomorrow
);

loadToday();
loadTomorrow();
renderStreak();

updateDayBar();
setInterval(updateDayBar, 60 * 1000);

startTicker();
renderAreas();
initApp();
