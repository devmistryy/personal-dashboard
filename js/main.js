// ══════════════════════════════════════════════════════════════════════════
//  main.js — core + page shell + bootstrap.
//
//  Load order (see index.html): todo.js, habits.js, jobs.js, areas.js, then
//  THIS FILE LAST. Feature files only declare functions and attach listeners;
//  main.js holds every bare top-level call (the "Bootstrap" section at the
//  bottom), which is why it must load after the others. Do not add top-level
//  invocations to the feature files.
// ══════════════════════════════════════════════════════════════════════════

const ANTHROPIC_API_KEY = '';           // task "Polish" (js/todo.js)
// Diet-tab "Import from screenshot" (js/diet.js) — OCR.space. 'helloworld' is the
// shared free test key (rate-limited); get your own free key (25k/month) at
// https://ocr.space/ocrapi/freekey and paste it here.
const OCR_SPACE_API_KEY = 'helloworld';
// Default until WHOOP overrides it with today's real wake time (js/whoop.js
// _whoopApplyWakeTime) — a `let` so that can happen.
let WAKE_HOUR  = 8;
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
  _migrateGoalKeys();
  _normalizeTasks();
  _saveLocal();
}

function _seedLocalCityCoverageFromUrl() {
  const url = new URL(location.href);
  if (url.searchParams.get('seedCityCoverage') !== '1') return;
  url.searchParams.delete('seedCityCoverage');
  history.replaceState(null, '', url);

  const jobs = (MEM['jobs:list'] || []).filter(job =>
    !job.sampleCityCoverage && !/\(Sample \d+\)$/.test(job.company));
  const regions = new Set(['Silicon Valley', 'Orange County', 'Research Triangle Park', 'Oʻahu']);
  const cities = [...new Set([
    ...techCities.map(city => city.name),
    ...techMetros.flatMap(metro => metro.includedAreas || []),
  ])].filter(city => !regions.has(city));
  const covered = new Set(jobs.flatMap(job => job.locationType === 'remote'
    ? [] : (job.locationCities || [])).map(city => city.toLowerCase()));
  const roles = ['Software Engineer', 'Frontend Engineer', 'Backend Engineer', 'Full Stack Engineer',
    'Data Engineer', 'Product Manager', 'UX Designer', 'DevOps Engineer'];
  cities.forEach((city, i) => {
    if (covered.has(city.toLowerCase())) return;
    const date = new Date();
    date.setDate(date.getDate() - (i % 45));
    const dateApplied = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')].join('-');
    jobs.push({
      id: _jobId(), company: `Sample Job - ${city}`, sampleCityCoverage: true,
      role: roles[i % roles.length], platform: 'Company Site',
      dateApplied, status: 'Applied', locationType: 'onsite', locationCities: [city],
    });
  });
  MEM['jobs:list'] = jobs;
  _saveLocal();
}

// One-time in-place rename of the pre-2026-09 "goal" storage keys to "task", for
// local (test@local) accounts whose whole MEM blob lives in localStorage. Real
// accounts re-fetch from Supabase each load, so they need nothing here.
function _migrateGoalKeys() {
  // Only the old date-keyed goal lists (goals:YYYY-MM-DD) — NOT goals:list, the
  // new Areas & Goals collection, which must survive this shim untouched.
  Object.keys(MEM).filter(k => /^goals:\d{4}-\d{2}-\d{2}$/.test(k)).forEach(k => {
    const n = 'tasks:' + k.slice(6);
    if (!MEM.hasOwnProperty(n)) MEM[n] = MEM[k];
    delete MEM[k];
  });
  [['goal_streak_v1', 'task_streak_v1'],
   ['goal_sort_v1', 'task_sort_v1'],
   ['goal_dismissed_v1', 'task_dismissed_v1']].forEach(([o, n]) => {
    if (MEM.hasOwnProperty(o) && !MEM.hasOwnProperty(n)) MEM[n] = MEM[o];
    delete MEM[o];
  });
  delete MEM['goal_rollover_v1'];
  // Drop leftovers from the removed step-linked-habits feature.
  (MEM['habits:list'] || []).forEach(h => {
    if (h) { delete h.autoGoal; delete h.autoSource; delete h.stepTarget; }
  });
  delete MEM['step_autocheck_v1'];
  delete MEM['step_ingest_token_v1'];
  delete MEM['step_counts_v1'];
  // Replaced by sunday_reset_removed_v1 (see applySundayReset).
  delete MEM['sunday_reset_log_v1'];
}

