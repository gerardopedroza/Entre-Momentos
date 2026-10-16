import { ensureEventDriveStructure, syncDedicationToSheet } from "./google-drive.js";
import { nowIso } from "./core.js";

export async function enqueueJob(db, eventId, type, dedicationId = null) {
  const existing = await db.prepare("SELECT id FROM integration_jobs WHERE event_id=? AND type=? AND ((dedication_id IS NULL AND ? IS NULL) OR dedication_id=?) AND state IN ('pending','retry','running')")
    .bind(eventId, type, dedicationId, dedicationId).first();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO integration_jobs (id,event_id,dedication_id,type,state,attempts,next_attempt_at,created_at,updated_at)
    VALUES (?,?,?,?,'pending',0,?,?,?)`)
    .bind(id, eventId, dedicationId, type, nowIso(), nowIso(), nowIso()).run();
  return id;
}

export async function processDueJobs(env, limit = 20) {
  if (!env.DB) throw new Error("No existe el enlace a D1.");
  const due = await env.DB.prepare("SELECT id FROM integration_jobs WHERE state IN ('pending','retry') AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT ?")
    .bind(nowIso(), limit).all();
  const results = [];
  for (const { id } of due.results || []) results.push(await processOneJob(env, id));
  return results;
}

export async function processOneJob(env, jobId) {
  const db = env.DB;
  const claim = await db.prepare(`UPDATE integration_jobs SET state='running', attempts=attempts+1, updated_at=?
    WHERE id=? AND state IN ('pending','retry')`).bind(nowIso(), jobId).run();
  if (!claim.meta?.changes) return { id: jobId, state: "already_claimed" };
  const job = await db.prepare("SELECT * FROM integration_jobs WHERE id=?").bind(jobId).first();
  try {
    if (job.type === "init_drive") {
      const event = await db.prepare("SELECT * FROM events WHERE id=?").bind(job.event_id).first();
      await ensureEventDriveStructure(env, db, event);
    } else if (job.type === "sync_dedication") {
      const row = await db.prepare(`SELECT d.*,g.name AS guest_name,e.dedications_sheet_id
        FROM dedications d JOIN event_guests g ON g.id=d.guest_id JOIN events e ON e.id=d.event_id WHERE d.id=?`).bind(job.dedication_id).first();
      if (!row) throw Object.assign(new Error("No se encontró la dedicatoria."), { code: "dedication_missing" });
      if (!row.dedications_sheet_id) throw Object.assign(new Error("La hoja de dedicatorias aún no está conectada."), { code: "sheet_not_configured" });
      await syncDedicationToSheet(env, row.dedications_sheet_id, row);
      await db.prepare("UPDATE dedications SET sheet_state='synced' WHERE id=?").bind(row.id).run();
    } else throw Object.assign(new Error("Tipo de trabajo no reconocido."), { code: "job_type_unknown" });
    await db.prepare("UPDATE integration_jobs SET state='done',last_error_code=NULL,updated_at=? WHERE id=?").bind(nowIso(), jobId).run();
    return { id: jobId, state: "done" };
  } catch (error) {
    const attempts = Number(job.attempts || 0);
    const terminal = attempts >= 8;
    const backoffMinutes = Math.min(360, 2 ** Math.min(attempts, 8));
    const next = new Date(Date.now() + backoffMinutes * 60000).toISOString();
    await db.prepare("UPDATE integration_jobs SET state=?,next_attempt_at=?,last_error_code=?,updated_at=? WHERE id=?")
      .bind(terminal ? "dead" : "retry", next, String(error.code || "integration_error").slice(0, 80), nowIso(), jobId).run();
    if (job.type === "init_drive") await db.prepare("UPDATE events SET drive_status='error' WHERE id=?").bind(job.event_id).run();
    if (job.type === "sync_dedication") await db.prepare("UPDATE dedications SET sheet_state='error' WHERE id=?").bind(job.dedication_id).run();
    return { id: jobId, state: terminal ? "dead" : "retry", errorCode: String(error.code || "integration_error"), nextAttemptAt: next };
  }
}
