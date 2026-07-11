import { createClient } from "@supabase/supabase-js";

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

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);

  // Step 1: Find sessions to archive
  const { data: toArchive, error: findErr } = await supabase
    .from("leod_sessions")
    .select("*")
    .eq("status", "ENDED")
    .lt("updated_at", cutoff.toISOString());

  if (findErr) {
    return new Response(JSON.stringify({ error: findErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let archived = 0;

  if (toArchive && toArchive.length > 0) {
    // Step 2: Insert into archive table (soft-delete)
    const { error: archiveErr } = await supabase
      .from("leod_sessions_archive")
      .upsert(toArchive.map((s: Record<string, unknown>) => ({ ...s, archived_at: new Date().toISOString() })));

    if (archiveErr) {
      return new Response(JSON.stringify({ error: `Archive failed: ${archiveErr.message}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Step 3: Delete originals only after successful archive
    const ids = toArchive.map((s: Record<string, unknown>) => s.id);
    const { error: delErr } = await supabase
      .from("leod_sessions")
      .delete()
      .in("id", ids);

    if (delErr) {
      return new Response(JSON.stringify({ error: `Delete failed: ${delErr.message}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    archived = ids.length;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      archived,
      cutoff: cutoff.toISOString(),
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
