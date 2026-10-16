const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const demoEvent = {
  id: "demo-event",
  name: "Isa & Mateo",
  date: "2026-10-15",
  demo: true,
  moments: [
    { id: "demo-entrada", name: "Entrada de los novios", state: "sample", start: "17:00" },
    { id: "demo-brindis", name: "El brindis", state: "sample", start: "19:30" },
    { id: "demo-baile", name: "Primer baile", state: "sample", start: "21:00" },
    { id: "demo-fiesta", name: "Fiesta y pista", state: "sample", start: "22:00" },
  ],
};
let eventData = { name: "Entre Momentos", moments: [] };
let guest = null;
let moments = [];
let submissions = new Map();
let selectedMomentIndex = 0;
let selectedPhoto = null;
let previewUrl = "";
let uploadRequestId = "";
let staffDashboard = null;
let staffAuthenticated = false;
let isDemo = false;
let demoSearchEnabled = false;
let isSending = false;
let dragStartX = null;
let serverClockOffset = 0;
let refreshingEvent = false;

function screen(name) {
  $$(".screen").forEach((item) => { item.hidden = item.id !== "screen-" + name; });
  document.body.dataset.screen = name;
}

async function api(path, options = {}) {
  const eventSlug = new URLSearchParams(window.location.search).get("event");
  if (eventSlug && (/^\/api\/guests\/identify(?:\/select)?$/.test(path) || path === "/api/events/current")) {
    const scoped = new URL(path, window.location.origin);
    scoped.searchParams.set("event", eventSlug);
    path = scoped.pathname + scoped.search;
  }
  let response;
  try { response = await fetch(path, { credentials: "include", ...options }); }
  catch { throw new Error("No hay conexión con el servicio del evento."); }
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(payload?.message || (response.status === 404 ? "Este servicio aún no está conectado." : "No se pudo completar la solicitud."));
  if (!payload) throw new Error("El servidor no confirmó la operación.");
  return payload;
}

function setEvent(data) {
  eventData = data || {};
  if (eventData.serverTime) {
    const serverTime = new Date(eventData.serverTime).getTime();
    if (Number.isFinite(serverTime)) serverClockOffset = serverTime - Date.now();
  }
  moments = Array.isArray(eventData.moments) ? eventData.moments : [];
  const date = eventData.date ? new Date(eventData.date + "T12:00:00") : null;
  const dateLabel = date && !Number.isNaN(date.valueOf())
    ? date.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" })
    : eventData.demo ? "VISTA DE DEMOSTRACIÓN" : "ÁLBUM DE BODA";
  $("#event-name-display").textContent = eventData.name || "Entre Momentos";
  $("#event-date-display").textContent = dateLabel.toLocaleUpperCase("es-MX");
  $("#home-event-kicker").textContent = dateLabel.toLocaleUpperCase("es-MX");
  $("#staff-event-kicker").textContent = (eventData.name || "EVENTO").toLocaleUpperCase("es-MX");
  const cover = eventData.coverUrl || "";
  if (cover) {
    const imageLayer = "linear-gradient(180deg,#1b292322 15%,#1b2923d9 100%),url(\"" + cover + "\")";
    $("#event-cover").style.backgroundImage = imageLayer;
    $("#event-backdrop").style.backgroundImage = imageLayer;
  } else {
    $("#event-cover").style.removeProperty("background-image");
    $("#event-backdrop").style.removeProperty("background-image");
  }
  $("#demo-badge").hidden = !eventData.demo;
  if (date && !Number.isNaN(date.valueOf())) {
    $("#schedule-date").textContent = date.toLocaleDateString("es-MX", { day: "numeric", month: "long" }).toLocaleUpperCase("es-MX");
  }
}

