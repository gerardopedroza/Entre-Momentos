import { fail, getEventDateLocal, json, newId, nowIso, readJson } from "./core.js";
import { calculateAutomaticWinner } from "./admin-api.js";

export async function handleStaffApi(ctx, path) {
  const { request, env } = ctx;
  const db = env.DB;
  const url = new URL(request.url);
  const access = url.searchParams.get("access") || "";
  async function authorizedEvent(eventId = url.searchParams.get("eventId")) {
    if (!access || !eventId) return null;
    return db.prepare("SELECT id,venue_id FROM events WHERE id=? AND public_staff_slug=? AND state='active'").bind(eventId, access).first();
  }
  if (path === "/api/staff/events" && request.method === "GET") {
    const tokenEvent = await db.prepare("SELECT id,venue_id,name,slug,event_date FROM events WHERE public_staff_slug=? AND state='active'").bind(access).first();
    if (!tokenEvent) return fail("El enlace de STAFF no es válido o ya fue renovado.", 401, "staff_link_invalid");
    return json({ events: [tokenEvent] });
  }
  if (path === "/api/staff/current" && request.method === "GET") {
    const eventId = url.searchParams.get("eventId");
    if (!await authorizedEvent(eventId)) return fail("El enlace de STAFF no corresponde a este evento.", 401, "staff_link_invalid");
    const event = await db.prepare("SELECT e.*,v.name AS venue_name,v.timezone AS venue_timezone FROM events e JOIN venues v ON v.id=e.venue_id WHERE e.id=? AND e.state='active' AND v.active=1")
      .bind(eventId).first();
    if (!event || event.event_date !== getEventDateLocal(new Date(), event.venue_timezone)) return fail("No hay un evento activo en ese lugar en este momento.", 404, "event_unavailable");
    const contests = await db.prepare(`SELECT c.*,p.name AS prize_name,p.instructions AS prize_instructions
      FROM contests c LEFT JOIN prizes p ON p.id=c.prize_id WHERE c.event_id=? ORDER BY c.opens_at`).bind(event.id).all();
    const board = [];
    for (const contest of contests.results || []) {
      const now = Date.now();
      const state = contest.state === "inactive" || contest.state === "draft" ? contest.state
        : now < Date.parse(contest.opens_at) ? "upcoming" : now < Date.parse(contest.closes_at) ? "active" : "closed";
      let winner = contest.winner_guest_id
        ? await guestDetails(db, contest.winner_guest_id, event.id)
        : null;
      let leader = null;
      let entries = [];
      if (["first_photo", "most_photos"].includes(contest.kind)) {
        const calculated = await calculateAutomaticWinner(db, contest);
        if (calculated) {
          leader = await guestDetails(db, calculated.guest_id, event.id);
          leader.count = calculated.count || 1;
          leader.reachedAt = calculated.reached_at || calculated.received_at;
        }
      }
      if (["photo_with_couple", "bouquet", "manual"].includes(contest.kind)) {
        const result = await db.prepare(`SELECT g.id AS guest_id,g.name,t.name AS table_name,MIN(ps.received_at) AS reached_at,COUNT(ps.id) AS count
          FROM photo_submissions ps JOIN event_guests g ON g.id=ps.guest_id LEFT JOIN event_tables t ON t.id=g.table_id
          JOIN contest_activities ca ON ca.activity_id=ps.activity_id
          WHERE ca.contest_id=? AND ps.eligible=1 GROUP BY g.id ORDER BY reached_at LIMIT 50`).bind(contest.id).all();
        entries = result.results || [];
      }
      board.push({
        id: contest.id, name: contest.name, kind: contest.kind, state, opensAt: contest.opens_at, closesAt: contest.closes_at,
        instructions: contest.validation_instructions || "", prize: contest.prize_name ? { name: contest.prize_name, instructions: contest.prize_instructions || "" } : null,
        winner, leader, entries, calculated: ["first_photo", "most_photos"].includes(contest.kind),
        delivery: contest.winner_guest_id && contest.prize_id ? await db.prepare("SELECT delivered_at,staff_name FROM prize_deliveries WHERE contest_id=?").bind(contest.id).first() : null,
      });
    }
    return json({ event: { id: event.id, name: event.name, venueName: event.venue_name, eventDate: event.event_date }, contests: board, serverTime: nowIso() });
  }
  if (path === "/api/staff/deliveries" && request.method === "POST") return registerDelivery(request, env, access);
  return null;
}

async function guestDetails(db, guestId, eventId) {
  return db.prepare(`SELECT g.id,g.name,t.name AS table_name FROM event_guests g
    LEFT JOIN event_tables t ON t.id=g.table_id WHERE g.id=? AND g.event_id=? AND g.active=1`).bind(guestId, eventId).first();
}

async function registerDelivery(request, env, access) {
  const data = await readJson(request, 4096);
  const staffName = String(data.staffName || "").trim().slice(0, 80);
  if (!staffName) return fail("Escribe tu nombre para registrar la entrega.");
  const contest = await env.DB.prepare(`SELECT c.id,c.event_id,c.prize_id,c.winner_guest_id,c.state FROM contests c WHERE c.id=?`).bind(data.contestId).first();
  if (!contest || contest.event_id !== data.eventId || !contest.prize_id || !contest.winner_guest_id || contest.state !== "finished") return fail("Este concurso no tiene un premio confirmado para entregar.", 409, "prize_not_ready");
  const tokenEvent = await env.DB.prepare("SELECT id FROM events WHERE id=? AND public_staff_slug=? AND state='active'").bind(contest.event_id, access).first();
  if (!tokenEvent) return fail("El enlace de STAFF no corresponde a este evento.", 401, "staff_link_invalid");
  const current = await env.DB.prepare("SELECT delivered_at FROM prize_deliveries WHERE contest_id=? AND prize_id=? AND guest_id=?").bind(contest.id, contest.prize_id, contest.winner_guest_id).first();
  if (!current) return fail("No encontramos el premio de este ganador.", 404, "prize_delivery_not_found");
  if (current.delivered_at) return fail("Esta entrega ya quedó registrada.", 409, "prize_already_delivered");
  const deliveredAt = nowIso();
  const result = await env.DB.prepare("UPDATE prize_deliveries SET delivered_at=?,staff_name=? WHERE contest_id=? AND delivered_at IS NULL")
    .bind(deliveredAt, staffName, contest.id).run();
  if (!result.meta?.changes) return fail("La entrega ya fue registrada por otra persona.", 409, "prize_already_delivered");
  await env.DB.prepare("INSERT INTO audit_log (id,event_id,actor_type,actor_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,?, 'staff', ?, 'prize.delivered','contest',?,?,?)")
    .bind(newId(), contest.event_id, staffName, contest.id, JSON.stringify({ guestId: contest.winner_guest_id, prizeId: contest.prize_id }), deliveredAt).run();
  return json({ delivered: true, deliveredAt, staffName });
}
