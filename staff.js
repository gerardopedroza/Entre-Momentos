const access = new URLSearchParams(location.search).get("access") || "";
const root = document.querySelector("#staff-content");
const feedback = document.querySelector("#staff-feedback");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || "No se pudo cargar el panel.");
  return result;
}
async function load() {
  if (!access) throw new Error("Pide al administrador el enlace STAFF específico de este evento.");
  const { events = [] } = await api(`/api/staff/events?access=${encodeURIComponent(access)}`);
  if (!events.length) throw new Error("Este enlace no tiene un evento activo asignado.");
  const event = events[0];
  const data = await api(`/api/staff/current?eventId=${encodeURIComponent(event.id)}&access=${encodeURIComponent(access)}`);
  render(data);
}
function render(data) {
  root.innerHTML = `<h1>${esc(data.event.name)}</h1><p>${esc(data.event.venueName)} · ${esc(data.event.eventDate)}</p><div class="staff-status">Estado del evento: ${data.contests.some(c => c.state === "active") ? "Hay dinámicas en curso" : "Consulta la agenda y los resultados"}</div>${(data.contests || []).map(contest => `
    <article class="contest"><h2>${esc(contest.name)}</h2><p>${contest.state === "upcoming" ? "Próximamente" : contest.state === "active" ? "En curso" : contest.state === "closed" || contest.state === "finished" ? "Cerrado" : esc(contest.state)}</p>
    ${contest.prize ? `<p>Premio: <strong>${esc(contest.prize.name)}</strong>${contest.prize.instructions ? ` · ${esc(contest.prize.instructions)}` : ""}</p>` : ""}
    ${contest.winner ? `<p class="winner">Ganador: ${esc(contest.winner.name)}${contest.winner.table_name ? ` · Mesa ${esc(contest.winner.table_name)}` : ""}</p>` : contest.leader ? `<p>Líder provisional: <strong>${esc(contest.leader.name)}</strong>${contest.calculated ? ` · ${Number(contest.leader.count || 1)} foto(s)` : ""}</p>` : ""}
    ${contest.delivery?.delivered_at ? `<p>Premio entregado por ${esc(contest.delivery.staff_name || "STAFF")}.</p>` : contest.winner && contest.prize ? `<form class="staff-form" data-delivery="${esc(contest.id)}"><input name="staffName" placeholder="Tu nombre" required maxlength="80"><button class="staff-button">Registrar entrega</button></form>` : ""}</article>`).join("") || "<p>No hay dinámicas configuradas para este evento.</p>"}`;
  root.querySelectorAll("[data-delivery]").forEach(form => form.addEventListener("submit", async event => {
    event.preventDefault(); const button = form.querySelector("button"); button.disabled = true;
    try { await api(`/api/staff/deliveries?access=${encodeURIComponent(access)}`, { method: "POST", body: JSON.stringify({ eventId: data.event.id, contestId: form.dataset.delivery, staffName: new FormData(form).get("staffName") }) }); feedback.textContent = "Entrega registrada."; await load(); }
    catch (error) { feedback.textContent = error.message; button.disabled = false; }
  }));
}
if (access) load().catch(error => { root.innerHTML = `<h1>Acceso STAFF</h1><p class="staff-error">${esc(error.message)}</p><p>Solicita al administrador que te comparta el enlace directo de este evento.</p>`; });
else root.innerHTML = `<h1>Acceso STAFF</h1><p>Solicita al administrador el enlace directo del evento que vas a coordinar.</p>`;
