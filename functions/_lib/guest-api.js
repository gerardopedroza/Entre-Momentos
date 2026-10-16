import { createGuestSession, guestSession, revokeGuest } from "./auth.js";
import { fail, getEventDateLocal, isEligible, json, newId, normalizeName, nowIso, readJson } from "./core.js";
import { driveIdFromUrl, ensureActivityDriveFolder, uploadGuestPhoto } from "./google-drive.js";
import { enqueueJob } from "./jobs.js";

function publicUrl(event, venue) { return "/l/" + venue.slug + "?event=" + encodeURIComponent(event.slug); }

async function resolvePublicEvent(request, env, eventSession = null) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("event");
  const venueSlug = url.searchParams.get("venue");
  let event = null;
  if (eventSession?.event_id) event = await env.DB.prepare("SELECT * FROM events WHERE id=? AND state='active'").bind(eventSession.event_id).first();
  if (!event && slug) event = await env.DB.prepare("SELECT * FROM events WHERE slug=? COLLATE NOCASE AND state='active'").bind(slug).first();
  if (!event && venueSlug) {
    const venue = await env.DB.prepare("SELECT * FROM venues WHERE slug=? COLLATE NOCASE AND active=1").bind(venueSlug).first();
    if (venue) event = await env.DB.prepare("SELECT * FROM events WHERE venue_id=? AND event_date=? AND state='active' LIMIT 1")
      .bind(venue.id, getEventDateLocal(new Date(), venue.timezone)).first();
  }
  return event;
}

async function shapeEvent(db, event, venue, now = Date.now()) {
  if (!event) return null;
  const activities = await db.prepare("SELECT a.*,m.id AS asset_id FROM event_activities a LEFT JOIN media_assets m ON m.id=a.reference_asset_id WHERE a.event_id=? AND a.active=1 ORDER BY a.position,a.starts_at")
    .bind(event.id).all();
  const moments = (activities.results || []).map((activity) => ({
    id: activity.id,
    name: activity.name,
    position: activity.position,
    start: new Intl.DateTimeFormat("es-MX", { timeZone: event.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(activity.starts_at)),
    startsAt: activity.starts_at,
    endsAt: activity.ends_at,
    photoOpensAt: activity.photo_opens_at,
    photoClosesAt: activity.photo_closes_at,
    coverUrl: activity.asset_id ? "/api/media/" + activity.asset_id : null,
    state: now < Date.parse(activity.starts_at) ? "upcoming" : now < Date.parse(activity.ends_at) ? "active" : "finished",
  }));
  const current = moments.find((activity) => activity.state === "active");
  const next = moments.find((activity) => activity.state === "upcoming");
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    date: event.event_date,
    timezone: event.timezone,
    state: event.state,
    coverUrl: event.cover_asset_id ? "/api/media/" + event.cover_asset_id : null,
    contestsEnabled: Boolean(event.contests_enabled),
    venue: { id: venue.id, name: venue.name, slug: venue.slug },
    publicUrl: publicUrl(event, venue),
    moments,
    activeMomentId: current?.id || null,
    nextMomentId: next?.id || null,
  };
}

async function eventForGuest(db, guestId, eventId, now = Date.now()) {
  const event = await db.prepare("SELECT * FROM events WHERE id=? AND state='active'").bind(eventId).first();
  if (!event) return null;
  const venue = await db.prepare("SELECT id,name,slug,timezone FROM venues WHERE id=? AND active=1").bind(event.venue_id).first();
  if (!venue) return null;
  const shaped = await shapeEvent(db, event, venue, now);
  const submissions = await db.prepare("SELECT id,activity_id AS momentId,eligible,storage_state AS storageState,received_at AS receivedAt FROM photo_submissions WHERE guest_id=? AND event_id=? ORDER BY received_at")
    .bind(guestId, eventId).all();
  const winner = await db.prepare(`SELECT c.name AS contest_name,c.kind,p.name AS prize_name
    FROM contests c LEFT JOIN prizes p ON p.id=c.prize_id WHERE c.event_id=? AND c.winner_guest_id=? AND c.state='finished'
      AND c.winner_confirmed_at>?`).bind(eventId, guestId, new Date(Date.now() - 12 * 3600000).toISOString()).first();
  const winnerNotice = winner ? (winner.prize_name
    ? { text: "¡Felicidades! Ganaste " + winner.contest_name + ". Acércate al staff para recibir tu premio." }
    : { text: "¡Felicidades! Ganaste " + winner.contest_name + "." }) : null;
  return { event: shaped, submissions: submissions.results || [], winnerNotice };
}

