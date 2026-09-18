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
const JOB_PLATFORM_FALLBACK_STYLE = { bg:'rgba(255,255,255,0.08)', color:'var(--text-secondary)' };

let _jobSort = 'date';

function getJobs() { return MEM['jobs:list'] || []; }
function saveJobs(jobs) { MEM['jobs:list'] = jobs; _syncJobs(jobs); }

// User-created Job Role options (settings key, like the job boards catalog
// picks but user-authored) — jobs store the plain role string.
function getJobRoles() { return MEM['job_roles_v1'] || []; }
function saveJobRoles(list) { MEM['job_roles_v1'] = list; _syncSetting('job_roles_v1', list); }

// Upsert-only: there is no delete-job-application feature (jobs only ever get
// added or have fields edited), so unlike _syncReferrals this never needs to
// reconcile deletions. It used to infer deletions by diffing the full remote
// set against the local array and deleting whatever was missing — but that's
// wrong on more than one device/tab: a stale local array (this device hasn't
// loaded a job another device just added) would delete that job's row the
// next time this device saved anything at all.
async function _syncJobs(jobs) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (!jobs.length) return;
  const { error } = await sb.from('job_applications').upsert(jobs.map(j => ({
    id: j.id, user_id: uid, company: j.company, platform: j.platform || null,
    date_applied: j.dateApplied || null, status: j.status || 'Applied',
    location_type: j.locationType || null,
    location_cities: (j.locationCities && j.locationCities.length) ? j.locationCities : null,
    role: j.role || null,
  })), { onConflict: 'id' });
  if (error) _syncFailed('job_applications upsert failed', error);
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

// _esc() is defined in habits.js (loaded before this file) and shared via the
// global scope — do not redeclare it here. A jobs.js-local copy previously
// shadowed it with a weaker version that didn't escape single quotes.

