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

function _seedLocalRealisticJobsFromUrl() {
  const url = new URL(location.href);
  if (url.searchParams.get('seedRealisticJobs') !== '1') return;
  url.searchParams.delete('seedRealisticJobs');
  history.replaceState(null, '', url);

  const jobs = (MEM['jobs:list'] || []).filter(job =>
    !job.sampleCityCoverage && !/^Sample (?:Job|Application)/.test(job.company || '') && !/\(Sample \d+\)$/.test(job.company || ''));
  const roles = ['Software Engineer', 'Frontend Engineer', 'Backend Engineer', 'Full Stack Engineer',
    'Data Engineer', 'Product Manager', 'UX Designer', 'DevOps Engineer'];
  const platforms = ['LinkedIn', 'Company Site', 'Indeed'];
  const seeded = [];
  const used = new Set();
  const addLocation = (city, count, metroRank) => {
    const key = city.toLowerCase();
    if (used.has(key)) return;
    used.add(key);
    for (let i = 0; i < count; i++) {
      const date = new Date();
      date.setDate(date.getDate() - ((seeded.length * 3 + i * 7 + metroRank) % 150));
      seeded.push({
        id: _jobId(), company: `Sample Application ${seeded.length + 1}`, sampleCityCoverage: true,
        role: roles[seeded.length % roles.length], platform: platforms[seeded.length % platforms.length],
        dateApplied: [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'),
        status: ['Applied', 'Applied', 'Phone Screen', 'Rejected'][seeded.length % 4],
        locationType: 'onsite', locationCities: [city],
      });
    }
  };

  techCities.forEach(city => {
    const rank = city.cityTechRank;
    const count = rank <= 3 ? [10, 8, 7][rank - 1]
      : rank <= 7 ? 6
      : rank <= 10 ? 5
      : rank <= 15 ? 4
      : rank <= 25 ? 2 : 1;
    addLocation(city.name, count, rank);
  });
  techMetros.forEach(metro => {
    const coreNames = new Set(techCities.filter(city => city.metroId === metro.id)
      .flatMap(city => [city.name, ...(TECH_CITY_APPLICATION_ALIASES[city.name] || [])])
      .map(name => name.toLowerCase()));
    (metro.includedAreas || []).filter(area => !coreNames.has(area.toLowerCase()))
      .forEach(area => addLocation(area, metro.metroTechRank <= 12 ? 2 : 1, metro.metroTechRank));
  });
  MEM['jobs:list'] = [...jobs, ...seeded];
  _saveLocal();
}

// `?seedSampleJobs=1` (test@local only): replaces the job applications with
// the 124-application sample set used for the Jobs tab rework — real company
// names spread over ~60 US cities, made-up statuses, dates over ~4 months —
// plus three sample referrals. Deterministic, so every browser gets the same set.
function _seedLocalSampleJobsFromUrl() {
  const url = new URL(location.href);
  if (url.searchParams.get('seedSampleJobs') !== '1') return;
  url.searchParams.delete('seedSampleJobs');
  history.replaceState(null, '', url);

  const ds = off => { const d = new Date(); d.setDate(d.getDate() - off); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); };
  const J = (company, role, platform, off, status, locationType, locationCities = []) =>
    ({ id:_jobId(), company, role, platform, dateApplied:ds(off), status, locationType, locationCities });
  const base = [
    J('Stripe','Software Engineer','LinkedIn',0,'Applied','hybrid',['San Francisco, CA','Seattle, WA']),
    J('Figma','Frontend Engineer','Company Site',0,'Applied','onsite',['New York, NY']),
    J('Ramp','Full Stack Engineer','Wellfound',1,'Applied','onsite',['New York, NY']),
    J('Datadog','Software Engineer','LinkedIn',2,'Phone Screen','hybrid',['New York, NY','Boston, MA']),
    J('Notion','Frontend Engineer','Company Site',3,'Applied','onsite',['San Francisco, CA']),
    J('Vercel','Frontend Engineer','Built In',4,'Interview','remote'),
    J('Linear','Full Stack Engineer','Wellfound',5,'Applied','remote'),
    J('Airbnb','Software Engineer','LinkedIn',6,'Rejected','hybrid',['San Francisco, CA']),
    J('Snowflake','Software Engineer','Indeed',8,'Applied','onsite',['San Mateo, CA']),
    J('Cloudflare','Software Engineer','LinkedIn',9,'Phone Screen','hybrid',['Austin, TX']),
    J('Duolingo','Frontend Engineer','Company Site',11,'Applied','onsite',['Pittsburgh, PA']),
    J('Robinhood','Software Engineer','LinkedIn',12,'Rejected','onsite',['Menlo Park, CA']),
    J('Plaid','Full Stack Engineer','Built In',14,'Interview','hybrid',['San Francisco, CA','New York, NY']),
    J('Asana','Product Manager','LinkedIn',15,'Applied','onsite',['San Francisco, CA']),
    J('Shopify','Software Engineer','Company Site',17,'Applied','remote'),
    J('HubSpot','Frontend Engineer','Indeed',19,'Rejected','hybrid',['Cambridge, MA']),
    J('Brex','Software Engineer','Wellfound',21,'Applied','onsite',['New York, NY']),
    J('Twilio','Software Engineer','LinkedIn',24,'Applied','remote'),
    J('Discord','Frontend Engineer','Company Site',27,'Rejected','onsite',['San Francisco, CA']),
    J('Capital One','Software Engineer','Indeed',30,'Offer','hybrid',['McLean, VA']),
    J('Anduril','Software Engineer','LinkedIn',33,'Applied','onsite',['Costa Mesa, CA']),
    J('Instacart','Full Stack Engineer','LinkedIn',36,'Applied','remote'),
    J('Zillow','Software Engineer','Indeed',40,'Rejected','remote'),
    J('Epic Games','Software Engineer','Company Site',44,'Applied','onsite',['Raleigh, NC']),
  ];
  const companies = ['Meta','Google','Apple','Amazon','Microsoft','Netflix','Uber','Lyft','DoorDash','Pinterest','Snap','Reddit','Dropbox','Box','Atlassian','GitLab','MongoDB','Okta','Palantir','Scale AI','Databricks','Confluent','Elastic','Grafana Labs','Retool','Airtable','Canva','Coinbase','Chime','SoFi','Affirm','Toast','Wayfair','Peloton','Etsy','Squarespace','Spotify','Bloomberg','Two Sigma','Jane Street','Citadel','Oracle','Salesforce','Adobe','Intuit','Workday','ServiceNow','Nvidia','AMD','Qualcomm','Tesla','Rivian','SpaceX','Boeing','Lockheed Martin','Booz Allen','Indeed','Dell','Charles Schwab','Walmart Global Tech','Target Tech','Best Buy','Chewy','Kroger Digital','Nike','Intel','Zendesk','Expedia','T-Mobile','Microsoft Azure','Epic Systems','Cerner','Fidelity','Wells Fargo','Bank of America','Truist','Red Hat','SAS','Honeywell',"Lowe's",'Nationwide','Carvana','GoDaddy','Qualtrics','Pluralsight','Grubhub','Groupon','Morningstar','Allstate','Motorola','Ford','GM','Rocket Mortgage','Quicken Loans','Delta Tech','Home Depot','NCR','Mailchimp','Cox','Humana'];
  const cities = ['San Francisco, CA','San Francisco, CA','San Francisco, CA','New York, NY','New York, NY','New York, NY','New York, NY','Seattle, WA','Seattle, WA','Bellevue, WA','Redmond, WA','San Jose, CA','Mountain View, CA','Palo Alto, CA','Sunnyvale, CA','Austin, TX','Austin, TX','Austin, TX','Boston, MA','Boston, MA','Cambridge, MA','Los Angeles, CA','Los Angeles, CA','Santa Monica, CA','Irvine, CA','Costa Mesa, CA','San Diego, CA','Chicago, IL','Chicago, IL','Denver, CO','Boulder, CO','Washington, DC','Arlington, VA','Reston, VA','Dallas, TX','Plano, TX','Irving, TX','Raleigh, NC','Durham, NC','Atlanta, GA','Atlanta, GA','Philadelphia, PA','Pittsburgh, PA','Phoenix, AZ','Tempe, AZ','Salt Lake City, UT','Lehi, UT','Minneapolis, MN','Portland, OR','Nashville, TN','Charlotte, NC','Miami, FL','Detroit, MI','Columbus, OH','Madison, WI','Kansas City, MO','Houston, TX','Baltimore, MD','Richmond, VA','Tampa, FL'];
  const roles = ['Software Engineer','Software Engineer','Frontend Engineer','Full Stack Engineer','Full Stack Engineer','Product Manager'];
  const platforms = ['LinkedIn','LinkedIn','LinkedIn','Company Site','Company Site','Indeed','Wellfound','Built In'];
  let seed = 7;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const pick = list => list[Math.floor(rand() * list.length)];
  const extra = companies.map(company => {
    const off = Math.floor(Math.pow(rand(), 1.4) * 120) + 1;
    let status = rand() < 0.34 ? 'Rejected' : 'Applied';
    if (status === 'Applied' && off > 10 && rand() < 0.18) status = 'Phone Screen';
    if (status === 'Phone Screen' && rand() < 0.35) status = 'Interview';
    const type = rand() < 0.16 ? 'remote' : (rand() < 0.45 ? 'hybrid' : 'onsite');
    const places = type === 'remote' ? [] : (rand() < 0.15 ? [...new Set([pick(cities), pick(cities)])] : [pick(cities)]);
    return J(company, pick(roles), pick(platforms), off, status, type, places);
  });
  MEM['jobs:list'] = [...base, ...extra];
  MEM['job_roles_v1'] = ['Software Engineer','Frontend Engineer','Full Stack Engineer','Product Manager'];
  MEM['job_sites_v1'] = ['linkedin','indeed','wellfound','builtin'];
  const now = new Date().toISOString();
  MEM['referrals:list'] = [
    { id:'rf_a', name:'Priya Shah', jobId:base[3].id, step:'referred', createdAt:now },
    { id:'rf_b', name:'Marcus Lee', jobId:base[12].id, step:'thanked', createdAt:now },
    { id:'rf_c', name:'Jordan (college friend)', jobId:null, step:'ask', createdAt:now },
  ];
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


// ── Quote of the Day ──
// Picks one quote per active day (same 6am boundary as the rest of the app,
// via getActiveDateString) so it's stable all day and changes tomorrow.
const QUOTES = [
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "Discipline is choosing between what you want now and what you want most.", author: "Abraham Lincoln" },
  { text: "Small daily improvements are the key to staggering long-term results.", author: "James Clear" },
  { text: "You do not rise to the level of your goals. You fall to the level of your systems.", author: "James Clear" },
  { text: "Well done is better than well said.", author: "Benjamin Franklin" },
  { text: "The way to get started is to quit talking and begin doing.", author: "Walt Disney" },
  { text: "Motivation is what gets you started. Habit is what keeps you going.", author: "Jim Ryun" },
  { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
  { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
  { text: "Success is the sum of small efforts, repeated day in and day out.", author: "Robert Collier" },
  { text: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
  { text: "Focus on being productive instead of busy.", author: "Tim Ferriss" },
  { text: "Amateurs sit and wait for inspiration, the rest of us just get up and go to work.", author: "Stephen King" },
  { text: "The future depends on what you do today.", author: "Mahatma Gandhi" },
  { text: "A year from now you may wish you had started today.", author: "Karen Lamb" },
  { text: "Do the hard jobs first. The easy jobs will take care of themselves.", author: "Dale Carnegie" },
  { text: "Action is the foundational key to all success.", author: "Pablo Picasso" },
  { text: "What we do every day matters more than what we do once in a while.", author: "Gretchen Rubin" },
  { text: "The pain of discipline weighs ounces, the pain of regret weighs tons.", author: "Jim Rohn" },
  { text: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci" },
  { text: "Either you run the day, or the day runs you.", author: "Jim Rohn" },
  { text: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", author: "Will Durant" },
  { text: "Have the courage to follow your heart and intuition.", author: "Steve Jobs" },
  { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
  { text: "Energy and persistence conquer all things.", author: "Benjamin Franklin" },
  { text: "Slow is smooth, and smooth is fast.", author: "Navy SEAL saying" },
  { text: "You can't build a reputation on what you're going to do.", author: "Henry Ford" },
  { text: "It's not that I'm so smart, it's just that I stay with problems longer.", author: "Albert Einstein" },
  { text: "Progress, not perfection.", author: "Unknown" },
  { text: "Nothing is particularly hard if you divide it into small jobs.", author: "Henry Ford" },
  { text: "Until you value yourself, you won't value your time.", author: "M. Scott Peck" },
  { text: "The best way to predict the future is to create it.", author: "Peter Drucker" },
  { text: "Set your goals high, and don't stop till you get there.", author: "Bo Jackson" },
  { text: "Every accomplishment starts with the decision to try.", author: "John F. Kennedy" },
  { text: "Perfection is not attainable, but if we chase perfection we can catch excellence.", author: "Vince Lombardi" },
  { text: "Quality is not an act, it is a habit.", author: "Aristotle" },
  { text: "What gets measured gets managed.", author: "Peter Drucker" },
  { text: "The best time to plant a tree was 20 years ago. The second best time is now.", author: "Chinese Proverb" },
  { text: "Consistency is what transforms average into excellence.", author: "Unknown" },
];

function _quoteIndexForDate(dateStr) {
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    hash = (hash * 31 + dateStr.charCodeAt(i)) >>> 0;
  }
  return hash % QUOTES.length;
}

function renderQuoteOfDay() {
  const textEl = document.getElementById('quoteText');
  const authorEl = document.getElementById('quoteAuthor');
  if (!textEl || !authorEl) return;
  const quote = QUOTES[_quoteIndexForDate(getActiveDateString())];
  textEl.textContent = quote.text;
  authorEl.textContent = quote.author;
}


// ── Weather ──
// Uses the browser's geolocation + Open-Meteo (free, no API key) to show the
// current temperature. Cached in localStorage so a reload shows the last
// known reading instantly while a fresh one loads in the background.
const WEATHER_CACHE_KEY = 'dashboard_weather_cache_v2'; // v2: added sunrise/sunset
const WEATHER_MAX_AGE_MS = 30 * 60 * 1000;

function _weatherIconFor(code) {
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 57) return '🌦️';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return '🌧️';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '🌨️';
  if (code >= 95) return '⛈️';
  return '🌡️';
}

// Latest reading, kept so the sky tile can re-place the sun every minute
// (updateDayBar) without refetching.
let _weather = null;   // { temp, code, sunrises: [today, tomorrow], sunsets: [...] }

function _applyWeather(tempF, code, sunrises, sunsets) {
  _weather = { temp: tempF, code, sunrises: sunrises || null, sunsets: sunsets || null };
  renderSky();
}

// The sky tile next to the day info: its colour follows the time of day, the
// sun sits on an arc between today's sunrise and sunset, and after dark it
// becomes a moon crossing to tomorrow's sunrise. Open-Meteo's sunrise/sunset
// are local wall-clock ISO strings (timezone=auto), so new Date() reads them
// as local time.
function renderSky() {
  const row = document.getElementById('weatherBadge');
  if (!row || !_weather) return;
  document.getElementById('weatherTemp').textContent = Math.round(_weather.temp) + '°';
  row.title = _weatherIconFor(_weather.code) + ' ' + Math.round(_weather.temp) + '°F';
  const sky = document.getElementById('sky');
  const orb = document.getElementById('skyOrb');
  const sunEl = document.getElementById('weatherSun');
  sky.dataset.cond = _weather.code >= 51 ? 'wet' : _weather.code >= 3 ? 'cloudy' : 'clear';

  const rs = _weather.sunrises, ss = _weather.sunsets;
  if (!rs || !ss) {                       // old cache without sun times
    sky.hidden = true; sunEl.textContent = ''; row.hidden = false; return;
  }
  sky.hidden = false;
  const now = Date.now();
  const rise = new Date(rs[0]).getTime(), set = new Date(ss[0]).getTime();
  const riseNext = new Date(rs[1]).getTime();
  let f, phase;
  if (now >= rise && now < set) {
    f = (now - rise) / (set - rise);
    phase = now < rise + 2 * 3600e3 ? 'morning' : now > set - 90 * 60e3 ? 'golden' : 'day';
    sunEl.innerHTML = _sunEventHtml('sunset', new Date(set));
  } else {
    // Night: from today's sunset to tomorrow's sunrise, or — before dawn — from
    // (roughly) last night's sunset to this morning's sunrise.
    const [from, to] = now >= set ? [set, riseNext] : [set - 86400e3, rise];
    f = Math.min(1, Math.max(0, (now - from) / (to - from)));
    phase = 'night';
    sunEl.innerHTML = _sunEventHtml('sunrise', new Date(now >= set ? riseNext : rise));
  }
  sky.dataset.phase = phase;
  // Same quadratic as the SVG arc path: y(t) = 40 − 140t + 140t² on a 0–40 box.
  const y = 40 - 140 * f + 140 * f * f;
  orb.style.left = `calc(6% + ${(f * 88).toFixed(2)}%)`;
  orb.style.top  = `calc(3px + ${(y / 40).toFixed(3)} * (75% - 3px))`;
  row.hidden = false;
}

// The next sun event: a sun on the horizon with an arrow (up = sunrise,
// down = sunset), the word, and the time.
function _sunEventHtml(kind, when) {
  const arrow = kind === 'sunrise' ? 'M12 10V3M9 6l3-3 3 3' : 'M12 3v7M9 7l3 3 3-3';
  return `<span class="sun-evt sun-evt--${kind}"><svg viewBox="0 0 24 24" aria-hidden="true">` +
    `<path d="M3 20h18"/><path d="M6.5 20a5.5 5.5 0 0 1 11 0"/><path d="${arrow}"/></svg>` +
    `<span class="sun-evt-label">${kind}</span><span class="sun-evt-time">${fmtClock(when)}</span></span>`;
}

// Falls back here when geolocation is denied/unavailable, so the badge
// still shows something instead of staying hidden.
const WEATHER_FALLBACK_LAT = 33.7879;
const WEATHER_FALLBACK_LON = -117.8531; // Orange, CA

async function _fetchWeatherFor(latitude, longitude) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current_weather=true&temperature_unit=fahrenheit` +
      `&daily=sunrise,sunset&forecast_days=2&timezone=auto`;
    const res = await fetch(url);
    const data = await res.json();
    const temp = data.current_weather.temperature;
    const code = data.current_weather.weathercode;
    _applyWeather(temp, code, data.daily.sunrise, data.daily.sunset);
    try {
      localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({
        temp, code, ts: Date.now(),
        sunrise: data.daily.sunrise, sunset: data.daily.sunset,
      }));
    } catch (e) {}
  } catch (e) { console.error('[weather] fetch failed:', e); }
}

function loadWeather() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY) || 'null'); } catch (e) {}
  if (cached) {
    _applyWeather(cached.temp, cached.code, cached.sunrise, cached.sunset);
    if (Date.now() - cached.ts < WEATHER_MAX_AGE_MS) return;
  }

  if (!navigator.geolocation) {
    _fetchWeatherFor(WEATHER_FALLBACK_LAT, WEATHER_FALLBACK_LON);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => _fetchWeatherFor(pos.coords.latitude, pos.coords.longitude),
    (err) => {
      console.error('[weather] geolocation failed, falling back to Orange, CA:', err);
      _fetchWeatherFor(WEATHER_FALLBACK_LAT, WEATHER_FALLBACK_LON);
    },
    { maximumAge: WEATHER_MAX_AGE_MS, timeout: 10000 }
  );
}


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
  const C = 2 * Math.PI * 54;
  const ring  = document.getElementById('ringFill');
  const phaseEl = document.getElementById('ringPhase');
  const statusEl = document.getElementById('ringStatus');
  const remainEl = document.getElementById('ringRemain');

  ring.style.strokeDasharray = C;
  const [clock, ampm] = fmtClock(now).split(' ');
  document.getElementById('ringClock').textContent = clock;
  document.getElementById('ringAmPm').textContent = ampm;

  const dateEl = document.getElementById('stripDate');
  if (dateEl) dateEl.textContent = formatDate(typeof getActiveDateString === 'function'
    ? getActiveDateString() : _localDateStr(now));

  const hoursEl = document.getElementById('ringHours');
  if (hoursEl) hoursEl.textContent = fmtHourDecimal(WAKE_HOUR) + ' – ' + fmtHourDecimal(SLEEP_HOUR);

  const h = now.getHours() + now.getMinutes()/60 + now.getSeconds()/3600;
  let dayPct;

  if (h < WAKE_HOUR) {
    dayPct = 0;
    ring.style.strokeDashoffset = C;
    ring.style.stroke = '#4D4B47';
    phaseEl.textContent = 'SLEEPING';
    statusEl.textContent = 'Still sleeping';
    remainEl.textContent = `${fmtHM(WAKE_HOUR - h)} until wake-up`;
  } else if (h < SLEEP_HOUR) {
    dayPct = (h - WAKE_HOUR) / (SLEEP_HOUR - WAKE_HOUR) * 100;
    ring.style.strokeDashoffset = C * (1 - dayPct/100);
    ring.style.stroke = '#4A9EFF';
    remainEl.textContent = `${fmtHM(SLEEP_HOUR - h)} left`;
    if (dayPct < 25) { phaseEl.textContent='MORNING'; statusEl.textContent='Morning — fresh start'; }
    else if (dayPct < 50) { phaseEl.textContent='MIDDAY'; statusEl.textContent='Midday — keep moving'; }
    else if (dayPct < 75) { phaseEl.textContent='AFTERNOON'; statusEl.textContent='Afternoon — push it'; }
    else if (dayPct < 90) { phaseEl.textContent='EVENING'; statusEl.textContent='Evening — wrap up'; }
    else { phaseEl.textContent='BEDTIME'; statusEl.textContent='Bedtime soon'; }
  } else {
    dayPct = 100;
    ring.style.strokeDashoffset = 0;
    ring.style.stroke = '#E25D7A';
    phaseEl.textContent = 'LATE';
    statusEl.textContent = 'Past bedtime';
    remainEl.textContent = 'Sleep!';
  }
  document.getElementById('dayRing').dataset.dayPct = Math.round(dayPct);
  renderDayStripTasks();
  renderSky();
}

// The task half of the day strip: the inner (green) ring is the share of
// today's tasks done, and "planned" adds up the estimates on what's still open
// — green while it fits in the awake time left, red once it doesn't. Called on
// every task change (renderTodayHeader) and every minute (updateDayBar).
function renderDayStripTasks() {
  const ringEl = document.getElementById('ringTasks');
  if (!ringEl) return;
  const tasks = storeGet(todayKey()) || [];
  const done = tasks.filter(g => g.done).length;
  const pct = tasks.length ? done / tasks.length : 0;
  const C = 2 * Math.PI * 43;
  ringEl.style.strokeDasharray = C;
  ringEl.style.strokeDashoffset = C * (1 - pct);
  ringEl.style.opacity = pct ? 1 : 0;           // round caps draw a dot at 0%
  const wrap = document.getElementById('dayRing');
  wrap.title = `Day ${wrap.dataset.dayPct || 0}% · tasks ${Math.round(pct * 100)}% done (${done}/${tasks.length})`;

  const planned = tasks.filter(g => !g.done).reduce((n, g) => n + (g.est || 0), 0);
  const pw = document.getElementById('ringPlannedWrap');
  pw.hidden = !planned;
  if (!planned) return;
  const now = new Date();
  const h = now.getHours() + now.getMinutes()/60;
  const leftMin = Math.max(0, Math.round((SLEEP_HOUR - Math.max(h, WAKE_HOUR)) * 60));
  // Whole minutes — fmtHM takes fractional hours and floors float error (145m → "2h 24m").
  const fmtMin = m => (m >= 60 ? `${Math.floor(m / 60)}h ` : '') + `${String(m % 60).padStart(m >= 60 ? 2 : 1, '0')}m`;
  const el = document.getElementById('ringPlanned');
  const fits = planned <= leftMin;
  el.textContent = fits ? `${fmtMin(planned)} planned` : `${fmtMin(planned)} planned, ${fmtMin(planned - leftMin)} over`;
  el.className = fits ? 'fits' : 'over';
  el.title = fits ? `${fmtMin(leftMin - planned)} to spare` : 'More planned than awake time left';
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

// Set on load when the habits rows come back with a `meta` column, so clearing
// the last schedule still writes meta: null instead of leaving the old one.
let _habitsMetaColumn = false;
async function _syncHabits(habits) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (habits.length) {
    // `meta` only goes out once a habit uses a schedule, so a database that
    // hasn't run the master.sql column yet keeps saving everything else.
    const withMeta = _habitsMetaColumn || habits.some(h => h.schedule);
    const { error } = await sb.from('habits').upsert(habits.map((h, i) => {
      const row = {
        id: h.id, user_id: uid, name: h.name,
        start_date: h.startDate || null, end_date: h.endDate || null,
        archived: h.archived || false, archived_at: h.archivedAt || null,
        sort_order: i, area: h.area || null, end_of_day: h.endOfDay || false,
        morning_routine: h.morningRoutine || false, night_routine: h.nightRoutine || false,
        runs: Array.isArray(h.runs) ? h.runs : [],
        track_type: h.trackType || 'checkbox', target: h.target || null,
      };
      if (withMeta) row.meta = h.schedule ? { schedule: h.schedule } : null;
      return row;
    }), { onConflict: 'id' });
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

// The optional per-task extras, as stored in `tasks.meta`. null when a task has
// none, so plain tasks keep a null column.
function _taskMeta(g) {
  const m = {};
  if (g.focus) m.focus = true;
  if (g.est > 0) m.est = g.est;
  if (g.due) m.due = g.due;
  if (Array.isArray(g.steps) && g.steps.length) m.steps = g.steps.map(s => ({ text: s.text, done: !!s.done }));
  return Object.keys(m).length ? m : null;
}

async function _syncTasksNow(dateStr, tasks) {
  const uid = await _requireUid(); if (!uid) return;

  if (!tasks.length) {
    const { error } = await sb.from('tasks').delete().eq('user_id', uid).eq('date', dateStr);
    if (error) _syncFailed('tasks clear failed', error);
    return;
  }

  // `meta` (focus / estimate / due / steps) is only sent when some task on this
  // day actually uses it, so a day without those extras never references the
  // column — a DB that hasn't had master.sql's `tasks.meta` added yet keeps
  // saving those days normally instead of rejecting every insert.
  const metas = tasks.map(_taskMeta);
  const withMeta = metas.some(Boolean);

  // Insert the current set first, asking for the new rows' ids back.
  const { data: inserted, error: insErr } = await sb.from('tasks').insert(tasks.map((g, i) => {
    const row = {
      user_id: uid, date: dateStr, text: g.text,
      done: g.done || false, done_at: g.doneAt || null,
      area: g.area || null, priority: g.priority || 'Medium',
      tid: g.id || null, created_at: g.createdAt || null,
    };
    if (withMeta) row.meta = metas[i];
    return row;
  })).select('id');
  if (insErr) {
    _syncFailed(withMeta ? 'tasks insert failed (kept existing rows — run master.sql for tasks.meta?)'
                         : 'tasks insert failed (kept existing rows)', insErr);
    return;
  }

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

  _habitsMetaColumn = habits.some(h => 'meta' in h);
  MEM['habits:list'] = habits.map(h => ({
    id: h.id, name: h.name, startDate: h.start_date || h.created_at?.slice(0,10), endDate: h.end_date,
    archived: h.archived, archivedAt: h.archived_at,
    area: h.area || null, createdAt: h.created_at, endOfDay: h.end_of_day || false,
    morningRoutine: h.morning_routine || false, nightRoutine: h.night_routine || false,
    runs: Array.isArray(h.runs) ? h.runs : [],
    trackType: h.track_type || 'checkbox', target: h.target || null,
    ...(h.meta && h.meta.schedule ? { schedule: h.meta.schedule } : {}),
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
    const meta = g.meta || {};
    if (meta.focus) task.focus = true;
    if (meta.est > 0) task.est = meta.est;
    if (meta.due) task.due = meta.due;
    if (Array.isArray(meta.steps) && meta.steps.length) task.steps = meta.steps;
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

  _jobsMetaColumn = jobs.some(j => 'meta' in j);
  MEM['jobs:list'] = jobs.map(j => {
    const job = {
      id: j.id, company: j.company, role: j.role || '', platform: j.platform || '',
      dateApplied: j.date_applied || '', status: j.status || 'Applied',
      locationType: j.location_type || '', locationCities: Array.isArray(j.location_cities) ? j.location_cities : [],
    };
    const meta = j.meta || {};
    if (meta.url) job.url = meta.url;
    if (meta.notes) job.notes = meta.notes;
    if (meta.next && meta.next.date) job.next = meta.next;
    if (Array.isArray(meta.history) && meta.history.length) job.history = meta.history;
    return job;
  });

  MEM['goals:list'] = goalRows.map(g => ({
    id: g.id, title: g.title, area: g.area || null, notes: g.notes || '',
    done: !!g.done, doneAt: g.done_at || null, createdAt: g.created_at,
  }));

  _referralsStepColumn = referralRows.some(r => 'step' in r);
  MEM['referrals:list'] = referralRows.map(r => ({
    id: r.id, name: r.name, jobId: r.job_id || null, createdAt: r.created_at,
    ...(r.step ? { step: r.step } : {}),
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
document.querySelectorAll('#tabBar .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabBar .tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    // Tabs share one scrolling page, so without this a new tab opens wherever
    // the last one was scrolled to — often halfway down.
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
});

// ── Sidebar collapse toggle ──
// Persists across reloads (UI-only preference, not synced data).
const SIDEBAR_COLLAPSED_KEY = 'dashboard_sidebar_collapsed';
(function initSidebarToggle() {
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebarToggle');
  if (!sidebar || !toggleBtn) return;
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch (e) {}
  sidebar.classList.toggle('collapsed', collapsed);
  toggleBtn.addEventListener('click', () => {
    const isCollapsed = sidebar.classList.toggle('collapsed');
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, isCollapsed ? '1' : '0'); } catch (e) {}
  });
})();

// ── Re-check the "active day" when returning to an already-open tab ──
// The app otherwise only rolls the date over on a full page load / sign-in.
let _lastActiveDate = getActiveDateString();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const now = getActiveDateString();
  if (now === _lastActiveDate) return;
  _lastActiveDate = now;
  checkStreak(); rollover(); applySundayReset();
  loadToday(); loadUpcoming(); renderStreak(); renderQuoteOfDay();
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
  if (LOCAL_MODE) _seedLocalRealisticJobsFromUrl();
  if (LOCAL_MODE) _seedLocalSampleJobsFromUrl();
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('signOutBtn').style.display = '';
  checkStreak(); rollover(); applySundayReset(); renderHabits(); renderReactiveHabits(); loadToday(); loadUpcoming(); renderStreak(); renderJobs(); renderJobSites(); renderReferrals(); renderTechRankings(); renderAreas(); renderGoals(); renderDiet(); renderMobility(); renderWhoop();
  _whoopHandleOAuthReturn();
  _syncSundayResetBtn();
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

loadToday();
loadUpcoming();
renderStreak();

updateDayBar();
setInterval(updateDayBar, 60 * 1000);

renderQuoteOfDay();

loadWeather();
setInterval(loadWeather, WEATHER_MAX_AGE_MS);

renderAreas();
renderGoals();
renderDiet();
renderMobility();
initApp();
