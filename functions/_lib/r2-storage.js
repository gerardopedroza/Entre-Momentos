import { nowIso } from "./core.js";

export function eventPrefix(eventId) { return `events/${eventId}/`; }

export async function requireEventBucket(env) {
  if (!env.EVENT_MEDIA) throw Object.assign(new Error("El almacenamiento R2 de Cloudflare no está conectado."), { status: 503, code: "event_media_unavailable" });
  return env.EVENT_MEDIA;
}

export async function createEventFolderMarker(env, event) {
  const bucket = await requireEventBucket(env);
  const body = JSON.stringify({ id: event.id, name: event.name, date: event.event_date, createdAt: nowIso() }, null, 2);
  await bucket.put(`${eventPrefix(event.id)}event.json`, body, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  await bucket.put(`${eventPrefix(event.id)}dedications/.folder`, "Dedicatorias del evento. Se genera también un CSV en la descarga del evento.", { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
}

export async function createActivityFolderMarker(env, eventId, activity) {
  const bucket = await requireEventBucket(env);
  const body = JSON.stringify({ id: activity.id, name: activity.name, position: activity.position, startsAt: activity.starts_at, endsAt: activity.ends_at }, null, 2);
  await bucket.put(`${eventPrefix(eventId)}activities/${activity.id}/activity.json`, body, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
}

export async function uploadGuestPhoto(env, event, activity, guestId, file, fileName) {
  const bucket = await requireEventBucket(env);
  const extension = String(fileName || "foto.jpg").split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const key = `${eventPrefix(event.id)}activities/${activity.id}/photos/${guestId}/foto`;
  const prefix = `${eventPrefix(event.id)}activities/${activity.id}/photos/${guestId}/`;
  let cursor;
  do {
    const options = { prefix, limit: 1000 };
    if (cursor) options.cursor = cursor;
    const previous = await bucket.list(options);
    if (previous.objects?.length) await bucket.delete(previous.objects.map((object) => object.key));
    cursor = previous.truncated ? previous.cursor : undefined;
  } while (cursor);
  const finalKey = key + "." + extension;
  await bucket.put(finalKey, file.stream(), { httpMetadata: { contentType: file.type }, customMetadata: { eventId: event.id, activityId: activity.id, guestId } });
  return { id: finalKey, key: finalKey };
}

export async function storeDedication(env, eventId, dedication) {
  const bucket = await requireEventBucket(env);
  const key = `${eventPrefix(eventId)}dedications/${dedication.id}.json`;
  await bucket.put(key, JSON.stringify(dedication, null, 2), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  return key;
}

export async function listEventObjects(bucket, eventId) {
  const objects = [];
  let cursor;
  do {
    const options = { prefix: eventPrefix(eventId), limit: 1000 };
    if (cursor) options.cursor = cursor;
    const page = await bucket.list(options);
    objects.push(...(page.objects || []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

export async function deleteEventObjects(bucket, eventId) {
  let cursor; let deleted = 0;
  do {
    const options = { prefix: eventPrefix(eventId), limit: 1000 };
    if (cursor) options.cursor = cursor;
    const page = await bucket.list(options);
    const keys = (page.objects || []).map((object) => object.key);
    for (let index = 0; index < keys.length; index += 1000) await bucket.delete(keys.slice(index, index + 1000));
    deleted += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

export async function deleteAllEventPhotos(env, db, eventId) {
  const bucket = await requireEventBucket(env);
  let cursor; let deleted = 0;
  do {
    const options = { prefix: `${eventPrefix(eventId)}activities/`, limit: 1000 };
    if (cursor) options.cursor = cursor;
    const page = await bucket.list(options);
    const photoKeys = (page.objects || []).map((object) => object.key).filter((key) => key.includes("/photos/"));
    if (photoKeys.length) await bucket.delete(photoKeys);
    deleted += photoKeys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await db.prepare("UPDATE photo_submissions SET storage_state='failed',drive_file_id=NULL,error_code='photo_removed_by_admin' WHERE event_id=? AND storage_state='stored'").bind(eventId).run();
  return deleted;
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let value = n; for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; table[n] = value >>> 0; }
  return table;
}
const CRC_TABLE = crcTable();
function crcUpdate(crc, bytes) { for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); return crc >>> 0; }
function u16(value) { const bytes = new Uint8Array(2); new DataView(bytes.buffer).setUint16(0, value, true); return bytes; }
function u32(value) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value >>> 0, true); return bytes; }
function concat(...arrays) { const size = arrays.reduce((sum, array) => sum + array.byteLength, 0); const result = new Uint8Array(size); let offset = 0; for (const array of arrays) { result.set(array, offset); offset += array.byteLength; } return result; }

export function zipStream(files, bucket) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      let offset = 0;
      const central = [];
      const emit = (bytes) => { controller.enqueue(bytes); offset += bytes.byteLength; };
      try {
        for (const file of files) {
          const name = encoder.encode(file.name);
          const start = offset;
          const knownBytes = file.bytes instanceof Uint8Array ? file.bytes : null;
          const size = knownBytes?.byteLength ?? Number(file.size || 0);
          if (size > 0xffffffff || offset + size > 0xffffffff) throw Object.assign(new Error("El paquete supera el tamaño ZIP admitido."), { status: 413, code: "archive_too_large" });
          const flags = knownBytes ? 0x0800 : 0x0808;
          let crc = 0xffffffff;
          if (knownBytes) { for (let i = 0; i < knownBytes.length; i += 65536) crc = crcUpdate(crc, knownBytes.subarray(i, i + 65536)); crc = (crc ^ 0xffffffff) >>> 0; }
          const time = 0;
          const date = 0x0021;
          emit(concat(u32(0x04034b50), u16(20), u16(flags), u16(0), u16(time), u16(date), u32(knownBytes ? crc : 0), u32(knownBytes ? size : 0), u32(knownBytes ? size : 0), u16(name.length), u16(0), name));
          if (knownBytes) emit(knownBytes);
          else {
            const object = await bucket.get(file.key);
            if (!object) throw Object.assign(new Error("Faltó un archivo R2 durante la descarga."), { status: 409, code: "archive_object_missing" });
            const reader = object.body.getReader();
            let written = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              written += value.byteLength; crc = crcUpdate(crc, value); emit(value);
            }
            crc = (crc ^ 0xffffffff) >>> 0;
            if (written !== size) throw Object.assign(new Error("Un archivo R2 cambió durante la descarga."), { status: 409, code: "archive_object_changed" });
            emit(concat(u32(0x08074b50), u32(crc), u32(size), u32(size)));
          }
          central.push({ name, flags, crc: knownBytes ? crc : crc >>> 0, size, start, time, date });
          if (central.length > 60000) throw Object.assign(new Error("El evento contiene demasiados archivos para un solo paquete."), { status: 413, code: "archive_too_many_files" });
        }
        const centralStart = offset;
        for (const file of central) emit(concat(u32(0x02014b50), u16(20), u16(20), u16(file.flags), u16(0), u16(file.time), u16(file.date), u32(file.crc), u32(file.size), u32(file.size), u16(file.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(file.start), file.name));
        const centralSize = offset - centralStart;
        emit(concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(centralSize), u32(centralStart), u16(0)));
        controller.close();
      } catch (error) { controller.error(error); }
    },
  });
}

export function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
