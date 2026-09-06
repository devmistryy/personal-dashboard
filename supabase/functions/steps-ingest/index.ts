// steps-ingest — receives a day's step total and stores it in `step_counts`.
//
// An iOS Shortcut ("Sync WHOOP Steps") reads today's WHOOP-sourced step samples
// out of Apple Health, sums them, and POSTs here on a Time-of-Day automation:
//
//   POST /functions/v1/steps-ingest
//   { "token": "<per-user secret>", "date": "2026-09-06", "steps": 9713 }
//
// The token is the `step_ingest_token_v1` value the dashboard generates per user
// (stored in the `settings` table). We resolve it to a user_id with the service
// role key and upsert one row per (user_id, date). No Supabase JWT involved —
// config.toml sets verify_jwt = false for this function.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });

// Accept dates within this many days of today; anything older is ignored so a
// misconfigured automation can't rewrite months of history.
const BACK_WINDOW_DAYS = 7;

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(d + "T00:00:00Z");
  if (Number.isNaN(t)) return false;
  const ageDays = (Date.now() - t) / 86_400_000;
  return ageDays >= -1 && ageDays <= BACK_WINDOW_DAYS; // allow "tomorrow" for TZ skew
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  if (!token) return json(401, { error: "missing token" });

  const date = typeof payload.date === "string" && payload.date.trim()
    ? payload.date.trim()
    : utcToday();
  if (!isValidDate(date)) return json(400, { error: `date out of range: ${date}` });

  const steps = Math.round(Number(payload.steps));
  if (!Number.isFinite(steps) || steps < 0 || steps > 500_000) {
    return json(400, { error: "steps must be a non-negative number" });
  }

  const source = typeof payload.source === "string" && payload.source.trim()
    ? payload.source.trim().slice(0, 64)
    : "whoop_via_healthkit";

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json(500, { error: "function not configured" });
  }
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // `step_ingest_token_v1` is a jsonb string per user. Fetch the rows for that
  // key and match in JS — avoids any jsonb-filter encoding fragility, and there
  // is only ever a handful of them.
  const { data: rows, error: lookupErr } = await sb
    .from("settings")
    .select("user_id, value")
    .eq("key", "step_ingest_token_v1");

  if (lookupErr) return json(500, { error: "token lookup failed" });

  const match = (rows ?? []).find((r) => {
    const v = r.value;
    return (typeof v === "string" ? v : String(v)) === token;
  });
  if (!match) return json(403, { error: "unknown token" });

  const userId = match.user_id as string;

  const { error: upsertErr } = await sb
    .from("step_counts")
    .upsert(
      { user_id: userId, date, steps, source, updated_at: new Date().toISOString() },
      { onConflict: "user_id,date" },
    );

  if (upsertErr) return json(500, { error: "write failed" });

  return json(200, { ok: true, date, steps });
});
