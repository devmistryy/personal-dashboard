-- ═══════════════════════════════════════════════════════════════
--  MASTER SCRIPT — the one file to run in the Supabase SQL editor.
--  Idempotent end to end — safe to run again any time this file changes.
--
--  Contains, in order:
--    1. Schema — every table + RLS policy the app uses.
--    2. One-time backfill — copies any Diet/Mobility data still sitting in
--       the old `settings` key/value blobs into their new dedicated tables.
--       Idempotent and re-run-safe: each block is a no-op once the target
--       table holds any row for that user (guarded), and `on conflict do
--       nothing` covers the first run, so it can never overwrite live data
--       or bring back a record deleted after the initial migration.
--
--  Storage rule for future tables:
--    • Collections of records (habits, tasks, meals, exercises, sessions, …)
--      get their own table.
--    • Per-user scalar prefs / small singletons live in `settings` (key/value).
--
--  A commented-out cleanup block sits at the very bottom — run it manually,
--  once, only after confirming the app looks right on the new tables.
-- ═══════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────
-- 0. RENAMES (2026-09: "goal" → "task")
--    Guarded so a fresh install (no old objects) and a re-run (new names
--    already in place) are both no-ops. Run before the schema section so the
--    `create table if not exists` blocks below see the renamed objects.
-- ─────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'goals')
     and not exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'tasks') then
    alter table goals rename to tasks;                 -- data, indexes, PK seq, RLS policy travel with it
  end if;
  if exists (select 1 from information_schema.columns
             where table_name = 'tasks' and column_name = 'gid')
     and not exists (select 1 from information_schema.columns
             where table_name = 'tasks' and column_name = 'tid') then
    alter table tasks rename column gid to tid;
  end if;
end $$;

-- settings key/value rows: goal_* → task_*  (idempotent — skips a user whose
-- task_* row already exists, then drops the leftover goal_* row).
update settings set key = 'task_' || substr(key, 6)
  where key in ('goal_streak_v1', 'goal_dismissed_v1', 'goal_sort_v1')
    and not exists (
      select 1 from settings s2
      where s2.user_id = settings.user_id
        and s2.key = 'task_' || substr(settings.key, 6));
delete from settings where key in ('goal_streak_v1', 'goal_dismissed_v1', 'goal_sort_v1', 'goal_rollover_v1');

-- Removed step-linked-habits feature (WHOOP steps via Apple Health → steps-ingest
-- → step_counts). Drop its table, columns and settings blobs.
drop table if exists step_counts;
alter table habits drop column if exists auto_source;
alter table habits drop column if exists auto_goal;
alter table habits drop column if exists step_target;
delete from settings where key in ('step_autocheck_v1', 'step_ingest_token_v1');

-- Sunday Reset: the old sunday_reset_log_v1 marked entries "injected" before the
-- tasks write landed, so a write that failed or lost a race left the entry
-- suppressed for that Sunday forever. Replaced by sunday_reset_removed_v1, which
-- records only the entries you deleted off a Sunday's list; everything else is
-- re-derived from the list itself on each load. Dropping the old rows also
-- un-suppresses the current Sunday, so the missing tasks appear on next load.
delete from settings where key = 'sunday_reset_log_v1';

-- ─────────────────────────────────────────────────────────────
-- 1. SCHEMA
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────── habits ───────────────────────────
create table if not exists habits (
  id          text primary key,
  user_id     uuid references auth.users not null,
  name        text not null,
  start_date  date,
  end_date    date,
  area        text,
  archived    boolean default false,
  archived_at date,
  sort_order  integer,
  end_of_day  boolean default false,
  created_at  timestamptz default now()
);
alter table habits add column if not exists area        text;
alter table habits add column if not exists sort_order  integer;
alter table habits add column if not exists end_of_day  boolean default false;
alter table habits add column if not exists morning_routine boolean default false;
alter table habits add column if not exists night_routine   boolean default false;
-- Finished active spans, appended when an archived habit is started again, so
-- its "Day N" resumes where it stopped instead of going back to day 1 — and so
-- the earlier run keeps its check-ins and its place in each day's completion
-- count. Shape: [{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}, …]
alter table habits add column if not exists runs jsonb default '[]'::jsonb;
-- Superseded by `runs` before either shipped; drop if an early version created them.
alter table habits drop column if exists prior_days;
alter table habits drop column if exists prior_done;
-- 'checkbox' (default, done/not-done) or 'increment' (done N of `target` times
-- a day — see habit_counts). track_type never gates any query, only client
-- rendering, so it's a plain text column rather than an enum.
alter table habits add column if not exists track_type text default 'checkbox';
alter table habits add column if not exists target     integer;
alter table habits enable row level security;

