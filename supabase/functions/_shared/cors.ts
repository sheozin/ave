// _shared/cors.ts — CORS origin allowlist for Edge Functions.
// Replaces the previous 'Access-Control-Allow-Origin: *' headers.
//
// file:// pages send Origin: null in Chrome/Firefox — we allow 'null' for local use.
// Server-to-server calls (curl, deploy ping) send no Origin header — pass through.
// Additional origin can be set via ALLOWED_ORIGIN env var for production deployments.

const BASE_ORIGINS = new Set([
  'null',                    // file:// pages (local operation)
  'http://localhost:7230',   // http-server dev preview
  'http://localhost:3000',   // alternative dev port
  'http://127.0.0.1:7230',
])

export function corsHeaders(req: Request): Record<string, string> {
  // Allow additional production origin via env var
  const extraOrigin = Deno.env.get('ALLOWED_ORIGIN')
  if (extraOrigin) BASE_ORIGINS.add(extraOrigin)

  const origin = req.headers.get('Origin')

  // No Origin header = server-to-server (curl, deploy ping) — no CORS restriction
  if (!origin) {
    return { 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
  }

  const allowed = BASE_ORIGINS.has(origin)
  return {
    ...(allowed ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}
