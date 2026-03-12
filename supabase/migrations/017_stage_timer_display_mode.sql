-- Migration 017: Add stage-timer to leod_signage_displays content_mode check constraint
-- The stage-timer mode is the 11th display mode, showing a speaker-facing fullscreen countdown.

ALTER TABLE leod_signage_displays
  DROP CONSTRAINT IF EXISTS leod_signage_displays_content_mode_check;

ALTER TABLE leod_signage_displays
  ADD CONSTRAINT leod_signage_displays_content_mode_check
  CHECK (content_mode IN (
    'schedule',
    'wayfinding',
    'sponsors',
    'break',
    'wifi',
    'recall',
    'custom',
    'agenda',
    'timeline',
    'programme',
    'stage-timer'
  ));
