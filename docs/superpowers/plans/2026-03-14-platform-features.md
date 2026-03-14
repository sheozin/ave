# CueDeck Platform Features Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 4 independent feature areas: editable user profiles, enhanced operators modal, promo/gift codes, and signage display pairing.

**Architecture:** All UI lives in `cuedeck-console.html` (single-file app). Backend uses Supabase tables + Edge Functions (Deno/TypeScript). Display page is `cuedeck-display.html`. Each area adds new DB columns/tables via migrations, new Edge Functions where needed, and new UI code in the console.

**Tech Stack:** Vanilla JS/CSS/HTML, Supabase JS v2 (CDN), Supabase Edge Functions (Deno), Stripe API (billing sync)

**Spec:** `docs/superpowers/specs/2026-03-14-platform-features-design.md`

---

## Chunk 1: Area 2 — Editable User Profiles

### Task 1: Database Migration — New Profile Columns

**Files:**
- Create: `supabase/migrations/019_user_profile_fields.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/019_user_profile_fields.sql`:

```sql
-- ============================================================
-- CueDeck — Migration 019: User Profile Fields
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Add new columns to leod_users
ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS vat_id TEXT;
ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS billing_address TEXT;

-- 2. RLS: Users can update their own row
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'leod_users'
      AND policyname = 'auth_update_own_profile'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "auth_update_own_profile"
        ON leod_users FOR UPDATE TO authenticated
        USING (id = auth.uid())
        WITH CHECK (id = auth.uid())
    $policy$;
  END IF;
END $$;

-- 3. RPC: get_operators_with_last_seen
CREATE OR REPLACE FUNCTION get_operators_with_last_seen()
RETURNS TABLE (
  id UUID,
  name TEXT,
  email TEXT,
  role TEXT,
  organization TEXT,
  active BOOLEAN,
  last_sign_in_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM leod_users WHERE leod_users.id = auth.uid() AND leod_users.role = 'director'
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
  SELECT u.id, u.name, u.email, u.role, u.organization, u.active,
         a.last_sign_in_at
  FROM leod_users u
  LEFT JOIN auth.users a ON a.id = u.id
  ORDER BY u.role, u.name;
END;
$$;
```

- [ ] **Step 2: Apply migration to live database**

Run in Supabase SQL Editor. Verify columns exist and RPC works.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/019_user_profile_fields.sql
git commit -m "feat: add profile fields migration + get_operators_with_last_seen RPC"
```

---

### Task 2: Edge Function — update-billing-details

**Files:**
- Create: `supabase/functions/update-billing-details/index.ts`

This Edge Function receives billing fields, updates `leod_users`, and syncs to Stripe customer metadata.

- [ ] **Step 1: Create the Edge Function**

Create `supabase/functions/update-billing-details/index.ts`. Pattern: follow `invite-operator/index.ts`.

Logic:
1. Auth: verify caller via JWT → `sb.auth.getUser(jwt)`
2. Verify caller is director via `leod_users.role`
3. Extract `company_name`, `vat_id`, `billing_address` from body
4. Update `leod_users` row with those fields
5. If `leod_subscriptions.stripe_customer_id` exists for this director, sync to Stripe:
   - POST `https://api.stripe.com/v1/customers/{id}` with `name`, `metadata[vat_id]`, `address[line1]`
   - Use `STRIPE_SECRET_KEY` env var
   - Non-fatal if Stripe sync fails
6. Return `{ ok: true }`

- [ ] **Step 2: Deploy**

```bash
bash scripts/deploy-functions.sh update-billing-details
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/update-billing-details/index.ts
git commit -m "feat: add update-billing-details edge function"
```

---

### Task 3: UI — Editable Profile Panel

**Files:**
- Modify: `cuedeck-console.html`
  - Profile panel HTML at ~line 1671
  - `renderProfilePanel()` at ~line 5511
  - `boot()` function (load new fields into state)

**What to change:**

1. **HTML** (~line 1671): Inside the `profile-panel` div, after the `pp-identity` section:
   - Make `pp-identity` div `position:relative`
   - Add Edit button: `<button id="pp-edit-btn" onclick="toggleProfileEdit()">✎ Edit</button>` (positioned top-right)
   - Add `<div id="pp-edit-section" style="display:none">` containing:
     - "Personal Details" header
     - Name input (`#pp-edit-name`)
     - Organization input (`#pp-edit-org`)
     - Phone input (`#pp-edit-phone`)
     - Divider
     - "Billing Details" section with Director badge (`#pp-billing-section`, display:none by default)
     - Company Name input (`#pp-edit-company`)
     - VAT/Tax ID input (`#pp-edit-vat`)
     - Billing Address textarea (`#pp-edit-address`)
     - "Save Changes" button calling `saveProfileChanges()`
     - Status div (`#pp-save-status`)

