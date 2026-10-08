// members.ts: event teams (spec docs/superpowers/specs/2026-10-08-event-teams-design.md).
// Membership is per event in leod_event_members; the event's creator is its
// director and is never a row there. Shared by transition.ts,
// invite-operator and manage-operator.

// The six console roles a membership may have (same CHECK as the table).
export const MEMBER_ROLES = new Set(['director', 'stage', 'av', 'interp', 'reg', 'signage'])

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