function renderJobs() {
  const jobs = [...getJobs()];
  renderJobMap();
  if (_jobSort === 'date') {
    jobs.sort((a,b) => (b.dateApplied||'').localeCompare(a.dateApplied||''));
  } else {
    jobs.sort((a,b) => JOB_STATUSES.indexOf(a.status) - JOB_STATUSES.indexOf(b.status));
  }
  const totalEl = document.getElementById('jobStatTotal');
  const todayEl = document.getElementById('jobStatToday');
  if (totalEl) totalEl.textContent = jobs.length;
  if (todayEl) todayEl.textContent = jobs.filter(j => j.dateApplied === _todayStr()).length;
  const tbody = document.getElementById('jobTableBody');
  if (!tbody) return;
  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="job-empty">No applications yet — type a company name below.</td></tr>';
    return;
  }
  tbody.innerHTML = jobs.map(job => {
    const ss = JOB_STATUS_STYLE[job.status] || JOB_STATUS_STYLE['Applied'];
    const ps = job.platform ? (JOB_PLATFORM_STYLE[job.platform] || JOB_PLATFORM_FALLBACK_STYLE) : null;
    const pSite = job.platform ? JOB_SITE_CATALOG.find(s => s.name === job.platform) : null;
    const cities = (job.locationCities && job.locationCities.length) ? _esc(job.locationCities.join(', ')) : '';
    const locLabel = job.locationType === 'remote' ? 'Remote'
      : job.locationType === 'hybrid'  ? (cities ? cities + ' · Hybrid' : 'Hybrid')
      : job.locationType === 'onsite'  ? (cities ? cities + ' · On-site' : 'On-site')
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
          ? `<span class="job-pill job-pill-platform" style="background:${ps.bg};color:${ps.color}" data-action="platform" data-id="${job.id}">${pSite ? `<img class="job-platform-logo" src="${_jobSiteLogoUrl(pSite.domain)}" alt="">` : ''}${_esc(job.platform)}</span>`
          : `<span class="job-pill job-pill-empty" data-action="platform" data-id="${job.id}">—</span>`}
      </td>
      <td class="job-td">
        <span class="job-date-display" data-action="date" data-id="${job.id}">${_fmtJobDate(job.dateApplied)}</span>
        <input type="date" class="job-date-input" data-id="${job.id}" value="${job.dateApplied||''}" max="${_todayStr()}">
      </td>
      <td class="job-td">
        <span class="job-pill" style="background:${ss.bg};color:${ss.color}" data-action="status" data-id="${job.id}">${_esc(job.status)}</span>
      </td>
      <td class="job-td">
        <span class="job-location-display" data-action="location" data-id="${job.id}">${locLabel || '<span style="color:var(--text-tertiary)">—</span>'}</span>
      </td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('.job-platform-logo').forEach(img => { img.onerror = () => img.remove(); });
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
let _jobMapPanelResizeObserver = null;
// Switch to 'numbered' to restore the previous marker layout.
const JOB_MAP_MARKER_MODE = 'minimal';

function _syncJobLocationPanelHeight() {
  const mapCard = document.querySelector('.jobs-map-card');
  const rankCard = document.querySelector('.jobs-location-layout .tech-rank-card');
  if (!mapCard || !rankCard) return;
  if (window.matchMedia('(max-width:900px)').matches) {
    rankCard.style.height = '';
    return;
  }
  rankCard.style.height = `${Math.ceil(mapCard.getBoundingClientRect().height)}px`;
}

function _watchJobLocationPanelHeight() {
  const mapCard = document.querySelector('.jobs-map-card');
  if (!mapCard || _jobMapPanelResizeObserver) return;
  _jobMapPanelResizeObserver = new ResizeObserver(_syncJobLocationPanelHeight);
  _jobMapPanelResizeObserver.observe(mapCard);
  window.addEventListener('resize', _syncJobLocationPanelHeight);
  _syncJobLocationPanelHeight();
}

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
  const rankedCity = typeof techCities === 'undefined' ? null : techCities.find(city =>
    city.name.toLowerCase() === cityName ||
    (typeof TECH_CITY_APPLICATION_ALIASES !== 'undefined' &&
      (TECH_CITY_APPLICATION_ALIASES[city.name] || []).some(alias => alias.toLowerCase() === cityName)));
  const rankedMetro = rankedCity
    ? techMetros.find(metro => metro.id === rankedCity.metroId)
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
      corePlaces:[], coreJobs:[], coreJobIds:new Set(), totalX:0, totalY:0, weight:0,
      coreX:0, coreY:0, coreWeight:0,
    });
    const group = groups.get(key);
    group.places.push(entry);
    const weight = entry.jobs.length;
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
      entry.jobs.forEach(job => {
        if (group.coreJobIds.has(job.id)) return;
        group.coreJobIds.add(job.id);
        group.coreJobs.push(job);
      });
    }
  });
  const grouped = [...groups.values()];
  const maxMetroApplications = Math.max(...grouped.map(group => group.jobs.length), 1);
  const maxCityApplications = Math.max(...grouped.map(group => group.coreJobs.length), 1);
  return grouped.map(group => {
    group.point = group.coreWeight
      ? [group.coreX / group.coreWeight, group.coreY / group.coreWeight]
      : [group.totalX / group.weight, group.totalY / group.weight];
    group.radius = JOB_MAP_MARKER_MODE === 'numbered'
      ? Math.min(28, 8 + Math.sqrt(group.jobs.length) * 3)
      : 10 + Math.sqrt(group.jobs.length / maxMetroApplications) * 18;
    group.cityRadius = group.coreJobs.length
      ? (JOB_MAP_MARKER_MODE === 'numbered'
        ? Math.min(group.radius - 4, Math.max(7 + Math.max(0, String(group.coreJobs.length).length - 1) * 3, 3 + Math.sqrt(group.coreJobs.length) * 3))
        : Math.min(group.radius - 5, 4 + Math.sqrt(group.coreJobs.length / maxCityApplications) * 8))
      : 0;
    if (group.coreJobs.length) group.kind = 'composite';
    return group;
  });
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

