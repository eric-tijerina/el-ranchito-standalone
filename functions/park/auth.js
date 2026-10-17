import { json, applyCors, handleOptions, verifyPassword, issueToken, authRateLimited, clientIp } from "../_lib.js";

export async function onRequestOptions({ request }) {
  return handleOptions(request);
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const password = body && body.password;
    if (typeof password !== "string" || !password) {
      return applyCors(request, json({ error: "wrong password" }, 401));
    }
    // Need configured check: if no auth_hash and no PARK_PASSWORD, backend not set up yet.
    const check = await verifyPassword(env, password);
    if (!check.configured) {
      return applyCors(request, json({ error: "not configured" }, 503));
    }
    const ip = clientIp(request);
    if (authRateLimited(ip)) {
      return applyCors(request, json({ error: "too many attempts" }, 429));
    }
    if (!check.ok) {
      return applyCors(request, json({ error: "wrong password" }, 401));
    }
    const token = await issueToken(env);
    return applyCors(request, json({ token }));
  } catch {
    return applyCors(request, json({ error: "internal error" }, 500));
  }
}
