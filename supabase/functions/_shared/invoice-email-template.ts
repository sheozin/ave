// CueDeck Invoice Email Template
// Branded payment receipt email following existing email-templates.ts patterns

import { BRAND } from './email-templates.ts'

export interface InvoiceEmailData {
  invoice_number: string
  invoice_date: string
  customer_name?: string
  customer_email: string
  amount_paid: number // in cents
  currency: string
  period_start?: string
  period_end?: string
  line_items: Array<{
    description: string
    amount: number // in cents
  }>
}

// Format cents to currency string
function formatCurrency(cents: number, currency: string): string {
  const amount = cents / 100
  const symbols: Record<string, string> = { eur: '€', usd: '$', gbp: '£' }
  const symbol = symbols[currency.toLowerCase()] || currency.toUpperCase() + ' '
  return `${symbol}${amount.toFixed(2)}`
}

// Format date to readable string
function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

// Base email wrapper (matching email-templates.ts style)
const invoiceEmailWrapper = (content: string, preheader = '') => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>CueDeck Invoice</title>
  <style>
    body { margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
    .wrapper { width: 100%; background-color: #f4f4f5; padding: 40px 20px; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
    .header { background: linear-gradient(135deg, ${BRAND.darkColor}, #2d2d44); padding: 32px; text-align: center; }
    .logo { font-size: 28px; font-weight: 700; color: ${BRAND.color}; text-decoration: none; }
    .tagline { color: rgba(255,255,255,0.7); font-size: 12px; margin-top: 8px; letter-spacing: 1px; }
    .content { padding: 40px 32px; color: #374151; line-height: 1.7; font-size: 16px; }
    .content h1 { color: #1a1a2e; font-size: 24px; margin: 0 0 24px; }
    .content p { margin: 0 0 16px; }
    .receipt-box { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; margin: 24px 0; }
    .receipt-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; border-bottom: 1px solid #e5e7eb; padding-bottom: 16px; }
    .receipt-title { font-size: 14px; font-weight: 600; color: ${BRAND.color}; text-transform: uppercase; letter-spacing: 0.05em; }
    .receipt-number { font-size: 12px; color: #6b7280; }
    .receipt-amount { font-size: 32px; font-weight: 700; color: #22c55e; text-align: center; margin: 20px 0; }
    .receipt-status { display: inline-block; background: rgba(34,197,94,0.1); color: #22c55e; font-size: 11px; font-weight: 600; padding: 4px 12px; border-radius: 100px; text-transform: uppercase; letter-spacing: 0.05em; }
    .receipt-row { display: flex; justify-content: space-between; padding: 8px 0; font-size: 14px; }
    .receipt-row .label { color: #6b7280; }
    .receipt-row .value { color: #374151; font-weight: 500; }
    .receipt-divider { border-top: 1px dashed #e5e7eb; margin: 16px 0; }
    .line-item { display: flex; justify-content: space-between; padding: 8px 0; font-size: 14px; color: #374151; }
    .line-item .desc { flex: 1; }
    .line-item .amount { font-weight: 500; margin-left: 16px; }
    .pdf-note { background: linear-gradient(135deg, #eff6ff, #dbeafe); border: 1px solid #93c5fd; border-radius: 8px; padding: 16px; margin: 24px 0; text-align: center; }
    .pdf-note strong { color: ${BRAND.color}; }
    .cta-button { display: inline-block; background: ${BRAND.color}; color: #ffffff !important; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0; }
    .signature { margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb; }
    .footer { background: #f8fafc; padding: 24px 32px; text-align: center; border-top: 1px solid #e5e7eb; }
    .footer p { color: #9ca3af; font-size: 12px; margin: 0 0 8px; }
    .footer a { color: ${BRAND.color}; text-decoration: none; }
    .preheader { display: none; max-height: 0; overflow: hidden; }
    @media only screen and (max-width: 600px) {
      .content { padding: 24px 20px; }
      .header { padding: 24px 20px; }
      .receipt-box { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="preheader">${preheader}</div>
  <div class="wrapper">
    <div class="container">
      <div class="header" style="background-color: #1a1a2e; padding: 32px; text-align: center;">
        <a href="${BRAND.website}" class="logo" style="color: #2563EB !important; font-size: 28px; font-weight: 700; text-decoration: none;">${BRAND.name}</a>
        <div class="tagline" style="color: rgba(255,255,255,0.7); font-size: 12px; margin-top: 8px; letter-spacing: 1px;">${BRAND.tagline}</div>
      </div>
      ${content}
      <div class="footer">
        <p>&copy; ${new Date().getFullYear()} ${BRAND.name}. All rights reserved.</p>
        <p>
          <a href="${BRAND.website}">Website</a> ·
          <a href="${BRAND.app}">Dashboard</a> ·
          <a href="${BRAND.website}/docs">Docs</a>
        </p>
        <p style="margin-top: 16px;">
          All payments are processed by AVE Events, Poland (VAT: PL5223025100).
        </p>
      </div>
    </div>
  </div>
</body>
</html>
`

export function invoiceReceiptEmail(data: InvoiceEmailData) {
  const firstName = data.customer_name?.split(' ')[0] || 'there'
  const formattedAmount = formatCurrency(data.amount_paid, data.currency)
  const formattedDate = formatDate(data.invoice_date)

  // Build line items HTML
  const lineItemsHtml = data.line_items.map(item => `
    <div class="line-item">
      <span class="desc">${item.description}</span>
      <span class="amount">${formatCurrency(item.amount, data.currency)}</span>
    </div>
  `).join('')

  // Build period HTML if applicable
  const periodHtml = (data.period_start && data.period_end) ? `
    <div class="receipt-row">
      <span class="label">Billing Period</span>
      <span class="value">${formatDate(data.period_start)} — ${formatDate(data.period_end)}</span>
    </div>
  ` : ''

  const content = `
    <div class="content">
      <h1>Payment Received</h1>

      <p>Hi ${firstName},</p>

      <p>Thank you for your payment! Your CueDeck subscription is active and ready to use.</p>

      <div class="receipt-box">
        <div class="receipt-header">
          <div>
            <div class="receipt-title">Payment Receipt</div>
            <div class="receipt-number">${data.invoice_number}</div>
          </div>
          <span class="receipt-status">Paid</span>
        </div>

        <div class="receipt-amount">${formattedAmount}</div>

        <div class="receipt-divider"></div>

        ${lineItemsHtml}

        <div class="receipt-divider"></div>

        <div class="receipt-row">
          <span class="label">Date</span>
          <span class="value">${formattedDate}</span>
        </div>
        ${periodHtml}
        <div class="receipt-row">
          <span class="label">Invoice Number</span>
          <span class="value">${data.invoice_number}</span>
        </div>
      </div>

      <div class="pdf-note">
        <strong>📎 Your PDF invoice is attached</strong><br>
        <span style="font-size: 13px; color: #6b7280;">Save it for your records or forward to your accounts team.</span>
      </div>

      <p style="text-align: center;">
        <a href="${BRAND.app}" class="cta-button">Open CueDeck Dashboard →</a>
      </p>

      <p>If you have any questions about this payment, reply to this email and we'll help you out.</p>

      <div class="signature">
        <p style="margin: 0; font-weight: 600; color: #1a1a2e;">The CueDeck Team</p>
        <p style="margin: 4px 0 0; font-size: 14px; color: #6b7280;">billing@cuedeck.io</p>
      </div>
    </div>
  `

  return {
    subject: `Payment Receipt - ${data.invoice_number}`,
    html: invoiceEmailWrapper(content, `Your payment of ${formattedAmount} has been received. Invoice ${data.invoice_number} attached.`),
    text: `
Payment Received

Hi ${firstName},

Thank you for your payment! Your CueDeck subscription is active and ready to use.

Amount Paid: ${formattedAmount}
Invoice Number: ${data.invoice_number}
Date: ${formattedDate}

Your PDF invoice is attached to this email.

Open Dashboard: ${BRAND.app}

Questions? Reply to this email.

The CueDeck Team
billing@cuedeck.io
    `.trim()
  }
}
