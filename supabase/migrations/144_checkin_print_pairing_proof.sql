-- 144_checkin_print_pairing_network.sql
-- Closes the device-code phishing path in reverse pairing (143). Anyone can
-- run a print station and get a code; a link carrying that code, sent to an
-- organizer, could pair the stranger's station to the organizer's event, and
-- a paired station receives every badge: names and check-in QR codes.
--
-- One-click pairing now needs proof that the station runs on the very
-- computer doing the approving: with its request the station registers the
-- SHA-256 of a second secret (proof_hash), and serves the secret itself only
-- on 127.0.0.1 to CueDeck pages. The pairing page fetches it from there,
-- never from the link. checkin-kiosk-pair approves with that proof, or with
-- a code the person typed off the station (code_typed); a link alone pairs
-- nothing. (A first version compared source networks via X-Forwarded-For,
-- which a caller can set; it was never applied.)
ALTER TABLE leod_checkin_device_requests ADD COLUMN IF NOT EXISTS proof_hash text
  CHECK (proof_hash IS NULL OR proof_hash ~ '^[0-9a-f]{64}$');
