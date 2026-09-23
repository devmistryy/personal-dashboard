// Jobs tab: a Pipeline view (applications grouped by stage, plus job boards,
// referrals and top places), an application page, and a Locations view (map +
// rankings). Loaded before main.js.

// ── Job Applications ──
// 'No reply' is an addition for applications that never got an answer; the
// other names and colours are unchanged.
const JOB_STATUSES = ['Applied','Phone Screen','Interview','Offer','Rejected','No reply'];
const JOB_STATUS_STYLE = {
  'Applied':      { bg:'rgba(186,117,23,0.22)',  color:'#EF9F27' },
  'Phone Screen': { bg:'rgba(55,138,221,0.22)',  color:'#5BADEE' },
  'Interview':    { bg:'rgba(52,199,89,0.18)',   color:'#34C759' },
  'Offer':        { bg:'rgba(29,158,117,0.22)',  color:'#30D158' },
  'Rejected':     { bg:'rgba(226,75,74,0.22)',   color:'#E24B4A' },
  'No reply':     { bg:'rgba(124,147,184,0.18)', color:'#7C93B8' },
};
const JOB_PIPELINE_STEPS = ['Applied','Phone Screen','Interview','Offer'];
const JOB_CLOSED_STATUSES = new Set(['Rejected','No reply']);
const JOB_PLATFORM_STYLE = {
  'LinkedIn':     { bg:'rgba(55,138,221,0.20)', color:'#378ADD' },
  'Indeed':       { bg:'rgba(99,153,34,0.20)',  color:'#97C459' },
  'Company Site': { bg:'rgba(255,255,255,0.10)', color:'rgba(255,255,255,0.75)' },
};
const JOB_PLATFORM_FALLBACK_STYLE = { bg:'rgba(255,255,255,0.08)', color:'var(--text-secondary)' };
const JOB_MAP_VIEWBOX = { x:0, y:8, width:960, height:588 };
const JOB_STALE_DAYS = 30;          // "Applied" this long with no answer → Needs you
const JOB_SCREEN_OUTCOME_DAYS = 5;  // phone screen this long with no outcome → Needs you
const JOB_WEEKLY_GOAL_DEFAULT = 10;
const JOB_GROUP_LIMIT = 12;         // rows shown per group before "Show N more"

// View state. The view and grouping are remembered per browser.
const JOBS_UI_KEY = 'jobs_ui_v1';
let _jobView = 'pipeline';          // 'pipeline' | 'detail' | 'locations'
let _jobGroup = 'stage';            // 'stage' | 'week'
let _jobDetailId = null;
let _jobFilter = null;              // a status, from the pipeline keys
let _jobQuery = '';
let _jobPlaceSel = null;            // { key, label, cityJobs, metroJobs, jobs } picked on the map / rankings
let _jobUiLoaded = false;
const _jobExpanded = {};
const _jobAttnDismissed = new Set();

function _loadJobUi() {
  if (_jobUiLoaded) return;
  _jobUiLoaded = true;
  try {
    const ui = JSON.parse(localStorage.getItem(JOBS_UI_KEY) || '{}');
    if (ui.view === 'locations') _jobView = 'locations';
    if (ui.group === 'week') _jobGroup = 'week';
  } catch { /* optional */ }
}
function _saveJobUi() {
  try { localStorage.setItem(JOBS_UI_KEY, JSON.stringify({ view:_jobView === 'locations' ? 'locations' : 'pipeline', group:_jobGroup })); }
  catch { /* optional */ }
}

function getJobs() { return MEM['jobs:list'] || []; }
function saveJobs(jobs) { MEM['jobs:list'] = jobs; _syncJobs(jobs); }

// User-created Job Role options (settings key, like the job boards catalog
// picks but user-authored) — jobs store the plain role string.
function getJobRoles() { return MEM['job_roles_v1'] || []; }
function saveJobRoles(list) { MEM['job_roles_v1'] = list; _syncSetting('job_roles_v1', list); }
function addJobRole(v) { const r = getJobRoles(); if (!r.includes(v)) saveJobRoles([...r, v]); }

function getJobWeeklyGoal() { return Number(MEM['job_weekly_goal_v1']) > 0 ? Number(MEM['job_weekly_goal_v1']) : JOB_WEEKLY_GOAL_DEFAULT; }
function saveJobWeeklyGoal(n) { MEM['job_weekly_goal_v1'] = n; _syncSetting('job_weekly_goal_v1', n); }

// Per-application extras (posting link, notes, next step, status history)
// live in one `job_applications.meta` jsonb column (master.sql). A brand-new
// application has none, so it saves on a database without the column; the
// history only starts once a status changes.
let _jobsMetaColumn = false;
function _jobMeta(j) {
  const m = {};
  if (j.url) m.url = j.url;
  if (j.notes) m.notes = j.notes;
  if (j.next && j.next.date) m.next = { date:j.next.date, label:j.next.label || '' };
  if (Array.isArray(j.history) && j.history.length) m.history = j.history;
  return Object.keys(m).length ? m : null;
}

// Upsert-only: deletions go through _deleteJobRemote (called directly from
// deleteJob), never inferred by diffing the full remote set against the local
// array. Inferring them broke on a second tab/device: a stale local array
// (this device hasn't loaded a job another device just added) would delete
// that job's row the next time this device saved anything at all.
async function _syncJobs(jobs) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (!jobs.length) return;
  // `meta` only goes out once some application has extras, so a database
  // that hasn't run the master.sql column yet keeps saving everything else.
  const withMeta = _jobsMetaColumn || jobs.some(j => _jobMeta(j));
  const { error } = await sb.from('job_applications').upsert(jobs.map(j => {
    const row = {
      id: j.id, user_id: uid, company: j.company, platform: j.platform || null,
      date_applied: j.dateApplied || null, status: j.status || 'Applied',
      location_type: j.locationType || null,
      location_cities: (j.locationCities && j.locationCities.length) ? j.locationCities : null,
      role: j.role || null,
    };
    if (withMeta) row.meta = _jobMeta(j);
    return row;
  }), { onConflict: 'id' });
  if (error) _syncFailed('job_applications upsert failed', error);
}

async function _deleteJobRemote(id) {
  if (LOCAL_MODE) return;
  const uid = await _requireUid(); if (!uid) return;
  const { error } = await sb.from('job_applications').delete().eq('user_id', uid).eq('id', id);
  if (error) _syncFailed('job_applications delete failed', error);
}

function _jobId() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function _jobIso(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function _todayStr() { return _jobIso(new Date()); }
function _jobDate(ds) { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m-1, d); }
function _jobDaysSince(ds) {
  if (!ds) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((today - _jobDate(ds)) / 864e5);
}
function _jobWeekStart(ds) {
  const d = _jobDate(ds);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return _jobIso(d);
}
function _fmtJobDate(ds) {
  if (!ds) return '—';
  return _jobDate(ds).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}
function _fmtJobShort(ds) {
  if (!ds) return '—';
  return _jobDate(ds).toLocaleDateString('en-US', { month:'short', day:'numeric' });
}

// Status history: stored once a status changes; before that it's derived
// from the date applied (and an undated entry for older applications that
// moved on before history existed).
function _jobHistory(j) {
  if (Array.isArray(j.history) && j.history.length) return j.history;
  const h = [{ status:'Applied', date:j.dateApplied || null }];
  if (j.status && j.status !== 'Applied') h.push({ status:j.status, date:null });
  return h;
}
function _jobStageDate(j) { const h = _jobHistory(j); return h[h.length - 1].date; }
function _jobIsClosed(j) { return JOB_CLOSED_STATUSES.has(j.status); }
function _jobIsStale(j) { return j.status === 'Applied' && (_jobDaysSince(j.dateApplied) ?? 0) >= JOB_STALE_DAYS; }

// _esc() is defined in habits.js (loaded before this file) and shared via the
// global scope — do not redeclare it here. A jobs.js-local copy previously
// shadowed it with a weaker version that didn't escape single quotes.

function _jobStatusPill(j) {
  const ss = JOB_STATUS_STYLE[j.status] || JOB_STATUS_STYLE['Applied'];
  return `<button type="button" class="job-pill" style="background:${ss.bg};color:${ss.color}" data-action="status" data-id="${_esc(j.id)}" aria-label="Status: ${_esc(j.status)}. Change">${_esc(j.status)}</button>`;
}

function _jobPlatformIcon(name) {
  const site = name ? JOB_SITE_CATALOG.find(s => s.name === name) : null;
  if (site) return `<img class="job-platform-logo" src="${_jobSiteLogoUrl(site.domain)}" alt="">`;
  return `<span class="jobs-plat-fallback" aria-hidden="true">${name === 'Company Site' ? '◎' : _esc((name || '?')[0])}</span>`;
}

function _jobLocationText(j) {
  if (j.locationType === 'remote') return { place:'Remote', type:'' };
  const cities = (j.locationCities || []).join(' · ');
  const type = j.locationType === 'hybrid' ? 'hybrid' : j.locationType === 'onsite' ? 'on-site' : '';
  return { place:cities || (type ? '' : '—'), type };
}

// An application listing N cities counts 1/N toward each place, so a
// multi-city posting still adds up to one application on the map and its lists.
function _jobCityShare(j) { return 1 / ((j.locationCities || []).filter(c => String(c).trim()).length || 1); }
function _jobFmtApps(n) { return String(+n.toFixed(2)); }
// Lists show whole numbers: nearest, but any share at all shows as at least 1.
function _jobListCount(n) { return n > 0 ? Math.max(1, Math.round(n)) : 0; }

function _jobReferrer(j) {
  return getReferrals().find(r => r.jobId === j.id && (r.step === 'referred' || r.step === 'thanked' || !r.step));
}

// ── Rendering ──
function renderJobs() {
  _loadJobUi();
  _watchJobsPin();
  renderJobMap();
  _renderJobsView();
  _renderJobsHeader();
  _renderJobsAttention();
  _renderJobsList();
  _renderJobRoles();
  if (_jobView === 'detail') _renderJobDetail();
  if (typeof renderJobSites === 'function') renderJobSites();
}

function _renderJobsView() {
  const views = { pipeline:'jobsPipelineView', detail:'jobsDetailView', locations:'jobsLocationsView' };
  if (_jobView === 'detail' && !_getJobById(_jobDetailId)) _jobView = 'pipeline';
  Object.entries(views).forEach(([v, id]) => { const el = document.getElementById(id); if (el) el.hidden = v !== _jobView; });
  const tab = _jobView === 'locations' ? 'locations' : 'pipeline';
  document.querySelectorAll('.jobs-viewtab').forEach(b => {
    b.classList.toggle('active', b.dataset.jview === tab);
    b.setAttribute('aria-selected', String(b.dataset.jview === tab));
  });
  document.querySelectorAll('[data-jgroup]').forEach(b => b.classList.toggle('active', b.dataset.jgroup === _jobGroup));
}

function _setJobView(view, id) {
  _jobView = view;
  if (id !== undefined) _jobDetailId = id;
  _saveJobUi();
  _renderJobsView();
  if (view === 'detail') _renderJobDetail();
  else _renderJobsList();
  const tab = document.getElementById('tab-jobs');
  if (tab && tab.classList.contains('active')) window.scrollTo({ top:0 });
}

// The column labels stick just under the pinned day strip.
let _jobsPinObserver = null;
function _watchJobsPin() {
  const pin = document.querySelector('.top-pin');
  if (!pin || _jobsPinObserver) return;
  const set = () => {
    const stuck = getComputedStyle(pin).position === 'sticky';
    document.documentElement.style.setProperty('--jobs-pin', stuck ? Math.ceil(pin.getBoundingClientRect().height) + 'px' : '0px');
  };
  _jobsPinObserver = new ResizeObserver(set);
  _jobsPinObserver.observe(pin);
  window.addEventListener('resize', set);
  set();
}

function _renderJobsHeader() {
  const jobs = getJobs();
  const today = _todayStr();
  const weeks = [];
  for (let i = 7; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i * 7); weeks.push(_jobWeekStart(_jobIso(d))); }
  const counts = weeks.map(w => jobs.filter(j => j.dateApplied && _jobWeekStart(j.dateApplied) === w).length);
  const goal = getJobWeeklyGoal();
  const max = Math.max(goal, ...counts, 1);
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  set('jobsWeekLabel', 'Week of ' + _esc(_fmtJobShort(weeks[7])));
  set('jobsWeekCount', String(counts[7]));
  set('jobsWeekSub', `<button type="button" class="jobs-goal-btn" id="jobsGoalBtn" title="Change your weekly goal">${counts[7]} of ${goal}</button> weekly goal · ${jobs.filter(j => j.dateApplied === today).length} today · ${jobs.length} total`);
  set('jobsWeekBars', counts.map((c, i) =>
    `<u class="${i === 7 ? 'now' : c >= goal ? 'hit' : ''}" style="height:${Math.max(2, c / max * 40)}px" title="Week of ${_esc(_fmtJobShort(weeks[i]))}: ${c}"></u>`).join('') +
    `<span class="goal" style="bottom:${goal / max * 40}px"></span>`);

  const n = Object.fromEntries(JOB_STATUSES.map(s => [s, jobs.filter(j => j.status === s).length]));
  set('jobsPipeBar', JOB_STATUSES.filter(s => n[s]).map(s =>
    `<i style="flex-grow:${n[s]};background:${JOB_STATUS_STYLE[s].color};opacity:${_jobFilter && _jobFilter !== s ? 0.25 : 0.9}"></i>`).join(''));
  // Reply rate: of applications at least a week old, the share that got any
  // answer. Median reply: days from applying to the first status change,
  // where the history has both dates.
  const old = jobs.filter(j => (_jobDaysSince(j.dateApplied) ?? 0) >= 7);
  const replied = old.filter(j => j.status !== 'Applied' && j.status !== 'No reply');
  const gaps = jobs.map(j => { const h = _jobHistory(j); return h[1] && h[0].date && h[1].date && h[1].status !== 'No reply' ? Math.round((_jobDate(h[1].date) - _jobDate(h[0].date)) / 864e5) : null; })
    .filter(g => g !== null && g >= 0).sort((a, b) => a - b);
  const stats = [`<span>Reply rate <b>${old.length ? Math.round(replied.length / old.length * 100) + '%' : '—'}</b></span>`];
  if (gaps.length) stats.push(`<span>Median reply <b>${gaps[Math.floor(gaps.length / 2)]}d</b></span>`);
  set('jobsPipeKeys', JOB_STATUSES.map(s =>
    `<button type="button" class="jobs-pk ${_jobFilter === s ? 'on' : ''}" data-jfilter="${_esc(s)}" aria-pressed="${_jobFilter === s}"><i style="background:${JOB_STATUS_STYLE[s].color}"></i>${_esc(s)}<b>${n[s]}</b></button>`).join('') +
    `<span class="jobs-pipe-stats">${stats.join('')}</span>`);
}

