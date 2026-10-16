const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const storageFallback = new Map();
const demoGuests = [
  { name: "Ana García", detail: "Familia de la novia" },
  { name: "Ana García", detail: "Familia del novio" },
  { name: "Carlos López", detail: "Familia del novio" },
  { name: "María Torres", detail: "Amiga de la pareja" },
  { name: "Luis Hernández", detail: "Familia de la novia" },
];
const defaultActivities = [
  { name: "El brindis", start: "19:30", end: "20:00" },
  { name: "El primer baile", start: "21:00", end: "21:30" },
  { name: "La pista se llena", start: "22:00", end: "22:30" },
];
let activities = readJSON("em-activities", defaultActivities);
let currentGuest = "";
let currentGuestId = "";
let activityIndex = 0;
let countdownSeconds = 300;
let openSeconds = 0;
let isPreviewOpen = false;
let selectedPhoto = null;
let photoUrl = "";
let photoIsOnTime = false;
let photoIsPreview = false;
let clockInterval = null;

function read(key) {
  try { return localStorage.getItem(key) ?? storageFallback.get(key) ?? null; }
  catch { return storageFallback.get(key) ?? null; }
}
function write(key, value) {
  storageFallback.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* Keep the mockup usable from a local HTML file. */ }
}
function readJSON(key, fallback) {
  try {
    const value = JSON.parse(read(key) || "null");
    return Array.isArray(value) && value.length ? value : fallback;
  } catch { return fallback; }
}
function safeKey(value) { return value.trim().toLocaleLowerCase("es-MX").replace(/\s+/g, "-"); }
function quotaKey(activity = activities[activityIndex]) {
  return `em-photo:${safeKey(currentGuestId || currentGuest)}:${activityIndex}:${safeKey(activity.name)}`;
}
function screen(name) {
  $$(".screen").forEach((element) => { element.hidden = element.id !== `screen-${name}`; });
  document.body.dataset.screen = name;
}
function getActivity() { return activities[activityIndex] || defaultActivities[0]; }
function updateEventCover() {
  const eventName = $("#event-name").value.trim() || "Ana & Carlos";
  const eventDate = $("#event-date").value;
  $("#event-name-display").textContent = eventName;
  if (eventDate) {
    const date = new Date(eventDate + "T12:00:00");
    $("#event-date-display").textContent = date.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" }).toLocaleUpperCase("es-MX");
    $("#schedule-date").textContent = date.toLocaleDateString("es-MX", { day: "numeric", month: "long" }).toLocaleUpperCase("es-MX");
  }
  const coverImage = read("em-cover:" + safeKey(eventName));
  if (coverImage) {
    $("#event-cover").style.backgroundImage = "linear-gradient(180deg, #24332c00 38%, #1b2825c9 100%), url(\"" + coverImage + "\")";
    $("#event-cover").classList.add("has-cover-image");
  } else {
    $("#event-cover").style.removeProperty("background-image");
    $("#event-cover").classList.remove("has-cover-image");
  }
}
function renderPublicSchedule() {
  const list = $("#public-schedule");
  list.replaceChildren();
  activities.slice(0, 5).forEach((activity) => {
    const row = document.createElement("div");
    row.className = "public-activity";
    row.innerHTML = '<time></time><span class="public-activity-mark"></span><strong></strong>';
    $("time", row).textContent = activity.start;
    $("strong", row).textContent = activity.name;
    list.append(row);
  });
}
function formatSeconds(value) {
  const n = Math.max(0, value);
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}
function activityPhotoWindowSeconds(activity) {
  const toMinutes = (time) => {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  };
  return Math.max(60, (toMinutes(activity.end) - toMinutes(activity.start) - 10) * 60);
}
function refreshMoment() {
  const activity = getActivity();
  const opened = isPreviewOpen || openSeconds > 0;
  const closed = !isPreviewOpen && openSeconds <= 0 && countdownSeconds <= 0;
  $("#moment-title").textContent = activity.name;
  $("#photo-activity-name").textContent = activity.name.toLocaleUpperCase("es-MX");
  $("#moment-time").textContent = activity.start;
  $("#camera-input").disabled = !opened && !closed;
  $("#camera-button").classList.toggle("is-disabled", !opened && !closed);
  $("#camera-button").classList.toggle("is-late", closed);
  $("#moment-state").textContent = isPreviewOpen ? "VISTA PREVIA" : opened ? "MOMENTO ABIERTO" : closed ? "MOMENTO CERRADO" : "PRÓXIMO MOMENTO";
  $("#moment-prompt").innerHTML = isPreviewOpen
    ? `Vista previa de la cámara<br /><strong>Lista para probar</strong>`
    : opened
      ? `Ya puedes tomar la foto<br /><strong>${activity.name}</strong>`
      : closed
        ? `La toma de este momento<br /><strong>ya cerró</strong>`
        : `Prepárate para tomar la foto<br /><strong>en <span id="countdown">${formatSeconds(countdownSeconds)}</span></strong>`;
  $("#camera-instruction").textContent = opened ? "Tu foto cuenta para la dinámica." : closed ? "Puedes subirla al álbum; ya no cuenta para la dinámica." : "La carga se activa cinco minutos antes.";
  $("#camera-button-label").textContent = opened ? "Subir mi foto" : closed ? "Subir al álbum" : "Aún no";
  $("#preview-open").hidden = isPreviewOpen || opened || closed;
  const alreadyShared = currentGuest && read(quotaKey());
  if (alreadyShared) {
    $("#camera-input").disabled = true;
    $("#camera-button").classList.add("is-disabled");
    $("#camera-button").classList.remove("is-late");
    $("#camera-button-label").textContent = "Foto enviada";
    $("#camera-instruction").textContent = "Ya compartiste tu foto de este momento.";
    $("#moment-state").textContent = "MOMENTO COMPARTIDO";
    $("#moment-prompt").innerHTML = `Gracias por ayudar<br /><strong>con este momento.</strong>`;
    $("#preview-open").hidden = true;
  }
}
function clearTemporaryPhoto() {
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = "";
  selectedPhoto = null;
  $("#camera-input").value = "";
  $("#photo-preview").removeAttribute("src");
  $("#photo-preview").hidden = true;
  $("#photo-empty").hidden = false;
}
function beginGuestFlow(guest) {
  const guestName = typeof guest === "string" ? guest : guest.name;
  currentGuest = guestName;
  currentGuestId = typeof guest === "string" ? guestName : `${guest.name}-${guest.detail}`;
  activityIndex = 0;
  countdownSeconds = 300;
  openSeconds = 0;
  isPreviewOpen = false;
  clearInterval(clockInterval);
  screen("moment");
  refreshMoment();
  clockInterval = setInterval(() => {
    if (isPreviewOpen) return;
    if (countdownSeconds > 0) {
      countdownSeconds -= 1;
      if (countdownSeconds === 0) openSeconds = activityPhotoWindowSeconds(getActivity());
    }
    else if (openSeconds > 0) openSeconds -= 1;
    refreshMoment();
  }, 1000);
}
function addGuestResult(guest) {
  const button = document.createElement("button");
  button.className = "guest-result";
  button.type = "button";
  button.innerHTML = `<span class="guest-initial"></span><span class="guest-identity"><strong></strong><small></small></span><span class="result-arrow">→</span>`;
  $(".guest-initial", button).textContent = guest.name.slice(0, 1);
  $(".guest-identity strong", button).textContent = guest.name;
  $(".guest-identity small", button).textContent = guest.detail;
  button.addEventListener("click", () => beginGuestFlow(guest));
  $("#guest-results").append(button);
}
function renderActivities() {
  const list = $("#activity-list");
  list.replaceChildren();
  activities.forEach((activity, index) => {
    const row = document.createElement("article");
    row.className = "activity-row";
    row.innerHTML = '<span class="activity-index"></span><div class="activity-fields"><input class="activity-name-input" aria-label="Nombre del momento" /><div class="time-fields"><label>Inicia<input class="activity-start" type="time" /></label><span>—</span><label>Termina<input class="activity-end" type="time" /></label></div></div><button class="remove-activity" type="button" aria-label="Quitar momento">×</button>';
    $(".activity-index", row).textContent = String(index + 1).padStart(2, "0");
    $(".activity-name-input", row).value = activity.name;
    $(".activity-start", row).value = activity.start;
    $(".activity-end", row).value = activity.end;
    row.addEventListener("input", () => {
      activities[index].name = $(".activity-name-input", row).value;
      activities[index].start = $(".activity-start", row).value;
      activities[index].end = $(".activity-end", row).value;
    });
    $(".remove-activity", row).addEventListener("click", () => {
      if (activities.length < 2) return;
      activities.splice(index, 1);
      if (activityIndex >= activities.length) activityIndex = activities.length - 1;
      renderActivities();
    });
    list.append(row);
  });
}
function showNextActivity() {
  activityIndex = (activityIndex + 1) % activities.length;
  countdownSeconds = 300;
  openSeconds = 0;
  isPreviewOpen = false;
  screen("moment");
  refreshMoment();
}

