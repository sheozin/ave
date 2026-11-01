-- 148_checkin_staff_invite_status.sql
-- Desk staff invitations say when they went out. Until now an operator row
-- recorded only that someone was added; when the invitation email was sent,
-- how many times, and by whom were nowhere. checkin-invite-staff stamps
-- these after each email it sends, and its list returns them with the
-- person's last sign-in, so Event admin shows "Invite sent 1 Nov 14:05,
-- waiting" or "Joined, active 3 h ago".
ALTER TABLE leod_checkin_operators
  ADD COLUMN IF NOT EXISTS invited_at   timestamptz,
  ADD COLUMN IF NOT EXISTS invite_count integer NOT NULL DEFAULT 0 CHECK (invite_count >= 0),
  ADD COLUMN IF NOT EXISTS invited_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL;