2. **JS** (after `renderProfilePanel()` ~line 5605): Add two functions:

   `toggleProfileEdit()`:
   - Toggle `pp-edit-section` display
   - When opening: populate inputs from `S.userName`, `S.userOrg`, `S.userPhone`, `S.userCompanyName`, `S.userVatId`, `S.userBillingAddress`
   - Show billing section only if `S.userRole === 'director'`
   - Toggle button text between "✎ Edit" and "✕ Cancel"

   `saveProfileChanges()`:
   - Read values from inputs
   - `sb.from('leod_users').update({ name, organization, phone }).eq('id', S.user.id)`
   - Update `S.userName`, `S.userOrg`, `S.userPhone` in local state
   - If director: call `sb.functions.invoke('update-billing-details', { body: { company_name, vat_id, billing_address } })`
   - Re-render profile panel, close edit section
   - Show "✓ Saved" status

3. **Boot** (~where `S.userName` is set): Add `phone, company_name, vat_id, billing_address` to the `.select()` query on `leod_users`, and store them as `S.userPhone`, `S.userCompanyName`, `S.userVatId`, `S.userBillingAddress`.

- [ ] **Step 1: Update profile panel HTML**
- [ ] **Step 2: Add toggleProfileEdit() and saveProfileChanges() JS**
- [ ] **Step 3: Update boot() to load new fields**
- [ ] **Step 4: Test in browser** — edit profile, save, refresh, verify persistence
- [ ] **Step 5: Commit**

```bash
git add cuedeck-console.html
git commit -m "feat: editable user profiles with personal + billing details"
```

---

## Chunk 2: Area 3 — Enhanced Operators Modal

### Task 4: Edge Function — manage-operator

**Files:**
- Create: `supabase/functions/manage-operator/index.ts`

Handles 3 actions via `body.action`:
- `suspend`: `sb.from('leod_users').update({ active: false }).eq('id', targetId)`
- `reactivate`: `sb.from('leod_users').update({ active: true }).eq('id', targetId)`
- `remove`: Delete `leod_users` row + ban auth account via `sb.auth.admin.updateUserById(targetId, { ban_duration: '876600h' })`

Pattern: same auth check as `invite-operator`. Cannot act on yourself (`targetId === user.id` → 400). Audit log to `leod_event_log`.

- [ ] **Step 1: Create the Edge Function**
- [ ] **Step 2: Deploy**: `bash scripts/deploy-functions.sh manage-operator`
- [ ] **Step 3: Commit**

```bash
git add supabase/functions/manage-operator/index.ts
git commit -m "feat: add manage-operator edge function (suspend/reactivate/remove)"
```

---

### Task 5: UI — Enhanced Operators Modal

**Files:**
- Modify: `cuedeck-console.html`
  - Users modal HTML at ~line 1956
  - `refreshUsersModal()` at ~line 5254
  - Add new functions: `filterOperators()`, `manageOperator()`, `confirmRemoveUser()`, `renderOperatorRows()`
  - Add `showSuspendedScreen()` + login gate in `boot()`

**Changes:**

1. **HTML** (~line 1977): After `invite-section`, before `users-modal-body`, add search input:
   ```
   <input id="um-search" placeholder="🔍  Search operators..." oninput="filterOperators()">
   ```

2. **Rewrite `refreshUsersModal()`** to:
   - Call `sb.rpc('get_operators_with_last_seen')` instead of direct query
   - Store results in module-level `_operatorsData`
   - Call `renderOperatorRows(data)`

3. **New `renderOperatorRows(data)` function** renders each row with:
   - Name + organization + SUSPENDED badge (if suspended, row at 0.6 opacity)
   - Email
   - Last seen line: dot (green/red/gray) + "Last seen: Xh ago" or "never"
   - Role select (options capitalized: Director, Stage, AV, Interp, Reg, Signage, Pending)
   - Action buttons per state:
     - Active: "Update" + "⏸" (suspend)
     - Pending: "Approve" + "🗑" (remove)
     - Suspended: "▶ Activate" + "🗑" (remove)
   - Cannot show action buttons for self (`u.id === S.user?.id`)
   - Footer: "X operators · Y pending · Z suspended"

4. **`filterOperators()`**: Client-side filter of `_operatorsData` by name/email, re-render

5. **`manageOperator(userId, action)`**: Invoke `manage-operator` edge function, refresh modal on success

6. **`confirmRemoveUser(userId, name)`**: `confirm()` dialog, then call `manageOperator`