function _renderJobsAttention() {
  const el = document.getElementById('jobsAttn');
  if (!el) return;
  const jobs = getJobs();
  const items = [];
  jobs.filter(j => j.status === 'Interview' && !(j.next && j.next.date >= _todayStr())).slice(0, 3).forEach(j =>
    items.push({ key:'int:' + j.id, html:`<b>${_esc(j.company)}</b> · Interview, no date set`, btn:'Set date', act:`open:${j.id}` }));
  jobs.filter(j => j.status === 'Phone Screen' && (_jobDaysSince(_jobStageDate(j)) ?? 0) >= JOB_SCREEN_OUTCOME_DAYS).slice(0, 3).forEach(j =>
    items.push({ key:'ps:' + j.id, html:`<b>${_esc(j.company)}</b> · phone screen ${_jobDaysSince(_jobStageDate(j))}d ago, no outcome logged`, btn:'Log outcome', act:`open:${j.id}` }));
  const stale = jobs.filter(_jobIsStale);
  if (stale.length) items.push({ key:'stale', html:`<b>${stale.length} application${stale.length === 1 ? '' : 's'}</b> with no reply in ${JOB_STALE_DAYS}+ days`, btn:'Mark all no reply', act:'stale' });
  const list = items.filter(x => !_jobAttnDismissed.has(x.key));
  el.hidden = !list.length;
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="jobs-attn-h">Needs you · ${list.length}</div>` + list.map(x =>
    `<div class="jobs-attn-row"><span>${x.html}</span><span class="hab-actions"><button type="button" class="hab-chip" data-attn="${_esc(x.act)}">${x.btn}</button><button type="button" class="jobs-link-btn" data-attn-dismiss="${_esc(x.key)}" aria-label="Dismiss">×</button></span></div>`).join('');
}

// Roles card (Pipeline side column): every role you've applied for, with its
// application count, most first.
function _renderJobRoles() {
  const el = document.getElementById('jobsRoleList');
  if (!el) return;
  const counts = new Map();
  getJobs().forEach(j => { const r = j.role || ''; counts.set(r, (counts.get(r) || 0) + 1); });
  const rows = [...counts].sort((a, b) => b[1] - a[1] || (a[0] || '~').localeCompare(b[0] || '~'));
  const known = getJobRoles();
  known.filter(r => !counts.has(r)).sort((a, b) => a.localeCompare(b)).forEach(r => rows.push([r, 0]));
  el.innerHTML = rows.length
    ? rows.map(([role, n]) => `<li class="jobs-role-row"><span class="${role ? '' : 'none'}">${_esc(role || 'No role')}</span><b>${n}</b>${role && known.includes(role) ? `<button type="button" class="jobs-role-rm" data-jrole-rm="${_esc(role)}" title="Remove role option">×</button>` : ''}</li>`).join('')
    : '<li class="jobs-role-row"><span class="none">No applications yet</span></li>';
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.id !== 'jobRoleAddInput') return;
  const val = e.target.value.trim();
  if (!val) return;
  addJobRole(val);
  e.target.value = '';
  _renderJobRoles();
});

document.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-jrole-rm]');
  if (!rm) return;
  saveJobRoles(getJobRoles().filter(r => r !== rm.dataset.jroleRm));
  _renderJobRoles();
});

function _jobRowHTML(j) {
  const loc = _jobLocationText(j);
  const days = _jobDaysSince(j.dateApplied);
  const ref = _jobReferrer(j);
  const closed = _jobIsClosed(j);
  let sub = '', warn = false;
  if (j.status === 'Applied') {
    if (days === null) sub = '';
    else if (days >= JOB_STALE_DAYS) { sub = `no reply · ${days}d`; warn = true; }
    else sub = days === 0 ? 'today' : `${days}d ago`;
  } else if (closed) {
    sub = _jobStageDate(j) ? _fmtJobShort(_jobStageDate(j)) : '';
  } else {
    const d = _jobDaysSince(_jobStageDate(j));
    sub = d === null ? '' : `${d}d in stage`;
  }
  const next = j.next && j.next.date && !closed ? `<span class="jobs-tag jobs-tag-next" title="${_esc(j.next.label || 'Next step')}">${_esc(_fmtJobShort(j.next.date))}</span>` : '';
  const firstCity = j.locationType === 'remote' ? 'Remote' : ((j.locationCities || [])[0] || '').split(',')[0];
  return `<div class="jobs-row ${closed ? 'closed' : ''}" data-job="${_esc(j.id)}" tabindex="0" role="button" aria-label="${_esc(j.company)}${j.role ? ', ' + _esc(j.role) : ''}, ${_esc(j.status)}. Open">
    <div class="jobs-co"><b>${_esc(j.company)}</b><span class="jobs-role">${_esc(j.role || '')}${firstCity ? `<span class="m-extra">${j.role ? ' · ' : ''}${_esc(firstCity)}</span>` : ''}</span>${ref ? `<span class="jobs-tag jobs-tag-ref">via ${_esc(ref.name.split(' ')[0])}</span>` : ''}${next}</div>
    <div class="jobs-loc"><span title="${_esc(loc.place)}">${_esc(loc.place)}</span>${loc.type ? `<small>${loc.type}</small>` : ''}</div>
    <span class="jobs-plat">${j.platform ? _jobPlatformIcon(j.platform) + `<span>${_esc(j.platform)}</span>` : '<span>—</span>'}</span>
    <div class="jobs-date">${_esc(_fmtJobShort(j.dateApplied))}<small>${days === null ? '' : days === 0 ? 'today' : days + 'd'}</small></div>
    <div class="jobs-stat">${_jobStatusPill(j)}<small class="${warn ? 'warn' : ''}">${_esc(sub)}</small></div>
  </div>`;
}

function _jobGroupHTML(key, title, color, arr, note, collapsible) {
  if (!arr.length) return '';
  const lim = _jobExpanded[key] ? arr.length : JOB_GROUP_LIMIT;
  const rows = arr.slice(0, lim).map(_jobRowHTML).join('');
  const more = arr.length > lim ? `<button type="button" class="jobs-more" data-jmore="${_esc(key)}">Show ${arr.length - lim} more</button>` : '';
  const head = `<div class="hab-group-head"><h3 style="color:${color}">${_esc(title)}</h3><span class="hab-group-ct">${arr.length}</span>${note ? `<span class="hab-group-note">${_esc(note)}</span>` : ''}</div>`;
  if (collapsible) return `<details class="jobs-group" data-jgroupkey="${_esc(key)}" ${_jobExpanded['open:' + key] ? 'open' : ''}><summary>${head}</summary>${rows}${more}</details>`;
  return `<div class="jobs-group">${head}${rows}${more}</div>`;
}

function _renderJobsList() {
  const el = document.getElementById('jobsList');
  if (!el) return;
  const q = _jobQuery.trim().toLowerCase();
  const arr = getJobs().filter(j => (!_jobFilter || j.status === _jobFilter) &&
    (!q || [j.company, j.role, j.platform, j.locationType, ...(j.locationCities || [])].join(' ').toLowerCase().includes(q)));
  if (!getJobs().length) { el.innerHTML = '<div class="jobs-empty">No applications yet. Hit <strong>+ Add application</strong> or press N.</div>'; return; }
  if (!arr.length) { el.innerHTML = `<div class="jobs-empty">No applications match${q ? ` "${_esc(_jobQuery)}"` : ' this filter'}.</div>`; return; }
  const byDate = (a, b) => (b.dateApplied || '').localeCompare(a.dateApplied || '');
  let html = '';
  if (_jobGroup === 'stage') {
    const s = JOB_STATUS_STYLE;
    html += _jobGroupHTML('offer', 'Offer', s['Offer'].color, arr.filter(j => j.status === 'Offer').sort(byDate));
    html += _jobGroupHTML('int', 'Interviewing', s['Interview'].color, arr.filter(j => j.status === 'Interview' || j.status === 'Phone Screen')
      .sort((a, b) => (a.status === 'Interview' ? 0 : 1) - (b.status === 'Interview' ? 0 : 1) || byDate(a, b)));
    html += _jobGroupHTML('wait', 'Waiting', s['Applied'].color, arr.filter(j => j.status === 'Applied').sort(byDate), 'newest first');
    const closed = arr.filter(_jobIsClosed).sort((a, b) => (_jobStageDate(b) || b.dateApplied || '').localeCompare(_jobStageDate(a) || a.dateApplied || ''));
    html += _jobGroupHTML('closed', 'Closed', 'var(--text-tertiary)', closed, 'rejected · no reply', !_jobFilter && !q);
  } else {
    const thisWeek = _jobWeekStart(_todayStr());
    const lastWeek = (() => { const d = _jobDate(thisWeek); d.setDate(d.getDate() - 7); return _jobIso(d); })();
    const weeks = [...new Set(arr.map(j => j.dateApplied ? _jobWeekStart(j.dateApplied) : ''))].sort().reverse();
    weeks.forEach(w => {
      const label = !w ? 'No date' : w === thisWeek ? 'This week' : w === lastWeek ? 'Last week' : 'Week of ' + _fmtJobShort(w);
      html += _jobGroupHTML('w' + w, label, 'var(--text-secondary)', arr.filter(j => (j.dateApplied ? _jobWeekStart(j.dateApplied) : '') === w).sort(byDate));
    });
  }
  el.innerHTML = html;
  el.querySelectorAll('.job-platform-logo').forEach(img => { img.onerror = () => img.remove(); });
}

const JOB_MAP_STATES = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California', CO:'Colorado',
  CT:'Connecticut', DE:'Delaware', FL:'Florida', GA:'Georgia', HI:'Hawaii', ID:'Idaho',
  IL:'Illinois', IN:'Indiana', IA:'Iowa', KS:'Kansas', KY:'Kentucky', LA:'Louisiana',
  ME:'Maine', MD:'Maryland', MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi',
  MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire', NJ:'New Jersey',
  NM:'New Mexico', NY:'New York', NC:'North Carolina', ND:'North Dakota', OH:'Ohio',
  OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina',
  SD:'South Dakota', TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia',
  WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming', DC:'District of Columbia'
};
const _jobMapGeocodes = new Map();
const JOB_MAP_KNOWN_CITIES = {
  'new york city': [-74.0060, 40.7128],
  'new york': [-74.0060, 40.7128],
  'manhattan': [-73.9712, 40.7831],
  'brooklyn': [-73.9442, 40.6782],
  'queens': [-73.7949, 40.7282],
  'bronx': [-73.8648, 40.8448],
  'the bronx': [-73.8648, 40.8448],
  'staten island': [-74.1502, 40.5795],
  'washington, dc': [-77.0365, 38.8951],
  'st. louis': [-90.1994, 38.6270],
  'tysons': [-77.2270, 38.9187],
  'st. paul': [-93.0900, 44.9537],
};
const JOB_MAP_GEOCODE_CACHE_KEY = 'job_map_geocodes_v1';
const _jobMapSavedGeocodes = (() => {
  try { return JSON.parse(localStorage.getItem(JOB_MAP_GEOCODE_CACHE_KEY) || '{}'); }
  catch { return {}; }
})();
const _jobMapGeocodeLanes = Array.from({ length:6 }, () => Promise.resolve());
let _jobMapNextGeocodeLane = 0;
let _jobMapGeometry = null;
let _jobMapLoad = null;
let _jobMapRenderId = 0;
// 'minimal' preserves application-scaled sizing as the backup; 'color' is the current experiment.
const JOB_MAP_MARKER_MODE = 'color';
let _jobMapCityBands = [1, 2, 4, 7];
let _jobMapMetroBands = [1, 2, 4, 7];

function _jobMapStateName(text) {
  const trimmed = text.trim();
  return JOB_MAP_STATES[trimmed.toUpperCase()] ||
    Object.values(JOB_MAP_STATES).find(name => name.toLowerCase() === trimmed.toLowerCase()) || '';
}

function _jobMapGeocode(label) {
  const key = label.toLowerCase().trim();
  if (_jobMapGeocodes.has(key)) return _jobMapGeocodes.get(key);
  if (JOB_MAP_KNOWN_CITIES[key]) {
    const known = Promise.resolve({ coordinate:JOB_MAP_KNOWN_CITIES[key], city:label });
    _jobMapGeocodes.set(key, known);
    return known;
  }
  if (_jobMapSavedGeocodes[key]) {
    const saved = Promise.resolve(_jobMapSavedGeocodes[key]);
    _jobMapGeocodes.set(key, saved);
    return saved;
  }
  const parts = label.split(',').map(s => s.trim()).filter(Boolean);
  const city = parts[0];
  const state = parts.length > 1 ? _jobMapStateName(parts[1]) : '';
  const params = new URLSearchParams({ name: city, count: '20', countryCode: 'US', language: 'en' });
  const lane = _jobMapNextGeocodeLane++ % _jobMapGeocodeLanes.length;
  const pending = _jobMapGeocodeLanes[lane].then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch('https://geocoding-api.open-meteo.com/v1/search?' + params);
        if (!response.ok) throw new Error('Geocoding unavailable');
        const data = await response.json();
        const match = (data.results || []).find(place => place.name.toLowerCase() === city.toLowerCase() &&
          (!state || (place.admin1 || '').toLowerCase() === state.toLowerCase()));
        if (!match) return null;
        const result = { coordinate:[match.longitude, match.latitude], city:match.name };
        _jobMapSavedGeocodes[key] = result;
        try { localStorage.setItem(JOB_MAP_GEOCODE_CACHE_KEY, JSON.stringify(_jobMapSavedGeocodes)); }
        catch { /* Cache is optional. */ }
        return result;
      } catch {
        if (attempt === 2) return null;
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    return null;
  });
  _jobMapGeocodeLanes[lane] = pending;
  _jobMapGeocodes.set(key, pending);
  return pending;
}

function _loadJobMap() {
  if (_jobMapLoad) return _jobMapLoad;
  const loadJson = url => fetch(url).then(response => {
    if (!response.ok) throw new Error('Map unavailable');
    return response.json();
  });
  _jobMapLoad = Promise.all([
    loadJson('vendor/us-states-10m.json'),
    loadJson('vendor/us-metros-2025.json?v=2')
  ]).then(([atlas, metros]) => {
      const states = topojson.feature(atlas, atlas.objects.states).features
        .filter(state => !['72', '78'].includes(String(state.id)));
      const collection = { type:'FeatureCollection', features:states };
      const projection = d3.geoAlbersUsa().fitExtent([[28, 24], [932, 586]], collection);
      _jobMapGeometry = { collection, projection, metros };
      return _jobMapGeometry;
    }).catch(() => null);
  return _jobMapLoad;
}

function _jobMapMetro(metros, coordinate) {
  const contains = metro => coordinate[0] >= metro.bbox[0] && coordinate[0] <= metro.bbox[2] &&
    coordinate[1] >= metro.bbox[1] && coordinate[1] <= metro.bbox[3] &&
    d3.geoContains(metro.geometry, coordinate);
  const orangeCounty = metros.find(metro => metro.id === 'OC');
  if (contains(orangeCounty)) return orangeCounty;
  return metros.find(metro => metro.id !== 'OC' && contains(metro)) || null;
}

const JOB_MAP_RANKED_METRO_IDS = {
  nyc:'35620', 'san-francisco':'41860', 'san-jose':'41940', seattle:'42660', austin:'12420',
  'dc-nova':'47900', 'dallas-fort-worth':'19100', boston:'14460', 'los-angeles':'31080',
  'orange-county':'OC', chicago:'16980', 'raleigh-durham':'39580', philadelphia:'37980',
  'san-diego':'41740', 'denver-boulder':'19740', phoenix:'38060', 'salt-lake-city':'41620',
  baltimore:'12580', charlotte:'16740', nashville:'34980', pittsburgh:'38300',
  'south-florida':'33100', 'minneapolis-st-paul':'33460', portland:'38900', detroit:'19820',
  orlando:'36740', tampa:'45300', 'kansas-city':'28140', columbus:'18140', 'st-louis':'41180',
  jacksonville:'27260', 'san-antonio':'41700', sacramento:'40900', indianapolis:'26900',
  huntsville:'26620', cincinnati:'17140', richmond:'40060', hartford:'25540',
  'inland-empire':'40140', 'hampton-roads':'47260', milwaukee:'33340',
  'colorado-springs':'17820', albany:'10580', omaha:'36540', providence:'39300', boise:'14260',
  dayton:'19340', rochester:'40380', 'des-moines':'19780', 'las-vegas':'29820', honolulu:'46520',
};

function _jobMapMetroDisplayName(metro) {
  if (typeof techMetros === 'undefined') return `${metro.name} metro area`;
  const rankedMetroId = Object.keys(JOB_MAP_RANKED_METRO_IDS).find(id =>
    JOB_MAP_RANKED_METRO_IDS[id] === metro.id);
  const rankedMetro = techMetros.find(item => item.id === rankedMetroId);
  return rankedMetro ? rankedMetro.name : `${metro.name} metro area`;
}

function _jobMapRankedMetro(metros, label) {
  if (typeof techMetros === 'undefined') return null;
  const cityName = _jobMapCityName(label).toLowerCase();
  const rankedMetro = typeof getTechMetroForLocation === 'function'
    ? getTechMetroForLocation(cityName)
    : techMetros.find(metro => (metro.includedAreas || []).some(area => area.toLowerCase() === cityName));
  return rankedMetro ? metros.find(metro => metro.id === JOB_MAP_RANKED_METRO_IDS[rankedMetro.id]) || null : null;
}

function _jobMapCityName(label) {
  const value = String(label).trim();
  if (value.toLowerCase() === 'washington, dc') return value;
  const parts = value.split(',').map(part => part.trim()).filter(Boolean);
  return parts.length > 1 && _jobMapStateName(parts.at(-1)) ? parts.slice(0, -1).join(', ') : value;
}

function _jobMapIsCore(entry) {
  // Blue markers are reserved for ranked cities with a defined major-city core.
  if (!entry.metro || ['OC', '40140'].includes(entry.metro.id)) return false;
  const rankedCities = typeof techCities === 'undefined' ? [] : techCities;
  const cityName = _jobMapCityName(entry.label).toLowerCase();
  return rankedCities.some(city => city.name.toLowerCase() === cityName ||
    (typeof TECH_CITY_APPLICATION_ALIASES !== 'undefined' &&
      (TECH_CITY_APPLICATION_ALIASES[city.name] || []).some(alias => alias.toLowerCase() === cityName)));
}

function _jobMapMarkers(entries) {
  const groups = new Map();
  entries.filter(entry => entry.point).forEach(entry => {
    const key = entry.metro ? `metro:${entry.metro.id}` : `other:${entry.label.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, {
      label:entry.metro ? _jobMapMetroDisplayName(entry.metro) : entry.label,
      metro:entry.metro, kind:entry.metro ? 'metro' : 'other', places:[], jobs:[], jobIds:new Set(),
      corePlaces:[], coreJobs:[], coreJobIds:new Set(), apps:0, coreApps:0, totalX:0, totalY:0, weight:0,
      coreX:0, coreY:0, coreWeight:0,
    });
    const group = groups.get(key);
    group.places.push(entry);
    const weight = entry.apps;
    group.apps += weight;
    group.totalX += entry.point[0] * weight;
    group.totalY += entry.point[1] * weight;
    group.weight += weight;
    entry.jobs.forEach(job => {
      if (group.jobIds.has(job.id)) return;
      group.jobIds.add(job.id);
      group.jobs.push(job);
    });
    if (entry.kind === 'core') {
      group.corePlaces.push(entry);
      group.coreX += entry.point[0] * weight;
      group.coreY += entry.point[1] * weight;
      group.coreWeight += weight;
      group.coreApps += weight;
      entry.jobs.forEach(job => {
        if (group.coreJobIds.has(job.id)) return;
        group.coreJobIds.add(job.id);
        group.coreJobs.push(job);
      });
    }
  });
  const grouped = [...groups.values()];
  const maxMetroApplications = Math.max(...grouped.map(group => group.apps), 1);
  const maxCityApplications = Math.max(...grouped.map(group => group.coreApps), 1);
  return grouped.map(group => {
    group.point = group.coreWeight
      ? [group.coreX / group.coreWeight, group.coreY / group.coreWeight]
      : [group.totalX / group.weight, group.totalY / group.weight];
    group.radius = JOB_MAP_MARKER_MODE === 'numbered'
      ? Math.min(28, 8 + Math.sqrt(group.apps) * 3)
      : 10 + Math.sqrt(group.apps / maxMetroApplications) * 18;
    group.cityRadius = group.coreApps
      ? (JOB_MAP_MARKER_MODE === 'numbered'
        ? Math.min(group.radius - 4, Math.max(7 + Math.max(0, _jobFmtApps(group.coreApps).length - 1) * 3, 3 + Math.sqrt(group.coreApps) * 3))
        : Math.min(group.radius - 5, 4 + Math.sqrt(group.coreApps / maxCityApplications) * 8))
      : 0;
    group.cityColorApps = group.coreApps;
    group.metroColorApps = Math.max(0, group.apps - group.coreApps);
    if (group.coreJobs.length) group.kind = 'composite';
    return group;
  });
}

