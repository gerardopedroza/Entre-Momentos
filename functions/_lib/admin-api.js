import { createAdminSession, requireAdmin, revokeAdmin } from "./auth.js";
import { enqueueJob, processDueJobs } from "./jobs.js";
import { fail, getEventDateLocal, json, localDateTimeToIso, newId, nowIso, readJson, slugify } from "./core.js";
import { deleteDriveImage, driveIdFromUrl, ensureEventDriveStructure } from "./google-drive.js";

const KINDS = new Set(["first_photo", "most_photos", "photo_with_couple", "bouquet", "manual"]);

function routeId(path, prefix) { return path.slice(prefix.length).split("/").filter(Boolean); }
function apiError(error) { return fail(error.message || "No se pudo completar la operación.", error.status || 400, error.code || "invalid_request"); }
function isMissingColumn(error, column) { return new RegExp(`(?:no such column:\\s*(?:[\\w]+\\.)?${column}\\b|has no column named\\s+${column}\\b)`, "i").test(String(error?.message || error)); }
async function authorized(ctx) { await requireAdmin(ctx.request, ctx.env); }
async function eventOr404(db, id) { const row = await db.prepare("SELECT * FROM events WHERE id=?").bind(id).first(); if (!row) throw Object.assign(new Error("No se encontró el evento."), { status: 404, code: "event_not_found" }); return row; }
async function log(db, action, entityType, entityId, eventId = null, detail = {}) {
  await db.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?, 'admin', 'administrator', ?,?,?,?,?)")
    .bind(newId(), eventId, action, entityType, entityId, JSON.stringify(detail), nowIso()).run();
}
function publicEventPath(event, venue) { return "/l/" + venue.slug + "?event=" + encodeURIComponent(event.slug); }

