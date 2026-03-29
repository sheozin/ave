# CueDeck Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a platform-level super-admin dashboard (`cuedeck-admin.html`) for managing all users, subscriptions, promo codes, and analytics across the CueDeck platform, completely isolated from the production console.

**Architecture:** Single HTML file (`cuedeck-admin.html`) served at `/admin` via Vercel rewrite. Supabase auth with `admin` role gate. All cross-tenant data access via admin-only RLS policies and server-side RPC functions. 4 new Edge Functions for write operations. Chart.js for analytics. Light/dark theme.

**Tech Stack:** HTML/CSS/JS (no framework), Supabase JS v2 via CDN, Chart.js via CDN, Deno Edge Functions

**Spec:** `docs/superpowers/specs/2026-03-17-admin-dashboard-design.md`

---

## File Structure

```
cuedeck-admin.html                                  — Single-file admin dashboard (new)
cuedeck-console.html                                — Add admin role block to boot() (modify)
supabase/migrations/027_admin_dashboard.sql         — Role constraint + audit table + RLS + RPCs (new)
supabase/functions/admin-manage-user/index.ts       — User management Edge Function (new)
supabase/functions/admin-manage-subscription/index.ts — Subscription override Edge Function (new)
supabase/functions/admin-manage-promo/index.ts      — Promo code CRUD Edge Function (new)
supabase/functions/admin-promote/index.ts           — Admin promotion Edge Function (new)
vercel.json                                         — Add /admin rewrite (modify)
```

---

## Chunk 1: Database Foundation

### Task 1: Write Migration 027 — Admin Role + Audit Table + RLS + RPCs

**Files:**
- Create: `supabase/migrations/027_admin_dashboard.sql`

- [ ] **Step 1: Create migration file with role constraint expansion**

```sql
-- ============================================================
-- CueDeck — Migration 027: Admin Dashboard
-- Run this in Supabase SQL Editor
-- ============================================================

-- ── 1. Expand role constraint to include 'admin' ─────────────
ALTER TABLE leod_users DROP CONSTRAINT IF EXISTS leod_users_role_check;
ALTER TABLE leod_users ADD CONSTRAINT leod_users_role_check
  CHECK (role IN ('admin','director','stage','av','interp','reg','signage','pending'));

-- ── 2. Admin audit log ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS leod_admin_audit (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_id    UUID REFERENCES auth.users(id),
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON leod_admin_audit(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON leod_admin_audit(created_at DESC);

ALTER TABLE leod_admin_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_audit_read ON leod_admin_audit FOR SELECT
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY admin_audit_insert ON leod_admin_audit FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
```

- [ ] **Step 2: Add admin RLS policies on existing tables**

Append to the same file:

```sql
-- ── 3. Admin RLS policies on existing tables ─────────────────

-- leod_users: admin can read/update ALL rows
CREATE POLICY admin_read_all_users ON leod_users FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users u WHERE u.id = auth.uid() AND u.role = 'admin'));
CREATE POLICY admin_update_all_users ON leod_users FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users u WHERE u.id = auth.uid() AND u.role = 'admin'));

-- leod_subscriptions: admin can read/update ALL rows
CREATE POLICY admin_read_all_subs ON leod_subscriptions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY admin_update_all_subs ON leod_subscriptions FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));

-- leod_promo_codes: admin can read/insert/update ALL rows
CREATE POLICY admin_read_all_promos ON leod_promo_codes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY admin_insert_promos ON leod_promo_codes FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY admin_update_promos ON leod_promo_codes FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));

-- leod_events: admin can read ALL rows (read-only)
CREATE POLICY admin_read_all_events ON leod_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));

-- leod_sessions: admin can read ALL rows (read-only)
CREATE POLICY admin_read_all_sessions ON leod_sessions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));

-- leod_event_log: admin can read ALL rows (read-only)
CREATE POLICY admin_read_all_logs ON leod_event_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
```

- [ ] **Step 3: Add admin RPC functions for analytics**

Append to the same file:

