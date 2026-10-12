-- 137_display_turned_portrait.sql
-- A TV mounted on its side whose player still sends a landscape picture.
-- portrait_right / portrait_left tell the display page to turn its picture a
-- quarter turn that way; 'portrait' stays a screen that is already upright.
ALTER TABLE leod_signage_displays
  DROP CONSTRAINT IF EXISTS leod_signage_displays_orientation_check;
ALTER TABLE leod_signage_displays
  ADD CONSTRAINT leod_signage_displays_orientation_check
  CHECK (orientation IN ('landscape','portrait','portrait_right','portrait_left'));