7. **CSS**: Add styles for `.um-suspend-btn`, `.um-activate-btn`, `.um-remove-btn`

8. **Login gate**: In `boot()`, after fetching user row, if `userRow.active === false`, call `showSuspendedScreen()` and return

9. **`showSuspendedScreen()`**: Full-screen overlay with "Account Suspended" message and Sign Out button

- [ ] **Step 1: Add search input HTML**
- [ ] **Step 2: Add CSS for new button styles**
- [ ] **Step 3: Rewrite refreshUsersModal() + add renderOperatorRows()**
- [ ] **Step 4: Add filterOperators(), manageOperator(), confirmRemoveUser()**
- [ ] **Step 5: Add login gate + showSuspendedScreen()**
- [ ] **Step 6: Test in browser** — search, suspend, activate, remove, login gate
- [ ] **Step 7: Commit**

```bash
git add cuedeck-console.html
git commit -m "feat: enhanced operators modal with search, suspend, remove, last-seen"
```

---

## Chunk 3: Area 4 — Promo / Gift Codes

### Task 6: Database Migration — Promo Codes Table

**Files:**
- Create: `supabase/migrations/020_promo_codes.sql`

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS leod_promo_codes (
  code           TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('discount', 'trial_extension', 'plan_unlock')),
  stripe_coupon_id TEXT,
  extra_days     INT,
  granted_plan   TEXT,
  granted_months INT,
  max_uses       INT,
  uses           INT DEFAULT 0,
  expires_at     TIMESTAMPTZ,
  active         BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE leod_promo_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_promo_codes"
  ON leod_promo_codes FOR SELECT TO authenticated
  USING (true);
```

- [ ] **Step 2: Apply + insert test data** (LAUNCH20, EVENTPRO, VIP2026)
- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/020_promo_codes.sql
git commit -m "feat: add promo codes table migration"
```

---

### Task 7: Edge Function — redeem-code

**Files:**
- Create: `supabase/functions/redeem-code/index.ts`

Logic:
1. Auth: verify caller via JWT
2. Look up code in `leod_promo_codes` (case-insensitive, `.toUpperCase()`)
3. Validate: `active`, not expired, `uses < max_uses`
4. Find director's subscription (caller might be operator — check `invited_by`)
5. Apply based on `type`:
   - `discount`: Return `stripe_coupon_id` for checkout
   - `trial_extension`: Update `leod_subscriptions.trial_ends_at += extra_days`
   - `plan_unlock`: Update `leod_subscriptions.plan` + `current_period_end` + set `status='active'`
6. Increment `uses` counter
7. Return result with message

- [ ] **Step 1: Create the Edge Function**
- [ ] **Step 2: Deploy**: `bash scripts/deploy-functions.sh redeem-code`
- [ ] **Step 3: Commit**

```bash
git add supabase/functions/redeem-code/index.ts
git commit -m "feat: add redeem-code edge function"
```

---

### Task 8: UI — Promo Code Input

**Files:**
- Modify: `cuedeck-console.html`
  - Billing modal HTML at ~line 2021
  - Trial expired screen (search for `trial-expired-screen`)

**Changes:**

1. **Billing modal** (~line 2053, before `ev-modal-actions`): Add promo code section:
   - "Have a promo or gift code?" label
   - Code input (`#bm-promo-code`, monospace, letter-spacing)
   - "Apply" button calling `redeemPromoCode('bm')`
   - Status div (`#bm-promo-status`)

2. **Trial expired screen**: Add same code input section:
   - "Have a code?" label
   - Input (`#te-promo-code`)
   - "Apply" button calling `redeemPromoCode('te')`
   - Status div (`#te-promo-status`)

3. **JS function `redeemPromoCode(prefix)`**:
   - Read code from `#${prefix}-promo-code`
   - Call `sb.functions.invoke('redeem-code', { body: { code } })`
   - On error: show error in status div
   - On success:
     - For `discount`: store `S._pendingCoupon = data.stripe_coupon_id`
     - For `trial_extension`/`plan_unlock`: reload subscription, refresh UI; if on trial-expired screen (`prefix === 'te'`), reload page
   - Show success message

4. **Wire coupon into checkout**: In `startCheckout()`, pass `S._pendingCoupon` in the body if set. Update `create-checkout-session` edge function to accept `coupon_id` and pass as `discounts` to Stripe.

- [ ] **Step 1: Add promo code HTML to billing modal**
- [ ] **Step 2: Add promo code HTML to trial expired screen**
- [ ] **Step 3: Add redeemPromoCode() JS function**
- [ ] **Step 4: Wire coupon into startCheckout()**
- [ ] **Step 5: Test** — invalid code error, trial extension, plan unlock, discount at checkout
- [ ] **Step 6: Commit**

