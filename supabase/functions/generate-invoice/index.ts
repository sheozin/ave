// generate-invoice — User-facing endpoint for invoice retrieval
// Supports JSON, HTML view, and PDF download

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { generateInvoicePdf, type InvoiceData } from '../_shared/invoice-pdf.ts'

Deno.serve(async (req) => {
  const cors = corsHeaders(req)

  // Pre-flight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  // Parse query params
  const url = new URL(req.url)
  const invoiceId = url.searchParams.get('id')
  const format = url.searchParams.get('format') || 'json' // json, html, pdf

  if (!invoiceId) {
    return new Response(JSON.stringify({ error: 'Missing id parameter' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Validate format
  if (!['json', 'html', 'pdf'].includes(format)) {
    return new Response(JSON.stringify({ error: 'Invalid format. Use: json, html, or pdf' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Get JWT from Authorization header
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const jwt = authHeader.replace('Bearer ', '')

  // Create Supabase client with user's JWT
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    }
  )

  // Verify user is authenticated
  const { data: { user }, error: authError } = await sb.auth.getUser()
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Fetch invoice using RPC (enforces RLS)
  const { data: invoice, error: fetchError } = await sb
    .rpc('get_invoice_by_id', { p_invoice_id: invoiceId })
    .single()

  if (fetchError || !invoice) {
    return new Response(JSON.stringify({ error: 'Invoice not found' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Return JSON
  if (format === 'json') {
    return new Response(JSON.stringify(invoice), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Return HTML view
  if (format === 'html') {
    const html = generateInvoiceHtml(invoice)
    return new Response(html, {
      headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  // Return PDF
  if (format === 'pdf') {
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

    try {
      const pdfBytes = await generateInvoicePdf(invoiceData)
      return new Response(pdfBytes, {
        headers: {
          ...cors,
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${invoice.invoice_number}.pdf"`,
        },
      })
    } catch (pdfErr) {
      console.error('PDF generation failed:', pdfErr)
      return new Response(JSON.stringify({ error: 'PDF generation failed' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  }

  return new Response(JSON.stringify({ error: 'Invalid format' }), {
    status: 400,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})

// Generate simple HTML invoice view
function generateInvoiceHtml(invoice: Record<string, unknown>): string {
  const formatCurrency = (cents: number, currency: string): string => {
    const amount = (cents as number) / 100
    const symbols: Record<string, string> = { eur: '€', usd: '$', gbp: '£' }
    const symbol = symbols[(currency as string).toLowerCase()] || currency.toUpperCase() + ' '
    return `${symbol}${amount.toFixed(2)}`
  }

  const formatDate = (dateStr: string): string => {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
  }

  const lineItems = (invoice.line_items as Array<Record<string, unknown>>) || []
  const lineItemsHtml = lineItems.map(item => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e5e7eb">${item.description || 'CueDeck Subscription'}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e5e7eb;text-align:center">${item.quantity || 1}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e5e7eb;text-align:right">${formatCurrency(item.amount as number, invoice.currency as string)}</td>
    </tr>
  `).join('')

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${invoice.invoice_number}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; margin: 0; padding: 40px 20px; }
    .invoice { max-width: 800px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); padding: 48px; }
    .header { display: flex; justify-content: space-between; margin-bottom: 48px; }
    .logo { font-size: 28px; font-weight: 700; color: #2563eb; }
    .tagline { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .invoice-title { text-align: right; }
    .invoice-title h1 { font-size: 24px; color: #1a1a2e; margin: 0; }
    .invoice-title .number { font-size: 14px; color: #6b7280; margin-top: 4px; }
    .invoice-title .date { font-size: 12px; color: #9ca3af; margin-top: 2px; }
    .status { display: inline-block; padding: 4px 12px; border-radius: 100px; font-size: 11px; font-weight: 600; text-transform: uppercase; margin-top: 8px; }
    .status.paid { background: rgba(34,197,94,0.1); color: #22c55e; }
    .billing { display: flex; gap: 48px; margin-bottom: 48px; }
    .billing-section { flex: 1; }
    .billing-label { font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
    .billing-name { font-size: 14px; font-weight: 600; color: #1a1a2e; }
    .billing-detail { font-size: 13px; color: #374151; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin: 32px 0; }
    th { text-align: left; font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; padding: 12px 0; border-bottom: 2px solid #e5e7eb; }
    th:last-child { text-align: right; }
    .totals { margin-left: auto; width: 280px; }
    .total-row { display: flex; justify-content: space-between; padding: 8px 0; font-size: 14px; }
    .total-row.final { border-top: 2px solid #e5e7eb; margin-top: 8px; padding-top: 16px; font-weight: 700; font-size: 18px; }
    .total-row.final .amount { color: #22c55e; }
    .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 12px; color: #9ca3af; }
    .print-btn { position: fixed; top: 20px; right: 20px; background: #2563eb; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .print-btn:hover { background: #1d4ed8; }
    @media print { .print-btn { display: none; } body { background: #fff; padding: 0; } .invoice { box-shadow: none; } }
  </style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">Print / Save PDF</button>
  <div class="invoice">
    <div class="header">
      <div>
        <div class="logo">CueDeck</div>
        <div class="tagline">Run every session. Own every moment.</div>
      </div>
      <div class="invoice-title">
        <h1>INVOICE</h1>
        <div class="number">${invoice.invoice_number}</div>
        <div class="date">${formatDate(invoice.invoice_date as string)}</div>
        <span class="status paid">${invoice.status}</span>
      </div>
    </div>

    <div class="billing">
      <div class="billing-section">
        <div class="billing-label">From</div>
        <div class="billing-name">AVE Events</div>
        <div class="billing-detail">ul. Dzieci Warszawy 11j lok. 24</div>
        <div class="billing-detail">02-495 Warszawa, Poland</div>
        <div class="billing-detail" style="color:#6b7280;margin-top:8px">VAT: PL5223025100</div>
        <div class="billing-detail">billing@cuedeck.io</div>
      </div>
      <div class="billing-section">
        <div class="billing-label">Bill To</div>
        ${invoice.company_name ? `<div class="billing-name">${invoice.company_name}</div>` : ''}
        ${invoice.customer_name ? `<div class="billing-detail">${invoice.customer_name}</div>` : ''}
        <div class="billing-detail">${invoice.customer_email}</div>
        ${invoice.billing_address ? `<div class="billing-detail">${(invoice.billing_address as string).replace(/\n/g, '<br>')}</div>` : ''}
        ${invoice.vat_id ? `<div class="billing-detail" style="color:#6b7280">VAT: ${invoice.vat_id}</div>` : ''}
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th style="text-align:center">Qty</th>
          <th style="text-align:right">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${lineItemsHtml}
      </tbody>
    </table>

    <div class="totals">
      <div class="total-row">
        <span>Subtotal</span>
        <span>${formatCurrency((invoice.amount_paid as number) - (invoice.tax_amount as number), invoice.currency as string)}</span>
      </div>
      ${(invoice.tax_amount as number) > 0 ? `
      <div class="total-row">
        <span>VAT</span>
        <span>${formatCurrency(invoice.tax_amount as number, invoice.currency as string)}</span>
      </div>
      ` : ''}
      <div class="total-row final">
        <span>Total Paid</span>
        <span class="amount">${formatCurrency(invoice.amount_paid as number, invoice.currency as string)}</span>
      </div>
    </div>

    ${invoice.paid_at ? `<div style="text-align:right;font-size:12px;color:#6b7280;margin-top:24px">Payment received on ${formatDate(invoice.paid_at as string)}</div>` : ''}

    <div class="footer">
      <p>Thank you for your business!</p>
      <p>Questions? Contact us at billing@cuedeck.io</p>
      <p style="margin-top:16px">www.cuedeck.io</p>
    </div>
  </div>
</body>
</html>
  `
}