function showHome(profile, data, demo = false) {
  guest = profile;
  isDemo = demo;
  setEvent(data || demoEvent);
  submissions = new Map();
  (profile?.submissions || []).forEach((item) => submissions.set(String(item.momentId), item));
  $("#home-guest-name").textContent = profile?.name || profile?.displayName || "invitado";
  const count = eventData.presence?.activeCount;
  $("#connected-count").textContent = Number.isInteger(count) ? String(count) : "Invitados";
  $("#presence-status").textContent = Number.isInteger(count) ? "personas activas" : "Sin datos en vivo";
  const active = moments.findIndex((moment) => moment.id === eventData.activeMomentId || moment.state === "active");
  const next = moments.findIndex((moment) => moment.id === eventData.nextMomentId || moment.state === "upcoming");
  selectedMomentIndex = active >= 0 ? active : next >= 0 ? next : 0;
  renderCarousel();
  renderSchedule();
  resetUploadPanel();
  screen("home");
}

function momentStatus(moment) {
  const submission = submissions.get(String(moment.id));
  if (submission) return submission.eligible === true ? "Foto enviada · participa" : "Foto enviada · fuera del reto";
  if (moment.state === "active") return "Momento activo";
  if (moment.state === "finished") return "Momento finalizado";
  if (moment.state === "upcoming") return "Próximo momento";
  return "Momento del evento";
}

