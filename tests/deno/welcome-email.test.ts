// The check-in welcome must stay about check-in: no command center steps,
// no dashboard link, no long dashes, and a name cannot inject markup.
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { checkinWelcomeEmail } from '../../supabase/functions/_shared/email-templates.ts'

Deno.test('check-in welcome: links to /checkin and skips the command center', () => {
  const m = checkinWelcomeEmail({ email: 'a@example.com', name: 'Ana Kowalska' })
  assertEquals(m.subject, 'Welcome to CueDeck Check-in, Ana')
  assert(m.html.includes('https://app.cuedeck.io/checkin'))
  for (const s of [m.html, m.text]) {
    assert(!/Ctrl\+K|Run a test session|Stage, AV/.test(s))
    assert(!/[—–]/.test(s.replace(/<style[\s\S]*?<\/style>/, '')))
  }
  const bad = checkinWelcomeEmail({ email: 'a@example.com', name: '<img src=x>Ana' })
  assert(!bad.html.includes('<img src=x>'))
})
