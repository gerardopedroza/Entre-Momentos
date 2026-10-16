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
  $("#camera-input").disabled = !opened || closed;
  $("#camera-button").classList.toggle("is-disabled", !opened || closed);
  $("#moment-state").textContent = isPreviewOpen ? "VISTA PREVIA" : opened ? "MOMENTO ABIERTO" : closed ? "MOMENTO CERRADO" : "PRÓXIMO MOMENTO";
  $("#moment-prompt").innerHTML = isPreviewOpen
    ? `Vista previa de la cámara<br /><strong>Lista para probar</strong>`
    : opened
      ? `Ya puedes tomar la foto<br /><strong>${activity.name}</strong>`
      : closed
        ? `La toma de este momento<br /><strong>ya cerró</strong>`
        : `Prepárate para tomar la foto<br /><strong>en <span id="countdown">${formatSeconds(countdownSeconds)}</span></strong>`;
  $("#camera-instruction").textContent = opened ? "Una toma para compartir este momento." : closed ? "Espera el siguiente momento del programa." : "Te avisamos cuando se abra la cámara.";
  $("#camera-button-label").textContent = opened ? "Tomar mi foto" : closed ? "Momento cerrado" : "Aún no";
  $("#preview-open").hidden = isPreviewOpen || opened || closed;
  $("#footer-guest").textContent = currentGuest;
  const alreadyShared = currentGuest && read(quotaKey());
  if (alreadyShared) {
    $("#camera-input").disabled = true;
    $("#camera-button").classList.add("is-disabled");
    $("#camera-button-label").textContent = "Foto compartida";
    $("#camera-instruction").textContent = "Ya compartiste una foto de este momento.";
    $("#moment-state").textContent = "MOMENTO COMPARTIDO";
    $("#moment-prompt").innerHTML = `Gracias por ayudar<br /><strong>con este momento.</strong>`;
    $("#preview-open").hidden = true;
  }
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
  $("#photo-preview").src = photoUrl;
  $("#photo-preview").hidden = false;
  $("#photo-empty").hidden = true;
  $("#confirm-photo").disabled = false;
  $("#photo-message").textContent = `Foto lista para “${getActivity().name}”. Solo se admitirá esta toma para la actividad.`;
  screen("photo");
});
$("#confirm-photo").addEventListener("click", () => {
  if (!selectedPhoto || !currentGuest) return;
  write(quotaKey(), "confirmed");
  $("#upload-status span:last-child").textContent = "La foto está lista. La conexión de Drive aún no está configurada.";
  $("#download-photo").href = photoUrl;
  $("#download-photo").download = `entre-momentos-${safeKey(getActivity().name)}.${selectedPhoto.name.split(".").pop() || "jpg"}`;
  screen("done");
});
$("#retake-photo").addEventListener("click", () => { $("#camera-input").value = ""; screen("moment"); refreshMoment(); });
$("#photo-back").addEventListener("click", () => { $("#camera-input").value = ""; selectedPhoto = null; screen("moment"); refreshMoment(); });
$("#preview-open").addEventListener("click", () => { isPreviewOpen = true; refreshMoment(); });
$("#next-moment").addEventListener("click", showNextActivity);
$("#home-button").addEventListener("click", () => { clearInterval(clockInterval); screen("welcome"); });
$('.back-button[data-back="welcome"]').addEventListener("click", () => screen("welcome"));
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

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
