import { handleAdminApi } from "../_lib/admin-api.js";
import { handleGuestApi } from "../_lib/guest-api.js";
import { fail, json, requireSameOrigin } from "../_lib/core.js";
import { handleStaffApi } from "../_lib/staff-api.js";

export async function onRequest(context) {
  const { request, env, params } = context;
  if (!env.DB) return fail("La base de datos del proyecto aún no está enlazada.", 503, "database_not_configured");
  const parts = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const path = "/api/" + parts.join("/");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": new URL(request.url).origin, "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Idempotency-Key", "Access-Control-Allow-Credentials": "true", "Vary": "Origin" } });
  try {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) await requireSameOrigin(request);
    if (path === "/api/health" && request.method === "GET") return json({ status: "ok", database: "connected", cloudflareR2: Boolean(env.EVENT_MEDIA), serverTime: new Date().toISOString() });
    if (path.startsWith("/api/admin/")) return await handleAdminApi(context, path);
    if (path.startsWith("/api/staff/")) {
      const response = await handleStaffApi(context, path);
      if (response) return response;
    }
    const response = await handleGuestApi(context, path);
    if (response) return response;
    return fail("No existe esa operación.", 404, "route_not_found");
  } catch (error) {
    console.error("api_error", { path, code: error.code || "internal_error", status: error.status || 500 });
    return fail(error.message || "Ocurrió un error del servicio.", error.status || 500, error.code || "internal_error");
  }
}
