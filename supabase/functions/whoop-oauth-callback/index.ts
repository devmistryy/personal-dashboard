// whoop-oauth-callback — starts and completes the WHOOP OAuth2 flow.
//
// Two jobs, distinguished by the request:
//
//   1. START — GET ?action=start, called by the dashboard's own browser code
//      with the user's Supabase session JWT in Authorization: Bearer <jwt>.
//      config.toml sets verify_jwt = false for this whole function (job 2
//      below is hit directly by WHOOP with no JWT at all), so the JWT check
//      for this path happens in code, not the gateway. We verify it, build a
//      signed `state` carrying the user_id + return origin, and hand back the
//      WHOOP authorize URL for the browser to redirect to. The authorize URL
//      is built here (not in browser JS) because this is the only place that
//      can sign `state` — WHOOP_CLIENT_ID lives here too, alongside the
//      secret, purely so the browser never needs to know it either.
//
//   2. CALLBACK — GET ?code=...&state=..., hit directly by WHOOP's servers
//      after the user approves access. We verify the signed state, exchange
//      the code for tokens (using WHOOP_CLIENT_SECRET — never exposed to the
//      browser), store them in `whoop_tokens`, and 302 back to the dashboard.
//
// `state` is a stateless, HMAC-signed token (STATE_SIGNING_SECRET) rather
// than a database row — it's the only channel available to carry the
// user_id and "where do I redirect back to" through WHOOP's servers and
// back to us, and signing it stops anyone from hitting this callback
// directly with a forged user_id.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });

const html = (status: number, body: string) =>
  new Response(body, { status, headers: { ...CORS, "content-type": "text/html" } });

// Not sensitive — WHOOP expects this in a public authorize URL — so it's a
// plain constant rather than a secret.
const WHOOP_CLIENT_ID = "29c60061-61cd-423a-a2f0-feef12b8ce42";

const WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_PROFILE_URL = "https://api.prod.whoop.com/developer/v2/user/profile/basic";

// Every read scope WHOOP offers, plus `offline` — required to receive a
// refresh_token at all.
const SCOPES =
  "read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline";

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// This function's own deployed URL. Must exactly match the redirect_uri
// registered in the WHOOP developer app, and be identical in both the
// authorize request (below) and the token exchange (below) — WHOOP rejects a
// mismatch.
const REDIRECT_URI =
  "https://tlqjmlocxxsdlxseumxw.supabase.co/functions/v1/whoop-oauth-callback";

function b64urlEncode(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signState(payload: Record<string, unknown>, secret: string): Promise<string> {
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${bytesToHex(new Uint8Array(sig))}`;
}

async function verifyState(
  state: string,
  secret: string,
): Promise<{ user_id: string; origin: string; ts: number } | null> {
  const [payloadB64, sigHex] = state.split(".");
  if (!payloadB64 || !sigHex) return null;
  const key = await hmacKey(secret);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      hexToBytes(sigHex),
      new TextEncoder().encode(payloadB64),
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    if (
      typeof payload.user_id !== "string" ||
      typeof payload.origin !== "string" ||
      typeof payload.ts !== "number"
    ) {
      return null;
    }
    if (Date.now() - payload.ts > STATE_MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const clientSecret = Deno.env.get("WHOOP_CLIENT_SECRET");
  const stateSecret = Deno.env.get("STATE_SIGNING_SECRET");
  if (!supabaseUrl || !serviceKey || !anonKey || !clientSecret || !stateSecret) {
    return json(500, { error: "function not configured" });
  }

  // ─────────────────────────── START ───────────────────────────
  if (url.searchParams.get("action") === "start") {
    const authHeader = req.headers.get("authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json(401, { error: "missing bearer token" });

    const authClient = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
    if (userErr || !userData?.user) return json(401, { error: "invalid session" });

    const origin = req.headers.get("origin") ?? url.searchParams.get("origin") ?? "";
    if (!origin) return json(400, { error: "missing origin" });

    const state = await signState(
      { user_id: userData.user.id, origin, ts: Date.now(), nonce: crypto.randomUUID() },
      stateSecret,
    );

    const authorizeUrl = new URL(WHOOP_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", WHOOP_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("scope", SCOPES);
    authorizeUrl.searchParams.set("state", state);

    return json(200, { url: authorizeUrl.toString() });
  }

  // ────────────────────────── CALLBACK ──────────────────────────
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const whoopError = url.searchParams.get("error");

  if (!state) {
    return html(400, "<p>Missing state. Please retry connecting from the dashboard.</p>");
  }
  const verified = await verifyState(state, stateSecret);
  if (!verified) {
    return html(
      400,
      "<p>This connection request expired or was invalid. Please retry from the dashboard.</p>",
    );
  }
  const { user_id, origin } = verified;

  if (whoopError || !code) {
    return Response.redirect(`${origin}/?whoop=error`, 302);
  }

  const tokenRes = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: WHOOP_CLIENT_ID,
      client_secret: clientSecret,
    }),
  });

  if (!tokenRes.ok) {
    console.error("whoop token exchange failed", tokenRes.status);
    return Response.redirect(`${origin}/?whoop=error`, 302);
  }

  const tokenData = await tokenRes.json();
  const { access_token, refresh_token, expires_in, scope } = tokenData ?? {};
  if (!access_token || !refresh_token) {
    console.error("whoop token response missing fields");
    return Response.redirect(`${origin}/?whoop=error`, 302);
  }
  const expiresAt = new Date(Date.now() + Number(expires_in) * 1000).toISOString();

  // Best-effort: fetch WHOOP's own user id for reference. Not fatal if it fails.
  let whoopUserId: string | null = null;
  try {
    const profileRes = await fetch(WHOOP_PROFILE_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      whoopUserId = profile?.user_id != null ? String(profile.user_id) : null;
    }
  } catch {
    // non-fatal
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { error: upsertErr } = await sb.from("whoop_tokens").upsert({
    user_id,
    access_token,
    refresh_token,
    expires_at: expiresAt,
    scope: scope ?? null,
    whoop_user_id: whoopUserId,
    updated_at: new Date().toISOString(),
  });

  if (upsertErr) {
    console.error("whoop_tokens upsert failed", upsertErr.message);
    return Response.redirect(`${origin}/?whoop=error`, 302);
  }

  return Response.redirect(`${origin}/?whoop=connected`, 302);
});
