-- 144_checkin_print_pairing_network.sql
-- Closes the device-code phishing path in reverse pairing (143). Anyone can
-- run a print station and get a code; a link carrying that code, sent to an
-- organizer, could pair the stranger's station to the organizer's event, and
-- a paired station receives every badge: names and check-in QR codes.
--
-- The request now remembers which network asked for the code (a SHA-256 of
-- the source address, never the address). checkin-kiosk-pair approves in
-- one click only when the person approving is on that same network (their
-- own station, next to them). From any other network the code must be typed
-- from the station itself (code_typed), so a link alone pairs nothing.
ALTER TABLE leod_checkin_device_requests ADD COLUMN IF NOT EXISTS ip_hash text
  CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$');
