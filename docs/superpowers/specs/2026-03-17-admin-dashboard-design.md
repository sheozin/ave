# CueDeck Admin Dashboard Design Spec

**Date:** 2026-03-17
**Status:** Approved
**Approach:** Separate HTML file on same domain (Approach A)

## Overview

Platform-level super-admin dashboard for managing ALL users, subscriptions, promo codes, and analytics across the entire CueDeck platform. Completely isolated from the production console.

## URL & Routing

- **URL:** `https://app.cuedeck.io/admin`
- **File:** `cuedeck-admin.html`
- **Vercel rewrite:** `/admin` -> `/cuedeck-admin.html`

## Security Model

| Layer | Implementation |
|-------|---------------|
| Role gate | New `admin` role in `leod_users`. Boot checks `role = 'admin'`, shows "Access Denied" for all others |
| RLS policies | Admin-only policies on all tables for cross-tenant reads |
| Admin RPCs | Server-side Postgres functions for aggregated queries |
| Audit log | Every admin action logged to `leod_admin_audit` table |
| Session timeout | 30-minute inactivity auto-logout |
| Console isolation | Admin role NOT in ROLE_WRITE — admins cannot operate production console |

### Admin Role Rules
- Admins see ALL users, subscriptions, events across every organization
- Directors/operators cannot access the admin page
- Admin cannot use the production console (not in ROLE_WRITE)
- Only existing admins can promote others to admin

## Database Changes

### Migration 027: Admin role + audit table

```sql
-- Expand role constraint to include 'admin'
ALTER TABLE leod_users DROP CONSTRAINT IF EXISTS leod_users_role_check;
ALTER TABLE leod_users ADD CONSTRAINT leod_users_role_check
  CHECK (role IN ('admin','director','stage','av','interp','reg','signage','pending'));

-- Admin audit log
CREATE TABLE leod_admin_audit (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_id UUID REFERENCES auth.users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,  -- 'user', 'subscription', 'promo_code'
  target_id TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE leod_admin_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_audit_read ON leod_admin_audit FOR SELECT
  USING (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY admin_audit_insert ON leod_admin_audit FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'));
```

### Admin-only RLS policies on existing tables
- `leod_users`: admin can SELECT/UPDATE all rows
- `leod_subscriptions`: admin can SELECT/UPDATE all rows
- `leod_promo_codes`: admin can SELECT/INSERT/UPDATE all rows
- `leod_events`: admin can SELECT all rows (read-only)
- `leod_sessions`: admin can SELECT all rows (read-only)
- `leod_event_log`: admin can SELECT all rows (read-only)

### Admin RPC Functions (server-side)

```
admin_get_stats() → { total_users, active_subs, dau, mrr, churn_rate, conversion_rate, deltas }
admin_get_signups_per_day(days INT) → [{ date, count }]
admin_get_dau_per_day(days INT) → [{ date, count }]
admin_get_tier_breakdown() → [{ plan, count }]
admin_get_recent_signups(limit INT) → [{ email, date, plan }]
admin_get_recent_events(limit INT) → [{ name, operator, date }]
admin_list_users(search, role_filter, status_filter, page, per_page) → [users]
admin_list_subscriptions(filter, page, per_page) → [subscriptions]
admin_list_promo_codes(page, per_page) → [codes]
admin_get_promo_redemptions(code) → [{ user, date }]
```

## Dashboard Pages (5 sections)

### 1. Dashboard Home (Analytics)

**Stats cards** (with +/- delta vs previous 30 days):
- Total signups (all time + 30-day delta)
- Active subscribers by tier: Pay-per-event / Starter (EUR 59) / Pro (EUR 99)
- DAU — users with any event session in last 24h
- MRR — sum of active subscription values
- Churn rate — cancellations last 30 days / active start of period
- Conversion rate — signups to paying subscribers

**Charts:**
- Line: signups per day (last 30 days)
- Bar: DAU last 14 days
- Pie: tier breakdown

**Recent Activity Feed:**
- Last 10 signups (email, date, tier)
- Last 10 events run (name, operator, date)

### 2. Users

- Searchable/sortable table: name, email, role, org, plan, status, last login
- Click row -> detail panel: edit role, name, org, active status
- Actions: suspend, reactivate, delete/ban, force password reset, promote to admin
- Impersonate: opens console in new tab as that user

### 3. Subscriptions

- All subscriptions table: user, plan, status, interval, period dates, Stripe link
- Manual override: upgrade/downgrade plan, extend trial, gift months
- Quick filters: active, past_due, canceled, trial, expired

### 4. Promo Codes

- Full table: code, type, discount/days/plan, max uses, current uses, expiry, active
- Create new code form: type selector (discount/trial_extension/plan_unlock), all fields
- Edit existing: toggle active, change max uses, extend expiry
- Redemption history: who redeemed what, when

### 5. Audit Log

- Chronological feed of all admin actions
- Filters: action type, admin, date range
- Read-only (no editing/deleting audit entries)

## Edge Functions (4 new)

| Function | Purpose |
|----------|---------|
| `admin-manage-user` | Change role, suspend, ban, reset password, impersonate token |
| `admin-manage-subscription` | Override plan, extend trial, gift months |
| `admin-manage-promo` | Create/edit/deactivate promo codes |
| `admin-promote` | Promote user to admin (admin-only) |

All functions: verify JWT + check `role='admin'` + log to `leod_admin_audit`.

## Tech Stack

- **Charts:** Chart.js via CDN (lightweight, no build)
- **Everything else:** vanilla JS, Supabase via CDN (same as console)
- **Styling:** light/dark theme toggle
  - **Dark theme:** matches console palette (blue-tinted dark)
  - **Light theme:** clean white/gray with purple admin accent
  - **Toggle:** stored in localStorage, defaults to system preference via `prefers-color-scheme`
  - **Admin accent:** purple/violet to visually distinguish from console's blue

## File Structure

```
cuedeck-admin.html                          — single-file admin dashboard
supabase/migrations/027_admin_dashboard.sql — role expansion + audit table + RLS + RPCs
supabase/functions/admin-manage-user/       — user management Edge Function
supabase/functions/admin-manage-subscription/ — subscription override Edge Function
supabase/functions/admin-manage-promo/      — promo code management Edge Function
supabase/functions/admin-promote/           — admin promotion Edge Function
```
