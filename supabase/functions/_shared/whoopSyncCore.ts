// Shared by whoop-sync (browser, JWT-authenticated) and whoop-webhook
// (WHOOP-authenticated, no user session) — both just need "do a full WHOOP
// sync for this Supabase user_id" with a service-role client already in
// hand. Keeping this in one place means the refresh/fetch/upsert logic
// can't drift between the two call paths.

// deno-lint-ignore-file no-explicit-any

const WHOOP_CLIENT_ID = "29c60061-61cd-423a-a2f0-feef12b8ce42";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_API = "https://api.prod.whoop.com/developer/v2";

// Refresh proactively if the access token expires within this window.
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

// WHOOP's `timezone_offset` looks like "-04:00" — this converts a cycle's
// start timestamp + that offset into the local calendar date WHOOP itself
// attributes the cycle to, which is what `whoop_recovery` is keyed on.
function localDate(iso: string, timezoneOffset: string): string {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(timezoneOffset ?? "");
  const offsetMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const t = new Date(iso).getTime() + offsetMin * 60_000;
  return new Date(t).toISOString().slice(0, 10);
}

async function whoopFetch(path: string, accessToken: string) {
  const res = await fetch(`${WHOOP_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`WHOOP ${path} -> ${res.status}`);
  return res.json();
}

// Follows WHOOP's nextToken pagination (max 25 records/page) from `start` to now.
async function whoopFetchAll(path: string, start: string, accessToken: string) {
  const out: any[] = [];
  let next: string | null = null;
  do {
    const qs = `start=${encodeURIComponent(start)}&limit=25${next ? `&nextToken=${encodeURIComponent(next)}` : ""}`;
    const page = await whoopFetch(`${path}?${qs}`, accessToken);
    out.push(...(page?.records ?? []));
    next = page?.next_token ?? null;
  } while (next);
  return out;
}

// First sync backfills this far; later syncs re-pull a few days so late
// score updates (recovery/sleep re-scored after the fact) are picked up.
const BACKFILL_DAYS = 90;
const RESYNC_DAYS = 3;

export async function runWhoopSync(
  sb: any,
  userId: string,
  clientSecret: string,
): Promise<{ connected: boolean; recovery?: any; recoveries?: any[]; workouts?: any[]; profile?: any; error?: string }> {
  const { data: tokenRow, error: tokenErr } = await sb
    .from("whoop_tokens")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (tokenErr) return { connected: false, error: "token lookup failed" };
  if (!tokenRow) return { connected: false };

  let accessToken = tokenRow.access_token as string;
  const expiresAt = new Date(tokenRow.expires_at as string).getTime();

  if (expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    const refreshRes = await fetch(WHOOP_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenRow.refresh_token as string,
        client_id: WHOOP_CLIENT_ID,
        client_secret: clientSecret,
      }),
    });

    if (!refreshRes.ok) {
      console.error("whoop refresh failed", refreshRes.status);
      return { connected: true, error: "reauth_required" };
    }

    const refreshed = await refreshRes.json();
    accessToken = refreshed.access_token;
    const newRefreshToken = refreshed.refresh_token ?? tokenRow.refresh_token;
    const newExpiresAt = new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString();

    await sb
      .from("whoop_tokens")
      .update({
        access_token: accessToken,
        refresh_token: newRefreshToken,
        expires_at: newExpiresAt,
        scope: refreshed.scope ?? tokenRow.scope,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  }

  try {
    const dateQuery = (ascending: boolean) =>
      sb.from("whoop_recovery").select("date").eq("user_id", userId)
        .order("date", { ascending }).limit(1).maybeSingle();
    const [{ data: firstRow }, { data: lastRow }] = await Promise.all([dateQuery(true), dateQuery(false)]);
    const backfillMs = Date.now() - BACKFILL_DAYS * 86_400_000;
    // ponytail: re-walks the full window every sync while history is shorter
    // than BACKFILL_DAYS (e.g. a new WHOOP account); ~4 requests per 25 days.
    const startMs = !firstRow || new Date(firstRow.date).getTime() > backfillMs + 86_400_000
      ? backfillMs
      : new Date(lastRow.date).getTime() - RESYNC_DAYS * 86_400_000;
    const start = new Date(startMs).toISOString();

    const [cycles, recoveries, sleeps, workouts, profile, bodyMeasurement] = await Promise.all([
      whoopFetchAll("/cycle", start, accessToken),
      whoopFetchAll("/recovery", start, accessToken).catch(() => []),
      whoopFetchAll("/activity/sleep", start, accessToken).catch(() => []),
      whoopFetchAll("/activity/workout", start, accessToken).catch(() => []),
      whoopFetch("/user/profile/basic", accessToken).catch(() => null),
      whoopFetch("/user/measurement/body", accessToken).catch(() => null),
    ]);
    if (!cycles.length) {
      return { connected: true, recovery: null, recoveries: [], workouts: [], profile: null };
    }

    // Opportunistically back-fill whoop_user_id if it's missing (e.g. the
    // best-effort fetch during the OAuth callback failed) — the webhook
    // looks up which Supabase user an event belongs to by this column.
    if (profile?.user_id != null && !tokenRow.whoop_user_id) {
      await sb.from("whoop_tokens").update({ whoop_user_id: String(profile.user_id) }).eq("user_id", userId);
    }

    const recoveryByCycle = new Map(recoveries.map((r: any) => [r.cycle_id, r]));
    const sleepById = new Map(sleeps.map((s: any) => [s.id, s]));

    // Keyed by date, oldest cycle first, so if two cycles land on the same
    // wake-up date the newer one wins (and one upsert never hits a key twice).
    const rowsByDate = new Map<string, any>();
    for (const cycle of [...cycles].sort((a, b) => (a.start < b.start ? -1 : 1))) {
      const recovery: any = recoveryByCycle.get(cycle.id) ?? null;
      const sleep: any = (recovery?.sleep_id && sleepById.get(recovery.sleep_id)) ??
        sleeps.find((s: any) => s.cycle_id === cycle.id && !s.nap) ?? null;

      // Keyed by the day you WOKE UP, not the cycle's own start — WHOOP
      // attributes a cycle to the day before the sleep that ends it, which
      // would otherwise date last night's data as yesterday even though the
      // wake-up (and the rest of the cycle) belongs to today.
      const date = sleep?.end
        ? localDate(sleep.end, sleep.timezone_offset ?? cycle.timezone_offset)
        : localDate(cycle.start, cycle.timezone_offset);

      rowsByDate.set(date, {
        user_id: userId,
        date,
        cycle_score_state: cycle.score_state ?? null,
        strain: cycle.score?.strain ?? null,
        avg_heart_rate: cycle.score?.average_heart_rate ?? null,
        max_heart_rate: cycle.score?.max_heart_rate ?? null,
        kilojoule: cycle.score?.kilojoule ?? null,
        recovery_score_state: recovery?.score_state ?? null,
        user_calibrating: recovery?.score?.user_calibrating ?? null,
        recovery_score: recovery?.score?.recovery_score ?? null,
        resting_hr: recovery?.score?.resting_heart_rate ?? null,
        hrv_ms: recovery?.score?.hrv_rmssd_milli ?? null,
        spo2_percentage: recovery?.score?.spo2_percentage ?? null,
        skin_temp_celsius: recovery?.score?.skin_temp_celsius ?? null,
        sleep_score_state: sleep?.score_state ?? null,
        is_nap: sleep?.nap ?? null,
        sleep_start: sleep?.start ?? null,
        sleep_end: sleep?.end ?? null,
        sleep_performance: sleep?.score?.sleep_performance_percentage ?? null,
        sleep_efficiency_percentage: sleep?.score?.sleep_efficiency_percentage ?? null,
        sleep_consistency_percentage: sleep?.score?.sleep_consistency_percentage ?? null,
        respiratory_rate: sleep?.score?.respiratory_rate ?? null,
        total_in_bed_ms: sleep?.score?.stage_summary?.total_in_bed_time_milli ?? null,
        total_awake_ms: sleep?.score?.stage_summary?.total_awake_time_milli ?? null,
        total_no_data_ms: sleep?.score?.stage_summary?.total_no_data_time_milli ?? null,
        light_sleep_ms: sleep?.score?.stage_summary?.total_light_sleep_time_milli ?? null,
        deep_sleep_ms: sleep?.score?.stage_summary?.total_slow_wave_sleep_time_milli ?? null,
        rem_sleep_ms: sleep?.score?.stage_summary?.total_rem_sleep_time_milli ?? null,
        sleep_cycle_count: sleep?.score?.stage_summary?.sleep_cycle_count ?? null,
        disturbance_count: sleep?.score?.stage_summary?.disturbance_count ?? null,
        sleep_need_baseline_ms: sleep?.score?.sleep_needed?.baseline_milli ?? null,
        sleep_need_debt_ms: sleep?.score?.sleep_needed?.need_from_sleep_debt_milli ?? null,
        sleep_need_strain_ms: sleep?.score?.sleep_needed?.need_from_recent_strain_milli ?? null,
        sleep_need_nap_ms: sleep?.score?.sleep_needed?.need_from_recent_nap_milli ?? null,
        raw: { cycle, recovery, sleep },
        synced_at: new Date().toISOString(),
      });
    }

    const recoveryRows = [...rowsByDate.values()];
    const { error: recErr } = await sb
      .from("whoop_recovery")
      .upsert(recoveryRows, { onConflict: "user_id,date" });
    if (recErr) console.error("whoop_recovery upsert failed", recErr.message);

    const workoutRows = workouts.map((w: any) => ({
      id: String(w.id),
      user_id: userId,
      start: w.start,
      end: w.end,
      sport_id: w.sport_id ?? null,
      sport_name: w.sport_name ?? null,
      score_state: w.score_state ?? null,
      strain: w.score?.strain ?? null,
      avg_heart_rate: w.score?.average_heart_rate ?? null,
      max_heart_rate: w.score?.max_heart_rate ?? null,
      kilojoule: w.score?.kilojoule ?? null,
      percent_recorded: w.score?.percent_recorded ?? null,
      distance_meter: w.score?.distance_meter ?? null,
      altitude_gain_meter: w.score?.altitude_gain_meter ?? null,
      altitude_change_meter: w.score?.altitude_change_meter ?? null,
      zone_0_ms: w.score?.zone_durations?.zone_zero_milli ?? null,
      zone_1_ms: w.score?.zone_durations?.zone_one_milli ?? null,
      zone_2_ms: w.score?.zone_durations?.zone_two_milli ?? null,
      zone_3_ms: w.score?.zone_durations?.zone_three_milli ?? null,
      zone_4_ms: w.score?.zone_durations?.zone_four_milli ?? null,
      zone_5_ms: w.score?.zone_durations?.zone_five_milli ?? null,
      raw: w,
      synced_at: new Date().toISOString(),
    }));

    if (workoutRows.length) {
      const { error: woErr } = await sb.from("whoop_workouts").upsert(workoutRows);
      if (woErr) console.error("whoop_workouts upsert failed", woErr.message);
    }

    const profileRow = {
      user_id: userId,
      first_name: profile?.first_name ?? null,
      last_name: profile?.last_name ?? null,
      email: profile?.email ?? null,
      height_meter: bodyMeasurement?.height_meter ?? null,
      weight_kilogram: bodyMeasurement?.weight_kilogram ?? null,
      max_heart_rate: bodyMeasurement?.max_heart_rate ?? null,
      raw: { profile, bodyMeasurement },
      synced_at: new Date().toISOString(),
    };
    const { error: profErr } = await sb.from("whoop_profile").upsert(profileRow);
    if (profErr) console.error("whoop_profile upsert failed", profErr.message);

    const latest = recoveryRows.reduce((a, b) => (a.date > b.date ? a : b));
    const latestCycle = latest.raw.cycle;
    const latestWorkouts = workoutRows.filter((w: any) =>
      w.start >= latestCycle.start && (!latestCycle.end || w.start < latestCycle.end));

    return {
      connected: true,
      recovery: latest,
      recoveries: recoveryRows,
      workouts: latestWorkouts,
      profile: profileRow,
    };
  } catch (e) {
    console.error("whoop sync fetch failed", (e as Error).message);
    return { connected: true, error: "whoop_unreachable" };
  }
}
