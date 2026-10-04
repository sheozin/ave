// checkin-roles.js: browser copy of the check-in role table.
// Server copy: supabase/functions/_shared/checkin-roles.ts. The server
// decides; pages use this only to hide controls a role cannot use.
// tests/checkin-roles.spec.ts runs both copies over the same table.

export const ROLES = ['owner', 'organizer', 'lead', 'crew', 'viewer'];
export const GRANT_ROLES = ['organizer', 'lead', 'crew', 'viewer'];

const OFFICE = ['owner', 'organizer'];
const LEADS = ['owner', 'organizer', 'lead'];

export const GRANTS = {
  go_live: ['owner'],
  transfer_owner: ['owner'],
  archive_event: ['owner'],
  edit_details: OFFICE,
  manage_guests: OFFICE,
  test_setup: OFFICE,
  export: OFFICE,
  invite_any: OFFICE,
  invite_crew: LEADS,
  kiosk: LEADS,
  walk_in: LEADS,
  undo_any: LEADS,
  desk_health: LEADS,
  desk: ['owner', 'organizer', 'lead', 'crew'],
  dashboard: ['owner', 'organizer', 'lead', 'crew', 'viewer'],
};

export function effectiveRole(opRole, isOwner) {
  if (isOwner || opRole === 'owner') return 'owner';
  return opRole === 'organizer' || opRole === 'lead' || opRole === 'crew' || opRole === 'viewer' ? opRole : null;
}

export function can(role, perm) {
  return !!role && Object.hasOwn(GRANTS, perm) && GRANTS[perm].includes(role);
}

export function invitableRoles(role) {
  if (can(role, 'invite_any')) return [...GRANT_ROLES];
  if (can(role, 'invite_crew')) return ['crew'];
  return [];
}

export function removeVerdict(caller, targetId, ownerId, ops) {
  if (!can(caller, 'invite_crew')) return { ok: false, code: 'forbidden' };
  const row = ops.find(o => o.user_id === targetId);
  if (!row) return { ok: false, code: 'not_found' };
  if (targetId === ownerId) return { ok: false, code: 'event_owner' };
  if (!can(caller, 'invite_any') && row.role !== 'crew') return { ok: false, code: 'forbidden' };
  if (row.role === 'organizer' && ops.filter(o => o.role === 'organizer').length <= 1) {
    return { ok: false, code: 'last_organizer' };
  }
  return { ok: true };
}

const LABELS = { owner: 'Owner', organizer: 'Organizer', lead: 'Desk lead', crew: 'Desk staff', viewer: 'Viewer' };
export function roleLabel(role) { return role ? LABELS[role] : 'No access'; }

export const ROLE_HELP = {
  organizer: 'Edits the event, imports guests, sends QR emails and invites people.',
  lead: 'Runs the desk on the day: kiosks, walk-ins, undoing any check-in, and inviting desk staff.',
  crew: 'Searches, checks people in, prints badges and undoes their own check-ins.',
  viewer: 'Sees the live numbers on the dashboard. Never sees names.',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

// Check-ins this signed-in person made on this device for this event, as
// attendee id -> scanned_at. Built from the desk's outbox, whose items carry
// operator_id from this plan on. An item the server refused (any result
// other than 'ok') was never a check-in.
export function ownCheckins(outbox, userId, eventId) {
  const own = new Map();
  if (!userId) return own;
  for (const p of outbox || []) {
    if (p.action !== 'checkin' || p.event_id !== eventId || p.operator_id !== userId) continue;
    if (p.result && p.result !== 'ok') continue;
    const prev = own.get(p.attendee_id);
    if (!prev || prev < p.scanned_at) own.set(p.attendee_id, p.scanned_at);
  }
  return own;
}

// Ruling 8 on the screen: leads and above undo anyone; desk staff only a
// check-in they made, and only while it is still the current one. The
// server applies the same rule in checkin_apply_scan.
export function mayUndo(role, attendee, own) {
  if (!attendee || !attendee.checked_in_at) return false;
  if (can(role, 'undo_any')) return true;
  if (!can(role, 'desk') || !own) return false;
  const mine = Date.parse(own.get(attendee.id));
  const current = Date.parse(attendee.checked_in_at);
  return !Number.isNaN(mine) && !Number.isNaN(current) && mine === current;
}

// Complimentary status is read from the owner's account (ruling 3), so a
// transfer in test mode can switch it. Live events are already paid for.
export function transferNote(eventIsComp, targetIsComp, isLive) {
  if (isLive || !!eventIsComp === !!targetIsComp) return '';
  return targetIsComp
    ? ' This event will become complimentary, because their account is.'
    : ' This event is complimentary because your account is. After the transfer it will need paying for before it can go live.';
}
