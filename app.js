const byId = (id) => document.getElementById(id);
const joinPanel = byId("join-panel");
const dashboard = byId("dashboard");
const guestFlow = byId("guest-flow");
let demoOpen = false;
const fallbackStore = new Map();
function storeGet(key) {
  try { return localStorage.getItem(key); } catch { return fallbackStore.get(key) ?? null; }
}
function storeSet(key, value) {
  fallbackStore.set(key, value);
  try { localStorage.setItem(key, value); } catch { /* This preview remains usable in file mode. */ }
}
function storeRemove(key) {
  fallbackStore.delete(key);
  try { localStorage.removeItem(key); } catch { /* This preview remains usable in file mode. */ }
}
function showSection(section) {
  [dashboard, guestFlow].forEach((item) => { item.hidden = item !== section; });
  if (section) window.scrollTo({ top: 0, behavior: "instant" });
}

function parseTime(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function printTime(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function getActivities() {
  return [...document.querySelectorAll(".editor-row")].map((row) => ({
    name: row.querySelector(".activity-name").value.trim() || "Actividad sin nombre",
    start: row.querySelector(".activity-start").value,
    end: row.querySelector(".activity-end").value,
  })).filter((activity) => activity.start && activity.end);
}

function updateGuestSchedule() {
  const activities = getActivities();
  if (!activities.length) return;
  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const entries = activities.map((item) => ({
    ...item,
    opens: parseTime(item.start) - 5,
    closes: parseTime(item.end) - 5,
  }));
  const active = entries.find((item) => currentMinute >= item.opens && currentMinute < item.closes);
  const upcoming = entries.find((item) => currentMinute < item.opens);
  const previous = [...entries].reverse().find((item) => currentMinute >= item.closes);
  let item = active || upcoming || previous || entries[0];
  let mode = active ? "active" : upcoming ? "upcoming" : "closed";
  if (demoOpen) mode = "demo";

  byId("activity-title").textContent = item.name;
  byId("upload-destination").textContent = item.name;
  byId("activity-clock").textContent = item.start;
  byId("activity-detail").textContent = `${item.start}–${item.end} · fotos ${printTime(item.opens)}–${printTime(item.closes)}`;
  byId("window-start").textContent = `ABRE ${printTime(item.opens)}`;
  byId("window-end").textContent = `CIERRA ${printTime(item.closes)}`;
  byId("activity-state").textContent = mode === "demo" ? "PRUEBA · ACTIVIDAD ABIERTA" : mode === "active" ? "ACTIVIDAD ABIERTA PARA FOTOS" : mode === "upcoming" ? "SIGUIENTE ACTIVIDAD" : "VENTANA DE FOTOS CERRADA";

  const isOpen = mode === "active" || mode === "demo";
  byId("confirm-activity").checked = false;
  byId("confirm-activity").disabled = !isOpen;
  byId("photo-file").disabled = true;
  byId("window-copy").innerHTML = mode === "demo"
    ? `Modo de prueba activado<br /><b>La carga es solo una demostración</b>`
    : isOpen
    ? `Esta actividad está abierta para fotos<br /><b>Última foto a las ${printTime(item.closes)}</b>`
    : mode === "upcoming"
      ? `Las fotos abren 5 min antes<br /><b>Podrás empezar a las ${printTime(item.opens)}</b>`
      : "La ventana de fotos de esta actividad terminó";
  byId("upload-copy").textContent = isOpen ? "Confirma la actividad para subir" : "Fotos aún no disponibles";
  byId("upload-note").textContent = isOpen
    ? "La foto se asignará a la actividad indicada arriba."
    : "La actividad y su horario se actualizan desde la coordinación.";

  const duration = Math.max(1, item.closes - item.opens);
  const progress = Math.max(0, Math.min(100, ((currentMinute - item.opens) / duration) * 100));
  byId("activity-progress").style.width = `${progress}%`;
  document.querySelector(".next-activity").classList.toggle("is-closed", !isOpen);
  byId("simulate-open").textContent = demoOpen ? "Salir del modo de prueba" : "Probar esta actividad como abierta";
  byId("simulate-open").hidden = mode === "active";
  updateUpcoming(entries, item);
}

function updateUpcoming(activities, current) {
  const upcoming = activities.filter((activity) => activity.name !== current.name).slice(0, 2);
  const list = byId("upcoming-list");
  list.replaceChildren();
  upcoming.forEach((activity) => {
    const row = document.createElement("div");
    row.className = "mini-activity";
    row.innerHTML = `<span>${activity.start}</span><span class="schedule-mark upcoming"></span><span><b></b><small>Próxima actividad</small></span>`;
    row.querySelector("b").textContent = activity.name;
    list.append(row);
  });
  if (!upcoming.length) list.innerHTML = '<div class="mini-activity"><span>—</span><span></span><span><b>Sin más actividades</b><small>El programa termina aquí</small></span></div>';
}

function bindActivityRow(row) {
  row.querySelector(".activity-name").addEventListener("input", () => {
    row.querySelector(".folder-chip").textContent = `▱ ${row.querySelector(".activity-name").value || "Actividad"}`;
    updateGuestSchedule();
  });
  row.querySelector(".row-delete").addEventListener("click", () => {
    if (document.querySelectorAll(".editor-row").length <= 1) return;
    row.remove();
    updateGuestSchedule();
  });
}

byId("participate").addEventListener("click", () => {
  joinPanel.hidden = false;
  byId("guest-name").focus();
});
byId("close-join").addEventListener("click", () => { joinPanel.hidden = true; });
joinPanel.addEventListener("click", (event) => { if (event.target === joinPanel) joinPanel.hidden = true; });
byId("guest-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = byId("guest-name").value.trim();
  if (!name) return;
  const demoGuests = [
    { name: "Ana García", note: "Familia de la novia" },
    { name: "Ana García", note: "Familia del novio" },
    { name: "Carlos López", note: "Familia del novio" },
    { name: "María Torres", note: "Amiga de la pareja" },
    { name: "Luis Hernández", note: "Familia de la novia" },
  ];
  const matchesFound = demoGuests.filter((guest) => guest.name.toLocaleLowerCase("es-MX").includes(name.toLocaleLowerCase("es-MX")));
  const matches = byId("inline-matches");
  matches.replaceChildren();
  matchesFound.forEach((guest) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "guest-match";
    button.innerHTML = `<span class="match-avatar">${guest.name.slice(0,1)}</span><span><b></b><small></small></span><span class="match-arrow">→</span>`;
    button.querySelector("b").textContent = guest.name;
    button.querySelector("small").textContent = guest.note;
    button.addEventListener("click", () => {
      byId("flow-guest-name").textContent = guest.name.toLocaleUpperCase("es-MX");
      demoOpen = true;
      joinPanel.hidden = true;
      matches.hidden = true;
      showSection(guestFlow);
      updateGuestSchedule();
    });
    matches.append(button);
  });
  byId("guest-feedback").textContent = matchesFound.length ? "Elige tu registro. Datos de ejemplo." : "No encontramos ese nombre en la lista de ejemplo.";
  matches.hidden = matchesFound.length === 0;
});
byId("continue-demo").addEventListener("click", () => {
  const name = byId("guest-name").value.trim() || "Invitado de prueba";
  byId("flow-guest-name").textContent = name.toLocaleUpperCase("es-MX");
  demoOpen = true;
  byId("inline-matches").hidden = true;
  joinPanel.hidden = true;
  showSection(guestFlow);
  updateGuestSchedule();
});
byId("flow-back").addEventListener("click", () => {
  demoOpen = false;
  guestFlow.hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
});
byId("simulate-open").addEventListener("click", () => {
  demoOpen = !demoOpen;
  updateGuestSchedule();
});
byId("mode-toggle").addEventListener("click", () => showSection(dashboard));
byId("flow-coordinator").addEventListener("click", () => showSection(dashboard));
byId("guest-view").addEventListener("click", () => {
  dashboard.hidden = true;
  window.scrollTo({ top: 0, behavior: "instant" });
});
document.querySelectorAll(".admin-tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".admin-tab").forEach((item) => item.classList.toggle("active", item === tab));
  document.querySelectorAll(".admin-pane").forEach((pane) => { pane.hidden = pane.id !== `pane-${tab.dataset.adminTab}`; });
}));
byId("add-activity").addEventListener("click", () => {
  const row = document.createElement("article");
  row.className = "editor-row";
  row.innerHTML = '<span class="editor-grip">⠿</span><div class="editor-time"><label>INICIO<input class="activity-start" type="time" value="20:30" /></label><span>—</span><label>FIN<input class="activity-end" type="time" value="21:00" /></label></div><div class="editor-name"><input class="activity-name" value="Nueva actividad" /><small>Describe el momento que quieres fotografiar</small></div><span class="folder-chip">▱ Nueva actividad</span><button class="row-delete" aria-label="Eliminar actividad" type="button">×</button>';
  byId("schedule-editor").append(row);
  bindActivityRow(row);
  updateGuestSchedule();
});
try {
  const saved = JSON.parse(storeGet("entre-momentos-schedule") || "null");
  if (Array.isArray(saved) && saved.length) {
    const editor = byId("schedule-editor");
    editor.replaceChildren();
    saved.forEach((activity) => {
      const row = document.createElement("article");
      row.className = "editor-row";
      row.innerHTML = '<span class="editor-grip">⠿</span><div class="editor-time"><label>INICIO<input class="activity-start" type="time" /></label><span>—</span><label>FIN<input class="activity-end" type="time" /></label></div><div class="editor-name"><input class="activity-name" /><small>Actividad del evento</small></div><span class="folder-chip"></span><button class="row-delete" aria-label="Eliminar actividad" type="button">×</button>';
      row.querySelector(".activity-name").value = activity.name;
      row.querySelector(".activity-start").value = activity.start;
      row.querySelector(".activity-end").value = activity.end;
      row.querySelector(".folder-chip").textContent = `▱ ${activity.name}`;
      editor.append(row);
    });
  }
} catch { storeRemove("entre-momentos-schedule"); }
byId("save-schedule").addEventListener("click", () => {
  const activities = getActivities();
  storeSet("entre-momentos-schedule", JSON.stringify(activities));
  byId("save-status").textContent = `Guardado en este navegador · ${activities.length} actividades · ${new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}`;
  updateGuestSchedule();
});
document.querySelectorAll(".editor-row").forEach(bindActivityRow);
document.querySelectorAll(".activity-start, .activity-end").forEach((input) => input.addEventListener("change", updateGuestSchedule));
byId("confirm-activity").addEventListener("change", (event) => {
  byId("photo-file").disabled = !event.target.checked;
  byId("upload-copy").textContent = event.target.checked ? "Elegir foto de esta actividad" : "Confirma la actividad para subir";
});
byId("photo-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  byId("upload-copy").textContent = file.name;
  byId("photo-feedback").textContent = `Foto elegida para “${byId("upload-destination").textContent}”. En la aplicación real se enviará a la carpeta de Drive del fotógrafo.`;
});
byId("drive-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = byId("drive-url");
  const url = input.value.trim();
  const feedback = byId("drive-feedback");
  if (url && !/^https:\/\/drive\.google\.com\//i.test(url)) {
    feedback.textContent = "Pega el enlace de una carpeta de Google Drive.";
    return;
  }
  const eventName = byId("event-name").value.trim() || "este evento";
  if (url) storeSet(`entre-momentos-drive:${eventName}`, url);
  else storeRemove(`entre-momentos-drive:${eventName}`);
  byId("folder-root-name").textContent = `Carpeta del evento — ${eventName}`;
  byId("drive-status-title").textContent = url ? "Enlace de carpeta guardado para este evento" : "Falta el enlace de Drive de este evento";
  feedback.textContent = url ? "Enlace guardado en este navegador. Aún no se han concedido permisos de carga a Drive." : "Se quitó el enlace de este evento.";
});
byId("event-name").addEventListener("change", () => {
  const eventName = byId("event-name").value.trim() || "este evento";
  const savedUrl = storeGet(`entre-momentos-drive:${eventName}`) || "";
  byId("drive-url").value = savedUrl;
  byId("folder-root-name").textContent = `Carpeta del evento — ${eventName}`;
  byId("drive-status-title").textContent = savedUrl ? "Enlace de carpeta guardado para este evento" : "Falta el enlace de Drive de este evento";
  byId("drive-feedback").textContent = "";
});
{
  const eventName = byId("event-name").value.trim() || "este evento";
  const savedUrl = storeGet(`entre-momentos-drive:${eventName}`) || "";
  byId("drive-url").value = savedUrl;
  if (savedUrl) byId("drive-status-title").textContent = "Enlace de carpeta guardado para este evento";
}
updateGuestSchedule();
window.setInterval(updateGuestSchedule, 15000);

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