async function renderJobMap() {
  const svg = document.getElementById('jobsMap');
  if (!svg) return;
  _watchJobLocationPanelHeight();
  const renderId = ++_jobMapRenderId;
  const jobs = getJobs();
  const remoteCount = jobs.filter(job => job.locationType === 'remote').length;
  const locations = new Map();
  jobs.forEach(job => {
    if (job.locationType === 'remote') return;
    (job.locationCities || []).forEach(city => {
      const label = String(city).trim();
      if (!label) return;
      const key = label.toLowerCase();
      if (!locations.has(key)) locations.set(key, { label, jobs:[] });
      locations.get(key).jobs.push(job);
    });
  });
  document.getElementById('jobsMapRemote').textContent = remoteCount ? `${remoteCount} remote` : '';
  const message = document.getElementById('jobsMapMessage');
  const summary = document.getElementById('jobsMapSummary');
  const footer = document.getElementById('jobsMapFooter');
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
  _jobMapSpreadMarkers(markers);
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
    const marker = document.createElementNS(ns, 'g');
    marker.setAttribute('class', `jobs-map-marker jobs-map-marker-${entry.kind} jobs-map-marker-${JOB_MAP_MARKER_MODE}`);
    marker.setAttribute('transform', `translate(${point[0]},${point[1]})`);
    marker.setAttribute('tabindex', '0');
    marker.setAttribute('role', 'button');
    const cityCount = entry.coreJobs.length;
    marker.setAttribute('aria-label', `${entry.label}: ${entry.jobs.length} metro application${entry.jobs.length === 1 ? '' : 's'}${cityCount ? `, including ${cityCount} in the major city` : ''}`);
    const outer = document.createElementNS(ns, 'circle');
    outer.setAttribute('r', entry.radius);
    marker.appendChild(outer);
    if (entry.cityRadius) {
      const cityOffset = JOB_MAP_MARKER_MODE === 'numbered'
        ? Math.max(0, entry.radius - entry.cityRadius - 2)
        : 0;
      const inner = document.createElementNS(ns, 'circle');
      inner.setAttribute('r', entry.cityRadius);
      inner.setAttribute('cx', -cityOffset);
      inner.setAttribute('cy', cityOffset);
      marker.appendChild(inner);
      if (JOB_MAP_MARKER_MODE === 'numbered') {
        const cityCount = document.createElementNS(ns, 'text');
        cityCount.setAttribute('class', 'jobs-map-city-count');
        cityCount.setAttribute('x', -cityOffset);
        cityCount.setAttribute('y', cityOffset);
        cityCount.textContent = entry.coreJobs.length;
        marker.appendChild(cityCount);
        const metroCount = document.createElementNS(ns, 'text');
        metroCount.setAttribute('class', 'jobs-map-metro-count');
        metroCount.setAttribute('x', entry.radius * 0.42);
        metroCount.setAttribute('y', -entry.radius * 0.42);
        metroCount.textContent = entry.jobs.length;
        marker.appendChild(metroCount);
      }
    }
    if (JOB_MAP_MARKER_MODE === 'numbered' && !entry.cityRadius && entry.jobs.length > 1) {
      const count = document.createElementNS(ns, 'text');
      count.textContent = entry.jobs.length;
      marker.appendChild(count);
    }
    const tooltip = document.getElementById('jobsMapTooltip');
    const show = () => {
      tooltip.replaceChildren();
      const title = document.createElement('strong');
      title.textContent = entry.label;
      tooltip.appendChild(title);
      const metro = document.createElement('div');
      metro.className = 'jobs-map-tooltip-metro';
      metro.textContent = `${entry.jobs.length} application${entry.jobs.length === 1 ? '' : 's'} · ${entry.kind === 'other' ? 'Outside a metro area' : 'Metro area'}${entry.coreJobs.length ? ` · ${entry.coreJobs.length} in major city` : ''}`;
      tooltip.appendChild(metro);
      const names = document.createElement('div');
      names.textContent = entry.places.map(place => place.label).join(', ');
      tooltip.appendChild(names);
      tooltip.hidden = false;
      const frame = document.getElementById('jobsMapFrame').getBoundingClientRect();
      tooltip.style.left = Math.min(frame.width - tooltip.offsetWidth - 8, Math.max(8, point[0] * frame.width / 960 + 12)) + 'px';
      tooltip.style.top = Math.max(8, point[1] * frame.height / 610 - tooltip.offsetHeight - 8) + 'px';
    };
    const hide = () => { tooltip.hidden = true; };
    marker.addEventListener('mouseenter', show);
    marker.addEventListener('mouseleave', hide);
    marker.addEventListener('focus', show);
    marker.addEventListener('blur', hide);
    const open = () => document.querySelector(`.job-row[data-id="${CSS.escape(entry.jobs[0].id)}"]`)?.scrollIntoView({ behavior:'smooth', block:'center' });
    marker.addEventListener('click', open);
    marker.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    svg.appendChild(marker);
  });
  _renderJobMetroList(entries);
  const mappedCount = mappedJobs.size;
  summary.textContent = `${mappedCount} mapped application${mappedCount === 1 ? '' : 's'} · ${markers.length} map marker${markers.length === 1 ? '' : 's'}`;
  message.hidden = true;
  if (!entries.length) {
    message.hidden = false;
    message.textContent = jobs.length ? 'Add a city to an on-site or hybrid application to see it here.' : 'Add a job application to start mapping locations.';
  }
  if (unmapped.length) {
    footer.className = 'jobs-map-footer jobs-map-unmapped';
    footer.textContent = `Could not place: ${unmapped.join(', ')}. Use City, ST in the location field.`;
  } else {
    footer.className = 'jobs-map-footer';
  }
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