```sql
-- ── 4. Admin RPC: Statistics ─────────────────────────────────

-- 4a. admin_get_stats — returns all KPI numbers + 30-day deltas
CREATE OR REPLACE FUNCTION admin_get_stats()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_total_users INT;
  v_total_users_30d INT;
  v_prev_users_30d INT;
  v_active_subs INT;
  v_dau INT;
  v_mrr NUMERIC;
  v_churn_rate NUMERIC;
  v_conversion_rate NUMERIC;
  v_tier_perevent INT;
  v_tier_starter INT;
  v_tier_pro INT;
  v_tier_enterprise INT;
  v_canceled_30d INT;
  v_active_start INT;
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- Total users
  SELECT count(*) INTO v_total_users FROM leod_users WHERE role != 'pending';
  SELECT count(*) INTO v_total_users_30d FROM leod_users
    WHERE role != 'pending' AND id IN (
      SELECT id FROM auth.users WHERE created_at >= now() - interval '30 days'
    );
  SELECT count(*) INTO v_prev_users_30d FROM leod_users
    WHERE role != 'pending' AND id IN (
      SELECT id FROM auth.users WHERE created_at >= now() - interval '60 days'
        AND created_at < now() - interval '30 days'
    );

  -- Active subscribers by tier
  SELECT count(*) INTO v_active_subs FROM leod_subscriptions WHERE status = 'active' AND plan != 'trial';
  SELECT count(*) INTO v_tier_perevent FROM leod_subscriptions WHERE status = 'active' AND plan = 'perevent';
  SELECT count(*) INTO v_tier_starter FROM leod_subscriptions WHERE status = 'active' AND plan = 'starter';
  SELECT count(*) INTO v_tier_pro FROM leod_subscriptions WHERE status = 'active' AND plan = 'pro';
  SELECT count(*) INTO v_tier_enterprise FROM leod_subscriptions WHERE status = 'active' AND plan = 'enterprise';

  -- DAU: users who have sessions with activity in last 24h
  SELECT count(DISTINCT e.created_by) INTO v_dau
    FROM leod_events e
    INNER JOIN leod_sessions s ON s.event_id = e.id
    WHERE s.updated_at >= now() - interval '24 hours';

  -- MRR: sum subscription values (starter=59, pro=99, enterprise=299, perevent excluded)
  SELECT COALESCE(SUM(CASE
    WHEN plan = 'starter' AND billing_interval = 'month' THEN 59
    WHEN plan = 'starter' AND billing_interval = 'year' THEN 49
    WHEN plan = 'pro' AND billing_interval = 'month' THEN 99
    WHEN plan = 'pro' AND billing_interval = 'year' THEN 82
    WHEN plan = 'enterprise' THEN 299
    ELSE 0
  END), 0) INTO v_mrr
  FROM leod_subscriptions WHERE status = 'active' AND plan NOT IN ('trial', 'perevent');

  -- Churn rate: cancellations in last 30d / active at start of period
  SELECT count(*) INTO v_canceled_30d FROM leod_subscriptions
    WHERE status IN ('canceled', 'expired') AND updated_at >= now() - interval '30 days';
  v_active_start := v_active_subs + v_canceled_30d;
  v_churn_rate := CASE WHEN v_active_start > 0
    THEN round((v_canceled_30d::NUMERIC / v_active_start) * 100, 1) ELSE 0 END;

  -- Conversion rate: paying / total non-pending users
  v_conversion_rate := CASE WHEN v_total_users > 0
    THEN round((v_active_subs::NUMERIC / v_total_users) * 100, 1) ELSE 0 END;

  RETURN jsonb_build_object(
    'total_users', v_total_users,
    'new_users_30d', v_total_users_30d,
    'prev_users_30d', v_prev_users_30d,
    'active_subs', v_active_subs,
    'tier_perevent', v_tier_perevent,
    'tier_starter', v_tier_starter,
    'tier_pro', v_tier_pro,
    'tier_enterprise', v_tier_enterprise,
    'dau', v_dau,
    'mrr', v_mrr,
    'churn_rate', v_churn_rate,
    'conversion_rate', v_conversion_rate
  );
END;
$$;

-- 4b. admin_get_signups_per_day
CREATE OR REPLACE FUNCTION admin_get_signups_per_day(p_days INT DEFAULT 30)
RETURNS TABLE (day DATE, signup_count BIGINT) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  RETURN QUERY
    SELECT d.day::DATE, COALESCE(count(a.id), 0)
    FROM generate_series(
      (now() - (p_days || ' days')::INTERVAL)::DATE,
      now()::DATE,
      '1 day'::INTERVAL
    ) AS d(day)
    LEFT JOIN auth.users a ON a.created_at::DATE = d.day::DATE
    GROUP BY d.day ORDER BY d.day;
END;
$$;

-- 4c. admin_get_dau_per_day
CREATE OR REPLACE FUNCTION admin_get_dau_per_day(p_days INT DEFAULT 14)
RETURNS TABLE (day DATE, active_users BIGINT) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  RETURN QUERY
    SELECT d.day::DATE, COALESCE(sub.cnt, 0)
    FROM generate_series(
      (now() - (p_days || ' days')::INTERVAL)::DATE,
      now()::DATE,
      '1 day'::INTERVAL
    ) AS d(day)
    LEFT JOIN (
      SELECT s.updated_at::DATE AS uday, count(DISTINCT e.created_by) AS cnt
      FROM leod_sessions s
      JOIN leod_events e ON e.id = s.event_id
      WHERE s.updated_at >= now() - (p_days || ' days')::INTERVAL
      GROUP BY uday
    ) sub ON sub.uday = d.day::DATE
    ORDER BY d.day;
END;
$$;

-- 4d. admin_get_tier_breakdown
CREATE OR REPLACE FUNCTION admin_get_tier_breakdown()
RETURNS TABLE (plan TEXT, count BIGINT) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  RETURN QUERY
    SELECT s.plan, count(*)
    FROM leod_subscriptions s
    WHERE s.status = 'active'
    GROUP BY s.plan ORDER BY count DESC;
END;
$$;

-- 4e. admin_get_recent_signups
CREATE OR REPLACE FUNCTION admin_get_recent_signups(p_limit INT DEFAULT 10)
RETURNS TABLE (email TEXT, created_at TIMESTAMPTZ, plan TEXT) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  RETURN QUERY
    SELECT u.email, a.created_at, COALESCE(s.plan, 'none')
    FROM leod_users u
    JOIN auth.users a ON a.id = u.id
    LEFT JOIN leod_subscriptions s ON s.director_id = u.id
    WHERE u.role != 'pending'
    ORDER BY a.created_at DESC LIMIT p_limit;
END;
$$;

-- 4f. admin_get_recent_events
CREATE OR REPLACE FUNCTION admin_get_recent_events(p_limit INT DEFAULT 10)
RETURNS TABLE (event_name TEXT, operator_email TEXT, created_at TIMESTAMPTZ) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  RETURN QUERY
    SELECT e.name, u.email, e.created_at
    FROM leod_events e
    LEFT JOIN leod_users u ON u.id = e.created_by
    ORDER BY e.created_at DESC LIMIT p_limit;
END;
$$;

-- 4g. admin_list_users (paginated, searchable — single query with window count)
CREATE OR REPLACE FUNCTION admin_list_users(
  p_search TEXT DEFAULT '',
  p_role_filter TEXT DEFAULT '',
  p_status_filter TEXT DEFAULT '',
  p_page INT DEFAULT 1,
  p_per_page INT DEFAULT 25
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_offset INT := (p_page - 1) * p_per_page;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'total', COALESCE(MAX(t.total_count), 0),
      'page', p_page,
      'per_page', p_per_page,
      'users', COALESCE(jsonb_agg(to_jsonb(t) - 'total_count' ORDER BY t.created_at DESC), '[]'::JSONB)
    )
    FROM (
      SELECT u.id, u.email, u.name, u.role, u.organization, u.active,
             a.created_at, a.last_sign_in_at,
             COALESCE(s.plan, 'none') AS plan, COALESCE(s.status, 'none') AS sub_status,
             count(*) OVER() AS total_count
      FROM leod_users u
      JOIN auth.users a ON a.id = u.id
      LEFT JOIN leod_subscriptions s ON s.director_id = u.id
      WHERE (p_search = '' OR u.email ILIKE '%' || p_search || '%' OR u.name ILIKE '%' || p_search || '%')
        AND (p_role_filter = '' OR u.role = p_role_filter)
        AND (p_status_filter = '' OR
             (p_status_filter = 'active' AND u.active = true) OR
             (p_status_filter = 'suspended' AND u.active = false))
      ORDER BY a.created_at DESC
      LIMIT p_per_page OFFSET v_offset
    ) t
  );
END;
$$;

-- 4h. admin_list_promo_codes (paginated)
CREATE OR REPLACE FUNCTION admin_list_promo_codes(p_page INT DEFAULT 1, p_per_page INT DEFAULT 25)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_offset INT := (p_page - 1) * p_per_page;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  RETURN jsonb_build_object(
    'total', (SELECT count(*) FROM leod_promo_codes),
    'page', p_page,
    'codes', COALESCE((
      SELECT jsonb_agg(row_to_jsonb(p) ORDER BY p.created_at DESC)
      FROM (
        SELECT * FROM leod_promo_codes ORDER BY created_at DESC
        LIMIT p_per_page OFFSET v_offset
      ) p
    ), '[]'::JSONB)
  );
END;
$$;

-- 4i. admin_list_subscriptions (paginated, filterable)
CREATE OR REPLACE FUNCTION admin_list_subscriptions(
  p_filter TEXT DEFAULT '',
  p_page INT DEFAULT 1,
  p_per_page INT DEFAULT 25
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_offset INT := (p_page - 1) * p_per_page;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'total', COALESCE(MAX(t.total_count), 0),
      'page', p_page,
      'per_page', p_per_page,
      'subscriptions', COALESCE(jsonb_agg(to_jsonb(t) - 'total_count' ORDER BY t.created_at DESC), '[]'::JSONB)
    )
    FROM (
      SELECT s.id, s.director_id, s.plan, s.status, s.billing_interval,
             s.trial_ends_at, s.current_period_start, s.current_period_end,
             s.cancel_at, s.stripe_customer_id, s.stripe_subscription_id,
             s.events_purchased, s.events_used, s.created_at,
             u.email, u.name, u.organization,
             count(*) OVER() AS total_count
      FROM leod_subscriptions s
      JOIN leod_users u ON u.id = s.director_id
      WHERE (p_filter = '' OR s.status = p_filter OR
             (p_filter = 'trial' AND s.plan = 'trial'))
      ORDER BY s.created_at DESC
      LIMIT p_per_page OFFSET v_offset
    ) t
  );
END;
$$;

-- 4j. admin_get_promo_redemptions
-- Note: promo redemptions are tracked by uses count on leod_promo_codes.
-- Full per-user redemption history requires a future redemptions table.
CREATE OR REPLACE FUNCTION admin_get_promo_redemptions(p_code TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  RETURN (SELECT row_to_jsonb(p) FROM leod_promo_codes p WHERE p.code = p_code);
END;
$$;
```