function _jobMapCityColor(apps) {
  if (apps >= _jobMapCityBands[3]) return '#8b5cf6';
  if (apps >= _jobMapCityBands[2]) return '#0666d6';
  if (apps >= _jobMapCityBands[1]) return '#22c7c3';
  if (apps >= 2) return '#12a968';
  return '#ffffff';
}

function _jobMapMetroColor(apps) {
  if (apps >= _jobMapMetroBands[3]) return '#8b5cf6';
  if (apps >= _jobMapMetroBands[2]) return '#0666d6';
  if (apps >= _jobMapMetroBands[1]) return '#22c7c3';
  if (apps >= 2) return '#12a968';
  return '#ffffff';
}

function _jobMapSpreadMarkers(entries) {
  const mapped = entries.filter(entry => entry.point);
  const isPinned = entry => entry.metro?.id === '35620'; // Keep NYC at its verified anchor.
  mapped.forEach(entry => { entry.displayPoint = [...entry.point]; });
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    for (let i = 0; i < mapped.length; i++) {
      for (let j = i + 1; j < mapped.length; j++) {
        const a = mapped[i], b = mapped[j];
        if (isPinned(a) && isPinned(b)) continue;
        let dx = b.displayPoint[0] - a.displayPoint[0];
        let dy = b.displayPoint[1] - a.displayPoint[1];
        let distance = Math.hypot(dx, dy);
        const minimum = a.radius + b.radius + 8;
        if (distance >= minimum) continue;
        if (distance < 0.01) { dx = 1; dy = 0; distance = 1; }
        const push = (minimum - distance) / 2;
        const aPush = isPinned(a) ? 0 : isPinned(b) ? push * 2 : push;
        const bPush = isPinned(b) ? 0 : isPinned(a) ? push * 2 : push;
        a.displayPoint[0] -= dx / distance * aPush;
        a.displayPoint[1] -= dy / distance * aPush;
        b.displayPoint[0] += dx / distance * bPush;
        b.displayPoint[1] += dy / distance * bPush;
        moved = true;
      }
    }
    mapped.filter(entry => !isPinned(entry)).forEach(entry => {
      entry.displayPoint[0] += (entry.point[0] - entry.displayPoint[0]) * 0.08;
      entry.displayPoint[1] += (entry.point[1] - entry.displayPoint[1]) * 0.08;
      if (entry.kind === 'composite') {
        const dx = entry.displayPoint[0] - entry.point[0];
        const dy = entry.displayPoint[1] - entry.point[1];
        const distance = Math.hypot(dx, dy);
        if (distance > 22) {
          entry.displayPoint[0] = entry.point[0] + dx / distance * 22;
          entry.displayPoint[1] = entry.point[1] + dy / distance * 22;
        }
      }
      entry.displayPoint[0] = Math.max(entry.radius + 4, Math.min(956 - entry.radius, entry.displayPoint[0]));
      entry.displayPoint[1] = Math.max(entry.radius + 4, Math.min(606 - entry.radius, entry.displayPoint[1]));
    });
    if (!moved) break;
  }
}

function _renderJobMetroList(entries) {
  if (typeof setApplicationLocationRankings === 'function') setApplicationLocationRankings(entries);
}

// Fixed colour ranges, the same for the city dot and the metro ring:
// 1 · 2–3 · 4–6 · 7–9 · 10+ (white · green · teal · blue · purple). They used
// to be recalculated from the current maximum, so a colour meant something
// different every week.
function _jobMapColorBands() { return [1, 4, 7, 10]; }

// Techmetro id for a metro geometry id (reverse of JOB_MAP_RANKED_METRO_IDS).
function _jobMapTechMetroId(geoId) {
  return Object.keys(JOB_MAP_RANKED_METRO_IDS).find(id => JOB_MAP_RANKED_METRO_IDS[id] === geoId) || null;
}

// Share-of-applications bar used by the ranking rows: width = the place's share of hybrid + on-site
// applications, colour = its marker colour on the map.
function _jobOnsiteCount() {
  return getJobs().filter(j => j.locationType !== 'remote' && (j.locationCities || []).length).length;
}
function _jobShareBar(n, kind, total) {
  const pct = total ? n / total * 100 : 0;
  const color = kind === 'other' ? '#6b7178' : kind === 'metro' ? _jobMapMetroColor(n) : _jobMapCityColor(n);
  return `<span class="jobs-share-bar" title="${Math.round(pct)}% of ${total} hybrid and on-site application${total === 1 ? '' : 's'}"><i style="width:${pct}%;background:${n ? color : 'transparent'}"></i></span>`;
}

let _jobMapMarkerIndex = new Map();   // selection key → marker <g>

