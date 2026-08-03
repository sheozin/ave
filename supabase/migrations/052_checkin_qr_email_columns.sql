-- ============================================================
-- CueDeck — Migration 052: Check-in module — QR email columns
-- ============================================================
-- Two columns supporting QR/email delivery (see
-- docs/superpowers/specs/2026-07-25-checkin-qr-email-delivery-design.md):
--
-- qr_email_sent_at: tracks whether/when an attendee's QR email went
-- out. Used to target "never sent" attendees by default, avoid
-- double-sending, and (later) show send status in an admin UI.
--
-- auto_send_qr_email: per-event opt-in for automatic sending on
-- import. Defaults FALSE, not TRUE — the failure modes aren't
-- symmetric. An organizer who forgot to enable it just flips a switch
-- or calls the manual send endpoint (search-by-name still works
-- on-site regardless). An organizer who already runs registration
-- elsewhere and gets a surprise duplicate email sent to their
-- attendees the moment they import a CSV is a real trust problem.
-- No RLS policy changes needed — both columns live on tables already
-- covered by existing policies (leod_checkin_attendees,
-- leod_checkin_entitlements), and entitlements still has no
-- client-writable policy at all (unchanged from migration 051).
-- ============================================================

ALTER TABLE leod_checkin_attendees
  ADD COLUMN IF NOT EXISTS qr_email_sent_at TIMESTAMPTZ;

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS auto_send_qr_email BOOLEAN NOT NULL DEFAULT false;