- [ ] **Step 4: Apply migration to live database**

Run the SQL in Supabase SQL Editor at:
`https://supabase.com/dashboard/project/sawekpguemzvuvvulfbc/sql`

- [ ] **Step 5: Set your own account to admin role**

```sql
UPDATE leod_users SET role = 'admin' WHERE email = 'YOUR_EMAIL_HERE';
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/027_admin_dashboard.sql
git commit -m "feat: add migration 027 — admin role, audit table, RLS policies, analytics RPCs"
```

---

## Chunk 2: Edge Functions

### Task 2: Create admin-manage-user Edge Function

**Files:**
- Create: `supabase/functions/admin-manage-user/index.ts`

- [ ] **Step 1: Create the Edge Function**

```typescript
// admin-manage-user — Admin manages any user across the platform.
// Actions: update_role, suspend, reactivate, remove, reset_password, impersonate

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

const VALID_ROLES = new Set(['admin','director','stage','av','interp','reg','signage','pending'])
const VALID_ACTIONS = new Set(['update_role','suspend','reactivate','remove','reset_password','impersonate'])

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Auth: verify JWT
  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Verify caller is admin
  const { data: callerRow } = await sb.from('leod_users')
    .select('role').eq('id', user.id).single()
  if (!callerRow || callerRow.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden — admin only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const action   = String(body.action  || '').trim()
  const targetId = String(body.user_id || '').trim()

  if (!VALID_ACTIONS.has(action)) {
    return new Response(JSON.stringify({ error: `Invalid action: ${action}` }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
  if (!targetId) {
    return new Response(JSON.stringify({ error: 'Missing user_id' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  try {
    let result: Record<string, unknown> = { ok: true, action }

    if (action === 'update_role') {
      const newRole = String(body.role || '').trim()
      if (!VALID_ROLES.has(newRole)) {
        return new Response(JSON.stringify({ error: `Invalid role: ${newRole}` }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const { error } = await sb.from('leod_users').update({ role: newRole }).eq('id', targetId)
      if (error) throw error
      // Also update name/org if provided
      const updates: Record<string, unknown> = {}
      if (body.name) updates.name = String(body.name)
      if (body.organization) updates.organization = String(body.organization)
      if (Object.keys(updates).length) {
        await sb.from('leod_users').update(updates).eq('id', targetId)
      }

    } else if (action === 'suspend') {
      const { error } = await sb.from('leod_users').update({ active: false }).eq('id', targetId)
      if (error) throw error

    } else if (action === 'reactivate') {
      const { error } = await sb.from('leod_users').update({ active: true }).eq('id', targetId)
      if (error) throw error

    } else if (action === 'remove') {
      const { error: deleteErr } = await sb.from('leod_users').delete().eq('id', targetId)
      if (deleteErr) throw deleteErr
      const { error: banErr } = await sb.auth.admin.updateUserById(targetId, { ban_duration: '876600h' })
      if (banErr) console.error('Auth ban failed:', banErr.message)

    } else if (action === 'reset_password') {
      const { data: targetUser } = await sb.from('leod_users').select('email').eq('id', targetId).single()
      if (!targetUser?.email) throw new Error('User email not found')
      const { error } = await sb.auth.admin.generateLink({
        type: 'recovery',
        email: targetUser.email,
      })
      if (error) throw error

    } else if (action === 'impersonate') {
      // Generate a magic link for admin to log in as the target user
      const { data: targetUser } = await sb.from('leod_users').select('email').eq('id', targetId).single()
      if (!targetUser?.email) throw new Error('User email not found')
      const { data: linkData, error } = await sb.auth.admin.generateLink({
        type: 'magiclink',
        email: targetUser.email,
      })
      if (error) throw error
      result.magic_link = linkData?.properties?.action_link
    }

    // Audit log
    await sb.from('leod_admin_audit').insert({
      admin_id: user.id,
      action,
      target_type: 'user',
      target_id: targetId,
      details: { role: body.role, name: body.name },
    })

    return new Response(JSON.stringify(result), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/admin-manage-user/index.ts
git commit -m "feat: add admin-manage-user Edge Function"
```

