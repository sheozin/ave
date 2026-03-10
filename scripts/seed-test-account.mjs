#!/usr/bin/env node
/**
 * seed-test-account.mjs
 * Creates (or resets) a dedicated test director account in Supabase,
 * seeds a test event, and adds sample sessions for E2E testing.
 *
 * Usage:
 *   node scripts/seed-test-account.mjs
 *
 * Required env vars (create a .env.test file or export them):
 *   SUPABASE_URL           https://xxx.supabase.co
 *   SUPABASE_SERVICE_KEY   service_role key (from Supabase dashboard → Settings → API)
 *   TEST_EMAIL             e.g. test-director@cuedeck.io
 *   TEST_PASSWORD          a strong password for the test account
 *
 * What it does:
 *   1. Creates auth user via admin API (or resets password if it already exists)
 *   2. Upserts leod_users row with director role
 *   3. Creates (or updates) a test event "CueDeck Test Event"
 *   4. Deletes any existing sessions for that event
 *   5. Seeds 5 sample sessions (PLANNED state, staggered times)
 *   6. Prints the TEST_SESSION_ID for use in E2E tests
 *
 * After running, add to your .env.test:
 *   TEST_EMAIL=...
 *   TEST_PASSWORD=...
 *   TEST_SESSION_ID=<printed by this script>
 */

import { createClient } from '@supabase/supabase-js';

// ── Load env ──────────────────────────────────────────────────────────────
const SUPABASE_URL        = process.env.SUPABASE_URL        || 'https://sawekpguemzvuvvulfbc.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TEST_EMAIL           = process.env.TEST_EMAIL           || 'test-director@cuedeck-test.io';
const TEST_PASSWORD        = process.env.TEST_PASSWORD        || 'TestDirector2026!!';

if (!SUPABASE_SERVICE_KEY) {
  console.error('\n❌  SUPABASE_SERVICE_KEY is required.');
  console.error('   Get it from: Supabase Dashboard → Settings → API → service_role secret\n');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const log = (msg) => console.log(`  ${msg}`);
const ok  = (msg) => console.log(`  ✅ ${msg}`);
const err = (msg) => console.log(`  ❌ ${msg}`);

// ── Step 1: Create or reset test auth user ────────────────────────────────
async function upsertAuthUser() {
  log('Creating test auth user…');

  // Try to create fresh
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email:             TEST_EMAIL,
    password:          TEST_PASSWORD,
    email_confirm:     true,   // skip email confirmation for test account
    user_metadata:     { name: 'Test Director', organization: 'CueDeck QA' },
  });

  if (created?.user) {
    ok(`Auth user created: ${created.user.id}`);
    return created.user.id;
  }

  // Already exists — get the existing user
  if (createErr?.message?.includes('already registered') || createErr?.status === 422) {
    log('User already exists — fetching…');
    const { data: { users } } = await sb.auth.admin.listUsers();
    const existing = users?.find(u => u.email === TEST_EMAIL);
    if (!existing) { err('Could not find existing user.'); process.exit(1); }

    // Reset password to keep test account predictable
    await sb.auth.admin.updateUserById(existing.id, { password: TEST_PASSWORD, email_confirm: true });
    ok(`Auth user reset: ${existing.id}`);
    return existing.id;
  }

  err(`Failed to create auth user: ${createErr?.message}`);
  process.exit(1);
}

// ── Step 2: Upsert leod_users director row ────────────────────────────────
async function upsertDirectorProfile(userId) {
  log('Upserting director profile…');
  const { error } = await sb.from('leod_users').upsert({
    id:           userId,
    email:        TEST_EMAIL,
    role:         'director',
    name:         'Test Director',
    organization: 'CueDeck QA',
    active:       true,
  }, { onConflict: 'id' });

  if (error) { err(`Profile upsert failed: ${error.message}`); process.exit(1); }
  ok('Director profile ready.');
}