function updateMomentPrompt() {
  const moment = moments[selectedMomentIndex];
  const prompt = $("#moment-prompt");
  if (!moment) { prompt.textContent = "La agenda aún no está disponible."; return; }
  if (isDemo) { prompt.textContent = "Vista de ejemplo · " + (moment.start || "") + " · no hay cuenta regresiva real."; return; }
  const opensAt = moment.photoOpensAt || moment.captureOpensAt;
  const closesAt = moment.photoClosesAt || moment.captureClosesAt;
  const opens = opensAt ? new Date(opensAt).getTime() : NaN;
  const closes = closesAt ? new Date(closesAt).getTime() : NaN;
  const now = Date.now() + serverClockOffset;
  if (Number.isFinite(opens) && now < opens) {
    const seconds = Math.ceil((opens - now) / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    const remaining = minutes ? minutes + " min" + (remainder ? " " + remainder + " s" : "") : remainder + " s";
    prompt.textContent = "Prepárate para la foto de " + moment.name + " en " + remaining;
  } else if (Number.isFinite(closes) && now < closes) {
    prompt.textContent = "Ya puedes subir la foto de " + moment.name;
  } else if (Number.isFinite(closes) && now >= closes) {
    prompt.textContent = "El reto terminó. Aún puedes compartir tu recuerdo de " + moment.name + ".";
  } else if (moment.state === "active") {
    prompt.textContent = "Ya puedes compartir tu foto de " + moment.name;
  } else {
    prompt.textContent = moment.name + (moment.start ? " · " + moment.start : "") + ". Puedes compartir tu foto en cualquier momento.";
  }
}

function renderCarousel() {
  const rail = $("#moment-carousel");
  rail.replaceChildren();
  const dots = $("#carousel-pagination");
  dots.replaceChildren();
  if (!moments.length) {
    const empty = document.createElement("p");
    empty.className = "empty-carousel";
    empty.textContent = "La agenda del evento aún no está disponible.";
    rail.append(empty);
    $("#selected-moment-state").textContent = "AGENDA PENDIENTE";
    $("#upload-hint").textContent = "Vuelve cuando el programa esté conectado.";
    $("#gallery-button").hidden = true;
    return;
  }
  $("#gallery-button").hidden = false;
  moments.forEach((moment, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "moment-card";
    card.classList.toggle("is-active-moment", moment.state === "active");
    card.setAttribute("aria-label", moment.name + ". " + momentStatus(moment) + ". Seleccionar para subir foto.");
    card.setAttribute("aria-current", index === selectedMomentIndex ? "true" : "false");
    if (moment.coverUrl) card.style.backgroundImage = "linear-gradient(160deg,#0002,#29352fcc),url(\"" + moment.coverUrl + "\")";
    const badge = document.createElement("span");
    badge.className = "moment-card-status";
    badge.textContent = isDemo ? "EJEMPLO" : momentStatus(moment);
    const title = document.createElement("span");
    title.className = "moment-card-name";
    title.textContent = moment.name || "Momento";
    const time = document.createElement("span");
    time.className = "moment-card-meta";
    time.textContent = moment.start || moment.startTime || "";
    const submission = submissions.get(String(moment.id));
    card.append(badge, title, time);
    if (submission?.thumbnailUrl) {
      const thumbnail = document.createElement("img");
      thumbnail.className = "moment-thumbnail";
      thumbnail.src = submission.thumbnailUrl;
      thumbnail.alt = "Vista previa de tu foto enviada";
      card.append(thumbnail);
    }
    card.addEventListener("click", () => selectMoment(index, true));
    rail.append(card);
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "carousel-dot";
    dot.setAttribute("aria-label", "Mostrar momento " + (index + 1) + ": " + moment.name);
    dot.setAttribute("aria-current", index === selectedMomentIndex ? "true" : "false");
    dot.addEventListener("click", () => selectMoment(index, false));
    dots.append(dot);
  });
  updateCarousel();
}

function updateCarousel() {
  const cards = $$(".moment-card", $("#moment-carousel"));
  cards.forEach((card, index) => {
    let offset = index - selectedMomentIndex;
    if (offset > moments.length / 2) offset -= moments.length;
    if (offset < -moments.length / 2) offset += moments.length;
    const distance = Math.abs(offset);
    card.style.transform = "translateX(calc(-50% + " + offset * 73 + "px)) scale(" + Math.max(.76, 1 - distance * .12) + ") rotateY(" + (-offset * 10) + "deg)";
    card.style.zIndex = String(10 - distance);
    card.style.opacity = distance > 1 ? "0" : distance ? ".72" : "1";
    card.style.pointerEvents = distance > 1 ? "none" : "auto";
    card.setAttribute("aria-current", index === selectedMomentIndex ? "true" : "false");
  });
  $$(".carousel-dot", $("#carousel-pagination")).forEach((dot, index) => dot.setAttribute("aria-current", index === selectedMomentIndex ? "true" : "false"));
  const current = moments[selectedMomentIndex];
  updateMomentPrompt();
  if (!current) return;
  const submission = submissions.get(String(current.id));
  $("#selected-moment-state").textContent = (isDemo ? "EJEMPLO · " : "") + momentStatus(current).toLocaleUpperCase("es-MX");
  $("#upload-hint").textContent = isDemo
    ? "Prueba el flujo. La foto no se enviará ni se guardará."
    : submission ? "Ya compartiste una foto para este momento."
      : "Tu foto se enviará a «" + current.name + "». Solo una por invitado.";
  $("#send-photo").disabled = Boolean(submission) || isDemo || isSending;
}

function selectMoment(index, openPanel) {
  if (!moments.length) return;
  selectedMomentIndex = (index + moments.length) % moments.length;
  updateCarousel();
  if (openPanel) openUploadPanel();
}
function moveCarousel(amount) { if (moments.length) selectMoment(selectedMomentIndex + amount, false); }

function renderSchedule() {
  const list = $("#public-schedule");
  list.replaceChildren();
  moments.forEach((moment) => {
    const row = document.createElement("div");
    row.className = "public-activity";
    const time = document.createElement("time");
    time.textContent = moment.start || moment.startTime || "—";
    const mark = document.createElement("span");
    mark.className = "public-activity-mark";
    const title = document.createElement("strong");
    title.textContent = moment.name;
    row.append(time, mark, title);
    list.append(row);
  });
  $("#schedule-note").textContent = isDemo ? "Vista de demostración; no muestra datos reales." : "Horarios actualizados por la coordinación del evento.";
}

function openUploadPanel() {
  if (!moments.length) return toast("La agenda aún no está disponible.");
  $("#upload-panel").classList.add("open");
}
function clearPhotoPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = "";
  selectedPhoto = null;
  uploadRequestId = "";
  $("#gallery-input").value = "";
  $("#photo-preview").removeAttribute("src");
  $("#photo-review").hidden = true;
  $("#gallery-button").hidden = !moments.length;
  $("#send-photo").disabled = true;
  $("#photo-feedback").textContent = "";
}
function resetUploadPanel() {
  clearPhotoPreview();
  $("#upload-panel").classList.remove("open");
  $("#upload-hint").textContent = moments.length ? "Selecciona un momento para empezar." : "La agenda aún no está disponible.";
}
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 4200);
}
function requestId() { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2); }