### Task 3: Create admin-manage-subscription Edge Function

**Files:**
- Create: `supabase/functions/admin-manage-subscription/index.ts`

- [ ] **Step 1: Create the Edge Function**

```typescript
// admin-manage-subscription — Admin overrides subscription plan, extends trial, gifts months.
// Actions: override_plan, extend_trial, gift_months

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: callerRow } = await sb.from('leod_users')
    .select('role').eq('id', user.id).single()
  if (!callerRow || callerRow.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden — admin only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const action    = String(body.action     || '').trim()
  const directorId = String(body.director_id || '').trim()

  if (!directorId) {
    return new Response(JSON.stringify({ error: 'Missing director_id' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  try {
    if (action === 'override_plan') {
      const plan = String(body.plan || '').trim()
      const validPlans = ['trial','perevent','starter','pro','enterprise']
      if (!validPlans.includes(plan)) {
        return new Response(JSON.stringify({ error: `Invalid plan: ${plan}` }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const { error } = await sb.from('leod_subscriptions')
        .update({ plan, status: 'active' })
        .eq('director_id', directorId)
      if (error) throw error

    } else if (action === 'extend_trial') {
      const days = parseInt(String(body.days || '0'), 10)
      if (days <= 0) {
        return new Response(JSON.stringify({ error: 'Invalid days' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const { data: sub } = await sb.from('leod_subscriptions')
        .select('trial_ends_at').eq('director_id', directorId).single()
      const base = sub?.trial_ends_at ? new Date(sub.trial_ends_at) : new Date()
      const newEnd = new Date(base.getTime() + days * 86_400_000)
      const { error } = await sb.from('leod_subscriptions')
        .update({ trial_ends_at: newEnd.toISOString(), status: 'active' })
        .eq('director_id', directorId)
      if (error) throw error

    } else if (action === 'gift_months') {
      const plan = String(body.plan || 'pro').trim()
      const months = parseInt(String(body.months || '1'), 10)
      const periodEnd = new Date()
      periodEnd.setMonth(periodEnd.getMonth() + months)
      const { error } = await sb.from('leod_subscriptions')
        .update({
          plan,
          status: 'active',
          current_period_end: periodEnd.toISOString(),
          trial_ends_at: null,
        })
        .eq('director_id', directorId)
      if (error) throw error

    } else {
      return new Response(JSON.stringify({ error: `Invalid action: ${action}` }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // Audit
    await sb.from('leod_admin_audit').insert({
      admin_id: user.id,
      action: `subscription_${action}`,
      target_type: 'subscription',
      target_id: directorId,
      details: { plan: body.plan, days: body.days, months: body.months },
    })

    return new Response(JSON.stringify({ ok: true, action }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/admin-manage-subscription/index.ts
git commit -m "feat: add admin-manage-subscription Edge Function"
```

