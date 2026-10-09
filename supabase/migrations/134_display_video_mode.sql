-- 134_display_video_mode.sql
-- A display that plays one video edge to edge, on a loop, and nothing else:
-- a lectern or a logo screen. The video has its own column, not
-- override_content, because clearing an override must not remove it.
-- Only https addresses are accepted.

ALTER TABLE leod_signage_displays
  ADD COLUMN IF NOT EXISTS video_url text
  CHECK (video_url IS NULL OR (video_url ~ '^https://[^\s<>"]+$' AND length(video_url) <= 1000));

ALTER TABLE leod_signage_displays DROP CONSTRAINT IF EXISTS leod_signage_displays_content_mode_check;
ALTER TABLE leod_signage_displays ADD CONSTRAINT leod_signage_displays_content_mode_check
  CHECK (content_mode = ANY (ARRAY['schedule','wayfinding','sponsors','break','wifi','recall','custom',
                                   'agenda','timeline','programme','stage-timer','video']));
