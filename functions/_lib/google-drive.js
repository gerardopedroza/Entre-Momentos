import { base64url, newId } from "./core.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
let cachedToken = null;

function b64ToBytes(value) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function privateKeyBytes(pem) {
  const body = String(pem || "").replace(/\\n/g, "\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  if (!body) throw new Error("Google Drive no está configurado.");
  return b64ToBytes(body);
}

async function accessToken(env) {
  if (cachedToken && cachedToken.until > Date.now() + 60000) return cachedToken.value;
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !key) throw Object.assign(new Error("Google Drive requiere las credenciales del servicio."), { code: "drive_not_configured" });
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claim = base64url(JSON.stringify({ iss: email, scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets", aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const unsigned = header + "." + claim;
  const cryptoKey = await crypto.subtle.importKey("pkcs8", privateKeyBytes(key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = unsigned + "." + base64url(new Uint8Array(signature));
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  if (!response.ok) throw Object.assign(new Error("Google rechazó la autenticación del servicio."), { code: "drive_auth_failed" });
  const result = await response.json();
  cachedToken = { value: result.access_token, until: Date.now() + Number(result.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function driveRequest(env, path, init = {}) {
  const origin = path.startsWith("/upload/") ? "https://www.googleapis.com" : API;
  const response = await fetch(origin + path, { ...init, headers: { Authorization: "Bearer " + await accessToken(env), ...(init.headers || {}) } });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* Keep provider details out of public responses. */ }
  if (!response.ok) {
    const error = Object.assign(new Error("Google Drive no pudo completar la operación."), { code: "drive_api_error", providerStatus: response.status });
    throw error;
  }
  return { response, payload };
}

function escapeQuery(value) { return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'"); }

async function findByAppKey(env, key) {
  const q = "trashed = false and appProperties has { key='entreMomentosKey' and value='" + escapeQuery(key) + "' }";
  const { payload } = await driveRequest(env, "/files?" + new URLSearchParams({ q, pageSize: "10", fields: "files(id,name,mimeType,webViewLink,parents)" }));
  return payload?.files?.[0] || null;
}

async function createDriveFolder(env, parentId, name, key) {
  const existing = await findByAppKey(env, key);
  if (existing) return existing.id;
  const { payload } = await driveRequest(env, "/files?fields=id,name,mimeType", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId], appProperties: { entreMomentosKey: key } }),
  });
  if (!payload?.id) throw new Error("Drive no confirmó la carpeta.");
  return payload.id;
}

export function driveIdFromUrl(value) {
  const text = String(value || "").trim();
  if (/^[A-Za-z0-9_-]{15,}$/.test(text)) return text;
  const match = text.match(/\/folders\/([A-Za-z0-9_-]+)/) || text.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return match?.[1] || "";
}

export async function ensureEventDriveStructure(env, db, event) {
  let eventFolderId = event.drive_folder_id;
  if (!eventFolderId) {
    const venue = await db.prepare("SELECT drive_root_folder_id FROM venues WHERE id=?").bind(event.venue_id).first();
    if (!venue?.drive_root_folder_id) throw Object.assign(new Error("Configura la carpeta de Drive del evento o la carpeta raíz del lugar."), { code: "drive_folder_missing" });
    eventFolderId = await createDriveFolder(env, venue.drive_root_folder_id, event.name, event.id + ":event-root");
    await db.prepare("UPDATE events SET drive_folder_id=?,drive_folder_url=?,drive_status='pending' WHERE id=?")
      .bind(eventFolderId, "https://drive.google.com/drive/folders/" + eventFolderId, event.id).run();
  }
  const { payload: parent } = await driveRequest(env, "/files/" + encodeURIComponent(eventFolderId) + "?fields=id,name,mimeType,trashed,capabilities(canAddChildren)");
  if (!parent || parent.trashed || parent.mimeType !== "application/vnd.google-apps.folder" || parent.capabilities?.canAddChildren !== true) {
    throw Object.assign(new Error("La carpeta no existe o el servicio no tiene permiso de edición. Compártela con el correo del servicio de Drive."), { code: "drive_folder_permission" });
  }
  const folderSpecs = [
    { purpose: "welcome", name: "01. Bienvenida", key: event.id + ":welcome" },
    { purpose: "moments", name: "02. Momentos de la boda", key: event.id + ":moments" },
    { purpose: "dedications", name: "04. Dedicatorias", key: event.id + ":dedications" },
  ];
  const folders = {};
  for (const spec of folderSpecs) {
    const folderId = await createDriveFolder(env, eventFolderId, spec.name, spec.key);
    folders[spec.purpose] = folderId;
    await saveFolderRecord(db, event.id, spec.purpose, null, folderId);
  }
  const activityRows = await db.prepare("SELECT id,name FROM event_activities WHERE event_id=? AND active=1 ORDER BY position").bind(event.id).all();
  for (const activity of activityRows.results || []) {
    const folderId = await createDriveFolder(env, folders.moments, activity.name, event.id + ":activity:" + activity.id);
    await saveFolderRecord(db, event.id, "activity", activity.id, folderId);
    await db.prepare("UPDATE event_activities SET drive_folder_id=? WHERE id=? AND event_id=?").bind(folderId, activity.id, event.id).run();
  }
  let sheetId = event.dedications_sheet_id;
  if (!sheetId) {
    const key = event.id + ":dedications-sheet";
    const existing = await findByAppKey(env, key);
    if (existing) sheetId = existing.id;
    else {
      const { payload } = await driveRequest(env, "/files?fields=id,name", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Dedicatorias - " + event.name, mimeType: "application/vnd.google-apps.spreadsheet", parents: [folders.dedications], appProperties: { entreMomentosKey: key } }),
      });
      sheetId = payload?.id;
    }
    if (!sheetId) throw new Error("No se pudo crear la hoja de dedicatorias.");
    await renameDedicationsTab(env, sheetId);
    await sheetsAppend(env, sheetId, [["ID interno", "Fecha y hora", "Invitado", "Mensaje"]]);
    await db.prepare("UPDATE events SET dedications_sheet_id=?, dedications_sheet_url=? WHERE id=?")
      .bind(sheetId, "https://docs.google.com/spreadsheets/d/" + sheetId + "/edit", event.id).run();
  }
  await db.prepare("UPDATE events SET drive_status='ready' WHERE id=?").bind(event.id).run();
  return { folders, sheetId };
}

export async function ensureActivityDriveFolder(env, db, event, activity) {
  let momentsFolder = await db.prepare("SELECT drive_folder_id FROM storage_folders WHERE event_id=? AND purpose='moments'").bind(event.id).first();
  if (!momentsFolder) {
    await ensureEventDriveStructure(env, db, event);
    momentsFolder = await db.prepare("SELECT drive_folder_id FROM storage_folders WHERE event_id=? AND purpose='moments'").bind(event.id).first();
  }
  const id = await createDriveFolder(env, momentsFolder.drive_folder_id, activity.name, event.id + ":activity:" + activity.id);
  await saveFolderRecord(db, event.id, "activity", activity.id, id);
  await db.prepare("UPDATE event_activities SET drive_folder_id=? WHERE id=?").bind(id, activity.id).run();
  return id;
}

async function saveFolderRecord(db, eventId, purpose, activityId, driveFolderId) {
  const existing = activityId
    ? await db.prepare("SELECT id FROM storage_folders WHERE event_id=? AND purpose=? AND activity_id=?").bind(eventId, purpose, activityId).first()
    : await db.prepare("SELECT id FROM storage_folders WHERE event_id=? AND purpose=? AND activity_id IS NULL").bind(eventId, purpose).first();
  if (existing) {
    await db.prepare("UPDATE storage_folders SET drive_folder_id=? WHERE id=?").bind(driveFolderId, existing.id).run();
  } else {
    await db.prepare("INSERT INTO storage_folders (id,event_id,activity_id,purpose,drive_folder_id) VALUES (?,?,?,?,?)")
      .bind(newId(), eventId, activityId, purpose, driveFolderId).run();
  }
}

async function findUploadedRequest(env, key) { return findByAppKey(env, key); }

export async function uploadGuestPhoto(env, folderId, eventId, guestId, idempotencyKey, file, fileName) {
  const key = eventId + ":photo:" + guestId + ":" + idempotencyKey;
  const existing = await findUploadedRequest(env, key);
  if (existing) return existing;
  const boundary = "em_" + crypto.randomUUID().replaceAll("-", "");
  const metadata = { name: fileName, mimeType: file.type, parents: [folderId], appProperties: { entreMomentosKey: key, eventId, guestId } };
  const prefix = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata) + "\r\n--" + boundary + "\r\nContent-Type: " + file.type + "\r\n\r\n";
  const suffix = "\r\n--" + boundary + "--";
  const payload = new Blob([prefix, file, suffix]);
  const { payload: result } = await driveRequest(env, "/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink", {
    method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body: payload,
  });
  if (!result?.id) throw new Error("Drive no confirmó la fotografía.");
  return result;
}

export async function uploadEventImage(env, folderId, eventId, assetId, file, fileName) {
  const boundary = "em_" + crypto.randomUUID().replaceAll("-", "");
  const key = eventId + ":asset:" + assetId;
  const metadata = { name: fileName, mimeType: file.type, parents: [folderId], appProperties: { entreMomentosKey: key, eventId, assetId } };
  const prefix = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata) + "\r\n--" + boundary + "\r\nContent-Type: " + file.type + "\r\n\r\n";
  const suffix = "\r\n--" + boundary + "--";
  const { payload } = await driveRequest(env, "/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType", {
    method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body: new Blob([prefix, file, suffix]),
  });
  if (!payload?.id) throw new Error("Drive no confirmó la imagen del evento.");
  return payload;
}

export async function downloadDriveImage(env, fileId) {
  const response = await fetch(API + "/files/" + encodeURIComponent(fileId) + "?alt=media", { headers: { Authorization: "Bearer " + await accessToken(env) } });
  if (!response.ok) throw Object.assign(new Error("Google Drive no pudo abrir la imagen del evento."), { code: "drive_api_error", providerStatus: response.status });
  return response;
}

export async function deleteDriveImage(env, fileId) {
  await driveRequest(env, "/files/" + encodeURIComponent(fileId), { method: "DELETE" });
}

async function sheetsRequest(env, sheetId, range, init) {
  const url = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(sheetId) + "/values/" + encodeURIComponent(range);
  const response = await fetch(url, { ...init, headers: { Authorization: "Bearer " + await accessToken(env), ...(init.headers || {}) } });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw Object.assign(new Error("Google Sheets no pudo completar la operación."), { code: "sheets_api_error", providerStatus: response.status });
  return payload;
}

export async function sheetsAppend(env, sheetId, rows) {
  const url = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(sheetId) + "/values/" + encodeURIComponent("Dedicatorias!A:D") + ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS";
  const response = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + await accessToken(env), "Content-Type": "application/json" }, body: JSON.stringify({ values: rows }) });
  if (!response.ok) throw Object.assign(new Error("Google Sheets no pudo agregar la dedicatoria."), { code: "sheets_api_error", providerStatus: response.status });
  return response.json();
}