### Task 4: Create admin-manage-promo Edge Function

**Files:**
- Create: `supabase/functions/admin-manage-promo/index.ts`

- [ ] **Step 1: Create the Edge Function**

```typescript
// admin-manage-promo — Admin creates, edits, deactivates promo codes.
// Actions: create, update, deactivate

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: callerRow } = await sb.from('leod_users')
    .select('role').eq('id', user.id).single()
  if (!callerRow || callerRow.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden — admin only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const action = String(body.action || '').trim()

  try {
    if (action === 'create') {
      const code = String(body.code || '').trim().toUpperCase()
      const type = String(body.type || '').trim()
      if (!code || !['discount','trial_extension','plan_unlock'].includes(type)) {
        return new Response(JSON.stringify({ error: 'Invalid code or type' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const row: Record<string, unknown> = {
        code, type, active: true, uses: 0,
      }
      if (body.stripe_coupon_id) row.stripe_coupon_id = String(body.stripe_coupon_id)
      if (body.extra_days) row.extra_days = parseInt(String(body.extra_days), 10)
      if (body.granted_plan) row.granted_plan = String(body.granted_plan)
      if (body.granted_months) row.granted_months = parseInt(String(body.granted_months), 10)
      if (body.max_uses) row.max_uses = parseInt(String(body.max_uses), 10)
      if (body.expires_at) row.expires_at = String(body.expires_at)

      const { error } = await sb.from('leod_promo_codes').insert(row)
      if (error) throw error

    } else if (action === 'update') {
      const code = String(body.code || '').trim().toUpperCase()
      if (!code) {
        return new Response(JSON.stringify({ error: 'Missing code' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      const updates: Record<string, unknown> = {}
      if (body.max_uses !== undefined) updates.max_uses = body.max_uses === null ? null : parseInt(String(body.max_uses), 10)
      if (body.expires_at !== undefined) updates.expires_at = body.expires_at
      if (body.active !== undefined) updates.active = Boolean(body.active)
      if (body.stripe_coupon_id !== undefined) updates.stripe_coupon_id = body.stripe_coupon_id
      if (body.extra_days !== undefined) updates.extra_days = parseInt(String(body.extra_days), 10)
      if (body.granted_plan !== undefined) updates.granted_plan = body.granted_plan
      if (body.granted_months !== undefined) updates.granted_months = parseInt(String(body.granted_months), 10)

      const { error } = await sb.from('leod_promo_codes').update(updates).eq('code', code)
      if (error) throw error

    } else if (action === 'deactivate') {
      const code = String(body.code || '').trim().toUpperCase()
      const { error } = await sb.from('leod_promo_codes').update({ active: false }).eq('code', code)
      if (error) throw error

    } else {
      return new Response(JSON.stringify({ error: `Invalid action: ${action}` }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // Audit
    await sb.from('leod_admin_audit').insert({
      admin_id: user.id,
      action: `promo_${action}`,
      target_type: 'promo_code',
      target_id: String(body.code || ''),
      details: body,
    })

    return new Response(JSON.stringify({ ok: true, action }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/admin-manage-promo/index.ts
git commit -m "feat: add admin-manage-promo Edge Function"
```