function guestChoice(profile) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "guest-result";
  const initial = document.createElement("span");
  initial.className = "guest-initial";
  initial.textContent = (profile.name || "I").slice(0, 1).toLocaleUpperCase("es-MX");
  const identity = document.createElement("span");
  identity.className = "guest-identity";
  const name = document.createElement("strong");
  name.textContent = profile.name || "Invitado";
  const reference = document.createElement("small");
  reference.textContent = profile.reference || "Toca para entrar al álbum";
  identity.append(name, reference);
  const arrow = document.createElement("span");
  arrow.className = "result-arrow";
  arrow.textContent = "→";
  button.append(initial, identity, arrow);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      if (demoSearchEnabled) {
        showHome({ id: profile.id, name: profile.name, table: profile.reference?.replace(/^Mesa /, "") }, demoEvent, true);
        return;
      }
      await enterGuest(await api("/api/guests/identify/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ guestId: profile.id }) }));
    }
    catch (error) { button.disabled = false; $("#search-message").textContent = error.message; }
  });
  $("#guest-results").append(button);
}

async function enterGuest(response) {
  const profile = response.guest || response.profile;
  if (!profile?.id) throw new Error("El servicio no confirmó tu identidad.");
  const payload = response.event ? response : await api("/api/events/current");
  const eventPayload = payload.event ? { ...payload.event, serverTime: payload.serverTime || payload.event.serverTime } : payload;
  const signedIn = { ...(payload.guest || profile), submissions: payload.submissions || payload.guest?.submissions || profile.submissions || [] };
  showHome(signedIn, eventPayload, false);
}

async function refreshEvent() {
  if (isDemo || !guest || refreshingEvent) return;
  refreshingEvent = true;
  try {
    const payload = await api("/api/events/current");
    const currentEvent = payload.event ? { ...payload.event, serverTime: payload.serverTime || payload.event.serverTime } : payload;
    setEvent(currentEvent);
    if (Array.isArray(payload.submissions)) {
      submissions = new Map(payload.submissions.map((item) => [String(item.momentId), item]));
    }
    renderCarousel();
    renderSchedule();
  } catch { /* Keep the last confirmed schedule if the service is temporarily unavailable. */ }
  finally { refreshingEvent = false; }
}

$("#guest-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#guest-search").value.trim();
  $("#search-message").textContent = "Buscando tu nombre…";
  $("#guest-results").replaceChildren();
  $("#guest-results").hidden = true;
  if (demoSearchEnabled) {
    const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-MX");
    if (!normalized.includes("ana")) {
      $("#search-message").textContent = "En esta prueba, escribe Ana para ver a las dos invitadas homónimas.";
      return;
    }
    $("#search-message").textContent = "Encontré dos personas con ese nombre. Elige una mesa para continuar.";
    [
      { id: "demo-ana-4", name: "Ana López", reference: "Mesa 4" },
      { id: "demo-ana-8", name: "Ana López", reference: "Mesa 8" },
    ].forEach((profile) => guestChoice(profile));
    $("#guest-results").hidden = false;
    return;
  }
  try {
    const result = await api("/api/guests/identify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (Array.isArray(result.matches)) {
      $("#search-message").textContent = result.matches.length > 1 ? "Encontré varias personas. Elige la tuya." : "Confirma que eres tú.";
      result.matches.forEach((profile) => guestChoice(profile));
      $("#guest-results").hidden = false;
    } else await enterGuest(result);
  } catch (error) { $("#search-message").textContent = error.message; }
});

