const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const demoEvent = {
  id: "demo-event",
  name: "Isa & Mateo",
  date: "2026-10-15",
  demo: true,
  moments: [
    { id: "demo-entrada", name: "Entrada de los novios", state: "sample", start: "17:00", coverUrl: "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=720&q=82" },
    { id: "demo-brindis", name: "El brindis", state: "sample", start: "19:30", coverUrl: "https://images.unsplash.com/photo-1511795409834-ef04bbd61622?auto=format&fit=crop&w=720&q=82" },
    { id: "demo-baile", name: "Primer baile", state: "sample", start: "21:00", coverUrl: "https://images.unsplash.com/photo-1537633552985-df8429e8048b?auto=format&fit=crop&w=720&q=82" },
    { id: "demo-fiesta", name: "Fiesta y pista", state: "sample", start: "22:00", coverUrl: "https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=720&q=82" },
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
// The bare site URL is a clickable demo; event links always carry ?event= and use the live guest list.
let demoSearchEnabled = !new URLSearchParams(window.location.search).has("event") && !new URLSearchParams(window.location.search).has("venue");
let isSending = false;
let dragStartX = null;
let suppressCarouselClick = false;
let serverClockOffset = 0;
let refreshingEvent = false;
let presenceInterval = null;
let presenceBusy = false;
let carouselTapHintShown = false;
let carouselTutorialTimers = [];
let currentWinnerNotice = null;

function showWinnerNotice(notice, forceModal = true) {
  if (!notice || !notice.text) return;
  currentWinnerNotice = notice;

  const banner = $("#winner-banner");
  const bannerCopy = $("#winner-banner-copy");
  if (banner && bannerCopy) {
    bannerCopy.textContent = notice.contestName ? `¡Ganaste «${notice.contestName}»!` : notice.text;
    banner.hidden = false;
  }

  const contestEl = $("#winner-modal-contest");
  if (contestEl) contestEl.textContent = notice.contestName ? `«${notice.contestName}»` : "Reto del evento";

  const textEl = $("#winner-modal-text");
  if (textEl) textEl.textContent = notice.text;

  const prizeBox = $("#winner-modal-prize");
  const prizeNameEl = $("#winner-modal-prize-name");
  if (prizeBox && prizeNameEl) {
    if (notice.prizeName) {
      prizeNameEl.textContent = notice.prizeName;
      prizeBox.hidden = false;
    } else {
      prizeBox.hidden = true;
    }
  }

  if (forceModal) {
    openWinnerModal();
  }
}

function openWinnerModal() {
  const modal = $("#winner-modal-overlay");
  if (modal) modal.hidden = false;
}

function closeWinnerModal() {
  const modal = $("#winner-modal-overlay");
  if (modal) modal.hidden = true;
}

function clearWinnerNotice() {
  currentWinnerNotice = null;
  const banner = $("#winner-banner");
  if (banner) banner.hidden = true;
  closeWinnerModal();
}

function screen(name) {
  $$(".screen").forEach((item) => { item.hidden = item.id !== "screen-" + name; });
  document.body.dataset.screen = name;
  setPresenceTracking(name === "home");
}

async function api(path, options = {}) {
  const eventSlug = new URLSearchParams(window.location.search).get("event");
  const venueSlug = new URLSearchParams(window.location.search).get("venue");
  if (eventSlug && (/^\/api\/guests\/identify(?:\/select)?$/.test(path) || path === "/api/events/current")) {
    const scoped = new URL(path, window.location.origin);
    scoped.searchParams.set("event", eventSlug);
    path = scoped.pathname + scoped.search;
  } else if (venueSlug && (/^\/api\/guests\/identify(?:\/select)?$/.test(path) || path === "/api/events/current")) {
    const scoped = new URL(path, window.location.origin);
    scoped.searchParams.set("venue", venueSlug);
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
  $("#staff-event-kicker").textContent = (eventData.name || "EVENTO").toLocaleUpperCase("es-MX");
  const cover = eventData.coverUrl || "";
  if (cover) {
    const imageLayer = "linear-gradient(180deg,rgba(24,32,29,.14) 0%,rgba(24,32,29,.04) 28%,transparent 52%,rgba(255,250,246,.05) 66%,rgba(255,250,246,.3) 78%,rgba(255,250,246,.76) 90%,#fffaf6 100%),url(\"" + cover + "\")";
    $("#event-backdrop").style.backgroundImage = imageLayer;
  } else {
    $("#event-backdrop").style.removeProperty("background-image");
  }
  $("#demo-badge").hidden = !eventData.demo;
  if (date && !Number.isNaN(date.valueOf())) {
    $("#schedule-date").textContent = date.toLocaleDateString("es-MX", { day: "numeric", month: "long" }).toLocaleUpperCase("es-MX");
  }
}

let activityTicker = null;
let currentAutoActivityIndex = -1;
let isUserBrowsing = false;
let userBrowsingTimer = null;

function parseMomentMinutes(moment) {
  if (!moment) return null;
  if (moment.startsAt) {
    const d = new Date(moment.startsAt);
    if (!Number.isNaN(d.valueOf())) return d.getHours() * 60 + d.getMinutes();
  }
  const raw = moment.start || moment.startTime || "";
  const match = String(raw).match(/(\d{1,2}):(\d{2})(?:\s*([ap]\.?m\.?))?/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const ampm = match[3] ? match[3].toLowerCase().replace(/\./g, "") : null;
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return h * 60 + m;
}

function getCurrentActivityIndex() {
  if (!moments || !moments.length) return 0;
  const now = new Date();
  const nowEpoch = now.getTime();

  // 1. If moments have full ISO timestamps on today's date
  const firstStartsAt = moments[0].startsAt ? Date.parse(moments[0].startsAt) : NaN;
  const isLiveToday = Number.isFinite(firstStartsAt) && (new Date(firstStartsAt).toDateString() === now.toDateString());

  if (isLiveToday) {
    if (nowEpoch < firstStartsAt) return 0;
    let active = 0;
    for (let i = 0; i < moments.length; i++) {
      const start = Date.parse(moments[i].startsAt || "");
      if (!Number.isFinite(start)) continue;
      let nextStart = Infinity;
      if (i + 1 < moments.length && moments[i + 1].startsAt) {
        nextStart = Date.parse(moments[i + 1].startsAt);
      } else if (moments[i].endsAt) {
        nextStart = Date.parse(moments[i].endsAt);
      }
      if (nowEpoch >= start) {
        active = i;
        if (nowEpoch < nextStart) return i;
      }
    }
    return active;
  }

  // If live event is on a future date: always start at the first activity (index 0)
  if (Number.isFinite(firstStartsAt) && nowEpoch < firstStartsAt) {
    return 0;
  }

  // 2. Device time-of-day comparison (for demo mode or relative testing)
  const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const momentMins = moments.map((m) => {
    const mins = parseMomentMinutes(m);
    return mins !== null ? mins : 0;
  });

  const firstM = momentMins[0] || 0;
  // Handle overnight activities (e.g. wedding starts at 17:00 and has activities past midnight < 06:00)
  const normalizedMins = momentMins.map((mins) => {
    if (firstM >= 12 * 60 && mins < 6 * 60) return mins + 24 * 60;
    return mins;
  });

  let adjustedNow = nowMinutes;
  if (firstM >= 12 * 60 && nowMinutes < 6 * 60) {
    adjustedNow += 24 * 60;
  }

  // If accessed before the first activity schedule, always display the first activity
  if (adjustedNow < normalizedMins[0]) {
    return 0;
  }

  let currentIdx = 0;
  for (let i = 0; i < normalizedMins.length; i++) {
    const start = normalizedMins[i];
    const nextStart = i + 1 < normalizedMins.length ? normalizedMins[i + 1] : start + 120;
    if (adjustedNow >= start) {
      currentIdx = i;
      if (adjustedNow < nextStart) return i;
    }
  }
  return currentIdx;
}

function updateMomentsState(activeIdx) {
  moments.forEach((m, idx) => {
    m.state = idx < activeIdx ? "finished" : idx === activeIdx ? "active" : "upcoming";
  });
  $$(".moment-card", $("#moment-carousel")).forEach((card, idx) => {
    card.classList.toggle("is-active-moment", idx === activeIdx);
  });
}

function checkActivityProgression(force = false) {
  if (!moments || !moments.length) return;
  const activeIdx = getCurrentActivityIndex();
  updateMomentsState(activeIdx);

  if (force || activeIdx !== currentAutoActivityIndex) {
    const prevAuto = currentAutoActivityIndex;
    currentAutoActivityIndex = activeIdx;
    if (force || !isUserBrowsing || activeIdx !== prevAuto) {
      isUserBrowsing = false;
      if (userBrowsingTimer) { clearTimeout(userBrowsingTimer); userBrowsingTimer = null; }
      selectMoment(activeIdx, false);
      renderSchedule();
    }
  }
}

function startActivityTicker() {
  if (activityTicker) window.clearInterval(activityTicker);
  activityTicker = window.setInterval(() => {
    if (document.body.dataset.screen === "home") {
      checkActivityProgression(false);
    }
  }, 3000);
}

function showHome(profile, data, demo = false) {
  guest = profile;
  isDemo = demo;
  setEvent(data || demoEvent);
  submissions = new Map();
  (profile?.submissions || []).filter((item) => item.storageState === "stored").forEach((item) => submissions.set(String(item.momentId), item));
  $("#home-guest-name").textContent = profile?.name || profile?.displayName || "invitado";
  const nickname = profile?.nickname || "";
  $("#home-guest-nickname").textContent = nickname;
  $("#home-guest-nickname").hidden = !nickname;
  const count = eventData.presence?.activeCount;
  const hasLiveCount = Number.isInteger(count) && count >= 0;
  $("#connected-count").textContent = hasLiveCount ? String(count) : "—";
  $("#presence-status").textContent = count === 1 ? "invitado participando" : "invitados participando";
  $("#guest-presence").classList.toggle("has-live-count", hasLiveCount);
  const initialIndex = getCurrentActivityIndex();
  currentAutoActivityIndex = initialIndex;
  selectedMomentIndex = initialIndex;
  updateMomentsState(initialIndex);
  renderCarousel();
  renderSchedule();
  resetUploadPanel();
  const notice = profile?.winnerNotice || data?.winnerNotice || null;
  if (notice) {
    showWinnerNotice(notice, false);
  } else {
    clearWinnerNotice();
  }
  screen("home");
  showCarouselTapHint();
  startActivityTicker();
}

function showCarouselTapHint() {
  const stage = $("#carousel-stage");
  if (!stage || !moments.length) return;
  let alreadyShown = false;
  try { alreadyShown = localStorage.getItem("em-carousel-gesture-seen-v5") === "1"; } catch {}
  if (alreadyShown || carouselTapHintShown) return;
  carouselTapHintShown = true;
  carouselTutorialTimers.forEach(window.clearTimeout);
  carouselTutorialTimers = [];
  stage.classList.remove("swipe-tutorial", "tap-tutorial");
  void stage.offsetWidth;
  const hasSwipeTarget = moments.length > 1;
  const playTutorial = () => {
    if (!stage.isConnected || document.body.dataset.screen !== "home") {
      carouselTapHintShown = false;
      return;
    }
    if (hasSwipeTarget) stage.classList.add("swipe-tutorial");
    carouselTutorialTimers.push(window.setTimeout(() => {
      stage.classList.remove("swipe-tutorial");
      stage.classList.add("tap-tutorial");
    }, hasSwipeTarget ? 4800 : 100));
    carouselTutorialTimers.push(window.setTimeout(() => {
      stage.classList.remove("tap-tutorial");
      try { localStorage.setItem("em-carousel-gesture-seen-v5", "1"); } catch {}
      carouselTutorialTimers = [];
    }, hasSwipeTarget ? 8300 : 3900));
  };
  requestAnimationFrame(() => requestAnimationFrame(playTutorial));
}

function setPresenceCount(count) {
  if (!Number.isInteger(count) || count < 0) return;
  eventData.presence = { ...(eventData.presence || {}), activeCount: count };
  $("#connected-count").textContent = String(count);
  $("#presence-status").textContent = count === 1 ? "invitado participando" : "invitados participando";
  $("#guest-presence").classList.add("has-live-count");
}

async function sendPresence(active = true, keepalive = false) {
  if (!guest?.id || isDemo || !eventData.id || presenceBusy) return;
  presenceBusy = true;
  try {
    const payload = await api("/api/guest/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active, eventId: eventData.id }), ...(keepalive ? { keepalive: true } : {}) });
    setPresenceCount(payload.activeCount);
  } catch { /* A failed heartbeat expires naturally and does not block the guest flow. */ }
  finally { presenceBusy = false; }
}

function setPresenceTracking(enabled) {
  if (presenceInterval) { window.clearInterval(presenceInterval); presenceInterval = null; }
  if (!enabled || document.visibilityState === "hidden") { if (guest && !isDemo) void sendPresence(false); return; }
  if (!guest || isDemo) return;
  void sendPresence(true);
  presenceInterval = window.setInterval(() => { if (document.visibilityState === "visible") void sendPresence(true); }, 20000);
}

function momentStatus(moment) {
  const submission = submissions.get(String(moment.id));
  if (submission) return submission.eligible === true ? "Foto enviada · participa" : "Foto enviada · fuera del reto";
  if (moment.state === "active") return "Momento activo";
  if (moment.state === "finished") return "Momento finalizado";
  if (moment.state === "upcoming") return "Próximo momento";
  return "Momento del evento";
}

function findAvailableMoment(start, direction, includeStart = false) {
  const first = includeStart ? start : start + direction;
  for (let index = first; index >= 0 && index < moments.length; index += direction) {
    if (!submissions.has(String(moments[index].id))) return index;
  }
  return null;
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
    const slide = document.createElement("article");
    slide.className = "moment-slide";
    slide.setAttribute("aria-current", index === selectedMomentIndex ? "true" : "false");
    const heading = document.createElement("div");
    heading.className = "moment-slide-heading";
    const title = document.createElement("h2");
    title.className = "moment-card-name";
    title.textContent = moment.name || "Momento";
    if (title.textContent.length > 24) title.classList.add("is-long");
    const time = document.createElement("p");
    time.className = "moment-card-meta";
    time.textContent = moment.start || moment.startTime || "";
    heading.append(title);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "moment-card";
    card.classList.toggle("is-active-moment", moment.state === "active");
    card.setAttribute("aria-label", (moment.name || "Momento") + (time.textContent ? ", " + time.textContent : "") + ". Tocar para elegir una foto.");
    card.setAttribute("aria-current", index === selectedMomentIndex ? "true" : "false");
    if (moment.coverUrl) {
      card.style.backgroundImage = "url(\"" + moment.coverUrl + "\")";
      card.classList.add("has-photo");
    }
    if (submissions.has(String(moment.id))) {
      const check = document.createElement("span");
      check.className = "moment-card-submitted-check";
      check.setAttribute("aria-hidden", "true");
      check.innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>';
      card.append(check);
      card.setAttribute("aria-label", (moment.name || "Momento") + ". Foto enviada; puedes volver a ver este momento.");
    }
    card.addEventListener("click", () => selectMoment(index, true));
    slide.append(heading, card, time);
    rail.append(slide);
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
  const slides = $$(".moment-slide", $("#moment-carousel"));
  const cardOffset = Math.min(180, window.innerWidth * 0.46);
  slides.forEach((slide, index) => {
    const offset = index - selectedMomentIndex;
    const distance = Math.abs(offset);
    const side = Math.sign(offset);
    slide.style.transform = "translate(-50%,-50%) translateX(" + offset * cardOffset + "px) translateY(" + (distance ? 4 : 0) + "px) scale(" + Math.max(.78, 1 - distance * .13) + ") rotateY(" + (-side * 3) + "deg)";
    slide.style.zIndex = String(10 - distance);
    slide.style.opacity = distance > 1 ? "0" : distance ? ".74" : "1";
    slide.style.pointerEvents = distance > 1 ? "none" : "auto";
    const swipeDistance = Math.min(72, Math.max(46, window.innerWidth * 0.15));
    slide.style.setProperty("--tutorial-swipe-left", -swipeDistance + "px");
    slide.style.setProperty("--tutorial-swipe-right", swipeDistance + "px");
    slide.setAttribute("aria-current", index === selectedMomentIndex ? "true" : "false");
  });
  $$(".carousel-dot", $("#carousel-pagination")).forEach((dot, index) => dot.setAttribute("aria-current", index === selectedMomentIndex ? "true" : "false"));
  const current = moments[selectedMomentIndex];
  if (!current) return;
  const submission = submissions.get(String(current.id));
  $("#selected-moment-state").textContent = (isDemo ? "EJEMPLO · " : "") + momentStatus(current).toLocaleUpperCase("es-MX");
  $("#upload-hint").textContent = isDemo
    ? "Prueba el flujo."
    : submission ? "Ya compartiste una foto para este momento. Puedes enviar otra para cambiarla."
      : "Tu foto se enviará a «" + current.name + "».";
  $("#send-photo").disabled = isSending || !selectedPhoto;
}

function selectMoment(index, openPanel) {
  if (!moments.length) return;
  const boundedIndex = Math.max(0, Math.min(moments.length - 1, index));
  selectedMomentIndex = boundedIndex;
  updateCarousel();
  if (openPanel) openUploadPanel();

  if (boundedIndex !== currentAutoActivityIndex) {
    isUserBrowsing = true;
    if (userBrowsingTimer) clearTimeout(userBrowsingTimer);
    userBrowsingTimer = setTimeout(() => {
      isUserBrowsing = false;
      if (currentAutoActivityIndex >= 0 && currentAutoActivityIndex < moments.length) {
        selectMoment(currentAutoActivityIndex, false);
      }
    }, 20000);
  } else {
    isUserBrowsing = false;
    if (userBrowsingTimer) { clearTimeout(userBrowsingTimer); userBrowsingTimer = null; }
  }
}
function moveCarousel(amount) {
  if (!moments.length || !amount) return;
  const nextIndex = selectedMomentIndex + Math.sign(amount);
  if (nextIndex >= 0 && nextIndex < moments.length) selectMoment(nextIndex, false);
}

function renderSchedule() {
  const list = $("#public-schedule");
  list.replaceChildren();
  moments.forEach((moment, idx) => {
    const row = document.createElement("div");
    row.className = "public-activity";
    if (idx === currentAutoActivityIndex || moment.state === "active") {
      row.classList.add("is-current");
    }
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
  $("#screen-home").classList.add("is-uploading");
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
  $("#screen-home").classList.remove("is-reviewing");
  $("#gallery-button").hidden = !moments.length;
  $("#send-photo").disabled = true;
  $("#photo-feedback").textContent = "";
}
function resetUploadPanel() {
  clearPhotoPreview();
  $("#upload-panel").classList.remove("open");
  $("#screen-home").classList.remove("is-uploading");
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
  const nickname = profile.nickname ? document.createElement("small") : null;
  if (nickname) { nickname.className = "guest-nickname"; nickname.textContent = profile.nickname; }
  const reference = document.createElement("small");
  reference.textContent = profile.reference || "Toca para entrar al álbum";
  identity.append(name);
  if (nickname) identity.append(nickname);
  identity.append(reference);
  const arrow = document.createElement("span");
  arrow.className = "result-arrow";
  arrow.textContent = "→";
  button.append(initial, identity, arrow);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      if (demoSearchEnabled) {
        showHome({ id: profile.id, name: profile.name, nickname: profile.nickname, table: profile.reference?.replace(/^Mesa /, "") }, demoEvent, true);
        return;
      }
      await enterGuest(await api("/api/guests/identify/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ guestId: profile.id }) }));
    }
    catch (error) { button.disabled = false; $("#homonym-feedback").textContent = error.message; }
  });
  $("#homonym-results").append(button);
}

async function enterGuest(response) {
  const profile = response.guest || response.profile;
  if (!profile?.id) throw new Error("El servicio no confirmó tu identidad.");
  const payload = response.event ? response : await api("/api/events/current");
  const eventPayload = payload.event ? { ...payload.event, serverTime: payload.serverTime || payload.event.serverTime } : payload;
  const notice = payload.winnerNotice || response.winnerNotice || null;
  const signedIn = { ...(payload.guest || profile), submissions: payload.submissions || payload.guest?.submissions || profile.submissions || [], winnerNotice: notice };
  showHome(signedIn, eventPayload, false);
  if (notice) {
    showWinnerNotice(notice, true);
  }
}

async function refreshEvent() {
  if (isDemo || !guest || refreshingEvent) return;
  refreshingEvent = true;
  try {
    const payload = await api("/api/events/current");
    const currentEvent = payload.event ? { ...payload.event, serverTime: payload.serverTime || payload.event.serverTime } : payload;
    setEvent(currentEvent);
    if (Array.isArray(payload.submissions)) {
      submissions = new Map(payload.submissions.filter((item) => item.storageState === "stored").map((item) => [String(item.momentId), item]));
    }
    if (payload.winnerNotice) {
      showWinnerNotice(payload.winnerNotice, false);
    } else {
      clearWinnerNotice();
    }
    checkActivityProgression(false);
    renderCarousel();
    renderSchedule();
  } catch { /* Keep the last confirmed schedule if the service is temporarily unavailable. */ }
  finally { refreshingEvent = false; }
}

$("#guest-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#guest-search").value.trim();
  $("#search-message").textContent = "Buscando tu nombre…";
  $("#homonym-results").replaceChildren();
  try {
    const result = await api("/api/guests/identify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (Array.isArray(result.matches) && result.matches.length > 1) {
      result.matches.forEach((profile) => guestChoice(profile));
      $("#homonym-title").textContent = `Encuentra tu nombre en la lista (${result.matches.length})`;
      $("#homonym-feedback").textContent = "";
      screen("homonyms");
      return;
    } else if (Array.isArray(result.matches) && result.matches.length === 1) {
      await enterGuest(await api("/api/guests/identify/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ guestId: result.matches[0].id }) }));
      return;
    } else {
      await enterGuest(result);
      return;
    }
  } catch (error) {
    if (!demoSearchEnabled) {
      $("#search-message").textContent = error.message;
      return;
    }
    const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-MX");
    const demoGuests = [
      { id: "demo-ana-4", name: "Ana López", reference: "Mesa 4" },
      { id: "demo-ana-8", name: "Ana López", reference: "Mesa 8" },
      { id: "demo-carlos-1", name: "Carlos Ramírez", reference: "Mesa 1" },
      { id: "demo-maria-2", name: "María Gómez", reference: "Mesa 2" },
      { id: "demo-gerardo-3", name: "Gerardo Pedroza", reference: "Mesa 3" },
      { id: "demo-laura-5", name: "Laura Martínez", reference: "Mesa 5" },
    ];
    const matches = demoGuests.filter((g) => {
      const gNorm = g.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-MX");
      return gNorm.includes(normalized) || normalized.split(/\s+/).some((term) => term.length > 1 && gNorm.includes(term));
    });
    if (matches.length > 1) {
      matches.forEach((profile) => guestChoice(profile));
      $("#homonym-title").textContent = `Encuentra tu nombre en la lista (${matches.length})`;
      $("#homonym-feedback").textContent = "";
      screen("homonyms");
      return;
    } else if (matches.length === 1) {
      showHome({ id: matches[0].id, name: matches[0].name, reference: matches[0].reference }, demoEvent, true);
      return;
    }
    const formatted = name.split(/\s+/).map((w) => w.charAt(0).toLocaleUpperCase("es-MX") + w.slice(1).toLocaleLowerCase("es-MX")).join(" ");
    showHome({ id: "demo-" + Date.now(), name: formatted, reference: "Mesa Invitados" }, demoEvent, true);
  }
});

$("#access-entry").addEventListener("click", () => { window.location.href = "/admin.html"; });
$("#home-upload").addEventListener("click", openUploadPanel);
$("#home-dedication").addEventListener("click", () => { $("#message-feedback").textContent = ""; screen("message"); });
$("#homonym-back").addEventListener("click", () => { $("#homonym-title").textContent = "Encuentra tu nombre en la lista"; screen("welcome"); $("#guest-search").focus(); });
$("#cancel-upload").addEventListener("click", resetUploadPanel);
$("#carousel-stage").addEventListener("pointerdown", (event) => { dragStartX = event.clientX; });
$("#carousel-stage").addEventListener("pointerup", (event) => {
  if (dragStartX === null) return;
  const delta = event.clientX - dragStartX;
  if (Math.abs(delta) > 40) {
    suppressCarouselClick = true;
    moveCarousel(delta < 0 ? 1 : -1);
    window.setTimeout(() => { suppressCarouselClick = false; }, 0);
  }
  dragStartX = null;
});
$("#carousel-stage").addEventListener("pointercancel", () => { dragStartX = null; });
$("#carousel-stage").addEventListener("click", (event) => {
  if (!suppressCarouselClick) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  suppressCarouselClick = false;
}, true);
$$('[data-back="home"]').forEach((button) => button.addEventListener("click", () => screen("home")));
$("#home-button").addEventListener("click", () => screen(guest ? "home" : "welcome"));

$("#gallery-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file || !file.type.startsWith("image/")) { $("#photo-feedback").textContent = "Selecciona una imagen."; return; }
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  selectedPhoto = file;
  $("#screen-home").classList.add("is-uploading", "is-reviewing");
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
  if (!selectedPhoto || !moment || isSending) return;
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
    const nextAvailable = findAvailableMoment(selectedMomentIndex, 1) ?? findAvailableMoment(selectedMomentIndex, -1);
    if (nextAvailable !== null) selectedMomentIndex = nextAvailable;
    renderCarousel();
    resetUploadPanel();
    if (result.winnerNotice) {
      showWinnerNotice(result.winnerNotice, true);
    }
  } catch (error) {
    $("#photo-feedback").textContent = error.message || "No se pudo enviar la foto.";
    toast(error.message || "Error al enviar la foto.");
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
$("#winner-banner-open")?.addEventListener("click", openWinnerModal);
$("#winner-modal-close")?.addEventListener("click", closeWinnerModal);
$("#winner-modal-backdrop")?.addEventListener("click", closeWinnerModal);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => registrations.forEach((registration) => registration.unregister())).catch(() => {});
  if ("caches" in window) caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("entre-momentos-" )).map((key) => caches.delete(key)))).catch(() => {});
}
api("/api/events/current").then((payload) => {
  if (payload.event && !payload.event.demo) {
    demoSearchEnabled = false;
  }
  setEvent(payload.event ? { ...payload.event, serverTime: payload.serverTime || payload.event.serverTime } : payload);
}).catch(() => {});
window.setInterval(() => { if (guest && !isDemo) refreshEvent(); }, 30000);
document.addEventListener("visibilitychange", () => {
  setPresenceTracking(document.body.dataset.screen === "home");
  if (document.visibilityState === "visible" && document.body.dataset.screen === "home") {
    checkActivityProgression(true);
  }
});
window.addEventListener("pagehide", () => { if (document.body.dataset.screen === "home") void sendPresence(false, true); });
screen("welcome");
