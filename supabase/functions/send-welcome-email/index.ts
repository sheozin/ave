// send-welcome-email — Sends founder welcome email to new users
// Called by database trigger on first login or via API

import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendEmail } from '../_shared/resend.ts'
import { founderWelcomeEmail, type UserData } from '../_shared/email-templates.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)

  // Pre-flight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  // Parse body
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Ping support (deploy verification)
  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Validate input ──────────────────────────────────────────────
  const userId = body.user_id as string
  const email = body.email as string
  const name = body.name as string | undefined

  if (!userId || !email) {
    return new Response(JSON.stringify({ error: 'Missing user_id or email' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Check if welcome email already sent ─────────────────────────
  const sb = adminClient()
  const { data: existingEmail } = await sb
    .from('email_log')
    .select('id')
    .eq('user_id', userId)
    .eq('email_type', 'founder-welcome')
    .single()

  if (existingEmail) {
    return new Response(JSON.stringify({
      ok: true,
      skipped: true,
      message: 'Welcome email already sent'
    }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Generate email content ──────────────────────────────────────
  const userData: UserData = {
    email,
    name: name || undefined,
    firstName: name?.split(' ')[0],
  }

  const emailContent = founderWelcomeEmail(userData)

  // ── Send email via Resend ───────────────────────────────────────
  const result = await sendEmail({
    to: email,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
    tags: [
      { name: 'type', value: 'founder-welcome' },
      { name: 'user_id', value: userId },
    ],
  })

  if (result.error) {
    console.error('Failed to send welcome email:', result.error)
    return new Response(JSON.stringify({ error: result.error }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Log email sent ──────────────────────────────────────────────
  await sb.from('email_log').insert({
    user_id: userId,
    email_type: 'founder-welcome',
    email_address: email,
    subject: emailContent.subject,
    status: 'sent',
    resend_id: result.id,
    sent_at: new Date().toISOString(),
    metadata: { name: name || null },
  })

  // ── Log activity ──────────────────────────────────────────────────
  await sb.rpc('log_activity', {
    p_user_id: userId,
    p_action: 'welcome_email_sent',
    p_category: 'email',
    p_description: `Welcome email sent to ${email}`,
    p_metadata: { resend_id: result.id },
  })

  // ── Schedule follow-up emails ───────────────────────────────────
  const now = new Date()
  const scheduledEmails = [
    { email_type: 'feature-deep-dive', delay_days: 3 },
    { email_type: 'social-proof', delay_days: 7 },
    { email_type: 'check-in', delay_days: 14 },
  ]

  for (const scheduled of scheduledEmails) {
    const sendAt = new Date(now.getTime() + scheduled.delay_days * 24 * 60 * 60 * 1000)
    await sb.from('email_queue').insert({
      user_id: userId,
      email_address: email,
      user_name: name,
      email_type: scheduled.email_type,
      scheduled_for: sendAt.toISOString(),
      status: 'pending',
    })
  }

  console.log(`Welcome email sent to ${email}, follow-ups scheduled`)

  return new Response(
    JSON.stringify({
      ok: true,
      email_id: result.id,
      scheduled_count: scheduledEmails.length
    }),
    { headers: { ...cors, 'Content-Type': 'application/json' } }
  )
})
