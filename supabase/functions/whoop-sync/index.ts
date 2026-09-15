// whoop-sync — pulls the user's latest WHOOP data and stores it.
//
// Called by the dashboard's browser code with the user's own Supabase JWT
// (config.toml leaves verify_jwt at its default `true`, so the gateway
// already rejects any request without a valid session before this code
// runs — we just decode the already-verified JWT's `sub` claim for the
// user id, no second round trip to Supabase auth needed).
//
// The actual refresh/fetch/upsert logic lives in ../_shared/whoopSyncCore.ts,
// shared with whoop-webhook — this file only resolves "which user" and
// shapes the HTTP response.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runWhoopSync } from "../_shared/whoopSyncCore.ts";

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

function decodeJwtSub(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded).sub ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authHeader = req.headers.get("authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const userId = jwt ? decodeJwtSub(jwt) : null;
  if (!userId) return json(401, { error: "missing or invalid session" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const clientSecret = Deno.env.get("WHOOP_CLIENT_SECRET");
  if (!supabaseUrl || !serviceKey || !clientSecret) {
    return json(500, { error: "function not configured" });
  }
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const result = await runWhoopSync(sb, userId, clientSecret);
  return json(200, result);
});
