-- 136_display_video_sync.sql
-- Video Loop displays roll in step: each screen plays its video at the
-- position given by the server's clock, so screens with videos of the same
-- length show the same frame at the same moment. On by default; a display
-- can opt out (a screen that should simply loop on its own).
ALTER TABLE leod_signage_displays
  ADD COLUMN IF NOT EXISTS video_sync boolean NOT NULL DEFAULT true;