### Task 5: Create admin-promote Edge Function

**Files:**
- Create: `supabase/functions/admin-promote/index.ts`

- [ ] **Step 1: Create the Edge Function**

```typescript
// admin-promote — Promotes a user to admin role. Only callable by existing admins.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const { data: callerRow } = await sb.from('leod_users')
    .select('role').eq('id', user.id).single()
  if (!callerRow || callerRow.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden — admin only' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const targetId = String(body.user_id || '').trim()
  if (!targetId) {
    return new Response(JSON.stringify({ error: 'Missing user_id' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Cannot demote yourself
  if (targetId === user.id) {
    return new Response(JSON.stringify({ error: 'Cannot modify your own admin status' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  try {
    const { error } = await sb.from('leod_users')
      .update({ role: 'admin' })
      .eq('id', targetId)
    if (error) throw error

    // Audit
    await sb.from('leod_admin_audit').insert({
      admin_id: user.id,
      action: 'promote_to_admin',
      target_type: 'user',
      target_id: targetId,
      details: {},
    })

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/admin-promote/index.ts
git commit -m "feat: add admin-promote Edge Function"
```

### Task 6: Deploy all admin Edge Functions

- [ ] **Step 1: Deploy**

```bash
bash scripts/deploy-functions.sh admin-manage-user
bash scripts/deploy-functions.sh admin-manage-subscription
bash scripts/deploy-functions.sh admin-manage-promo
bash scripts/deploy-functions.sh admin-promote
```

---

## Chunk 3: Admin Dashboard HTML — Shell, Auth, Theme, Console Isolation

### Task 7a: Create cuedeck-admin.html — HTML structure + login + auth

**Files:**
- Create: `cuedeck-admin.html`

- [ ] **Step 1: Create HTML file with head, CDN imports, login screen**

Create `cuedeck-admin.html` with:
- `<head>`: meta viewport, title "CueDeck Admin", Inter font from Google Fonts, Supabase JS v2 CDN, Chart.js CDN
- Login screen: centered card with email/password form, "CueDeck Admin" heading, error message area
- Access denied screen: "You do not have admin access" message with logout button
- Dashboard shell: empty sidebar + main content area (content added in later tasks)
- Supabase client init with same anon key as console

- [ ] **Step 2: Add boot() auth flow with admin role gate**

```javascript
const sb = supabase.createClient(
  'https://sawekpguemzvuvvulfbc.supabase.co',
  'ANON_KEY_HERE'
);
const S = { user: null, adminName: '' };

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { showLogin(); return; }
  const { data: row } = await sb.from('leod_users')
    .select('role, name').eq('id', session.user.id).single();
  if (!row || row.role !== 'admin') { showAccessDenied(); return; }
  S.user = session.user;
  S.adminName = row.name;
  showDashboard();
  loadDashboardData();
  startInactivityTimer();
}
```

- [ ] **Step 3: Add 30-minute session timeout**

```javascript
let _inactivityTimer;
function startInactivityTimer() {
  const TIMEOUT = 30 * 60 * 1000;
  const reset = () => { clearTimeout(_inactivityTimer); _inactivityTimer = setTimeout(logout, TIMEOUT); };
  ['mousemove','keydown','click','scroll'].forEach(e => document.addEventListener(e, reset));
  reset();
}
async function logout() { await sb.auth.signOut(); location.reload(); }
```

- [ ] **Step 4: Commit**

```bash
git add cuedeck-admin.html
git commit -m "feat: add cuedeck-admin.html with login and admin auth gate"
```

### Task 7b: Add CSS theme system (light/dark) and sidebar layout

**Files:**
- Modify: `cuedeck-admin.html`

- [ ] **Step 1: Add CSS custom properties for dark and light themes**

```css
[data-theme="dark"] {
  --bg: #0a0b14; --surface: #12141f; --surface-2: #1a1d2e;
  --border: rgba(255,255,255,.08); --text: #e2e8f0; --text-muted: #94a3b8;
  --accent: #8b5cf6; --accent-hover: #7c3aed;
  --success: #22c55e; --danger: #ef4444; --warning: #f59e0b;
}
[data-theme="light"] {
  --bg: #f8fafc; --surface: #ffffff; --surface-2: #f1f5f9;
  --border: #e2e8f0; --text: #1e293b; --text-muted: #64748b;
  --accent: #7c3aed; --accent-hover: #6d28d9;
  --success: #16a34a; --danger: #dc2626; --warning: #d97706;
}
```

- [ ] **Step 2: Add sidebar layout (240px fixed) + main content area**

Sidebar with 5 nav items (Dashboard, Users, Subscriptions, Promo Codes, Audit Log), admin name at top, theme toggle + logout at bottom. Main area fills remaining width.

- [ ] **Step 3: Add theme toggle logic**

```javascript
function initTheme() {
  const saved = localStorage.getItem('cuedeck_admin_theme');
  const theme = saved || (matchMedia('(prefers-color-scheme:light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', theme);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('cuedeck_admin_theme', next);
}
```