async function renderJobMap() {
  const svg = document.getElementById('jobsMap');
  if (!svg) return;
  const renderId = ++_jobMapRenderId;
  const jobs = getJobs();
  const remoteCount = jobs.filter(job => String(job.locationType || '').toLowerCase() === 'remote').length;
  const locations = new Map();
  jobs.forEach(job => {
    const locationType = String(job.locationType || '').toLowerCase();
    // Hybrid applications are map-eligible when they have one or more cities,
    // just like on-site applications. Only fully remote jobs stay off-map.
    if (locationType === 'remote') return;
    (job.locationCities || []).forEach(city => {
      const label = String(city).trim();
      if (!label) return;
      const key = label.toLowerCase();
      if (!locations.has(key)) locations.set(key, { label, jobs:[], apps:0 });
      locations.get(key).jobs.push(job);
      locations.get(key).apps += _jobCityShare(job);
    });
  });
  const message = document.getElementById('jobsMapMessage');
  const summary = document.getElementById('jobsMapSummary');
  const footer = document.getElementById('jobsMapFooter');
  const stats = document.getElementById('jobsMapStats');
  message.hidden = false;
  message.textContent = 'Loading map…';
  footer.textContent = '';
  if (typeof d3 === 'undefined' || typeof topojson === 'undefined') {
    message.textContent = 'Map library unavailable. Check your connection.';
    return;
  }
  const map = await _loadJobMap();
  if (renderId !== _jobMapRenderId) return;
  if (!map) { message.textContent = 'Map unavailable. Check your connection.'; return; }

  const ns = 'http://www.w3.org/2000/svg';
  svg.replaceChildren();
  const path = d3.geoPath(map.projection);
  map.collection.features.forEach(feature => {
    const state = document.createElementNS(ns, 'path');
    state.setAttribute('class', 'jobs-map-land');
    state.setAttribute('d', path(feature) || '');
    svg.appendChild(state);
  });
  const entries = await Promise.all([...locations.values()].map(async entry =>
    ({ ...entry, place:await _jobMapGeocode(entry.label) })));
  if (renderId !== _jobMapRenderId) return;
  const unmapped = [];
  const mappedJobs = new Set();
  entries.forEach(entry => {
    const point = entry.place && map.projection(entry.place.coordinate);
    if (!point) { unmapped.push(entry.label); return; }
    entry.point = point;
    entry.metro = _jobMapRankedMetro(map.metros, entry.label) || _jobMapMetro(map.metros, entry.place.coordinate);
    entry.kind = entry.metro
      ? (_jobMapIsCore(entry) ? 'core' : 'metro')
      : 'other';
    entry.jobs.forEach(job => mappedJobs.add(job.id));
  });
  const markers = _jobMapMarkers(entries);
  _jobMapCityBands = _jobMapColorBands();
  _jobMapMetroBands = _jobMapColorBands();
  _jobMapSpreadMarkers(markers);
  const tooltip = document.getElementById('jobsMapTooltip');
  _jobMapMarkerIndex = new Map();
  markers.forEach(entry => {
    const point = entry.displayPoint;
    if (Math.hypot(point[0] - entry.point[0], point[1] - entry.point[1]) > 3) {
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('class', 'jobs-map-leader');
      line.setAttribute('x1', entry.point[0]);
      line.setAttribute('y1', entry.point[1]);
      line.setAttribute('x2', point[0]);
      line.setAttribute('y2', point[1]);
      svg.insertBefore(line, svg.querySelector('.jobs-map-marker'));
    }
    const techId = entry.metro ? _jobMapTechMetroId(entry.metro.id) : null;
    const key = techId ? 'm:' + techId : entry.metro ? 'g:' + entry.metro.id : 'o:' + entry.label.toLowerCase();
    const marker = document.createElementNS(ns, 'g');
    marker.setAttribute('class', `jobs-map-marker jobs-map-marker-${entry.kind} jobs-map-marker-${JOB_MAP_MARKER_MODE}${_jobPlaceSel && _jobPlaceSel.key === key ? ' selected' : ''}`);
    marker.setAttribute('transform', `translate(${point[0]},${point[1]})`);
    marker.setAttribute('tabindex', '0');
    marker.setAttribute('role', 'button');
    const cityCount = _jobFmtApps(entry.coreApps);
    const metroCount = _jobFmtApps(entry.apps - entry.coreApps);
    marker.setAttribute('aria-label', entry.kind === 'other' ? `${entry.label}: ${_jobFmtApps(entry.apps)} application${entry.apps === 1 ? '' : 's'}`
      : `${entry.label}: ${entry.coreApps ? `${cityCount} in the major city, ` : ''}${metroCount} in the metro area`);
    const outer = document.createElementNS(ns, 'circle');
    outer.setAttribute('r', entry.radius);
    if (JOB_MAP_MARKER_MODE === 'color' && entry.metro) {
      const metroColor = _jobMapMetroColor(entry.metroColorApps);
      outer.style.stroke = metroColor;
      outer.style.fill = metroColor;
      outer.style.fillOpacity = metroColor === '#ffffff' ? '0.1' : '0.2';
      if (metroColor === '#ffffff') outer.style.strokeOpacity = '0.8';
    }
    marker.appendChild(outer);
    if (entry.cityRadius) {
      const inner = document.createElementNS(ns, 'circle');
      inner.setAttribute('r', entry.cityRadius);
      if (JOB_MAP_MARKER_MODE === 'color') {
        const cityColor = _jobMapCityColor(entry.cityColorApps);
        inner.style.fill = cityColor;
        inner.style.fillOpacity = cityColor === '#ffffff' ? '0.3' : '1';
      }
      marker.appendChild(inner);
    }
    const show = () => {
      tooltip.replaceChildren();
      const title = document.createElement('strong');
      title.textContent = entry.label;
      tooltip.appendChild(title);
      const counts = document.createElement('div');
      counts.className = 'jobs-map-tooltip-counts';
      const row = (label, n, color) => {
        const r = document.createElement('div');
        r.className = 'jobs-map-tooltip-count';
        r.innerHTML = `<span>${label}</span><strong><em class="jobs-map-tooltip-count-number">${n}</em> APPS</strong>`;
        r.querySelector('em').style.color = color;
        counts.appendChild(r);
      };
      if (entry.kind === 'other') row('Applications', _jobFmtApps(entry.apps), 'var(--text-primary)');
      else {
        if (entry.coreApps) row('Major City', cityCount, _jobMapCityColor(entry.cityColorApps));
        row('Metro Area', metroCount, _jobMapMetroColor(entry.metroColorApps));
      }
      tooltip.appendChild(counts);
      tooltip.hidden = false;
      const frame = document.getElementById('jobsMapFrame').getBoundingClientRect();
      tooltip.style.left = Math.min(frame.width - tooltip.offsetWidth - 8, Math.max(8, (point[0] - JOB_MAP_VIEWBOX.x) * frame.width / JOB_MAP_VIEWBOX.width + 12)) + 'px';
      tooltip.style.top = Math.max(8, (point[1] - JOB_MAP_VIEWBOX.y) * frame.height / JOB_MAP_VIEWBOX.height - tooltip.offsetHeight - 8) + 'px';
    };
    const hide = () => { tooltip.hidden = true; };
    marker.addEventListener('mouseenter', show);
    marker.addEventListener('mouseleave', hide);
    marker.addEventListener('focus', show);
    marker.addEventListener('blur', hide);
    const select = () => _selectJobPlace({ key, label:entry.label, cityJobs:entry.coreJobs, metroJobs:entry.jobs.filter(j => !entry.coreJobIds.has(j.id)), jobs:entry.jobs, cityN:entry.coreApps, metroN:entry.apps - entry.coreApps, n:entry.apps, other:entry.kind === 'other' });
    marker.addEventListener('click', select);
    marker.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
    _jobMapMarkerIndex.set(key, marker);
    svg.appendChild(marker);
  });
  _renderJobMetroList(entries);
  const outsideApps = new Set(entries.filter(e => e.point && !e.metro).flatMap(e => e.jobs.map(j => j.id))).size;
  const rankedMetros = new Set(markers.filter(m => m.metro && _jobMapTechMetroId(m.metro.id)).map(m => m.metro.id)).size;
  summary.textContent = `${mappedJobs.size} on the map · ${markers.length} place${markers.length === 1 ? '' : 's'}`;
  stats.innerHTML = [
    [remoteCount, 'Remote'],
    [rankedMetros, 'Ranked metros'],
    [outsideApps, 'Outside a metro'],
    [unmapped.length, "Couldn't place"],
  ].map(([n, l]) => `<div class="jobs-map-stat"><b>${n}</b><span>${l}</span></div>`).join('');
  message.hidden = true;
  if (!entries.length) {
    message.hidden = false;
    message.textContent = jobs.length ? 'Add a city to an on-site or hybrid application to see it here.' : 'Add a job application to start mapping locations.';
  }
  footer.textContent = unmapped.length ? `Could not place: ${unmapped.join(', ')}. Use City, ST in the location field.` : '';
  _renderJobPlaceDetail();
}

// A place picked on the map or in the rankings: highlight it and list its
// applications under the map.
function _selectJobPlace(sel) {
  _jobPlaceSel = _jobPlaceSel && _jobPlaceSel.key === sel.key ? null : sel;
  _jobMapMarkerIndex.forEach((g, key) => g.classList.toggle('selected', !!_jobPlaceSel && _jobPlaceSel.key === key));
  if (typeof renderTechRankings === 'function') renderTechRankings();
  _renderJobPlaceDetail();
}

function _renderJobPlaceDetail() {
  const el = document.getElementById('jobsPlaceDetail');
  const hint = document.getElementById('jobsPlaceHint');
  if (!el) return;
  // Re-read the jobs so status changes made since the pick show up.
  const sel = _jobPlaceSel;
  const live = sel ? sel.jobs.map(j => _getJobById(j.id)).filter(Boolean) : [];
  el.hidden = !sel;
  if (hint) hint.hidden = !!sel;
  if (!sel) { el.innerHTML = ''; return; }
  const counts = sel.other ? `${_jobListCount(sel.n)} application${_jobListCount(sel.n) === 1 ? '' : 's'}`
    : `${sel.cityN ? `Major city ${_jobListCount(sel.cityN)} · ` : ''}Metro area ${_jobListCount(sel.metroN)}`;
  const sorted = live.slice().sort((a, b) => (b.dateApplied || '').localeCompare(a.dateApplied || ''));
  el.innerHTML = `<div class="jobs-side-head"><span class="hab-eyebrow">${_esc(sel.label)} · ${_esc(counts)}</span><button type="button" class="jobs-link-btn" data-place-clear>Clear</button></div>` +
    sorted.slice(0, 12).map(j => {
      const ss = JOB_STATUS_STYLE[j.status] || JOB_STATUS_STYLE['Applied'];
      return `<button type="button" class="jobs-place-line" data-job-open="${_esc(j.id)}"><span>${_esc(j.company)} · ${_esc((j.locationCities || []).join(', '))}</span><span class="job-pill" style="background:${ss.bg};color:${ss.color}">${_esc(j.status)}</span></button>`;
    }).join('') + (sorted.length > 12 ? `<span class="jd-hint">+ ${sorted.length - 12} more</span>` : '');
}

function _getJobById(id) { return getJobs().find(j => j.id === id); }

// Renders into an already-open job-dropdown: existing role options (click to
// assign, × to remove from the list) plus an input to create a new one.
// Re-invoked in place after add/remove so the list stays current without
// closing the dropdown.
function _renderJobRoleDropdown(dd, id) {
  const roles = getJobRoles();
  const job = _getJobById(id);
  dd.innerHTML = '';
  if (!roles.length) {
    const empty = document.createElement('div');
    empty.className = 'job-dd-empty';
    empty.textContent = 'No roles yet';
    dd.appendChild(empty);
  }
  roles.forEach(role => {
    const item = document.createElement('div');
    item.className = 'job-dd-item job-dd-item-removable';
    if (job && job.role === role) item.style.background = 'rgba(255,255,255,0.07)';
    const label = document.createElement('span');
    label.className = 'job-dd-item-label';
    label.textContent = role;
    item.appendChild(label);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'job-dd-item-remove';
    rm.textContent = '×';
    rm.title = 'Remove role option';
    rm.addEventListener('click', (ev) => {
      ev.stopPropagation();
      saveJobRoles(getJobRoles().filter(r => r !== role));
      _renderJobRoleDropdown(dd, id);
    });
    item.appendChild(rm);
    item.addEventListener('click', () => { _updateJob(id, { role }); _closeJobDropdown(); });
    dd.appendChild(item);
  });
  const addRow = document.createElement('div');
  addRow.className = 'job-dd-add-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'job-loc-city-input';
  input.placeholder = '+ Add a role…';
  addRow.appendChild(input);
  dd.appendChild(addRow);
  input.addEventListener('click', ev => ev.stopPropagation());
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') {
      const val = input.value.trim();
      if (!val) return;
      addJobRole(val);
      _updateJob(id, { role: val });
      _closeJobDropdown();
    }
    if (ev.key === 'Escape') _closeJobDropdown();
  });
  // preventScroll: this input sits after every existing role in the list, so a
  // plain .focus() scrolls the (possibly tall, scrollable) dropdown down to
  // reveal it — hiding the very options list the dropdown opened to show.
  setTimeout(() => input.focus({ preventScroll: true }), 0);
}

function _updateJob(id, patch) {
  const jobs = getJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return;
  Object.assign(jobs[idx], patch);
  saveJobs(jobs);
  renderJobs();
  if ('platform' in patch) renderJobSites();
}

// Dropdown
let _jddCloseHandler = null;
function _openJobDropdown(triggerEl, buildFn) {
  const dd = document.getElementById('jobDropdown');
  buildFn(dd);
  const rect = triggerEl.getBoundingClientRect();
  dd.style.display = 'block';
  // dd is a single shared element reused by every dropdown (status, platform,
  // role, job-site picker, ...) and is only ever hidden, never removed — so a
  // scroll position left over from a previous, taller dropdown (e.g. the job
  // site picker scrolled halfway down) would otherwise carry over and open
  // this one already scrolled past its first items. Must run after `display`
  // is set to 'block' — assigning scrollTop on a display:none element is a
  // silent no-op.
  dd.scrollTop = 0;
  const ddW = 180;
  let left = rect.left;
  if (left + ddW > window.innerWidth - 8) left = window.innerWidth - ddW - 8;
  dd.style.left = left + 'px';
  dd.style.top = (rect.bottom + 5) + 'px';
  // Flip above the trigger (or clamp) when there isn't room below — otherwise a
  // long list (e.g. the job site picker) renders partly off-screen with no way
  // to reach the rest, since the dropdown is position:fixed.
  const ddH = dd.getBoundingClientRect().height;
  if (rect.bottom + 5 + ddH > window.innerHeight - 8) {
    const above = rect.top - 5 - ddH;
    dd.style.top = (above >= 8 ? above : Math.max(8, window.innerHeight - ddH - 8)) + 'px';
  }
  if (_jddCloseHandler) document.removeEventListener('click', _jddCloseHandler, true);
  _jddCloseHandler = (e) => {
    if (!dd.contains(e.target) && e.target !== triggerEl) {
      dd.style.display = 'none';
      document.removeEventListener('click', _jddCloseHandler, true);
      _jddCloseHandler = null;
    }
  };
  setTimeout(() => document.addEventListener('click', _jddCloseHandler, true), 0);
}
function _closeJobDropdown() {
  document.getElementById('jobDropdown').style.display = 'none';
  if (_jddCloseHandler) { document.removeEventListener('click', _jddCloseHandler, true); _jddCloseHandler = null; }
}

