// set-overrun — Transition a LIVE session to OVERRUN.
// Called automatically by the client tick when correctedNow() exceeds
// actual_start + planned_duration. Not triggered by operator button clicks.
// Idempotency via leod_commands prevents duplicate transitions from
// multiple concurrent clients detecting overrun simultaneously.
import { runTransition } from '../_shared/transition.ts'

Deno.serve((req) => runTransition(req, 'OVERRUN'))