// Add new job
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.id !== 'jobAddInput') return;
  const name = e.target.value.trim();
  if (!name) return;
  const jobs = getJobs();
  jobs.unshift({ id: _jobId(), company:name, role:'', platform:'', dateApplied:_todayStr(), status:'Applied', locationType:'', locationCities:[] });
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
  const counts = {};
  getJobs().forEach(j => { if (j.platform) counts[j.platform] = (counts[j.platform] || 0) + 1; });
  list.innerHTML = '';
  keys.forEach((key, idx) => {
    const site = _jobSiteCatalogEntry(key);
    if (site) list.appendChild(buildJobSiteRow(site, idx, counts[site.name] || 0));
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

function buildJobSiteRow(site, idx, count) {
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

  if (count > 0) {
    const countEl = document.createElement('span');
    countEl.className = 'job-site-count';
    countEl.textContent = count;
    countEl.title = count === 1 ? '1 application' : count + ' applications';
    li.appendChild(countEl);
  }

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
async function _syncReferrals(referrals) {
  if (LOCAL_MODE) return _saveLocal();
  const uid = await _requireUid(); if (!uid) return;
  if (!referrals.length) return;
  const { error } = await sb.from('referrals').upsert(referrals.map((r, i) => ({
    id: r.id, user_id: uid, name: r.name, job_id: r.jobId || null,
    sort_order: i, created_at: r.createdAt || null,
  })), { onConflict: 'id' });
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

  const job = r.jobId ? _getJobById(r.jobId) : null;
  const pill = document.createElement('span');
  pill.className = job ? 'job-pill' : 'job-pill job-pill-empty';
  pill.dataset.action = 'referral-company';
  pill.dataset.id = r.id;
  pill.textContent = job ? job.company : '—';
  li.appendChild(pill);

  const del = document.createElement('button');
  del.className = 'referral-delete';
  del.type = 'button';
  del.textContent = '×';
  del.title = 'Remove referral';
  del.addEventListener('click', () => deleteReferral(r.id));
  li.appendChild(del);

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
      unlink.addEventListener('click', () => { _updateReferral(id, { jobId: null }); _closeJobDropdown(); });
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
      item.addEventListener('click', () => { _updateReferral(id, { jobId: job.id }); _closeJobDropdown(); });
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
