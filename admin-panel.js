const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const loginCard = $("#login-card");
const shell = $("#admin-shell");
const feedback = $("#admin-feedback");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const state = { venues: [], events: [], selected: null, details: null };

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "No se pudo completar la operación.");
  return data;
}
const send = (path, method, data) => api(path, { method, body: JSON.stringify(data) });
function message(text) { feedback.textContent = text; }
function showLoggedOut(text = "") { loginCard.hidden = false; shell.hidden = true; message(text); }
function showLoggedIn() { loginCard.hidden = true; shell.hidden = false; }
function navigate(view) {
  $$(".admin-view").forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  $$(".admin-nav [data-view]").forEach((button) => button.setAttribute("aria-current", button.dataset.view === view ? "page" : "false"));
  $("#admin-content").scrollTo({ top: 0, behavior: "smooth" });
}
function optionHtml(venues, selected = "") { return '<option value="">Selecciona un lugar</option>' + venues.filter((v) => v.active).map((v) => `<option value="${esc(v.id)}" ${v.id === selected ? "selected" : ""}>${esc(v.name)}</option>`).join(""); }
function eventStateLabel(value) { return ({ active: "Activo", draft: "Preparación", inactive: "Inactivo", finished: "Finalizado" })[value] || value; }
function dateLabel(date) { return date ? new Date(`${date}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" }) : "Fecha pendiente"; }
function timeLabel(value) { return value ? new Date(value).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Horario pendiente"; }

let lastPlaceSearchAt = 0;
function timezoneOption(select, timezone) {
  if (!timezone) return;
  if (![...select.options].some((option) => option.value === timezone)) {
    const option = new Option(timezone, timezone);
    select.add(option);
  }
  select.value = timezone;
}
function attachPlaceAutocomplete(formId, suggestionsId, statusId) {
  const form = $(formId);
  const input = form.elements.name;
  const list = $(suggestionsId);
  const status = $(statusId);
  let timer = null;
  let controller = null;
  let places = [];
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); };
  const choose = async (place) => {
    const properties = place.properties || {};
    const name = properties.name || properties.city || properties.county || properties.state;
    const locality = properties.city || properties.district || properties.county;
    const detail = [locality, properties.state, properties.country].filter((part, index, all) => part && all.indexOf(part) === index && part !== name);
    input.value = [name, ...detail].filter(Boolean).join(", ");
    close();
    status.textContent = "Lugar elegido. Buscando su zona horaria…";
    const [longitude, latitude] = place.geometry?.coordinates || [];
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) { status.textContent = "No pude determinar la zona horaria; selecciónala manualmente."; return; }
    try {
      const query = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude) });
      const response = await fetch(`https://timeapi.io/api/timezone/coordinate?${query}`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("timezone_lookup_failed");
      const data = await response.json();
      const timezone = data.timeZone || data.timezone;
      if (!timezone) throw new Error("timezone_missing");
      timezoneOption(form.elements.timezone, timezone);
      status.textContent = `Zona horaria detectada: ${timezone}.`;
    } catch {
      status.textContent = "No pude detectar la zona horaria. Selecciónala en la lista.";
    }
  };
  const show = (features) => {
    places = features;
    list.innerHTML = features.map((place, index) => {
      const properties = place.properties || {};
      const name = properties.name || properties.city || properties.county || "Lugar";
      const detail = [properties.city || properties.district || properties.county, properties.state, properties.country]
        .filter((part, partIndex, all) => part && all.indexOf(part) === partIndex && part !== name).join(", ");
      return `<button type="button" role="option" aria-selected="false" data-place-index="${index}">${esc(name)}<small>${esc(detail)}</small></button>`;
    }).join("");
    list.hidden = !features.length;
    input.setAttribute("aria-expanded", String(features.length > 0));
    $$('[data-place-index]', list).forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => choose(places[Number(button.dataset.placeIndex)]));
    });
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    controller?.abort();
    const query = input.value.trim();
    close();
    if (query.length < 3) { status.textContent = "Escribe al menos 3 letras para ver sugerencias."; return; }
    status.textContent = "Buscando lugares…";
    timer = setTimeout(async () => {
      const wait = Math.max(0, 1000 - (Date.now() - lastPlaceSearchAt));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      if (input.value.trim() !== query) return;
      lastPlaceSearchAt = Date.now();
      controller = new AbortController();
      try {
        const params = new URLSearchParams({ q: query, lang: "es", limit: "6", lat: "23.6345", lon: "-102.5528", location_bias_scale: "0.2" });
        const response = await fetch(`https://photon.komoot.io/api/?${params}`, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error("place_search_failed");
        const data = await response.json();
        const features = Array.isArray(data.features) ? data.features : [];
        show(features);
        status.textContent = features.length ? "Elige el resultado correcto; la zona horaria se completará sola." : "No encontré sugerencias. Puedes escribir el lugar manualmente.";
      } catch (error) {
        if (error.name !== "AbortError") status.textContent = "No pude consultar sugerencias; puedes escribir el lugar manualmente.";
      }
    }, 550);
  });
  input.addEventListener("focus", () => { if (list.childElementCount) { list.hidden = false; input.setAttribute("aria-expanded", "true"); } });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "ArrowDown" && !list.hidden) { event.preventDefault(); $("button", list)?.focus(); }
  });
  document.addEventListener("click", (event) => { if (!form.contains(event.target)) close(); });
}

