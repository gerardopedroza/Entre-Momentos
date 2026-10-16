export const TZ = "America/Mexico_City";

export function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function fail(message, status = 400, code = "invalid_request") {
  return json({ error: code, message }, status);
}

export function nowIso() { return new Date().toISOString(); }
export function newId() { return crypto.randomUUID(); }
export function slugify(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
}
export function normalizeName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("es-MX").replace(/\s+/g, " ");
}
export function safeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) result |= left[i] ^ right[i];
  return result === 0;
}
export async function sha256(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function base64url(bytes) {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function readJson(request, maxBytes = 65536) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw Object.assign(new Error("La solicitud es demasiado grande."), { status: 413, code: "payload_too_large" });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw Object.assign(new Error("La solicitud es demasiado grande."), { status: 413, code: "payload_too_large" });
  try { return JSON.parse(text || "{}"); }
  catch { throw Object.assign(new Error("El contenido JSON no es válido."), { status: 400, code: "invalid_json" }); }
}

export async function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (origin !== new URL(request.url).origin) throw Object.assign(new Error("Origen no permitido."), { status: 403, code: "origin_forbidden" });
}

export function cookie(request, name) {
  const pair = (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : "";
}

export function setCookie(name, value, maxAge) {
  return name + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}
export function clearCookie(name) { return name + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"; }

export function getEventDateLocal(date = new Date(), timeZone = TZ) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Convert a venue-local datetime into a UTC ISO timestamp without relying on the visitor's clock zone.
export function localDateTimeToIso(value, timeZone = TZ) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Usa una fecha y hora local válida.");
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let step = 0; step < 3; step++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part) => part.type !== "literal").map(({ type, value }) => [type, Number(value)]));
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const delta = target - asUtc;
    if (!delta) break;
    guess += delta;
  }
  const result = new Date(guess);
  const finalParts = Object.fromEntries(formatter.formatToParts(result).filter((part) => part.type !== "literal").map(({ type, value }) => [type, Number(value)]));
  if (finalParts.year !== year || finalParts.month !== month || finalParts.day !== day || finalParts.hour !== hour || finalParts.minute !== minute) {
    throw new Error("La hora local no existe o es ambigua por el cambio de horario.");
  }
  return result.toISOString();
}

export function validateActivityWindow(start, end, timezone = TZ, openingsMinutes = 5, closeEarlyMinutes = 5) {
  const startsAt = localDateTimeToIso(start, timezone);
  const endsAt = localDateTimeToIso(end, timezone);
  if (Date.parse(startsAt) >= Date.parse(endsAt)) throw new Error("La hora de fin debe ser posterior al inicio.");
  return {
    startsAt,
    endsAt,
    photoOpensAt: new Date(Date.parse(startsAt) - openingsMinutes * 60000).toISOString(),
    photoClosesAt: new Date(Date.parse(endsAt) - closeEarlyMinutes * 60000).toISOString(),
  };
}

export function activityState(activity, now = Date.now()) {
  if (!activity.active) return "inactive";
  const start = Date.parse(activity.starts_at);
  const end = Date.parse(activity.ends_at);
  if (now < start) return "upcoming";
  if (now < end) return "active";
  return "finished";
}

export function evaluateContest(kind, entries, config = {}) {
  const eligible = entries.filter((entry) => entry.eligible && entry.storage_state === "stored");
  if (kind === "first_photo") {
    return eligible.sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at) || String(a.id).localeCompare(String(b.id)))[0] || null;
  }
  if (kind === "most_photos") {
    const activities = new Set(config.activityIds || []);
    const scoped = activities.size ? eligible.filter((entry) => activities.has(entry.activity_id)) : eligible;
    const counts = new Map();
    for (const entry of scoped) {
      const state = counts.get(entry.guest_id) || { count: 0, reachedAt: entry.received_at, guest_id: entry.guest_id };
      state.count++;
      if (Date.parse(entry.received_at) < Date.parse(state.reachedAt)) state.reachedAt = entry.received_at;
      counts.set(entry.guest_id, state);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || Date.parse(a.reachedAt) - Date.parse(b.reachedAt) || a.guest_id.localeCompare(b.guest_id))[0] || null;
  }
  // Reality-based categories (couple photo, bouquet, physical challenges) need staff validation.
  return null;
}

export function isEligible(receivedAt, opensAt, closesAt) {
  const received = Date.parse(receivedAt);
  return Number.isFinite(received) && received >= Date.parse(opensAt) && received < Date.parse(closesAt);
}
