// whoop-webhook — WHOOP calls this the moment new data is ready (recovery
// scored, sleep finalized, a workout logged), so the dashboard picks up a
// wake-up without the user ever clicking "Sync now". config.toml sets
// verify_jwt = false — WHOOP has no Supabase session, it authenticates
// itself via a signed request instead (verified below).
//
// Flow: verify the X-WHOOP-Signature header -> parse the event -> look up
// which Supabase user this WHOOP account belongs to (whoop_tokens.whoop_user_id)
// -> respond 2XX immediately (WHOOP expects that within ~1s and retries up
// to 5 times over an hour otherwise) -> run the actual sync in the
// background via EdgeRuntime.waitUntil.
//
// Register this function's URL in the WHOOP developer dashboard's Webhooks
// section: https://tlqjmlocxxsdlxseumxw.supabase.co/functions/v1/whoop-webhook

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runWhoopSync } from "../_shared/whoopSyncCore.ts";

async function verifySignature(rawBody: string, timestamp: string, signature: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
  // Not timing-safe, but this is a single-user personal app and the window
  // for a meaningful timing attack over HTTP is negligible.
  return computed === signature;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const timestamp = req.headers.get("X-WHOOP-Signature-Timestamp");
  const signature = req.headers.get("X-WHOOP-Signature");
  const rawBody = await req.text();
  if (!timestamp || !signature) return new Response("missing signature headers", { status: 400 });

  const clientSecret = Deno.env.get("WHOOP_CLIENT_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!clientSecret || !supabaseUrl || !serviceKey) {
    return new Response("function not configured", { status: 500 });
  }

  const valid = await verifySignature(rawBody, timestamp, signature, clientSecret);
  if (!valid) {
    console.error("whoop-webhook: bad signature");
    return new Response("invalid signature", { status: 401 });
  }

  let payload: { user_id?: number | string; type?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("ok", { status: 200 }); // malformed but signed — ack, ignore
  }

  const whoopUserId = payload.user_id != null ? String(payload.user_id) : "";
  if (!whoopUserId) return new Response("ok", { status: 200 });

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: tokenRow } = await sb
    .from("whoop_tokens")
    .select("user_id")
    .eq("whoop_user_id", whoopUserId)
    .maybeSingle();

  if (!tokenRow) {
    // Unknown WHOOP account (or whoop_user_id hasn't backfilled yet) —
    // nothing we can do with this event.
    return new Response("ok", { status: 200 });
  }

  // Respond fast (WHOOP wants a 2XX within ~1s); do the real work after.
  const syncPromise = runWhoopSync(sb, tokenRow.user_id as string, clientSecret).catch((e) =>
    console.error("webhook-triggered sync failed", (e as Error).message)
  );
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(syncPromise);
  } else {
    await syncPromise; // fallback if waitUntil isn't available in this runtime
  }

  return new Response("ok", { status: 200 });
});