-- ───────────────────────── habit_logs ─────────────────────────
create table if not exists habit_logs (
  user_id  uuid references auth.users not null,
  habit_id text not null,
  date     date not null,
  primary key (user_id, habit_id, date)
);
alter table habit_logs enable row level security;

-- ──────────────────────── habit_counts ────────────────────────
-- Raw daily tally for a track_type='increment' habit — e.g. "drank water 5 of
-- 8 times today". A row only exists once the count is > 0; reaching `target`
-- also adds the day to habit_logs (see setHabitCount in js/habits.js), so
-- streaks, the completion rings and every other done/not-done read still
-- come from habit_logs alone and never need to know about counts.
create table if not exists habit_counts (
  user_id  uuid references auth.users not null,
  habit_id text not null,
  date     date not null,
  count    integer not null default 0,
  primary key (user_id, habit_id, date)
);
alter table habit_counts enable row level security;

-- ───────────────────────── habit_voids ────────────────────────
-- A voided (habit, day) pair didn't count: the day is excused, not failed. It
-- never breaks a streak, never counts toward the day's completion %, and never
-- increments the habit's "Day N". Same shape as habit_logs — one row per pair.
create table if not exists habit_voids (
  user_id  uuid references auth.users not null,
  habit_id text not null,
  date     date not null,
  primary key (user_id, habit_id, date)
);
alter table habit_voids enable row level security;

-- ──────────────────────── habit_notes ─────────────────────────
create table if not exists habit_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users not null,
  habit_id   text not null,                     -- matches habits.id (text)
  text       text not null,
  created_at timestamptz not null default now()
);
create index if not exists habit_notes_user_habit_idx
  on habit_notes (user_id, habit_id);
alter table habit_notes enable row level security;

-- ─────────────────────── reactive_habits ──────────────────────
-- Cue-triggered habits (Situational: something happening around you; Internal:
-- a state you notice in yourself), tracked per-occurrence rather than daily —
-- see reactive_habit_logs. id is text: client generates 'rh_' + uuid (js/reactiveHabits.js _rhId).
create table if not exists reactive_habits (
  id         text primary key,
  user_id    uuid references auth.users not null,
  name       text not null,
  cue_type   text not null check (cue_type in ('situational', 'internal')),
  created_at timestamptz default now()
);
alter table reactive_habits enable row level security;

-- ────────────────────── reactive_habit_logs ───────────────────
-- One row per occurrence: the cue arose and the user logged whether they
-- handled it well. Flat + timestamped like diet_entries, not date-bucketed
-- like habit_logs — an occurrence needs its own time and an outcome, not just
-- a day. id is text: client generates 'rh_' + uuid (js/reactiveHabits.js _rhId).
create table if not exists reactive_habit_logs (
  id         text primary key,
  user_id    uuid references auth.users not null,
  habit_id   text not null,                     -- matches reactive_habits.id
  ts         timestamptz not null,
  outcome    text not null check (outcome in ('good', 'bad')),
  created_at timestamptz default now()
);
create index if not exists reactive_habit_logs_user_habit_idx
  on reactive_habit_logs (user_id, habit_id);
alter table reactive_habit_logs enable row level security;