async function renameDedicationsTab(env, sheetId) {
  const response = await fetch("https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(sheetId) + "?fields=sheets.properties(sheetId,title)", {
    headers: { Authorization: "Bearer " + await accessToken(env) },
  });
  if (!response.ok) throw Object.assign(new Error("No se pudo abrir la hoja de dedicatorias."), { code: "sheets_api_error" });
  const data = await response.json();
  const sheet = data.sheets?.[0]?.properties;
  if (!sheet) throw new Error("La hoja de cálculo no contiene una pestaña disponible.");
  if (sheet.title !== "Dedicatorias") {
    const renamed = await fetch("https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(sheetId) + ":batchUpdate", {
      method: "POST", headers: { Authorization: "Bearer " + await accessToken(env), "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ updateSheetProperties: { properties: { sheetId: sheet.sheetId, title: "Dedicatorias" }, fields: "title" } }] }),
    });
    if (!renamed.ok) throw Object.assign(new Error("No se pudo preparar la pestaña de dedicatorias."), { code: "sheets_api_error" });
  }
}

export async function syncDedicationToSheet(env, sheetId, dedication) {
  const values = await sheetsRequest(env, sheetId, "Dedicatorias!A:A", { method: "GET" });
  const idExists = (values?.values || []).some((row) => row[0] === dedication.id);
  if (idExists) return;
  await sheetsAppend(env, sheetId, [[dedication.id, dedication.created_at, dedication.guest_name, dedication.message]]);
}

export function validateGoogleUrl(value) { return driveIdFromUrl(value); }
