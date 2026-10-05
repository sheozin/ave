-- 098_checkin_scanner_pairing.sql
-- Scanner Build A, task 5: pair a scanner to a scan point. A pairing code
-- now says what it pairs (device_kind, default 'kiosk' so the deployed kiosk
-- flow is unchanged) and, for a scanner, where (scan_point_id, required, as
-- 048 requires of the scanner device itself). The claim only succeeds for
-- the kind the claiming page asks for: a scanner code typed into a kiosk
-- tablet reads as invalid instead of pairing a kiosk with a scanner's key.
ALTER TABLE leod_checkin_kiosk_pairing
  ADD COLUMN IF NOT EXISTS device_kind text NOT NULL DEFAULT 'kiosk',
  ADD COLUMN IF NOT EXISTS scan_point_id uuid REFERENCES leod_checkin_scan_points(id) ON DELETE CASCADE;
ALTER TABLE leod_checkin_kiosk_pairing DROP CONSTRAINT IF EXISTS leod_checkin_kiosk_pairing_kind_chk;
ALTER TABLE leod_checkin_kiosk_pairing ADD CONSTRAINT leod_checkin_kiosk_pairing_kind_chk
  CHECK (device_kind IN ('kiosk', 'scanner') AND (device_kind <> 'scanner' OR scan_point_id IS NOT NULL));

DROP FUNCTION IF EXISTS public.checkin_kiosk_claim_pairing(text);
CREATE FUNCTION public.checkin_kiosk_claim_pairing(p_code text, p_kind text DEFAULT 'kiosk')
RETURNS TABLE(event_id uuid, label text, device_kind text, scan_point_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  UPDATE leod_checkin_kiosk_pairing p
     SET claimed_at = now()
   WHERE p.code = p_code
     AND p.device_kind = COALESCE(p_kind, 'kiosk')
     AND p.claimed_at IS NULL
     AND p.expires_at > now()
  RETURNING p.event_id, p.label, p.device_kind, p.scan_point_id
$function$;
REVOKE ALL ON FUNCTION public.checkin_kiosk_claim_pairing(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_kiosk_claim_pairing(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