// Table click delegation
document.addEventListener('click', (e) => {
  // Status — Rejected / No reply sit under a divider: they end the pipeline.
  const statusEl = e.target.closest('[data-action="status"]');
  if (statusEl) {
    const id = statusEl.dataset.id;
    const cur = _getJobById(id)?.status;
    _openJobDropdown(statusEl, (dd) => {
      dd.innerHTML = JOB_STATUSES.map(s => {
        const c = JOB_STATUS_STYLE[s].color;
        return (s === 'Rejected' ? '<div class="job-dd-sep"></div>' : '') +
          `<div class="job-dd-item ${s === cur ? 'cur' : ''}" data-status="${s}"><span class="job-dd-dot" style="background:${c}"></span>${s}</div>`;
      }).join('');
      dd.querySelectorAll('[data-status]').forEach(item => {
        item.addEventListener('click', () => { _closeJobDropdown(); _setJobStatus(id, item.dataset.status); });
      });
    });
    return;
  }
  // Platform — options are the user's ranked Job Boards list, plus a fixed
  // "Company Site" catch-all for applications made directly on an employer's site.
  const platEl = e.target.closest('[data-action="platform"]');
  if (platEl) {
    const id = platEl.dataset.id;
    const job = _getJobById(id);
    const sites = getJobSites().map(_jobSiteCatalogEntry).filter(Boolean);
    sites.push({ name: 'Company Site', domain: null });
    // Keep the job's already-assigned platform selectable even if its board
    // was since removed from Job Boards — otherwise there'd be no way to see
    // or change it without re-adding the board first.
    if (job && job.platform && !sites.some(s => s.name === job.platform)) {
      sites.unshift(JOB_SITE_CATALOG.find(s => s.name === job.platform) || { name: job.platform, domain: null });
    }
    _openJobDropdown(platEl, (dd) => {
      dd.innerHTML = sites.map(s => {
        const ps = JOB_PLATFORM_STYLE[s.name] || JOB_PLATFORM_FALLBACK_STYLE;
        const logo = s.domain ? `<img class="job-platform-logo" src="${_jobSiteLogoUrl(s.domain)}" alt="">` : '';
        return `<div class="job-dd-item" data-platform="${_esc(s.name)}"><span class="job-pill job-pill-platform" style="background:${ps.bg};color:${ps.color};font-size:11px;padding:2px 8px;">${logo}${_esc(s.name)}</span></div>`;
      }).join('');
      dd.querySelectorAll('.job-platform-logo').forEach(img => { img.onerror = () => img.remove(); });
      dd.querySelectorAll('[data-platform]').forEach(item => {
        item.addEventListener('click', () => { _updateJob(id, { platform: item.dataset.platform }); _closeJobDropdown(); });
      });
    });
    return;
  }
  // Job Role — options the user creates themselves, managed right in this
  // dropdown (type + Enter to add, × to remove) rather than a separate screen.
  const roleEl = e.target.closest('[data-action="role"]');
  if (roleEl) {
    const id = roleEl.dataset.id;
    _openJobDropdown(roleEl, (dd) => _renderJobRoleDropdown(dd, id));
    return;
  }
  // Location — locationType is a single choice (remote/hybrid/onsite can't mix
  // on one application), but hybrid/onsite can list more than one city (e.g.
  // an onsite role open to either of two offices).
  const locEl = e.target.closest('[data-action="location"]');
  if (locEl) {
    const id = locEl.dataset.id;
    const job = _getJobById(id);
    let selType = job?.locationType || null;
    _openJobDropdown(locEl, (dd) => {
      dd.innerHTML = `
        <div class="job-dd-item" data-loctype="remote">Remote</div>
        <div class="job-dd-item" data-loctype="hybrid">Hybrid</div>
        <div class="job-dd-item" data-loctype="onsite">On-site</div>
        <div id="jobLocCitiesWrap" style="display:none;padding:4px 8px 6px;">
          <div id="jobLocCityChips" class="job-loc-city-chips"></div>
          <input class="job-loc-city-input" id="jobLocCityInput" placeholder="City, ST (e.g. Irvine, CA)">
        </div>`;
      dd.querySelectorAll('[data-loctype]').forEach(item => {
        if (item.dataset.loctype === selType) item.style.fontWeight = '500';
      });
      const renderChips = () => {
        const chips = document.getElementById('jobLocCityChips');
        (_getJobById(id)?.locationCities || []).forEach((city, i) => {
          const chip = document.createElement('span');
          chip.className = 'job-loc-city-chip';
          const label = document.createElement('span');
          label.textContent = city;
          chip.appendChild(label);
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'job-loc-city-chip-remove';
          rm.textContent = '×';
          rm.title = 'Remove this location';
          rm.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const cur = (_getJobById(id)?.locationCities || []).filter((_, ci) => ci !== i);
            _updateJob(id, { locationType: selType, locationCities: cur });
            chips.innerHTML = '';
            renderChips();
          });
          chip.appendChild(rm);
          chips.appendChild(chip);
        });
      };
      // Wires up the city input's Enter-to-add / Escape-to-close behavior.
      // Called both when the dropdown opens already on hybrid/onsite (i.e. a
      // city is already listed) and right after switching to hybrid/onsite —
      // previously this only ran on the switch, so reopening a dropdown that
      // was already hybrid/onsite left the input dead (Enter did nothing).
      const wireCityInput = () => {
        const ci = document.getElementById('jobLocCityInput');
        ci.onclick = ev2 => ev2.stopPropagation();
        ci.onkeydown = ev2 => {
          if (ev2.key === 'Enter') {
            const val = ci.value.trim();
            if (!val) return;
            const cur = _getJobById(id)?.locationCities || [];
            if (!cur.some(c => c.toLowerCase() === val.toLowerCase())) {
              _updateJob(id, { locationType: selType, locationCities: [...cur, val] });
              document.getElementById('jobLocCityChips').innerHTML = '';
              renderChips();
            }
            ci.value = '';
          }
          if (ev2.key === 'Escape') _closeJobDropdown();
        };
      };
      if (selType === 'hybrid' || selType === 'onsite') {
        document.getElementById('jobLocCitiesWrap').style.display = 'block';
        renderChips();
        wireCityInput();
      }
      dd.querySelectorAll('[data-loctype]').forEach(item => {
        item.addEventListener('click', (ev) => {
          ev.stopPropagation();
          selType = item.dataset.loctype;
          dd.querySelectorAll('[data-loctype]').forEach(i => i.style.fontWeight = '');
          item.style.fontWeight = '500';
          if (selType === 'remote') {
            _updateJob(id, { locationType:'remote', locationCities:[] });
            _closeJobDropdown();
          } else {
            _updateJob(id, { locationType: selType });
            const wrap = document.getElementById('jobLocCitiesWrap');
            wrap.style.display = 'block';
            document.getElementById('jobLocCityChips').innerHTML = '';
            renderChips();
            const ci = document.getElementById('jobLocCityInput');
            ci.value = '';
            ci.focus();
            wireCityInput();
          }
        });
      });
    });
    return;
  }
});

// Company name inline save
document.addEventListener('blur', (e) => {
  if (!e.target.classList.contains('job-company-name')) return;
  const id = e.target.dataset.id;
  if (!id) return;
  const jobs = getJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return;
  const name = e.target.textContent.trim();
  if (!name) { e.target.textContent = jobs[idx].company; return; }
  if (jobs[idx].company !== name) {
    jobs[idx].company = name;
    saveJobs(jobs);
    renderReferrals(); // a referral may be linked to this job's company
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('job-company-name')) { e.preventDefault(); e.target.blur(); }
});

// ── Job Boards (ranked list of job listing sites) ──
// A fixed catalog of well-known sites, each with a logo + link already set up —
// the user just picks which ones to rank (drag to reorder) rather than typing
// in a name and URL by hand. Add a new option here to make it pickable.
const JOB_SITE_CATALOG = [
  { key: 'linkedin',      name: 'LinkedIn',      domain: 'linkedin.com',      url: 'https://www.linkedin.com/jobs' },
  { key: 'indeed',        name: 'Indeed',        domain: 'indeed.com',        url: 'https://www.indeed.com' },
  { key: 'glassdoor',     name: 'Glassdoor',     domain: 'glassdoor.com',     url: 'https://www.glassdoor.com' },
  { key: 'ziprecruiter',  name: 'ZipRecruiter',  domain: 'ziprecruiter.com',  url: 'https://www.ziprecruiter.com' },
  { key: 'wellfound',     name: 'Wellfound',     domain: 'wellfound.com',     url: 'https://wellfound.com' },
  { key: 'builtin',       name: 'Built In',      domain: 'builtin.com',       url: 'https://builtin.com' },
  { key: 'monster',       name: 'Monster',       domain: 'monster.com',       url: 'https://www.monster.com' },
  { key: 'dice',          name: 'Dice',          domain: 'dice.com',          url: 'https://www.dice.com' },
  { key: 'handshake',     name: 'Handshake',     domain: 'joinhandshake.com', url: 'https://joinhandshake.com' },
  { key: 'hired',         name: 'Hired',         domain: 'hired.com',         url: 'https://hired.com' },
  { key: 'simplyhired',   name: 'SimplyHired',   domain: 'simplyhired.com',   url: 'https://www.simplyhired.com' },
  { key: 'careerbuilder', name: 'CareerBuilder', domain: 'careerbuilder.com', url: 'https://www.careerbuilder.com' },
  { key: 'usajobs',       name: 'USAJOBS',       domain: 'usajobs.gov',       url: 'https://www.usajobs.gov' },
];
function _jobSiteCatalogEntry(key) { return JOB_SITE_CATALOG.find(s => s.key === key); }
function _jobSiteLogoUrl(domain) { return `https://www.google.com/s2/favicons?sz=64&domain=${domain}`; }

// MEM['job_sites_v1'] is just an array of catalog keys — rank = position.
function getJobSites() { return MEM['job_sites_v1'] || []; }
function saveJobSites(keys) { MEM['job_sites_v1'] = keys; _syncSetting('job_sites_v1', keys); }

let _jobSiteDragFrom = null;

// Each board shows its reply rate: of its applications at least a week old,
// the share that got any answer. "Company Site" is listed last, unranked.
function _jobReplyStats(name) {
  const apps = getJobs().filter(j => j.platform === name);
  const old = apps.filter(j => (_jobDaysSince(j.dateApplied) ?? 0) >= 7);
  const replied = old.filter(j => j.status !== 'Applied' && j.status !== 'No reply').length;
  return { apps:apps.length, pct:old.length ? Math.round(replied / old.length * 100) : null };
}

function renderJobSites() {
  const list = document.getElementById('jobSiteList');
  if (!list) return;
  const keys = getJobSites();
  list.innerHTML = '';
  keys.forEach((key, idx) => {
    const site = _jobSiteCatalogEntry(key);
    if (site) list.appendChild(buildJobSiteRow(site, idx, _jobReplyStats(site.name)));
  });
  const direct = _jobReplyStats('Company Site');
  if (direct.apps) list.appendChild(buildJobSiteRow({ key:null, name:'Company Site', domain:null, url:null }, -1, direct));
  const empty = document.getElementById('jobSiteEmptyState');
  if (empty) empty.style.display = keys.length ? 'none' : 'block';
  const addBtn = document.getElementById('jobSiteAddBtn');
  if (addBtn) addBtn.style.display = keys.length >= JOB_SITE_CATALOG.length ? 'none' : '';
}

function _buildSiteLogo(site) {
  const img = document.createElement('img');
  img.className = 'job-site-logo';
  img.src = _jobSiteLogoUrl(site.domain);
  img.alt = '';
  img.loading = 'lazy';
  img.onerror = () => {
    const fallback = document.createElement('span');
    fallback.className = 'job-site-logo-fallback';
    fallback.textContent = site.name[0].toUpperCase();
    img.replaceWith(fallback);
  };
  return img;
}

