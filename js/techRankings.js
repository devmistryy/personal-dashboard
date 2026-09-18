// Read-only Tech Location Rankings on the Jobs tab.
let _techRankingMode = 'metro';
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
          id:`other:${otherKey}`, name:`Out-of-pocket city: ${entry.label}`, kind:'other',
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

function renderTechRankings() {
  const list = document.getElementById('techRankingList');
  if (!list) return;
  const isApplications = _techRankingMode === 'applications';
  const isMetro = _techRankingMode === 'metro';
  const rows = isApplications
    ? _applicationLocationRows
    : isMetro
    ? [...techMetros].sort((a, b) => a.metroTechRank - b.metroTechRank)
    : [...techCities].sort((a, b) => a.cityTechRank - b.cityTechRank);
  const fragment = document.createDocumentFragment();
  rows.forEach((row, index) => {
    const item = document.createElement('li');
    item.className = 'tech-rank-row';
    const rank = isApplications ? index + 1 : isMetro ? row.metroTechRank : row.cityTechRank;
    item.value = rank;
    const position = document.createElement('div');
    position.className = 'tech-rank-position';
    if (isApplications) {
      position.classList.add('tech-rank-application-position', `tech-rank-application-position-${row.kind}`);
      position.setAttribute('aria-label', row.kind === 'core' ? 'Major city' : row.kind === 'metro' ? 'Metro area' : 'Out-of-pocket city');
    } else {
      position.classList.add('tech-rank-neutral-position');
    }
    const number = document.createElement('span');
    number.className = 'tech-rank-number';
    number.textContent = `${rank}`;
    number.setAttribute('aria-hidden', 'true');
    position.appendChild(number);
    item.appendChild(position);
    const content = document.createElement('div');
    content.className = 'tech-rank-content';
    let applicationCount = null;
    const name = document.createElement('strong');
    name.className = 'tech-rank-name';
    name.textContent = row.name;
    content.appendChild(name);
    if (isApplications) {
      applicationCount = document.createElement('span');
      applicationCount.className = 'tech-rank-application-count';
      const total = document.createElement('strong');
      total.textContent = row.jobs.length;
      const label = document.createElement('span');
      label.textContent = 'APPS';
      applicationCount.append(total, label);
    } else if (isMetro) {
      const applicationRow = _applicationLocationRows.find(item => item.id === `metro:${row.id}`);
      applicationCount = document.createElement('span');
      applicationCount.className = 'tech-rank-application-count';
      const total = document.createElement('strong');
      total.textContent = applicationRow?.jobs.length || 0;
      const label = document.createElement('span');
      label.textContent = 'APPS';
      applicationCount.append(total, label);
      const detail = document.createElement('span');
      detail.className = 'tech-rank-detail';
      const majorCityNames = new Set(techCities
        .filter(city => city.metroId === row.id)
        .flatMap(city => [city.name, ...(TECH_CITY_APPLICATION_ALIASES[city.name] || [])])
        .map(name => name.toLowerCase()));
      const areas = (row.includedAreas || techCities.filter(city => city.metroId === row.id).map(city => city.name))
        .filter(area => !majorCityNames.has(area.toLowerCase()));
      detail.textContent = areas.join(' · ');
      content.appendChild(detail);
    } else {
      const applicationRow = _applicationLocationRows.find(item => item.id === `city:${row.id}`);
      applicationCount = document.createElement('span');
      applicationCount.className = 'tech-rank-application-count';
      const total = document.createElement('strong');
      total.textContent = applicationRow?.jobs.length || 0;
      const label = document.createElement('span');
      label.textContent = 'APPS';
      applicationCount.append(total, label);
    }
    if (applicationCount) {
      const total = applicationCount.querySelector('strong');
      const applicationRow = isApplications
        ? row
        : _applicationLocationRows.find(item => item.id === `${isMetro ? 'metro' : 'city'}:${row.id}`);
      const totalColor = isApplications
        ? row.kind === 'core'
          ? _jobMapCityColor(row.jobs.length)
          : row.kind === 'metro'
          ? _jobMapMetroColor(row.jobs.length)
          : '#e1ba63'
        : isMetro
        ? _jobMapMetroColor(applicationRow?.jobs.length || 0)
        : _jobMapCityColor(applicationRow?.jobs.length || 0);
      total.style.color = totalColor;
    }
    item.appendChild(content);
    if (applicationCount) item.appendChild(applicationCount);
    fragment.appendChild(item);
  });
  list.replaceChildren(fragment);
  list.setAttribute('aria-label', isApplications ? 'Application locations ranked by application count' : isMetro ? 'Metro technology opportunity ranking' : 'City technology opportunity ranking');
  document.getElementById('techRankingCount').textContent = `${rows.length} ${isApplications ? 'areas' : isMetro ? 'metros' : 'cities'}`;
  document.querySelectorAll('.tech-rank-mode').forEach(button => {
    const active = button.dataset.techMode === _techRankingMode;
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
