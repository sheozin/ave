// members.ts: event teams (spec docs/superpowers/specs/2026-10-08-event-teams-design.md).
// Membership is per event in leod_event_members; the event's creator is its
// director and is never a row there. Shared by transition.ts,
// invite-operator and manage-operator.

// The six console roles a membership may have (same CHECK as the table).
export const MEMBER_ROLES = new Set(['director', 'stage', 'av', 'interp', 'reg', 'signage'])

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// One row in that event's own log per team change (spec §4), naming who did
// it. validate_event_log_role restamps operator_role with the caller's role
// on the event. A failed log write is reported, never silent, and does not
// undo the change it describes. No email address goes in the payload: every
// member of the event reads its log.
// deno-lint-ignore no-explicit-any
export async function logMemberChange(sb: any, eventId: string, operatorId: string, action: string, payload: Record<string, unknown>): Promise<void> {
  const { error } = await sb.from('leod_event_log').insert({
    event_id: eventId, session_id: null, action, operator_id: operatorId, operator_role: 'director',
    payload, server_time_ms: Date.now(),
  })
  if (error) console.error(`${action} log failed:`, error.message)
}