$("#demo-entry").addEventListener("click", () => {
  demoSearchEnabled = true;
  $("#guest-search").value = "Ana";
  $("#guest-results").replaceChildren();
  $("#guest-results").hidden = true;
  $("#search-message").textContent = "Prueba con Ana y elige entre las dos personas.";
  $("#guest-search").focus();
});
$("#home-upload").addEventListener("click", openUploadPanel);
$("#home-dedication").addEventListener("click", () => { $("#message-feedback").textContent = ""; screen("message"); });
$("#home-schedule").addEventListener("click", () => screen("schedule"));
$("#cancel-upload").addEventListener("click", resetUploadPanel);
$("#carousel-prev").addEventListener("click", () => moveCarousel(-1));
$("#carousel-next").addEventListener("click", () => moveCarousel(1));
$("#carousel-stage").addEventListener("pointerdown", (event) => { dragStartX = event.clientX; });
$("#carousel-stage").addEventListener("pointerup", (event) => {
  if (dragStartX === null) return;
  const delta = event.clientX - dragStartX;
  if (Math.abs(delta) > 40) moveCarousel(delta < 0 ? 1 : -1);
  dragStartX = null;
});
$("#carousel-stage").addEventListener("pointercancel", () => { dragStartX = null; });
$$('[data-back="home"]').forEach((button) => button.addEventListener("click", () => screen("home")));
$("#home-button").addEventListener("click", () => screen(guest ? "home" : "welcome"));

$("#gallery-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file || !file.type.startsWith("image/")) { $("#photo-feedback").textContent = "Selecciona una imagen."; return; }
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  selectedPhoto = file;
  previewUrl = URL.createObjectURL(file);
  uploadRequestId = requestId();
  $("#photo-preview").src = previewUrl;
  $("#photo-review").hidden = false;
  $("#gallery-button").hidden = true;
  $("#photo-feedback").textContent = isDemo ? "Demostración: la foto no se enviará ni guardará." : "Confirma el momento antes de enviarla.";
  updateCarousel();
});
$("#change-photo").addEventListener("click", () => {
  $("#gallery-button").hidden = false;
  $("#photo-feedback").textContent = "Selecciona otra imagen para reemplazar esta vista previa.";
  $("#gallery-input").click();
});
$("#cancel-photo").addEventListener("click", clearPhotoPreview);
$("#send-photo").addEventListener("click", async () => {
  const moment = moments[selectedMomentIndex];
  if (!selectedPhoto || !moment || isSending || isDemo) return;
  isSending = true;
  $("#send-photo").disabled = true;
  $("#photo-feedback").textContent = "Enviando…";
  try {
    const form = new FormData();
    form.append("photo", selectedPhoto, selectedPhoto.name);
    form.append("momentId", String(moment.id));
    const result = await api("/api/photos", { method: "POST", headers: { "Idempotency-Key": uploadRequestId }, body: form });
    if (!result.submission?.id) throw new Error("El servicio no confirmó la foto.");
    submissions.set(String(moment.id), { ...result.submission, momentId: moment.id });
    const eligible = result.submission.eligible === true;
    clearPhotoPreview();
    renderCarousel();
    $("#upload-panel").classList.remove("open");
    toast("¡Gracias por compartir tu foto! Tu recuerdo ya forma parte de esta historia" + (eligible ? "" : " · Fuera del reto"));
  } catch (error) {
    $("#photo-feedback").textContent = error.message + " La imagen sigue solo en memoria; puedes reintentar.";
    $("#send-photo").disabled = false;
  } finally { isSending = false; }
});

