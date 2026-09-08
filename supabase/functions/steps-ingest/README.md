# steps-ingest — WHOOP step count → step-linked habits

WHOOP's developer API does not expose step count. WHOOP *does* write its step
samples into Apple Health, so this pipe reads them there:

```
WHOOP band → WHOOP app → Apple Health (Source = "WHOOP")
   → iOS Shortcut (sum today's WHOOP steps) → POST here → step_counts table
   → dashboard auto-checks any habit linked to a step target
```

## 1. Database

Run the updated `master.sql` in the Supabase SQL editor. It adds the
`step_counts` table (+ its RLS policy) and the `habits.auto_source` /
`habits.step_target` columns. It is idempotent — safe to re-run.

## 2. Deploy the function

```bash
supabase login
supabase link --project-ref tlqjmlocxxsdlxseumxw
supabase functions deploy steps-ingest
```

`config.toml` already sets `verify_jwt = false` for this function — it is called
by the Shortcut with a per-user token, not a Supabase JWT. No extra secrets are
needed (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically).

Payload:

```
POST https://tlqjmlocxxsdlxseumxw.supabase.co/functions/v1/steps-ingest
{ "token": "<per-user token>", "date": "2026-09-06", "steps": 9713 }
```

`date` is optional (defaults to UTC today); dates older than 7 days are ignored.

## 3. Link a habit + get your token

In the dashboard: **Habits → create a habit (e.g. "Steps") → open it →
"Auto-check from step count"**. Set the daily target. The panel shows the sync URL
and your personal token (generated on first use, stored in `settings`).

The habit is auto-checked **once** on any day its step count reaches the target;
after that you can toggle it by hand like any other habit.

## 4. iOS Shortcut (~5 min)

1. WHOOP app → Menu → Integrations → **Apple Health** on, with Steps write
   access. Confirm in Health → Steps → today that "WHOOP" shows as a source.
2. Shortcuts app → new shortcut **"Sync WHOOP Steps"**:
   - **Find Health Samples** — Sample Type `Steps`; filter `Start Date` `is`
     `today`; filter `Source` `contains` `WHOOP`.
   - **Calculate Statistics** — `Sum` of `Value` → `StepTotal`.
   - **Format Date** — current date, format `yyyy-MM-dd` → `Today`.
   - **Get Contents of URL** — the sync URL; Method `POST`; Request Body `JSON`:
     `{ "token": "<token>", "date": Today, "steps": StepTotal }`.
3. Shortcuts → **Automation** → Personal Automation → **Time of Day** →
   e.g. 2 pm and 11:15 pm → run "Sync WHOOP Steps", **Run Immediately**,
   notifications off.
4. Run it once by hand. Check a row appears in `step_counts` and the habit
   reflects it after the dashboard reloads.

WHOOP's HealthKit write lags a few hours, so the late-evening run is what
usually locks in the day's total.
