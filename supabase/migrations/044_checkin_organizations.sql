-- ============================================================
-- CueDeck — Migration 044: Check-in module — organizations
-- ============================================================
-- Adds a lightweight organizations table above leod_users, so a
-- company with multiple director accounts can eventually share
-- billing/reporting. Does NOT change leod_events RLS or ownership —
-- core CueDeck event visibility is untouched. Check-in's own
-- authorization is leod_checkin_operators (migration 045), not this
-- table — this exists for future roll-up only.
--
-- Backfill: every existing director/admin who is the root of an
-- invite chain (invited_by IS NULL) gets their own organization.
-- Operators they invited inherit the same org_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_organizations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leod_organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY member_read_org ON leod_organizations
  FOR SELECT TO authenticated
  USING (
    id IN (SELECT org_id FROM leod_users WHERE id = auth.uid())
  );

ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES leod_organizations(id);

-- Backfill: one org per existing invite-chain root, propagated to
-- everyone they invited.
DO $$
DECLARE
  r RECORD;
  v_org_id UUID;
BEGIN
  FOR r IN
    SELECT id, email, organization
    FROM leod_users
    WHERE invited_by IS NULL AND org_id IS NULL AND role IN ('director', 'admin')
  LOOP
    INSERT INTO leod_organizations (name)
    VALUES (COALESCE(NULLIF(r.organization, ''), r.email))
    RETURNING id INTO v_org_id;

    UPDATE leod_users SET org_id = v_org_id WHERE id = r.id;

    UPDATE leod_users SET org_id = v_org_id
    WHERE invited_by = r.id AND org_id IS NULL;
  END LOOP;
END $$;
