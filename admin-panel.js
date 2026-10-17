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
  if (view === "venues") { $("#venue-create-card").hidden = true; $("#venue-editor").hidden = true; }
  if (view === "events") { $("#event-setup-card").hidden = true; $("#event-editor").hidden = true; $("#events-list-card").hidden = false; }
  $("#admin-content").scrollTo({ top: 0, behavior: "smooth" });
}
function optionHtml(venues, selected = "") { return '<option value="">Selecciona un lugar</option>' + venues.filter((v) => v.active).map((v) => `<option value="${esc(v.id)}" ${v.id === selected ? "selected" : ""}>${esc(v.name)}</option>`).join(""); }
function eventStateLabel(value) { return ({ active: "Activo", draft: "Preparación", inactive: "Inactivo", finished: "Finalizado" })[value] || value; }
function dateLabel(date) { return date ? new Date(`${date}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" }) : "Fecha pendiente"; }
function timeLabel(value) { return value ? new Date(value).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Horario pendiente"; }
function setPreviewElements(img, placeholder, url) {
  if (img.dataset.objectUrl) { URL.revokeObjectURL(img.dataset.objectUrl); delete img.dataset.objectUrl; }
  if (url) { img.src = url; if (url.startsWith("blob:")) img.dataset.objectUrl = url; img.hidden = false; placeholder.hidden = true; }
  else { img.removeAttribute("src"); img.hidden = true; placeholder.hidden = false; }
}
function setCoverPreview(image, empty, url) {
  setPreviewElements($(image), $(empty), url);
}
function previewCoverFile(input, image, empty) {
  const source = typeof input === "string" ? $(input) : input;
  const file = source?.files?.[0];
  if (file) setCoverPreview(image, empty, URL.createObjectURL(file));
}
function timeParts(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone || "America/Mexico_City", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(value));
  return { clock: `${parts.find((part) => part.type === "hour").value}:${parts.find((part) => part.type === "minute").value}`, period: parts.find((part) => part.type === "dayPeriod").value.toUpperCase() };
}
function nextEventDateTime(date) {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T00:00`;
}

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
  const input = form.elements.placeCity;
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

let setupActivityCount = 0;
const EVENT_DRAFT_KEY = "entre-momentos:event-setup-draft";
let restoringEventDraft = false;
let setupAgendaRows = null;
let setupGuestRows = null;
function addSetupActivity() {
  const list = $("#setup-activities");
  const index = list.children.length;
  const card = document.createElement("article");
  card.className = "setup-activity-card";
  card.dataset.setupActivity = "";
  card.innerHTML = `<div class="setup-activity-heading"><h4>Momento ${index + 1}</h4><button class="admin-button secondary" type="button" data-remove-setup-activity aria-label="Quitar momento">Quitar</button></div>
    <div class="admin-two-col"><label>Nombre de la actividad<input name="name" placeholder="El brindis" minlength="2"></label><label>Foto de referencia (opcional)<input name="reference" type="file" accept="image/jpeg,image/png,image/webp"><span class="cover-preview setup-reference-preview"><img data-reference-preview alt="Vista previa de la actividad" hidden><span data-reference-empty>La miniatura aparecerá aquí al seleccionarla.</span></span></label></div>
    <label>Descripción breve (opcional)<textarea name="description" placeholder="Una frase que explique el momento" rows="2"></textarea></label>
    <div class="admin-two-col"><label>Hora de inicio<div class="admin-time-entry"><input name="startClock" type="text" inputmode="numeric" maxlength="5" pattern="(?:[1-9]|1[0-2]):[0-5][0-9]" placeholder="5:30" aria-label="Hora y minutos de inicio"><select name="startPeriod" aria-label="AM o PM"><option>PM</option><option>AM</option></select></div></label>
    <label>Hora de fin<div class="admin-time-entry"><input name="endClock" type="text" inputmode="numeric" maxlength="5" pattern="(?:[1-9]|1[0-2]):[0-5][0-9]" placeholder="6:30" aria-label="Hora y minutos de fin"><select name="endPeriod" aria-label="AM o PM"><option>PM</option><option>AM</option></select></div></label></div>
    <label class="rule-toggle"><input name="hasContest" type="checkbox"><span>Premiar la primera foto de esta actividad</span></label>
    <div class="setup-challenge" hidden><label>Nombre del reconocimiento<input name="contestName" placeholder="Primera foto del brindis"></label><label>Regla o condición<textarea name="contestRules" placeholder="Qué debe aparecer en la foto" rows="2"></textarea></label><label class="rule-toggle"><input name="hasPrize" type="checkbox"><span>Esta dinámica tendrá premio físico</span></label><label data-prize-name hidden>Premio<input name="prizeName" placeholder="Ramo, recuerdo, etc."></label><p class="admin-help">Si no hay premio, se mostrará una felicitación digital.</p></div>`;
  list.append(card);
  card.querySelector("[data-remove-setup-activity]").addEventListener("click", () => { if (list.children.length <= 1) return; card.remove(); [...list.children].forEach((item, i) => { item.querySelector("h4").textContent = `Momento ${i + 1}`; }); saveEventDraft(); });
  card.querySelector('[name="hasContest"]').addEventListener("change", (event) => { card.querySelector(".setup-challenge").hidden = !event.target.checked; });
  card.querySelector('[name="hasPrize"]').addEventListener("change", (event) => { card.querySelector("[data-prize-name]").hidden = !event.target.checked; });
  card.querySelector('[name="reference"]').addEventListener("change", (event) => {
    const file = event.currentTarget.files?.[0];
    if (file) setPreviewElements(card.querySelector("[data-reference-preview]"), card.querySelector("[data-reference-empty]"), URL.createObjectURL(file));
  });
}
function saveEventDraft() {
  if (restoringEventDraft) return;
  const form = $("#event-form");
  const fields = [...form.querySelectorAll("input:not([type=file]),select,textarea")].map((field) => ({ value: field.value, checked: field.type === "checkbox" ? field.checked : undefined }));
  try {
    localStorage.setItem(EVENT_DRAFT_KEY, JSON.stringify({ fields, activityCount: $("#setup-activities").children.length, agendaRows: setupAgendaRows, guestRows: setupGuestRows, savedAt: Date.now() }));
    $("#setup-event-feedback").textContent = "Borrador guardado automáticamente en este navegador.";
  } catch { $("#setup-event-feedback").textContent = "No se pudo guardar el borrador automáticamente. Completa y guarda el evento antes de cerrar."; }
}
function restoreEventDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(EVENT_DRAFT_KEY) || "null"); } catch { return; }
  if (!draft?.fields?.length) return;
  setupAgendaRows = Array.isArray(draft.agendaRows) ? draft.agendaRows : null;
  setupGuestRows = Array.isArray(draft.guestRows) ? draft.guestRows : null;
  restoringEventDraft = true;
  const list = $("#setup-activities");
  list.innerHTML = "";
  for (let index = 0; index < Math.max(1, Math.min(Number(draft.activityCount) || 1, 30)); index++) addSetupActivity();
  const fields = [...$("#event-form").querySelectorAll("input:not([type=file]),select,textarea")];
  fields.forEach((field, index) => {
    const saved = draft.fields[index];
    if (!saved) return;
    if (field.type === "checkbox") field.checked = Boolean(saved.checked);
    else field.value = saved.value ?? "";
  });
  $("#setup-activities").querySelectorAll("[data-setup-activity]").forEach((card) => {
    card.querySelector(".setup-challenge").hidden = !card.querySelector('[name="hasContest"]').checked;
    card.querySelector("[data-prize-name]").hidden = !card.querySelector('[name="hasPrize"]').checked;
  });
  $("#setup-event-challenge").hidden = !$("#setup-event-challenge-enabled").checked;
  $("#setup-event-close-time").hidden = $("#setup-event-challenge-kind").value !== "most_photos";
  $("#setup-event-prize-field").hidden = !$("#setup-event-challenge-prize-enabled").checked;
  restoringEventDraft = false;
  if (setupAgendaRows) $("#setup-agenda-preview").textContent = `${setupAgendaRows.length} momento(s) recuperados del borrador.`;
  if (setupGuestRows) $("#setup-guests-preview").textContent = `${setupGuestRows.length} invitado(s) recuperados del borrador.`;
  const restoredFiles = [setupAgendaRows && `${setupAgendaRows.length} momentos`, setupGuestRows && `${setupGuestRows.length} invitados`].filter(Boolean).join(" y ");
  $("#setup-event-feedback").textContent = `Recuperé el borrador guardado en este navegador${restoredFiles ? `, incluida la lista de ${restoredFiles}` : ""}. Las fotografías sí tendrás que seleccionarlas de nuevo.`;
}
async function uploadEventAsset(eventId, file, kind, activityId = "") {
  if (!file) return null;
  const data = new FormData(); data.append("file", file, file.name); data.append("kind", kind); if (activityId) data.append("activityId", activityId);
  const response = await fetch(`/api/admin/events/${encodeURIComponent(eventId)}/assets`, { method: "POST", credentials: "same-origin", body: data });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || "No se pudo guardar la imagen.");
  return result.asset;
}
function guestRowsFromImport(rows) {
  return rows.map((row) => {
    const firstName = col(row, ["nombre", "nombres", "nombreyapellido", "nombreapellido", "firstname", "givenname"]);
    const lastName = col(row, ["apellido", "apellidos", "lastname", "surname"]);
    const fullName = col(row, ["nombrecompleto", "invitado", "name"]);
    const name = [firstName, lastName].filter(Boolean).join(" ") || fullName;
    return { name, nickname: col(row, ["apodo", "sobrenombre", "nickname", "alias"]), tableName: col(row, ["mesa", "table", "mesanumero"]) };
  }).filter((guest) => guest.name.length >= 2);
}async function loadDashboard() {
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
  return `<article class="admin-row-card"><div class="admin-row-top"><div><h3>${esc(event.name)}</h3><div class="admin-meta">${esc(event.venue_name)} · ${dateLabel(event.event_date)}</div></div><span class="admin-badge ${event.state === "active" ? "active" : ""}">${eventStateLabel(event.state)}</span></div><div class="admin-meta" style="margin-top:8px">${Number(event.guest_count || 0)} invitados · ${Number(event.activity_count || 0)} momentos · ${Number(event.photo_count || 0)} fotos en R2</div>${configButton ? `<div class="admin-actions"><button class="admin-button secondary" type="button" data-configure="${esc(event.id)}">Modificar evento</button><button class="admin-button secondary" type="button" data-download-event="${esc(event.id)}">Descargar evento</button><button class="admin-button secondary" type="button" data-delete-photos="${esc(event.id)}">Eliminar fotos</button><button class="admin-button secondary" type="button" data-delete-event="${esc(event.id)}">Eliminar evento</button></div>` : ""}</article>`;
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
  if (!confirm(`¿Eliminar el lugar «${venue.name}»?${consequence} También se borrarán de R2 las fotos y archivos de cada evento de este lugar. Esta acción no se puede deshacer.`)) return;
  try {
    await api(`/api/admin/venues/${encodeURIComponent(id)}`, { method: "DELETE" });
    $("#venue-editor").hidden = true;
    message(`Lugar «${venue.name}» eliminado${eventCount ? " junto con sus eventos" : ""}.`);
    await loadDashboard();
  } catch (error) { message(error.message); }
}
async function deleteEvent(id) {
  const event = state.events.find((item) => item.id === id);
  if (!event || !confirm(`¿Eliminar permanentemente el evento «${event.name}» de ${event.venue_name}? Se eliminarán sus fotos de R2, portada, fotos de actividades, agenda, invitados y demás información. No afecta otros eventos. Esta acción no se puede deshacer.`)) return;
  try {
    await api(`/api/admin/events/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.selected === id) { state.selected = null; state.details = null; $("#event-editor").hidden = true; }
    message(`Evento «${event.name}» eliminado.`);
    await loadDashboard();
  } catch (error) { message(error.message); }
}
async function downloadEvent(id) {
  const event = state.events.find((item) => item.id === id);
  if (!event) return;
  try {
    message(`Preparando la descarga de «${event.name}»…`);
    const response = await fetch(`/api/admin/events/${encodeURIComponent(id)}/download`, { credentials: "same-origin" });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.message || "No se pudo preparar la descarga."); }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `${event.name.replace(/[^\p{L}\p{N} -]/gu, "").trim() || "evento"}-evento.zip`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    message(`Descarga de «${event.name}» iniciada.`);
  } catch (error) { message(error.message); }
}
async function deleteEventPhotos(id) {
  const event = state.events.find((item) => item.id === id);
  if (!event || !confirm(`¿Eliminar todas las fotos de invitados de «${event.name}»? Solo se borrarán las fotos de este evento; se conservarán su portada, referencias, agenda e invitados.`)) return;
  try {
    const result = await api(`/api/admin/events/${encodeURIComponent(id)}/photos`, { method: "DELETE" });
    message(`${Number(result.deletedCount || 0)} foto(s) eliminadas de «${event.name}».`);
    await loadDashboard();
  } catch (error) { message(error.message); }
}
function bindVenueUrlCopy(root = document) {
  $$('[data-copy-venue-url]', root).forEach((button) => button.addEventListener("click", async () => {
    const venue = state.venues.find((item) => item.id === button.dataset.venueId);
    const url = venue?.[button.dataset.copyVenueUrl === "staff" ? "staffUrl" : "guestUrl"];
    if (!url) return;
    try { await navigator.clipboard.writeText(url); }
    catch { const field = document.createElement("textarea"); field.value = url; document.body.append(field); field.select(); document.execCommand("copy"); field.remove(); }
    const original = button.textContent;
    button.textContent = "Copiada";
    message(`${button.dataset.copyVenueUrl === "staff" ? "URL STAFF" : "URL de invitados"} de ${venue.name} copiada.`);
    setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1800);
  }));
}
function renderEvents() {
  const grouped = new Map();
  state.events.forEach((event) => { const venue = event.venue_name || "Sin lugar"; if (!grouped.has(venue)) grouped.set(venue, []); grouped.get(venue).push(event); });
  $("#events-list").innerHTML = grouped.size ? [...grouped].map(([venue, events]) => `<section class="event-venue-group"><div class="event-venue-heading"><h3>${esc(venue)}</h3><span>${events.length} evento(s)</span></div><div class="admin-list">${events.map((event) => eventCard(event)).join("")}</div></section>`).join("") : '<div class="empty-state">Aún no hay eventos. Crea uno después de registrar el lugar.</div>';
  $$('[data-configure]', $("#events-list")).forEach((button) => button.addEventListener("click", () => selectEvent(button.dataset.configure)));
  $$('[data-delete-event]', $("#events-list")).forEach((button) => button.addEventListener("click", () => deleteEvent(button.dataset.deleteEvent)));
  $$('[data-download-event]', $("#events-list")).forEach((button) => button.addEventListener("click", () => downloadEvent(button.dataset.downloadEvent)));
  $$('[data-delete-photos]', $("#events-list")).forEach((button) => button.addEventListener("click", () => deleteEventPhotos(button.dataset.deletePhotos)));
}
function openEventCreation() {
  navigate("events");
  $("#event-editor").hidden = true;
  $("#events-list-card").hidden = true;
  $("#event-setup-card").hidden = false;
  $("#event-setup-card").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderStaff() {
  $("#staff-list").innerHTML = state.venues.length ? state.venues.map((venue) => `<section class="admin-card"><p class="admin-eyebrow">LUGAR</p><h2>${esc(venue.name)}</h2><p class="admin-meta">${venue.active_event_name ? `Evento activo hoy: ${esc(venue.active_event_name)}` : "Sin evento activo hoy; estos enlaces mostrarán el evento de este lugar cuando esté activo."}</p><div class="admin-url"><strong>STAFF</strong><input aria-label="URL STAFF de ${esc(venue.name)}" readonly value="${esc(venue.staffUrl)}"><button class="admin-button secondary" type="button" data-copy-venue-url="staff" data-venue-id="${esc(venue.id)}">Copiar</button></div><a class="admin-link-open" href="${esc(venue.staffUrl)}" target="_blank" rel="noopener noreferrer">Abrir enlace STAFF ↗</a><div class="admin-url"><strong>INVITADOS</strong><input aria-label="URL de invitados de ${esc(venue.name)}" readonly value="${esc(venue.guestUrl)}"><button class="admin-button secondary" type="button" data-copy-venue-url="guest" data-venue-id="${esc(venue.id)}">Copiar</button></div><a class="admin-link-open" href="${esc(venue.guestUrl)}" target="_blank" rel="noopener noreferrer">Abrir enlace de invitados ↗</a></section>`).join("") : '<div class="empty-state">Cuando registres un lugar, aquí aparecerán sus URLs para STAFF e invitados.</div>';
  bindVenueUrlCopy($("#staff-list"));
}

async function selectEvent(id, tab = "details") {
  try {
    const result = await api(`/api/admin/events/${encodeURIComponent(id)}/details`);
    state.selected = id;
    state.details = result;
    $("#event-setup-card").hidden = true;
    fillEventForm(result);
    renderEventDetails();
    $("#event-editor").hidden = false;
    setEventTab(tab);
    navigate("events");
    $("#event-editor").hidden = false;
    $("#event-editor").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { message(error.message); }
}
function fillEventForm({ event, venue }) {
  const form = $("#event-edit-form");
  form.elements.name.value = event.name;
  form.elements.venueId.value = venue.id;
  form.elements.eventDate.value = event.event_date;
  form.elements.state.value = event.state;
  form.elements.contestsEnabled.checked = Boolean(event.contests_enabled);
  setCoverPreview("#event-edit-cover-preview", "#event-edit-cover-empty", event.cover_asset_id ? `/api/media/${encodeURIComponent(event.cover_asset_id)}` : "");
  $("#selected-event-title").textContent = event.name;
  $("#selected-event-state").textContent = eventStateLabel(event.state);
  $("#selected-event-state").classList.toggle("active", event.state === "active");
}
function setEventTab(tab) {
  $$('[data-event-tab]').forEach((button) => button.setAttribute("aria-pressed", button.dataset.eventTab === tab ? "true" : "false"));
  $$('[data-event-panel]').forEach((panel) => { panel.hidden = panel.dataset.eventPanel !== tab; });
}
function updateContestCriteriaFields() {
  const kind = $("#contest-form [name=kind]").value;
  $("#contest-activity-field").hidden = kind !== "first_activity_photo";
  $("#contest-close-time-field").hidden = kind !== "most_photos";
  if (kind !== "first_activity_photo") $("#contest-form [name=activityId]").value = "";
}
function renderEventDetails() {
  const { activities, guests, contests } = state.details;
  $("#activities-list").innerHTML = activities.length ? `<div class="admin-actions activity-bulk-actions"><label class="activity-select-all"><input type="checkbox" data-select-all-activities> Seleccionar varias</label><button class="admin-button secondary" type="button" data-delete-selected-activities disabled>Quitar seleccionadas</button></div>${activities.map((activity) => `<article class="admin-row-card"><div class="admin-row-top"><label class="activity-select"><input type="checkbox" data-select-activity="${esc(activity.id)}" aria-label="Seleccionar ${esc(activity.name)}"></label><div class="activity-row-content"><h3>${esc(activity.position)}. ${esc(activity.name)}</h3>${activity.description ? `<p class="admin-meta">${esc(activity.description)}</p>` : ""}${activity.reference_asset_id ? `<img class="activity-reference-thumb" src="/api/media/${encodeURIComponent(activity.reference_asset_id)}" alt="Foto de referencia de ${esc(activity.name)}" loading="lazy">` : ""}<div class="admin-meta">${timeLabel(activity.starts_at)} – ${new Date(activity.ends_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</div></div><div class="admin-actions"><button class="admin-button secondary" type="button" data-edit-activity="${esc(activity.id)}">Modificar</button><button class="admin-button secondary" type="button" data-delete-activity="${esc(activity.id)}">Quitar</button></div></div><div class="admin-meta">Fotos: ${timeLabel(activity.photo_opens_at)} a ${new Date(activity.photo_closes_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</div></article>`).join("")}` : '<div class="empty-state">Agrega los momentos de la boda para construir el minuto a minuto.</div>';
  $$('[data-delete-activity]', $("#activities-list")).forEach((button) => button.addEventListener("click", () => deactivate(`/api/admin/activities/${encodeURIComponent(button.dataset.deleteActivity)}`, "Actividad quitada.", "activities")));
  const list = $("#activities-list");
  const selectAll = list.querySelector("[data-select-all-activities]");
  const removeSelected = list.querySelector("[data-delete-selected-activities]");
  const updateSelection = () => {
    const checks = $$('[data-select-activity]', list);
    const selected = checks.filter((check) => check.checked);
    removeSelected.disabled = selected.length === 0;
    if (selectAll) { selectAll.checked = checks.length > 0 && selected.length === checks.length; selectAll.indeterminate = selected.length > 0 && selected.length < checks.length; }
  };
  selectAll?.addEventListener("change", () => { $$('[data-select-activity]', list).forEach((check) => { check.checked = selectAll.checked; }); updateSelection(); });
  $$('[data-select-activity]', list).forEach((check) => check.addEventListener("change", updateSelection));
  removeSelected?.addEventListener("click", async () => {
    const ids = $$('[data-select-activity]:checked', list).map((check) => check.dataset.selectActivity);
    if (!ids.length || !confirm(`¿Quitar ${ids.length} actividad(es) seleccionada(s) del minuto a minuto?`)) return;
    removeSelected.disabled = true;
    try {
      const result = await api("/api/admin/activities/bulk-deactivate", { method: "POST", body: JSON.stringify({ eventId: state.selected, activityIds: ids }) });
      if (Number(result.deactivatedCount) !== ids.length) throw new Error("El servidor no confirmó todas las actividades. Actualiza la lista para revisar el resultado.");
      await selectEvent(state.selected, "activities");
      await loadDashboard();
      message(`${result.deactivatedCount} actividad(es) quitada(s) del minuto a minuto.`);
    }
    catch (error) { message(error.message); removeSelected.disabled = false; }
  });
  $("#guests-list").innerHTML = guests.length ? guests.map((guest) => `<article class="admin-row-card"><div class="admin-row-top"><div><h3>${esc(guest.name)}</h3>${guest.nickname ? `<div class="admin-meta">Apodo: ${esc(guest.nickname)}</div>` : ""}<div class="admin-meta">${guest.table_name ? `Mesa ${esc(guest.table_name)} · ` : ""}${guest.active ? `${Number(guest.photos_sent || 0)} foto(s) enviadas` : "Invitación desactivada"}</div></div>${guest.active ? `<button class="admin-button secondary" type="button" data-delete-guest="${esc(guest.id)}">Desactivar</button>` : '<span class="admin-badge">Inactivo</span>'}</div></article>`).join("") : '<div class="empty-state">Agrega a las personas invitadas o carga la lista desde un archivo CSV o Excel.</div>';
  $$('[data-delete-guest]', $("#guests-list")).forEach((button) => button.addEventListener("click", () => deactivate(`/api/admin/guests/${encodeURIComponent(button.dataset.deleteGuest)}`, "Invitación desactivada.")));
  const currentActivity = $("#contest-form [name=activityId]").value;
  $("#contest-form [name=activityId]").innerHTML = '<option value="">Cierre de todo el evento</option>' + activities.filter((a) => a.active).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
  if (currentActivity) $("#contest-form [name=activityId]").value = currentActivity;
  $("#contests-list").innerHTML = contests.length ? contests.map((contest) => `<article class="admin-row-card"><div class="admin-row-top"><div><h3>${esc(contest.name)}</h3><div class="admin-meta">${contest.kind === "first_photo" ? ((contest.activity_ids || "").split(",").filter(Boolean).length === 1 ? "Primera foto de la actividad" : "Primera foto del evento") : contest.kind === "most_photos" ? "Mayor cantidad de fotos del evento" : contest.kind === "photo_with_couple" ? "Foto con los novios" : contest.kind === "bouquet" ? "Ramo" : "Selección del equipo"} · ${esc(eventStateLabel(contest.state))}</div></div><div class="admin-actions"><span class="admin-badge ${contest.prize_name ? "active" : ""}">${contest.prize_name ? `Premio: ${esc(contest.prize_name)}` : "Felicitación digital"}</span>${contest.state !== "finished" ? `<button class="admin-button secondary" type="button" data-edit-contest="${esc(contest.id)}">Modificar</button>` : ""}</div></div>${contest.validation_instructions ? `<p class="admin-meta" style="margin-bottom:0">${esc(contest.validation_instructions)}</p>` : ""}</article>`).join("") : '<div class="empty-state">Aún no hay retos o reconocimientos configurados.</div>';
}
async function deactivate(path, successText, eventTab = "details") {
  if (!confirm("¿Quieres desactivar este elemento?")) return;
  try { await api(path, { method: "DELETE" }); await selectEvent(state.selected, eventTab); await loadDashboard(); message(successText); }
  catch (error) { message(error.message); }
}

function cleanHeader(value) { return String(value ?? "").replace(/^\uFEFF/, "").toLocaleLowerCase("es-MX").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, ""); }
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
  const headers = rows[0].map(cleanHeader);
  return rows.slice(1).map((cols) => Object.fromEntries(headers.map((header, index) => [header, cols[index] || ""])));
}
function parseExcel(buffer) {
  if (!window.XLSX) throw new Error("No se pudo cargar el lector de Excel. Revisa tu conexión e inténtalo de nuevo.");
  const workbook = window.XLSX.read(buffer, { cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("El archivo no contiene una hoja de cálculo.");
  const records = window.XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
  if (!records.length) throw new Error("El archivo no contiene filas para importar.");
  return records.map((record) => Object.fromEntries(Object.entries(record).map(([key, value]) => [cleanHeader(key), value])));
}
async function readImportFile(file) {
  const extension = file.name.split(".").pop().toLocaleLowerCase("es-MX");
  if (["xls", "xlsx"].includes(extension)) return parseExcel(await file.arrayBuffer());
  return parseCSV((await file.text()).replace(/^\uFEFF/, ""));
}
function col(row, names) { for (const name of names) { const value = row[name]; if (value !== undefined && value !== null && String(value).trim()) return String(value).trim(); } return ""; }
function dateTime(value, date) {
  const formatTime = (minutes) => {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    // The API expects a venue-local timestamp with minute precision (YYYY-MM-DDTHH:mm).
    return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  };
  // Excel stores times as a fraction of a day; serial date-times also include
  // whole days, which we intentionally ignore because the event has one date.
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const fraction = value % 1;
    return formatTime(Math.round(fraction * 24 * 60) % (24 * 60));
  }
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return formatTime(value.getHours() * 60 + value.getMinutes());

  const source = String(value ?? "").trim();
  const clockSource = source.match(/^\d{4}-\d{2}-\d{2}[T ](.+)$/)?.[1] || source;
  const normalized = clockSource.normalize("NFKC").toLocaleLowerCase("es-MX")
    .replace(/[\u200b-\u200f\uFEFF]/g, "")
    .replace(/([ap])\s*\.?\s*m\.?/g, "$1m")
    .replace(/\bde\s+la\s+mañana\b/g, "am")
    .replace(/\bde\s+la\s+(?:tarde|noche)\b/g, "pm");
  const time = normalized.match(/^(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?\s*(am|pm)?$/i);
  if (time) {
    let hour = Number(time[1]);
    const minute = Number(time[2]);
    const second = Number(time[3] || 0);
    const suffix = time[4]?.toLowerCase();
    if (minute > 59 || second > 59 || (suffix ? hour < 1 || hour > 12 : hour > 23)) throw new Error(`La hora «${source}» no es válida.`);
    if (suffix) hour = (hour % 12) + (suffix === "pm" ? 12 : 0);
    return formatTime(hour * 60 + minute, second);
  }
  // Accept ISO date/time or localized date-time strings while always assigning
  // the activity to the event's configured date.
  const embeddedClock = source.match(/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}[T ,]+(.+)$/i)?.[1];
  if (embeddedClock) return dateTime(embeddedClock, date);
  throw new Error(`No se reconoce la hora «${source}». Usa, por ejemplo, 09:00, 5:30 p. m. o 17:30.`);
}
function manualEventDateTime(date, clock, period) {
  const match = String(clock || "").trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 12) throw new Error("Escribe la hora como 5:30 y elige AM o PM.");
  const hour = (Number(match[1]) % 12) + (period === "PM" ? 12 : 0);
  return `${date}T${String(hour).padStart(2, "0")}:${match[2]}`;
}
async function importFile(input, kind) {
  const file = input.files?.[0]; if (!file || !state.details) return;
  input.disabled = true;
  try {
    const rows = await readImportFile(file);
    let imported = 0;
    let skipped = 0;
    let firstRowError = "";
    if (kind === "guests") {
      for (const row of rows) {
        const firstName = col(row, ["nombre", "nombres", "nombreyapellido", "nombreapellido", "firstname", "givenname"]);
        const lastName = col(row, ["apellido", "apellidos", "lastname", "surname"]);
        const fullName = col(row, ["nombrecompleto", "invitado", "name"]);
        const name = [firstName, lastName].filter(Boolean).join(" ") || fullName;
        if (!name) { skipped++; continue; }
        try { await send("/api/admin/guests", "POST", { eventId: state.selected, firstName, lastName, name, nickname: col(row, ["apodo", "sobrenombre", "nickname", "alias"]), tableName: col(row, ["mesa", "table", "mesanumero"]) }); imported++; }
        catch (error) { skipped++; firstRowError ||= error.message; }
      }
    } else {
      let position = Math.max(0, ...state.details.activities.map((activity) => Number(activity.position) || 0));
      for (const row of rows) {
        const name = col(row, ["nombredelaactividad", "actividad", "momento", "nombre", "name"]);
        const starts = col(row, ["horadeinicio", "horainicio", "inicio", "empieza", "start", "startsat"]);
        const ends = col(row, ["horafin", "horadefin", "fin", "termina", "end", "endsat"]);
        if (!name || !starts || !ends) { skipped++; continue; }
        try { await send("/api/admin/activities", "POST", { eventId: state.selected, name, position: position + 1, startsAt: dateTime(starts, state.details.event.event_date), endsAt: dateTime(ends, state.details.event.event_date) }); position++; imported++; }
        catch (error) { skipped++; firstRowError ||= error.message; }
      }
    }
    await selectEvent(state.selected); await loadDashboard();
    message(`${imported} ${kind === "guests" ? "invitado(s)" : "actividad(es)"} importado(s).${skipped ? ` Se omitieron ${skipped} fila(s)${firstRowError ? `; primer error: ${firstRowError}` : " por falta de datos requeridos"}.` : ""}`);
  } catch (error) { message(`No se completó la importación: ${error.message}`); }
  finally { input.disabled = false; input.value = ""; }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = $("button", event.currentTarget); button.disabled = true; message("Comprobando acceso…");
  try { await send("/api/admin/session", "POST", { username: $("#username").value.trim(), password: $("#password").value }); $("#password").value = ""; await loadDashboard(); navigate("overview"); message("Sesión iniciada."); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
$("#logout").addEventListener("click", async () => { try { await api("/api/admin/session", { method: "DELETE" }); } catch {} window.location.replace("/"); });
$$('[data-view]').forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
$$('[data-go]').forEach((button) => button.addEventListener("click", () => navigate(button.dataset.go)));
$("#create-event-button").addEventListener("click", openEventCreation);
$$('[data-create-event]').forEach((button) => button.addEventListener("click", openEventCreation));
$("#create-venue-button").addEventListener("click", () => { $("#venue-editor").hidden = true; $("#venue-create-card").hidden = false; $("#venue-create-card").scrollIntoView({ behavior: "smooth", block: "start" }); });
$("#cancel-create-venue").addEventListener("click", () => { $("#venue-create-card").hidden = true; $("#admin-content").scrollTo({ top: 0, behavior: "smooth" }); });
$("#cancel-create-event").addEventListener("click", () => { $("#event-setup-card").hidden = true; $("#events-list-card").hidden = false; $("#admin-content").scrollTo({ top: 0, behavior: "smooth" }); });
$$('[data-event-tab]').forEach((button) => button.addEventListener("click", () => setEventTab(button.dataset.eventTab)));
$("#admin-content").addEventListener("scroll", (event) => { $("#admin-scroll-top").hidden = event.currentTarget.scrollTop < 240; }, { passive: true });
$("#admin-scroll-top").addEventListener("click", () => $("#admin-content").scrollTo({ top: 0, behavior: "smooth" }));

$("#venue-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button", form); button.disabled = true;
  const data = Object.fromEntries(new FormData(form)); delete data.placeCity;
  try { await send("/api/admin/venues", "POST", data); form.reset(); $("#venue-create-card").hidden = true; message("Lugar guardado."); await loadDashboard(); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
attachPlaceAutocomplete("#venue-form", "#venue-suggestions", "#venue-search-status");
attachPlaceAutocomplete("#venue-edit-form", "#venue-edit-suggestions", "#venue-edit-search-status");
$("#venue-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button[type=submit]", form); button.disabled = true;
  const data = Object.fromEntries(new FormData(form)); delete data.placeCity;
  try { await send(`/api/admin/venues/${encodeURIComponent(data.id)}`, "PUT", data); $("#venue-editor").hidden = true; message("Cambios del lugar guardados."); await loadDashboard(); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
$("#cancel-venue-edit").addEventListener("click", () => { $("#venue-editor").hidden = true; $("#venue-edit-form").reset(); });
$("#event-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button[type=submit]", form); const status = $("#setup-event-feedback"); button.disabled = true; status.textContent = "Preparando la configuración…";
  const data = { name: form.elements.name.value.trim(), venueId: form.elements.venueId.value, eventDate: form.elements.eventDate.value, state: form.elements.state.value, contestsEnabled: form.elements.contestsEnabled.checked };
  const cover = $("#event-cover-upload").files?.[0]; const cards = $$("[data-setup-activity]", form); let created = null;
  try {
    const guestFile = $("#setup-guests-file").files?.[0]; const guests = guestFile ? guestRowsFromImport(await readImportFile(guestFile)) : (setupGuestRows || []);
    const manualActivities = cards.map((card) => {
      const name = card.querySelector("[name=name]").value.trim(); const startClock = card.querySelector("[name=startClock]").value; const endClock = card.querySelector("[name=endClock]").value;
      if (!name && !startClock && !endClock) return null;
      if (name.length < 2 || !startClock || !endClock) throw new Error("Completa el nombre, la hora de inicio y la hora de fin de cada momento, o quita la tarjeta vacía.");
      const startsAt = manualEventDateTime(data.eventDate, startClock, card.querySelector("[name=startPeriod]").value); const endsAt = manualEventDateTime(data.eventDate, endClock, card.querySelector("[name=endPeriod]").value);
      return { name, description: card.querySelector("[name=description]").value.trim(), startsAt, endsAt, reference: card.querySelector("[name=reference]").files?.[0] || null, contest: card.querySelector("[name=hasContest]").checked ? { name: card.querySelector("[name=contestName]").value.trim(), kind: "first_photo", rules: card.querySelector("[name=contestRules]").value.trim(), prize: card.querySelector("[name=hasPrize]").checked ? card.querySelector("[name=prizeName]").value.trim() : "" } : null };
    }).filter(Boolean);
    const agendaFile = $("#setup-agenda-file").files?.[0];
    const importedActivities = agendaFile || setupAgendaRows ? (await (agendaFile ? readImportFile(agendaFile) : setupAgendaRows)).map((row) => {
      const name = col(row, ["nombredelaactividad", "actividad", "momento", "nombre", "name"]);
      const starts = col(row, ["horadeinicio", "horainicio", "inicio", "empieza", "start", "startsat"]);
      const ends = col(row, ["horafin", "horadefin", "fin", "termina", "end", "endsat"]);
      if (!name || !starts || !ends) throw new Error("La agenda debe tener Nombre de la actividad, Hora de inicio y Hora fin en cada fila.");
      const challengeName = col(row, ["reto", "dinamica", "nombredelreto", "contest", "challenge"]);
      const challengeKind = col(row, ["tipodereto", "tipo", "challengekind"]);
      const validKinds = ["first_photo", "most_photos", "photo_with_couple", "bouquet", "manual"];
      return { name, description: col(row, ["descripcion", "description"]), startsAt: dateTime(starts, data.eventDate), endsAt: dateTime(ends, data.eventDate), reference: null,
        contest: challengeName ? { name: challengeName, kind: validKinds.includes(challengeKind) ? challengeKind : "manual", rules: col(row, ["regla", "condicion", "condiciones", "instrucciones", "validationinstructions"]), prize: col(row, ["premio", "prize"]) } : null };
    }) : [];
    const activities = [...manualActivities, ...importedActivities].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    if (!activities.length) throw new Error("Agrega al menos un momento manualmente o carga la agenda en CSV o Excel.");
    const eventChallenge = data.contestsEnabled && $("#setup-event-challenge-enabled").checked ? { name: $("#setup-event-challenge-name").value.trim(), kind: $("#setup-event-challenge-kind").value, rules: $("#setup-event-challenge-rules").value.trim(), prize: $("#setup-event-challenge-prize-enabled").checked ? $("#setup-event-challenge-prize").value.trim() : "", closeClock: $("#setup-event-close-clock").value, closePeriod: $("#setup-event-close-period").value } : null;
    if (eventChallenge && !eventChallenge.name) throw new Error("Escribe el nombre del reto general del evento.");
    if (eventChallenge?.kind === "most_photos" && !eventChallenge.closeClock) throw new Error("Indica la hora de cierre para el reto de mayor cantidad de fotos.");
    for (const activity of activities) if (activity.contest && !activity.contest.name) throw new Error("Ponle un nombre a cada reto que agregues.");
    status.textContent = "Guardando evento, actividades, retos e invitados…";
    const requestedState = data.state; const result = await send("/api/admin/events", "POST", { ...data, state: "draft" }); created = result.event;
    if (cover) { status.textContent = "Guardando fotografía principal…"; await uploadEventAsset(created.id, cover, "event_cover"); }
    const createdActivities = [];
    for (let i = 0; i < activities.length; i++) {
      const activity = activities[i]; status.textContent = `Guardando momento ${i + 1} de ${activities.length}…`;
      const saved = await send("/api/admin/activities", "POST", { eventId: created.id, name: activity.name, description: activity.description, startsAt: activity.startsAt, endsAt: activity.endsAt, position: i + 1 });
      createdActivities.push(saved.activity);
      if (activity.reference) await uploadEventAsset(created.id, activity.reference, "activity_reference", saved.activity.id);
      if (activity.contest && data.contestsEnabled) {
        let prizeId = null;
        if (activity.contest.prize) prizeId = (await send("/api/admin/prizes", "POST", { eventId: created.id, name: activity.contest.prize, instructions: "Coordina la entrega con el STAFF." })).prize.id;
        const opensAt = new Date(Date.parse(saved.activity.starts_at) - 5 * 60000).toISOString(); const closesAt = new Date(Date.parse(saved.activity.ends_at) - 5 * 60000).toISOString();
        await send("/api/admin/contests", "POST", { eventId: created.id, name: activity.contest.name, kind: activity.contest.kind, activityIds: [saved.activity.id], opensAt, closesAt, state: data.state === "active" ? "active" : "draft", prizeId, validationInstructions: activity.contest.rules, rules: { conditions: activity.contest.rules } });
      }
    }
    if (eventChallenge && data.contestsEnabled) {
      let prizeId = null;
      if (eventChallenge.prize) prizeId = (await send("/api/admin/prizes", "POST", { eventId: created.id, name: eventChallenge.prize, instructions: "Coordina la entrega con el STAFF al cierre del evento." })).prize.id;
      const opensAt = new Date(Math.min(...createdActivities.map((item) => Date.parse(item.photo_opens_at)))).toISOString();
      const closesAt = new Date(Math.max(...createdActivities.map((item) => Date.parse(item.photo_closes_at)))).toISOString();
      const contestOpenAt = eventChallenge.kind === "first_photo" ? `${data.eventDate}T00:00` : opensAt;
      const contestCloseAt = eventChallenge.kind === "first_photo" ? nextEventDateTime(data.eventDate) : eventChallenge.kind === "most_photos" ? manualEventDateTime(data.eventDate, eventChallenge.closeClock, eventChallenge.closePeriod) : closesAt;
      await send("/api/admin/contests", "POST", { eventId: created.id, name: eventChallenge.name, kind: eventChallenge.kind, activityIds: createdActivities.map((item) => item.id), opensAt: contestOpenAt, closesAt: contestCloseAt, state: data.state === "active" ? "active" : "draft", prizeId, validationInstructions: eventChallenge.rules || (eventChallenge.prize ? "" : "Felicitación digital al cierre del evento."), rules: { scope: "event", conditions: eventChallenge.rules } });
    }
    for (const guest of guests) await send("/api/admin/guests", "POST", { eventId: created.id, ...guest });
    if (requestedState === "active") await send(`/api/admin/events/${encodeURIComponent(created.id)}`, "PUT", { ...data, state: "active" });
    status.textContent = `Evento listo. ${activities.length} momento(s) y ${guests.length} invitado(s) guardados.`;
    try { localStorage.removeItem(EVENT_DRAFT_KEY); } catch {} setupAgendaRows = null; setupGuestRows = null; form.reset(); $("#setup-activities").innerHTML = ""; setupActivityCount = 0; addSetupActivity(); $("#setup-event-challenge").hidden = true; $("#setup-event-close-time").hidden = true; $("#setup-event-prize-field").hidden = true; setCoverPreview("#event-cover-preview", "#event-cover-empty", ""); form.elements.contestsEnabled.checked = true; $("#event-setup-card").hidden = true; $("#events-list-card").hidden = false; await loadDashboard(); await selectEvent(created.id);
  } catch (error) {
    if (created?.id) { try { await api(`/api/admin/events/${encodeURIComponent(created.id)}`, { method: "DELETE" }); } catch {} status.textContent = "No se completó la configuración y se intentó retirar el evento incompleto."; }
    message(error.message); status.textContent = `${status.textContent} ${error.message}`;
  } finally { button.disabled = false; }
});
addSetupActivity();
$("#add-setup-activity").addEventListener("click", () => { addSetupActivity(); saveEventDraft(); });
$("#event-form").addEventListener("input", saveEventDraft);
$("#event-form").addEventListener("change", saveEventDraft);
restoreEventDraft();
$("#setup-event-challenge-enabled").addEventListener("change", (event) => { $("#setup-event-challenge").hidden = !event.target.checked; });
$("#setup-event-challenge-kind").addEventListener("change", (event) => { $("#setup-event-close-time").hidden = event.target.value !== "most_photos"; });
$("#setup-event-challenge-prize-enabled").addEventListener("change", (event) => { $("#setup-event-prize-field").hidden = !event.target.checked; });
$("#event-cover-upload").addEventListener("change", () => previewCoverFile("#event-cover-upload", "#event-cover-preview", "#event-cover-empty"));
$("#event-edit-cover-upload").addEventListener("change", () => previewCoverFile("#event-edit-cover-upload", "#event-edit-cover-preview", "#event-edit-cover-empty"));
$("#setup-agenda-file").addEventListener("change", async (event) => { const file = event.currentTarget.files?.[0]; if (!file) return; try { setupAgendaRows = await readImportFile(file); saveEventDraft(); $("#setup-agenda-preview").textContent = `${setupAgendaRows.length} momento(s) detectados y guardados en el borrador. Se combinarán con los momentos manuales.`; } catch (error) { $("#setup-agenda-preview").textContent = error.message; event.currentTarget.value = ""; } });
$("#setup-guests-file").addEventListener("change", async (event) => { const file = event.currentTarget.files?.[0]; if (!file) return; try { setupGuestRows = guestRowsFromImport(await readImportFile(file)); saveEventDraft(); $("#setup-guests-preview").textContent = `${setupGuestRows.length} invitado(s) listos y guardados en el borrador.`; } catch (error) { $("#setup-guests-preview").textContent = error.message; event.currentTarget.value = ""; } });
$("#event-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button", form); button.disabled = true;
  const data = Object.fromEntries(new FormData(form)); const cover = form.elements.cover.files?.[0]; delete data.cover; data.contestsEnabled = form.elements.contestsEnabled.checked;
  try { await send(`/api/admin/events/${encodeURIComponent(state.selected)}`, "PUT", data); if (cover) await uploadEventAsset(state.selected, cover, "event_cover"); message("Cambios del evento guardados."); await loadDashboard(); await selectEvent(state.selected); }
  catch (error) { message(error.message); }
  finally { button.disabled = false; }
});
$("#activities-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-activity]"); if (!button) return;
  const activity = state.details?.activities.find((item) => item.id === button.dataset.editActivity); if (!activity) return;
  const form = $("#activity-form"); const localTime = (value) => { const parts = new Intl.DateTimeFormat("en-US", { timeZone: state.details.event.timezone || "America/Mexico_City", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(value)); return { clock: `${parts.find((part) => part.type === "hour").value}:${parts.find((part) => part.type === "minute").value}`, period: parts.find((part) => part.type === "dayPeriod").value.toUpperCase() }; }; const start = localTime(activity.starts_at); const end = localTime(activity.ends_at);
  form.elements.activityId.value = activity.id; form.elements.name.value = activity.name; form.elements.description.value = activity.description || ""; form.elements.startClock.value = start.clock; form.elements.startPeriod.value = start.period; form.elements.endClock.value = end.clock; form.elements.endPeriod.value = end.period;
  setCoverPreview("#activity-reference-preview", "#activity-reference-empty", activity.reference_asset_id ? `/api/media/${encodeURIComponent(activity.reference_asset_id)}` : "");
  $("#save-activity-button").textContent = "Guardar cambios"; $("#cancel-activity-edit").hidden = false; form.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#cancel-activity-edit").addEventListener("click", (event) => { const form = $("#activity-form"); form.reset(); form.elements.activityId.value = ""; setCoverPreview("#activity-reference-preview", "#activity-reference-empty", ""); $("#save-activity-button").textContent = "Agregar actividad"; event.currentTarget.hidden = true; });
$("#activity-form").elements.reference.addEventListener("change", (event) => previewCoverFile(event.currentTarget, "#activity-reference-preview", "#activity-reference-empty"));
$("#activity-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button", form); button.disabled = true;
  const data = Object.fromEntries(new FormData(form)); const reference = form.elements.reference.files?.[0]; const activityId = data.activityId; delete data.reference; delete data.activityId; data.startsAt = manualEventDateTime(state.details.event.event_date, data.startClock, data.startPeriod); data.endsAt = manualEventDateTime(state.details.event.event_date, data.endClock, data.endPeriod); delete data.startClock; delete data.startPeriod; delete data.endClock; delete data.endPeriod; data.eventId = state.selected; data.position = activityId ? state.details.activities.find((item) => item.id === activityId)?.position : Math.max(0, ...state.details.activities.map((activity) => Number(activity.position) || 0)) + 1;
  try { const result = activityId ? await send(`/api/admin/activities/${encodeURIComponent(activityId)}`, "PUT", data) : await send("/api/admin/activities", "POST", data); if (reference) await uploadEventAsset(state.selected, reference, "activity_reference", result.activity.id); form.reset(); form.elements.activityId.value = ""; setCoverPreview("#activity-reference-preview", "#activity-reference-empty", ""); $("#save-activity-button").textContent = "Agregar actividad"; $("#cancel-activity-edit").hidden = true; message(activityId ? "Cambios de la actividad guardados." : "Actividad agregada al minuto a minuto."); await selectEvent(state.selected, "activities"); await loadDashboard(); }
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
$("#activity-csv").addEventListener("change", (event) => importFile(event.currentTarget, "activities"));
$("#guest-csv").addEventListener("change", (event) => importFile(event.currentTarget, "guests"));

if (!$("#contest-form [name=contestId]")) { const id = document.createElement("input"); id.type = "hidden"; id.name = "contestId"; $("#contest-form").prepend(id); }
$("#contests-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-contest]"); if (!button) return;
  const contest = state.details?.contests.find((item) => item.id === button.dataset.editContest); if (!contest) return;
  const form = $("#contest-form"); form.elements.contestId.value = contest.id; form.elements.name.value = contest.name;
  const linkedActivityIds = (contest.activity_ids || "").split(",").filter(Boolean);
  let contestRules = {}; try { contestRules = JSON.parse(contest.rule_json || "{}"); } catch {}
  const isActivityScoped = contestRules.scope === "activity" || (!contestRules.scope && linkedActivityIds.length === 1 && state.details.activities.filter((item) => item.active).length > 1);
  form.elements.kind.value = contest.kind === "most_photos" ? "most_photos" : contest.kind === "first_photo" && isActivityScoped ? "first_activity_photo" : "first_event_photo";
  form.elements.activityId.value = form.elements.kind.value === "first_activity_photo" ? linkedActivityIds[0] : "";
  if (form.elements.kind.value === "most_photos" && contest.closes_at) { const close = timeParts(contest.closes_at, state.details.event.timezone); form.elements.closeClock.value = close.clock; form.elements.closePeriod.value = close.period; }
  updateContestCriteriaFields();
  form.elements.hasPrize.checked = Boolean(contest.prize_id); $("#prize-fields").hidden = !contest.prize_id; $("#felicitation-fields").hidden = Boolean(contest.prize_id);
  form.elements.prizeName.value = contest.prize_name || ""; form.elements.prizeInstructions.value = contest.prize_instructions || "";
  form.elements.validationInstructions.value = contest.validation_instructions || "";
  $("button[type=submit]", form).textContent = "Guardar cambios del reto"; form.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#contest-form [name=kind]").addEventListener("change", updateContestCriteriaFields);
$("#contest-form [name=hasPrize]").addEventListener("change", (event) => { $("#prize-fields").hidden = !event.target.checked; $("#felicitation-fields").hidden = event.target.checked; });
$("#contest-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button[type=submit]", form); button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const allActivities = state.details.activities.filter((activity) => activity.active);
    const kind = values.kind === "most_photos" ? "most_photos" : "first_photo";
    const activity = values.kind === "first_activity_photo" ? allActivities.find((item) => item.id === values.activityId) : null;
    const isEventFirstPhoto = values.kind === "first_event_photo";
    if (values.kind === "first_activity_photo" && !activity) throw new Error("Selecciona la actividad cuya primera foto recibirá el premio.");
    if (kind === "most_photos" && !form.elements.closeClock.value) throw new Error("Indica la hora de cierre para el reto de mayor cantidad de fotos.");
    const activityIds = activity ? [activity.id] : allActivities.map((item) => item.id);
    const opensAt = isEventFirstPhoto ? `${state.details.event.event_date}T00:00` : activity?.photo_opens_at || (activityIds.length ? allActivities.map((a) => a.photo_opens_at).sort()[0] : new Date(`${state.details.event.event_date}T00:00:00`).toISOString());
    const closesAt = kind === "most_photos"
      ? manualEventDateTime(state.details.event.event_date, form.elements.closeClock.value, form.elements.closePeriod.value)
      : isEventFirstPhoto ? nextEventDateTime(state.details.event.event_date) : activity?.photo_closes_at || (activityIds.length ? allActivities.map((a) => a.photo_closes_at).sort().at(-1) : new Date(`${state.details.event.event_date}T23:59:00`).toISOString());
    let prizeId = null;
    if (form.elements.hasPrize.checked) {
      if (!values.prizeName.trim()) throw new Error("Escribe el nombre del premio o cambia a Felicitación digital.");
      const prize = await send("/api/admin/prizes", "POST", { eventId: state.selected, name: values.prizeName, instructions: values.prizeInstructions });
      prizeId = prize.prize.id;
    }
    const felicitacion = form.elements.hasPrize.checked ? "" : `Felicitación digital: ${values.felicitation || "¡Gracias por compartir este momento!"}`;
    const instructions = [felicitacion, values.validationInstructions.trim()].filter(Boolean).join("\n\n");
    const contestId = values.contestId;
    await send(contestId ? `/api/admin/contests/${encodeURIComponent(contestId)}` : "/api/admin/contests", contestId ? "PUT" : "POST", { eventId: state.selected, name: values.name, kind, activityIds, opensAt, closesAt, prizeId, validationInstructions: instructions, rules: { scope: activity ? "activity" : "event", conditions: values.validationInstructions }, state: "active" });
    form.reset(); updateContestCriteriaFields(); button.textContent = "Guardar reto"; $("#prize-fields").hidden = false; $("#felicitation-fields").hidden = true; await selectEvent(state.selected, "contests"); message(contestId ? "Cambios del reto guardados." : "Reto guardado y visible para el STAFF.");
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
});

api("/api/admin/session").then(async (session) => { if (session.authenticated) { await loadDashboard(); navigate("overview"); } else showLoggedOut(); }).catch(() => showLoggedOut());
