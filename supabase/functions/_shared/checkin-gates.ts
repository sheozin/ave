// supabase/functions/_shared/checkin-gates.ts
// The gate decision each check-in Edge Function makes, as pure functions,
// so tests/checkin-function-gates.spec.ts can run every role through them
// without a database. The permission table itself is checkin-roles.ts.

import {
  can, invitableRoles, type CallerRole, type CheckinRole, type GrantRole, type Permission, type RemoveVerdict,
} from './checkin-roles.ts'

export type GateBody = { error: string; code?: string }
export type GateVerdict = { ok: true } | { ok: false; status: 400 | 403 | 404 | 409 | 500; body: GateBody }

export const NOT_OWNER: GateBody = { error: 'Only the event owner can go live', code: 'not_owner' }

export const FUNCTION_GATES = {
  'checkin-create-checkout': { perm: 'go_live', forbidden: NOT_OWNER },
  'checkin-import-attendees': { perm: 'manage_guests', forbidden: { error: 'Forbidden, organizers only' } },
  'checkin-send-qr-emails': { perm: 'manage_guests', forbidden: { error: 'Forbidden, organizers only' } },
  // Waitlist and approval: releasing a held guest is a guest-list change.
  'checkin-held': { perm: 'manage_guests', forbidden: { error: 'Forbidden, organizers only' } },
  // The desk maps a 403 whose message contains 'organizer' to its
  // "who can set up a kiosk" note, so keep that word in the message.
  'checkin-kiosk-pair': { perm: 'kiosk', forbidden: { error: 'Forbidden, organizers and desk leads only' } },
  'checkin-record-scans': { perm: 'desk', forbidden: { error: 'Forbidden, desk roles only' } },
  'checkin-add-walk-in': { perm: 'walk_in', forbidden: { error: 'Only an organizer or a desk lead can add a walk-in', code: 'forbidden' } },
} as const satisfies Record<string, { perm: Permission; forbidden: GateBody }>

export type GatedFunction = keyof typeof FUNCTION_GATES

type Caller = Pick<CallerRole, 'role' | 'error'>

// A database error while reading the role is a 500, never a 403: a refusal
// would tell the caller they lack access when the server simply failed.
export function functionGate(fn: GatedFunction, caller: Caller): GateVerdict {
  if (caller.error) return { ok: false, status: 500, body: { error: caller.error } }
  const g = FUNCTION_GATES[fn]
  if (!can(caller.role, g.perm)) return { ok: false, status: 403, body: { ...g.forbidden } }
  return { ok: true }
}

// checkin-enable-event: test mode and event settings belong to the owner,
// an organizer, or a CueDeck admin.
export function enableEventGate(caller: Caller, isAdmin: boolean): GateVerdict {
  if (caller.error) return { ok: false, status: 500, body: { error: caller.error } }
  if (!isAdmin && !can(caller.role, 'test_setup')) return { ok: false, status: 403, body: { error: 'Forbidden' } }
  return { ok: true }
}

// checkin-enable-event on a complimentary owner's event. Going live is the
// owner's act alone, admins included (roles ruling 1), and only through
// the explicit go-live call: a bare call (no settings). A settings save
// proceeds and leaves the event in test, whoever makes it, so toggling a
// kiosk option never takes an event live as a side effect. A bare call
// on an event already in test from anyone but the owner is refused rather
// than answered with a 200 that changes nothing. A first setup (no
// entitlement row yet) by anyone else proceeds in test.
export type CompDecision = 'go_live' | 'refuse' | 'proceed'
export function compGoLiveDecision(args: {
  isComp: boolean
  role: CheckinRole | null
  existingStatus: string | null
  hasSettings: boolean
}): CompDecision {
  if (!args.isComp) return 'proceed'
  if (args.hasSettings) return 'proceed'
  if (can(args.role, 'go_live')) return 'go_live'
  if (args.existingStatus === 'test' && !args.hasSettings) return 'refuse'
  return 'proceed'
}

// ── email lookups ───────────────────────────────────────────────────
// Both email lookups use ilike so case does not matter. PostgREST reads
// '*' in an ilike pattern as '%' and offers no escape for it, so an
// address containing '*' is refused outright ('*@domain' would find
// whoever has an address there). '%' and '_' are LIKE wildcards but legal
// in real addresses, so they (and the escape character) are escaped.
export const EMAIL_RE = /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (m) => '\\' + m)

export function normalizeInviteEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null
}

// ── checkin-invite-staff ────────────────────────────────────────────
// Every action needs at least invite_crew (owner, organizer, desk lead).
// The live Setup page shows this message as it comes.
export const STAFF_FORBIDDEN: GateBody = { error: 'Forbidden, organizers and desk leads only' }
export function staffGate(caller: Caller): GateVerdict {
  if (caller.error) return { ok: false, status: 500, body: { error: caller.error } }
  if (!can(caller.role, 'invite_crew')) return { ok: false, status: 403, body: { ...STAFF_FORBIDDEN } }
  return { ok: true }
}

