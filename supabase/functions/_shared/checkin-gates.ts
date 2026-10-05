// supabase/functions/_shared/checkin-gates.ts
// The gate decision each check-in Edge Function makes, as pure functions,
// so tests/checkin-function-gates.spec.ts can run every role through them
// without a database. The permission table itself is checkin-roles.ts.

import { can, type CallerRole, type CheckinRole, type Permission } from './checkin-roles.ts'

export type GateBody = { error: string; code?: string }
export type GateVerdict = { ok: true } | { ok: false; status: 403 | 500; body: GateBody }

export const NOT_OWNER: GateBody = { error: 'Only the event owner can go live', code: 'not_owner' }

export const FUNCTION_GATES = {
  'checkin-create-checkout': { perm: 'go_live', forbidden: NOT_OWNER },
  'checkin-import-attendees': { perm: 'manage_guests', forbidden: { error: 'Forbidden, organizers only' } },
  'checkin-send-qr-emails': { perm: 'manage_guests', forbidden: { error: 'Forbidden, organizers only' } },
  // The desk maps a 403 whose message contains 'organizer' to its
  // "who can set up a kiosk" note, so keep that word in the message.
  'checkin-kiosk-pair': { perm: 'kiosk', forbidden: { error: 'Forbidden, organizers and desk leads only' } },
  'checkin-record-scans': { perm: 'desk', forbidden: { error: 'Forbidden, desk roles only' } },
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
// owner's act alone, admins included (roles ruling 1). A bare call (no
// settings) on an event already in test is a go-live request, so anyone
// else is refused rather than answered with a 200 that changes nothing.
// A first setup (no entitlement row yet) or a settings save proceeds and
// leaves the event in test.
export type CompDecision = 'go_live' | 'refuse' | 'proceed'
export function compGoLiveDecision(args: {
  isComp: boolean
  role: CheckinRole | null
  existingStatus: string | null
  hasSettings: boolean
}): CompDecision {
  if (!args.isComp) return 'proceed'
  if (can(args.role, 'go_live')) return 'go_live'
  if (args.existingStatus === 'test' && !args.hasSettings) return 'refuse'
  return 'proceed'
}
