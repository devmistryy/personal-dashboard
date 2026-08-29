// Jobs tab: applications table with inline editing and dropdowns.
// Loaded before main.js.

// ── Job Applications ──
const JOB_STATUSES = ['Applied','Phone Screen','Interview','Offer','Rejected'];
const JOB_STATUS_STYLE = {
  'Applied':      { bg:'rgba(186,117,23,0.22)',  color:'#EF9F27' },
  'Phone Screen': { bg:'rgba(55,138,221,0.22)',  color:'#5BADEE' },
  'Interview':    { bg:'rgba(52,199,89,0.18)',   color:'#34C759' },
  'Offer':        { bg:'rgba(29,158,117,0.22)',  color:'#30D158' },
  'Rejected':     { bg:'rgba(226,75,74,0.22)',   color:'#E24B4A' },
};
const JOB_PLATFORM_STYLE = {
  'LinkedIn':     { bg:'rgba(55,138,221,0.20)', color:'#378ADD' },
  'Indeed':       { bg:'rgba(99,153,34,0.20)',  color:'#97C459' },
  'Company Site': { bg:'rgba(255,255,255,0.10)', color:'rgba(255,255,255,0.75)' },
};

let _jobSort = 'date';

function getJobs() { return MEM['jobs:list'] || []; }
function saveJobs(jobs) { MEM['jobs:list'] = jobs; _syncJobs(jobs); }

async function _syncJobs(jobs) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _uid(); if (!uid) return;
  if (jobs.length) {
    const { error } = await sb.from('job_applications').upsert(jobs.map(j => ({
      id: j.id, user_id: uid, company: j.company, platform: j.platform || null,
      date_applied: j.dateApplied || null, status: j.status || 'Applied',
      location_type: j.locationType || null, location_city: j.locationCity || null,
    })), { onConflict: 'id' });
    if (error) console.error('[sync] job_applications upsert failed:', error);
  }
  const { data: existing, error: selErr } = await sb.from('job_applications').select('id').eq('user_id', uid);
  if (selErr) { console.error('[sync] job_applications select failed:', selErr); return; }
  const currentIds = new Set(jobs.map(j => j.id));
  const toDelete = (existing || []).filter(r => !currentIds.has(r.id)).map(r => r.id);
  if (toDelete.length) {
    const { error: delErr } = await sb.from('job_applications').delete().eq('user_id', uid).in('id', toDelete);
    if (delErr) console.error('[sync] job_applications delete failed:', delErr);
  }
}

function _todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function _fmtJobDate(ds) {
  if (!ds) return '—';
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m-1, d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderJobs() {
  const jobs = [...getJobs()];
  if (_jobSort === 'date') {
    jobs.sort((a,b) => (b.dateApplied||'').localeCompare(a.dateApplied||''));
  } else {
    jobs.sort((a,b) => JOB_STATUSES.indexOf(a.status) - JOB_STATUSES.indexOf(b.status));
  }
  const tbody = document.getElementById('jobTableBody');
  if (!tbody) return;
  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="job-empty">No applications yet — type a company name below.</td></tr>';
    return;
  }
  tbody.innerHTML = jobs.map(job => {
    const ss = JOB_STATUS_STYLE[job.status] || JOB_STATUS_STYLE['Applied'];
    const ps = job.platform ? (JOB_PLATFORM_STYLE[job.platform] || { bg:'rgba(255,255,255,0.08)', color:'var(--text-secondary)' }) : null;
    const locLabel = job.locationType === 'remote' ? 'Remote'
      : job.locationType === 'hybrid'  ? (job.locationCity ? _esc(job.locationCity) + ' · Hybrid' : 'Hybrid')
      : job.locationType === 'onsite'  ? (job.locationCity ? _esc(job.locationCity) + ' · On-site' : 'On-site')
      : '';
    return `<tr class="job-row" data-id="${job.id}">
      <td class="job-td">
        <div class="job-company-cell">
          <span class="job-company-name" contenteditable="true" spellcheck="false" data-id="${job.id}">${_esc(job.company)}</span>
        </div>
      </td>
      <td class="job-td">
        ${ps
          ? `<span class="job-pill" style="background:${ps.bg};color:${ps.color}" data-action="platform" data-id="${job.id}">${_esc(job.platform)}</span>`
          : `<span class="job-pill job-pill-empty" data-action="platform" data-id="${job.id}">—</span>`}
      </td>
      <td class="job-td">
        <span class="job-date-display" data-action="date" data-id="${job.id}">${_fmtJobDate(job.dateApplied)}</span>
        <input type="date" class="job-date-input" data-id="${job.id}" value="${job.dateApplied||''}" max="${_todayStr()}">
      </td>
      <td class="job-td">
        <span class="job-pill" style="background:${ss.bg};color:${ss.color}" data-action="status" data-id="${job.id}">${job.status}</span>
      </td>
      <td class="job-td">
        <span class="job-location-display" data-action="location" data-id="${job.id}">${locLabel || '<span style="color:var(--text-tertiary)">—</span>'}</span>
      </td>
    </tr>`;
  }).join('');
}

