import { runTransition } from '../_shared/transition.ts'
Deno.serve(req => runTransition(req, 'LIVE'))
