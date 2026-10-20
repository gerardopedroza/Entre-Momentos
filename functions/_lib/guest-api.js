import { createGuestSession, guestSession, revokeGuest } from "./auth.js";
import { fail, getEventDateLocal, isEligible, json, newId, normalizeName, nowIso, readJson } from "./core.js";
import { downloadDriveImage } from "./google-drive.js";
import { storeDedication, uploadGuestPhoto } from "./r2-storage.js";

let presenceTablePromise = null;
const PRESENCE_TTL_MS = 60000;

async function ensurePresenceTable(db) {
  if (!presenceTablePromise) {
    presenceTablePromise = db.prepare(`CREATE TABLE IF NOT EXISTS guest_presence (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      guest_id TEXT NOT NULL REFERENCES event_guests(id) ON DELETE CASCADE,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (event_id, guest_id)
    )`).run().catch((error) => { presenceTablePromise = null; throw error; });
  }
  await presenceTablePromise;
}

async function activeGuestCount(db, eventId) {
  await ensurePresenceTable(db);
  const cutoff = new Date(Date.now() - PRESENCE_TTL_MS).toISOString();
  const result = await db.prepare("SELECT COUNT(*) AS active_count FROM guest_presence WHERE event_id=? AND last_seen_at>=?")
    .bind(eventId, cutoff).first();
  return Number(result?.active_count || 0);
}

async function updateGuestPresence(request, env) {
  const session = await guestSession(request, env);
  if (!session) return fail("Identifícate para registrar tu conexión.", 401, "guest_required");
  const data = await readJson(request, 2048);
  if (String(data.eventId || "") !== session.event_id) return fail("La conexión no corresponde a este evento.", 403, "event_session_mismatch");
  const event = await env.DB.prepare("SELECT id FROM events WHERE id=? AND state IN ('active', 'draft')").bind(session.event_id).first();
  if (!event) return fail("Este evento ya no está activo.", 404, "event_unavailable");
  await ensurePresenceTable(env.DB);
  const stamp = nowIso();
  if (data.active === false) {
    await env.DB.prepare("DELETE FROM guest_presence WHERE event_id=? AND guest_id=?").bind(session.event_id, session.guest_id).run();
  } else {
    await env.DB.prepare(`INSERT INTO guest_presence (event_id,guest_id,last_seen_at) VALUES (?,?,?)
      ON CONFLICT(event_id,guest_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`)
      .bind(session.event_id, session.guest_id, stamp).run();
  }
  await env.DB.prepare("DELETE FROM guest_presence WHERE event_id=? AND last_seen_at<?").bind(session.event_id, new Date(Date.now() - PRESENCE_TTL_MS).toISOString()).run();
  return json({ activeCount: await activeGuestCount(env.DB, session.event_id) });
}

function publicUrl(event, venue) { return venue?.slug ? "/l/" + encodeURIComponent(venue.slug) : "/?event=" + encodeURIComponent(event.slug || ""); }

async function resolvePublicEvent(request, env, eventSession = null) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("event");
  const venueSlug = url.searchParams.get("venue");
  let event = null;
  if (venueSlug) {
    const venue = await env.DB.prepare("SELECT * FROM venues WHERE slug=? COLLATE NOCASE AND active=1").bind(venueSlug).first();
    if (venue) {
      event = await env.DB.prepare("SELECT * FROM events WHERE venue_id=? AND event_date=? AND state IN ('active', 'draft') LIMIT 1")
        .bind(venue.id, getEventDateLocal(new Date(), venue.timezone)).first();
      if (!event) {
        event = await env.DB.prepare("SELECT * FROM events WHERE venue_id=? AND state IN ('active', 'draft') ORDER BY CASE WHEN state='active' THEN 0 ELSE 1 END, event_date DESC LIMIT 1")
          .bind(venue.id).first();
      }
    }
  }
  if (!venueSlug && eventSession?.event_id) {
    event = await env.DB.prepare("SELECT * FROM events WHERE id=? AND state IN ('active', 'draft')").bind(eventSession.event_id).first();
  }
  if (!venueSlug && !event && slug) {
    event = await env.DB.prepare("SELECT * FROM events WHERE slug=? COLLATE NOCASE AND state IN ('active', 'draft')").bind(slug).first();
  }
  // Una URL de lugar solo puede resolver a un evento de ese lugar; nunca caer al evento principal.
  if (!event && !venueSlug) {
    event = await env.DB.prepare("SELECT * FROM events WHERE state IN ('active', 'draft') ORDER BY CASE WHEN state='active' THEN 0 ELSE 1 END, event_date DESC LIMIT 1").first();
  }
  return event;
}

