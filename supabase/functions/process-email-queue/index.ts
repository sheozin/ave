// process-email-queue — Processes scheduled emails from the queue
// Called by cron job every hour to send due emails

import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendEmail } from '../_shared/resend.ts'
import {
  featureDeepDiveEmail,
  socialProofEmail,
  checkInEmail,
  type UserData,
} from '../_shared/email-templates.ts'

// Map email types to template functions
const EMAIL_TEMPLATES: Record<string, (user: UserData) => { subject: string; html: string; text: string }> = {
  'feature-deep-dive': featureDeepDiveEmail,
  'social-proof': socialProofEmail,
  'check-in': checkInEmail,
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)

  // Pre-flight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  // Parse body (optional - can be triggered without body)
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    // No body is fine for cron triggers
  }

  // Ping support
  if (body._ping) {
    return new Response(JSON.stringify({ pong: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()

  // ── Fetch pending emails that are due ───────────────────────────
  const now = new Date().toISOString()
  const { data: pendingEmails, error: fetchErr } = await sb
    .from('email_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', now)
    .limit(50)

  if (fetchErr) {
    console.error('Failed to fetch email queue:', fetchErr)
    return new Response(JSON.stringify({ error: fetchErr.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (!pendingEmails || pendingEmails.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  console.log(`Processing ${pendingEmails.length} pending emails`)

  let successCount = 0
  let failCount = 0

  for (const queueItem of pendingEmails) {
    const templateFn = EMAIL_TEMPLATES[queueItem.email_type]
    if (!templateFn) {
      console.error(`Unknown email type: ${queueItem.email_type}`)
      await sb.from('email_queue')
        .update({ status: 'failed', error: 'Unknown email type' })
        .eq('id', queueItem.id)
      failCount++
      continue
    }

    // Check if user has unsubscribed
    const { data: user } = await sb
      .from('leod_users')
      .select('email, name, active')
      .eq('id', queueItem.user_id)
      .single()

    if (!user || !user.active) {
      // User deleted or deactivated — skip
      await sb.from('email_queue')
        .update({ status: 'skipped', error: 'User inactive' })
        .eq('id', queueItem.id)
      continue
    }

    // Generate email content
    const userData: UserData = {
      email: queueItem.email_address,
      name: queueItem.user_name || user.name,
      firstName: (queueItem.user_name || user.name)?.split(' ')[0],
    }

    const emailContent = templateFn(userData)

    // Send email
    const result = await sendEmail({
      to: queueItem.email_address,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
      tags: [
        { name: 'type', value: queueItem.email_type },
        { name: 'user_id', value: queueItem.user_id },
      ],
    })

    if (result.error) {
      console.error(`Failed to send ${queueItem.email_type} to ${queueItem.email_address}:`, result.error)
      await sb.from('email_queue')
        .update({ status: 'failed', error: result.error })
        .eq('id', queueItem.id)
      failCount++
      continue
    }

    // Mark as sent and log
    await sb.from('email_queue')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        resend_id: result.id
      })
      .eq('id', queueItem.id)

    await sb.from('email_log').insert({
      user_id: queueItem.user_id,
      email_type: queueItem.email_type,
      email_address: queueItem.email_address,
      subject: emailContent.subject,
      status: 'sent',
      resend_id: result.id,
      sent_at: new Date().toISOString(),
      metadata: { queue_id: queueItem.id, scheduled_for: queueItem.scheduled_for },
    })

    successCount++
    console.log(`Sent ${queueItem.email_type} to ${queueItem.email_address}`)
  }

  return new Response(
    JSON.stringify({
      ok: true,
      processed: pendingEmails.length,
      success: successCount,
      failed: failCount
    }),
    { headers: { ...cors, 'Content-Type': 'application/json' } }
  )
})