- [ ] **Step 4: Add showSection() for nav switching**

```javascript
function showSection(name) {
  document.querySelectorAll('.admin-section').forEach(el => el.style.display = 'none');
  document.getElementById('section-' + name).style.display = '';
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.section === name));
}
```

- [ ] **Step 5: Commit**

```bash
git add cuedeck-admin.html
git commit -m "feat: add light/dark theme system and sidebar layout"
```

### Task 8: Block admin role in production console

**Files:**
- Modify: `cuedeck-console.html` (in the `loadUserRole()` function)

- [ ] **Step 1: Add admin role block using DOM methods**

In `loadUserRole()`, after checking for `pending` and `suspended`, add a check for `admin`. Use DOM createElement/textContent (no innerHTML for security):

```javascript
if (row.role === 'admin') {
  const app = document.getElementById('app');
  app.textContent = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100vh;color:#94a3b8;font-size:18px';
  const inner = document.createElement('div');
  inner.style.textContent = 'text-align:center';
  const h = document.createElement('h2');
  h.textContent = 'Admin Account';
  const p = document.createElement('p');
  p.textContent = 'This account has admin access only.';
  const a = document.createElement('a');
  a.href = '/admin';
  a.textContent = 'Go to Admin Dashboard';
  a.style.cssText = 'color:#8b5cf6;text-decoration:underline';
  inner.appendChild(h);
  inner.appendChild(p);
  inner.appendChild(a);
  wrap.appendChild(inner);
  app.appendChild(wrap);
  return false;
}
```

- [ ] **Step 2: Commit**

```bash
git add cuedeck-console.html
git commit -m "feat: block admin role from production console, redirect to /admin"
```

### Task 9: Update vercel.json with /admin rewrite

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add rewrite rule BEFORE the catch-all `/` rule**

Insert at the top of the `rewrites` array (before the existing rules):
```json
{ "source": "/admin", "destination": "/cuedeck-admin.html" }
```

The final rewrites array should be:
```json
[
  { "source": "/admin",   "destination": "/cuedeck-admin.html" },
  { "source": "/",        "destination": "/cuedeck-console.html" },
  { "source": "/d",       "destination": "/cuedeck-display.html" },
  { "source": "/display", "destination": "/cuedeck-display.html" }
]
```

- [ ] **Step 2: Commit**

```bash
git add vercel.json
git commit -m "feat: add /admin rewrite to vercel.json"
```

---

## Chunk 4: Dashboard Analytics Section

### Task 10: Build the Dashboard Home analytics page

**Files:**
- Modify: `cuedeck-admin.html` (add to the dashboard section)

- [ ] **Step 1: Add stats cards row**

6 stat cards in a CSS grid (3 columns desktop, 2 tablet, 1 mobile):
- Total signups (with +N last 30d delta badge)
- Active subscribers
- DAU
- MRR (EUR)
- Churn rate (%)
- Conversion rate (%)

Each card: value, label, delta badge (green +, red -)

- [ ] **Step 2: Add Chart.js charts**

Three charts in a 2-column grid:
- Line chart: signups per day (30 days) — `admin_get_signups_per_day(30)`
- Bar chart: DAU last 14 days — `admin_get_dau_per_day(14)`
- Pie/doughnut chart: tier breakdown — `admin_get_tier_breakdown()`

- [ ] **Step 3: Add recent activity feed**

Two-column layout:
- Left: "Recent Signups" — last 10 from `admin_get_recent_signups(10)`
- Right: "Recent Events" — last 10 from `admin_get_recent_events(10)`

Each item: avatar circle (first letter), email/name, date, tier badge

- [ ] **Step 4: Wire up data loading**

```javascript
async function loadDashboardData() {
  const [statsRes, signupsRes, dauRes, tierRes, recentSignups, recentEvents] = await Promise.all([
    sb.rpc('admin_get_stats'),
    sb.rpc('admin_get_signups_per_day', { p_days: 30 }),
    sb.rpc('admin_get_dau_per_day', { p_days: 14 }),
    sb.rpc('admin_get_tier_breakdown'),
    sb.rpc('admin_get_recent_signups', { p_limit: 10 }),
    sb.rpc('admin_get_recent_events', { p_limit: 10 }),
  ]);
  renderStats(statsRes.data);
  renderSignupsChart(signupsRes.data);
  renderDAUChart(dauRes.data);
  renderTierChart(tierRes.data);
  renderRecentSignups(recentSignups.data);
  renderRecentEvents(recentEvents.data);
}
```

- [ ] **Step 5: Commit**

```bash
git add cuedeck-admin.html
git commit -m "feat: add analytics dashboard with stats, charts, activity feed"
```

---

## Chunk 5: Users, Subscriptions, Promo Codes, Audit Log Sections

### Task 11: Build Users section

**Files:**
- Modify: `cuedeck-admin.html`

- [ ] **Step 1: Add users table with search/filter bar**

Top bar: search input, role dropdown filter, status dropdown (active/suspended/all), pagination controls.