async function shapeEvent(db, event, venue, now = Date.now()) {
  if (!event) return null;
  if (!venue && event.venue_id) {
    venue = await db.prepare("SELECT id,name,slug,timezone FROM venues WHERE id=?").bind(event.venue_id).first();
  }
  const timezone = event.timezone || venue?.timezone || "America/Mexico_City";
  const activities = await db.prepare("SELECT a.*,m.id AS asset_id FROM event_activities a LEFT JOIN media_assets m ON m.id=a.reference_asset_id WHERE a.event_id=? AND a.active=1 ORDER BY a.position,a.starts_at")
    .bind(event.id).all();
  const moments = (activities.results || []).map((activity) => ({
    id: activity.id,
    name: activity.name,
    description: activity.description || "",
    position: activity.position,
    start: new Intl.DateTimeFormat("es-MX", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(activity.starts_at)),
    startsAt: activity.starts_at,
    endsAt: activity.ends_at,
    photoOpensAt: activity.photo_opens_at,
    photoClosesAt: activity.photo_closes_at,
    coverUrl: activity.asset_id ? "/api/media/" + activity.asset_id : null,
    state: now < Date.parse(activity.starts_at) ? "upcoming" : now < Date.parse(activity.ends_at) ? "active" : "finished",
  }));
  const current = moments.find((activity) => {
    const opensAt = Date.parse(activity.photoOpensAt || "");
    const closesAt = Date.parse(activity.photoClosesAt || "");
    return Number.isFinite(opensAt) && Number.isFinite(closesAt) && now >= opensAt && now < closesAt;
  });
  const next = moments.filter((activity) => {
    const opensAt = Date.parse(activity.photoOpensAt || "");
    return Number.isFinite(opensAt) && opensAt > now;
  }).sort((a, b) => Date.parse(a.photoOpensAt) - Date.parse(b.photoOpensAt))[0] || moments[0];
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    date: event.event_date,
    timezone: timezone,
    state: event.state,
    coverUrl: event.cover_asset_id ? "/api/media/" + event.cover_asset_id : null,
    contestsEnabled: Boolean(event.contests_enabled),
    venue: venue ? { id: venue.id, name: venue.name, slug: venue.slug } : { id: "", name: event.name || "Evento", slug: event.slug || "" },
    publicUrl: venue ? publicUrl(event, venue) : "/?event=" + encodeURIComponent(event.slug || ""),
    moments,
    activeMomentId: current?.id || null,
    nextMomentId: next?.id || null,
  };
}

