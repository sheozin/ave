-- 081: close anon access to the pairing table.
--
-- Apply only after the display page from the same branch is live: until then
-- a TV on the old pairing screen inserts and polls leod_signage_pairing
-- directly. The new page pairs through display_pair_start/display_pair_poll
-- (080) and reads through display_feed (080), so it needs no table access.
--
-- anon_all_pairing was FOR ALL TO anon USING (true): anyone with the
-- publishable key could list every pairing row, or link any pending code to
-- any display id. Direct anon access to leod_signage_displays already went
-- in 080.
--
-- Callers checked 2026-10-05: leod_signage_pairing is referenced only by
-- cuedeck-display.html (now RPC only) and cuedeck-console.html (signed in,
-- authenticated policies from 080). No edge function, admin page or check-in
-- page touches it.
--
-- Untouched on purpose: anon_read_clock (leod_clock), anon_read_broadcast
-- (leod_broadcast), anon_read_sponsors (leod_signage_sponsors).
--
-- Rollback (not run):
--   CREATE POLICY anon_all_pairing ON leod_signage_pairing FOR ALL TO anon USING (true) WITH CHECK (true);
--   GRANT SELECT, INSERT, UPDATE, DELETE ON leod_signage_pairing TO anon;

DROP POLICY IF EXISTS anon_all_pairing ON public.leod_signage_pairing;
REVOKE ALL ON public.leod_signage_pairing FROM anon;
