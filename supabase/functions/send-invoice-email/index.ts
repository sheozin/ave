// send-invoice-email — Generates and sends branded invoice PDF via email
// Called by stripe-webhook after invoice.payment_succeeded

import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendEmailWithAttachment } from '../_shared/resend.ts'
import { generateInvoicePdf, pdfToBase64, type InvoiceData } from '../_shared/invoice-pdf.ts'
import { invoiceReceiptEmail } from '../_shared/invoice-email-template.ts'

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

  const invoiceId = body.invoice_id as string
  if (!invoiceId) {
    return new Response(JSON.stringify({ error: 'Missing invoice_id' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const sb = adminClient()

  // Fetch invoice from database
  const { data: invoice, error: fetchError } = await sb
    .from('leod_invoices')
    .select('*')
    .eq('id', invoiceId)
    .single()

  if (fetchError || !invoice) {
    console.error('Invoice not found:', invoiceId, fetchError)
    return new Response(JSON.stringify({ error: 'Invoice not found' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Skip if email already sent
  if (invoice.email_sent) {
    console.log('Email already sent for invoice:', invoice.invoice_number)
    return new Response(JSON.stringify({
      ok: true,
      skipped: true,
      message: 'Email already sent'
    }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Prepare invoice data for PDF
  const invoiceData: InvoiceData = {
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date,
    status: invoice.status,
    customer_email: invoice.customer_email,
    customer_name: invoice.customer_name || undefined,
    company_name: invoice.company_name || undefined,
    vat_id: invoice.vat_id || undefined,
    billing_address: invoice.billing_address || undefined,
    amount_due: invoice.amount_due,
    amount_paid: invoice.amount_paid,
    tax_amount: invoice.tax_amount,
    currency: invoice.currency,
    line_items: invoice.line_items || [],
    period_start: invoice.period_start || undefined,
    period_end: invoice.period_end || undefined,
    paid_at: invoice.paid_at || undefined,
  }

  // Generate PDF
  let pdfBytes: Uint8Array
  try {
    pdfBytes = await generateInvoicePdf(invoiceData)
  } catch (pdfErr) {
    console.error('PDF generation failed:', pdfErr)
    return new Response(JSON.stringify({ error: 'PDF generation failed' }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const pdfBase64 = pdfToBase64(pdfBytes)

  // Update pdf_generated flag
  await sb
    .from('leod_invoices')
    .update({ pdf_generated: true })
    .eq('id', invoiceId)

  // Generate email content
  const emailContent = invoiceReceiptEmail({
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date,
    customer_name: invoice.customer_name || undefined,
    customer_email: invoice.customer_email,
    amount_paid: invoice.amount_paid,
    currency: invoice.currency,
    period_start: invoice.period_start || undefined,
    period_end: invoice.period_end || undefined,
    line_items: (invoice.line_items || []).map((item: Record<string, unknown>) => ({
      description: (item.description as string) || 'CueDeck Subscription',
      amount: (item.amount as number) || 0,
    })),
  })

  // Send email with PDF attachment
  const result = await sendEmailWithAttachment({
    to: invoice.customer_email,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
    attachments: [{
      filename: `${invoice.invoice_number}.pdf`,
      content: pdfBase64,
      content_type: 'application/pdf',
    }],
    tags: [
      { name: 'type', value: 'invoice' },
      { name: 'invoice_id', value: invoiceId },
      { name: 'invoice_number', value: invoice.invoice_number },
    ],
  })

  if (result.error) {
    console.error('Failed to send invoice email:', result.error)
    return new Response(JSON.stringify({ error: result.error }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Log to email_log for admin tracking
  await sb.from('email_log').insert({
    user_id: invoice.director_id,
    email_type: 'invoice',
    email_address: invoice.customer_email,
    subject: emailContent.subject,
    status: 'sent',
    resend_id: result.id,
    invoice_id: invoiceId,
    metadata: {
      invoice_number: invoice.invoice_number,
      amount: invoice.amount_paid,
      currency: invoice.currency,
    },
  })

  // Update invoice record with email status
  await sb
    .from('leod_invoices')
    .update({
      email_sent: true,
      resend_id: result.id,
    })
    .eq('id', invoiceId)

  console.log(`Invoice email sent: ${invoice.invoice_number} to ${invoice.customer_email}`)

  return new Response(
    JSON.stringify({
      ok: true,
      email_id: result.id,
      invoice_number: invoice.invoice_number,
    }),
    { headers: { ...cors, 'Content-Type': 'application/json' } }
  )
})
