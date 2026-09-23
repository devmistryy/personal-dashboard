// Tech Location Rankings on the Jobs tab's Locations view: your applications
// by place (the major city and the rest of its metro counted separately), or
// the fixed metro / city rankings with your counts beside them.
let _techRankingMode = 'applications';
const _techMetroById = new Map(techMetros.map(metro => [metro.id, metro]));
let _applicationLocationRows = [];

function setApplicationLocationRankings(entries) {
  const metroRows = techMetros.map(metro => ({
    id:`metro:${metro.id}`, name:metro.name, kind:'metro', jobs:[], jobIds:new Set(), places:[],
  }));
  const cityRows = techCities.map(city => ({
    id:`city:${city.id}`, name:city.name, kind:'core', jobs:[], jobIds:new Set(), places:[],
  }));
  const otherRows = new Map();
  const metroById = new Map(techMetros.map((metro, index) => [metro.id, metroRows[index]]));
  const cityByName = new Map(techCities.map((city, index) => [city.name.toLowerCase(), cityRows[index]]));
  techCities.forEach((city, index) => {
    (typeof TECH_CITY_APPLICATION_ALIASES === 'undefined' ? [] : TECH_CITY_APPLICATION_ALIASES[city.name] || [])
      .forEach(alias => cityByName.set(alias.toLowerCase(), cityRows[index]));
  });
  entries.forEach(entry => {
    const cityName = (typeof _jobMapCityName === 'function' ? _jobMapCityName(entry.label) : entry.label).toLowerCase();
    const majorCity = cityByName.get(cityName);
    const rankedMetro = typeof getTechMetroForLocation === 'function' ? getTechMetroForLocation(cityName) : null;
    let metroRow = majorCity ? majorCity : metroById.get(rankedMetro?.id);
    if (!metroRow) {
      const otherKey = cityName || entry.label.toLowerCase();
      metroRow = otherRows.get(otherKey);
      if (!metroRow) {
        metroRow = {
          id:`other:${otherKey}`, name:entry.label, kind:'other',
          jobs:[], jobIds:new Set(), places:[],
        };
        otherRows.set(otherKey, metroRow);
      }
    }
    entry.jobs.forEach(job => {
      if (metroRow.jobIds.has(job.id)) return;
      metroRow.jobIds.add(job.id);
      metroRow.jobs.push(job);
    });
    metroRow.places.push({ label:entry.label, kind:majorCity ? 'core' : rankedMetro ? 'metro' : 'other' });
  });
  _applicationLocationRows = [...metroRows, ...cityRows, ...otherRows.values()].map(row => ({
    ...row,
    places:row.places.sort((a, b) => a.label.localeCompare(b.label)),
  })).sort((a, b) => b.jobs.length - a.jobs.length || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  renderTechRankings();
}

// A row's display name: the city itself for a major-city row.
function _techRankRowName(row) {
  if (row.kind === 'core') {
    const city = techCities.find(c => `city:${c.id}` === row.id);
    return city ? city.name : row.name;
  }
  return row.name;
}

// What a row selects on the map: the whole metro (city + metro area), or a
// single unranked place.
function _techPlaceForMetro(metroId) {
  const metro = _techMetroById.get(metroId);
  const cityIds = new Set(techCities.filter(c => c.metroId === metroId).map(c => `city:${c.id}`));
  const cityJobs = _applicationLocationRows.filter(r => cityIds.has(r.id)).flatMap(r => r.jobs);
  const metroJobs = (_applicationLocationRows.find(r => r.id === `metro:${metroId}`) || { jobs:[] }).jobs;
  return { key:'m:' + metroId, label:metro ? metro.name : metroId, cityJobs, metroJobs, jobs:[...cityJobs, ...metroJobs] };
}
function _techRowPlace(row, kind) {
  if (kind === 'other') return { key:'o:' + row.id, label:row.name, cityJobs:[], metroJobs:[], jobs:row.jobs, other:true };
  const metroId = kind === 'metro-rank' ? row.id
    : kind === 'city-rank' ? row.metroId
    : row.kind === 'metro' ? row.id.replace(/^metro:/, '')
    : (techCities.find(c => `city:${c.id}` === row.id) || {}).metroId;
  return metroId ? _techPlaceForMetro(metroId) : null;
}

function renderTechRankings() {
  const list = document.getElementById('techRankingList');
  if (!list) return;
  const mode = _techRankingMode;
  const byId = new Map(_applicationLocationRows.map(r => [r.id, r]));
  const count = id => (byId.get(id) || { jobs:[] }).jobs.length;
  let rows;
  if (mode === 'applications') {
    rows = _applicationLocationRows.filter(r => r.jobs.length).map((r, i) => ({
      num:i + 1, name:_techRankRowName(r), kind:r.kind, n:r.jobs.length,
      place:_techRowPlace(r, r.kind === 'other' ? 'other' : 'apps'),
    }));
  } else if (mode === 'metro') {
    rows = [...techMetros].sort((a, b) => a.metroTechRank - b.metroTechRank).map(m => ({
      num:m.metroTechRank, name:m.name, kind:'metro', n:count(`metro:${m.id}`), place:_techRowPlace(m, 'metro-rank'),
    }));
  } else {
    rows = [...techCities].sort((a, b) => a.cityTechRank - b.cityTechRank).map(c => ({
      num:c.cityTechRank, name:c.name, kind:'core', n:count(`city:${c.id}`), place:_techRowPlace(c, 'city-rank'),
    }));
  }
  const total = typeof _jobOnsiteCount === 'function' ? _jobOnsiteCount() : 0;
  const selKey = typeof _jobPlaceSel !== 'undefined' && _jobPlaceSel ? _jobPlaceSel.key : null;
  const fragment = document.createDocumentFragment();
  rows.forEach(row => {
    const item = document.createElement('li');
    const gap = mode !== 'applications' && row.n === 0 && row.num <= 15;
    item.className = `tech-rank-row${row.n ? '' : ' zero'}${row.place && row.place.key === selKey ? ' selected' : ''}`;
    item.value = row.num;
    item.tabIndex = 0;
    const label = row.kind === 'core' ? 'Major city' : row.kind === 'metro' ? 'Metro area' : 'Not ranked';
    item.innerHTML = `<span class="tech-rank-number" aria-hidden="true">${row.num}</span>` +
      `<span class="tech-rank-name"><i class="tech-kind tech-kind-${row.kind}" title="${label}"></i>${_esc(row.name)}${gap ? '<span class="tech-rank-gap" title="A top-15 place with no applications yet">gap</span>' : ''}</span>` +
      `<span class="tech-rank-n">${row.n}</span>` +
      (typeof _jobShareBar === 'function' ? _jobShareBar(row.n, row.kind === 'core' ? 'core' : row.kind, total) : '');
    item.setAttribute('aria-label', `${row.num}. ${row.name}, ${label.toLowerCase()}: ${row.n} application${row.n === 1 ? '' : 's'}`);
    if (row.place && typeof _selectJobPlace === 'function') {
      const pick = () => _selectJobPlace(row.place);
      item.addEventListener('click', pick);
      item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    }
    fragment.appendChild(item);
  });
  list.replaceChildren(fragment);
  list.setAttribute('aria-label', mode === 'applications' ? 'Your application locations, ranked by application count' : mode === 'metro' ? 'Metro technology opportunity ranking' : 'City technology opportunity ranking');
  document.getElementById('techRankingCount').textContent = `${rows.length} ${mode === 'applications' ? 'places' : mode === 'metro' ? 'metros' : 'cities'}`;
  document.querySelectorAll('.tech-rank-mode').forEach(button => {
    const active = button.dataset.techMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

document.addEventListener('click', event => {
  const button = event.target.closest('.tech-rank-mode');
  if (!button) return;
  _techRankingMode = button.dataset.techMode;
  renderTechRankings();
});