async function eventForGuest(db, guestId, eventId, now = Date.now()) {
  const event = await db.prepare("SELECT * FROM events WHERE id=? AND state IN ('active', 'draft')").bind(eventId).first();
  if (!event) return null;
  const venue = await db.prepare("SELECT id,name,slug,timezone FROM venues WHERE id=?").bind(event.venue_id).first();
  const shaped = await shapeEvent(db, event, venue, now);
  const submissions = await db.prepare("SELECT id,activity_id AS momentId,eligible,storage_state AS storageState,received_at AS receivedAt FROM photo_submissions WHERE guest_id=? AND event_id=? ORDER BY received_at")
    .bind(guestId, eventId).all();
  const wonContests = await db.prepare(`SELECT c.id, c.name AS contest_name, c.kind, c.winner_confirmed_at,
      p.id AS prize_id, p.name AS prize_name, p.instructions AS prize_instructions, pd.delivered_at
    FROM contests c
    LEFT JOIN prizes p ON p.id = c.prize_id
    LEFT JOIN prize_deliveries pd ON pd.contest_id = c.id
    WHERE c.event_id = ? AND c.winner_guest_id = ? AND c.state = 'finished'
    ORDER BY c.winner_confirmed_at DESC`).bind(eventId, guestId).all();

  const wonPrizes = (wonContests.results || []).map((w) => ({
    contestId: w.id,
    contestName: w.contest_name,
    kind: w.kind,
    isPhysical: Boolean(w.prize_name && String(w.prize_name).trim().length > 0),
    prizeName: w.prize_name ? String(w.prize_name).trim() : null,
    prizeInstructions: w.prize_instructions ? String(w.prize_instructions).trim() : "Acércate al staff o coordinación para recibir tu regalo.",
    deliveredAt: w.delivered_at || null,
    isDelivered: Boolean(w.delivered_at),
    confirmedAt: w.winner_confirmed_at
  }));

  const pendingPhysical = wonPrizes.filter((w) => w.isPhysical && !w.isDelivered);
  const deliveredPhysical = wonPrizes.filter((w) => w.isPhysical && w.isDelivered);
  const virtualWins = wonPrizes.filter((w) => !w.isPhysical);

  const primary = pendingPhysical[0] || deliveredPhysical[0] || virtualWins[0] || null;
  const winnerNotice = primary ? {
    contestId: primary.contestId,
    contestName: primary.contestName,
    isPhysical: primary.isPhysical,
    prizeName: primary.prizeName,
    prizeInstructions: primary.prizeInstructions,
    deliveredAt: primary.deliveredAt,
    isDelivered: primary.isDelivered,
    text: primary.isPhysical
      ? (pendingPhysical.length > 1
          ? `¡Felicidades! Tienes ${pendingPhysical.length} premios por reclamar con el staff.`
          : `¡Felicidades! Ganaste el reto «${primary.contestName}». Acércate al staff para recibir tu premio (${primary.prizeName}).`)
      : `¡Felicidades! Ganaste el reto «${primary.contestName}». ¡Gracias por compartir tus fotos!`
  } : null;

  return { event: shaped, submissions: submissions.results || [], winnerNotice, wonPrizes };
}