function buildJobSiteRow(site, idx, stats) {
  const li = document.createElement('li');
  li.className = 'job-site-row' + (site.key ? '' : ' fixed');
  const drag = document.createElement('span');
  drag.className = 'job-site-drag';
  drag.setAttribute('aria-hidden', 'true');
  if (site.key) {
    li.dataset.key = site.key;
    li.draggable = true;
    drag.textContent = '⋮⋮';
    _wireJobSiteDrag(li, site.key);
  }
  li.appendChild(drag);

  const rank = document.createElement('span');
  rank.className = 'job-site-rank';
  rank.textContent = site.key ? idx + 1 : '';
  li.appendChild(rank);

  if (site.domain) li.appendChild(_buildSiteLogo(site));
  else { const f = document.createElement('span'); f.className = 'job-site-logo-fallback'; f.textContent = '◎'; li.appendChild(f); }

  const main = document.createElement('div');
  main.className = 'job-site-main';
  const name = document.createElement(site.url ? 'a' : 'span');
  name.className = 'job-site-name';
  if (site.url) { name.href = site.url; name.target = '_blank'; name.rel = 'noopener noreferrer'; }
  name.textContent = site.name;
  main.appendChild(name);
  const rate = document.createElement('div');
  rate.className = 'job-site-rate';
  rate.innerHTML = `<i style="width:${stats.pct || 0}%"></i>`;
  main.appendChild(rate);
  li.appendChild(main);

  const countEl = document.createElement('span');
  countEl.className = 'job-site-count';
  countEl.innerHTML = `<b>${stats.pct === null ? '—' : stats.pct + '%'}</b><br>${stats.apps} app${stats.apps === 1 ? '' : 's'}`;
  countEl.title = stats.pct === null ? 'No applications older than a week yet' : `${stats.pct}% of applications older than a week got a reply`;
  li.appendChild(countEl);

  if (site.key) {
    const del = document.createElement('button');
    del.className = 'job-site-delete';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Remove from ranking';
    del.addEventListener('click', () => deleteJobSite(site.key));
    li.appendChild(del);
  }
  return li;
}

function deleteJobSite(key) {
  saveJobSites(getJobSites().filter(k => k !== key));
  renderJobSites();
}

function _wireJobSiteDrag(li, key) {
  li.addEventListener('dragstart', e => {
    _jobSiteDragFrom = key;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => li.classList.add('dragging'), 0);
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    document.querySelectorAll('#jobSiteList .job-site-row').forEach(r => r.classList.remove('drag-over'));
  });
  li.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('#jobSiteList .job-site-row').forEach(r => r.classList.remove('drag-over'));
    if (key !== _jobSiteDragFrom) li.classList.add('drag-over');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
  li.addEventListener('drop', e => {
    e.preventDefault();
    li.classList.remove('drag-over');
    if (_jobSiteDragFrom == null || _jobSiteDragFrom === key) return;
    const keys = getJobSites();
    const from = keys.indexOf(_jobSiteDragFrom);
    const to   = keys.indexOf(key);
    if (from < 0 || to < 0) return;
    const [moved] = keys.splice(from, 1);
    keys.splice(to, 0, moved);
    saveJobSites(keys);
    _jobSiteDragFrom = null;
    renderJobSites();
  });
}

// "+ Add a job site" — pick from the catalog entries not already ranked.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#jobSiteAddBtn');
  if (!btn) return;
  const already = new Set(getJobSites());
  const available = JOB_SITE_CATALOG.filter(s => !already.has(s.key));
  _openJobDropdown(btn, (dd) => {
    dd.innerHTML = '';
    if (!available.length) {
      const empty = document.createElement('div');
      empty.className = 'job-site-picker-empty';
      empty.textContent = 'All sites added';
      dd.appendChild(empty);
      return;
    }
    available.forEach(site => {
      const item = document.createElement('div');
      item.className = 'job-dd-item job-site-picker-item';
      item.appendChild(_buildSiteLogo(site));
      const label = document.createElement('span');
      label.textContent = site.name;
      item.appendChild(label);
      item.addEventListener('click', () => {
        const keys = getJobSites();
        keys.push(site.key);
        saveJobSites(keys);
        renderJobSites();
        _closeJobDropdown();
      });
      dd.appendChild(item);
    });
  });
});

// ── Referrals ──
// People who can refer the user into a company. Each entry optionally links
// to a job_applications row (by id) so the shown company always tracks that
// application's current company name rather than a copy typed at link time.
function getReferrals() { return MEM['referrals:list'] || []; }
function saveReferrals(list) { MEM['referrals:list'] = list; _syncReferrals(list); }
function _referralId() {
  return 'rf_' + ((crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

// Upsert-only, like _syncJobs — deletion is handled separately by
// _deleteReferralRemote (called directly from deleteReferral), not inferred
// by diffing the full remote set against this local array. Inferring deletes
// that way broke on a second tab/device: a local array that simply hadn't
// loaded a referral added elsewhere would delete that referral's row the
// next time this device saved anything (e.g. an unrelated name edit).
// `step` (To ask → Asked → Referred → Thanked) is a master.sql column; like
// jobs' meta it only goes out once some referral has one.
let _referralsStepColumn = false;
async function _syncReferrals(referrals) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (!referrals.length) return;
  const withStep = _referralsStepColumn || referrals.some(r => r.step);
  const { error } = await sb.from('referrals').upsert(referrals.map((r, i) => {
    const row = { id: r.id, user_id: uid, name: r.name, job_id: r.jobId || null,
      sort_order: i, created_at: r.createdAt || null };
    if (withStep) row.step = r.step || null;
    return row;
  }), { onConflict: 'id' });
  if (error) _syncFailed('referrals upsert failed', error);
}

async function _deleteReferralRemote(id) {
  if (LOCAL_MODE) return;
  const uid = await _requireUid(); if (!uid) return;
  const { error } = await sb.from('referrals').delete().eq('user_id', uid).eq('id', id);
  if (error) _syncFailed('referrals delete failed', error);
}

function _updateReferral(id, patch) {
  const referrals = getReferrals();
  const idx = referrals.findIndex(r => r.id === id);
  if (idx === -1) return;
  Object.assign(referrals[idx], patch);
  saveReferrals(referrals);
  renderReferrals();
}

function deleteReferral(id) {
  saveReferrals(getReferrals().filter(r => r.id !== id));
  _deleteReferralRemote(id);
  renderReferrals();
}

const REFERRAL_STEPS = ['ask', 'asked', 'referred', 'thanked'];
const REFERRAL_STEP_LABEL = { ask:'To ask', asked:'Asked', referred:'Referred', thanked:'Thanked' };
// Older referrals have no step: linked ones count as referred.
function _referralStep(r) { return r.step || (r.jobId ? 'referred' : 'ask'); }

function buildReferralRow(r) {
  const li = document.createElement('li');
  li.className = 'referral-row';
  li.dataset.id = r.id;

  const name = document.createElement('span');
  name.className = 'referral-name';
  name.contentEditable = 'true';
  name.spellcheck = false;
  name.dataset.id = r.id;
  name.textContent = r.name;
  li.appendChild(name);

  const step = _referralStep(r);
  const stepBtn = document.createElement('button');
  stepBtn.type = 'button';
  stepBtn.className = 'referral-step';
  stepBtn.dataset.step = step;
  stepBtn.textContent = REFERRAL_STEP_LABEL[step];
  stepBtn.title = 'Click to move to the next step';
  stepBtn.addEventListener('click', () => {
    _updateReferral(r.id, { step:REFERRAL_STEPS[(REFERRAL_STEPS.indexOf(step) + 1) % REFERRAL_STEPS.length] });
    renderJobs();
  });
  li.appendChild(stepBtn);

  const del = document.createElement('button');
  del.className = 'referral-delete';
  del.type = 'button';
  del.textContent = '×';
  del.title = 'Remove referral';
  del.addEventListener('click', () => { deleteReferral(r.id); renderJobs(); });
  li.appendChild(del);

  const job = r.jobId ? _getJobById(r.jobId) : null;
  const company = document.createElement('button');
  company.type = 'button';
  company.className = 'referral-company';
  company.dataset.action = 'referral-company';
  company.dataset.id = r.id;
  company.textContent = job ? job.company : 'Link a company';
  li.appendChild(company);

  return li;
}

function renderReferrals() {
  const list = document.getElementById('referralList');
  if (!list) return;
  const referrals = getReferrals();
  list.innerHTML = '';
  referrals.forEach(r => list.appendChild(buildReferralRow(r)));
  const empty = document.getElementById('referralEmptyState');
  if (empty) empty.style.display = referrals.length ? 'none' : 'block';
}

// Referral name inline save (mirrors the job company-name pattern above).
document.addEventListener('blur', (e) => {
  if (!e.target.classList.contains('referral-name')) return;
  const id = e.target.dataset.id;
  if (!id) return;
  const referrals = getReferrals();
  const idx = referrals.findIndex(r => r.id === id);
  if (idx === -1) return;
  const name = e.target.textContent.trim();
  if (!name) { e.target.textContent = referrals[idx].name; return; }
  if (referrals[idx].name !== name) { referrals[idx].name = name; saveReferrals(referrals); }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('referral-name')) { e.preventDefault(); e.target.blur(); }
});

// Add new referral
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.id !== 'referralAddInput') return;
  const name = e.target.value.trim();
  if (!name) return;
  const referrals = getReferrals();
  referrals.unshift({ id: _referralId(), name, jobId: null, createdAt: new Date().toISOString() });
  saveReferrals(referrals);
  e.target.value = '';
  renderReferrals();
});

// Company link picker — distinct companies from the Job Applications table,
// plus "Unlink" when the referral currently has one.
document.addEventListener('click', (e) => {
  const pill = e.target.closest('[data-action="referral-company"]');
  if (!pill) return;
  const id = pill.dataset.id;
  const referral = getReferrals().find(r => r.id === id);
  const byCompany = new Map();
  getJobs().forEach(j => {
    if (!j.company) return;
    const existing = byCompany.get(j.company);
    if (!existing || (j.dateApplied || '') > (existing.dateApplied || '')) byCompany.set(j.company, j);
  });
  const options = [...byCompany.values()];
  _openJobDropdown(pill, (dd) => {
    dd.innerHTML = '';
    if (referral && referral.jobId) {
      const unlink = document.createElement('div');
      unlink.className = 'job-dd-item';
      unlink.textContent = 'Unlink';
      unlink.addEventListener('click', () => { _updateReferral(id, { jobId: null }); _closeJobDropdown(); renderJobs(); });
      dd.appendChild(unlink);
    }
    if (!options.length) {
      const empty = document.createElement('div');
      empty.className = 'job-site-picker-empty';
      empty.textContent = 'Add a job application first';
      dd.appendChild(empty);
      return;
    }
    options.forEach(job => {
      const item = document.createElement('div');
      item.className = 'job-dd-item';
      item.textContent = job.company;
      item.addEventListener('click', () => { _updateReferral(id, { jobId: job.id }); _closeJobDropdown(); renderJobs(); });
      dd.appendChild(item);
    });
  });
});

// Freeform notes about referrals in general (settings key — a single blob
// shaped { text, updatedAt } rather than the plain string other settings use,
// so the modal can show a "Saved HH:MM" timestamp across reopens).
function getReferralNotesData() {
  const raw = MEM['referral_notes_v1'];
  if (!raw) return { text: '', updatedAt: null };
  if (typeof raw === 'string') return { text: raw, updatedAt: null }; // pre-timestamp shape
  return { text: raw.text || '', updatedAt: raw.updatedAt || null };
}
function saveReferralNotesData(text) {
  const data = { text, updatedAt: new Date().toISOString() };
  MEM['referral_notes_v1'] = data;
  _syncSetting('referral_notes_v1', data);
  return data;
}

let _referralNotesAutosaveTimer = null;

function _referralNotesWordCount() {
  const val = document.getElementById('referralNotesInput').value.trim();
  const words = val ? val.split(/\s+/).length : 0;
  document.getElementById('referralNotesCount').textContent = words + (words === 1 ? ' word' : ' words');
}

function _renderReferralNotesSavedStatus(updatedAt) {
  const status = document.getElementById('referralNotesStatus');
  if (!updatedAt) { status.textContent = ''; return; }
  const time = new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  status.textContent = 'Saved ' + time;
}

function saveReferralNotesForm() {
  clearTimeout(_referralNotesAutosaveTimer);
  const data = saveReferralNotesData(document.getElementById('referralNotesInput').value);
  _renderReferralNotesSavedStatus(data.updatedAt);
}

function _scheduleReferralNotesAutosave() {
  document.getElementById('referralNotesStatus').textContent = 'Saving…';
  clearTimeout(_referralNotesAutosaveTimer);
  _referralNotesAutosaveTimer = setTimeout(saveReferralNotesForm, 700);
}

function openReferralNotesModal() {
  const data = getReferralNotesData();
  document.getElementById('referralNotesInput').value = data.text;
  _referralNotesWordCount();
  _renderReferralNotesSavedStatus(data.updatedAt);
  const modal = document.getElementById('referralNotesModal');
  modal.classList.add('open');
  modal.querySelector('.sr-modal-card').scrollTop = 0;
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('referralNotesInput').focus(), 0);
}
function closeReferralNotesModal() {
  if (_referralNotesAutosaveTimer) saveReferralNotesForm(); // flush a pending debounce so nothing typed is lost
  document.getElementById('referralNotesModal').classList.remove('open');
  document.body.style.overflow = '';
}

// Markdown-ish insert helpers for the toolbar — prefix buttons act on the
// current line, the date button inserts plain text at the caret.
function _referralNotesInsertAtLineStart(prefix) {
  const ta = document.getElementById('referralNotesInput');
  const pos = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
  ta.value = ta.value.slice(0, lineStart) + prefix + ta.value.slice(lineStart);
  const newPos = pos + prefix.length;
  ta.setSelectionRange(newPos, newPos);
}
function _referralNotesInsertAtCursor(text) {
  const ta = document.getElementById('referralNotesInput');
  const start = ta.selectionStart, end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const newPos = start + text.length;
  ta.setSelectionRange(newPos, newPos);
}

document.querySelectorAll('.referral-notes-tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.insert;
    if (kind === 'heading') _referralNotesInsertAtLineStart('## ');
    else if (kind === 'bullet') _referralNotesInsertAtLineStart('- ');
    else if (kind === 'checkbox') _referralNotesInsertAtLineStart('- [ ] ');
    else if (kind === 'date') _referralNotesInsertAtCursor(new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
    document.getElementById('referralNotesInput').focus();
    _referralNotesWordCount();
    _scheduleReferralNotesAutosave();
  });
});

document.getElementById('referralNotesInput').addEventListener('input', () => {
  _referralNotesWordCount();
  _scheduleReferralNotesAutosave();
});