// Owner and organizer invite any of the four roles, a desk lead only crew.
export function inviteRoleVerdict(role: CheckinRole | null, want: GrantRole): GateVerdict {
  if (!invitableRoles(role).includes(want)) {
    return { ok: false, status: 403, body: { error: 'Desk leads can invite desk staff only', code: 'role_not_allowed' } }
  }
  return { ok: true }
}

const REMOVE_ERRORS: Record<Exclude<RemoveVerdict, { ok: true }>['code'], [string, 403 | 404 | 409]> = {
  forbidden: ['Desk leads can remove desk staff only', 403],
  not_found: ['Not on this event', 404],
  event_owner: ['The event owner cannot be removed', 409],
  last_organizer: ['An event needs at least one organizer', 409],
}
export function removeResponse(v: RemoveVerdict): GateVerdict {
  if (v.ok) return { ok: true }
  const [error, status] = REMOVE_ERRORS[v.code]
  return { ok: false, status, body: { error, code: v.code } }
}

// An archived ("deleted") event takes no new people, owner or payment.
// Listing and removing stay open so the team can still be tidied.
export const ARCHIVED: GateBody = { error: 'This event was deleted.', code: 'archived' }
const ARCHIVED_BLOCKS = ['invite', 'transfer_owner', 'archive_event']
export function archivedVerdict(action: string, active: boolean | null | undefined): GateVerdict {
  if (active === false && ARCHIVED_BLOCKS.includes(action)) return { ok: false, status: 409, body: { ...ARCHIVED } }
  return { ok: true }
}

// A desk lead manages desk staff only, so they see crew rows and their
// own row, never organizer or viewer contact details.
export function visibleStaff<T extends { user_id: string; role: string }>(role: CheckinRole | null, callerId: string, team: T[]): T[] {
  if (can(role, 'invite_any')) return team
  return team.filter(o => o.role === 'crew' || o.user_id === callerId)
}

// Ruling 3: check-in events only, to an existing, active organizer, owner only.
export function transferVerdict(a: {
  role: CheckinRole | null
  createdVia: string | null
  callerId: string
  targetId: string
  targetIsUuid: boolean
  team: { user_id: string; role: string }[]
  targetActive: boolean
}): GateVerdict {
  if (!can(a.role, 'transfer_owner')) {
    return { ok: false, status: 403, body: { error: 'Only the event owner can transfer ownership', code: 'not_owner' } }
  }
  if (a.createdVia !== 'checkin') {
    return { ok: false, status: 409, body: { error: 'This event belongs to a CueDeck console account and cannot be transferred here', code: 'console_event' } }
  }
  if (!a.targetIsUuid || a.targetId === a.callerId) {
    return { ok: false, status: 400, body: { error: 'Choose another organizer', code: 'bad_target' } }
  }
  const row = a.team.find(o => o.user_id === a.targetId)
  if (!row || row.role !== 'organizer') {
    return { ok: false, status: 409, body: { error: 'Ownership can only go to an organizer on this event', code: 'not_organizer' } }
  }
  if (!a.targetActive) {
    return { ok: false, status: 409, body: { error: 'This organizer\'s account is inactive. Choose another organizer.', code: 'target_inactive' } }
  }
  return { ok: true }
}

// Ruling 2: delete means archive, owner only, check-in events only, and
// only while in test mode (a live event holds a purchase and attendance).
// No entitlement row means nothing was ever set up or bought. An open
// Stripe Checkout session could still complete, so wait for it to expire.
export function archiveVerdict(a: {
  role: CheckinRole | null
  createdVia: string | null
  entStatus: string | null
  checkoutSessionId?: string | null
  checkoutExpiresAt?: string | null
  nowMs?: number
}): GateVerdict {
  if (!can(a.role, 'archive_event')) {
    return { ok: false, status: 403, body: { error: 'Only the event owner can delete this event', code: 'not_owner' } }
  }
  if (a.createdVia !== 'checkin') {
    return { ok: false, status: 409, body: { error: 'This event belongs to a CueDeck console account and cannot be deleted here', code: 'console_event' } }
  }
  if (a.entStatus !== null && a.entStatus !== 'test') {
    return { ok: false, status: 409, body: { error: 'A live event cannot be deleted here. Email support@cuedeck.io and we will help.', code: 'live_event' } }
  }
  if (a.checkoutSessionId && a.checkoutExpiresAt && new Date(a.checkoutExpiresAt).getTime() > (a.nowMs ?? Date.now())) {
    return { ok: false, status: 409, body: { error: 'A payment is in progress for this event. Try again in an hour.', code: 'checkout_open' } }
  }
  return { ok: true }
}
