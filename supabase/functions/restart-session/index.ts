// restart-session — Put a session that already went live back to READY and
// clear its actual_start/actual_end, so the stage timer starts fresh at the
// next go-live. Allowed from LIVE, HOLD, OVERRUN, ENDED, and from CALLING or READY
// when it still carries an actual_start; anything else gets 409.
import { runTransition } from '../_shared/transition.ts'

Deno.serve((req) => runTransition(req, 'READY', { reset: true }))