// Guarantee every stored task has a stable id + ISO createdAt. New tasks get
// these at creation; this backfills anything older (local blobs, pre-id rows).
function _normalizeTasks() {
  Object.keys(MEM).filter(k => k.startsWith('tasks:')).forEach(k => {
    (MEM[k] || []).forEach(g => {
      if (!g.id) g.id = _taskId();
      if (!g.createdAt) g.createdAt = new Date().toISOString();
    });
  });
}
function _seedLocalData() {
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  const dayAgo = n => { const x = new Date(d); x.setDate(x.getDate() - n);
    return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0') + '-' + String(x.getDate()).padStart(2,'0'); };
  const h1 = 'h_' + Math.random().toString(36).slice(2, 10);
  const h2 = 'h_' + Math.random().toString(36).slice(2, 10);
  const jobSeedId = 'j_' + Math.random().toString(36).slice(2, 10);
  return {
    'areas:list': [
      { name: 'Health', color: '#52C97A' },
      { name: 'Work',   color: '#4A9EFF' },
    ],
    'habit_sort_v1': 'custom',
    'habits:list': [
      { id: h1, name: 'Read 20 minutes', startDate: today, endDate: null, archived: false, archivedAt: null, area: 'Health', createdAt: new Date(Date.now() - 60000).toISOString() },
      { id: h2, name: 'Morning walk',    startDate: today, endDate: null, archived: false, archivedAt: null, area: 'Health', createdAt: new Date().toISOString() },
    ],
    ['habits:log:' + today]: [h1],
    ['tasks:' + today]: [
      { id: 'g_seed1', text: 'Try out the local test account', done: true,  doneAt: new Date().toISOString(), priority: 'Medium', area: null, createdAt: new Date(Date.now() - 3600000).toISOString() },
      { id: 'g_seed2', text: 'Add my own task',                done: false, priority: 'Medium', area: null, createdAt: new Date().toISOString() },
    ],
    'task_streak_v1': { count: 0, lastProcessedDate: null },
    'jobs:list': [
      { id: jobSeedId, company: 'Example Corp', role: 'Software Engineer', platform: 'LinkedIn', dateApplied: today, status: 'Applied', locationType: 'remote', locationCities: [] },
    ],
    'job_roles_v1': ['Software Engineer', 'Product Manager'],
    'job_sites_v1': ['linkedin', 'indeed'],
    'referrals:list': [
      { id: 'rf_seed1', name: 'Jordan (college friend)', jobId: jobSeedId, createdAt: new Date(Date.now() - 2 * 86400000).toISOString() },
      { id: 'rf_seed2', name: 'Sam Lee', jobId: null, createdAt: new Date().toISOString() },
    ],
    'goals:list': [
      { id: 'gl_seed1', title: 'Ship the dashboard v2', area: 'Work',   notes: 'Areas & Goals tab, then a weekly review.', done: false, doneAt: null, createdAt: new Date(Date.now() - 6 * 86400000).toISOString() },
      { id: 'gl_seed2', title: 'Run a 10k',             area: 'Health', notes: '', done: false, doneAt: null, createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
      { id: 'gl_seed3', title: 'Read 12 books this year', area: null,   notes: '', done: true,  doneAt: new Date(Date.now() - 86400000).toISOString(), createdAt: new Date(Date.now() - 20 * 86400000).toISOString() },
    ],
    'diet_healthy_v1': ['Eggs', 'Kiwi', 'Chicken', 'Spinach', 'Lentils'],
    'diet_unhealthy_v1': ['Soda', 'Fries'],
    'diet_entries_v1': [
      { id: 'd_seed1', date: today, time: '13:00', desc: 'Dal, rice and salad', calories: 620,
        protein: 24, carbs: 82, fats: 14,
        category: 'Homecooked Meal', healthyIngredients: ['Lentils', 'Spinach'], unhealthyFoods: [] },
    ],
    'mobility_exercises_v1': [
      { id: 's_seed1', createdAt: Date.now() - 32 * 86400000, name: 'Deep squat hold',
        session: 'morning', measure: 'hold', sets: 1, holdSeconds: 40, reps: null, frequency: 7 },
      { id: 's_seed2', createdAt: Date.now() - 30000, name: 'Couch stretch',
        session: 'night', measure: 'hold', sets: 2, holdSeconds: 45, reps: null, frequency: 4 },
      { id: 's_seed3', createdAt: Date.now() - 28 * 86400000, name: 'Side plank',
        session: 'morning', measure: 'hold', sets: 2, holdSeconds: 20, reps: null, frequency: 3 },
      { id: 's_seed4', createdAt: Date.now() - 10000, name: 'Quadruped thoracic rotation',
        session: 'night', measure: 'reps', sets: 1, holdSeconds: null, reps: 10, frequency: 2 },
    ],
    'mobility_progress:s_seed1': [
      { id: 'mp_s1a', date: dayAgo(28), sets: 1, measure: 'hold', holdSeconds: 40, reps: null },
      { id: 'mp_s1b', date: dayAgo(21), sets: 1, measure: 'hold', holdSeconds: 45, reps: null },
      { id: 'mp_s1c', date: dayAgo(14), sets: 1, measure: 'hold', holdSeconds: 50, reps: null },
      { id: 'mp_s1d', date: dayAgo(7),  sets: 1, measure: 'hold', holdSeconds: 55, reps: null },
      { id: 'mp_s1e', date: dayAgo(1),  sets: 1, measure: 'hold', holdSeconds: 60, reps: null },
    ],
    'mobility_progress:s_seed3': [
      { id: 'mp_s3a', date: dayAgo(24), sets: 2, measure: 'hold', holdSeconds: 20, reps: null },
      { id: 'mp_s3b', date: dayAgo(17), sets: 3, measure: 'hold', holdSeconds: 20, reps: null },
      { id: 'mp_s3c', date: dayAgo(10), sets: 3, measure: 'hold', holdSeconds: 25, reps: null },
      { id: 'mp_s3d', date: dayAgo(3),  sets: 3, measure: 'hold', holdSeconds: 30, reps: null },
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
function saveAreas(areas) { MEM['areas:list'] = areas; _syncSetting('areas:list', areas); }

function storeSet(key, value) {
  MEM[key] = value;
  if (key.startsWith('tasks:')) {
    window.dispatchEvent(new CustomEvent('tasks-changed'));
    _syncTasks(key.slice(6), value);
  } else if (key === 'task_streak_v1' || key === 'task_dismissed_v1') {
    _syncSetting(key, value);
  }
}
function storeDelete(key) {
  delete MEM[key];
  if (key.startsWith('tasks:')) _syncTasks(key.slice(6), []);
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

const todayKey    = () => 'tasks:' + getActiveDateString();
const tomorrowKey = () => 'tasks:' + getTomorrowDateString();


// ── Ticker ──
let tickerItems = [];
let cycleIdx = 0;
let tickerInterval = null;
let tickerLeaveTimer = null;

function buildTickerItems() {
  const tasks = storeGet(todayKey()) || [];
  const total = tasks.length;
  const done  = tasks.filter(g => g.done).length;
  const meta  = `${done}/${total}`;
  document.getElementById('taskTickerMeta').textContent = meta;
  if (total === 0) {
    return [{ status: 'empty', text: 'No tasks set for today — add one to get rolling.' }];
  }
  if (done === total) {
    return [{ status: 'done', text: '✓ All tasks done — solid day.' }];
  }
  return tasks.filter(g => !g.done).map(g => ({ status: 'pending', text: g.text }));
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

  const stage = document.getElementById('taskTickerStage');
  const existingRows = [...stage.querySelectorAll('.task-ticker-row')];

  // Drop any leftover rows from an interrupted transition, keeping only the
  // most recent one to animate out.
  if (tickerLeaveTimer) { clearTimeout(tickerLeaveTimer); tickerLeaveTimer = null; }
  const currentRow = existingRows.pop() || null;
  existingRows.forEach(r => r.remove());

  const newRow = document.createElement('div');
  newRow.className = 'task-ticker-row';
  newRow.innerHTML = `<span class="task-ticker-status" data-status="${item.status}">${glyphFor(item.status)}</span><span class="task-ticker-text">${item.text}</span>`;

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

window.addEventListener('tasks-changed', () => {
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

// Formats a decimal hour (e.g. 9.116, or 24 for midnight) as a clock string,
// for WAKE_HOUR/SLEEP_HOUR which aren't tied to "now".
function fmtHourDecimal(hDec) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMinutes(Math.round((hDec % 24) * 60));
  return fmtClock(d);
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

  const hoursEl = document.getElementById('ringHours');
  if (hoursEl) hoursEl.textContent = fmtHourDecimal(WAKE_HOUR) + ' – ' + fmtHourDecimal(SLEEP_HOUR);

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
  wrap.className = 'task-area-wrap';

  const areas = getAreas();
  const areaObj = areas.find(a => a.name === currentArea);
  const hasArea = !!currentArea && !!areaObj;

  const pill = document.createElement('span');
  pill.className = 'task-area-pill' + (hasArea ? '' : ' is-empty');
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
    document.querySelectorAll('.task-area-dd').forEach(d => d.remove());

    const freshAreas = getAreas();
    const dd = document.createElement('div');
    dd.className = 'task-area-dd';

    if (freshAreas.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'task-area-dd-empty';
      empty.textContent = 'No Areas Created';
      dd.appendChild(empty);
    } else {
      freshAreas.forEach(a => {
        const item = document.createElement('div');
        item.className = 'task-area-dd-item';
        const dpill = document.createElement('span');
        dpill.className = 'task-area-pill';
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

// Every _sync* function calls this instead of raw _uid(). A missing/expired
// session used to make `if (!uid) return;` exit silently — no _syncFailed
// call, unlike every other failure path in these functions — so the change
// looked saved (MEM was already updated) but never reached the database,
// with no warning until the next reload quietly reverted it.
async function _requireUid() {
  const uid = await _uid();
  if (!uid) _syncFailed('no active session — sign-in may have expired', new Error('missing uid'));
  return uid;
}

// Every _sync* function reports its failures here instead of to console.error
// alone. The writes are fire-and-forget, so a rejected one used to leave MEM and
// the database quietly diverged: the change looks saved, and the next reload
// reverts it with no explanation. The banner says so while the tab is still
// open, in time to redo the change or copy it out. Repeat failures (a whole day
// re-syncing, say) coalesce into one banner rather than stacking.
let _syncErrCount = 0, _syncErrTimer = null;

function _syncFailed(what, error) {
  if (error === undefined) console.error('[sync] ' + what);
  else console.error('[sync] ' + what + ':', error);
  if (LOCAL_MODE) return;                       // local mode never hits the network

  const el = document.getElementById('syncErrorBanner');
  if (!el) return;
  _syncErrCount++;
  el.textContent = _syncErrCount === 1
    ? "Couldn't save to the server — this change is only on this device. Reload to see what's actually stored."
    : `Couldn't save ${_syncErrCount} changes to the server — they're only on this device. Reload to see what's actually stored.`;
  el.hidden = false;
  clearTimeout(_syncErrTimer);
  _syncErrTimer = setTimeout(_dismissSyncError, 12000);
}

function _dismissSyncError() {
  const el = document.getElementById('syncErrorBanner');
  if (el) el.hidden = true;
  _syncErrCount = 0;
  clearTimeout(_syncErrTimer);
  _syncErrTimer = null;
}
document.getElementById('syncErrorBanner').addEventListener('click', _dismissSyncError);

// Wrap every _syncX function (from this file and every feature file loaded
// before it) to count in-flight calls, so signOut() can wait for pending
// writes to land instead of reloading mid-flight and silently cancelling
// whatever the user just changed. Relies on function-declaration hoisting —
// by the time this runs, every `_syncXxx` declared anywhere in this file is
// already bound, and every earlier-loaded file's has already executed.
let _pendingSyncs = 0;
Object.keys(window)
  .filter(k => /^_sync[A-Z]/.test(k) && k !== '_syncFailed' && typeof window[k] === 'function')
  .forEach(name => {
    const orig = window[name];
    window[name] = async function (...args) {
      _pendingSyncs++;
      try { return await orig.apply(this, args); }
      finally { _pendingSyncs--; }
    };
  });

async function _waitForPendingSyncs(maxMs = 3000) {
  const start = Date.now();
  while (_pendingSyncs > 0 && Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 50));
  }
}

// Re-tag every task carrying `oldName` in ONE server-side update. The day-scoped
// _syncTasks would need a full rewrite per date — up to 90 round trips for one
// rename — and could only reach days inside the load window, which is why area
// renames used to leave history rows pointing at a name that no longer resolves
// (their pill silently went blank). Pass null for `newArea` to clear the tag.
async function _syncTaskAreaRename(oldName, newArea) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  const { error } = await sb.from('tasks').update({ area: newArea })
    .eq('user_id', uid).eq('area', oldName);
  if (error) _syncFailed('task area re-tag failed', error);
}

async function _syncHabits(habits) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (habits.length) {
    const { error } = await sb.from('habits').upsert(habits.map((h, i) => ({
      id: h.id, user_id: uid, name: h.name,
      start_date: h.startDate || null, end_date: h.endDate || null,
      archived: h.archived || false, archived_at: h.archivedAt || null,
      sort_order: i, area: h.area || null, end_of_day: h.endOfDay || false,
      morning_routine: h.morningRoutine || false, night_routine: h.nightRoutine || false,
      runs: Array.isArray(h.runs) ? h.runs : [],
      track_type: h.trackType || 'checkbox', target: h.target || null,
    })), { onConflict: 'id' });
    if (error) _syncFailed('habits upsert failed', error);
  }
  const { data: existing = [], error: selErr } = await sb.from('habits').select('id').eq('user_id', uid);
  if (selErr) { _syncFailed('habits select failed', selErr); return; }
  const currentIds = new Set(habits.map(h => h.id));
  const toDelete = (existing || []).filter(r => !currentIds.has(r.id)).map(r => r.id);
  if (toDelete.length) {
    const { error: delErr } = await sb.from('habits').delete().eq('user_id', uid).in('id', toDelete);
    if (delErr) _syncFailed('habits delete failed', delErr);
  }
}

// Both of the day-scoped syncs below (habit_logs, tasks) write the current set
// FIRST and only then delete whatever else is left for that date. If the write
// fails — schema drift, a constraint, a dropped connection — we bail before
// deleting anything, so a failed sync can never leave the day emptier than it
// started. Worst case is a few duplicate rows until the next save, which the
// same "delete everything I didn't just write" step cleans up.

async function _syncHabitLog(dateStr, ids) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;

  if (ids.length) {
    const { error: insErr } = await sb.from('habit_logs').upsert(
      ids.map(id => ({ user_id: uid, habit_id: id, date: dateStr })),
      { onConflict: 'user_id,habit_id,date', ignoreDuplicates: true });
    if (insErr) { _syncFailed('habit_logs upsert failed (kept existing rows)', insErr); return; }
  }

  let del = sb.from('habit_logs').delete().eq('user_id', uid).eq('date', dateStr);
  if (ids.length) del = del.not('habit_id', 'in', `(${ids.map(i => `"${i}"`).join(',')})`);
  const { error: delErr } = await del;
  if (delErr) _syncFailed('habit_logs stale-delete failed', delErr);
}

async function _syncHabitVoids(dateStr, ids) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;

  if (ids.length) {
    const { error: insErr } = await sb.from('habit_voids').upsert(
      ids.map(id => ({ user_id: uid, habit_id: id, date: dateStr })),
      { onConflict: 'user_id,habit_id,date', ignoreDuplicates: true });
    if (insErr) { _syncFailed('habit_voids upsert failed (run master.sql?)', insErr); return; }
  }

  let del = sb.from('habit_voids').delete().eq('user_id', uid).eq('date', dateStr);
  if (ids.length) del = del.not('habit_id', 'in', `(${ids.map(i => `"${i}"`).join(',')})`);
  const { error: delErr } = await del;
  if (delErr) _syncFailed('habit_voids stale-delete failed', delErr);
}

// Unlike habit_logs/habit_voids (plain presence markers, upserted with
// ignoreDuplicates), a count row's whole point is its `count` column changing
// day over day, so this upsert must actually overwrite on conflict.
async function _syncHabitCounts(dateStr, counts) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  const ids = Object.keys(counts).filter(id => counts[id] > 0);

  if (ids.length) {
    const { error: insErr } = await sb.from('habit_counts').upsert(
      ids.map(id => ({ user_id: uid, habit_id: id, date: dateStr, count: counts[id] })),
      { onConflict: 'user_id,habit_id,date' });
    if (insErr) { _syncFailed('habit_counts upsert failed (run master.sql?)', insErr); return; }
  }

  let del = sb.from('habit_counts').delete().eq('user_id', uid).eq('date', dateStr);
  if (ids.length) del = del.not('habit_id', 'in', `(${ids.map(i => `"${i}"`).join(',')})`);
  const { error: delErr } = await del;
  if (delErr) _syncFailed('habit_counts stale-delete failed', delErr);
}

// Day-scoped task sync. `_syncTasksNow` writes insert-then-stale-delete, so two
// of them running concurrently for the SAME date destroy each other's rows: the
// first call's delete ("everything on this date that isn't a row I just
// inserted") wipes the rows the second call inserted. That happened on every
// load — rollover() and applySundayReset() both write today's list back to back
// — and silently dropped whichever set lost the race, which is why the injected
// Sunday Reset tasks never survived a reload.
//
// So writes are queued per date, and a queued write that's been superseded
// before it starts is dropped: only the newest snapshot for a date is sent.
const _taskSyncChain   = new Map();   // date → tail of that date's write chain
const _taskSyncPending = new Map();   // date → newest snapshot not yet written

function _syncTasks(dateStr, tasks) {
  if (LOCAL_MODE) return _saveLocal();
  // Snapshot: the caller's array keeps being mutated while this write waits.
  _taskSyncPending.set(dateStr, tasks.map(g => Object.assign({}, g)));

  const run = (_taskSyncChain.get(dateStr) || Promise.resolve())
    .catch(() => {})
    .then(() => {
      const payload = _taskSyncPending.get(dateStr);
      if (payload === undefined) return;      // a later call already wrote it
      _taskSyncPending.delete(dateStr);
      return _syncTasksNow(dateStr, payload);
    });

  _taskSyncChain.set(dateStr, run);
  // .catch here too: callers don't await, so a rejected write would otherwise
  // surface as an unhandled rejection and leave a dead tail in the chain map.
  run.catch(e => _syncFailed('tasks write failed', e))
     .then(() => { if (_taskSyncChain.get(dateStr) === run) _taskSyncChain.delete(dateStr); });
  return run;
}

async function _syncTasksNow(dateStr, tasks) {
  const uid = await _requireUid(); if (!uid) return;

  if (!tasks.length) {
    const { error } = await sb.from('tasks').delete().eq('user_id', uid).eq('date', dateStr);
    if (error) _syncFailed('tasks clear failed', error);
    return;
  }

  // Insert the current set first, asking for the new rows' ids back.
  const { data: inserted, error: insErr } = await sb.from('tasks').insert(tasks.map(g => ({
    user_id: uid, date: dateStr, text: g.text,
    done: g.done || false, done_at: g.doneAt || null,
    area: g.area || null, priority: g.priority || 'Medium',
    tid: g.id || null, created_at: g.createdAt || null,
  }))).select('id');
  if (insErr) { _syncFailed('tasks insert failed (kept existing rows)', insErr); return; }

  const keepIds = (inserted || []).map(r => r.id);
  if (!keepIds.length) { _syncFailed('tasks insert returned no ids — skipping stale-delete'); return; }

  // Drop the pre-insert copies (and any leftover duplicates) for this date.
  const { error: delErr } = await sb.from('tasks').delete()
    .eq('user_id', uid).eq('date', dateStr)
    .not('id', 'in', `(${keepIds.join(',')})`);
  if (delErr) _syncFailed('tasks stale-delete failed (duplicates clear on next save)', delErr);
}

async function _syncSetting(key, value) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  const { error } = await sb.from('settings').upsert({ user_id: uid, key, value }, { onConflict: 'user_id,key' });
  if (error) _syncFailed('settings upsert failed', error);
}

// Deleting a habit has to take its check-ins, voids and notes with it. Those
// tables are keyed by habit_id, so one delete each clears them server-side —
// far cheaper than replaying every affected date through the day-scoped syncs.
async function _syncPurgeHabit(habitId) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  for (const table of ['habit_logs', 'habit_voids', 'habit_counts', 'habit_notes']) {
    const { error } = await sb.from(table).delete().eq('user_id', uid).eq('habit_id', habitId);
    if (error) console.error(`[sync] ${table} purge failed:`, error);
  }
}

async function _syncHabitNotes(habitId, notes) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  const { error: delErr } = await sb.from('habit_notes').delete().eq('user_id', uid).eq('habit_id', habitId);
  if (delErr) { _syncFailed('habit_notes delete failed', delErr); return; }
  if (notes.length) {
    const { error } = await sb.from('habit_notes').insert(notes.map(n => ({
      user_id: uid, habit_id: habitId, text: n.text,
      created_at: new Date(n.createdAt).toISOString(),
    })));
    if (error) _syncFailed('habit_notes insert failed', error);
  }
}

// ── Reactive Habits (cue-triggered, logged per-occurrence — see js/reactiveHabits.js) ──
async function _syncReactiveHabits(list) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (list.length) {
    const { error } = await sb.from('reactive_habits').upsert(list.map(h => ({
      id: h.id, user_id: uid, name: h.name, cue_type: h.cueType,
      created_at: h.createdAt || new Date().toISOString(),
    })), { onConflict: 'id' });
    if (error) _syncFailed('reactive_habits upsert failed (run master.sql?)', error);
  }
  const { data: existing = [], error: selErr } = await sb.from('reactive_habits').select('id').eq('user_id', uid);
  if (selErr) { _syncFailed('reactive_habits select failed', selErr); return; }
  const keep = new Set(list.map(h => h.id));
  const toDelete = (existing || []).filter(r => !keep.has(r.id)).map(r => r.id);
  if (toDelete.length) {
    const { error: delErr } = await sb.from('reactive_habits').delete().eq('user_id', uid).in('id', toDelete);
    if (delErr) _syncFailed('reactive_habits delete failed', delErr);
  }
}

async function _syncReactiveOccurrences(list) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (list.length) {
    const { error } = await sb.from('reactive_habit_logs').upsert(list.map(o => ({
      id: o.id, user_id: uid, habit_id: o.habitId, ts: o.ts, outcome: o.outcome,
    })), { onConflict: 'id' });
    if (error) _syncFailed('reactive_habit_logs upsert failed (run master.sql?)', error);
  }
  const { data: existing = [], error: selErr } = await sb.from('reactive_habit_logs').select('id').eq('user_id', uid);
  if (selErr) { _syncFailed('reactive_habit_logs select failed', selErr); return; }
  const keep = new Set(list.map(o => o.id));
  const toDelete = (existing || []).filter(r => !keep.has(r.id)).map(r => r.id);
  if (toDelete.length) {
    const { error: delErr } = await sb.from('reactive_habit_logs').delete().eq('user_id', uid).in('id', toDelete);
    if (delErr) _syncFailed('reactive_habit_logs delete failed', delErr);
  }
}