$("#message-text").addEventListener("input", (event) => { $("#message-count").textContent = event.target.value.length + " / 240"; });
$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isDemo) { $("#message-feedback").textContent = "Demostración: la dedicatoria no se envió ni guardó."; return; }
  const button = $("button[type=submit]", event.currentTarget);
  button.disabled = true;
  $("#message-feedback").textContent = "Enviando dedicatoria…";
  try {
    const result = await api("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: $("#message-text").value.trim() }) });
    if (!result.messageId) throw new Error("El servicio no confirmó la dedicatoria.");
    $("#message-text").value = "";
    $("#message-count").textContent = "0 / 240";
    toast("¡Gracias! Tu dedicatoria quedó guardada.");
    screen("home");
  } catch (error) { $("#message-feedback").textContent = error.message + " Puedes reintentar."; }
  finally { button.disabled = false; }
});

$("#staff-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("button[type=submit]", event.currentTarget);
  button.disabled = true;
  $("#staff-login-feedback").textContent = "Verificando acceso…";
  try {
    const login = await api("/api/staff/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: $("#staff-email").value.trim(), password: $("#staff-password").value }) });
    if (login.authenticated !== true || login.role !== "staff") throw new Error("La cuenta no tiene acceso de staff.");
    staffAuthenticated = true;
    staffDashboard = await api("/api/staff/dashboard");
    renderStaff();
    screen("admin");
  } catch (error) { staffAuthenticated = false; $("#staff-login-feedback").textContent = error.message + " El panel permanece cerrado."; }
  finally { button.disabled = false; }
});

