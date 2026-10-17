import { json, applyCors, handleOptions, verifyToken, bearerToken, loadState, saveState } from "../_lib.js";

export async function onRequestOptions({ request }) {
  return handleOptions(request);
}

export async function onRequestGet({ request, env }) {
  try {
    if (!(await verifyToken(env, bearerToken(request)))) {
      return applyCors(request, json({ error: "unauthorized" }, 401));
    }
    const { state, updatedAt } = await loadState(env);
    return applyCors(request, json({ state, updatedAt }));
  } catch {
    return applyCors(request, json({ error: "internal error" }, 500));
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!(await verifyToken(env, bearerToken(request)))) {
      return applyCors(request, json({ error: "unauthorized" }, 401));
    }
    const body = await request.json().catch(() => ({}));
    const incoming = body.updatedAt;
    const { updatedAt: current } = await loadState(env);
    // last-write-wins: keep only a strictly newer record book (same as old backend)
    if (typeof incoming === "number" && incoming > current && "state" in body) {
      await saveState(env, body.state, incoming);
      return applyCors(request, json({ ok: true, updatedAt: incoming }));
    }
    return applyCors(request, json({ ok: true, updatedAt: current }));
  } catch {
    return applyCors(request, json({ error: "internal error" }, 500));
  }
}
