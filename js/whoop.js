// WHOOP tab — connect flow + rendering. Actual OAuth/API work happens in the
// two Supabase Edge Functions (whoop-oauth-callback, whoop-sync); this file
// only ever talks to those two functions and to the whoop_recovery /
// whoop_workouts / whoop_profile tables (loaded into MEM by loadFromSupabase
// in js/main.js, same as every other tab).

function _whoopFnUrl(name) {
  return SUPABASE_URL + '/functions/v1/' + name;
}

async function _whoopAccessToken() {
  if (LOCAL_MODE) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token || null;
}

async function whoopConnectStart() {
  const errEl = document.getElementById('whoopConnectError');
  errEl.hidden = true;
  if (LOCAL_MODE) {
    errEl.textContent = 'Sign in with your real account to connect WHOOP.';
    errEl.hidden = false;
    return;
  }
  const token = await _whoopAccessToken();
  if (!token) {
    errEl.textContent = 'Not signed in.';
    errEl.hidden = false;
    return;
  }
  try {
    const res = await fetch(_whoopFnUrl('whoop-oauth-callback') + '?action=start', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const body = await res.json();
    if (!res.ok || !body.url) throw new Error(body.error || 'failed to start');
    location.href = body.url;
  } catch (e) {
    errEl.textContent = 'Could not start WHOOP connection: ' + e.message;
    errEl.hidden = false;
  }
}

let _whoopSyncing = false;
let _whoopProbedOnce = false;

async function whoopSync() {
  if (LOCAL_MODE || _whoopSyncing) return;
  _whoopSyncing = true;
  const syncBtn = document.getElementById('whoopSyncBtn');
  if (syncBtn) { syncBtn.disabled = true; syncBtn.textContent = 'Syncing…'; }
  try {
    const token = await _whoopAccessToken();
    if (!token) throw new Error('not signed in');
    const res = await fetch(_whoopFnUrl('whoop-sync'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'sync failed');
    _whoopApplySyncResult(body);
  } catch (e) {
    console.error('whoop sync failed:', e);
    _whoopSetBanner('WHOOP unreachable — showing last-known data.');
  } finally {
    _whoopSyncing = false;
    if (syncBtn) { syncBtn.disabled = false; syncBtn.textContent = 'Sync now'; }
  }
}

function _whoopApplySyncResult(body) {
  if (!body.connected) {
    MEM['whoop:recovery'] = [];
    MEM['whoop:workouts'] = [];
    MEM['whoop:profile'] = null;
    renderWhoop();
    return;
  }
  if (body.error) {
    _whoopSetBanner(body.error === 'reauth_required'
      ? 'WHOOP access expired — reconnect below.'
      : 'WHOOP unreachable — showing last-known data.');
    if (body.error === 'reauth_required') MEM['whoop:recovery'] = [];
    renderWhoop();
    return;
  }
  if (body.recovery) {
    const existing = (MEM['whoop:recovery'] || []).filter(r => r.date !== body.recovery.date);
    MEM['whoop:recovery'] = [body.recovery, ...existing].sort((a, b) => (a.date < b.date ? 1 : -1));
  }
  if (body.workouts) MEM['whoop:workouts'] = body.workouts;
  if (body.profile) MEM['whoop:profile'] = body.profile;
  _whoopSetBanner(null);
  renderWhoop();
}

function _whoopSetBanner(msg) {
  const el = document.getElementById('whoopBanner');
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; }
  else { el.hidden = true; el.textContent = ''; }
}

function _whoopMsToHours(ms) {
  if (ms == null) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h + 'h ' + m + 'm';
}

function _whoopFmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// The Day Ring's "awake window" starts at WAKE_HOUR (js/main.js), a fixed
// 8 AM default. If WHOOP has today's real wake-up time, use that instead —
// and it naturally resets to the default each day since this looks up
// *today's* row only, never yesterday's.
function _whoopApplyWakeTime() {
  const today = _localDateStr(new Date());
  const row = (MEM['whoop:recovery'] || []).find(r => r.date === today);
  if (row && row.sleep_end) {
    const d = new Date(row.sleep_end);
    WAKE_HOUR = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  } else {
    WAKE_HOUR = 8;
  }
  if (typeof updateDayBar === 'function') updateDayBar();
}

function renderWhoop() {
  _whoopApplyWakeTime();

  const notConnectedEl = document.getElementById('whoopNotConnected');
  const connectedEl = document.getElementById('whoopConnected');
  const recoveryList = MEM['whoop:recovery'] || [];
  const hasEverConnected = recoveryList.length > 0 || !!MEM['whoop:profile'];

  if (!hasEverConnected) {
    notConnectedEl.hidden = false;
    connectedEl.hidden = true;
    // Ambiguous: could mean "never connected" or "connected, nothing synced
    // yet" — resolve it once with a quiet probe rather than guessing.
    if (!LOCAL_MODE && !_whoopProbedOnce) {
      _whoopProbedOnce = true;
      whoopSync();
    }
    return;
  }

  notConnectedEl.hidden = true;
  connectedEl.hidden = false;

  const today = _localDateStr(new Date());
  const todayRow = recoveryList.find(r => r.date === today) || recoveryList[0];

  document.getElementById('whoopDate').textContent = todayRow.date === today ? 'Today' : todayRow.date;
  document.getElementById('whoopRecoveryVal').textContent =
    todayRow.recovery_score != null ? todayRow.recovery_score + '%' : '—';
  document.getElementById('whoopStrainVal').textContent =
    todayRow.strain != null ? Number(todayRow.strain).toFixed(1) : '—';
  document.getElementById('whoopSleepVal').textContent =
    todayRow.sleep_performance != null ? todayRow.sleep_performance + '%' : '—';

  const sleepWindowEl = document.getElementById('whoopSleepWindow');
  if (todayRow.sleep_start && todayRow.sleep_end) {
    sleepWindowEl.textContent =
      _whoopFmtTime(todayRow.sleep_start) + '  →  ' + _whoopFmtTime(todayRow.sleep_end) +
      (todayRow.is_nap ? '  (nap)' : '');
    sleepWindowEl.hidden = false;
  } else {
    sleepWindowEl.hidden = true;
  }

  // Every column whoop_recovery stores, unrounded/unfiltered — this tab is
  // for seeing exactly what WHOOP's API returns, not a curated summary.
  const ms = (v) => _whoopMsToHours(v);
  const num = (v, unit, digits) => v != null ? Number(v).toFixed(digits ?? 0) + (unit || '') : '—';
  const details = [
    ['Cycle State', todayRow.cycle_score_state || '—'],
    ['Cycle Avg HR', num(todayRow.avg_heart_rate, ' bpm')],
    ['Cycle Max HR', num(todayRow.max_heart_rate, ' bpm')],
    ['Kilojoule', num(todayRow.kilojoule, ' kJ')],
    ['Recovery State', todayRow.recovery_score_state || '—'],
    ['Calibrating', todayRow.user_calibrating == null ? '—' : (todayRow.user_calibrating ? 'yes' : 'no')],
    ['HRV', num(todayRow.hrv_ms, ' ms')],
    ['Resting HR', num(todayRow.resting_hr, ' bpm')],
    ['SpO2', num(todayRow.spo2_percentage, '%', 1)],
    ['Skin Temp', num(todayRow.skin_temp_celsius, '°C', 1)],
    ['Sleep State', todayRow.sleep_score_state || '—'],
    ['Sleep Efficiency', num(todayRow.sleep_efficiency_percentage, '%', 1)],
    ['Sleep Consistency', num(todayRow.sleep_consistency_percentage, '%', 1)],
    ['Respiratory Rate', num(todayRow.respiratory_rate, '/min', 1)],
    ['Time in Bed', ms(todayRow.total_in_bed_ms)],
    ['Time Awake', ms(todayRow.total_awake_ms)],
    ['No-Data Time', ms(todayRow.total_no_data_ms)],
    ['Light Sleep', ms(todayRow.light_sleep_ms)],
    ['Deep (SWS) Sleep', ms(todayRow.deep_sleep_ms)],
    ['REM Sleep', ms(todayRow.rem_sleep_ms)],
    ['Sleep Cycles', todayRow.sleep_cycle_count ?? '—'],
    ['Disturbances', todayRow.disturbance_count ?? '—'],
    ['Sleep Need: Baseline', ms(todayRow.sleep_need_baseline_ms)],
    ['Sleep Need: Debt', ms(todayRow.sleep_need_debt_ms)],
    ['Sleep Need: Strain', ms(todayRow.sleep_need_strain_ms)],
    ['Sleep Need: Nap', ms(todayRow.sleep_need_nap_ms)],
  ];
  document.getElementById('whoopDetailGrid').innerHTML = details.map(([label, val]) =>
    '<div class="whoop-detail"><div class="whoop-detail-label">' + label + '</div>' +
    '<div class="whoop-detail-value">' + val + '</div></div>'
  ).join('');

  document.getElementById('whoopRawJson').textContent =
    todayRow.raw ? JSON.stringify(todayRow.raw, null, 2) : '(no raw payload stored for this row)';

  const workouts = (MEM['whoop:workouts'] || [])
    .filter(w => w.start && _localDateStr(new Date(w.start)) === todayRow.date);
  const workoutsEmpty = document.getElementById('whoopWorkoutsEmpty');
  const workoutsList = document.getElementById('whoopWorkoutsList');
  if (!workouts.length) {
    workoutsEmpty.hidden = false;
    workoutsList.innerHTML = '';
  } else {
    workoutsEmpty.hidden = true;
    const wms = (v) => _whoopMsToHours(v);
    const wnum = (v, unit, digits) => v != null ? Number(v).toFixed(digits ?? 0) + (unit || '') : '—';
    workoutsList.innerHTML = workouts.map(w => {
      const timeRange = _whoopFmtTime(w.start) + ' – ' + _whoopFmtTime(w.end);
      const fields = [
        ['Sport ID', w.sport_id ?? '—'],
        ['State', w.score_state || '—'],
        ['Avg HR', wnum(w.avg_heart_rate, ' bpm')],
        ['Max HR', wnum(w.max_heart_rate, ' bpm')],
        ['Kilojoule', wnum(w.kilojoule, ' kJ')],
        ['% Recorded', wnum(w.percent_recorded, '%')],
        ['Distance', wnum(w.distance_meter, ' m')],
        ['Altitude Gain', wnum(w.altitude_gain_meter, ' m')],
        ['Altitude Change', wnum(w.altitude_change_meter, ' m')],
        ['Zone 0', wms(w.zone_0_ms)], ['Zone 1', wms(w.zone_1_ms)], ['Zone 2', wms(w.zone_2_ms)],
        ['Zone 3', wms(w.zone_3_ms)], ['Zone 4', wms(w.zone_4_ms)], ['Zone 5', wms(w.zone_5_ms)],
      ];
      return '<div class="whoop-workout">' +
        '<div style="flex:1">' +
        '<div class="whoop-workout-name">' + (w.sport_name || 'Workout') + '</div>' +
        '<div class="whoop-workout-time">' + timeRange + '</div>' +
        '<div class="whoop-detail-grid" style="margin-top:8px;padding-top:0;border-top:none">' +
        fields.map(([label, val]) =>
          '<div class="whoop-detail"><div class="whoop-detail-label">' + label + '</div>' +
          '<div class="whoop-detail-value">' + val + '</div></div>'
        ).join('') +
        '</div>' +
        '<details class="whoop-workout-detail"><summary>Raw workout JSON</summary>' +
        '<pre>' + JSON.stringify(w.raw ?? w, null, 2) + '</pre></details>' +
        '</div>' +
        '<div class="whoop-workout-strain">' + (w.strain != null ? Number(w.strain).toFixed(1) : '—') + '</div>' +
        '</div>';
    }).join('');
  }

  const profile = MEM['whoop:profile'];
  const profileEl = document.getElementById('whoopProfileCard');
  if (profile) {
    const parts = [];
    if (profile.first_name) {
      parts.push('<span><b>' + profile.first_name + (profile.last_name ? ' ' + profile.last_name : '') + '</b></span>');
    }
    if (profile.email) parts.push('<span>' + profile.email + '</span>');
    if (profile.height_meter) parts.push('<span>Height ' + (profile.height_meter * 100).toFixed(1) + ' cm</span>');
    if (profile.weight_kilogram) parts.push('<span>Weight ' + profile.weight_kilogram.toFixed(1) + ' kg</span>');
    if (profile.max_heart_rate) parts.push('<span>Max HR ' + profile.max_heart_rate + ' bpm</span>');
    profileEl.innerHTML = parts.join('') +
      '<details class="whoop-workout-detail" style="flex-basis:100%"><summary>Raw profile JSON</summary>' +
      '<pre>' + JSON.stringify(profile.raw ?? profile, null, 2) + '</pre></details>';
    profileEl.hidden = parts.length === 0;
  } else {
    profileEl.hidden = true;
  }

  const isStale = todayRow.date !== today;
  _whoopSetBanner(isStale ? 'Showing last synced data from ' + todayRow.date + '.' : null);
}

function _whoopHandleOAuthReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get('whoop');
  if (!status) return;
  params.delete('whoop');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  if (status === 'connected') {
    _whoopProbedOnce = true;
    whoopSync();
  } else if (status === 'error') {
    _whoopSetBanner('Connecting to WHOOP failed. Please try again.');
  }
}

document.getElementById('whoopConnectBtn').addEventListener('click', whoopConnectStart);
document.getElementById('whoopSyncBtn').addEventListener('click', () => whoopSync());