async function resolveEventFromBody(data, request, env) {
  const eventId = data?.eventId;
  if (eventId) {
    const event = await env.DB.prepare("SELECT * FROM events WHERE id=? AND state IN ('active', 'draft')").bind(eventId).first();
    if (event) return event;
  }
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
    try { guest = await env.DB.prepare("SELECT id,name,nickname,table_id FROM event_guests WHERE id=? AND event_id=? AND active=1").bind(String(data.guestId), event.id).first(); }
    catch (error) { if (!/no such column: nickname/i.test(error.message)) throw error; guest = await env.DB.prepare("SELECT id,name,NULL AS nickname,table_id FROM event_guests WHERE id=? AND event_id=? AND active=1").bind(String(data.guestId), event.id).first(); }
  } else {
    const terms = [...new Set(name.split(/\s+/).filter((term) => term.length > 1))];
    if (!terms.length) return fail("Escribe al menos dos letras de tu nombre o apellido.");
    const conditions = terms.map(() => "(instr(g.name_key,?)>0 OR (g.nickname IS NOT NULL AND instr(lower(g.nickname),?)>0))").join(" OR ");
    let matches;
    const termBindings = [];
    terms.forEach((term) => { termBindings.push(term, term); });
    try {
      matches = await env.DB.prepare(`SELECT g.id,g.name,g.nickname,g.name_key,g.table_id,t.name AS table_name
        FROM event_guests g LEFT JOIN event_tables t ON t.id=g.table_id
        WHERE g.event_id=? AND g.active=1 AND (${conditions})
        ORDER BY CASE WHEN g.name_key=? THEN 0 WHEN instr(g.name_key,?)=1 THEN 1 ELSE 2 END, g.name`).bind(event.id, ...termBindings, name, name).all();
    } catch (error) {
      if (!/no such column: g\.nickname/i.test(error.message)) throw error;
      const legacyConditions = terms.map(() => "instr(g.name_key,?)>0").join(" OR ");
      matches = await env.DB.prepare(`SELECT g.id,g.name,NULL AS nickname,g.name_key,g.table_id,t.name AS table_name
        FROM event_guests g LEFT JOIN event_tables t ON t.id=g.table_id
        WHERE g.event_id=? AND g.active=1 AND (${legacyConditions})
        ORDER BY CASE WHEN g.name_key=? THEN 0 WHEN instr(g.name_key,?)=1 THEN 1 ELSE 2 END, g.name`).bind(event.id, ...terms, name, name).all();
    }
    const found = matches.results || [];
    if (!found.length) return fail("No encontré ese nombre en la lista del evento. Revisa cómo está escrito.", 404, "guest_not_found");
    if (terms.length > 1) {
      found.sort((a, b) => {
        const aKey = a.name_key || "";
        const bKey = b.name_key || "";
        if (aKey === name && bKey !== name) return -1;
        if (bKey === name && aKey !== name) return 1;
        const aAll = terms.every((t) => aKey.includes(t));
        const bAll = terms.every((t) => bKey.includes(t));
        if (aAll && !bAll) return -1;
        if (bAll && !aAll) return 1;
        const aCount = terms.filter((t) => aKey.includes(t)).length;
        const bCount = terms.filter((t) => bKey.includes(t)).length;
        if (aCount !== bCount) return bCount - aCount;
        return a.name.localeCompare(b.name, "es-MX");
      });
    }
    if (found.length > 1 || found[0].name_key !== name) {
      return json({
        matches: found.map((match) => ({
          id: match.id,
          name: match.name,
          nickname: match.nickname,
          reference: match.table_name ? "Mesa " + match.table_name : "Toca para confirmar"
        })),
        hasMore: false
      });
    }
    guest = found[0];
  }
  if (!guest) return fail("No encontré a esa persona en la lista del evento.", 404, "guest_not_found");
  const session = await createGuestSession(env, guest, event.id);
  const payload = await eventForGuest(env.DB, guest.id, event.id);
  const table = guest.table_id ? await env.DB.prepare("SELECT name FROM event_tables WHERE id=? AND event_id=?").bind(guest.table_id, event.id).first() : null;
  return json({ guest: { id: guest.id, name: guest.name, nickname: guest.nickname || null, table: table?.name || null }, event: payload.event, submissions: payload.submissions, winnerNotice: payload.winnerNotice }, 200, { "Set-Cookie": session.header });
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
    shaped.presence = { activeCount: await activeGuestCount(db, event.id) };
    if (!session || session.event_id !== event.id) return json({ event: { ...shaped, serverTime: nowIso() }, serverTime: nowIso() });
    const payload = await eventForGuest(db, session.guest_id, event.id);
    return json({ ...payload, guest: { id: session.guest_id, name: session.name, nickname: session.nickname || null, tableId: session.table_id }, serverTime: nowIso(), event: { ...payload.event, serverTime: nowIso() } });
  }
  if (path === "/api/guests/identify" && method === "POST") return identifyGuest(request, env, false);
  if (path === "/api/guests/identify/select" && method === "POST") return identifyGuest(request, env, true);
  if (path === "/api/guests/session" && method === "DELETE") return await revokeGuest(request, env);
  if (path === "/api/guest/presence" && method === "POST") return await updateGuestPresence(request, env);

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
  if (!event.contests_enabled) return false;
  // Sin restricción de horario: siempre participa en el reto del evento o actividad
  const contest = await db.prepare(`SELECT c.id FROM contests c LEFT JOIN contest_activities ca ON ca.contest_id=c.id
    WHERE c.event_id=? AND (ca.activity_id=? OR ca.activity_id IS NULL) AND c.state IN ('active', 'draft') LIMIT 1`)
    .bind(event.id, activity.id).first();
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
  const event = await db.prepare("SELECT * FROM events WHERE id=? AND state IN ('active', 'draft')").bind(session.event_id).first();
  if (!activity || !event) return fail("Ese momento no pertenece a tu boda.", 403, "activity_event_mismatch");
  const receivedAt = nowIso();
  const eligible = await eligibleForContest(db, event, activity, receivedAt);
  const prior = await db.prepare("SELECT * FROM photo_submissions WHERE event_id=? AND activity_id=? AND guest_id=?")
    .bind(event.id, activity.id, session.guest_id).first();
  let submissionId;
  if (prior?.storage_state === "pending" && prior.request_key !== idempotencyKey) return fail("Ya se está procesando una foto para este momento.", 409, "photo_upload_in_progress");
  if (prior?.id) {
    submissionId = prior.id;
    await db.prepare("UPDATE photo_submissions SET request_key=?,received_at=?,eligible=?,storage_state='pending',error_code=NULL WHERE id=?")
      .bind(idempotencyKey, receivedAt, eligible ? 1 : 0, submissionId).run();
  } else {
    submissionId = newId();
    try {
      await db.prepare(`INSERT INTO photo_submissions (id,event_id,activity_id,guest_id,request_key,received_at,eligible,storage_state)
        VALUES (?,?,?,?,?,?,?,'pending')`).bind(submissionId, event.id, activity.id, session.guest_id, idempotencyKey, receivedAt, eligible ? 1 : 0).run();
    } catch {
      submissionId = prior?.id || newId();
      await db.prepare("UPDATE photo_submissions SET request_key=?,received_at=?,eligible=?,storage_state='pending',error_code=NULL WHERE id=?")
        .bind(idempotencyKey, receivedAt, eligible ? 1 : 0, submissionId).run();
    }
  }
  try {
    const saved = await uploadGuestPhoto(env, event, activity, session.guest_id, file, safeImageName(file.name, session.guest_id, activity.name));
    await db.prepare("UPDATE photo_submissions SET storage_state='stored',drive_file_id=?,error_code=NULL WHERE id=?")
      .bind("r2:" + saved.key, submissionId).run();
    await db.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?, 'guest', ?, 'photo.stored','photo_submission',?,'{}',?)")
      .bind(newId(), event.id, session.guest_id, submissionId, nowIso()).run();

    let winnerNotice = null;
    if (event.contests_enabled) {
      // Evaluar si esta foto hace ganador al invitado en un reto de primera foto (de la actividad o de todo el evento)
      const candidate = await db.prepare(`SELECT c.*, p.name AS prize_name, p.instructions AS prize_instructions
        FROM contests c LEFT JOIN prizes p ON p.id=c.prize_id
        WHERE c.event_id=? AND c.winner_guest_id IS NULL AND c.state IN ('active', 'draft') AND c.kind='first_photo'
          AND (
            EXISTS (SELECT 1 FROM contest_activities ca WHERE ca.contest_id=c.id AND ca.activity_id=?)
            OR NOT EXISTS (SELECT 1 FROM contest_activities ca WHERE ca.contest_id=c.id)
            OR instr(c.rule_json, '"scope":"event"') > 0
          )
        ORDER BY CASE WHEN EXISTS (SELECT 1 FROM contest_activities ca WHERE ca.contest_id=c.id AND ca.activity_id=?) THEN 0 ELSE 1 END, c.opens_at ASC LIMIT 1`)
        .bind(event.id, activity.id, activity.id).first();

      if (candidate) {
        // Asignación atómica del ganador
        const crowned = await db.prepare(`UPDATE contests SET winner_guest_id=?, winner_confirmed_at=?, winner_confirmed_by='system', state='finished', updated_at=?
          WHERE id=? AND winner_guest_id IS NULL`).bind(session.guest_id, receivedAt, receivedAt, candidate.id).run();
        if (crowned.meta?.changes) {
          const resultId = newId();
          await db.prepare(`INSERT OR REPLACE INTO contest_results (id,contest_id,event_id,winner_guest_id,calculation,entry_count,trace_json,calculated_at)
            VALUES (?,?,?,?,'first_photo',1,?,?)`).bind(resultId, candidate.id, event.id, session.guest_id, JSON.stringify({ submissionId }), receivedAt).run();
          if (candidate.prize_id) {
            const deliveryId = newId();
            await db.prepare(`INSERT OR REPLACE INTO prize_deliveries (id,contest_id,prize_id,guest_id,created_at) VALUES (?,?,?,?,?)`)
              .bind(deliveryId, candidate.id, candidate.prize_id, session.guest_id, receivedAt).run();
          }
          await db.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?, 'system', 'first_photo', 'contest.winner_assigned','contest',?,?,?)")
            .bind(newId(), event.id, candidate.id, JSON.stringify({ guestId: session.guest_id, contestName: candidate.name }), receivedAt).run();

          winnerNotice = {
            contestId: candidate.id,
            contestName: candidate.name,
            isPhysical: Boolean(candidate.prize_name && String(candidate.prize_name).trim().length > 0),
            prizeName: candidate.prize_name || null,
            prizeInstructions: candidate.prize_instructions || "Acércate al staff para recibir tu regalo.",
            text: candidate.prize_name
              ? `¡Felicidades! Ganaste el reto «${candidate.name}». Acércate al staff para recibir tu premio (${candidate.prize_name}).`
              : `¡Felicidades! Ganaste el reto «${candidate.name}». ¡Gracias por compartir tus fotos!`
          };
        }
      }
    }

    const wonContests = await db.prepare(`SELECT c.id, c.name AS contest_name, c.kind, c.winner_confirmed_at,
        p.id AS prize_id, p.name AS prize_name, p.instructions AS prize_instructions, pd.delivered_at
      FROM contests c
      LEFT JOIN prizes p ON p.id = c.prize_id
      LEFT JOIN prize_deliveries pd ON pd.contest_id = c.id
      WHERE c.event_id = ? AND c.winner_guest_id = ? AND c.state = 'finished'
      ORDER BY c.winner_confirmed_at DESC`).bind(event.id, session.guest_id).all();

    const wonPrizes = (wonContests.results || []).map((w) => ({
      contestId: w.id,
      contestName: w.contest_name,
      kind: w.kind,
      isPhysical: Boolean(w.prize_name && String(w.prize_name).trim().length > 0),
      prizeName: w.prize_name ? String(w.prize_name).trim() : null,
      prizeInstructions: w.prize_instructions ? String(w.prize_instructions).trim() : "Acércate al staff o coordinación para recibir tu regalo.",
      deliveredAt: w.delivered_at || null,
      isDelivered: Boolean(w.delivered_at),
      confirmedAt: w.winner_confirmed_at
    }));

    return json({ submission: { id: submissionId, momentId: activity.id, eligible, storageState: "stored", receivedAt }, winnerNotice, wonPrizes }, 201);
  } catch (error) {
    await db.prepare("UPDATE photo_submissions SET storage_state='failed',error_code=? WHERE id=?").bind(String(error.code || "r2_upload_error").slice(0, 80), submissionId).run();
    await db.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?, 'guest', ?, 'photo.r2_failed','photo_submission',?,?,?)")
      .bind(newId(), event.id, session.guest_id, submissionId, JSON.stringify({ code: String(error.code || "r2_upload_error") }), nowIso()).run();
    return json({ error: "photo_not_stored", participationRecorded: true, submissionId }, 502);
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
  const guest = await db.prepare("SELECT name FROM event_guests WHERE id=? AND event_id=?").bind(session.guest_id, session.event_id).first();
  const dedicationObject = { id, guestName: guest?.name || "Invitado", message, createdAt: stamp };
  let objectKey;
  try { objectKey = await storeDedication(env, session.event_id, dedicationObject); }
  catch (error) { return fail("No se pudo guardar la dedicatoria en el almacenamiento del evento. Inténtalo de nuevo.", error.status || 503, error.code || "event_media_unavailable"); }
  try {
    await db.prepare("INSERT INTO dedications (id,event_id,guest_id,message,created_at,sheet_state) VALUES (?,?,?,?,?,'synced')")
      .bind(id, session.event_id, session.guest_id, message, stamp).run();
  } catch (error) { try { await env.EVENT_MEDIA.delete(objectKey); } catch {} throw error; }
  await db.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?, 'guest', ?, 'dedication.created','dedication',?,'{}',?)")
    .bind(newId(), session.event_id, session.guest_id, id, stamp).run();
  return json({ messageId: id, storageState: "stored", message: "Tu dedicatoria quedó guardada para el álbum." }, 201);
}