async function resolveEventFromBody(data, request, env) {
  const eventId = data.eventId;
  if (eventId) return env.DB.prepare("SELECT * FROM events WHERE id=? AND state='active'").bind(eventId).first();
  return resolvePublicEvent(request, env);
}

async function identifyGuest(request, env, select = false) {
  const data = await readJson(request, 8192);
  const event = await resolveEventFromBody(data, request, env);
  if (!event) return fail("No hay una boda activa en este enlace.", 404, "event_unavailable");
  const name = normalizeName(data.name || "");
  if (select && !String(data.guestId || "")) return fail("Elige tu nombre de la lista.");
  if (!select && name.length < 2) return fail("Escribe tu nombre o apellido para buscarte.");
  let guest;
  if (select) {
    guest = await env.DB.prepare("SELECT id,name,table_id FROM event_guests WHERE id=? AND event_id=? AND active=1")
      .bind(String(data.guestId), event.id).first();
  } else {
    const terms = [...new Set(name.split(/\s+/).filter((term) => term.length > 1))];
    if (!terms.length) return fail("Escribe al menos dos letras de tu nombre o apellido.");
    const conditions = terms.map(() => "instr(g.name_key,?)>0").join(" AND ");
    const matches = await env.DB.prepare(`SELECT g.id,g.name,g.name_key,g.table_id,t.name AS table_name
      FROM event_guests g LEFT JOIN event_tables t ON t.id=g.table_id
      WHERE g.event_id=? AND g.active=1 AND ${conditions}
      ORDER BY CASE WHEN g.name_key=? THEN 0 ELSE 1 END,g.name LIMIT 6`)
      .bind(event.id, ...terms, name).all();
    const found = matches.results || [];
    if (!found.length) return fail("No encontré ese nombre en la lista del evento. Revisa cómo está escrito.", 404, "guest_not_found");
    if (found.length > 1 || found[0].name_key !== name) {
      return json({ matches: found.slice(0, 5).map((match) => ({ id: match.id, name: match.name, reference: match.table_name ? "Mesa " + match.table_name : "Toca para confirmar" })), hasMore: found.length > 5 });
    }
    guest = found[0];
  }
  if (!guest) return fail("No encontré a esa persona en la lista del evento.", 404, "guest_not_found");
  const session = await createGuestSession(env, guest, event.id);
  const payload = await eventForGuest(env.DB, guest.id, event.id);
  const table = guest.table_id ? await env.DB.prepare("SELECT name FROM event_tables WHERE id=? AND event_id=?").bind(guest.table_id, event.id).first() : null;
  return json({ guest: { id: guest.id, name: guest.name, table: table?.name || null }, event: payload.event, submissions: payload.submissions, winnerNotice: payload.winnerNotice }, 200, { "Set-Cookie": session.header });
}

export async function handleGuestApi(ctx, path) {
  const { request, env } = ctx;
  const db = env.DB;
  const method = request.method;
  const url = new URL(request.url);

  if (path === "/api/events/current" && method === "GET") {
    const session = await guestSession(request, env);
    const event = await resolvePublicEvent(request, env, session);
    if (!event) return json({ event: null, serverTime: nowIso() });
    const venue = await db.prepare("SELECT * FROM venues WHERE id=?").bind(event.venue_id).first();
    const shaped = await shapeEvent(db, event, venue);
    if (!session || session.event_id !== event.id) return json({ event: { ...shaped, serverTime: nowIso() }, serverTime: nowIso() });
    const payload = await eventForGuest(db, session.guest_id, event.id);
    return json({ ...payload, guest: { id: session.guest_id, name: session.name, tableId: session.table_id }, serverTime: nowIso(), event: { ...payload.event, serverTime: nowIso() } });
  }
  if (path === "/api/guests/identify" && method === "POST") return identifyGuest(request, env, false);
  if (path === "/api/guests/identify/select" && method === "POST") return identifyGuest(request, env, true);
  if (path === "/api/guests/session" && method === "DELETE") return await revokeGuest(request, env);

  if (path === "/api/photos" && method === "POST") return await submitPhoto(request, env);
  if (path === "/api/messages" && method === "POST") return await submitDedication(request, env);
  if (path.startsWith("/api/media/") && method === "GET") return await serveMedia(path.slice("/api/media/".length), env);
  if (path === "/api/guest/winner" && method === "GET") {
    const session = await guestSession(request, env);
    if (!session) return fail("Identifícate para consultar tu resultado.", 401, "guest_required");
    const result = await db.prepare(`SELECT c.name AS contestName,c.winner_confirmed_at AS confirmedAt,p.name AS prizeName
      FROM contests c LEFT JOIN prizes p ON p.id=c.prize_id WHERE c.event_id=? AND c.winner_guest_id=? AND c.state='finished'
      ORDER BY c.winner_confirmed_at DESC`).bind(session.event_id, session.guest_id).all();
    return json({ wins: (result.results || []).map((win) => ({ ...win, message: win.prizeName ? "¡Felicidades! Acércate al staff para recibir tu premio." : "¡Felicidades! Has ganado." })) });
  }
  return null;
}