function renderStaff() {
  if (!staffAuthenticated || !staffDashboard) return;
  const list = $("#activity-list");
  list.replaceChildren();
  const program = staffDashboard.moments || [];
  $("#program-feedback").textContent = program.length ? "Agenda conectada." : "No hay programa disponible.";
  program.forEach((moment, index) => {
    const row = document.createElement("article");
    row.className = "activity-row";
    const number = document.createElement("span");
    number.className = "activity-index";
    number.textContent = String(index + 1).padStart(2, "0");
    const fields = document.createElement("div");
    fields.className = "activity-fields";
    const title = document.createElement("strong");
    title.textContent = moment.name || "Momento";
    const detail = document.createElement("small");
    detail.textContent = (moment.start || "—") + " · " + (moment.stateLabel || moment.state || "Estado pendiente");
    fields.append(title, detail);
    row.append(number, fields);
    list.append(row);
  });
  renderStaffTables(staffDashboard.tables || []);
  renderStaffContests(staffDashboard.contests || []);
  const event = staffDashboard.event || {};
  $("#staff-event-name").value = event.name || "";
  $("#staff-event-date").value = event.date || "";
  $("#staff-drive-url").value = event.driveFolderUrl || "";
}
function renderStaffTables(tables) {
  const root = $("#staff-tables");
  root.replaceChildren();
  if (!tables.length) { root.textContent = "No hay mesas conectadas."; return; }
  tables.forEach((table) => {
    const section = document.createElement("section");
    section.className = "table-card";
    const title = document.createElement("h3");
    title.textContent = table.name || "Mesa";
    section.append(title);
    (table.guests || []).forEach((person) => {
      const row = document.createElement("div");
      row.className = "table-guest";
      row.textContent = person.name + " · " + (person.participationState || "Sin participación");
      section.append(row);
    });
    root.append(section);
  });
}
function renderStaffContests(contests) {
  const root = $("#staff-contests");
  root.replaceChildren();
  if (!contests.length) { root.textContent = "No hay retos conectados."; return; }
  contests.forEach((contest) => {
    const card = document.createElement("article");
    card.className = "contest-card";
    const title = document.createElement("h3");
    title.textContent = contest.name || contest.momentName || "Reto";
    const timing = document.createElement("p");
    timing.textContent = (contest.opensAt || "—") + " a " + (contest.closesAt || "—") + " · " + (contest.state || "Estado pendiente");
    card.append(title, timing);
    if (contest.prize) {
      const prize = document.createElement("small");
      prize.textContent = "Premio: " + contest.prize;
      card.append(prize);
    }
    (contest.participants || []).forEach((person) => {
      const row = document.createElement("article");
      row.className = "contest-entry";
      if (person.thumbnailUrl) {
        const photo = document.createElement("img");
        photo.src = person.thumbnailUrl;
        photo.alt = "Foto enviada por " + (person.name || "invitado");
        row.append(photo);
      }
      const detail = document.createElement("div");
      detail.className = "contest-entry-detail";
      const name = document.createElement("strong");
      name.textContent = (person.name || "Invitado") + (person.table ? " · " + person.table : "");
      const meta = document.createElement("small");
      const receivedAt = person.receivedAt ? new Date(person.receivedAt).toLocaleString("es-MX", { hour: "2-digit", minute: "2-digit" }) : "Hora sin confirmar";
      meta.textContent = receivedAt + " · " + (person.eligible ? "Elegible" : "Recuerdo · no elegible") + (person.validationState ? " · " + person.validationState : "");
      detail.append(name, meta);
      row.append(detail);
      card.append(row);
      if (contest.requiresStaffWinner && person.eligible && contest.state !== "finished") {
        const winner = document.createElement("button");
        winner.type = "button";
        winner.className = "secondary-button";
        winner.textContent = "Confirmar como ganador";
        winner.addEventListener("click", () => postStaffAction("/api/staff/contests/" + encodeURIComponent(contest.id) + "/winner", { participantId: person.id }));
        card.append(winner);
      }
    });
    if (contest.state === "open") {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "secondary-button";
      close.textContent = "Cerrar reto";
      close.addEventListener("click", () => postStaffAction("/api/staff/contests/" + encodeURIComponent(contest.id) + "/close"));
      card.append(close);
    }
    root.append(card);
  });
}
async function postStaffAction(path, body) {
  try {
    await api(path, { method: "POST", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    staffDashboard = await api("/api/staff/dashboard");
    renderStaff();
  } catch (error) { toast(error.message); }
}

$(".admin-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest(".admin-tab");
  if (!tab || !staffAuthenticated) return;
  $$(".admin-tab").forEach((item) => item.classList.toggle("active", item === tab));
  $$(".admin-view").forEach((view) => { view.hidden = view.id !== "admin-" + tab.dataset.tab; });
});
$("#staff-event-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!staffAuthenticated) return;
  const form = new FormData();
  form.append("name", $("#staff-event-name").value.trim());
  form.append("date", $("#staff-event-date").value);
  form.append("driveFolderUrl", $("#staff-drive-url").value.trim());
  const cover = $("#staff-cover-image").files?.[0];
  if (cover) form.append("cover", cover, cover.name);
  const button = $("button[type=submit]", event.currentTarget);
  button.disabled = true;
  $("#staff-event-feedback").textContent = "Guardando evento…";
  try {
    const result = await api("/api/staff/event", { method: "PUT", body: form });
    if (!result.event) throw new Error("El servidor no confirmó los cambios.");
    staffDashboard.event = result.event;
    setEvent(result.event);
    $("#staff-event-feedback").textContent = "Evento actualizado.";
  } catch (error) { $("#staff-event-feedback").textContent = error.message + " No se guardaron cambios."; }
  finally { button.disabled = false; }
});
$("#close-admin").addEventListener("click", async () => {
  try { await api("/api/staff/session", { method: "DELETE" }); } catch { /* The local panel is closed even if logout cannot reach the server. */ }
  staffAuthenticated = false;
  staffDashboard = null;
  screen(guest ? "home" : "welcome");
});
$("#home-button").addEventListener("click", () => screen(guest ? "home" : "welcome"));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => registrations.forEach((registration) => registration.unregister())).catch(() => {});
  if ("caches" in window) caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("entre-momentos-" )).map((key) => caches.delete(key)))).catch(() => {});
}
api("/api/events/current").then((payload) => setEvent(payload.event ? { ...payload.event, serverTime: payload.serverTime || payload.event.serverTime } : payload)).catch(() => {});
window.setInterval(() => {
  if (document.body.dataset.screen === "home") updateMomentPrompt();
}, 1000);
window.setInterval(() => { if (guest && !isDemo) refreshEvent(); }, 30000);
screen("welcome");
