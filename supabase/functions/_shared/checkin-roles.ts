// supabase/functions/_shared/checkin-roles.ts
// The five check-in roles and what each may do. Server copy; the browser
// copy is /checkin-roles.js and tests/checkin-roles.spec.ts runs both over
// the same table, so drift fails there.
// Design: docs/superpowers/specs/2026-10-04-checkin-roles-design.md
//
// Ownership is never an operator row: it is leod_events.created_by. The
// owner also holds an 'organizer' row (trigger checkin_auto_grant_organizer),
// which effectiveRole() turns into 'owner'.

export type CheckinRole = 'owner' | 'organizer' | 'lead' | 'crew' | 'viewer'
export type GrantRole = 'organizer' | 'lead' | 'crew' | 'viewer'
export type Permission =
  | 'go_live' | 'transfer_owner' | 'archive_event'
  | 'edit_details' | 'manage_guests' | 'test_setup' | 'export' | 'invite_any'
  | 'invite_crew' | 'kiosk' | 'walk_in' | 'undo_any' | 'desk_health'
  | 'desk' | 'dashboard'

export const ROLES: CheckinRole[] = ['owner', 'organizer', 'lead', 'crew', 'viewer']
export const GRANT_ROLES: GrantRole[] = ['organizer', 'lead', 'crew', 'viewer']

const OFFICE: CheckinRole[] = ['owner', 'organizer']
const LEADS: CheckinRole[] = ['owner', 'organizer', 'lead']

export const GRANTS: Record<Permission, CheckinRole[]> = {
  go_live: ['owner'],            // pay or comp go-live, purchases and invoices
  transfer_owner: ['owner'],
  archive_event: ['owner'],      // "Delete event" (ruling 2)
  edit_details: OFFICE,
  manage_guests: OFFICE,         // import guests, send QR emails
  test_setup: OFFICE,            // enable test mode, event settings, Setup page
  export: OFFICE,                // attendee CSV (ruling 4: a screen permission)
  invite_any: OFFICE,
  invite_crew: LEADS,            // leads invite and remove desk staff only
  kiosk: LEADS,
  walk_in: LEADS,
  undo_any: LEADS,
  desk_health: LEADS,            // desk panel and staffing advice (people data)
  desk: ['owner', 'organizer', 'lead', 'crew'],
  dashboard: ['owner', 'organizer', 'lead', 'crew', 'viewer'],
}

export function effectiveRole(opRole: string | null | undefined, isOwner: boolean): CheckinRole | null {
  if (isOwner || opRole === 'owner') return 'owner'
  return opRole === 'organizer' || opRole === 'lead' || opRole === 'crew' || opRole === 'viewer' ? opRole : null
}

export function can(role: CheckinRole | null | undefined, perm: Permission): boolean {
  return !!role && (GRANTS[perm] ?? []).includes(role)
}

export function invitableRoles(role: CheckinRole | null | undefined): GrantRole[] {
  if (can(role, 'invite_any')) return [...GRANT_ROLES]
  if (can(role, 'invite_crew')) return ['crew']
  return []
}

export type RemoveVerdict =
  | { ok: true }
  | { ok: false; code: 'forbidden' | 'not_found' | 'event_owner' | 'last_organizer' }

export function removeVerdict(
  caller: CheckinRole | null | undefined,
  targetId: string,
  ownerId: string | null,
  ops: { user_id: string; role: string }[],
): RemoveVerdict {
  if (!can(caller, 'invite_crew')) return { ok: false, code: 'forbidden' }
  const row = ops.find(o => o.user_id === targetId)
  if (!row) return { ok: false, code: 'not_found' }
  if (targetId === ownerId) return { ok: false, code: 'event_owner' }
  if (!can(caller, 'invite_any') && row.role !== 'crew') return { ok: false, code: 'forbidden' }
  if (row.role === 'organizer' && ops.filter(o => o.role === 'organizer').length <= 1) {
    return { ok: false, code: 'last_organizer' }
  }
  return { ok: true }
}

const LABELS: Record<CheckinRole, string> = {
  owner: 'Owner', organizer: 'Organizer', lead: 'Desk lead', crew: 'Desk staff', viewer: 'Viewer',
}
export function roleLabel(role: CheckinRole | null | undefined): string {
  return role ? LABELS[role] : 'No access'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

export type CallerRole = { role: CheckinRole | null; ownerId: string | null; error: string | null }

// Reads the caller's role with the service-role client. A database error is
// returned as `error`, never folded into "no role", so a 500 is not reported
// to the caller as a 403.
// deno-lint-ignore no-explicit-any
export async function loadCallerRole(sb: any, eventId: string, userId: string): Promise<CallerRole> {
  if (!isUuid(eventId)) return { role: null, ownerId: null, error: null }
  const { data: ev, error: evErr } = await sb.from('leod_events')
    .select('created_by').eq('id', eventId).maybeSingle()
  if (evErr) return { role: null, ownerId: null, error: evErr.message }
  if (!ev) return { role: null, ownerId: null, error: null }
  const { data: op, error: opErr } = await sb.from('leod_checkin_operators')
    .select('role').eq('event_id', eventId).eq('user_id', userId).maybeSingle()
  if (opErr) return { role: null, ownerId: null, error: opErr.message }
  const ownerId: string | null = ev.created_by ?? null
  return { role: effectiveRole(op?.role ?? null, ownerId !== null && ownerId === userId), ownerId, error: null }
}
