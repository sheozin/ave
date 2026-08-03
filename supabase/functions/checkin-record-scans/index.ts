// supabase/functions/checkin-record-scans/index.ts
// Batch scan ingest for the check-in station. The server is the final
// authority on checked_in_at: it is set only when currently NULL, so
// the first scan wins even when two desks sync out of order. A scan
// that arrives second is recorded as 'duplicate', never dropped.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

type Item = {
  client_id: string;
  attendee_id: string;
  scanned_at: string;
  action: "checkin" | "undo";
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    if (body?._ping) {
      return new Response(JSON.stringify({ pong: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { event_id, operator_id, scan_point_id, items } = body as {
      event_id: string; operator_id: string | null;
      scan_point_id: string | null; items: Item[];
    };

    if (!event_id || !Array.isArray(items)) {
      return new Response(JSON.stringify({ error: "event_id and items required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Record<string, string> = {};

    for (const it of items) {
      // At-most-once. The station retries on reconnect, so a flush whose
      // response was lost re-sends this item. If we already recorded it,
      // return the original verdict and touch nothing.
      const { data: prior } = await supabase
        .from("leod_checkin_scan_events")
        .select("result")
        .eq("client_id", it.client_id)
        .maybeSingle();
      if (prior) { results[it.client_id] = prior.result; continue; }

      const { data: att } = await supabase
        .from("leod_checkin_attendees")
        .select("id, event_id, checked_in_at")
        .eq("id", it.attendee_id)
        .maybeSingle();

      if (!att) { results[it.client_id] = "unknown_token"; continue; }
      if (att.event_id !== event_id) { results[it.client_id] = "wrong_event"; continue; }

      let result: string;

      if (it.action === "undo") {
        await supabase
          .from("leod_checkin_attendees")
          .update({ checked_in_at: null })
          .eq("id", it.attendee_id);
        result = "undo";
      } else if (att.checked_in_at) {
        result = "duplicate";
      } else {
        const { data: updated } = await supabase
          .from("leod_checkin_attendees")
          .update({ checked_in_at: it.scanned_at })
          .eq("id", it.attendee_id)
          .is("checked_in_at", null)
          .select("id");
        result = updated && updated.length > 0 ? "ok" : "duplicate";
      }

      const { error: insErr } = await supabase
        .from("leod_checkin_scan_events").insert({
          id: crypto.randomUUID(),
          event_id,
          client_id: it.client_id,
          attendee_id: it.attendee_id,
          scan_point_id: scan_point_id ?? null,
          device_id: null,
          operator_id: operator_id ?? null,
          scanned_at: it.scanned_at,
          result,
        });

      // 23505 = unique violation on client_id: a concurrent flush of the
      // same item won the race. Its row is authoritative, so read it back
      // rather than reporting our own verdict.
      if (insErr?.code === "23505") {
        const { data: raced } = await supabase
          .from("leod_checkin_scan_events")
          .select("result").eq("client_id", it.client_id).maybeSingle();
        results[it.client_id] = raced?.result ?? result;
        continue;
      }

      results[it.client_id] = result;
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
