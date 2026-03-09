-- 012: Add scroll_style + paginate_seconds to signage displays
-- Enables directors to choose between auto-scroll and paginate for timeline/programme modes

ALTER TABLE leod_signage_displays
  ADD COLUMN IF NOT EXISTS scroll_style TEXT NOT NULL DEFAULT 'scroll'
    CHECK (scroll_style IN ('scroll', 'paginate')),
  ADD COLUMN IF NOT EXISTS paginate_seconds SMALLINT NOT NULL DEFAULT 10;