document.getElementById('referralNotesOpenBtn').addEventListener('click', openReferralNotesModal);
document.getElementById('referralNotesClose').addEventListener('click', closeReferralNotesModal);
document.getElementById('referralNotesSaveBtn').addEventListener('click', saveReferralNotesForm);
document.getElementById('referralNotesModal').addEventListener('click', (e) => {
  if (e.target.id === 'referralNotesModal') closeReferralNotesModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('referralNotesModal').classList.contains('open')) closeReferralNotesModal();
});

// ── Status changes ──
// Every change is recorded in the history with today's date. A closed
// application (Rejected / No reply) drops its next step.
function _setJobStatus(id, status) {
  _setJobsStatus([id], status);
}
function _setJobsStatus(ids, status) {
  const jobs = getJobs();
  const today = _todayStr();
  let changed = false;
  ids.forEach(id => {
    const j = jobs.find(x => x.id === id);
    if (!j || j.status === status) return;
    j.history = [..._jobHistory(j), { status, date:today }];
    j.status = status;
    if (JOB_CLOSED_STATUSES.has(status)) delete j.next;
    changed = true;
  });
  if (!changed) return;
  saveJobs(jobs);
  renderJobs();
}

// Saves a field without re-rendering (notes, typed as you go).
function _patchJobQuiet(id, patch) {
  const jobs = getJobs();
  const j = jobs.find(x => x.id === id);
  if (!j) return;
  Object.assign(j, patch);
  saveJobs(jobs);
}

function deleteJob(id) {
  const jobs = getJobs();
  const j = jobs.find(x => x.id === id);
  if (!j) return;
  MEM['jobs:list'] = jobs.filter(x => x.id !== id);
  // The database unlinks referrals itself (on delete set null); mirror it here.
  const refs = getReferrals();
  if (refs.some(r => r.jobId === id)) saveReferrals(refs.map(r => r.jobId === id ? { ...r, jobId:null } : r));
  if (LOCAL_MODE) _saveLocal();
  _deleteJobRemote(id);
  _jobView = 'pipeline';
  renderJobs();
  renderReferrals();
}

// ── Application page ──
function _openJobDetail(id) { _setJobView('detail', id); }

function _renderJobDetail() {
  const host = document.getElementById('jobDetail');
  const j = _getJobById(_jobDetailId);
  if (!host) return;
  if (!j) { host.innerHTML = ''; return; }
  const hist = _jobHistory(j);
  const reached = s => hist.find(h => h.status === s);
  const curIdx = JOB_PIPELINE_STEPS.indexOf(j.status);
  const closed = _jobIsClosed(j);
  const loc = _jobLocationText(j);
  const refs = getReferrals();
  const linked = refs.filter(r => r.jobId === j.id);
  const days = _jobDaysSince(j.dateApplied);
  const ps = j.platform ? (JOB_PLATFORM_STYLE[j.platform] || JOB_PLATFORM_FALLBACK_STYLE) : null;
  const pSite = j.platform ? JOB_SITE_CATALOG.find(s => s.name === j.platform) : null;
  const locLabel = j.locationType === 'remote' ? 'Remote'
    : [loc.place, j.locationType === 'hybrid' ? 'Hybrid' : j.locationType === 'onsite' ? 'On-site' : ''].filter(Boolean).join(' · ');
  const steps = JOB_PIPELINE_STEPS.map((s, i) => {
    const h = reached(s);
    const done = !!h && (closed || curIdx >= i);
    return `<button type="button" class="jd-step ${done ? 'done' : ''} ${j.status === s ? 'cur' : ''}" style="--c:${JOB_STATUS_STYLE[s].color}" data-jstep="${_esc(s)}" aria-pressed="${j.status === s}"><i></i><b>${_esc(s)}</b><small>${h && h.date ? _esc(_fmtJobShort(h.date)) : '—'}</small></button>`;
  }).join('');
  const nextStep = curIdx >= 0 && curIdx < JOB_PIPELINE_STEPS.length - 1 ? JOB_PIPELINE_STEPS[curIdx + 1] : null;
  const ss = JOB_STATUS_STYLE[j.status] || JOB_STATUS_STYLE['Applied'];
  const actions = closed
    ? `<span class="job-pill" style="background:${ss.bg};color:${ss.color};cursor:default">${_esc(j.status)}${_jobStageDate(j) ? ' · ' + _esc(_fmtJobShort(_jobStageDate(j))) : ''}</span><button type="button" class="jd-btn" data-jreopen>Reopen</button>`
    : `${nextStep ? `<button type="button" class="jd-btn pri" data-jstep="${_esc(nextStep)}">Move to ${_esc(nextStep)}</button>` : ''}<button type="button" class="jd-btn red" data-jstep="Rejected">Rejected</button><button type="button" class="jd-btn slate" data-jstep="No reply">No reply</button>`;
  const timeline = [...hist].reverse().map(h =>
    `<li><i style="background:${(JOB_STATUS_STYLE[h.status] || JOB_STATUS_STYLE['Applied']).color}"></i><time>${h.date ? _esc(_fmtJobShort(h.date)) : '—'}</time><span>${h.status === 'Applied' ? `<b>Applied</b>${j.platform ? ' via ' + _esc(j.platform) : ''}` : `Moved to <b>${_esc(h.status)}</b>`}</span></li>`).join('') +
    linked.map(r => `<li><i style="background:#B69CFF"></i><time>—</time><span><b>${_esc(r.name)}</b> ${r.step === 'asked' ? 'was asked to refer you' : r.step === 'ask' ? 'can refer you' : 'referred you'}</span></li>`).join('');
  host.innerHTML = `
    <div class="jd-top">
      <div class="jd-title">
        <h2 class="job-company-name" contenteditable="true" spellcheck="false" data-id="${_esc(j.id)}" aria-label="Company name">${_esc(j.company)}</h2>
        <div class="jd-sub">${j.role ? `<span>${_esc(j.role)}</span><span>·</span>` : ''}<span>${_esc(locLabel || 'No location')}</span>${j.platform ? `<span>·</span><span class="jobs-plat">${_jobPlatformIcon(j.platform)}<span>${_esc(j.platform)}</span></span>` : ''}</div>
      </div>
      <button type="button" class="hab-chip" data-jview="pipeline">← All applications</button>
    </div>
    <div class="jd-grid">
      <div>
        <div class="jd-stepper">${steps}</div>
        <div class="jd-actions">${actions}</div>
        ${closed ? '' : `<div class="jd-next"><span class="jd-next-k">Next step</span><input type="date" class="task-date-input" id="jdNextDate" value="${_esc(j.next && j.next.date || '')}" aria-label="Next step date"><input class="task-date-input jd-next-label" id="jdNextLabel" placeholder="e.g. Onsite loop, take-home due" value="${_esc(j.next && j.next.label || '')}" aria-label="Next step"></div>`}
        <div class="jd-settings">
          <div class="jd-set"><span>Posting</span><div class="jd-row">${j.url
            ? `<a class="jd-link" href="${_esc(j.url)}" target="_blank" rel="noopener noreferrer">${_esc(j.url.replace(/^https?:\/\/(www\.)?/, ''))}</a><button type="button" class="jobs-link-btn" data-jurl-edit>Edit</button>`
            : `<input class="task-date-input jd-url-input" id="jdUrl" placeholder="Paste the posting link" aria-label="Posting link">`}</div></div>
          <div class="jd-set"><span>Role</span><div class="jd-row">${j.role
            ? `<button type="button" class="job-pill" style="background:rgba(255,255,255,0.10);color:var(--text-secondary)" data-action="role" data-id="${_esc(j.id)}">${_esc(j.role)}</button>`
            : `<button type="button" class="job-pill job-pill-empty" data-action="role" data-id="${_esc(j.id)}">Pick a role</button>`}</div></div>
          <div class="jd-set"><span>Found on</span><div class="jd-row">${ps
            ? `<button type="button" class="job-pill job-pill-platform" style="background:${ps.bg};color:${ps.color}" data-action="platform" data-id="${_esc(j.id)}">${pSite ? `<img class="job-platform-logo" src="${_jobSiteLogoUrl(pSite.domain)}" alt="">` : ''}${_esc(j.platform)}</button>`
            : `<button type="button" class="job-pill job-pill-empty" data-action="platform" data-id="${_esc(j.id)}">Pick a board</button>`}</div></div>
          <div class="jd-set"><span>Location</span><div class="jd-row"><button type="button" class="job-pill job-pill-empty" style="color:var(--text-secondary)" data-action="location" data-id="${_esc(j.id)}">${_esc(locLabel || 'Set location')}</button></div></div>
          <div class="jd-set"><span>Applied</span><div class="jd-row"><input type="date" class="task-date-input" id="jdApplied" value="${_esc(j.dateApplied || '')}" max="${_todayStr()}" aria-label="Date applied">${days !== null ? `<span class="jd-hint">${days === 0 ? 'today' : days + ' day' + (days === 1 ? '' : 's') + ' ago'}</span>` : ''}</div></div>
          <div class="jd-set"><span>Referred by</span><div class="jd-row">${refs.length
            ? refs.map(r => `<button type="button" class="jd-refopt ${r.jobId === j.id ? 'on' : ''}" data-jref="${_esc(r.id)}" aria-pressed="${r.jobId === j.id}" title="${r.jobId && r.jobId !== j.id ? 'Linked to ' + _esc(_getJobById(r.jobId)?.company || 'another application') + ' now' : ''}">${_esc(r.name)}</button>`).join('')
            : '<span class="jd-hint">Add referrers in the Referrals card</span>'}</div></div>
        </div>
        <div class="jd-danger" id="jdDanger"><button type="button" class="jd-del" data-jdelete>Delete application…</button></div>
      </div>
      <div>
        <div class="jd-box"><span class="hab-eyebrow">Timeline</span><ol class="jd-timeline">${timeline}</ol></div>
        <div class="jd-notes"><span class="hab-eyebrow">Notes</span><textarea id="jdNotes" placeholder="Recruiter name, what they asked, what to prepare…">${_esc(j.notes || '')}</textarea><span class="jd-hint" id="jdNotesStatus">${j.notes ? 'Saved' : ''}</span></div>
      </div>
    </div>`;
  host.querySelectorAll('.job-platform-logo').forEach(img => { img.onerror = () => img.remove(); });
}

let _jdNotesTimer = null;
function _flushJobNotes() {
  const ta = document.getElementById('jdNotes');
  if (!_jdNotesTimer || !ta) return;
  clearTimeout(_jdNotesTimer); _jdNotesTimer = null;
  _patchJobQuiet(ta.closest('#jobDetail') ? _jobDetailId : null, { notes:ta.value });
  const st = document.getElementById('jdNotesStatus'); if (st) st.textContent = 'Saved';
}

document.getElementById('jobDetail').addEventListener('click', e => {
  const id = _jobDetailId;
  const step = e.target.closest('[data-jstep]');
  if (step) { _setJobStatus(id, step.dataset.jstep); return; }
  if (e.target.closest('[data-jreopen]')) {
    const j = _getJobById(id);
    const prev = j && [..._jobHistory(j)].reverse().find(h => !JOB_CLOSED_STATUSES.has(h.status));
    _setJobStatus(id, prev ? prev.status : 'Applied');
    return;
  }
  if (e.target.closest('[data-jurl-edit]')) {
    const row = e.target.closest('.jd-row');
    const url = _getJobById(id)?.url || '';
    row.innerHTML = `<input class="task-date-input jd-url-input" id="jdUrl" value="${_esc(url)}" placeholder="Paste the posting link" aria-label="Posting link">`;
    document.getElementById('jdUrl').focus();
    return;
  }
  const ref = e.target.closest('[data-jref]');
  if (ref) {
    const refs = getReferrals();
    const r = refs.find(x => x.id === ref.dataset.jref);
    if (!r) return;
    if (r.jobId === id) { r.jobId = null; }
    else { r.jobId = id; if (!r.step || r.step === 'ask' || r.step === 'asked') r.step = 'referred'; }
    saveReferrals(refs);
    renderReferrals();
    renderJobs();
    return;
  }
  if (e.target.closest('[data-jdelete]')) {
    const j = _getJobById(id);
    const box = document.getElementById('jdDanger');
    box.innerHTML = `<span class="jd-hint">Delete ${_esc(j.company)} and its notes? This can't be undone.</span><button type="button" class="jd-btn red" data-jdelete-yes>Delete</button><button type="button" class="jd-btn" data-jdelete-no>Cancel</button>`;
    box.querySelector('[data-jdelete-no]').focus();
    return;
  }
  if (e.target.closest('[data-jdelete-no]')) { _renderJobDetail(); return; }
  if (e.target.closest('[data-jdelete-yes]')) { deleteJob(id); return; }
});

document.getElementById('jobDetail').addEventListener('change', e => {
  const id = _jobDetailId;
  const j = _getJobById(id);
  if (!j) return;
  if (e.target.id === 'jdNextDate' || e.target.id === 'jdNextLabel') {
    const date = document.getElementById('jdNextDate').value;
    const label = document.getElementById('jdNextLabel').value.trim();
    const jobs = getJobs();
    const job = jobs.find(x => x.id === id);
    if (date) job.next = { date, label }; else delete job.next;
    saveJobs(jobs);
    _renderJobsList(); _renderJobsAttention();
  }
  if (e.target.id === 'jdApplied' && e.target.value) {
    const jobs = getJobs();
    const job = jobs.find(x => x.id === id);
    job.dateApplied = e.target.value;
    if (Array.isArray(job.history) && job.history[0] && job.history[0].status === 'Applied') job.history[0].date = e.target.value;
    saveJobs(jobs);
    renderJobs();
  }
  if (e.target.id === 'jdUrl') { _updateJob(id, { url:e.target.value.trim() }); }
});

