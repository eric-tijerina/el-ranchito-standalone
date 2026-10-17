// Shared helpers for El Ranchito /park Pages Functions.
// Same behavior as the old Render park-sync.js, but on Cloudflare D1:
//   POST /park/auth  {password} -> {token} | 401 | 503
//   GET  /park/state (Bearer)  -> {state, updatedAt}
//   POST /park/state (Bearer)  -> last-write-wins -> {ok, updatedAt}
//
// Auth: PBKDF2-SHA256 (WebCrypto, 100k iters) — NOT the old scrypt hash.
// Setup: set env PARK_PASSWORD (plaintext, his-hands, Cloudflare dashboard)
// on first deploy. The Worker derives + stores the hash in D1 on first
// use, then Eric deletes PARK_PASSWORD from env. The password itself
// never passes through chat, files, or logs. Token secret is auto-generated
// and stored in D1 on first use.

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;

const ALLOWED_ORIGINS = new Set([
  "https://elranchitorvpark.com",
  "http://elranchitorvpark.com",
]);

function b64encode(buf) {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64decode(str) {
  const norm = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function utf8(str) { return new TextEncoder().encode(str); }

export function applyCors(request, response) {
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin");
  }
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return response;
}
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
export function handleOptions(request) {
  const r = new Response(null, { status: 204 });
  return applyCors(request, r);
}

// ---- D1 helpers ----
async function metaGet(env, key) {
  const row = await env.PARK_DB.prepare(
    "SELECT value FROM park_meta WHERE key = ?"
  ).bind(key).first();
  return row ? row.value : null;
}
async function metaSet(env, key, value) {
  await env.PARK_DB.prepare(
    "INSERT INTO park_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

async function getTokenSecret(env) {
  let secret = await metaGet(env, "token_secret");
  if (!secret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    secret = b64encode(bytes);
    await metaSet(env, "token_secret", secret);
  }
  return b64decode(secret);
}

async function deriveHash(password, saltBytes) {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return new Uint8Array(bits);
}

async function getAuthHash(env) {
  const stored = await metaGet(env, "auth_hash");
  if (stored) return JSON.parse(stored);
  // First-use setup: PARK_PASSWORD env (his-hands) -> derive + store, then delete env var.
  const setupPw = env.PARK_PASSWORD;
  if (typeof setupPw === "string" && setupPw.length > 0) {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const hash = await deriveHash(setupPw, salt);
    const cfg = {
      kdf: "pbkdf2-sha256",
      iter: 100000,
      salt: b64encode(salt),
      hash: b64encode(hash),
    };
    await metaSet(env, "auth_hash", JSON.stringify(cfg));
    return cfg;
  }
  return null;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(env, password) {
  const cfg = await getAuthHash(env);
  if (!cfg) return { configured: false };
  const salt = b64decode(cfg.salt);
  const expected = b64decode(cfg.hash);
  const derived = await deriveHash(password, salt);
  return { configured: true, ok: constantTimeEqual(derived, expected) };
}

export async function issueToken(env) {
  const secret = await getTokenSecret(env);
  const payload = b64encode(utf8(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS })));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, utf8(payload));
  return payload + "." + b64encode(sig);
}

export async function verifyToken(env, token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64decode(payloadB64)));
  } catch { return false; }
  if (!payload || typeof payload.exp !== "number" || payload.exp <= Date.now()) return false;
  const secret = await getTokenSecret(env);
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  try {
    return await crypto.subtle.verify("HMAC", key, b64decode(sigB64), utf8(payloadB64));
  } catch { return false; }
}

export function bearerToken(request) {
  const h = request.headers.get("Authorization");
  if (!h) return null;
  const m = /^Bearer (.+)$/.exec(h.trim());
  return m ? m[1] : null;
}

// ---- rate limit: 10 POST /park/auth per IP per rolling 60s (per-isolate) ----
const authAttempts = new Map();
export function authRateLimited(ip) {
  const now = Date.now();
  const recent = (authAttempts.get(ip) || []).filter((t) => now - t < AUTH_WINDOW_MS);
  if (recent.length >= AUTH_MAX_ATTEMPTS) {
    authAttempts.set(ip, recent);
    return true;
  }
  recent.push(now);
  authAttempts.set(ip, recent);
  return false;
}
export function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// ---- state ----
export async function loadState(env) {
  const row = await env.PARK_DB.prepare(
    "SELECT state, updatedAt FROM park_state WHERE id = 1"
  ).first();
  if (!row) return { state: null, updatedAt: 0 };
  let state = null;
  try { state = row.state ? JSON.parse(row.state) : null; } catch { state = null; }
  return { state, updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0 };
}
export async function saveState(env, state, updatedAt) {
  await env.PARK_DB.prepare(
    "INSERT INTO park_state (id, state, updatedAt) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updatedAt = excluded.updatedAt"
  ).bind(JSON.stringify(state), updatedAt).run();
}