// ── Step 3: Upsert test event ─────────────────────────────────────────────
async function upsertTestEvent(directorId) {
  log('Upserting test event…');

  // Check for existing test event
  const { data: existing } = await sb
    .from('leod_events')
    .select('id')
    .eq('name', 'CueDeck Test Event')
    .eq('director_id', directorId)
    .maybeSingle();

  if (existing) {
    ok(`Test event already exists: ${existing.id}`);
    return existing.id;
  }

  const { data, error } = await sb.from('leod_events').insert({
    name:        'CueDeck Test Event',
    date:        new Date().toISOString().split('T')[0],
    timezone:    'Europe/Warsaw',
    director_id: directorId,
    active:      true,
  }).select('id').single();

  if (error) { err(`Event insert failed: ${error.message}`); process.exit(1); }
  ok(`Test event created: ${data.id}`);
  return data.id;
}

// ── Step 4: Seed sessions ─────────────────────────────────────────────────
async function seedSessions(eventId) {
  log('Clearing old test sessions…');
  await sb.from('leod_sessions').delete().eq('event_id', eventId);

  log('Seeding 5 sample sessions…');
  const sessions = [
    { sort_order: 1, title: 'Opening Ceremony',          type: 'Keynote',  planned_start: '09:00', planned_end: '09:30', speaker: 'Conference Chair',  room: 'Main Hall' },
    { sort_order: 2, title: 'Keynote: Future of Events', type: 'Keynote',  planned_start: '09:30', planned_end: '10:15', speaker: 'Jane Smith',       room: 'Main Hall' },
    { sort_order: 3, title: 'Morning Coffee Break',      type: 'Break',    planned_start: '10:15', planned_end: '10:45', speaker: '',                 room: 'Foyer'     },
    { sort_order: 4, title: 'Tech Innovation Panel',     type: 'Panel',    planned_start: '10:45', planned_end: '12:00', speaker: 'Panel Moderator',  room: 'Main Hall' },
    { sort_order: 5, title: 'Working Lunch',             type: 'Break',    planned_start: '12:00', planned_end: '13:00', speaker: '',                 room: 'Dining'    },
  ].map(s => ({
    ...s,
    event_id:        eventId,
    scheduled_start: s.planned_start,
    scheduled_end:   s.planned_end,
    status:          'PLANNED',
  }));

  const { data, error } = await sb.from('leod_sessions').insert(sessions).select('id, sort_order, title');
  if (error) { err(`Session seed failed: ${error.message}`); process.exit(1); }

  data.forEach(s => ok(`  Session ${s.sort_order}: ${s.title} → ${s.id}`));
  return data[0].id; // Return first session ID for TEST_SESSION_ID
}

// ── Step 5: Upsert trial subscription ────────────────────────────────────
async function upsertTrialSubscription(directorId) {
  log('Ensuring trial subscription…');
  const trialEnd = new Date();
  trialEnd.setFullYear(trialEnd.getFullYear() + 1); // 1-year test trial

  const { error } = await sb.from('leod_subscriptions').upsert({
    director_id:   directorId,
    plan:          'trial',
    status:        'active',
    trial_ends_at: trialEnd.toISOString(),
  }, { onConflict: 'director_id' });

  if (error) { err(`Subscription upsert failed: ${error.message}`); process.exit(1); }
  ok('Trial subscription active (1 year).');
}

// ── Main ──────────────────────────────────────────────────────────────────
console.log('\n🔧  CueDeck Test Account Seeder');
console.log('================================\n');

try {
  const userId    = await upsertAuthUser();
  await upsertDirectorProfile(userId);
  const eventId   = await upsertTestEvent(userId);
  const sessionId = await seedSessions(eventId);
  await upsertTrialSubscription(userId);

  console.log('\n✅  Test account ready!\n');
  console.log('Add these to your environment or .env.test file:\n');
  console.log(`  TEST_EMAIL=${TEST_EMAIL}`);
  console.log(`  TEST_PASSWORD=${TEST_PASSWORD}`);
  console.log(`  TEST_SESSION_ID=${sessionId}`);
  console.log('\nRun live tests with:');
  console.log(`  TEST_EMAIL=${TEST_EMAIL} TEST_PASSWORD=${TEST_PASSWORD} TEST_SESSION_ID=${sessionId} npm run test:e2e\n`);
} catch (e) {
  err(`Unexpected error: ${e.message}`);
  process.exit(1);
}