export async function handleAdminApi(ctx, path) {
  const { request, env } = ctx;
  const db = env.DB;
  const method = request.method;
  try {
    if (path === "/api/admin/session" && method === "POST") {
      const { handleAdminLogin } = await import("./auth.js");
      return await handleAdminLogin(request, env);
    }
    if (path === "/api/admin/session" && method === "GET") {
      const { adminSession } = await import("./auth.js");
      return json({ authenticated: Boolean(await adminSession(request, env)), role: "admin" });
    }
    if (path === "/api/admin/session" && method === "DELETE") return await revokeAdmin(request, env);
    await authorized(ctx);

    if (path === "/api/admin/dashboard" && method === "GET") {
      const venues = await db.prepare("SELECT v.*,COUNT(e.id) AS event_count FROM venues v LEFT JOIN events e ON e.venue_id=v.id GROUP BY v.id ORDER BY v.name").all();
      const events = await db.prepare(`SELECT e.*,v.name AS venue_name,v.slug AS venue_slug,
        (SELECT COUNT(*) FROM event_activities a WHERE a.event_id=e.id AND a.active=1) AS activity_count,
        (SELECT COUNT(*) FROM event_guests g WHERE g.event_id=e.id AND g.active=1) AS guest_count,
        (SELECT COUNT(*) FROM integration_jobs j WHERE j.event_id=e.id AND j.state IN ('pending','retry','dead')) AS pending_jobs
        FROM events e JOIN venues v ON v.id=e.venue_id ORDER BY e.event_date DESC,e.name`).all();
      const origin = new URL(request.url).origin;
      return json({ venues: venues.results || [], events: (events.results || []).map((event) => ({
        ...event,
        guestUrl: origin + publicEventPath(event, { slug: event.venue_slug }),
        staffUrl: origin + "/staff.html?access=" + encodeURIComponent(event.public_staff_slug),
      })) });
    }

    if (path === "/api/admin/venues" && method === "GET") {
      return json({ venues: (await db.prepare("SELECT * FROM venues ORDER BY name").all()).results || [] });
    }
    if (path === "/api/admin/venues" && method === "POST") {
      const data = await readJson(request);
      const name = String(data.name || "").trim();
      const slug = slugify(name);
      if (name.length < 2 || !slug) return fail("Escribe un nombre válido para el lugar.");
      const id = newId();
      const stamp = nowIso();
      try {
        await db.prepare("INSERT INTO venues (id,name,slug,timezone,drive_root_folder_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
          .bind(id, name, slug, data.timezone || "America/Mexico_City", null, data.active === false ? 0 : 1, stamp, stamp).run();
      } catch (error) { if (/UNIQUE/i.test(error.message)) return fail("Ya existe un lugar con esa URL corta.", 409, "venue_slug_taken"); throw error; }
      await log(db, "venue.created", "venue", id);
      return json({ venue: await db.prepare("SELECT * FROM venues WHERE id=?").bind(id).first() }, 201);
    }
    if (path.startsWith("/api/admin/venues/")) {
      const [id, action] = routeId(path, "/api/admin/venues/");
      const venue = await db.prepare("SELECT * FROM venues WHERE id=?").bind(id).first();
      if (!venue) return fail("No se encontró el lugar.", 404, "venue_not_found");
      if (method === "PUT" && !action) {
        const data = await readJson(request);
        const name = String(data.name || venue.name).trim();
        if (name.length < 2) return fail("Escribe un nombre válido para el lugar.");
        try {
          await db.prepare("UPDATE venues SET name=?,timezone=?,drive_root_folder_id=NULL,active=?,updated_at=? WHERE id=?")
            .bind(name, data.timezone || venue.timezone, data.active === false ? 0 : 1, nowIso(), id).run();
        } catch (error) { if (/UNIQUE/i.test(error.message)) return fail("Ese enlace corto ya está en uso.", 409, "venue_slug_taken"); throw error; }
        await log(db, "venue.updated", "venue", id);
        return json({ venue: await db.prepare("SELECT * FROM venues WHERE id=?").bind(id).first() });
      }
      if (method === "DELETE" || (method === "POST" && action === "deactivate")) {
        if (method === "DELETE") {
          const events = (await db.prepare("SELECT id,name FROM events WHERE venue_id=?").bind(id).all()).results || [];
          const stamp = nowIso();
          await db.batch([
            db.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,NULL,'admin','administrator','venue.deleted','venue',?,?,?)")
              .bind(newId(), id, JSON.stringify({ deletedEvents: events.length }), stamp),
            db.prepare("DELETE FROM prize_deliveries WHERE contest_id IN (SELECT c.id FROM contests c JOIN events e ON e.id=c.event_id WHERE e.venue_id=?)").bind(id),
            db.prepare("DELETE FROM events WHERE venue_id=?").bind(id),
            db.prepare("DELETE FROM venues WHERE id=?").bind(id),
          ]);
          return json({ ok: true, deletedEvents: events.length });
        }
        await db.prepare("UPDATE venues SET active=0,updated_at=? WHERE id=?").bind(nowIso(), id).run();
        await db.prepare("UPDATE events SET state='inactive',updated_at=? WHERE venue_id=? AND state='active'").bind(nowIso(), id).run();
        await log(db, "venue.deactivated", "venue", id);
        return json({ ok: true, active: false });
      }
    }

    if (path === "/api/admin/events" && method === "GET") {
      const venueId = new URL(request.url).searchParams.get("venueId");
      const events = venueId
        ? await db.prepare("SELECT e.*,v.name AS venue_name,v.slug AS venue_slug FROM events e JOIN venues v ON v.id=e.venue_id WHERE e.venue_id=? ORDER BY e.event_date DESC").bind(venueId).all()
        : await db.prepare("SELECT e.*,v.name AS venue_name,v.slug AS venue_slug FROM events e JOIN venues v ON v.id=e.venue_id ORDER BY e.event_date DESC").all();
      return json({ events: events.results || [] });
    }
    if (path === "/api/admin/events" && method === "POST") return await createEvent(request, env);
    if (path.startsWith("/api/admin/events/")) {
      const [id, ...actionParts] = routeId(path, "/api/admin/events/");
      const action = actionParts.join("/");
      const event = await eventOr404(db, id);
      if (method === "POST" && action === "assets") return await uploadEventAsset(request, env, event);
      if (method === "PUT" && !action) return await updateEvent(request, env, event);
      if (method === "DELETE") {
        const media = await db.prepare("SELECT r2_key FROM media_assets WHERE event_id=?").bind(id).all();
        for (const asset of media.results || []) {
          if (asset.r2_key.startsWith("drive:")) {
            if (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) await deleteDriveImage(env, asset.r2_key.slice(6));
          }
          else if (env.EVENT_MEDIA) await env.EVENT_MEDIA.delete(asset.r2_key);
        }
        const stamp = nowIso();
        await db.batch([
          db.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?,'admin','administrator','event.deleted','event',?,?,?)")
            .bind(newId(), id, id, JSON.stringify({ name: event.name }), stamp),
          db.prepare("DELETE FROM prize_deliveries WHERE contest_id IN (SELECT id FROM contests WHERE event_id=?)").bind(id),
          db.prepare("DELETE FROM events WHERE id=?").bind(id),
        ]);
        return json({ ok: true, deleted: true });
      }
      if (method === "POST" && action === "archive") {
        await db.prepare("UPDATE events SET state='inactive',updated_at=? WHERE id=?").bind(nowIso(), id).run();
        await log(db, "event.archived", "event", id, id);
        return json({ ok: true, state: "inactive" });
      }
      if (method === "POST" && action === "drive/retry") {
        await enqueueJob(db, id, "init_drive");
        const results = await processDueJobs(env, 5);
        const refreshed = await eventOr404(db, id);
        return json({ event: { id, driveStatus: refreshed.drive_status }, jobs: results });
      }
      if (method === "POST" && action === "staff-link/rotate") {
        const access = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
        await db.prepare("UPDATE events SET public_staff_slug=?,updated_at=? WHERE id=?").bind(access, nowIso(), id).run();
        await log(db, "event.staff_link_rotated", "event", id, id);
        return json({ staffUrl: new URL(request.url).origin + "/staff.html?access=" + access });
      }
      if (method === "GET" && action === "details") return json(await loadEventDetails(db, id));
    }

    if (path === "/api/admin/activities" && method === "POST") return await saveActivity(request, env, null);
    if (path === "/api/admin/activities/bulk-deactivate" && method === "POST") {
      const data = await readJson(request);
      const event = await eventOr404(db, String(data.eventId || ""));
      const activityIds = Array.isArray(data.activityIds) ? [...new Set(data.activityIds.map((id) => String(id || "")).filter(Boolean))] : [];
      if (!activityIds.length) return fail("Selecciona al menos una actividad.");
      if (activityIds.length > 200) return fail("Puedes quitar hasta 200 actividades a la vez.", 422, "too_many_activities");
      const placeholders = activityIds.map(() => "?").join(",");
      const rows = await db.prepare(`SELECT id FROM event_activities WHERE event_id=? AND active=1 AND id IN (${placeholders})`).bind(event.id, ...activityIds).all();
      const activeIds = (rows.results || []).map((row) => row.id);
      if (activeIds.length !== activityIds.length) return fail("Una o más actividades ya no están activas o no pertenecen a este evento. Actualiza la lista e inténtalo de nuevo.", 409, "activity_selection_stale");
      const activePlaceholders = activeIds.map(() => "?").join(",");
      const stamp = nowIso();
      const statements = [
        db.prepare(`UPDATE event_activities SET active=0,updated_at=? WHERE event_id=? AND active=1 AND id IN (${activePlaceholders})`).bind(stamp, event.id, ...activeIds),
        db.prepare(`UPDATE contests SET state='inactive',updated_at=? WHERE event_id=? AND kind='first_photo' AND state IN ('draft','active') AND id IN (SELECT ca.contest_id FROM contest_activities ca WHERE ca.activity_id IN (${activePlaceholders}) AND (SELECT COUNT(*) FROM contest_activities all_ca WHERE all_ca.contest_id=ca.contest_id)=1)`).bind(stamp, event.id, ...activeIds),
      ];
      for (const activityId of activeIds) statements.push(db.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?,'admin','administrator','activity.deactivated','activity',?,'{}',?)").bind(newId(), event.id, activityId, stamp));
      await db.batch(statements);
      const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM event_activities WHERE event_id=? AND active=1 AND id IN (${activePlaceholders})`).bind(event.id, ...activeIds).first();
      if (Number(remaining?.count || 0) !== 0) return fail("Cloudflare no confirmó que todas las actividades se quitaran. Actualiza la lista antes de continuar.", 500, "activity_deactivation_incomplete");
      return json({ ok: true, deactivatedCount: activeIds.length, activityIds: activeIds });
    }
    if (path.startsWith("/api/admin/activities/")) {
      const [id] = routeId(path, "/api/admin/activities/");
      const activity = await db.prepare("SELECT * FROM event_activities WHERE id=?").bind(id).first();
      if (!activity) return fail("No se encontró la actividad.", 404, "activity_not_found");
      if (method === "PUT") return await saveActivity(request, env, activity);
      if (method === "DELETE") {
        await db.prepare("UPDATE event_activities SET active=0,updated_at=? WHERE id=?").bind(nowIso(), id).run();
        await db.prepare(`UPDATE contests SET state='inactive',updated_at=? WHERE event_id=? AND kind='first_photo' AND state IN ('draft','active') AND id IN (SELECT ca.contest_id FROM contest_activities ca WHERE ca.activity_id=? AND (SELECT COUNT(*) FROM contest_activities all_ca WHERE all_ca.contest_id=ca.contest_id)=1)`).bind(nowIso(), activity.event_id, id).run();
        await log(db, "activity.deactivated", "activity", id, activity.event_id);
        return json({ ok: true });
      }
    }

    if (path === "/api/admin/guests" && method === "GET") {
      const eventId = new URL(request.url).searchParams.get("eventId");
      if (!eventId) return fail("Falta elegir un evento.");
      let rows;
      try { rows = await db.prepare(`SELECT g.id,g.event_id,g.name,g.nickname,t.name AS table_name,g.active,
        (SELECT COUNT(*) FROM photo_submissions p WHERE p.guest_id=g.id) AS photos_sent
        FROM event_guests g LEFT JOIN event_tables t ON t.id=g.table_id WHERE g.event_id=? ORDER BY g.name`).bind(eventId).all(); }
      catch (error) { if (!isMissingColumn(error, "nickname")) throw error; rows = await db.prepare(`SELECT g.id,g.event_id,g.name,NULL AS nickname,t.name AS table_name,g.active,
        (SELECT COUNT(*) FROM photo_submissions p WHERE p.guest_id=g.id) AS photos_sent
        FROM event_guests g LEFT JOIN event_tables t ON t.id=g.table_id WHERE g.event_id=? ORDER BY g.name`).bind(eventId).all(); }
      return json({ guests: rows.results || [] });
    }
    if (path === "/api/admin/guests" && method === "POST") return await createGuest(request, env);
    if (path.startsWith("/api/admin/guests/") && method === "DELETE") {
      const [id] = routeId(path, "/api/admin/guests/");
      await db.prepare("UPDATE event_guests SET active=0 WHERE id=?").bind(id).run();
      await log(db, "guest.deactivated", "guest", id);
      return json({ ok: true });
    }

    if (path === "/api/admin/contests" && method === "GET") {
      const eventId = new URL(request.url).searchParams.get("eventId");
      if (!eventId) return fail("Falta elegir un evento.");
      return json({ contests: (await db.prepare("SELECT c.*,p.name AS prize_name,p.instructions AS prize_instructions,(SELECT group_concat(activity_id, ',') FROM contest_activities ca WHERE ca.contest_id=c.id) AS activity_ids FROM contests c LEFT JOIN prizes p ON p.id=c.prize_id WHERE c.event_id=? ORDER BY c.opens_at").bind(eventId).all()).results || [] });
    }
    if (path === "/api/admin/contests" && method === "POST") return await createContest(request, env);
    if (path.startsWith("/api/admin/contests/") && method === "PUT") return await updateContest(request, env, routeId(path, "/api/admin/contests/")[0]);
    if (path.startsWith("/api/admin/contests/") && method === "POST") return await adminContestAction(request, env, routeId(path, "/api/admin/contests/"));

    if (path === "/api/admin/prizes" && method === "GET") {
      const eventId = new URL(request.url).searchParams.get("eventId");
      return json({ prizes: (await db.prepare("SELECT * FROM prizes WHERE event_id=? ORDER BY name").bind(eventId).all()).results || [] });
    }
    if (path === "/api/admin/prizes" && method === "POST") return await createPrize(request, env);

    if (path === "/api/admin/integrations" && method === "GET") {
      const rows = await db.prepare(`SELECT e.id,e.name,e.drive_status,e.drive_folder_id,e.drive_folder_url,e.dedications_sheet_id,
        (SELECT COUNT(*) FROM integration_jobs j WHERE j.event_id=e.id AND j.state IN ('pending','retry','dead')) AS pending_jobs
        FROM events e ORDER BY e.updated_at DESC`).all();
      return json({ integrations: rows.results || [], googleConfigured: Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) });
    }
    if (path === "/api/admin/jobs/retry" && method === "POST") return json({ results: await processDueJobs(env, 50) });

    return fail("No existe esa operación administrativa.", 404, "route_not_found");
  } catch (error) { return apiError(error); }
}

async function uploadEventAsset(request, env, event) {
  const db = env.DB;
  let form;
  try { form = await request.formData(); } catch { return fail("No se pudo leer la imagen seleccionada."); }
  const file = form.get("file");
  const kind = String(form.get("kind") || "");
  if (!(file instanceof File) || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || !file.size) return fail("Elige una imagen JPG, PNG o WebP.");
  if (file.size > 10 * 1024 * 1024) return fail("La imagen debe pesar menos de 10 MB.", 413, "image_too_large");
  const activityId = String(form.get("activityId") || "");
  if (kind === "activity_reference" && !await db.prepare("SELECT id FROM event_activities WHERE id=? AND event_id=?").bind(activityId, event.id).first()) return fail("La actividad no pertenece a este evento.", 422, "activity_event_mismatch");
  if (!["event_cover", "activity_reference"].includes(kind)) return fail("Selecciona el tipo de imagen.");
  const id = newId();
  const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" })[file.type];
  let key; const provider = "r2";
  if (!env.EVENT_MEDIA) return fail("El almacenamiento R2 de imágenes de portada y actividades aún no está conectado.", 503, "event_media_unavailable");
  key = `events/${event.id}/${id}.${extension}`;
  await env.EVENT_MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  try {
    await db.prepare("INSERT INTO media_assets (id,event_id,kind,r2_key,content_type,byte_size,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(id, event.id, kind, key, file.type, file.size, nowIso()).run();
    if (kind === "event_cover") await db.prepare("UPDATE events SET cover_asset_id=?,updated_at=? WHERE id=?").bind(id, nowIso(), event.id).run();
    else await db.prepare("UPDATE event_activities SET reference_asset_id=?,updated_at=? WHERE id=? AND event_id=?").bind(id, nowIso(), activityId, event.id).run();
  } catch (error) { if (provider === "drive") await deleteDriveImage(env, key.slice(6)); else await env.EVENT_MEDIA.delete(key); throw error; }
  return json({ asset: { id, kind, url: "/api/media/" + id, storage: provider } }, 201);
}
async function createEvent(request, env) {
  const db = env.DB;
  const data = await readJson(request);
  const venue = await db.prepare("SELECT * FROM venues WHERE id=? AND active=1").bind(data.venueId).first();
  if (!venue) return fail("Selecciona un lugar activo.", 422, "venue_required");
  const name = String(data.name || "").trim();
  const eventDate = String(data.eventDate || "");
  const slug = slugify(data.slug || name);
  if (name.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !slug) return fail("Revisa nombre, URL corta y fecha.");
  const state = data.state === "active" ? "active" : "draft";
  if (state === "active") {
    const conflict = await db.prepare("SELECT id FROM events WHERE venue_id=? AND event_date=? AND state='active'").bind(venue.id, eventDate).first();
    if (conflict) return fail("Ese lugar ya tiene una boda activa en esa fecha.", 409, "event_date_conflict");
  }
  const folderId = driveIdFromUrl(data.driveFolderUrl);
  if (!folderId) return fail("Agrega una carpeta de Google Drive válida asignada a esta boda.", 422, "drive_folder_required");
  if (folderId && await db.prepare("SELECT id FROM events WHERE drive_folder_id=?").bind(folderId).first()) return fail("Esta carpeta de Drive ya está vinculada a otro evento.", 409, "drive_folder_already_used");
  const id = newId();
  const staffSlug = crypto.randomUUID().replaceAll("-", "");
  const time = nowIso();
  try {
    await db.prepare(`INSERT INTO events (id,venue_id,name,slug,event_date,timezone,state,drive_folder_url,drive_folder_id,drive_status,contests_enabled,public_staff_slug,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, venue.id, name, slug, eventDate, venue.timezone || "America/Mexico_City", state, data.driveFolderUrl || null, folderId || null, folderId || venue.drive_root_folder_id ? "pending" : "not_configured", data.contestsEnabled === false ? 0 : 1, staffSlug, time, time).run();
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) return fail("La URL corta o la reserva de lugar y fecha ya está en uso.", 409, "event_conflict");
    if (/venue_inactive/.test(error.message)) return fail("Activa el lugar antes de activar el evento.", 409, "venue_inactive");
    throw error;
  }
  if (folderId || venue.drive_root_folder_id) await enqueueJob(db, id, "init_drive");
  await log(db, "event.created", "event", id, id, { venueId: venue.id, eventDate, state });
  return json({ event: await db.prepare("SELECT * FROM events WHERE id=?").bind(id).first(), driveStatus: folderId ? "pending" : "not_configured" }, 201);
}