async function eligibleForContest(db, event, activity, receivedAt) {
  if (!event.contests_enabled || !isEligible(receivedAt, activity.photo_opens_at, activity.photo_closes_at)) return false;
  const contest = await db.prepare(`SELECT c.id FROM contests c JOIN contest_activities ca ON ca.contest_id=c.id
    WHERE c.event_id=? AND ca.activity_id=? AND c.state='active' AND c.opens_at<=? AND c.closes_at>? LIMIT 1`)
    .bind(event.id, activity.id, receivedAt, receivedAt).first();
  return Boolean(contest);
}

async function submitPhoto(request, env) {
  const db = env.DB;
  const session = await guestSession(request, env);
  if (!session) return fail("Tu invitación venció. Vuelve a identificarte.", 401, "guest_required");
  const idempotencyKey = request.headers.get("idempotency-key") || "";
  if (!/^[A-Za-z0-9_-]{12,160}$/.test(idempotencyKey)) return fail("No pudimos identificar el intento de envío. Vuelve a seleccionar la foto.");
  let data;
  try { data = await request.formData(); }
  catch { return fail("El formulario de la fotografía no es válido."); }
  const file = data.get("photo");
  const activityId = String(data.get("momentId") || data.get("activityId") || "");
  if (!(file instanceof File) || !file.type.startsWith("image/") || !file.size) return fail("Selecciona una imagen válida.");
  if (file.size > 15 * 1024 * 1024) return fail("La foto debe pesar menos de 15 MB.", 413, "photo_too_large");
  const activity = await db.prepare("SELECT * FROM event_activities WHERE id=? AND event_id=? AND active=1").bind(activityId, session.event_id).first();
  const event = await db.prepare("SELECT * FROM events WHERE id=? AND state='active'").bind(session.event_id).first();
  if (!activity || !event) return fail("Ese momento no pertenece a tu boda.", 403, "activity_event_mismatch");
  const receivedAt = nowIso();
  const eligible = await eligibleForContest(db, event, activity, receivedAt);
  const prior = await db.prepare("SELECT * FROM photo_submissions WHERE event_id=? AND activity_id=? AND guest_id=?")
    .bind(event.id, activity.id, session.guest_id).first();
  let submissionId;
  if (prior?.storage_state === "stored") return fail("Ya enviaste tu foto definitiva para este momento.", 409, "photo_already_submitted");
  if (prior?.storage_state === "pending" && prior.request_key !== idempotencyKey) return fail("Ya se está procesando una foto para este momento.", 409, "photo_upload_in_progress");
  if (prior?.storage_state === "failed") {
    submissionId = prior.id;
    await db.prepare("UPDATE photo_submissions SET request_key=?,received_at=?,eligible=?,storage_state='pending',error_code=NULL WHERE id=?")
      .bind(idempotencyKey, receivedAt, eligible ? 1 : 0, submissionId).run();
  } else if (prior?.storage_state === "pending" && prior.request_key === idempotencyKey) {
    submissionId = prior.id;
  } else {
    submissionId = newId();
    try {
      await db.prepare(`INSERT INTO photo_submissions (id,event_id,activity_id,guest_id,request_key,received_at,eligible,storage_state)
        VALUES (?,?,?,?,?,?,?,'pending')`).bind(submissionId, event.id, activity.id, session.guest_id, idempotencyKey, receivedAt, eligible ? 1 : 0).run();
    } catch { return fail("Ya existe un envío registrado para este momento. Pide ayuda al fotógrafo.", 409, "photo_submission_conflict"); }
  }
  try {
    let folderId = activity.drive_folder_id;
    if (!folderId) folderId = await ensureActivityDriveFolder(env, db, event, activity);
    const saved = await uploadGuestPhoto(env, folderId, event.id, session.guest_id, idempotencyKey, file, safeImageName(file.name, session.guest_id, activity.name));
    await db.prepare("UPDATE photo_submissions SET storage_state='stored',drive_file_id=?,error_code=NULL WHERE id=?")
      .bind(saved.id, submissionId).run();
    await db.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?, 'guest', ?, 'photo.stored','photo_submission',?,'{}',?)")
      .bind(newId(), event.id, session.guest_id, submissionId, nowIso()).run();
    return json({ submission: { id: submissionId, momentId: activity.id, eligible, storageState: "stored", receivedAt } }, 201);
  } catch (error) {
    await db.prepare("UPDATE photo_submissions SET storage_state='failed',error_code=? WHERE id=?").bind(String(error.code || "drive_error").slice(0, 80), submissionId).run();
    await db.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?, 'guest', ?, 'photo.drive_failed','photo_submission',?,?,?)")
      .bind(newId(), event.id, session.guest_id, submissionId, JSON.stringify({ code: String(error.code || "drive_error") }), nowIso()).run();
    return json({ error: "photo_not_stored", message: "La foto no llegó a la carpeta de Drive. Tu participación quedó registrada si el horario y las reglas la permiten. Vuelve a seleccionarla para reintentar.", participationRecorded: true, submissionId }, 502);
  }
}