// Deleting a reactive habit takes its occurrence log with it — one delete
// clears every row keyed by habit_id (mirrors _syncPurgeHabit).
async function _syncPurgeReactiveHabit(habitId) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  const { error } = await sb.from('reactive_habit_logs').delete().eq('user_id', uid).eq('habit_id', habitId);
  if (error) console.error('[sync] reactive_habit_logs purge failed:', error);
}

// ── Mobility (dedicated tables; MEM keeps the old blob shape) ──
async function _syncMobExercises(list) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (list.length) {
    const { error } = await sb.from('mobility_exercises').upsert(list.map(ex => ({
      id: ex.id, user_id: uid, name: ex.name,
      session: ex.session || 'morning', measure: ex.measure || 'hold',
      sets: ex.sets || 1, hold_seconds: ex.holdSeconds ?? null, reps: ex.reps ?? null,
      frequency: ex.frequency || 3,
      created_at: new Date(ex.createdAt || Date.now()).toISOString(),
    })), { onConflict: 'id' });
    if (error) _syncFailed('mobility_exercises upsert failed', error);
  }
  const { data: existing = [], error: selErr } =
    await sb.from('mobility_exercises').select('id').eq('user_id', uid);
  if (selErr) { _syncFailed('mobility_exercises select failed', selErr); return; }
  const keep = new Set(list.map(ex => ex.id));
  const toDelete = (existing || []).filter(r => !keep.has(r.id)).map(r => r.id);
  if (toDelete.length) {
    // FK on delete cascade also clears mobility_logs for these exercises.
    const { error: delErr } = await sb.from('mobility_exercises').delete().eq('user_id', uid).in('id', toDelete);
    if (delErr) _syncFailed('mobility_exercises delete failed', delErr);
  }
}