async function serveMedia(assetId, env) {
  const asset = await env.DB.prepare("SELECT r2_key,content_type,byte_size FROM media_assets WHERE id=?").bind(assetId).first();
  if (!asset) return fail("No se encontró la imagen de referencia.", 404, "media_not_found");
  if (asset.r2_key.startsWith("drive:")) {
    const response = await downloadDriveImage(env, asset.r2_key.slice(6));
    return new Response(response.body, { headers: { "Content-Type": asset.content_type, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  }
  if (!env.EVENT_MEDIA) return fail("La imagen de referencia no está disponible.", 404, "media_not_found");
  const object = await env.EVENT_MEDIA.get(asset.r2_key);
  if (!object) return fail("La imagen de referencia no está disponible.", 404, "media_not_found");
  return new Response(object.body, { headers: { "Content-Type": asset.content_type, "Content-Length": String(asset.byte_size), "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}

export async function currentEventForStaff(db, eventId) {
  const event = await db.prepare("SELECT * FROM events WHERE id=? AND state IN ('active', 'draft')").bind(eventId).first();
  if (!event) return null;
  const venue = await db.prepare("SELECT id,name,slug,timezone FROM venues WHERE id=?").bind(event.venue_id).first();
  const shaped = await shapeEvent(db, event, venue);
  return { event: shaped, serverTime: nowIso() };
}
