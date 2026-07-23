#!/usr/bin/env node
/**
 * seed-checkin-test-event.mjs
 * Enables the check-in module on the existing CueDeck test event and
 * seeds a handful of test attendees, for E2E testing of Plan 1b/1c.
 *
 * Usage:
 *   node scripts/seed-checkin-test-event.mjs
 *
 * Required env vars (same as seed-test-account.mjs):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, TEST_EMAIL
 *
 * Assumes seed-test-account.mjs has already been run (needs the test
 * director + test event to exist).
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://sawekpguemzvuvvulfbc.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TEST_EMAIL           = process.env.TEST_EMAIL           || 'test-director@cuedeck-test.io';

if (!SUPABASE_SERVICE_KEY) {
  console.error('\n❌  SUPABASE_SERVICE_KEY is required.\n');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const log = (msg) => console.log(`  ${msg}`);
const ok  = (msg) => console.log(`  ✅ ${msg}`);
const err = (msg) => console.log(`  ❌ ${msg}`);

async function main() {
  log('Finding test director…');
  const { data: { users } } = await sb.auth.admin.listUsers();
  const director = users?.find(u => u.email === TEST_EMAIL);
  if (!director) { err(`Test director ${TEST_EMAIL} not found — run seed-test-account.mjs first.`); process.exit(1); }

  log('Finding test event…');
  const { data: event } = await sb.from('leod_events')
    .select('id, name').eq('created_by', director.id).order('created_at', { ascending: false }).limit(1).single();
  if (!event) { err('No event found for test director.'); process.exit(1); }
  ok(`Using event: ${event.name} (${event.id})`);

  log('Enabling check-in entitlements…');
  const { error: entErr } = await sb.from('leod_checkin_entitlements')
    .upsert({ event_id: event.id, checkin_core: true }, { onConflict: 'event_id' });
  if (entErr) { err(entErr.message); process.exit(1); }
  ok('Entitlements enabled');

  log('Ensuring organizer grant…');
  await sb.from('leod_checkin_operators')
    .upsert({ event_id: event.id, user_id: director.id, role: 'organizer' }, { onConflict: 'event_id,user_id' });
  ok('Organizer grant confirmed');

  log('Seeding entrance scan point…');
  const { data: entrance } = await sb.from('leod_checkin_scan_points')
    .upsert({ event_id: event.id, name: 'Main Entrance', code: 'ENTRANCE', kind: 'entrance', sort_order: 0 },
      { onConflict: 'event_id,code' })
    .select('id').single();
  ok(`Entrance scan point: ${entrance?.id}`);

  log('Clearing old test attendees…');
  await sb.from('leod_checkin_attendees').delete().eq('event_id', event.id).like('external_ref', 'SEED-%');

  log('Seeding 5 test attendees…');
  const attendees = [
    { first_name: 'Anna',  last_name: 'Kowalska',    email: 'anna@example.com',   ticket_type: 'attendee', external_ref: 'SEED-001' },
    { first_name: 'Piotr', last_name: 'Nowak',       email: 'piotr@example.com',  ticket_type: 'speaker',  external_ref: 'SEED-002' },
    { first_name: 'Julia', last_name: 'Wiśniewska',  email: 'julia@example.com',  ticket_type: 'vip',      external_ref: 'SEED-003' },
    { first_name: 'Marek', last_name: 'Zieliński',   email: 'marek@example.com',  ticket_type: 'staff',    external_ref: 'SEED-004' },
    { first_name: 'Ola',   last_name: 'Dąbrowska',   email: 'ola@example.com',    ticket_type: 'press',    external_ref: 'SEED-005' },
  ].map(a => ({ ...a, event_id: event.id, qr_token: crypto.randomUUID().replace(/-/g, '') }));

  const { error: attErr } = await sb.from('leod_checkin_attendees').insert(attendees);
  if (attErr) { err(attErr.message); process.exit(1); }
  ok(`Seeded ${attendees.length} attendees`);

  console.log('\n✅ Check-in test event ready.\n');
}

main();
