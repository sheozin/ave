import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "edge" };

// Every run, ok or failed, leaves one row in leod_checkin_job_runs under
// JOB. Migration 094 registers the job, so the brain's watcher
// (checkin_brain_signals) reports it 'failing' or 'stale' instead of seeing
// nothing: this cron failed every night for weeks with no one told.
const JOB = "session-cleanup";

export default async function handler(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const startedAt = new Date().toISOString();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);

  let eligible = 0;
  let archived = 0;
  let deleted = 0;
  let failure: string | null = null;

  try {
    // Step 1: Find sessions to archive
    const { data: toArchive, error: findErr } = await supabase
      .from("leod_sessions")
      .select("*")
      .eq("status", "ENDED")
      .lt("updated_at", cutoff.toISOString());
    if (findErr) throw new Error(`Find failed: ${findErr.message}`);

    eligible = toArchive?.length ?? 0;
    if (toArchive && toArchive.length > 0) {
      // Step 2: Insert into archive table (soft-delete)
      const { error: archiveErr } = await supabase
        .from("leod_sessions_archive")
        .upsert(toArchive.map((s: Record<string, unknown>) => ({ ...s, archived_at: new Date().toISOString() })));
      if (archiveErr) throw new Error(`Archive failed: ${archiveErr.message}`);
      const ids = toArchive.map((s: Record<string, unknown>) => s.id as string);
      archived = ids.length;

      // Step 3: Delete originals only after successful archive. The same
      // rules as step 1, so a session reopened since the read stays; the
      // rows deleted must match the rows archived.
      const { data: gone, error: delErr } = await supabase
        .from("leod_sessions")
        .delete()
        .in("id", ids)
        .eq("status", "ENDED")
        .lt("updated_at", cutoff.toISOString())
        .select("id");
      if (delErr) throw new Error(`Delete failed: ${delErr.message}`);
      deleted = gone?.length ?? 0;
      if (deleted !== archived) {
        const goneIds = new Set((gone ?? []).map((g: { id: string }) => g.id));
        const left = ids.filter((id) => !goneIds.has(id));
        throw new Error(`Deleted ${deleted} of ${archived} archived sessions; still in leod_sessions: ${left.join(", ")}`);
      }
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  const { error: runErr } = await supabase.from("leod_checkin_job_runs").insert({
    job_name: JOB,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: failure ? "failed" : "ok",
    detail: JSON.stringify({ eligible, archived, deleted, cutoff: cutoff.toISOString(), ...(failure ? { error: failure } : {}) }),
  });

  if (failure || runErr) {
    const error = [failure, runErr && `Run log failed: ${runErr.message}`].filter(Boolean).join("; ");
    return new Response(JSON.stringify({ error, eligible, archived, deleted }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
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
