-- ============================================================
-- CueDeck — Migration 034: Invoice System
-- Branded PDF invoices with email delivery
-- Run this in Supabase SQL Editor
-- ============================================================

-- ── 1. leod_invoices table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS leod_invoices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owner (the director who paid)
  director_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Stripe references
  stripe_invoice_id   TEXT UNIQUE,
  stripe_customer_id  TEXT,

  -- Invoice identification
  invoice_number      TEXT NOT NULL UNIQUE,

  -- Status
  status              TEXT NOT NULL DEFAULT 'paid'
                      CHECK (status IN ('draft', 'open', 'paid', 'void')),

  -- Amounts (all in cents)
  amount_due          INT NOT NULL DEFAULT 0,
  amount_paid         INT NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'eur',
  tax_amount          INT NOT NULL DEFAULT 0,

  -- Customer billing info (snapshot at time of invoice)
  customer_email      TEXT NOT NULL,
  customer_name       TEXT,
  company_name        TEXT,
  vat_id              TEXT,
  billing_address     TEXT,

  -- Line items (JSONB array)
  -- Each item: { description, quantity, unit_amount, amount, period_start?, period_end? }
  line_items          JSONB NOT NULL DEFAULT '[]'::JSONB,

  -- Dates
  invoice_date        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_start        TIMESTAMPTZ,
  period_end          TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,

  -- Delivery tracking
  pdf_generated       BOOLEAN NOT NULL DEFAULT FALSE,
  email_sent          BOOLEAN NOT NULL DEFAULT FALSE,
  resend_id           TEXT,

  -- Timestamps
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_inv_director ON leod_invoices (director_id);
CREATE INDEX IF NOT EXISTS idx_inv_stripe_inv ON leod_invoices (stripe_invoice_id);
CREATE INDEX IF NOT EXISTS idx_inv_stripe_cust ON leod_invoices (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_inv_date ON leod_invoices (invoice_date DESC);

-- ── 2. Invoice number sequence ─────────────────────────────
-- Format: INV-YYYY-NNNNN (e.g., INV-2026-00001)
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START WITH 1;

CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_year TEXT;
  v_seq  INT;
BEGIN
  v_year := TO_CHAR(CURRENT_DATE, 'YYYY');
  v_seq  := NEXTVAL('invoice_number_seq');
  RETURN 'INV-' || v_year || '-' || LPAD(v_seq::TEXT, 5, '0');
END;
$$;

-- ── 3. Auto-update updated_at ──────────────────────────────
CREATE OR REPLACE FUNCTION update_invoice_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoice_updated ON leod_invoices;
CREATE TRIGGER trg_invoice_updated
  BEFORE UPDATE ON leod_invoices
  FOR EACH ROW EXECUTE FUNCTION update_invoice_timestamp();

-- ── 4. Row Level Security ──────────────────────────────────
ALTER TABLE leod_invoices ENABLE ROW LEVEL SECURITY;

-- Directors can read their own invoices
CREATE POLICY "directors_read_own_invoices"
  ON leod_invoices FOR SELECT TO authenticated
  USING (director_id = auth.uid());

-- Only service role can insert/update (via edge functions)
-- No direct insert/update policies for authenticated users

-- ── 5. RPC: get_user_invoices ──────────────────────────────
-- Returns invoices for the current authenticated user
CREATE OR REPLACE FUNCTION get_user_invoices(
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  invoice_number TEXT,
  status TEXT,
  amount_paid INT,
  currency TEXT,
  invoice_date TIMESTAMPTZ,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  customer_name TEXT,
  company_name TEXT,
  line_items JSONB,
  pdf_generated BOOLEAN,
  email_sent BOOLEAN
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    i.id,
    i.invoice_number,
    i.status,
    i.amount_paid,
    i.currency,
    i.invoice_date,
    i.period_start,
    i.period_end,
    i.customer_name,
    i.company_name,
    i.line_items,
    i.pdf_generated,
    i.email_sent
  FROM leod_invoices i
  WHERE i.director_id = auth.uid()
  ORDER BY i.invoice_date DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- ── 6. RPC: get_invoice_by_id ──────────────────────────────
-- Returns full invoice details for PDF generation / viewing
CREATE OR REPLACE FUNCTION get_invoice_by_id(p_invoice_id UUID)
RETURNS TABLE (
  id UUID,
  director_id UUID,
  stripe_invoice_id TEXT,
  invoice_number TEXT,
  status TEXT,
  amount_due INT,
  amount_paid INT,
  currency TEXT,
  tax_amount INT,
  customer_email TEXT,
  customer_name TEXT,
  company_name TEXT,
  vat_id TEXT,
  billing_address TEXT,
  line_items JSONB,
  invoice_date TIMESTAMPTZ,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  paid_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    i.id,
    i.director_id,
    i.stripe_invoice_id,
    i.invoice_number,
    i.status,
    i.amount_due,
    i.amount_paid,
    i.currency,
    i.tax_amount,
    i.customer_email,
    i.customer_name,
    i.company_name,
    i.vat_id,
    i.billing_address,
    i.line_items,
    i.invoice_date,
    i.period_start,
    i.period_end,
    i.paid_at
  FROM leod_invoices i
  WHERE i.id = p_invoice_id
    AND i.director_id = auth.uid();
END;
$$;