$("#start-guest").addEventListener("click", () => { screen("guest"); $("#guest-search").focus(); });
$("#show-program").addEventListener("click", () => { renderPublicSchedule(); screen("schedule"); });
$("#open-message").addEventListener("click", () => { $("#message-author").value = ""; $("#message-text").value = ""; $("#message-count").textContent = "0 / 240"; screen("message"); $("#message-author").focus(); });
$("#message-text").addEventListener("input", (event) => { $("#message-count").textContent = event.target.value.length + " / 240"; });
$("#message-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const author = $("#message-author").value.trim();
  const message = $("#message-text").value.trim();
  if (!author || !message) return;
  const key = "em-messages:" + safeKey($("#event-name").value || "Ana & Carlos");
  let saved = [];
  try { saved = JSON.parse(read(key) || "[]"); } catch { saved = []; }
  saved.push({ author, message, createdAt: new Date().toISOString() });
  write(key, JSON.stringify(saved));
  $("#saved-message-preview").textContent = "“" + message + "”";
  $("#saved-message-author").textContent = "— " + author;
  $("#message-drive-status").textContent = "Guardado en esta demostración. La conexión con Drive aún no está configurada.";
  screen("message-done");
});
$("#message-home").addEventListener("click", () => screen("welcome"));
$("#guest-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = $("#guest-search").value.trim().toLocaleLowerCase("es-MX");
  const results = $("#guest-results");
  results.replaceChildren();
  const found = demoGuests.filter((guest) => guest.name.toLocaleLowerCase("es-MX").includes(query));
  found.forEach(addGuestResult);
  results.hidden = !found.length;
  $("#search-message").textContent = found.length ? "Elige tu registro para continuar." : "No encontramos ese nombre en la lista de demostración.";
});
$("#camera-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  selectedPhoto = file;
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = URL.createObjectURL(file);
  photoIsPreview = isPreviewOpen;
  photoIsOnTime = !photoIsPreview && openSeconds > 0;
  $("#photo-preview").src = photoUrl;
  $("#photo-preview").hidden = false;
  $("#photo-empty").hidden = true;
  $("#confirm-photo").disabled = false;
  $("#photo-message").textContent = photoIsPreview
    ? "Prueba de cámara. Esta foto no se enviará ni contará."
    : photoIsOnTime
      ? "Dentro de horario. Esta foto cuenta para la dinámica."
      : "Fuera de horario. Irá al álbum, pero no contará para la dinámica.";
  screen("photo");
});
$("#confirm-photo").addEventListener("click", () => {
  if (!selectedPhoto || !currentGuest) return;
  photoIsOnTime = !photoIsPreview && openSeconds > 0;
  if (!photoIsPreview) write(quotaKey(), photoIsOnTime ? "sent-on-time-demo" : "sent-late-demo");
  $("#done-title").innerHTML = photoIsPreview ? "Vista previa<br /><em>completada.</em>" : "Tu foto<br /><em>está lista.</em>";
  $("#done-subtitle").textContent = photoIsPreview ? "La imagen solo se usó para probar este flujo." : photoIsOnTime ? "Esta foto participa en la dinámica." : "Esta foto irá al álbum, pero queda fuera de la dinámica.";
  $("#upload-status").dataset.state = photoIsPreview ? "preview" : photoIsOnTime ? "on-time" : "late";
  $("#upload-status span:last-child").textContent = photoIsPreview
    ? "Vista previa. No se envió a Drive ni quedó guardada en esta web."
    : photoIsOnTime
      ? "Pendiente de envío a Drive. La foto no se guarda en esta web."
      : "Fuera de horario. Pendiente de envío a Drive; no cuenta para la dinámica.";
  clearTemporaryPhoto();
  screen("done");
});
$("#retake-photo").addEventListener("click", () => { clearTemporaryPhoto(); screen("moment"); refreshMoment(); });
$("#photo-back").addEventListener("click", () => { clearTemporaryPhoto(); screen("moment"); refreshMoment(); });
$("#preview-open").addEventListener("click", () => { isPreviewOpen = true; refreshMoment(); });
$("#next-moment").addEventListener("click", showNextActivity);
$("#home-button").addEventListener("click", () => { clearInterval(clockInterval); screen("welcome"); });
$$('.back-button[data-back="welcome"]').forEach((button) => button.addEventListener("click", () => screen("welcome")));
$('.back-button[data-back="guest"]').addEventListener("click", () => screen("guest"));
$("#open-admin").addEventListener("click", () => { renderActivities(); screen("admin"); });
$("#close-admin").addEventListener("click", () => { screen(currentGuest ? "moment" : "welcome"); refreshMoment(); });
$(".admin-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest(".admin-tab");
  if (!tab) return;
  $$(".admin-tab").forEach((item) => item.classList.toggle("active", item === tab));
  $$(".admin-view").forEach((view) => { view.hidden = view.id !== `admin-${tab.dataset.tab}`; });
});
$("#add-activity").addEventListener("click", () => {
  activities.push({ name: "Nuevo momento", start: "20:30", end: "21:00" });
  renderActivities();
});
$("#save-program").addEventListener("click", () => {
  activities = $$(".activity-row").map((row) => ({ name: $(".activity-name-input", row).value.trim(), start: $(".activity-start", row).value, end: $(".activity-end", row).value })).filter((item) => item.name && item.start && item.end);
  if (!activities.length) {
    $("#program-feedback").textContent = "Agrega al menos un momento con horario.";
    return;
  }
  write("em-activities", JSON.stringify(activities));
  write("em-event-name", $("#event-name").value.trim() || "Ana & Carlos");
  write("em-event-date", $("#event-date").value);
  updateEventCover();
  activityIndex = Math.min(activityIndex, activities.length - 1);
  $("#program-feedback").textContent = "Programa guardado en este navegador.";
  renderActivities();
  refreshMoment();
});
$("#event-name").addEventListener("change", () => {
  $("#drive-url").value = read(`em-drive:${safeKey($("#event-name").value)}`) || "";
});
$("#drive-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const url = $("#drive-url").value.trim();
  if (url && !/^https:\/\/drive\.google\.com\//i.test(url)) {
    $("#drive-feedback").textContent = "Usa el enlace de una carpeta de Google Drive.";
    return;
  }
  if (url) write(`em-drive:${safeKey($("#event-name").value)}`, url);
  $("#drive-feedback").textContent = url ? "Enlace guardado para este evento en este navegador." : "Pega el enlace de la carpeta que compartió el fotógrafo.";
});
$("#event-name").value = read("em-event-name") || $("#event-name").value;
$("#event-date").value = read("em-event-date") || $("#event-date").value;
$("#event-name").addEventListener("input", () => {
  $(".admin-title-row .kicker").textContent = `${$("#event-name").value.toLocaleUpperCase("es-MX")} · DEMO`;
});
$("#event-date").addEventListener("change", (event) => {
  if (event.target.value) $(".admin-top .kicker").textContent = `EVENTO · ${event.target.value}`;
});

$("#event-name").addEventListener("input", updateEventCover);
$("#event-date").addEventListener("change", updateEventCover);
updateEventCover();
$("#cover-image").addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file || !file.type.startsWith("image/")) return;
  const source = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    const maxEdge = 1400;
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    const eventName = $("#event-name").value.trim() || "Ana & Carlos";
    write("em-cover:" + safeKey(eventName), dataUrl);
    $("#event-cover").style.backgroundImage = "linear-gradient(180deg, #24332c00 38%, #1b2825c9 100%), url(\"" + dataUrl + "\")";
    $("#event-cover").classList.add("has-cover-image");
    URL.revokeObjectURL(source);
  };
  image.onerror = () => URL.revokeObjectURL(source);
  image.src = source;
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.getRegistrations().then((registrations) => registrations.forEach((registration) => registration.unregister())).catch(() => {});
}
if ("caches" in window) {
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("entre-momentos-")).map((key) => caches.delete(key)))).catch(() => {});
}