async function updateEvent(request, env, event) {
  const db = env.DB;
  const data = await readJson(request);
  const venueId = data.venueId || event.venue_id;
  const venue = await db.prepare("SELECT * FROM venues WHERE id=?").bind(venueId).first();
  if (!venue) return fail("No se encontró el lugar.", 404, "venue_not_found");
  const name = String(data.name || event.name).trim();
  const eventDate = String(data.eventDate || event.event_date);
  const slug = slugify(data.slug || event.slug || name);
  const state = ["draft", "active", "inactive", "finished"].includes(data.state) ? data.state : event.state;
  const folderUrl = Object.hasOwn(data, "driveFolderUrl") ? (String(data.driveFolderUrl || "").trim() || null) : event.drive_folder_url;
  const folderId = folderUrl ? driveIdFromUrl(folderUrl) : null;
  if (folderUrl && !folderId) return fail("El enlace de Drive no parece ser una carpeta válida.");
  if (!folderId) return fail("Cada evento debe conservar su carpeta de Google Drive.", 422, "drive_folder_required");
  if (folderId && folderId !== event.drive_folder_id && await db.prepare("SELECT id FROM events WHERE drive_folder_id=? AND id<>?").bind(folderId, event.id).first()) return fail("Esta carpeta ya está asociada a otra boda.", 409, "drive_folder_already_used");
  if (folderId !== event.drive_folder_id) {
    const assets = await db.prepare("SELECT COUNT(*) AS count FROM storage_folders WHERE event_id=?").bind(event.id).first();
    if (Number(assets?.count || 0) && folderId) return fail("Este evento ya tiene carpetas en Drive. Conserva esa carpeta o migra el evento con el soporte del administrador.", 409, "drive_root_locked");
  }
  try {
    await db.prepare(`UPDATE events SET venue_id=?,name=?,slug=?,event_date=?,timezone=?,state=?,drive_folder_url=?,drive_folder_id=?,
      drive_status=?,contests_enabled=?,updated_at=? WHERE id=?`)
      .bind(venue.id, name, slug, eventDate, venue.timezone, state, folderUrl, folderId, folderId ? (folderId === event.drive_folder_id ? event.drive_status : "pending") : "not_configured", data.contestsEnabled === false ? 0 : data.contestsEnabled === true ? 1 : event.contests_enabled, nowIso(), event.id).run();
  } catch (error) {
    if (/UNIQUE/i.test(error.message)) return fail("La URL o el lugar ya tienen un evento activo en esa fecha.", 409, "event_conflict");
    if (/venue_inactive/.test(error.message)) return fail("Activa el lugar antes de activar el evento.", 409, "venue_inactive");
    throw error;
  }
  if (folderId && (folderId !== event.drive_folder_id || event.drive_status !== "ready")) await enqueueJob(db, event.id, "init_drive");
  await log(db, "event.updated", "event", event.id, event.id);
  return json({ event: await db.prepare("SELECT * FROM events WHERE id=?").bind(event.id).first() });
}

