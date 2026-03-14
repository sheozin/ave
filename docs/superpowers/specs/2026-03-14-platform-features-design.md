# CueDeck Platform Features Design Spec

**Date:** 2026-03-14
**Status:** Approved
**Scope:** 4 independent feature areas for the CueDeck production console

---

## Area 1: Signage Display Connection

### Problem
Users don't understand how to connect physical screens to CueDeck. The current flow requires copying a UUID from the console and pasting it into the display page — unintuitive and error-prone.

### Solution

#### 1a. Pairing Code Flow
- `cuedeck-display.html` setup screen shows a **6-character alphanumeric pairing code** (e.g. `A7K-3M2`)
- Code generated client-side, stored in `leod_signage_pairing` table with 5-minute TTL
- Display polls for pairing confirmation every 2 seconds
- In the console, director enters the code in the Add Display wizard to link the display
- Works across networks (both communicate through Supabase)

#### 1b. Add Display Wizard
- Replaces the current "create display" modal with a step-by-step flow:
  1. Choose: **Pairing Code** (enter code from screen) or **Manual Setup** (configure without screen)
  2. Enter pairing code → auto-fills display name from screen
  3. Configure: content mode, zone type, orientation, filter room
  4. Confirmation: "Display connected" (heartbeat detected)

#### 1c. Device Dashboard
- Each display row in the Signage panel shows:
  - **Green/red dot** — online if `last_seen_at` < 60 seconds ago
  - **"Online"/"Offline" badge**
  - **Last seen timestamp** (e.g. "12s ago", "3h ago")
  - Existing Launch + QR buttons remain

#### Database Changes
- New table: `leod_signage_pairing` (code TEXT, display_id UUID NULL, event_id UUID, created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ)
- RLS: authenticated users can insert/read own event's pairing codes
- Migration: `018_signage_pairing.sql`

---

## Area 2: User Profiles

### Problem
Users cannot edit their name, organization, phone, or billing details after signup. The profile panel is read-only.

### Solution

#### Editable Profile Panel
- Existing profile panel in sidebar upgraded with inline-edit capability
- Click **"Edit"** button to toggle fields into editable inputs
- Fields: **Name**, **Organization**, **Phone** (new column)
- Save updates `leod_users` directly via Supabase client

#### Billing Details Section (Director Only)
- Below personal details: **Company Name**, **VAT/Tax ID**, **Billing Address**
- Stored on `leod_users` as new columns
- On save, syncs to Stripe customer object via edge function `update-billing-details`

#### Database Changes
- New columns on `leod_users`: `phone TEXT`, `company_name TEXT`, `vat_id TEXT`, `billing_address TEXT`
- RLS: users can update their own row (SELECT + UPDATE policies)
- Migration: `019_user_profile_fields.sql`

#### Edge Function
- `update-billing-details` — receives billing fields, updates `leod_users` + Stripe customer metadata

---

## Area 3: Enhanced Operators Modal

### Problem
Directors cannot search, suspend, or remove operators. The current modal only supports invite + role change.

### Solution

Enhance the existing operators modal (same position, width, dark card style):

1. **Search bar** — input below invite section, client-side filter by name/email
2. **Last active** — each row shows "Last seen: Xh ago" (query `auth.users.last_sign_in_at` via RPC)
3. **Suspend button** (⏸) — sets `leod_users.active = false`, user sees "Account suspended" on next login
4. **Reactivate button** (▶) — sets `leod_users.active = true` (shown for suspended users)
5. **Remove button** (🗑) — confirmation dialog, then deletes `leod_users` row + disables auth account via admin API
6. **Status summary** — footer shows "X operators · Y pending · Z suspended"

#### Login Gate for Suspended Users
- After auth sign-in, check `leod_users.active`
- If `active = false`, show "Your account has been suspended. Contact your director." screen
- Sign Out button available

#### Edge Function
- `manage-operator` — handles suspend/reactivate/remove actions (requires director JWT + admin API for auth account disable)

#### Database Changes
- No new tables — uses existing `leod_users.active` column (already in schema)
- New RPC: `get_operators_with_last_seen` — joins `leod_users` with `auth.users.last_sign_in_at`

---

## Area 4: Promo / Gift Codes

### Problem
No way to give users discounts, extend trials, or gift free plans.

### Solution

#### Flexible Code System (3 types)

| Type | Effect | Backend |
|------|--------|---------|
| `discount` | % or fixed amount off at checkout | Stripe coupon via `stripe_coupon_id` |
| `trial_extension` | Adds X days to trial period | Updates `leod_subscriptions.trial_ends_at` |
| `plan_unlock` | Grants free plan for X months | Updates `leod_subscriptions.plan` + `current_period_end` |

#### User-Facing UI
- **Billing modal**: "Have a promo or gift code?" input + Apply button below plan cards
- **Trial expiry screen**: same code input so blocked users can unlock without choosing a plan
- Success/error feedback inline

#### Code Management
- Via **Supabase Studio** — insert/edit rows in `leod_promo_codes` table
- Stripe coupons created in Stripe Dashboard, linked by `stripe_coupon_id`

#### Database Changes
```sql
CREATE TABLE leod_promo_codes (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('discount', 'trial_extension', 'plan_unlock')),
  stripe_coupon_id TEXT,
  extra_days INT,
  granted_plan TEXT,
  granted_months INT,
  max_uses INT,
  uses INT DEFAULT 0,
  expires_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```
- Migration: `020_promo_codes.sql`
- RLS: read-only for authenticated users (to validate codes client-side is NOT allowed — validation happens server-side only)

#### Edge Function
- `redeem-code` — validates code (active, not expired, uses < max_uses), applies effect based on type, increments uses counter
  - `discount`: returns Stripe coupon ID for checkout session to apply
  - `trial_extension`: updates `trial_ends_at` += extra_days
  - `plan_unlock`: updates plan + status + period_end

---

## Implementation Order

1. **User Profiles** (Area 2) — foundational, other features reference user data
2. **Enhanced Operators** (Area 3) — builds on profile fields
3. **Promo Codes** (Area 4) — independent, can parallel with above
4. **Signage Connection** (Area 1) — largest scope, independent of others

## Files Affected

| File | Changes |
|------|---------|
| `cuedeck-console.html` | Profile panel edit mode, operators modal enhancements, promo code input in billing modal + trial expiry, signage pairing wizard + device dashboard |
| `cuedeck-display.html` | Pairing code generation + display on setup screen |
| `supabase/migrations/018_signage_pairing.sql` | New pairing table |
| `supabase/migrations/019_user_profile_fields.sql` | New columns on leod_users |
| `supabase/migrations/020_promo_codes.sql` | New promo codes table |
| `supabase/functions/update-billing-details/` | Sync billing to Stripe |
| `supabase/functions/manage-operator/` | Suspend/reactivate/remove |
| `supabase/functions/redeem-code/` | Validate + apply promo codes |