function _getJobById(id) { return getJobs().find(j => j.id === id); }

function _updateJob(id, patch) {
  const jobs = getJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return;
  Object.assign(jobs[idx], patch);
  saveJobs(jobs);
  renderJobs();
}

// Dropdown
let _jddCloseHandler = null;
function _openJobDropdown(triggerEl, buildFn) {
  const dd = document.getElementById('jobDropdown');
  buildFn(dd);
  const rect = triggerEl.getBoundingClientRect();
  dd.style.display = 'block';
  const ddW = 180;
  let left = rect.left;
  if (left + ddW > window.innerWidth - 8) left = window.innerWidth - ddW - 8;
  dd.style.left = left + 'px';
  dd.style.top = (rect.bottom + 5) + 'px';
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
  // Status
  const statusEl = e.target.closest('[data-action="status"]');
  if (statusEl) {
    const id = statusEl.dataset.id;
    _openJobDropdown(statusEl, (dd) => {
      dd.innerHTML = JOB_STATUSES.map(s => {
        const c = JOB_STATUS_STYLE[s].color;
        return `<div class="job-dd-item" data-status="${s}"><span class="job-dd-dot" style="background:${c}"></span>${s}</div>`;
      }).join('');
      dd.querySelectorAll('[data-status]').forEach(item => {
        item.addEventListener('click', () => { _updateJob(id, { status: item.dataset.status }); _closeJobDropdown(); });
      });
    });
    return;
  }
  // Platform
  const platEl = e.target.closest('[data-action="platform"]');
  if (platEl) {
    const id = platEl.dataset.id;
    const platforms = ['LinkedIn','Indeed','Company Site'];
    _openJobDropdown(platEl, (dd) => {
      dd.innerHTML = platforms.map(p => {
        const ps = JOB_PLATFORM_STYLE[p];
        return `<div class="job-dd-item" data-platform="${p}"><span class="job-pill" style="background:${ps.bg};color:${ps.color};font-size:11px;padding:2px 8px;">${p}</span></div>`;
      }).join('');
      dd.querySelectorAll('[data-platform]').forEach(item => {
        item.addEventListener('click', () => { _updateJob(id, { platform: item.dataset.platform }); _closeJobDropdown(); });
      });
    });
    return;
  }
  // Date
  const dateEl = e.target.closest('[data-action="date"]');
  if (dateEl) {
    const id = dateEl.dataset.id;
    const td = dateEl.closest('td');
    const input = td.querySelector('.job-date-input');
    dateEl.style.display = 'none';
    input.style.display = 'inline-block';
    input.focus();
    const done = () => {
      if (input.value) _updateJob(id, { dateApplied: input.value });
      else renderJobs();
    };
    input.onblur = done;
    input.onkeydown = ev => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = _getJobById(id)?.dateApplied || ''; input.blur(); } };
    return;
  }
  // Location
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
        <div id="jobLocCityWrap" style="display:none;padding:4px 8px 6px;">
          <input class="job-loc-city-input" id="jobLocCityInput" placeholder="City (e.g. New York)">
        </div>`;
      dd.querySelectorAll('[data-loctype]').forEach(item => {
        item.addEventListener('click', (ev) => {
          ev.stopPropagation();
          selType = item.dataset.loctype;
          dd.querySelectorAll('[data-loctype]').forEach(i => i.style.fontWeight = '');
          item.style.fontWeight = '500';
          if (selType === 'remote') {
            _updateJob(id, { locationType:'remote', locationCity:'' });
            _closeJobDropdown();
          } else {
            const wrap = document.getElementById('jobLocCityWrap');
            wrap.style.display = 'block';
            const ci = document.getElementById('jobLocCityInput');
            ci.value = job?.locationCity || '';
            ci.focus();
            ci.onclick = ev2 => ev2.stopPropagation();
            ci.onkeydown = ev2 => {
              if (ev2.key === 'Enter') { _updateJob(id, { locationType:selType, locationCity:ci.value.trim() }); _closeJobDropdown(); }
              if (ev2.key === 'Escape') _closeJobDropdown();
            };
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
  const name = e.target.textContent.trim();
  if (!name || !id) return;
  const jobs = getJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx !== -1 && jobs[idx].company !== name) { jobs[idx].company = name; saveJobs(jobs); }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('job-company-name')) { e.preventDefault(); e.target.blur(); }
});

// Add new job
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.id !== 'jobAddInput') return;
  const name = e.target.value.trim();
  if (!name) return;
  const jobs = getJobs();
  jobs.unshift({ id: Date.now().toString(36), company:name, platform:'', dateApplied:_todayStr(), status:'Applied', locationType:'', locationCity:'' });
  saveJobs(jobs);
  e.target.value = '';
  renderJobs();
});

// Sort buttons
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.job-sort-btn');
  if (!btn) return;
  _jobSort = btn.dataset.sort;
  document.querySelectorAll('.job-sort-btn').forEach(b => b.classList.toggle('active', b === btn));
  renderJobs();
});
