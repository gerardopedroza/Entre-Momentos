import { clearCookie, cookie, json, newId, nowIso, setCookie, sha256 } from "./core.js";

const SESSION_HOURS = 10;

export async function createAdminSession(env) {
  const token = newId() + newId().replaceAll("-", "");
  const expires = new Date(Date.now() + SESSION_HOURS * 3600000).toISOString();
  await env.DB.prepare("INSERT INTO admin_sessions (id_hash, expires_at, created_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), expires, nowIso()).run();
  return json({ authenticated: true, role: "admin", expiresAt: expires }, 200, { "Set-Cookie": setCookie("em_admin", token, SESSION_HOURS * 3600) });
}

export async function createGuestSession(env, guest, eventId) {
  const token = newId() + newId().replaceAll("-", "");
  const expires = new Date(Date.now() + 14 * 86400000).toISOString();
  await env.DB.prepare("INSERT INTO guest_sessions (id_hash, guest_id, event_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(token), guest.id, eventId, expires, nowIso()).run();
  return { header: setCookie("em_guest", token, 14 * 86400), expiresAt: expires };
}

export async function adminSession(request, env) {
  const token = cookie(request, "em_admin");
  if (!token || !env.DB) return null;
  return env.DB.prepare("SELECT id_hash, expires_at FROM admin_sessions WHERE id_hash = ? AND expires_at > ?")
    .bind(await sha256(token), nowIso()).first();
}

export async function guestSession(request, env) {
  const token = cookie(request, "em_guest");
  if (!token || !env.DB) return null;
  return env.DB.prepare(`SELECT s.event_id, g.id AS guest_id, g.name, g.nickname, g.table_id
    FROM guest_sessions s JOIN event_guests g ON g.id = s.guest_id
    WHERE s.id_hash = ? AND s.expires_at > ? AND g.active = 1`)
    .bind(await sha256(token), nowIso()).first();
}

export function clearAdminResponse() { return json({ authenticated: false }, 200, { "Set-Cookie": clearCookie("em_admin") }); }
export function clearGuestResponse() { return json({ authenticated: false }, 200, { "Set-Cookie": clearCookie("em_guest") }); }

async function verifyPassword(password, serialized) {
  const [scheme, iterationsText, saltText, expectedText] = String(serialized || "").split("$");
  if (scheme !== "pbkdf2-sha256" || !iterationsText || !saltText || !expectedText) return false;
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 2000000) return false;
  const decode = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: decode(saltText), iterations }, key, 256);
  const actual = [...new Uint8Array(bits)];
  const expected = [...decode(expectedText)];
  if (actual.length !== expected.length) return false;
  return actual.reduce((diff, value, index) => diff | (value ^ expected[index]), 0) === 0;
}

export async function handleAdminLogin(request, env) {
  if (!env.DB || !env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH) return json({ error: "not_configured", message: "Falta configurar el acceso de administración." }, 503);
  const { readJson } = await import("./core.js");
  const data = await readJson(request, 4096);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await sha256((env.SESSION_PEPPER || env.ADMIN_USERNAME) + ":" + ip);
  const attempt = await env.DB.prepare("SELECT failures, locked_until FROM admin_login_attempts WHERE ip_hash = ?").bind(ipHash).first();
  if (attempt?.locked_until && Date.parse(attempt.locked_until) > Date.now()) return json({ error: "rate_limited", message: "Demasiados intentos. Vuelve a probar más tarde." }, 429);
  const isUsername = String(data.username || "") === env.ADMIN_USERNAME;
  const isPassword = await verifyPassword(String(data.password || ""), env.ADMIN_PASSWORD_HASH);
  if (!isUsername || !isPassword) {
    const failures = Number(attempt?.failures || 0) + 1;
    const lockedUntil = failures >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
    await env.DB.prepare(`INSERT INTO admin_login_attempts (ip_hash, failures, locked_until, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(ip_hash) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at`)
      .bind(ipHash, failures, lockedUntil, nowIso()).run();
    return json({ error: "invalid_credentials", message: "Usuario o contraseña incorrectos." }, 401);
  }
  await env.DB.prepare("DELETE FROM admin_login_attempts WHERE ip_hash = ?").bind(ipHash).run();
  return createAdminSession(env);
}

export async function requireAdmin(request, env) {
  const session = await adminSession(request, env);
  if (!session) throw Object.assign(new Error("Inicia sesión como administrador."), { status: 401, code: "admin_required" });
  return session;
}

export async function revokeAdmin(request, env) {
  const token = cookie(request, "em_admin");
  if (token && env.DB) await env.DB.prepare("DELETE FROM admin_sessions WHERE id_hash = ?").bind(await sha256(token)).run();
  return clearAdminResponse();
}

export async function revokeGuest(request, env) {
  const token = cookie(request, "em_guest");
  if (token && env.DB) await env.DB.prepare("DELETE FROM guest_sessions WHERE id_hash = ?").bind(await sha256(token)).run();
  return clearGuestResponse();
}
