-- Add audio_enabled flag to signage displays
-- Controls whether video sponsors play with sound on this display
ALTER TABLE leod_signage_displays
  ADD COLUMN IF NOT EXISTS audio_enabled BOOLEAN NOT NULL DEFAULT false;
