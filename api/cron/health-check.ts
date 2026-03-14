import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const config = { runtime: "edge" };

export default async function handler(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const start = Date.now();
  const { error } = await supabase.from("leod_events").select("id").limit(1);
  const latency = Date.now() - start;

  const status = {
    ok: !error,
    supabase: error ? "unreachable" : "healthy",
    latency_ms: latency,
    timestamp: new Date().toISOString(),
  };

  return new Response(JSON.stringify(status), {
    status: error ? 503 : 200,
    headers: { "Content-Type": "application/json" },
  });
}