-- ─────────────────────────── tasks ────────────────────────────
create table if not exists tasks (
  id         bigserial primary key,
  user_id    uuid references auth.users not null,
  date       date not null,
  text       text not null,
  done       boolean default false,
  done_at    timestamptz,
  area       text,
  priority   text default 'Medium',
  tid        text,          -- stable client-generated id (g_…), used for dedup + history
  created_at timestamptz,
  meta       jsonb          -- optional extras: { focus, est, due, steps:[{text,done}] }
);
alter table tasks add column if not exists area       text;
alter table tasks add column if not exists priority   text default 'Medium';
alter table tasks add column if not exists tid        text;
alter table tasks add column if not exists created_at timestamptz;
-- To Do redesign (2026-09-22): Focus flag, time estimate (minutes), due date
-- (YYYY-MM-DD) and step checklist, kept in one jsonb column. The app only sends
-- `meta` for a day once a task on it uses one of these, so days that don't are
-- unaffected even before this runs.
alter table tasks add column if not exists meta       jsonb;
-- Queue feature removed.
alter table tasks drop column if exists queued;
-- done_at migrated bigint(epoch ms) → timestamptz. Guarded so re-runs are no-ops.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'tasks' and column_name = 'done_at' and data_type = 'bigint'
  ) then
    alter table tasks
      alter column done_at type timestamptz
      using case when done_at is null then null
                 else to_timestamp(done_at / 1000.0) end;
  end if;
end $$;
-- Every read and every stale-delete filters on (user_id, date); the load query
-- has no upper date bound any more, so this is what keeps it off a full scan.
create index if not exists tasks_user_date_idx on tasks (user_id, date);
alter table tasks enable row level security;

-- ────────────────────────── settings ──────────────────────────
-- key/value store (value = jsonb). Per-user scalar prefs / small singletons.
-- Backs: habit_sort_v1, task_sort_v1, task_streak_v1, task_dismissed_v1,
--        sunday_reset_v1, sunday_reset_removed_v1, areas:list, area_notes:<name>,
--        job_roles_v1, job_sites_v1, referral_notes_v1
-- (Meals, mobility exercises and sessions live in their own tables below.)
create table if not exists settings (
  user_id uuid references auth.users not null,
  key     text not null,
  value   jsonb,
  primary key (user_id, key)
);
alter table settings enable row level security;

-- ──────────────────── job_applications ────────────────────────
-- id is text: client generates crypto.randomUUID() (see js/jobs.js _jobId)
-- id is uuid (not text) in the live table — confirmed 2026-09-15 when adding
-- the referrals FK below surfaced the mismatch: this file's `id text` was
-- never actually applied here since the table already existed, so it had
-- silently drifted from the real column type. js/jobs.js's _jobId() already
-- generates crypto.randomUUID() strings, which Postgres/PostgREST accept for
-- either column type, so nothing in the app needed to change.
create table if not exists job_applications (
  id            uuid primary key,
  user_id       uuid references auth.users not null,
  company       text not null,
  platform      text,
  date_applied  date,
  status        text default 'Applied',
  location_type text,
  location_cities text[],
  created_at    timestamptz default now()
);
-- Job Role: a free-text value the user picks from their own self-authored
-- option list (settings key 'job_roles_v1', managed inline in the dropdown —
-- see js/jobs.js _renderJobRoleDropdown), not a fixed enum.
alter table job_applications add column if not exists role text;
-- Migrated 2026-09-16: location_city (single string) -> location_cities
-- (text[]) so a hybrid/onsite application can list more than one city (e.g.
-- open to either of two offices). location_type still picks exactly one of
-- remote/hybrid/onsite — that choice stays mutually exclusive.
-- Guarded in a DO block (rather than a plain UPDATE) because the live table
-- had already drifted from this file before this migration was written (see
-- the id-type note above) — it turned out to have no location_city column at
-- all, which would make a bare `update ... set location_cities =
-- array[location_city]` fail with "column does not exist" before the `drop
-- column if exists` below ever ran. Checking information_schema first keeps
-- this file safe to run regardless of whatever the live table's actual
-- pre-migration shape is.
alter table job_applications add column if not exists location_cities text[];
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'job_applications' and column_name = 'location_city'
  ) then
    update job_applications set location_cities = array[location_city]
      where location_city is not null and location_cities is null;
    alter table job_applications drop column location_city;
  end if;
end $$;
alter table job_applications enable row level security;