async function loadDashboard() {
  const data = await api("/api/admin/dashboard");
  state.venues = data.venues || [];
  state.events = data.events || [];
  $("#stat-venues").textContent = state.venues.length;
  $("#stat-events").textContent = state.events.length;
  $("#stat-active").textContent = state.events.filter((event) => event.state === "active").length;
  $("#event-form [name=venueId]").innerHTML = optionHtml(state.venues);
  $("#event-edit-form [name=venueId]").innerHTML = optionHtml(state.venues);
  renderVenues();
  renderEvents();
  renderStaff();
  showLoggedIn();
}
function renderVenues() {
  $("#venues-list").innerHTML = state.venues.length ? state.venues.map((venue) => `<article class="admin-row-card"><div class="admin-row-top"><div><h3>${esc(venue.name)}</h3><div class="admin-meta">${Number(venue.event_count || 0)} evento(s) · ${esc(venue.timezone)}</div></div><span class="admin-badge ${venue.active ? "active" : ""}">${venue.active ? "Activo" : "Inactivo"}</span></div><div class="admin-actions"><button class="admin-button secondary" type="button" data-edit-venue="${esc(venue.id)}">Editar lugar</button><button class="admin-button secondary" type="button" data-delete-venue="${esc(venue.id)}">Eliminar lugar</button></div></article>`).join("") : '<div class="empty-state">Aún no hay lugares. Registra el primero para crear un evento.</div>';
  $$('[data-edit-venue]', $("#venues-list")).forEach((button) => button.addEventListener("click", () => editVenue(button.dataset.editVenue)));
  $$('[data-delete-venue]', $("#venues-list")).forEach((button) => button.addEventListener("click", () => deleteVenue(button.dataset.deleteVenue)));
}
function eventCard(event, configButton = true) {
  return `<article class="admin-row-card"><div class="admin-row-top"><div><h3>${esc(event.name)}</h3><div class="admin-meta">${esc(event.venue_name)} · ${dateLabel(event.event_date)}</div></div><span class="admin-badge ${event.state === "active" ? "active" : ""}">${eventStateLabel(event.state)}</span></div><div class="admin-meta" style="margin-top:8px">${Number(event.guest_count || 0)} invitados · ${Number(event.activity_count || 0)} momentos${event.drive_status === "ready" ? " · Drive conectado" : " · Drive pendiente"}</div><div class="admin-actions">${configButton ? `<button class="admin-button secondary" type="button" data-configure="${esc(event.id)}">Modificar evento</button><button class="admin-button secondary" type="button" data-delete-event="${esc(event.id)}">Eliminar evento</button>` : ""}<a class="admin-button secondary" href="${esc(event.staffUrl)}" target="_blank" rel="noopener noreferrer">Abrir STAFF</a><button class="admin-button" type="button" data-copy-staff="${esc(event.id)}" aria-label="Copiar URL de STAFF para ${esc(event.name)}"><svg aria-hidden="true" viewBox="0 0 24 24" style="width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>Copiar URL STAFF</button></div></article>`;
}
function editVenue(id) {
  const venue = state.venues.find((item) => item.id === id);
  if (!venue) return;
  const form = $("#venue-edit-form");
  form.elements.id.value = venue.id;
  form.elements.name.value = venue.name;
  form.elements.timezone.value = venue.timezone;
  $("#venue-editor").hidden = false;
  $("#venue-editor").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function deleteVenue(id) {
  const venue = state.venues.find((item) => item.id === id);
  if (!venue) return;
  const eventCount = Number(venue.event_count || 0);
  const consequence = eventCount ? ` También se eliminarán permanentemente sus ${eventCount} evento(s), junto con su agenda e invitados.` : "";
  if (!confirm(`¿Eliminar el lugar «${venue.name}»?${consequence} Se borrará la configuración del sitio; las carpetas y fotos de Google Drive no se eliminarán. Esta acción no se puede deshacer.`)) return;
  try {
    await api(`/api/admin/venues/${encodeURIComponent(id)}`, { method: "DELETE" });
    $("#venue-editor").hidden = true;
    message(`Lugar «${venue.name}» eliminado${eventCount ? " junto con sus eventos" : ""}.`);
    await loadDashboard();
  } catch (error) { message(error.message); }
}
async function deleteEvent(id) {
  const event = state.events.find((item) => item.id === id);
  if (!event || !confirm(`¿Eliminar permanentemente el evento «${event.name}» de ${event.venue_name}? También se eliminarán su agenda, invitados y configuración. Su carpeta y fotos de Google Drive se conservarán. Esta acción no se puede deshacer.`)) return;
  try {
    await api(`/api/admin/events/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.selected === id) { state.selected = null; state.details = null; $("#event-editor").hidden = true; }
    message(`Evento «${event.name}» eliminado.`);
    await loadDashboard();
  } catch (error) { message(error.message); }
}
function bindStaffCopy(root = document) {
  $$('[data-copy-staff]', root).forEach((button) => button.addEventListener("click", async () => {
    const event = state.events.find((item) => item.id === button.dataset.copyStaff);
    if (!event) return;
    try { await navigator.clipboard.writeText(event.staffUrl); }
    catch { const field = document.createElement("textarea"); field.value = event.staffUrl; document.body.append(field); field.select(); document.execCommand("copy"); field.remove(); }
    button.textContent = "URL copiada";
    message(`Enlace STAFF de ${event.name} copiado. Ya puedes enviarlo por WhatsApp.`);
    setTimeout(() => { if (button.isConnected) button.textContent = "Copiar URL STAFF"; }, 1800);
  }));
}
function renderEvents() {
  $("#events-list").innerHTML = state.events.length ? state.events.map((event) => eventCard(event)).join("") : '<div class="empty-state">Aún no hay eventos. Crea uno después de registrar el lugar.</div>';
  $$('[data-configure]', $("#events-list")).forEach((button) => button.addEventListener("click", () => selectEvent(button.dataset.configure)));
  $$('[data-delete-event]', $("#events-list")).forEach((button) => button.addEventListener("click", () => deleteEvent(button.dataset.deleteEvent)));
  bindStaffCopy($("#events-list"));
}
function renderStaff() {
  const grouped = new Map();
  state.events.forEach((event) => { if (!grouped.has(event.venue_name)) grouped.set(event.venue_name, []); grouped.get(event.venue_name).push(event); });
  $("#staff-list").innerHTML = grouped.size ? [...grouped].map(([venue, events]) => `<section class="admin-card"><p class="admin-eyebrow">LUGAR</p><h2>${esc(venue)}</h2><div class="admin-list">${events.map((event) => eventCard(event, false)).join("")}</div></section>`).join("") : '<div class="empty-state">Cuando crees eventos, aquí encontrarás sus enlaces STAFF agrupados por lugar.</div>';
  bindStaffCopy($("#staff-list"));
}

async function selectEvent(id) {
  try {
    const result = await api(`/api/admin/events/${encodeURIComponent(id)}/details`);
    state.selected = id;
    state.details = result;
    fillEventForm(result);
    renderEventDetails();
    $("#event-editor").hidden = false;
    setEventTab("details");
    navigate("events");
    $("#event-editor").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { message(error.message); }
}
function fillEventForm({ event, venue }) {
  const form = $("#event-edit-form");
  form.elements.name.value = event.name;
  form.elements.venueId.value = venue.id;
  form.elements.eventDate.value = event.event_date;
  form.elements.driveFolderUrl.value = event.drive_folder_url || "";
  form.elements.state.value = event.state;
  form.elements.contestsEnabled.checked = Boolean(event.contests_enabled);
  $("#selected-event-title").textContent = event.name;
  $("#selected-event-state").textContent = eventStateLabel(event.state);
  $("#selected-event-state").classList.toggle("active", event.state === "active");
}
function setEventTab(tab) {
  $$('[data-event-tab]').forEach((button) => button.setAttribute("aria-pressed", button.dataset.eventTab === tab ? "true" : "false"));
  $$('[data-event-panel]').forEach((panel) => { panel.hidden = panel.dataset.eventPanel !== tab; });
}
function renderEventDetails() {
  const { activities, guests, contests } = state.details;
  $("#activities-list").innerHTML = activities.length ? activities.map((activity) => `<article class="admin-row-card"><div class="admin-row-top"><div><h3>${esc(activity.position)}. ${esc(activity.name)}</h3><div class="admin-meta">${timeLabel(activity.starts_at)} – ${new Date(activity.ends_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</div></div><button class="admin-button secondary" type="button" data-delete-activity="${esc(activity.id)}">Quitar</button></div><div class="admin-meta">Fotos: ${timeLabel(activity.photo_opens_at)} a ${new Date(activity.photo_closes_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</div></article>`).join("") : '<div class="empty-state">Agrega los momentos de la boda para construir el minuto a minuto.</div>';
  $$('[data-delete-activity]', $("#activities-list")).forEach((button) => button.addEventListener("click", () => deactivate(`/api/admin/activities/${encodeURIComponent(button.dataset.deleteActivity)}`, "Actividad quitada.")));
  $("#guests-list").innerHTML = guests.length ? guests.map((guest) => `<article class="admin-row-card"><div class="admin-row-top"><div><h3>${esc(guest.name)}</h3><div class="admin-meta">${guest.table_name ? `Mesa ${esc(guest.table_name)} · ` : ""}${guest.active ? `${Number(guest.photos_sent || 0)} foto(s) enviadas` : "Invitación desactivada"}</div></div>${guest.active ? `<button class="admin-button secondary" type="button" data-delete-guest="${esc(guest.id)}">Desactivar</button>` : '<span class="admin-badge">Inactivo</span>'}</div></article>`).join("") : '<div class="empty-state">Agrega a las personas invitadas o carga la lista desde una hoja CSV.</div>';
  $$('[data-delete-guest]', $("#guests-list")).forEach((button) => button.addEventListener("click", () => deactivate(`/api/admin/guests/${encodeURIComponent(button.dataset.deleteGuest)}`, "Invitación desactivada.")));
  const currentActivity = $("#contest-form [name=activityId]").value;
  $("#contest-form [name=activityId]").innerHTML = '<option value="">Cierre de todo el evento</option>' + activities.filter((a) => a.active).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
  if (currentActivity) $("#contest-form [name=activityId]").value = currentActivity;
  $("#contests-list").innerHTML = contests.length ? contests.map((contest) => `<article class="admin-row-card"><div class="admin-row-top"><div><h3>${esc(contest.name)}</h3><div class="admin-meta">${contest.kind === "first_photo" ? "Primera foto elegible" : contest.kind === "most_photos" ? "Más fotos elegibles" : contest.kind === "photo_with_couple" ? "Foto con los novios" : contest.kind === "bouquet" ? "Ramo" : "Selección del equipo"} · ${esc(eventStateLabel(contest.state))}</div></div><span class="admin-badge ${contest.prize_name ? "active" : ""}">${contest.prize_name ? `Premio: ${esc(contest.prize_name)}` : "Felicitación digital"}</span></div>${contest.validation_instructions ? `<p class="admin-meta" style="margin-bottom:0">${esc(contest.validation_instructions)}</p>` : ""}</article>`).join("") : '<div class="empty-state">Aún no hay retos o reconocimientos configurados.</div>';
}
async function deactivate(path, successText) {
  if (!confirm("¿Quieres desactivar este elemento?")) return;
  try { await api(path, { method: "DELETE" }); message(successText); await selectEvent(state.selected); await loadDashboard(); }
  catch (error) { message(error.message); }
}

function parseCSV(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = firstLine.includes(";") && !firstLine.includes(",") ? ";" : firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows = []; let row = []; let value = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { value += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { row.push(value.trim()); value = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && text[i + 1] === "\n") i++; row.push(value.trim()); if (row.some(Boolean)) rows.push(row); row = []; value = ""; }
    else value += char;
  }
  row.push(value.trim()); if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error("El archivo no contiene filas para importar.");
  const clean = (v) => String(v).replace(/^\uFEFF/, "").toLocaleLowerCase("es-MX").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const headers = rows[0].map(clean);
  return rows.slice(1).map((cols) => Object.fromEntries(headers.map((header, index) => [header, cols[index] || ""])));
}
function col(row, names) { for (const name of names) { const value = row[name]; if (value) return value.trim(); } return ""; }
function dateTime(value, date) {
  const source = String(value || "").trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(source)) return `${date}T${source.length === 5 ? `${source}:00` : source}`;
  const parsed = new Date(source);
  if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  throw new Error(`No se reconoce la hora «${source}». Usa HH:MM o fecha y hora.`);
}
async function importCSV(input, kind) {
  const file = input.files?.[0]; if (!file || !state.details) return;
  input.disabled = true;
  try {
    const rows = parseCSV((await file.text()).replace(/^\uFEFF/, ""));
    let imported = 0;
    if (kind === "guests") {
      for (const row of rows) {
        const name = col(row, ["nombre", "invitado", "name", "nombrecompleto"]);
        if (!name) continue;
        await send("/api/admin/guests", "POST", { eventId: state.selected, name, tableName: col(row, ["mesa", "table", "mesanumero"]) }); imported++;
      }
    } else {
      let position = state.details.activities.length;
      for (const row of rows) {
        const name = col(row, ["actividad", "momento", "nombre", "name"]);
        const starts = col(row, ["inicio", "horainicio", "empieza", "start", "startsat"]);
        const ends = col(row, ["fin", "horafin", "termina", "end", "endsat"]);
        if (!name || !starts || !ends) continue;
        position++;
        await send("/api/admin/activities", "POST", { eventId: state.selected, name, position, startsAt: dateTime(starts, state.details.event.event_date), endsAt: dateTime(ends, state.details.event.event_date) }); imported++;
      }
    }
    await selectEvent(state.selected); await loadDashboard();
    message(`${imported} ${kind === "guests" ? "invitado(s)" : "actividad(es)"} importado(s).`);
  } catch (error) { message(`No se completó la importación: ${error.message}`); }
  finally { input.disabled = false; input.value = ""; }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = $("button", event.currentTarget); button.disabled = true; message("Comprobando acceso…");
  try { await send("/api/admin/session", "POST", { username: $("#username").value.trim(), password: $("#password").value }); $("#password").value = ""; await loadDashboard(); navigate("overview"); message("Sesión iniciada."); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
$("#logout").addEventListener("click", async () => { try { await api("/api/admin/session", { method: "DELETE" }); } catch {} showLoggedOut("Sesión cerrada. Ingresa de nuevo para continuar."); $("#username").value = ""; $("#password").value = ""; window.scrollTo({ top: 0, behavior: "smooth" }); });
$$('[data-view]').forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
$$('[data-go]').forEach((button) => button.addEventListener("click", () => navigate(button.dataset.go)));
$$('[data-event-tab]').forEach((button) => button.addEventListener("click", () => setEventTab(button.dataset.eventTab)));
$("#admin-content").addEventListener("scroll", (event) => { $("#admin-scroll-top").hidden = event.currentTarget.scrollTop < 240; }, { passive: true });
$("#admin-scroll-top").addEventListener("click", () => $("#admin-content").scrollTo({ top: 0, behavior: "smooth" }));

$("#venue-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button", form); button.disabled = true;
  const data = Object.fromEntries(new FormData(form));
  try { await send("/api/admin/venues", "POST", data); form.reset(); message("Lugar guardado."); await loadDashboard(); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
attachPlaceAutocomplete("#venue-form", "#venue-suggestions", "#venue-search-status");
attachPlaceAutocomplete("#venue-edit-form", "#venue-edit-suggestions", "#venue-edit-search-status");
$("#venue-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button[type=submit]", form); button.disabled = true;
  const data = Object.fromEntries(new FormData(form));
  try { await send(`/api/admin/venues/${encodeURIComponent(data.id)}`, "PUT", data); $("#venue-editor").hidden = true; message("Cambios del lugar guardados."); await loadDashboard(); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
$("#cancel-venue-edit").addEventListener("click", () => { $("#venue-editor").hidden = true; $("#venue-edit-form").reset(); });
$("#event-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button", form); button.disabled = true;
  const data = Object.fromEntries(new FormData(form)); data.contestsEnabled = form.elements.contestsEnabled.checked;
  try { const { event: created } = await send("/api/admin/events", "POST", data); form.reset(); form.elements.contestsEnabled.checked = true; message("Evento creado. Ahora agrega su agenda e invitados."); await loadDashboard(); await selectEvent(created.id); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
$("#event-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button", form); button.disabled = true;
  const data = Object.fromEntries(new FormData(form)); data.contestsEnabled = form.elements.contestsEnabled.checked;
  try { await send(`/api/admin/events/${encodeURIComponent(state.selected)}`, "PUT", data); message("Cambios del evento guardados."); await loadDashboard(); await selectEvent(state.selected); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
$("#activity-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button", form); button.disabled = true;
  const data = Object.fromEntries(new FormData(form)); data.eventId = state.selected; data.position = state.details.activities.length + 1;
  try { await send("/api/admin/activities", "POST", data); form.reset(); message("Actividad agregada al minuto a minuto."); await selectEvent(state.selected); await loadDashboard(); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
$("#guest-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button", form); button.disabled = true;
  const data = Object.fromEntries(new FormData(form)); data.eventId = state.selected;
  try { await send("/api/admin/guests", "POST", data); form.reset(); message("Invitado agregado."); await selectEvent(state.selected); await loadDashboard(); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
$("#activity-csv").addEventListener("change", (event) => importCSV(event.currentTarget, "activities"));
$("#guest-csv").addEventListener("change", (event) => importCSV(event.currentTarget, "guests"));

$("#contest-form [name=hasPrize]").addEventListener("change", (event) => { $("#prize-fields").hidden = !event.target.checked; $("#felicitation-fields").hidden = event.target.checked; });
$("#contest-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button", form); button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const allActivities = state.details.activities.filter((activity) => activity.active);
    const activity = allActivities.find((item) => item.id === values.activityId);
    const activityIds = activity ? [activity.id] : allActivities.map((item) => item.id);
    const opensAt = activity?.photo_opens_at || (activityIds.length ? allActivities.map((a) => a.photo_opens_at).sort()[0] : new Date(`${state.details.event.event_date}T00:00:00`).toISOString());
    const closesAt = activity?.photo_closes_at || (activityIds.length ? allActivities.map((a) => a.photo_closes_at).sort().at(-1) : new Date(`${state.details.event.event_date}T23:59:00`).toISOString());
    let prizeId = null;
    if (form.elements.hasPrize.checked) {
      if (!values.prizeName.trim()) throw new Error("Escribe el nombre del premio o cambia a Felicitación digital.");
      const prize = await send("/api/admin/prizes", "POST", { eventId: state.selected, name: values.prizeName, instructions: values.prizeInstructions });
      prizeId = prize.prize.id;
    }
    const felicitacion = form.elements.hasPrize.checked ? "" : `Felicitación digital: ${values.felicitation || "¡Gracias por compartir este momento!"}`;
    const instructions = [felicitacion, values.validationInstructions.trim()].filter(Boolean).join("\n\n");
    await send("/api/admin/contests", "POST", { eventId: state.selected, name: values.name, kind: form.elements.hasPrize.checked ? values.kind : "manual", activityIds, opensAt, closesAt, prizeId, validationInstructions: instructions, state: "active" });
    form.reset(); $("#prize-fields").hidden = false; $("#felicitation-fields").hidden = true; message("Reto guardado y visible para el STAFF."); await selectEvent(state.selected);
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
});

api("/api/admin/session").then(async (session) => { if (session.authenticated) { await loadDashboard(); navigate("overview"); } else showLoggedOut(); }).catch(() => showLoggedOut());
