// process-welcome-triggers — Processes pending welcome email triggers
// Called by cron job or webhook after login events

import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendEmail } from '../_shared/resend.ts'
import { founderWelcomeEmail, EMAIL_SEQUENCE, type UserData } from '../_shared/email-templates.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)

  // Pre-flight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  // Parse body
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    // No body is fine
  }

  // Ping support
  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()

  // ── Fetch unprocessed welcome triggers ──────────────────────────
  const { data: triggers, error: fetchErr } = await sb
    .from('welcome_email_trigger')
    .select('*')
    .eq('processed', false)
    .limit(20)

  if (fetchErr) {
    console.error('Failed to fetch triggers:', fetchErr)
    return new Response(JSON.stringify({ error: fetchErr.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (!triggers || triggers.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  console.log(`Processing ${triggers.length} welcome email triggers`)

  let successCount = 0
  let failCount = 0

  for (const trigger of triggers) {
    // Check if welcome email already sent (double-check)
    const { data: existingEmail } = await sb
      .from('email_log')
      .select('id')
      .eq('user_id', trigger.user_id)
      .eq('email_type', 'founder-welcome')
      .single()

    if (existingEmail) {
      // Already sent, mark as processed
      await sb.from('welcome_email_trigger')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq('user_id', trigger.user_id)
      continue
    }

    // Generate and send welcome email
    const userData: UserData = {
      email: trigger.email,
      name: trigger.name,
      firstName: trigger.name?.split(' ')[0],
    }

    const emailContent = founderWelcomeEmail(userData)

    const result = await sendEmail({
      to: trigger.email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
      tags: [
        { name: 'type', value: 'founder-welcome' },
        { name: 'user_id', value: trigger.user_id },
      ],
    })

    if (result.error) {
      console.error(`Failed to send welcome email to ${trigger.email}:`, result.error)
      failCount++
      continue
    }

    // Log email sent
    await sb.from('email_log').insert({
      user_id: trigger.user_id,
      email_type: 'founder-welcome',
      email_address: trigger.email,
      resend_id: result.id,
      sent_at: new Date().toISOString(),
    })

    // Mark trigger as processed
    await sb.from('welcome_email_trigger')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq('user_id', trigger.user_id)

    // Schedule follow-up emails (Day 3, 7, 14)
    const now = new Date()
    for (const seqItem of EMAIL_SEQUENCE.slice(1)) { // Skip first (welcome already sent)
      const sendAt = new Date(now.getTime() + seqItem.delayDays * 24 * 60 * 60 * 1000)
      await sb.from('email_queue').insert({
        user_id: trigger.user_id,
        email_address: trigger.email,
        user_name: trigger.name,
        email_type: seqItem.id,
        scheduled_for: sendAt.toISOString(),
        status: 'pending',
      })
    }

    successCount++
    console.log(`Welcome email sent to ${trigger.email}, ${EMAIL_SEQUENCE.length - 1} follow-ups scheduled`)
  }

  return new Response(
    JSON.stringify({
      ok: true,
      processed: triggers.length,
      success: successCount,
      failed: failCount
    }),
    { headers: { ...cors, 'Content-Type': 'application/json' } }
  )
})