async function _syncMobLog(exerciseId, entries) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  const rows = entries.map(e => ({
    user_id: uid, exercise_id: exerciseId, date: e.date,
    sets: e.sets || 1, measure: e.measure || 'hold',
    hold_seconds: e.holdSeconds ?? null, reps: e.reps ?? null,
  }));
  if (rows.length) {
    let { error } = await sb.from('mobility_logs').upsert(rows, { onConflict: 'user_id,exercise_id,date' });
    if (error && error.code === '23503') {   // FK: parent exercise not synced yet
      await _syncMobExercises(getMobExercises());
      ({ error } = await sb.from('mobility_logs').upsert(rows, { onConflict: 'user_id,exercise_id,date' }));
    }
    if (error) _syncFailed('mobility_logs upsert failed', error);
  }
  const keepDates = new Set(entries.map(e => e.date));
  const { data: existing = [], error: selErr } =
    await sb.from('mobility_logs').select('date').eq('user_id', uid).eq('exercise_id', exerciseId);
  if (selErr) { _syncFailed('mobility_logs select failed', selErr); return; }
  const staleDates = (existing || []).map(r => r.date).filter(d => !keepDates.has(d));
  if (staleDates.length) {
    const { error: delErr } = await sb.from('mobility_logs')
      .delete().eq('user_id', uid).eq('exercise_id', exerciseId).in('date', staleDates);
    if (delErr) _syncFailed('mobility_logs delete failed', delErr);
  }
}

