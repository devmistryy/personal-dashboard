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

// User-created Job Role options (settings key, like the job boards catalog
// picks but user-authored) — jobs store the plain role string.
function getJobRoles() { return MEM['job_roles_v1'] || []; }
function saveJobRoles(list) { MEM['job_roles_v1'] = list; _syncSetting('job_roles_v1', list); }

async function _syncJobs(jobs) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _uid(); if (!uid) return;
  if (jobs.length) {
    const { error } = await sb.from('job_applications').upsert(jobs.map(j => ({
      id: j.id, user_id: uid, company: j.company, platform: j.platform || null,
      date_applied: j.dateApplied || null, status: j.status || 'Applied',
      location_type: j.locationType || null, location_city: j.locationCity || null,
      role: j.role || null,
    })), { onConflict: 'id' });
    if (error) _syncFailed('job_applications upsert failed', error);
  }
  const { data: existing, error: selErr } = await sb.from('job_applications').select('id').eq('user_id', uid);
  if (selErr) { _syncFailed('job_applications select failed', selErr); return; }
  const currentIds = new Set(jobs.map(j => j.id));
  const toDelete = (existing || []).filter(r => !currentIds.has(r.id)).map(r => r.id);
  if (toDelete.length) {
    const { error: delErr } = await sb.from('job_applications').delete().eq('user_id', uid).in('id', toDelete);
    if (delErr) _syncFailed('job_applications delete failed', delErr);
  }
}

function _jobId() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
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
    tbody.innerHTML = '<tr><td colspan="6" class="job-empty">No applications yet — type a company name below.</td></tr>';
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
        ${job.role
          ? `<span class="job-pill job-pill-role" style="background:rgba(255,255,255,0.10);color:var(--text-secondary)" data-action="role" data-id="${job.id}" title="${_esc(job.role)}">${_esc(job.role)}</span>`
          : `<span class="job-pill job-pill-empty" data-action="role" data-id="${job.id}">—</span>`}
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
      const roles2 = getJobRoles();
      if (!roles2.includes(val)) { roles2.push(val); saveJobRoles(roles2); }
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
  // Job Role — options the user creates themselves, managed right in this
  // dropdown (type + Enter to add, × to remove) rather than a separate screen.
  const roleEl = e.target.closest('[data-action="role"]');
  if (roleEl) {
    const id = roleEl.dataset.id;
    _openJobDropdown(roleEl, (dd) => _renderJobRoleDropdown(dd, id));
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
  jobs.unshift({ id: _jobId(), company:name, role:'', platform:'', dateApplied:_todayStr(), status:'Applied', locationType:'', locationCity:'' });
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

function renderJobSites() {
  const list = document.getElementById('jobSiteList');
  if (!list) return;
  const keys = getJobSites();
  list.innerHTML = '';
  keys.forEach((key, idx) => {
    const site = _jobSiteCatalogEntry(key);
    if (site) list.appendChild(buildJobSiteRow(site, idx));
  });
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

function buildJobSiteRow(site, idx) {
  const li = document.createElement('li');
  li.className = 'job-site-row';
  li.dataset.key = site.key;
  li.draggable = true;

  const drag = document.createElement('span');
  drag.className = 'job-site-drag';
  drag.textContent = '⋮⋮';
  drag.setAttribute('aria-hidden', 'true');
  li.appendChild(drag);
  _wireJobSiteDrag(li, site.key);

  const rank = document.createElement('span');
  rank.className = 'job-site-rank';
  rank.textContent = idx + 1;
  li.appendChild(rank);

  li.appendChild(_buildSiteLogo(site));

  const name = document.createElement('a');
  name.className = 'job-site-name';
  name.href = site.url;
  name.target = '_blank';
  name.rel = 'noopener noreferrer';
  name.textContent = site.name;
  li.appendChild(name);

  const del = document.createElement('button');
  del.className = 'job-site-delete';
  del.type = 'button';
  del.textContent = '×';
  del.title = 'Remove from ranking';
  del.addEventListener('click', () => deleteJobSite(site.key));
  li.appendChild(del);

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