async function saveActivity(request, env, existing) {
  const db = env.DB;
  const data = await readJson(request);
  const event = await eventOr404(db, data.eventId || existing?.event_id);
  const name = String(data.name || existing?.name || "").trim();
  const description = String(data.description || existing?.description || "").trim().slice(0, 1000);
  let position = Number(existing?.position || 1);
  if (name.length < 2) return fail("Escribe el nombre de la actividad.");
  const startsAt = data.startsAt?.includes("Z") || /[+-]\d\d:\d\d$/.test(data.startsAt || "") ? new Date(data.startsAt).toISOString() : localDateTimeToIso(data.startsAt, event.timezone);
  const endsAt = data.endsAt?.includes("Z") || /[+-]\d\d:\d\d$/.test(data.endsAt || "") ? new Date(data.endsAt).toISOString() : localDateTimeToIso(data.endsAt, event.timezone);
  if (!Number.isFinite(Date.parse(startsAt)) || Date.parse(startsAt) >= Date.parse(endsAt)) return fail("La finalización debe ser posterior al inicio.");
  const window = { startsAt, endsAt, photoOpensAt: new Date(Date.parse(startsAt) - 5 * 60000).toISOString(), photoClosesAt: new Date(Date.parse(endsAt) - 5 * 60000).toISOString() };
  const overlap = await db.prepare(`SELECT id,name FROM event_activities WHERE event_id=? AND active=1 AND id<>? AND starts_at<? AND ends_at>? LIMIT 1`)
    .bind(event.id, existing?.id || "", endsAt, startsAt).first();
  if (overlap) return fail("El horario se cruza con «" + overlap.name + ". Ajusta el cronograma para evitar dos momentos activos a la vez.", 409, "activity_overlap");
  if (!existing) {
    const lastPosition = await db.prepare("SELECT COALESCE(MAX(position),0) AS max_position FROM event_activities WHERE event_id=?").bind(event.id).first();
    position = Number(lastPosition?.max_position || 0) + 1;
  }
  const id = existing?.id || newId();
  const time = nowIso();
  if (existing) {
    try { await db.prepare(`UPDATE event_activities SET name=?,description=?,position=?,starts_at=?,ends_at=?,photo_opens_at=?,photo_closes_at=?,active=?,updated_at=? WHERE id=? AND event_id=?`)
      .bind(name, description, position, window.startsAt, window.endsAt, window.photoOpensAt, window.photoClosesAt, data.active === false ? 0 : 1, time, id, event.id).run(); }
    catch (error) { if (!isMissingColumn(error, "description")) throw error; await db.prepare(`UPDATE event_activities SET name=?,position=?,starts_at=?,ends_at=?,photo_opens_at=?,photo_closes_at=?,active=?,updated_at=? WHERE id=? AND event_id=?`).bind(name, position, window.startsAt, window.endsAt, window.photoOpensAt, window.photoClosesAt, data.active === false ? 0 : 1, time, id, event.id).run(); }
  } else {
    try { await db.prepare(`INSERT INTO event_activities (id,event_id,name,description,position,starts_at,ends_at,photo_opens_at,photo_closes_at,active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`).bind(id, event.id, name, description, position, window.startsAt, window.endsAt, window.photoOpensAt, window.photoClosesAt, time, time).run(); }
    catch (error) { if (!isMissingColumn(error, "description")) throw error; await db.prepare(`INSERT INTO event_activities (id,event_id,name,position,starts_at,ends_at,photo_opens_at,photo_closes_at,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)`).bind(id, event.id, name, position, window.startsAt, window.endsAt, window.photoOpensAt, window.photoClosesAt, time, time).run(); }
  }
  if (event.drive_folder_id) await enqueueJob(db, event.id, "init_drive");
  await log(db, existing ? "activity.updated" : "activity.created", "activity", id, event.id);
  return json({ activity: await db.prepare("SELECT * FROM event_activities WHERE id=?").bind(id).first() }, existing ? 200 : 201);
}

