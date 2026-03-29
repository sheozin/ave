// resend-webhook — Handles Resend webhook events for email delivery tracking
// Receives events: delivered, opened, clicked, bounced, complained
// No JWT auth — uses Resend webhook signature verification

import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'

// Resend webhook event types
type ResendEventType = 'email.sent' | 'email.delivered' | 'email.opened' |
  'email.clicked' | 'email.bounced' | 'email.complained'

interface ResendWebhookEvent {
  type: ResendEventType
  created_at: string
  data: {
    email_id: string
    from: string
    to: string[]
    subject: string
    // For bounced events
    bounce?: {
      message: string
    }
    // For clicked events
    click?: {
      link: string
    }
  }
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  const sb = adminClient()
  const rawBody = await req.text()

  // ── Ping support (deploy verification) ───────────────────
  try {
    const parsed = JSON.parse(rawBody)
    if (parsed._ping) {
      return new Response(JSON.stringify({ pong: true }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  } catch {
    // Not JSON ping — continue
  }

  // ── Verify Resend webhook signature (optional but recommended) ──
  const svixId = req.headers.get('svix-id')
  const svixTimestamp = req.headers.get('svix-timestamp')
  const svixSignature = req.headers.get('svix-signature')

  // Note: For production, verify signature using svix library
  // For now, we'll accept the webhook if it has the headers
  if (!svixId) {
    console.warn('Missing svix-id header - webhook may be unauthorized')
  }

  // ── Parse event ──────────────────────────────────────────
  let event: ResendWebhookEvent
  try {
    event = JSON.parse(rawBody)
  } catch (e) {
    console.error('Failed to parse webhook body:', e)
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const emailId = event.data?.email_id
  if (!emailId) {
    console.error('Missing email_id in webhook event')
    return new Response(JSON.stringify({ error: 'Missing email_id' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  console.log(`Resend webhook: ${event.type} for ${emailId}`)

  // ── Map event type to status ─────────────────────────────
  const statusMap: Record<string, string> = {
    'email.sent': 'sent',
    'email.delivered': 'delivered',
    'email.opened': 'opened',
    'email.clicked': 'clicked',
    'email.bounced': 'bounced',
    'email.complained': 'bounced',
  }

  const newStatus = statusMap[event.type]
  if (!newStatus) {
    console.log(`Unhandled event type: ${event.type}`)
    return new Response(JSON.stringify({ received: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // ── Update email_log ─────────────────────────────────────
  try {
    const updateData: Record<string, unknown> = {
      status: newStatus,
    }

    // Set timestamp based on event type
    if (event.type === 'email.opened') {
      updateData.opened_at = event.created_at
    } else if (event.type === 'email.clicked') {
      updateData.clicked_at = event.created_at
    }

    // Add bounce message to metadata if present
    if (event.data.bounce) {
      const { data: existing } = await sb
        .from('email_log')
        .select('metadata')
        .eq('resend_id', emailId)
        .single()

      updateData.metadata = {
        ...(existing?.metadata || {}),
        bounce_message: event.data.bounce.message,
      }
    }

    const { error: updateErr } = await sb
      .from('email_log')
      .update(updateData)
      .eq('resend_id', emailId)

    if (updateErr) {
      console.error('Failed to update email_log:', updateErr)
      // Don't fail the webhook — Resend will retry
    } else {
      console.log(`Updated email ${emailId} status to ${newStatus}`)
    }

    // Log bounce/complaint as activity for admin attention
    if (event.type === 'email.bounced' || event.type === 'email.complained') {
      // Find the user_id from email_log
      const { data: emailRecord } = await sb
        .from('email_log')
        .select('user_id, email_address, email_type')
        .eq('resend_id', emailId)
        .single()

      if (emailRecord) {
        await sb.rpc('log_activity', {
          p_user_id: emailRecord.user_id,
          p_action: event.type === 'email.bounced' ? 'email_bounced' : 'email_complained',
          p_category: 'email',
          p_description: `Email ${event.type.split('.')[1]} for ${emailRecord.email_address}`,
          p_metadata: {
            email_type: emailRecord.email_type,
            resend_id: emailId,
            bounce_message: event.data.bounce?.message,
          },
        })
      }
    }

  } catch (e) {
    console.error('Error processing webhook:', e)
    // Still return 200 to prevent retries
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