document.getElementById('jobDetail').addEventListener('input', e => {
  if (e.target.id !== 'jdNotes') return;
  const st = document.getElementById('jdNotesStatus');
  if (st) st.textContent = 'Saving…';
  clearTimeout(_jdNotesTimer);
  _jdNotesTimer = setTimeout(_flushJobNotes, 600);
});

// ── Pipeline interactions ──
document.getElementById('tab-jobs').addEventListener('click', e => {
  const view = e.target.closest('[data-jview]');
  if (view) { _flushJobNotes(); _setJobView(view.dataset.jview); if (view.dataset.jview === 'pipeline') renderJobs(); return; }
  const filter = e.target.closest('[data-jfilter]');
  if (filter) { _jobFilter = _jobFilter === filter.dataset.jfilter ? null : filter.dataset.jfilter; _renderJobsHeader(); _renderJobsList(); return; }
  const group = e.target.closest('[data-jgroup]');
  if (group) { _jobGroup = group.dataset.jgroup; _saveJobUi(); _renderJobsView(); _renderJobsList(); return; }
  const more = e.target.closest('[data-jmore]');
  if (more) { _jobExpanded[more.dataset.jmore] = true; _renderJobsList(); return; }
  const attn = e.target.closest('[data-attn]');
  if (attn) {
    const act = attn.dataset.attn;
    if (act === 'stale') _setJobsStatus(getJobs().filter(_jobIsStale).map(j => j.id), 'No reply');
    else if (act.startsWith('open:')) _openJobDetail(act.slice(5));
    return;
  }
  const dismiss = e.target.closest('[data-attn-dismiss]');
  if (dismiss) { _jobAttnDismissed.add(dismiss.dataset.attnDismiss); _renderJobsAttention(); return; }
  if (e.target.closest('#jobsGoalBtn')) {
    const btn = e.target.closest('#jobsGoalBtn');
    btn.outerHTML = `<input type="number" min="1" max="200" class="task-date-input jobs-goal-input" id="jobsGoalInput" value="${getJobWeeklyGoal()}" aria-label="Weekly goal">`;
    const input = document.getElementById('jobsGoalInput');
    input.focus(); input.select();
    const done = () => { const v = parseInt(input.value, 10); if (v > 0 && v !== getJobWeeklyGoal()) saveJobWeeklyGoal(v); _renderJobsHeader(); };
    input.addEventListener('blur', done, { once:true });
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = getJobWeeklyGoal(); input.blur(); } });
    return;
  }
  if (e.target.closest('[data-place-clear]')) { _selectJobPlace(_jobPlaceSel); return; }
  const openBtn = e.target.closest('[data-job-open]');
  if (openBtn) { _openJobDetail(openBtn.dataset.jobOpen); return; }
  if (e.target.closest('[data-action]')) return;   // pills handle their own clicks
  const row = e.target.closest('[data-job]');
  if (row) _openJobDetail(row.dataset.job);
});
document.getElementById('tab-jobs').addEventListener('toggle', e => {
  const d = e.target.closest && e.target.closest('details[data-jgroupkey]');
  if (d) _jobExpanded['open:' + d.dataset.jgroupkey] = d.open;
}, true);
document.getElementById('jobsList').addEventListener('keydown', e => {
  const row = e.target.closest('[data-job]');
  if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); _openJobDetail(row.dataset.job); }
});
document.getElementById('jobsSearch').addEventListener('input', e => { _jobQuery = e.target.value; _renderJobsList(); });

// ── Add application modal ──
const _aj = { role:'', platform:'', lt:'', cities:[], when:'today', ref:'', url:'' };
function _ajEl(id) { return document.getElementById(id); }
function _ajPlatforms() {
  const list = getJobSites().map(_jobSiteCatalogEntry).filter(Boolean).map(s => s.name);
  list.push('Company Site');
  if (_aj.platform && !list.includes(_aj.platform)) list.unshift(_aj.platform);
  return list;
}
function _ajPaint(flash) {
  const roles = getJobRoles();
  _ajEl('ajRoles').innerHTML = roles.map(r => `<button type="button" class="aj-opt ${_aj.role === r ? 'on' : ''}" data-ajrole="${_esc(r)}" aria-pressed="${_aj.role === r}">${_esc(r)}</button>`).join('') +
    `<input class="task-date-input aj-newrole" id="ajNewRole" placeholder="+ New role ↵" aria-label="New role">`;
  _ajEl('ajPlatforms').innerHTML = _ajPlatforms().map(p => `<button type="button" class="aj-opt ${_aj.platform === p ? 'on' : ''}" data-ajplat="${_esc(p)}" aria-pressed="${_aj.platform === p}">${_jobPlatformIcon(p)}${_esc(p)}</button>`).join('');
  _ajEl('ajPlatforms').querySelectorAll('.job-platform-logo').forEach(img => { img.onerror = () => img.remove(); });
  if (flash) { _ajEl('ajPlatforms').classList.remove('aj-fill'); void _ajEl('ajPlatforms').offsetWidth; _ajEl('ajPlatforms').classList.add('aj-fill'); }
  document.querySelectorAll('#addJobForm .at-seg').forEach(seg => seg.querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', (seg.dataset.f === 'lt' ? _aj.lt : _aj.when) === b.dataset.v)));
  _ajEl('ajCitiesWrap').hidden = !(_aj.lt === 'hybrid' || _aj.lt === 'onsite');
  _ajEl('ajCities').innerHTML = _aj.cities.map((c, i) => `<span class="job-loc-city-chip"><span>${_esc(c)}</span><button type="button" class="job-loc-city-chip-remove" data-ajcity="${i}" aria-label="Remove ${_esc(c)}">×</button></span>`).join('');
  _ajEl('ajDate').hidden = _aj.when !== 'pick';
  const refs = getReferrals();
  _ajEl('ajRefs').innerHTML = `<button type="button" class="aj-opt ${!_aj.ref ? 'on' : ''}" data-ajref="">Nobody</button>` +
    refs.map(r => `<button type="button" class="aj-opt ${_aj.ref === r.id ? 'on' : ''}" data-ajref="${_esc(r.id)}">${_esc(r.name)}</button>`).join('');
  _ajEl('ajUrl').closest('.aj-url').classList.toggle('ok', !!_aj.url);
  _ajEl('ajSubmit').disabled = !_ajEl('ajCompany').value.trim();
}

// Posting links → company + where you found it. Only URL patterns, no AI:
// job boards from the catalog by domain; ATS hosts (Greenhouse, Lever,
// Ashby, Workday, SmartRecruiters) carry the company in the path or subdomain.
function _parseJobUrl(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  const cap = s => s ? decodeURIComponent(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
  const board = JOB_SITE_CATALOG.find(s => host === s.domain || host.endsWith('.' + s.domain));
  if (board) {
    const company = board.key === 'wellfound' && parts[0] === 'company' ? cap(parts[1]) : '';
    return { platform:board.name, company, note:company ? '' : `${board.name} links don't include the company. Type it in.` };
  }
  if (host.includes('greenhouse.io')) return { platform:'Company Site', company:cap(parts[0] === 'embed' ? url.searchParams.get('for') : parts[0]) };
  if (host.endsWith('lever.co') || host.endsWith('ashbyhq.com') || host.endsWith('smartrecruiters.com')) return { platform:'Company Site', company:cap(parts[0]) };
  if (host.includes('myworkdayjobs.com')) return { platform:'Company Site', company:cap(host.split('.')[0]) };
  const labels = host.split('.');
  const name = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  return { platform:'Company Site', company:cap(['careers', 'jobs', 'boards'].includes(name) ? labels[0] : name) };
}

function openAddJob() {
  _flushJobNotes();
  Object.assign(_aj, { role:getJobRoles()[0] || '', platform:_ajPlatforms()[0] || 'Company Site', lt:'', cities:[], when:'today', ref:'', url:'' });
  _ajEl('addJobForm').reset();
  _ajEl('ajUrlNote').hidden = true;
  _ajEl('ajStatus').textContent = '';
  _ajEl('ajDate').max = _todayStr();
  _ajPaint();
  _ajEl('addJobModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => _ajEl('ajUrl').focus(), 0);
}
function closeAddJob() {
  _ajEl('addJobModal').classList.remove('open');
  document.body.style.overflow = '';
}
function _ajApplyUrl() {
  const v = _ajEl('ajUrl').value.trim();
  _aj.url = v;
  const p = v ? _parseJobUrl(v) : null;
  const note = _ajEl('ajUrlNote');
  if (p) {
    _aj.platform = p.platform;
    if (p.company && !_ajEl('ajCompany').value.trim()) {
      _ajEl('ajCompany').value = p.company;
      _ajEl('ajCompany').parentElement.classList.remove('aj-fill'); void _ajEl('ajCompany').offsetWidth; _ajEl('ajCompany').parentElement.classList.add('aj-fill');
    }
    note.textContent = p.note || ''; note.hidden = !p.note;
  } else { note.hidden = !v; note.textContent = v ? "That doesn't look like a link. It won't be saved." : ''; if (v) _aj.url = ''; }
  _ajPaint(!!p);
  if (p) _ajEl('ajCompany').focus();
}
function _ajAddCity() {
  const input = _ajEl('ajCity');
  const v = input.value.trim();
  if (v && !_aj.cities.some(c => c.toLowerCase() === v.toLowerCase())) _aj.cities.push(v);
  input.value = '';
  _ajPaint();
  _ajEl('ajCity').focus();
}
function _ajSubmit() {
  const company = _ajEl('ajCompany').value.trim();
  if (!company) { _ajEl('ajStatus').textContent = 'Add a company name.'; return; }
  if (_ajEl('ajCity').value.trim()) _ajAddCity();
  let date = _todayStr();
  if (_aj.when === 'yday') { const d = new Date(); d.setDate(d.getDate() - 1); date = _jobIso(d); }
  if (_aj.when === 'pick') { if (!_ajEl('ajDate').value) { _ajEl('ajStatus').textContent = 'Pick the date you applied.'; return; } date = _ajEl('ajDate').value; }
  const job = { id:_jobId(), company, role:_aj.role, platform:_aj.platform, dateApplied:date, status:'Applied',
    locationType:_aj.lt, locationCities:(_aj.lt === 'hybrid' || _aj.lt === 'onsite') ? [..._aj.cities] : [] };
  if (_aj.url) job.url = _aj.url;
  const jobs = getJobs();
  jobs.unshift(job);
  saveJobs(jobs);
  if (_aj.ref) {
    const refs = getReferrals();
    const r = refs.find(x => x.id === _aj.ref);
    if (r) { r.jobId = job.id; r.step = 'referred'; saveReferrals(refs); }
  }
  closeAddJob();
  if (_jobView === 'detail') _jobView = 'pipeline';
  renderJobs();
  renderReferrals();
}

_ajEl('addJobForm').addEventListener('submit', e => { e.preventDefault(); _ajSubmit(); });
_ajEl('addJobForm').addEventListener('click', e => {
  if (e.target.closest('[data-close]')) { closeAddJob(); return; }
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.ajrole !== undefined) { _aj.role = _aj.role === b.dataset.ajrole ? '' : b.dataset.ajrole; _ajPaint(); return; }
  if (b.dataset.ajplat !== undefined) { _aj.platform = b.dataset.ajplat; _ajPaint(); return; }
  if (b.dataset.ajref !== undefined) { _aj.ref = b.dataset.ajref; _ajPaint(); return; }
  if (b.dataset.ajcity !== undefined) { _aj.cities.splice(+b.dataset.ajcity, 1); _ajPaint(); return; }
  const seg = b.closest('.at-seg');
  if (seg) {
    if (seg.dataset.f === 'lt') _aj.lt = _aj.lt === b.dataset.v ? '' : b.dataset.v;
    else _aj.when = b.dataset.v;
    _ajPaint();
    if (seg.dataset.f === 'lt' && (_aj.lt === 'hybrid' || _aj.lt === 'onsite')) _ajEl('ajCity').focus();
    if (seg.dataset.f === 'when' && _aj.when === 'pick') _ajEl('ajDate').focus();
  }
});
_ajEl('addJobForm').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'ajCity') { e.preventDefault(); if (e.target.value.trim()) _ajAddCity(); else _ajSubmit(); return; }
  if (e.target.id === 'ajNewRole') {
    e.preventDefault();
    const v = e.target.value.trim();
    if (!v) return;
    addJobRole(v);
    _aj.role = v;
    _ajPaint();
    return;
  }
  if (e.target.id === 'ajUrl') { e.preventDefault(); _ajApplyUrl(); }
});
_ajEl('ajUrl').addEventListener('paste', () => setTimeout(_ajApplyUrl, 0));
_ajEl('ajUrl').addEventListener('change', _ajApplyUrl);
_ajEl('ajCompany').addEventListener('input', () => { _ajEl('ajSubmit').disabled = !_ajEl('ajCompany').value.trim(); _ajEl('ajStatus').textContent = ''; });
_ajEl('addJobModal').addEventListener('click', e => { if (e.target.id === 'addJobModal') closeAddJob(); });
_ajEl('jobAddBtn').addEventListener('click', openAddJob);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (_ajEl('addJobModal').classList.contains('open')) { closeAddJob(); return; }
    if (_jobView === 'detail' && document.getElementById('tab-jobs').classList.contains('active') &&
        !document.querySelector('.sr-modal.open') && document.getElementById('jobDropdown').style.display !== 'block' &&
        !document.activeElement.isContentEditable) {
      _flushJobNotes(); _setJobView('pipeline'); renderJobs();
    }
    return;
  }
  // N opens the add modal — on the Jobs tab, when nothing else has the keyboard.
  if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey &&
      document.getElementById('tab-jobs').classList.contains('active') &&
      !document.querySelector('.sr-modal.open') &&
      !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) &&
      !document.activeElement.isContentEditable) {
    e.preventDefault();
    openAddJob();
  }
});
