-- ============================================================
-- CueDeck Migration 007 — Session Notes Field
-- Adds a free-text notes column to leod_sessions for
-- tech riders, cue notes, and operator instructions.
-- Run in Supabase SQL Editor.
-- ============================================================

ALTER TABLE leod_sessions ADD COLUMN IF NOT EXISTS notes TEXT;
