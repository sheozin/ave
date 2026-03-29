// CueDeck Invoice PDF Generator
// Uses pdf-lib for pure JS PDF generation (Deno-compatible, no Puppeteer)

import { PDFDocument, rgb, StandardFonts } from 'https://esm.sh/pdf-lib@1.17.1'

export interface InvoiceLineItem {
  description: string
  quantity: number
  unit_amount: number // in cents
  amount: number // in cents
  period_start?: string
  period_end?: string
}

export interface InvoiceData {
  invoice_number: string
  invoice_date: string
  status: string

  // Customer info
  customer_email: string
  customer_name?: string
  company_name?: string
  vat_id?: string
  billing_address?: string

  // Amounts (in cents)
  amount_due: number
  amount_paid: number
  tax_amount: number
  currency: string

  // Line items
  line_items: InvoiceLineItem[]

  // Period
  period_start?: string
  period_end?: string
  paid_at?: string
}

// CueDeck brand colors
const BRAND = {
  primary: rgb(0.145, 0.306, 0.937),   // #2563EB blue
  dark: rgb(0.102, 0.102, 0.18),       // #1a1a2e dark
  text: rgb(0.216, 0.255, 0.318),      // #374151 gray
  muted: rgb(0.42, 0.447, 0.502),      // #6B7280 muted
  light: rgb(0.969, 0.973, 0.976),     // #F8FAFC light bg
  success: rgb(0.133, 0.773, 0.369),   // #22C55E green
  border: rgb(0.898, 0.906, 0.922),    // #E5E7EB border
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

export async function generateInvoicePdf(invoice: InvoiceData): Promise<Uint8Array> {
  // Create A4 PDF
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([595.28, 841.89]) // A4 in points

  // Load fonts
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const { width, height } = page.getSize()
  const margin = 50
  let y = height - margin

  // ── Header: Logo & Invoice Title ──────────────────────────
  // CueDeck logo text (since we can't embed SVG easily)
  page.drawText('CueDeck', {
    x: margin,
    y: y,
    size: 28,
    font: fontBold,
    color: BRAND.primary,
  })

  // Tagline
  y -= 18
  page.drawText('Run every session. Own every moment.', {
    x: margin,
    y: y,
    size: 9,
    font: fontRegular,
    color: BRAND.muted,
  })

  // Invoice title on right
  page.drawText('INVOICE', {
    x: width - margin - 80,
    y: height - margin,
    size: 24,
    font: fontBold,
    color: BRAND.dark,
  })

  // Invoice number and date
  y = height - margin - 20
  page.drawText(invoice.invoice_number, {
    x: width - margin - 120,
    y: y,
    size: 11,
    font: fontRegular,
    color: BRAND.text,
  })

  y -= 16
  page.drawText(formatDate(invoice.invoice_date), {
    x: width - margin - 120,
    y: y,
    size: 10,
    font: fontRegular,
    color: BRAND.muted,
  })

  // Status badge
  y -= 20
  const statusColors: Record<string, typeof BRAND.success> = {
    paid: BRAND.success,
    open: BRAND.primary,
    draft: BRAND.muted,
    void: rgb(0.937, 0.267, 0.267),
  }
  const statusColor = statusColors[invoice.status] || BRAND.muted
  page.drawText(invoice.status.toUpperCase(), {
    x: width - margin - 120,
    y: y,
    size: 10,
    font: fontBold,
    color: statusColor,
  })

  // ── Billing From (Seller Details) ─────────────────────────
  y = height - margin - 100
  page.drawText('FROM', {
    x: margin,
    y: y,
    size: 9,
    font: fontBold,
    color: BRAND.muted,
  })

  y -= 18
  page.drawText('AVE Events', {
    x: margin,
    y: y,
    size: 11,
    font: fontBold,
    color: BRAND.text,
  })

  y -= 14
  page.drawText('ul. Dzieci Warszawy 11j lok. 24', {
    x: margin,
    y: y,
    size: 10,
    font: fontRegular,
    color: BRAND.text,
  })

  y -= 14
  page.drawText('02-495 Warszawa, Poland', {
    x: margin,
    y: y,
    size: 10,
    font: fontRegular,
    color: BRAND.text,
  })

  y -= 14
  page.drawText('VAT: PL5223025100', {
    x: margin,
    y: y,
    size: 10,
    font: fontRegular,
    color: BRAND.muted,
  })

  y -= 14
  page.drawText('billing@cuedeck.io', {
    x: margin,
    y: y,
    size: 10,
    font: fontRegular,
    color: BRAND.primary,
  })

  // ── Billing To ────────────────────────────────────────────
  const billToX = width / 2 + 20
  let billToY = height - margin - 100

  page.drawText('BILL TO', {
    x: billToX,
    y: billToY,
    size: 9,
    font: fontBold,
    color: BRAND.muted,
  })

  billToY -= 18
  if (invoice.company_name) {
    page.drawText(invoice.company_name, {
      x: billToX,
      y: billToY,
      size: 11,
      font: fontBold,
      color: BRAND.text,
    })
    billToY -= 14
  }

  if (invoice.customer_name) {
    page.drawText(invoice.customer_name, {
      x: billToX,
      y: billToY,
      size: 10,
      font: fontRegular,
      color: BRAND.text,
    })
    billToY -= 14
  }

  page.drawText(invoice.customer_email, {
    x: billToX,
    y: billToY,
    size: 10,
    font: fontRegular,
    color: BRAND.text,
  })
  billToY -= 14

  if (invoice.billing_address) {
    // Split address into lines
    const addressLines = invoice.billing_address.split('\n')
    for (const line of addressLines) {
      page.drawText(line.trim(), {
        x: billToX,
        y: billToY,
        size: 10,
        font: fontRegular,
        color: BRAND.text,
      })
      billToY -= 14
    }
  }

  if (invoice.vat_id) {
    page.drawText(`VAT: ${invoice.vat_id}`, {
      x: billToX,
      y: billToY,
      size: 10,
      font: fontRegular,
      color: BRAND.muted,
    })
  }

  // ── Period ────────────────────────────────────────────────
  if (invoice.period_start && invoice.period_end) {
    y = height - margin - 220
    page.drawText('BILLING PERIOD', {
      x: margin,
      y: y,
      size: 9,
      font: fontBold,
      color: BRAND.muted,
    })

    y -= 16
    page.drawText(
      `${formatDate(invoice.period_start)} — ${formatDate(invoice.period_end)}`,
      {
        x: margin,
        y: y,
        size: 10,
        font: fontRegular,
        color: BRAND.text,
      }
    )
    y -= 30
  } else {
    y = height - margin - 220
  }

  // ── Line Items Table ──────────────────────────────────────
  const tableTop = y
  const colDesc = margin
  const colQty = width - margin - 180
  const colUnit = width - margin - 120
  const colAmount = width - margin - 50

  // Table header
  page.drawRectangle({
    x: margin,
    y: tableTop - 20,
    width: width - 2 * margin,
    height: 24,
    color: BRAND.light,
  })

  page.drawText('Description', {
    x: colDesc + 8,
    y: tableTop - 14,
    size: 9,
    font: fontBold,
    color: BRAND.muted,
  })

  page.drawText('Qty', {
    x: colQty,
    y: tableTop - 14,
    size: 9,
    font: fontBold,
    color: BRAND.muted,
  })

  page.drawText('Unit Price', {
    x: colUnit,
    y: tableTop - 14,
    size: 9,
    font: fontBold,
    color: BRAND.muted,
  })

  page.drawText('Amount', {
    x: colAmount,
    y: tableTop - 14,
    size: 9,
    font: fontBold,
    color: BRAND.muted,
  })

  // Table rows
  let rowY = tableTop - 40
  for (const item of invoice.line_items) {
    // Description
    page.drawText(item.description || 'CueDeck Subscription', {
      x: colDesc + 8,
      y: rowY,
      size: 10,
      font: fontRegular,
      color: BRAND.text,
    })

    // Quantity
    page.drawText(String(item.quantity || 1), {
      x: colQty,
      y: rowY,
      size: 10,
      font: fontRegular,
      color: BRAND.text,
    })

    // Unit price
    page.drawText(formatCurrency(item.unit_amount, invoice.currency), {
      x: colUnit,
      y: rowY,
      size: 10,
      font: fontRegular,
      color: BRAND.text,
    })

    // Amount
    page.drawText(formatCurrency(item.amount, invoice.currency), {
      x: colAmount,
      y: rowY,
      size: 10,
      font: fontRegular,
      color: BRAND.text,
    })

    rowY -= 24
  }

  // Divider line
  rowY -= 10
  page.drawLine({
    start: { x: width - margin - 200, y: rowY },
    end: { x: width - margin, y: rowY },
    thickness: 1,
    color: BRAND.border,
  })

  // ── Totals ────────────────────────────────────────────────
  const totalsX = width - margin - 200
  rowY -= 20

  // Subtotal
  const subtotal = invoice.amount_paid - invoice.tax_amount
  page.drawText('Subtotal', {
    x: totalsX,
    y: rowY,
    size: 10,
    font: fontRegular,
    color: BRAND.muted,
  })
  page.drawText(formatCurrency(subtotal, invoice.currency), {
    x: colAmount,
    y: rowY,
    size: 10,
    font: fontRegular,
    color: BRAND.text,
  })

  // Tax
  if (invoice.tax_amount > 0) {
    rowY -= 18
    page.drawText('VAT', {
      x: totalsX,
      y: rowY,
      size: 10,
      font: fontRegular,
      color: BRAND.muted,
    })
    page.drawText(formatCurrency(invoice.tax_amount, invoice.currency), {
      x: colAmount,
      y: rowY,
      size: 10,
      font: fontRegular,
      color: BRAND.text,
    })
  }

  // Total
  rowY -= 24
  page.drawLine({
    start: { x: totalsX, y: rowY + 10 },
    end: { x: width - margin, y: rowY + 10 },
    thickness: 1,
    color: BRAND.border,
  })

  page.drawText('Total Paid', {
    x: totalsX,
    y: rowY,
    size: 12,
    font: fontBold,
    color: BRAND.dark,
  })
  page.drawText(formatCurrency(invoice.amount_paid, invoice.currency), {
    x: colAmount - 10,
    y: rowY,
    size: 12,
    font: fontBold,
    color: BRAND.success,
  })

  // ── Payment Info ──────────────────────────────────────────
  if (invoice.paid_at) {
    rowY -= 40
    page.drawText(`Payment received on ${formatDate(invoice.paid_at)}`, {
      x: totalsX,
      y: rowY,
      size: 9,
      font: fontRegular,
      color: BRAND.muted,
    })
  }

  // ── Footer ────────────────────────────────────────────────
  const footerY = 60

  // Divider
  page.drawLine({
    start: { x: margin, y: footerY + 30 },
    end: { x: width - margin, y: footerY + 30 },
    thickness: 1,
    color: BRAND.border,
  })

  // Footer text
  page.drawText('Thank you for your business!', {
    x: margin,
    y: footerY + 10,
    size: 10,
    font: fontBold,
    color: BRAND.text,
  })

  page.drawText(
    'Questions? Contact us at billing@cuedeck.io',
    {
      x: margin,
      y: footerY - 6,
      size: 9,
      font: fontRegular,
      color: BRAND.muted,
    }
  )

  page.drawText('www.cuedeck.io', {
    x: width - margin - 80,
    y: footerY + 10,
    size: 9,
    font: fontRegular,
    color: BRAND.primary,
  })

  // Serialize to bytes
  return await pdfDoc.save()
}

// Convert PDF bytes to base64 for email attachment
export function pdfToBase64(pdfBytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < pdfBytes.length; i++) {
    binary += String.fromCharCode(pdfBytes[i])
  }
  return btoa(binary)
}
