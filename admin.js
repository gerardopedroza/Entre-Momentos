const $ = (selector, root = document) => root.querySelector(selector);
const loginCard = $("#login-card");
const panel = $("#events-panel");
const feedback = $("#admin-feedback");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "No se pudo completar la operación.");
  return data;
}

function showLoggedOut(message = "") {
  loginCard.hidden = false;
  panel.hidden = true;
  $("#logout").hidden = true;
  feedback.textContent = message;
}

async function loadEvents() {
  const { events = [], venues = [] } = await api("/api/admin/dashboard");
  $("#event-form [name=venueId]").innerHTML = '<option value="">Selecciona un lugar</option>' + venues.filter(v => v.active).map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("");
  $("#events-list").innerHTML = events.length ? events.map((event) => `
    <article class="admin-card" data-event="${esc(event.id)}">
      <div class="event-grid"><div><h2>${esc(event.name)}</h2><div class="event-meta">${esc(event.venue_name)} · ${esc(event.event_date)} · Estado: ${event.state === "active" ? "Activo" : event.state === "draft" ? "Preparación" : esc(event.state)}</div></div><div class="event-meta">${Number(event.guest_count || 0)} invitados · ${Number(event.activity_count || 0)} actividades</div></div>
      <div class="url-row"><strong>INVITADOS</strong><input aria-label="Enlace para invitados" readonly value="${esc(event.guestUrl)}"><button class="admin-button secondary" data-copy="guest">Copiar</button></div>
      <div class="url-row"><strong>STAFF</strong><input aria-label="Enlace directo del staff" readonly value="${esc(event.staffUrl)}"><div class="url-actions"><a class="admin-button secondary" href="${esc(event.staffUrl)}" target="_blank" rel="noopener noreferrer">Abrir</a><button class="admin-button secondary" data-copy="staff">Copiar</button></div></div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="admin-button secondary" data-rotate="${esc(event.id)}">Renovar enlace STAFF</button></div>
    </article>`).join("") : '<div class="admin-card"><h2>Aún no hay eventos</h2><p>Cuando haya eventos registrados, sus enlaces para invitados y STAFF aparecerán aquí.</p></div>';
  $("#events-list").querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
    const row = button.closest(".url-row");
    const input = $("input", row);
    try { await navigator.clipboard.writeText(input.value); }
    catch { input.focus(); input.select(); document.execCommand("copy"); }
    feedback.textContent = `Enlace de ${button.dataset.copy === "guest" ? "invitados" : "STAFF"} copiado.`;
    button.textContent = "Copiado";
    setTimeout(() => { button.textContent = "Copiar"; }, 1600);
  }));
  $("#events-list").querySelectorAll("[data-rotate]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("El enlace STAFF actual dejará de funcionar. ¿Quieres generar uno nuevo?")) return;
    button.disabled = true;
    try {
      const result = await api(`/api/admin/events/${encodeURIComponent(button.dataset.rotate)}/staff-link/rotate`, { method: "POST", body: "{}" });
      await loadEvents();
      feedback.textContent = "Enlace STAFF renovado. Comparte el nuevo enlace con el equipo.";
      const card = $(`[data-event="${CSS.escape(button.dataset.rotate)}"]`);
      const input = card?.querySelectorAll(".url-row input")[1];
      if (input) input.select();
    } catch (error) { feedback.textContent = error.message; button.disabled = false; }
  }));
  loginCard.hidden = true;
  panel.hidden = false;
  $("#logout").hidden = false;
}

async function initialize() {
  try { await api("/api/admin/dashboard"); await loadEvents(); }
  catch (error) { showLoggedOut(error.message); }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("button", event.currentTarget);
  button.disabled = true;
  feedback.textContent = "Comprobando acceso…";
  try {
    await api("/api/admin/session", { method: "POST", body: JSON.stringify({ username: $("#username").value.trim(), password: $("#password").value }) });
    await loadEvents();
    feedback.textContent = "Sesión iniciada.";
    $("#password").value = "";
  } catch (error) { feedback.textContent = error.message; }
  finally { button.disabled = false; }
});

$("#logout").addEventListener("click", async () => {
  try { await api("/api/admin/session", { method: "DELETE" }); } catch { /* Session UI still closes if offline. */ }
  showLoggedOut("Sesión cerrada.");
});

initialize();

$("#venue-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button", form); button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try { await api("/api/admin/venues", { method: "POST", body: JSON.stringify(values) }); form.reset(); feedback.textContent = "Lugar guardado."; await loadEvents(); }
  catch (error) { feedback.textContent = error.message; }
  finally { button.disabled = false; }
});

$("#event-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = $("button", form); button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try { await api("/api/admin/events", { method: "POST", body: JSON.stringify(values) }); form.reset(); feedback.textContent = "Evento creado. Sus enlaces ya aparecen en la lista."; await loadEvents(); }
  catch (error) { feedback.textContent = error.message; }
  finally { button.disabled = false; }
});