-- ───────────────────────── referrals ─────────────────────────
-- People who can refer the user into a company, shown in the Jobs tab
-- sidebar below Job Boards. Optionally linked to a job_applications row;
-- unlinking (or the linked application being deleted) just clears the
-- company, it doesn't delete the referral. id is text: client generates
-- 'rf_' + uuid (js/jobs.js _referralId).
create table if not exists referrals (
  id         text primary key,
  user_id    uuid references auth.users not null,
  name       text not null,
  job_id     uuid references job_applications(id) on delete set null,
  sort_order integer,
  created_at timestamptz default now()
);
alter table referrals enable row level security;

-- ─────────────────────────── goals ────────────────────────────
-- Long-term objectives shown in the "Areas & Goals" tab, each optionally
-- tagged to an area (by name). Distinct from `tasks` (daily to-dos).
-- id is text: client generates 'gl_' + uuid (js/goals.js _goalId).
create table if not exists goals (
  id         text primary key,
  user_id    uuid references auth.users not null,
  title      text not null,
  area       text,                        -- area name, or null = unassigned
  notes      text,
  done       boolean default false,
  done_at    timestamptz,
  sort_order integer,
  created_at timestamptz default now()
);
alter table goals add column if not exists notes      text;
alter table goals add column if not exists done_at    timestamptz;
alter table goals add column if not exists sort_order integer;
alter table goals enable row level security;

-- ─────────────────────────── areas ────────────────────────────
-- Currently unused: areas + area notes persist via `settings`
-- (keys 'areas:list', 'area_notes:<name>'). Kept for future use.
create table if not exists areas (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users not null,
  name       text not null,
  color      text not null,
  sort_order integer not null default 0,
  created_at timestamptz default now()
);
alter table areas enable row level security;

-- ─────────────────────── diet_entries ─────────────────────────
-- one row per logged meal. id is text: 'd_' + base36 (js/diet.js _dietId).
-- The per-meal tag arrays stay jsonb — the analyzable record is the meal.
create table if not exists diet_entries (
  id          text primary key,
  user_id     uuid references auth.users not null,
  date        date not null,
  time        text,
  description text,                                -- 'desc' is a reserved word
  calories    integer,
  protein     integer,
  carbs       integer,
  fats        integer,
  category    text,                                -- 'Homecooked Meal' | 'Outside Food' | 'Fast Food'
  healthy_ingredients jsonb not null default '[]', -- string[]
  unhealthy_foods     jsonb not null default '[]', -- string[]
  created_at  timestamptz default now()
);
create index if not exists diet_entries_user_date_idx
  on diet_entries (user_id, date);
alter table diet_entries enable row level security;

-- ──────────────────────── diet_foods ──────────────────────────
-- the master "healthy ingredients" / "unhealthy foods" lists
create table if not exists diet_foods (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users not null,
  name       text not null,
  kind       text not null,                        -- 'healthy' | 'unhealthy'
  created_at timestamptz default now(),
  unique (user_id, name, kind)
);
alter table diet_foods enable row level security;

-- ─────────────────── mobility_exercises ───────────────────────
-- the exercise list. id is text: 's_' + base36 (js/mobility.js _mobId).
create table if not exists mobility_exercises (
  id           text primary key,
  user_id      uuid references auth.users not null,
  name         text not null,
  session      text not null default 'morning',    -- 'morning' | 'night'
  measure      text not null default 'hold',       -- 'hold' | 'reps'
  sets         integer not null default 1,
  hold_seconds integer,                             -- set when measure = 'hold'
  reps         integer,                             -- set when measure = 'reps'
  frequency    integer not null default 3,          -- times per week, 1..7
  created_at   timestamptz default now()
);
create index if not exists mobility_exercises_user_idx
  on mobility_exercises (user_id);
alter table mobility_exercises enable row level security;

-- ───────────────────── mobility_logs ──────────────────────────
-- one row per performed session (exercise + date). `measure` is snapshotted
-- per row so changing an exercise's measure later never rewrites old history.
create table if not exists mobility_logs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users not null,
  exercise_id  text not null references mobility_exercises (id) on delete cascade,
  date         date not null,
  sets         integer not null default 1,
  measure      text not null default 'hold',
  hold_seconds integer,
  reps         integer,
  created_at   timestamptz not null default now(),
  unique (user_id, exercise_id, date)               -- upsert target (no delete-then-insert)
);
create index if not exists mobility_logs_user_ex_idx
  on mobility_logs (user_id, exercise_id);