// ── Diet (dedicated tables; MEM keeps the old blob shape) ──
async function _syncDietEntries(list) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (list.length) {
    const { error } = await sb.from('diet_entries').upsert(list.map(e => ({
      id: e.id, user_id: uid, date: e.date, time: e.time || null,
      description: e.desc || null,
      calories: e.calories ?? null, protein: e.protein ?? null,
      carbs: e.carbs ?? null, fats: e.fats ?? null, category: e.category || null,
      healthy_ingredients: e.healthyIngredients || [],
      unhealthy_foods: e.unhealthyFoods || [],
    })), { onConflict: 'id' });
    if (error) _syncFailed('diet_entries upsert failed', error);
  }
  const { data: existing = [], error: selErr } =
    await sb.from('diet_entries').select('id').eq('user_id', uid);
  if (selErr) { _syncFailed('diet_entries select failed', selErr); return; }
  const keep = new Set(list.map(e => e.id));
  const toDelete = (existing || []).filter(r => !keep.has(r.id)).map(r => r.id);
  if (toDelete.length) {
    const { error: delErr } = await sb.from('diet_entries').delete().eq('user_id', uid).in('id', toDelete);
    if (delErr) _syncFailed('diet_entries delete failed', delErr);
  }
}

async function _syncDietFoods(kind, names) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (names.length) {
    const { error } = await sb.from('diet_foods').upsert(
      names.map(n => ({ user_id: uid, name: n, kind })),
      { onConflict: 'user_id,name,kind', ignoreDuplicates: true });
    if (error) _syncFailed('diet_foods upsert failed', error);
  }
  const { data: existing = [], error: selErr } =
    await sb.from('diet_foods').select('name').eq('user_id', uid).eq('kind', kind);
  if (selErr) { _syncFailed('diet_foods select failed', selErr); return; }
  const keep = new Set(names);
  const staleNames = (existing || []).map(r => r.name).filter(n => !keep.has(n));
  if (staleNames.length) {
    const { error: delErr } = await sb.from('diet_foods')
      .delete().eq('user_id', uid).eq('kind', kind).in('name', staleNames);
    if (delErr) _syncFailed('diet_foods delete failed', delErr);
  }
}