Table columns: Name, Email, Role, Org, Plan, Status, Last Login, Actions.

- [ ] **Step 2: Add user detail/edit slide-out panel**

Right panel that slides in when clicking a row:
- Editable fields: name, organization, role dropdown
- Status toggle (active/suspended)
- Action buttons: Reset Password, Promote to Admin, Delete/Ban
- Impersonate button (opens new tab)

- [ ] **Step 3: Wire up API calls**

```javascript
async function loadUsers(page = 1) {
  const { data } = await sb.rpc('admin_list_users', {
    p_search: userSearch, p_role_filter: roleFilter,
    p_status_filter: statusFilter, p_page: page, p_per_page: 25
  });
  renderUsersTable(data);
}

async function adminAction(action, payload) {
  const fn = action === 'promote_to_admin' ? 'admin-promote' : 'admin-manage-user';
  const { data, error } = await sb.functions.invoke(fn, { body: JSON.stringify(payload) });
  if (error) { showToast(error.message, 'error'); return; }
  showToast(`Action "${action}" completed`, 'success');
  loadUsers(currentPage);
}
```

- [ ] **Step 4: Commit**

```bash
git add cuedeck-admin.html
git commit -m "feat: add users management section"
```

### Task 12: Build Subscriptions section

**Files:**
- Modify: `cuedeck-admin.html`

- [ ] **Step 1: Add subscriptions table with filters**

Quick filter tabs: All, Active, Past Due, Canceled, Trial, Expired.
Table columns: User (email), Plan, Status, Interval, Period End, Stripe Link, Actions.

- [ ] **Step 2: Add subscription override modal**

Modal with:
- Override Plan dropdown (trial/perevent/starter/pro/enterprise)
- Extend Trial: days input
- Gift Months: plan dropdown + months input
- Confirmation prompt before applying

- [ ] **Step 3: Wire up API calls via admin-manage-subscription**

- [ ] **Step 4: Commit**

```bash
git add cuedeck-admin.html
git commit -m "feat: add subscriptions management section"
```

### Task 13: Build Promo Codes section

**Files:**
- Modify: `cuedeck-admin.html`

- [ ] **Step 1: Add promo codes table**

Table columns: Code, Type, Discount/Days/Plan, Max Uses, Current Uses, Expiry, Status, Actions.
Badge colors: discount=blue, trial_extension=green, plan_unlock=purple.

- [ ] **Step 2: Add create promo code modal**

Form fields change dynamically based on type:
- **discount:** stripe_coupon_id, max_uses, expires_at
- **trial_extension:** extra_days, max_uses, expires_at
- **plan_unlock:** granted_plan dropdown, granted_months, max_uses, expires_at

- [ ] **Step 3: Add edit/deactivate actions**

Inline edit for max_uses and expires_at. Toggle switch for active/inactive. Deactivate confirmation.

- [ ] **Step 4: Wire up API calls via admin-manage-promo**

- [ ] **Step 5: Commit**

```bash
git add cuedeck-admin.html
git commit -m "feat: add promo codes management section"
```

### Task 14: Build Audit Log section

**Files:**
- Modify: `cuedeck-admin.html`

- [ ] **Step 1: Add audit log feed with filters**

Filter bar: action type dropdown, date range picker (from/to), search.
Feed layout: timestamp, admin name, action badge, target, details expandable.

Data loaded via direct Supabase query on `leod_admin_audit` (RLS allows admin read).

- [ ] **Step 2: Add pagination**

Load 50 entries at a time with "Load more" button.

- [ ] **Step 3: Commit**

```bash
git add cuedeck-admin.html
git commit -m "feat: add audit log section"
```

---

## Chunk 6: Deploy & Verify

### Task 15: Final deployment and verification

- [ ] **Step 1: Push to cuedeck remote for Vercel deploy**

```bash
git push cuedeck main
```

- [ ] **Step 2: Apply migration 027 to live database**

Run `supabase/migrations/027_admin_dashboard.sql` in Supabase SQL Editor.

- [ ] **Step 3: Set admin role on your account**

```sql
UPDATE leod_users SET role = 'admin' WHERE email = 'YOUR_EMAIL';
```

- [ ] **Step 4: Deploy Edge Functions**

```bash
bash scripts/deploy-functions.sh admin-manage-user
bash scripts/deploy-functions.sh admin-manage-subscription
bash scripts/deploy-functions.sh admin-manage-promo
bash scripts/deploy-functions.sh admin-promote
```

- [ ] **Step 5: Verify in browser**

1. Open `https://app.cuedeck.io/admin`
2. Login with admin account
3. Verify dashboard loads with analytics
4. Test user management (search, edit, suspend)
5. Test subscription override
6. Test promo code creation
7. Verify audit log records all actions
8. Test theme toggle (light/dark)
9. Test session timeout (wait 30 min or manually trigger)
10. Verify non-admin accounts get "Access Denied"
11. Verify admin cannot access production console at `/`

- [ ] **Step 6: Final commit with any fixes**

```bash
git add -A
git commit -m "fix: admin dashboard polish and deploy verification"
git push cuedeck main
```
