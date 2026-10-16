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
async function renderStaffSelector() {
  root.innerHTML = `<h1>Acceso STAFF</h1><p>Selecciona el lugar y el evento que vas a coordinar.</p>
    <form class="staff-select-form" id="staff-select-form">
      <label for="staff-venue-select">Lugar<select id="staff-venue-select" required><option value="">Selecciona un lugar</option><option value="__demo__">Evento de demostración</option></select></label>
      <label for="staff-event-select">Evento<select id="staff-event-select" required disabled><option value="">Primero selecciona un lugar</option></select></label>
      <label for="staff-link-input">Enlace STAFF del evento<input id="staff-link-input" type="url" placeholder="Pega el enlace que te compartió administración" autocomplete="url" /></label>
      <button type="submit">Continuar <span aria-hidden="true">→</span></button>
      <p class="staff-select-help">El enlace del evento confirma que tienes acceso al panel. Puedes probar la pantalla con el evento de demostración.</p>
      <p class="staff-select-message" id="staff-select-message" role="status" aria-live="polite"></p>
    </form>`;
  const venueSelect = document.querySelector("#staff-venue-select");
  const eventSelect = document.querySelector("#staff-event-select");
  const linkInput = document.querySelector("#staff-link-input");
  const message = document.querySelector("#staff-select-message");
  function setEvents(rows) {
    eventSelect.innerHTML = '<option value="">Selecciona un evento</option>' + rows.map(event => `<option value="${esc(event.id)}">${esc(event.name)} · ${esc(event.event_date || "")}</option>`).join("");
    eventSelect.disabled = rows.length === 0;
  }
  try {
    const result = await api("/api/public/venues");
    for (const venue of result.venues || []) {
      const option = document.createElement("option");
      option.value = venue.id;
      option.textContent = venue.name;
      venueSelect.append(option);
    }
  } catch {
    message.textContent = "No hay eventos conectados en este momento. La demostración sigue disponible.";
  }
  venueSelect.addEventListener("change", async () => {
    message.textContent = "";
    if (venueSelect.value === "__demo__") {
      setEvents([{ id: "demo-event", name: "Isa & Mateo", event_date: "Vista de ejemplo" }]);
      linkInput.required = false;
      return;
    }
    linkInput.required = true;
    eventSelect.innerHTML = '<option value="">Cargando eventos…</option>';
    eventSelect.disabled = true;
    if (!venueSelect.value) {
      eventSelect.innerHTML = '<option value="">Primero selecciona un lugar</option>';
      return;
    }
    try {
      const result = await api("/api/public/events?venueId=" + encodeURIComponent(venueSelect.value));
      setEvents(result.events || []);
      if (!result.events?.length) message.textContent = "No hay un evento activo hoy en este lugar.";
    } catch (error) {
      eventSelect.innerHTML = '<option value="">No se pudieron cargar los eventos</option>';
      message.textContent = error.message;
    }
  });
  document.querySelector("#staff-select-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const selectedEvent = eventSelect.value;
    if (!selectedEvent) { message.textContent = "Selecciona un evento."; return; }
    if (selectedEvent === "demo-event") { renderDemoStaff(); return; }
    let token = "";
    try {
      const staffUrl = new URL(linkInput.value.trim());
      if (staffUrl.origin !== location.origin || !staffUrl.pathname.endsWith("/staff.html")) throw new Error();
      token = staffUrl.searchParams.get("access") || "";
    } catch {
      message.textContent = "Pega el enlace STAFF completo del evento.";
      return;
    }
    if (!token) { message.textContent = "Ese enlace no contiene acceso a STAFF."; return; }
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    message.textContent = "Verificando el evento…";
    try {
      const result = await api("/api/staff/events?access=" + encodeURIComponent(token));
      if (!(result.events || []).some(item => String(item.id) === String(selectedEvent))) throw new Error("El enlace STAFF no corresponde al evento seleccionado.");
      location.href = "./staff.html?access=" + encodeURIComponent(token);
    } catch (error) {
      message.textContent = error.message;
      button.disabled = false;
    }
  });
}
function renderDemoStaff() {
  root.innerHTML = `<p class="staff-select-help">VISTA DE DEMOSTRACIÓN</p><h1>Isa &amp; Mateo</h1><p>Jardín Los Olivos · hoy</p><div class="staff-status">Programa del evento · vista de ejemplo</div>
    <article class="contest"><h2>Entrada de los novios</h2><p>Próximamente · 17:00</p></article>
    <article class="contest"><h2>El brindis</h2><p>En curso · 19:30</p><p>Líder provisional: Ana López · 2 fotos</p></article>
    <article class="contest"><h2>Primer baile</h2><p>Próximamente · 21:00</p></article>
    <p class="staff-select-help">Los datos reales solo aparecen con el enlace STAFF del evento.</p><button class="staff-button" id="back-to-staff-select" type="button">Elegir otro evento</button>`;
  document.querySelector("#back-to-staff-select").addEventListener("click", renderStaffSelector);
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
if (access) load().catch(error => { root.innerHTML = `<h1>Acceso STAFF</h1><p class="staff-error">${esc(error.message)}</p><p>Solicita al administrador que te comparta el enlace correspondiente.</p>`; });
else renderStaffSelector();