alter table mobility_logs enable row level security;

-- ───────────────────── whoop_tokens ────────────────────────────
-- Raw OAuth tokens. Deliberately given NO RLS policy below (RLS is enabled
-- but the policy array is left empty for this table) — that makes it
-- unreadable/unwritable via the anon/authenticated client key entirely.
-- Only Edge Functions using the service-role key can touch this table.
create table if not exists whoop_tokens (
  user_id       uuid primary key references auth.users not null,
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  scope         text,
  whoop_user_id text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
alter table whoop_tokens enable row level security;

-- ───────────────────── whoop_recovery ──────────────────────────
-- One row per calendar day: WHOOP's cycle + recovery + sleep merged.
-- This IS covered by the normal "own" RLS policy — the only WHOOP data the
-- browser reads directly.
create table if not exists whoop_recovery (
  user_id                      uuid references auth.users not null,
  date                         date not null,
  -- cycle (GET /v2/cycle)
  cycle_score_state            text,      -- SCORED | PENDING_SCORE | UNSCORABLE
  strain                       numeric,
  avg_heart_rate               numeric,
  max_heart_rate               numeric,
  kilojoule                    numeric,
  -- recovery (GET /v2/cycle/{id}/recovery)
  recovery_score_state         text,
  user_calibrating             boolean,
  recovery_score               integer,
  resting_hr                   numeric,
  hrv_ms                       numeric,   -- hrv_rmssd_milli
  spo2_percentage              numeric,
  skin_temp_celsius            numeric,
  -- sleep (GET /v2/activity/sleep) — score + stage_summary + sleep_needed
  sleep_score_state            text,
  is_nap                       boolean,
  sleep_start                  timestamptz,   -- when they fell asleep
  sleep_end                    timestamptz,   -- when they woke up
  sleep_performance            integer,
  sleep_efficiency_percentage  numeric,
  sleep_consistency_percentage numeric,
  respiratory_rate             numeric,
  total_in_bed_ms              integer,
  total_awake_ms               integer,
  total_no_data_ms             integer,
  light_sleep_ms               integer,   -- total_light_sleep_time_milli
  deep_sleep_ms                integer,   -- total_slow_wave_sleep_time_milli
  rem_sleep_ms                 integer,   -- total_rem_sleep_time_milli
  sleep_cycle_count            integer,
  disturbance_count            integer,
  sleep_need_baseline_ms       integer,
  sleep_need_debt_ms           integer,
  sleep_need_strain_ms         integer,
  sleep_need_nap_ms            integer,
  raw                          jsonb,     -- full cycle+recovery+sleep API responses, verbatim
  synced_at                    timestamptz not null default now(),
  primary key (user_id, date)
);
-- table may already exist from an earlier narrower version — add anything missing
alter table whoop_recovery add column if not exists cycle_score_state text;
alter table whoop_recovery add column if not exists recovery_score_state text;
alter table whoop_recovery add column if not exists user_calibrating boolean;
alter table whoop_recovery add column if not exists sleep_score_state text;
alter table whoop_recovery add column if not exists is_nap boolean;
alter table whoop_recovery add column if not exists sleep_start timestamptz;
alter table whoop_recovery add column if not exists sleep_end timestamptz;
alter table whoop_recovery add column if not exists total_in_bed_ms integer;
alter table whoop_recovery add column if not exists total_awake_ms integer;
alter table whoop_recovery add column if not exists total_no_data_ms integer;
alter table whoop_recovery add column if not exists sleep_cycle_count integer;
alter table whoop_recovery add column if not exists disturbance_count integer;
alter table whoop_recovery add column if not exists sleep_need_baseline_ms integer;
alter table whoop_recovery add column if not exists sleep_need_debt_ms integer;
alter table whoop_recovery add column if not exists sleep_need_strain_ms integer;
alter table whoop_recovery add column if not exists sleep_need_nap_ms integer;
-- superseded by the granular columns above; table is brand-new and unsynced, safe to drop
alter table whoop_recovery drop column if exists awake_ms;
alter table whoop_recovery drop column if exists sleep_duration_ms;
alter table whoop_recovery drop column if exists sleep_need_ms;
create index if not exists whoop_recovery_user_date_idx
  on whoop_recovery (user_id, date);
alter table whoop_recovery enable row level security;

-- ───────────────────── whoop_workouts ──────────────────────────
-- One row per WHOOP workout (zero-to-many per day).
create table if not exists whoop_workouts (
  id                   text primary key,     -- WHOOP's own workout id
  user_id              uuid references auth.users not null,
  start                timestamptz not null,
  "end"                timestamptz not null,
  sport_id             integer,
  sport_name           text,
  score_state          text,
  strain               numeric,
  avg_heart_rate       numeric,
  max_heart_rate       numeric,
  kilojoule            numeric,
  percent_recorded     numeric,
  distance_meter       numeric,
  altitude_gain_meter  numeric,
  altitude_change_meter numeric,
  zone_0_ms            integer,             -- zone_zero_milli
  zone_1_ms            integer,
  zone_2_ms            integer,
  zone_3_ms            integer,
  zone_4_ms            integer,
  zone_5_ms            integer,
  raw                  jsonb,
  synced_at            timestamptz not null default now()
);
-- table may already exist from an earlier narrower version — add anything missing
alter table whoop_workouts add column if not exists sport_id integer;
alter table whoop_workouts add column if not exists score_state text;
alter table whoop_workouts add column if not exists percent_recorded numeric;
alter table whoop_workouts add column if not exists altitude_change_meter numeric;
alter table whoop_workouts add column if not exists zone_0_ms integer;
alter table whoop_workouts add column if not exists zone_1_ms integer;
alter table whoop_workouts add column if not exists zone_2_ms integer;
alter table whoop_workouts add column if not exists zone_3_ms integer;
alter table whoop_workouts add column if not exists zone_4_ms integer;
alter table whoop_workouts add column if not exists zone_5_ms integer;
create index if not exists whoop_workouts_user_start_idx
  on whoop_workouts (user_id, start desc);
alter table whoop_workouts enable row level security;

-- ───────────────────── whoop_profile ───────────────────────────
-- Singleton per user: basic profile + body measurement. Low-churn,
-- upserted whole on every sync.
create table if not exists whoop_profile (
  user_id         uuid primary key references auth.users not null,
  first_name      text,
  last_name       text,
  email           text,
  height_meter    numeric,
  weight_kilogram numeric,
  max_heart_rate  numeric,
  raw             jsonb,
  synced_at       timestamptz not null default now()
);
alter table whoop_profile enable row level security;

-- ──────────────── RLS policies (create only if missing) ───────
do $$
declare t text;
begin
  foreach t in array array[
    'habits','habit_logs','habit_voids','habit_counts','habit_notes','tasks','goals','settings','job_applications','referrals','areas',
    'diet_entries','diet_foods','mobility_exercises','mobility_logs','reactive_habits','reactive_habit_logs',
    'whoop_recovery','whoop_workouts','whoop_profile'
  ] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = 'own'
    ) then
      execute format(
        'create policy "own" on public.%I for all '
        'using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 2. ONE-TIME BACKFILL — settings blobs → the tables above
-- ─────────────────────────────────────────────────────────────
-- Each block filters `settings` to the relevant keys in a subquery FIRST, then
-- expands the jsonb array — `jsonb_array_elements` errors on non-array values,
-- so it must never see rows like `habit_sort_v1` (a string) or `task_streak_v1`
-- (an object). No-op (touches 0 rows) once the source settings rows are gone.
--
-- Every block also carries a `not exists (… destination table …)` guard: once a
-- user has ANY row in the target table the whole block is skipped, so a re-run
-- can never resurrect a Diet/Mobility record deleted since the first migration.
-- (The `settings` blobs stopped updating when those tabs moved to their own
-- tables, so without this guard they'd be a stale source of deleted rows.)

-- mobility_exercises
insert into mobility_exercises
  (id, user_id, name, session, measure, sets, hold_seconds, reps, frequency, created_at)
select
  e->>'id',
  s.user_id,
  e->>'name',
  coalesce(e->>'session', 'morning'),
  coalesce(e->>'measure', 'hold'),
  coalesce((e->>'sets')::int, 1),
  (e->>'holdSeconds')::int,
  (e->>'reps')::int,
  coalesce((e->>'frequency')::int, 3),
  coalesce(to_timestamp((e->>'createdAt')::double precision / 1000), now())
from (
  select user_id, value from settings
  where key = 'mobility_exercises_v1' and jsonb_typeof(value) = 'array'
) s
cross join lateral jsonb_array_elements(s.value) e
where coalesce(e->>'id', '') <> '' and coalesce(e->>'name', '') <> ''
  and not exists (select 1 from mobility_exercises m where m.user_id = s.user_id)
on conflict (id) do nothing;

-- mobility_logs (depends on mobility_exercises, above, in this same transaction)
insert into mobility_logs
  (user_id, exercise_id, date, sets, measure, hold_seconds, reps)
select
  s.user_id,
  split_part(s.key, ':', 2),
  (e->>'date')::date,
  coalesce((e->>'sets')::int, 1),
  coalesce(e->>'measure', 'hold'),
  (e->>'holdSeconds')::int,
  (e->>'reps')::int
from (
  select user_id, key, value from settings
  where key like 'mobility_progress:%' and jsonb_typeof(value) = 'array'
) s
cross join lateral jsonb_array_elements(s.value) e
where e ? 'date'
  and split_part(s.key, ':', 2) in (select id from mobility_exercises)
  and not exists (select 1 from mobility_logs ml where ml.user_id = s.user_id)
on conflict (user_id, exercise_id, date) do nothing;

-- diet_entries
insert into diet_entries
  (id, user_id, date, time, description, calories, protein, carbs, fats,
   category, healthy_ingredients, unhealthy_foods)
select
  e->>'id',
  s.user_id,
  (e->>'date')::date,
  e->>'time',
  e->>'desc',
  (e->>'calories')::int,
  (e->>'protein')::int,
  (e->>'carbs')::int,
  (e->>'fats')::int,
  e->>'category',
  coalesce(e->'healthyIngredients', '[]'::jsonb),
  coalesce(e->'unhealthyFoods', '[]'::jsonb)
from (
  select user_id, value from settings
  where key = 'diet_entries_v1' and jsonb_typeof(value) = 'array'
) s
cross join lateral jsonb_array_elements(s.value) e
where coalesce(e->>'id', '') <> '' and e ? 'date'
  and not exists (select 1 from diet_entries d where d.user_id = s.user_id)
on conflict (id) do nothing;

-- diet_foods
insert into diet_foods (user_id, name, kind)
select s.user_id, f, 'healthy'
from (
  select user_id, value from settings
  where key = 'diet_healthy_v1' and jsonb_typeof(value) = 'array'
) s
cross join lateral jsonb_array_elements_text(s.value) f
where coalesce(f, '') <> ''
  and not exists (select 1 from diet_foods df where df.user_id = s.user_id and df.kind = 'healthy')
on conflict (user_id, name, kind) do nothing;

insert into diet_foods (user_id, name, kind)
select s.user_id, f, 'unhealthy'
from (
  select user_id, value from settings
  where key = 'diet_unhealthy_v1' and jsonb_typeof(value) = 'array'
) s
cross join lateral jsonb_array_elements_text(s.value) f
where coalesce(f, '') <> ''
  and not exists (select 1 from diet_foods df where df.user_id = s.user_id and df.kind = 'unhealthy')
on conflict (user_id, name, kind) do nothing;

commit;

-- ──────────────── cleanup — run manually, once, later ──────────
-- Only after confirming Diet + Mobility look right in the app. Deletes the
-- now-duplicate old settings rows the backfill above just copied elsewhere.
-- delete from settings
-- where key in ('diet_entries_v1', 'diet_healthy_v1', 'diet_unhealthy_v1', 'mobility_exercises_v1')
--    or key like 'mobility_progress:%';