function safeImageName(original, guestId, activityName) {
  const ext = String(original || "").split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "img";
  const clean = String(activityName || "momento").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 45) || "momento";
  return new Date().toISOString().replace(/[:.]/g, "-") + "_" + guestId.slice(0, 8) + "_" + clean + "." + ext;
}

async function submitDedication(request, env) {
  const db = env.DB;
  const session = await guestSession(request, env);
  if (!session) return fail("Tu invitación venció. Vuelve a identificarte.", 401, "guest_required");
  const data = await readJson(request, 4096);
  const message = String(data.message || "").trim();
  if (message.length < 1 || message.length > 500) return fail("La dedicatoria debe tener entre 1 y 500 caracteres.");
  const id = newId();
  const stamp = nowIso();
  await db.prepare("INSERT INTO dedications (id,event_id,guest_id,message,created_at,sheet_state) VALUES (?,?,?,?,?,'pending')")
    .bind(id, session.event_id, session.guest_id, message, stamp).run();
  try { await enqueueJob(db, session.event_id, "sync_dedication", id); }
  catch (error) { console.error("dedication_job_enqueue_failed", String(error.code || "database_error")); }
  await db.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?, 'guest', ?, 'dedication.created','dedication',?,'{}',?)")
    .bind(newId(), session.event_id, session.guest_id, id, stamp).run();
  return json({ messageId: id, storageState: "pending", message: "Tu dedicatoria está guardada y se sincronizará con la hoja del evento." }, 202);
}

async function serveMedia(assetId, env) {
  const asset = await env.DB.prepare("SELECT r2_key,content_type,byte_size FROM media_assets WHERE id=?").bind(assetId).first();
  if (!asset || !env.EVENT_MEDIA) return fail("No se encontró la imagen de referencia.", 404, "media_not_found");
  const object = await env.EVENT_MEDIA.get(asset.r2_key);
  if (!object) return fail("La imagen de referencia no está disponible.", 404, "media_not_found");
  return new Response(object.body, { headers: { "Content-Type": asset.content_type, "Content-Length": String(asset.byte_size), "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}

export async function currentEventForStaff(db, eventId) {
  const event = await db.prepare("SELECT * FROM events WHERE id=? AND state='active'").bind(eventId).first();
  if (!event) return null;
  const venue = await db.prepare("SELECT id,name,slug,timezone FROM venues WHERE id=? AND active=1").bind(event.venue_id).first();
  const shaped = await shapeEvent(db, event, venue);
  return { event: shaped, serverTime: nowIso() };
}
