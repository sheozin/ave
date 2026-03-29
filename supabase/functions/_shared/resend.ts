// Resend email client for CueDeck
// Uses Resend API to send transactional emails

export interface EmailPayload {
  to: string
  subject: string
  html: string
  text?: string
  replyTo?: string
  tags?: { name: string; value: string }[]
}

export interface ResendResponse {
  id?: string
  error?: string
}

export async function sendEmail(payload: EmailPayload): Promise<ResendResponse> {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set')
    return { error: 'Email service not configured' }
  }

  const fromEmail = Deno.env.get('FROM_EMAIL') || 'sheriff@cuedeck.io'
  const fromName = Deno.env.get('FROM_NAME') || 'Sheriff from CueDeck'

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        reply_to: payload.replyTo || fromEmail,
        tags: payload.tags,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('Resend API error:', data)
      return { error: data.message || 'Failed to send email' }
    }

    return { id: data.id }
  } catch (err) {
    console.error('Email send failed:', err)
    return { error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// Batch send emails (for sequences)
export async function sendBatchEmails(emails: EmailPayload[]): Promise<ResendResponse[]> {
  return Promise.all(emails.map(sendEmail))
}

// Attachment interface for email with attachments
export interface EmailAttachment {
  filename: string
  content: string // base64 encoded content
  content_type?: string
}

export interface EmailWithAttachmentsPayload extends EmailPayload {
  attachments?: EmailAttachment[]
}

// Send email with attachments (for invoices)
export async function sendEmailWithAttachment(
  payload: EmailWithAttachmentsPayload
): Promise<ResendResponse> {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set')
    return { error: 'Email service not configured' }
  }

  const fromEmail = Deno.env.get('FROM_EMAIL') || 'billing@cuedeck.io'
  const fromName = Deno.env.get('FROM_NAME') || 'CueDeck Billing'

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        reply_to: payload.replyTo || 'billing@cuedeck.io',
        tags: payload.tags,
        attachments: payload.attachments?.map(att => ({
          filename: att.filename,
          content: att.content,
          content_type: att.content_type || 'application/pdf',
        })),
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('Resend API error:', data)
      return { error: data.message || 'Failed to send email' }
    }

    return { id: data.id }
  } catch (err) {
    console.error('Email with attachment send failed:', err)
    return { error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