// Goals (Areas & Goals tab). Flat collection, client id — upsert-only.
// Deletion used to be inferred by diffing the full remote set against this
// local array and deleting whatever was missing, but that's wrong the moment
// two saves can be in flight at once: deleteGoal builds its array via
// `.filter()` (a new array, decoupled from whatever addGoal/edit is doing
// concurrently via in-place mutation), so a delete racing another save could
// delete a goal the other save had just added, or fail to delete the one the
// user actually removed. Deletion is now explicit — see deleteGoal below.
async function _syncGoals(goals) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (!goals.length) return;
  const { error } = await sb.from('goals').upsert(goals.map((g, i) => ({
    id: g.id, user_id: uid, title: g.title, area: g.area || null,
    notes: g.notes || null, done: g.done || false, done_at: g.doneAt || null,
    sort_order: i, created_at: g.createdAt || null,
  })), { onConflict: 'id' });
  if (error) _syncFailed('goals upsert failed', error);
}

async function _deleteGoalRemote(id) {
  if (LOCAL_MODE) return;
  const uid = await _requireUid(); if (!uid) return;
  const { error } = await sb.from('goals').delete().eq('user_id', uid).eq('id', id);
  if (error) _syncFailed('goals delete failed', error);
}

// ── Load all data from Supabase into MEM (parallel) ──
async function loadFromSupabase() {
  if (LOCAL_MODE) return _loadLocal();
  const uid = await _requireUid(); if (!uid) return;

  // Tasks load from 90 days back (matches TASK_HISTORY_DAYS) with NO upper
  // bound. There used to be one at today+1, which silently broke the Upcoming
  // planner: it lets you pick any future date, but anything past tomorrow never
  // came back on the next load. Worse, writing to a day MEM had never loaded
  // made `_syncTasks` insert that one task and stale-delete every other row for
  // the date — so re-adding a task to a day you'd planned wiped the rest of it.
  // `_localDateStr`, not toISOString, so the cutoff is the user's local day.
  const from = new Date(); from.setDate(from.getDate() - 90);
  const fromStr = _localDateStr(from);

  const results = await Promise.all([
    sb.from('habits').select('*').eq('user_id', uid).order('sort_order', { nullsFirst: false }).order('created_at'),
    sb.from('habit_logs').select('*').eq('user_id', uid),
    sb.from('tasks').select('*').eq('user_id', uid).gte('date', fromStr).order('id'),
    sb.from('settings').select('key,value').eq('user_id', uid),
    sb.from('job_applications').select('*').eq('user_id', uid).order('created_at', { ascending: false }),
    sb.from('habit_notes').select('*').eq('user_id', uid).order('created_at'),
    sb.from('mobility_exercises').select('*').eq('user_id', uid),
    sb.from('mobility_logs').select('*').eq('user_id', uid).order('date'),
    sb.from('diet_entries').select('*').eq('user_id', uid).order('date'),
    sb.from('diet_foods').select('*').eq('user_id', uid),
    sb.from('goals').select('*').eq('user_id', uid).order('sort_order', { nullsFirst: false }).order('created_at'),
    sb.from('referrals').select('*').eq('user_id', uid).order('sort_order', { nullsFirst: false }).order('created_at'),
    sb.from('habit_voids').select('*').eq('user_id', uid),
    sb.from('habit_counts').select('*').eq('user_id', uid),
    sb.from('reactive_habits').select('*').eq('user_id', uid).order('created_at'),
    sb.from('reactive_habit_logs').select('*').eq('user_id', uid).order('ts'),
    sb.from('whoop_recovery').select('*').eq('user_id', uid).order('date', { ascending: false }).limit(7),
    sb.from('whoop_workouts').select('*').eq('user_id', uid).order('start', { ascending: false }).limit(20),
    sb.from('whoop_profile').select('*').eq('user_id', uid).maybeSingle(),
  ]);

  results.forEach((r, i) => { if (r.error) console.error('Query', i, 'failed:', r.error); });

  const habits  = results[0].data || [];
  const logs    = results[1].data || [];
  const tasks   = results[2].data || [];
  const jobs    = results[4].data || [];
  const hNotes  = results[5].data || [];
  const mobEx   = results[6].data || [];
  const mobLogs = results[7].data || [];
  const dietEnt = results[8].data || [];
  const dietFds = results[9].data || [];
  const goalRows = results[10].data || [];
  const referralRows = results[11].data || [];
  const voids   = results[12].data || [];
  const counts  = results[13].data || [];
  const rHabits = results[14].data || [];
  const rLogs   = results[15].data || [];
  MEM['whoop:recovery'] = results[16].data || [];
  MEM['whoop:workouts'] = results[17].data || [];
  MEM['whoop:profile']  = results[18].data || null;

  MEM['habits:list'] = habits.map(h => ({
    id: h.id, name: h.name, startDate: h.start_date || h.created_at?.slice(0,10), endDate: h.end_date,
    archived: h.archived, archivedAt: h.archived_at,
    area: h.area || null, createdAt: h.created_at, endOfDay: h.end_of_day || false,
    morningRoutine: h.morning_routine || false, nightRoutine: h.night_routine || false,
    runs: Array.isArray(h.runs) ? h.runs : [],
    trackType: h.track_type || 'checkbox', target: h.target || null,
  }));

  logs.forEach(l => {
    const k = 'habits:log:' + l.date;
    if (!MEM[k]) MEM[k] = [];
    MEM[k].push(l.habit_id);
  });

  voids.forEach(v => {
    const k = 'habits:void:' + v.date;
    if (!MEM[k]) MEM[k] = [];
    MEM[k].push(v.habit_id);
  });

  counts.forEach(c => {
    const k = 'habits:count:' + c.date;
    if (!MEM[k]) MEM[k] = {};
    MEM[k][c.habit_id] = c.count;
  });

  // Rows written before the tid migration have tid = null. Without a stable
  // id, _normalizeTasks mints a fresh one every load, so rollover dedup and
  // "dismiss on delete" (task_dismissed_v1 is keyed by id) never stick — a
  // deleted overdue task reappears on the next reload. Mint the id once here
  // and write it back so it's permanent.
  const tidBackfill = [];
  tasks.forEach(g => {
    const k = 'tasks:' + g.date;
    if (!MEM[k]) MEM[k] = [];
    const tid = g.tid || _taskId();
    const task = { id: tid, text: g.text, done: g.done,
      area: g.area || null, priority: g.priority || 'Medium',
      createdAt: g.created_at || null };
    if (g.done_at) task.doneAt = g.done_at;
    // Collapse duplicate rows a failed stale-delete may have left (see
    // _syncTasks). `_syncTasks` re-inserts the whole day on every change, so the
    // HIGHEST id is the newest state — and the query is ordered by id ascending,
    // so a later row must replace an earlier one, keeping its slot in the day's
    // order. Keeping the first instead (as this did) rolled the day back to its
    // pre-edit state on reload: ticks came back unticked until the next save.
    const dupe = g.tid ? MEM[k].findIndex(x => x.id === g.tid) : -1;
    if (dupe >= 0) MEM[k][dupe] = task;
    else MEM[k].push(task);
    if (!g.tid) tidBackfill.push({ row: { ...g, tid }, task });
  });

  if (!LOCAL_MODE && tidBackfill.length) {
    const { error } = await sb.from('tasks').upsert(tidBackfill.map(b => b.row));
    if (error) {
      _syncFailed('task tid backfill failed (run master.sql?)', error);
      // The ids minted just above never reached the database, so they'll be
      // different again next load. Flag those rows: _sameTask (js/todo.js) falls
      // back to matching on text for them, which is the only way "dismiss on
      // delete" can stick when the id itself won't hold still.
      tidBackfill.forEach(b => { b.task.idUnstable = true; });
    }
  }

  (results[3].data || []).forEach(row => { MEM[row.key] = row.value; });

  MEM['jobs:list'] = jobs.map(j => ({
    id: j.id, company: j.company, role: j.role || '', platform: j.platform || '',
    dateApplied: j.date_applied || '', status: j.status || 'Applied',
    locationType: j.location_type || '', locationCities: Array.isArray(j.location_cities) ? j.location_cities : [],
  }));

  MEM['goals:list'] = goalRows.map(g => ({
    id: g.id, title: g.title, area: g.area || null, notes: g.notes || '',
    done: !!g.done, doneAt: g.done_at || null, createdAt: g.created_at,
  }));

  MEM['referrals:list'] = referralRows.map(r => ({
    id: r.id, name: r.name, jobId: r.job_id || null, createdAt: r.created_at,
  }));

  hNotes.forEach(n => {
    const k = 'habit_notes:' + n.habit_id;
    (MEM[k] = MEM[k] || []).push({ id: n.id, text: n.text, createdAt: Date.parse(n.created_at) });
  });

  MEM['mobility_exercises_v1'] = mobEx.map(r => ({
    id: r.id, name: r.name, session: r.session, measure: r.measure,
    sets: r.sets, holdSeconds: r.hold_seconds, reps: r.reps,
    frequency: r.frequency, createdAt: Date.parse(r.created_at),
  }));
  mobLogs.forEach(r => {
    const k = 'mobility_progress:' + r.exercise_id;
    (MEM[k] = MEM[k] || []).push({
      id: r.id, date: r.date, sets: r.sets, measure: r.measure,
      holdSeconds: r.hold_seconds, reps: r.reps,
    });
  });

  MEM['diet_entries_v1'] = dietEnt.map(r => ({
    id: r.id, date: r.date, time: r.time || '', desc: r.description || '',
    calories: r.calories, protein: r.protein, carbs: r.carbs, fats: r.fats,
    category: r.category,
    healthyIngredients: r.healthy_ingredients || [],
    unhealthyFoods: r.unhealthy_foods || [],
  }));
  MEM['diet_healthy_v1']   = dietFds.filter(r => r.kind === 'healthy').map(r => r.name);
  MEM['diet_unhealthy_v1'] = dietFds.filter(r => r.kind === 'unhealthy').map(r => r.name);

  MEM['reactive_habits:list'] = rHabits.map(h => ({
    id: h.id, name: h.name, cueType: h.cue_type, createdAt: h.created_at,
  }));
  MEM['reactive_habits:log'] = rLogs.map(l => ({
    id: l.id, habitId: l.habit_id, ts: l.ts, outcome: l.outcome,
  }));

  _normalizeTasks();
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

// ── Re-check the "active day" when returning to an already-open tab ──
// The app otherwise only rolls the date over on a full page load / sign-in.
let _lastActiveDate = getActiveDateString();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const now = getActiveDateString();
  if (now === _lastActiveDate) return;
  _lastActiveDate = now;
  checkStreak(); rollover(); applySundayReset();
  loadToday(); loadUpcoming(); renderStreak(); tick(true);
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
  if (LOCAL_MODE) _seedLocalCityCoverageFromUrl();
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('signOutBtn').style.display = '';
  checkStreak(); rollover(); applySundayReset(); renderHabits(); renderReactiveHabits(); loadToday(); loadUpcoming(); renderStreak(); renderJobs(); renderJobSites(); renderReferrals(); renderTechRankings(); renderAreas(); renderGoals(); renderDiet(); renderMobility(); renderWhoop();
  _whoopHandleOAuthReturn();
  _syncSundayResetBtn();
  tick(true); // refresh the task ticker immediately with the loaded data
}

async function signOut() {
  // Let any sync still in flight from the user's last click land first —
  // every save is fire-and-forget, so reloading immediately could cancel one
  // mid-request with no warning. Capped at 3s so a stuck request can't hang
  // sign-out indefinitely.
  if (!LOCAL_MODE) await _waitForPendingSyncs();
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
checkStreak();
rollover();
applySundayReset();

makeAddHandlers(
  document.getElementById('taskInput'),
  document.getElementById('taskAddBtn'),
  document.getElementById('taskPolishBtn'),
  todayKey,
  document.getElementById('polishStatus'),
  loadToday
);

makeAddHandlers(
  document.getElementById('tomorrowInput'),
  document.getElementById('tomorrowAddBtn'),
  document.getElementById('tomorrowPolishBtn'),
  () => 'tasks:' + plannerTargetDate(),
  document.getElementById('tomorrowStatus'),
  loadUpcoming
);

loadToday();
loadUpcoming();
renderStreak();

updateDayBar();
setInterval(updateDayBar, 60 * 1000);

startTicker();
renderAreas();
renderGoals();
renderDiet();
renderMobility();
initApp();
