-- ═══════════════════════════════════════════════════════════════
--  MASTER SCRIPT — the one file to run in the Supabase SQL editor.
--  Idempotent end to end — safe to run again any time this file changes.
--
--  Contains, in order:
--    1. Schema — every table + RLS policy the app uses.
--    2. One-time backfill — copies any Diet/Mobility data still sitting in
--       the old `settings` key/value blobs into their new dedicated tables.
--       Also idempotent (`on conflict do nothing`) — running it twice, or
--       against an account with nothing to migrate, is a no-op either way.
--
--  Storage rule for future tables:
--    • Collections of records (habits, goals, meals, exercises, sessions, …)
--      get their own table.
--    • Per-user scalar prefs / small singletons live in `settings` (key/value).
--
--  A commented-out cleanup block sits at the very bottom — run it manually,
--  once, only after confirming the app looks right on the new tables.
-- ═══════════════════════════════════════════════════════════════

begin;

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
alter table habits add column if not exists area       text;
alter table habits add column if not exists sort_order integer;
alter table habits add column if not exists end_of_day boolean default false;
alter table habits enable row level security;

-- ───────────────────────── habit_logs ─────────────────────────
create table if not exists habit_logs (
  user_id  uuid references auth.users not null,
  habit_id text not null,
  date     date not null,
  primary key (user_id, habit_id, date)
);
alter table habit_logs enable row level security;

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

-- ─────────────────────────── goals ────────────────────────────
create table if not exists goals (
  id       bigserial primary key,
  user_id  uuid references auth.users not null,
  date     date not null,
  text     text not null,
  done     boolean default false,
  done_at  bigint,
  queued   boolean default false,
  area     text,
  priority text default 'Medium'
);
alter table goals add column if not exists area     text;
alter table goals add column if not exists priority text default 'Medium';
alter table goals enable row level security;

-- ────────────────────────── settings ──────────────────────────
-- key/value store (value = jsonb). Per-user scalar prefs / small singletons.
-- Backs: habit_sort_v1, goal_streak_v1, sunday_reset_v1, sunday_reset_log_v1,
--        areas:list, area_notes:<name>
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
create table if not exists job_applications (
  id            text primary key,
  user_id       uuid references auth.users not null,
  company       text not null,
  platform      text,
  date_applied  date,
  status        text default 'Applied',
  location_type text,
  location_city text,
  created_at    timestamptz default now()
);
alter table job_applications enable row level security;

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

-- ──────────────── RLS policies (create only if missing) ───────
do $$
declare t text;
begin
  foreach t in array array[
    'habits','habit_logs','habit_notes','goals','settings','job_applications','areas',
    'diet_entries','diet_foods','mobility_exercises','mobility_logs'
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
-- so it must never see rows like `habit_sort_v1` (a string) or `goal_streak_v1`
-- (an object). No-op (touches 0 rows) once the source settings rows are gone.

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
on conflict (user_id, name, kind) do nothing;

insert into diet_foods (user_id, name, kind)
select s.user_id, f, 'unhealthy'
from (
  select user_id, value from settings
  where key = 'diet_unhealthy_v1' and jsonb_typeof(value) = 'array'
) s
cross join lateral jsonb_array_elements_text(s.value) f
where coalesce(f, '') <> ''
on conflict (user_id, name, kind) do nothing;

commit;

-- ──────────────── cleanup — run manually, once, later ──────────
-- Only after confirming Diet + Mobility look right in the app. Deletes the
-- now-duplicate old settings rows the backfill above just copied elsewhere.
-- delete from settings
-- where key in ('diet_entries_v1', 'diet_healthy_v1', 'diet_unhealthy_v1', 'mobility_exercises_v1')
--    or key like 'mobility_progress:%';