async function createGuest(request, env) {
  const db = env.DB;
  const data = await readJson(request);
  const event = await eventOr404(db, data.eventId);
  const firstName = String(data.firstName || "").trim();
  const lastName = String(data.lastName || "").trim();
  const name = [firstName, lastName].filter(Boolean).join(" ") || String(data.name || "").trim();
  const nickname = String(data.nickname || "").trim() || null;
  if (name.length < 2) return fail("Escribe el nombre del invitado.");
  let tableId = null;
  const tableName = String(data.tableName || "").trim();
  if (tableName) {
    const found = await db.prepare("SELECT id FROM event_tables WHERE event_id=? AND name=?").bind(event.id, tableName).first();
    tableId = found?.id || newId();
    if (!found) await db.prepare("INSERT INTO event_tables (id,event_id,name,position) VALUES (?,?,?,0)").bind(tableId, event.id, tableName).run();
  }
  const id = newId();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode((env.SESSION_PEPPER || "") + ":unused:" + crypto.randomUUID()));
  const hashHex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  try {
    try {
      await db.prepare("INSERT INTO event_guests (id,event_id,name,name_key,invitation_code_hash,table_id,nickname,active,created_at) VALUES (?,?,?,?,?,?,?,1,?)")
        .bind(id, event.id, name, name.toLocaleLowerCase("es-MX").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim(), hashHex, tableId, nickname, nowIso()).run();
    } catch (error) {
      if (!isMissingColumn(error, "nickname")) throw error;
      await db.prepare("INSERT INTO event_guests (id,event_id,name,name_key,invitation_code_hash,table_id,active,created_at) VALUES (?,?,?,?,?,?,1,?)")
        .bind(id, event.id, name, name.toLocaleLowerCase("es-MX").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim(), hashHex, tableId, nowIso()).run();
    }
  } catch (error) { if (/UNIQUE/i.test(error.message)) return fail("Ese código ya está asignado a otra invitación.", 409, "invitation_code_used"); throw error; }
  await log(db, "guest.created", "guest", id, event.id);
  return json({ guest: { id, eventId: event.id, name, nickname, tableName: tableName || null } }, 201);
}