```bash
git add cuedeck-console.html
git commit -m "feat: promo/gift code redemption in billing modal + trial expiry screen"
```

---

## Chunk 4: Area 1 — Signage Display Connection

### Task 9: Database Migration — Signage Pairing Table

**Files:**
- Create: `supabase/migrations/018_signage_pairing.sql`

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS leod_signage_pairing (
  code       TEXT PRIMARY KEY,
  display_id UUID,
  event_id   UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pairing_code ON leod_signage_pairing (code);

ALTER TABLE leod_signage_pairing ENABLE ROW LEVEL SECURITY;

-- Both anon and authenticated need CRUD (display page is unauthenticated)
CREATE POLICY "anon_all_pairing" ON leod_signage_pairing FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_pairing" ON leod_signage_pairing FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

- [ ] **Step 2: Apply migration**
- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/018_signage_pairing.sql
git commit -m "feat: add signage pairing table migration"
```

---

### Task 10: Display Page — Pairing Code Generation

**Files:**
- Modify: `cuedeck-display.html` — setup screen (~line 295)

**Changes:**

1. Replace the existing "Enter Display ID" setup screen with a pairing code view:
   - Large 6-char code display (e.g., `A7K-3M2`)
   - "Enter this code in your CueDeck console" instruction
   - Animated waiting indicator
   - Countdown timer (5 min TTL)
   - Fallback: "Or enter Display ID manually" with existing input

2. **JS logic**:
   - `generatePairingCode()`: 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I), formatted as `XXX-XXX`
   - `startPairing()`:
     1. Generate code, store in `leod_signage_pairing` with 5-min expiry
     2. Display code on screen
     3. Start countdown timer
     4. Poll `leod_signage_pairing` every 2s for `display_id` to be set
     5. On match: auto-boot display with that ID
     6. On expiry: auto-regenerate
   - `manualBoot()`: existing manual ID entry flow

3. **On page load**: If no `#id=` hash, show pairing screen and call `startPairing()`

- [ ] **Step 1: Replace setup screen HTML**
- [ ] **Step 2: Add generatePairingCode() and startPairing() JS**
- [ ] **Step 3: Update boot logic to call startPairing() when no hash ID**
- [ ] **Step 4: Test** — open display page, see code, pair from console
- [ ] **Step 5: Commit**

```bash
git add cuedeck-display.html
git commit -m "feat: display page pairing code generation + polling"
```

---

### Task 11: Console — Add Display Pairing + Device Dashboard

**Files:**
- Modify: `cuedeck-console.html`
  - `renderSignagePanel()` at ~line 3552
  - Display modal / creation flow

**Changes:**

1. **Pairing function** `pairDisplayByCode(code)`:
   - Look up code in `leod_signage_pairing` (validate not expired, not already used)
   - Create new `leod_signage_displays` row
   - Update `leod_signage_pairing.display_id` with new display ID
   - Refresh signage panel

2. **Add Display wizard** — modify the "Add Display" button to open a choice:
   - "🔗 Pairing Code" — shows code input, calls `pairDisplayByCode()`
   - "⚙️ Manual Setup" — opens existing display create modal

3. **Device dashboard enhancements** in `renderSignagePanel()`:
   - Already shows online/offline dot — add "Online"/"Offline" text badge
   - Add "last seen" timestamp text (e.g., "12s ago", "3h ago") using `d.last_seen_at`

- [ ] **Step 1: Add pairDisplayByCode() function**
- [ ] **Step 2: Modify Add Display button to show pairing code option**
- [ ] **Step 3: Enhance display rows with last-seen timestamps**
- [ ] **Step 4: Test** — pair display via code, verify auto-connection, check dashboard
- [ ] **Step 5: Commit**

```bash
git add cuedeck-console.html
git commit -m "feat: signage display pairing wizard + enhanced device dashboard"
```

---

## Final: Deploy & Verify

### Task 12: Deploy All

- [ ] **Step 1: Deploy edge functions**
```bash
bash scripts/deploy-functions.sh update-billing-details
bash scripts/deploy-functions.sh manage-operator
bash scripts/deploy-functions.sh redeem-code
```

- [ ] **Step 2: Apply migrations 018, 019, 020 to live DB**

- [ ] **Step 3: Run tests**
```bash
npm test
```

- [ ] **Step 4: Push to deploy**
```bash
git push origin main
git push cuedeck main
```

- [ ] **Step 5: Verify on live site** — test all 4 features at `https://app.cuedeck.io`