async function createPrize(request, env) {
  const db = env.DB;
  const data = await readJson(request);
  const event = await eventOr404(db, data.eventId);
  const name = String(data.name || "").trim();
  if (!name) return fail("Escribe el nombre del premio.");
  const id = newId();
  await db.prepare("INSERT INTO prizes (id,event_id,name,instructions,enabled,created_at) VALUES (?,?,?,?,1,?)").bind(id, event.id, name, String(data.instructions || "").trim(), nowIso()).run();
  await log(db, "prize.created", "prize", id, event.id);
  return json({ prize: await db.prepare("SELECT * FROM prizes WHERE id=?").bind(id).first() }, 201);
}

function contestTimestamp(value, timezone) {
  const source = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(source)) return localDateTimeToIso(source, timezone);
  return new Date(source).toISOString();
}

async function createContest(request, env) {
  const db = env.DB;
  const data = await readJson(request);
  const event = await eventOr404(db, data.eventId);
  if (!event.contests_enabled) return fail("Los concursos están deshabilitados para este evento.", 409, "contests_disabled");
  if (!KINDS.has(data.kind)) return fail("Elige un tipo de concurso válido.");
  const name = String(data.name || "").trim();
  const opensAt = contestTimestamp(data.opensAt, event.timezone);
  const closesAt = contestTimestamp(data.closesAt, event.timezone);
  if (!name || Date.parse(opensAt) >= Date.parse(closesAt)) return fail("Revisa el nombre y las horas del concurso.");
  const activityIds = Array.isArray(data.activityIds) ? data.activityIds : [];
  for (const activityId of activityIds) {
    const activity = await db.prepare("SELECT id FROM event_activities WHERE id=? AND event_id=? AND active=1").bind(activityId, event.id).first();
    if (!activity) return fail("Una actividad pertenece a otro evento o ya no está activa.", 422, "activity_event_mismatch");
  }
  if (data.prizeId && !await db.prepare("SELECT id FROM prizes WHERE id=? AND event_id=? AND enabled=1").bind(data.prizeId, event.id).first()) return fail("El premio no pertenece a este evento.", 422, "prize_event_mismatch");
  const id = newId();
  const stamp = nowIso();
  const state = data.state === "active" ? "active" : "draft";
  await db.prepare(`INSERT INTO contests (id,event_id,name,kind,rule_json,opens_at,closes_at,state,prize_id,validation_instructions,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, event.id, name, data.kind, JSON.stringify(data.rules || {}), opensAt, closesAt, state, data.prizeId || null, String(data.validationInstructions || "").trim(), stamp, stamp).run();
  for (const activityId of activityIds) await db.prepare("INSERT INTO contest_activities (contest_id,activity_id) VALUES (?,?)").bind(id, activityId).run();
  await log(db, "contest.created", "contest", id, event.id, { kind: data.kind });
  return json({ contest: await db.prepare("SELECT * FROM contests WHERE id=?").bind(id).first() }, 201);
}

async function updateContest(request, env, id) {
  const db = env.DB;
  const existing = await db.prepare("SELECT * FROM contests WHERE id=?").bind(id).first();
  if (!existing) return fail("No se encontró el reto.", 404, "contest_not_found");
  if (existing.state === "finished") return fail("Un reto finalizado no se puede modificar.", 409, "contest_finished");
  const event = await eventOr404(db, existing.event_id);
  const data = await readJson(request);
  const name = String(data.name || "").trim();
  if (!name || !KINDS.has(data.kind)) return fail("Revisa el nombre y el tipo de reto.");
  const opensAt = contestTimestamp(data.opensAt, event.timezone);
  const closesAt = contestTimestamp(data.closesAt, event.timezone);
  if (Date.parse(opensAt) >= Date.parse(closesAt)) return fail("Revisa las horas del reto.");
  const activityIds = Array.isArray(data.activityIds) ? data.activityIds : [];
  for (const activityId of activityIds) {
    if (!await db.prepare("SELECT id FROM event_activities WHERE id=? AND event_id=? AND active=1").bind(activityId, existing.event_id).first()) return fail("La actividad no pertenece a este evento.", 422, "activity_event_mismatch");
  }
  if (data.prizeId && !await db.prepare("SELECT id FROM prizes WHERE id=? AND event_id=? AND enabled=1").bind(data.prizeId, existing.event_id).first()) return fail("El premio no pertenece a este evento.", 422, "prize_event_mismatch");
  const stamp = nowIso();
  await db.prepare("UPDATE contests SET name=?,kind=?,rule_json=?,opens_at=?,closes_at=?,prize_id=?,validation_instructions=?,updated_at=? WHERE id=?")
    .bind(name, data.kind, JSON.stringify(data.rules || {}), opensAt, closesAt, data.prizeId || null, String(data.validationInstructions || "").trim(), stamp, id).run();
  await db.prepare("DELETE FROM contest_activities WHERE contest_id=?").bind(id).run();
  for (const activityId of activityIds) await db.prepare("INSERT INTO contest_activities (contest_id,activity_id) VALUES (?,?)").bind(id, activityId).run();
  if (existing.prize_id && existing.prize_id !== data.prizeId) await db.prepare("UPDATE prizes SET enabled=0 WHERE id=?").bind(existing.prize_id).run();
  await log(db, "contest.updated", "contest", id, existing.event_id);
  return json({ contest: await db.prepare("SELECT * FROM contests WHERE id=?").bind(id).first() });
}

async function adminContestAction(request, env, [id, action]) {
  const db = env.DB;
  const contest = await db.prepare("SELECT * FROM contests WHERE id=?").bind(id).first();
  if (!contest) return fail("No se encontró el concurso.", 404, "contest_not_found");
  const data = request.method === "POST" ? await readJson(request) : {};
  if (action === "close") {
    await db.prepare("UPDATE contests SET state='finished',closes_at=CASE WHEN closes_at>? THEN ? ELSE closes_at END,updated_at=? WHERE id=?")
      .bind(nowIso(), nowIso(), nowIso(), id).run();
    await log(db, "contest.closed", "contest", id, contest.event_id);
    return json({ ok: true });
  }
  if (action === "winner") {
    const guest = await db.prepare("SELECT id FROM event_guests WHERE id=? AND event_id=? AND active=1").bind(data.guestId, contest.event_id).first();
    if (!guest) return fail("El invitado no pertenece a este evento.", 422, "guest_event_mismatch");
    if (["first_photo", "most_photos"].includes(contest.kind)) {
      const result = await calculateAutomaticWinner(db, contest);
      if (!result || result.guest_id !== guest.id) return fail("El invitado no coincide con el resultado calculado.", 409, "winner_rule_mismatch");
    }
    await db.prepare("UPDATE contests SET winner_guest_id=?,winner_confirmed_at=?,winner_confirmed_by='administrator',state='finished',updated_at=? WHERE id=?")
      .bind(guest.id, nowIso(), nowIso(), id).run();
    if (contest.prize_id) {
      const existing = await db.prepare("SELECT id FROM prize_deliveries WHERE contest_id=?").bind(id).first();
      if (existing) await db.prepare("UPDATE prize_deliveries SET guest_id=? WHERE contest_id=? AND delivered_at IS NULL").bind(guest.id, id).run();
      else await db.prepare("INSERT INTO prize_deliveries (id,contest_id,prize_id,guest_id,created_at) VALUES (?,?,?,?,?)").bind(newId(), id, contest.prize_id, guest.id, nowIso()).run();
    }
    await log(db, "contest.winner_confirmed", "contest", id, contest.event_id, { guestId: guest.id });
    return json({ ok: true, winnerGuestId: guest.id });
  }
  return fail("Acción del concurso no reconocida.", 404, "contest_action_missing");
}

export async function calculateAutomaticWinner(db, contest) {
  const activities = await db.prepare("SELECT activity_id FROM contest_activities WHERE contest_id=?").bind(contest.id).all();
  const ids = (activities.results || []).map((row) => row.activity_id);
  if (contest.kind === "most_photos" && !ids.length) return null;
  let rules = {}; try { rules = JSON.parse(contest.rule_json || "{}"); } catch {}
  const eventWideFirstPhoto = contest.kind === "first_photo" && rules.scope === "event";
  let query = `SELECT id,guest_id,activity_id,received_at,eligible,storage_state FROM photo_submissions WHERE event_id=? AND storage_state='stored' AND received_at>=? AND received_at<?`;
  if (!eventWideFirstPhoto) query += " AND eligible=1";
  const params = [contest.event_id, contest.opens_at, contest.closes_at];
  if (ids.length) { query += " AND activity_id IN (" + ids.map(() => "?").join(",") + ")"; params.push(...ids); }
  const submissions = await db.prepare(query).bind(...params).all();
  const rows = submissions.results || [];
  if (contest.kind === "first_photo") return rows.sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at) || a.id.localeCompare(b.id))[0] || null;
  if (contest.kind !== "most_photos") return null;
  const counts = new Map();
  rows.forEach((row) => {
    const state = counts.get(row.guest_id) || { guest_id: row.guest_id, count: 0, reached_at: row.received_at };
    state.count++;
    if (Date.parse(row.received_at) > Date.parse(state.reached_at)) state.reached_at = row.received_at;
    counts.set(row.guest_id, state);
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || Date.parse(a.reached_at) - Date.parse(b.reached_at) || a.guest_id.localeCompare(b.guest_id))[0] || null;
}

async function loadEventDetails(db, eventId) {
  const event = await eventOr404(db, eventId);
  const venue = await db.prepare("SELECT id,name,slug,timezone,active FROM venues WHERE id=?").bind(event.venue_id).first();
  const activities = await db.prepare("SELECT * FROM event_activities WHERE event_id=? AND active=1 ORDER BY position,starts_at").bind(eventId).all();
  let guests;
  try { guests = await db.prepare(`SELECT g.id,g.name,g.nickname,t.name AS table_name,g.active FROM event_guests g LEFT JOIN event_tables t ON t.id=g.table_id WHERE g.event_id=? ORDER BY g.name`).bind(eventId).all(); }
  catch (error) { if (!isMissingColumn(error, "nickname")) throw error; guests = await db.prepare(`SELECT g.id,g.name,NULL AS nickname,t.name AS table_name,g.active FROM event_guests g LEFT JOIN event_tables t ON t.id=g.table_id WHERE g.event_id=? ORDER BY g.name`).bind(eventId).all(); }
  const contests = await db.prepare("SELECT c.*,(SELECT group_concat(activity_id, ',') FROM contest_activities ca WHERE ca.contest_id=c.id) AS activity_ids FROM contests c WHERE c.event_id=? ORDER BY c.opens_at").bind(eventId).all();
  const prizes = await db.prepare("SELECT * FROM prizes WHERE event_id=? ORDER BY name").bind(eventId).all();
  return { event, venue, activities: activities.results || [], guests: guests.results || [], contests: contests.results || [], prizes: prizes.results || [] };
}

export async function ensureEventFoldersNow(env, eventId) {
  const event = await env.DB.prepare("SELECT * FROM events WHERE id=?").bind(eventId).first();
  if (!event) throw new Error("No se encontró el evento.");
  return ensureEventDriveStructure(env, env.DB, event);
}
