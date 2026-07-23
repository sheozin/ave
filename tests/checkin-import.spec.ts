// tests/checkin-import.spec.ts
// Check-in CSV attendee import — validation, dedup, and classification
// logic for supabase/functions/checkin-import-attendees/index.ts.
// Following this repo's convention (see tests/checkin-rls.spec.ts,
// tests/idempotency.spec.ts): Deno Edge Functions aren't importable
// into vitest, so the logic is re-expressed as plain JS/TS and asserted
// against here. This IS the specification, kept in sync by a human
// diffing it against the real deployed code in
// supabase/functions/checkin-import-attendees/index.ts.
//
// The real function went through two review rounds that each found a
// real bug:
//   Round 1: a per-row update() error was silently discarded, risking
//   a misleading success summary (fixed with update_errors — not
//   covered here, that's a DB-effects concern outside pure
//   validation/classification logic).
//   Round 2: two rows in the SAME posted batch sharing an email or
//   external_ref (e.g. one registrant listed twice under different
//   ticket categories) both classified as 'create', silently producing
//   duplicate attendee records. Fixed with claimedExternalRefs /
//   claimedEmails sets, kept deliberately SEPARATE from the DB-sourced
//   byExternalRef / byEmail maps — a batch-claimed row has no real
//   attendee id yet, so a later duplicate must be 'skip', not 'update'.
//
// classifyRows() below mirrors that two-tier structure exactly: DB
// match maps (byExternalRef / byEmail) are consulted first: if a real
// DB match exists, the row is always 'update', full stop. Only when
// there is NO DB match (`!match`) does the function fall through to
// check the batch-claimed sets for an in-batch duplicate.

import { describe, it, expect } from 'vitest';

interface ImportRow {
  first_name: string;
  last_name: string;
  email?: string;
  company?: string;
  role_title?: string;
  ticket_type?: string;
  external_ref?: string;
}

interface ExistingAttendee {
  id: string;
  external_ref: string | null;
  email: string | null;
}

interface RowResult {
  row: ImportRow;
  action: 'create' | 'update' | 'skip';
  reason?: string;
}

// Line-for-line re-expression of validateRow() at index.ts:33-37.
function validateRow(row: ImportRow): string | null {
  if (!row.first_name?.trim()) return 'Missing first_name';
  if (!row.last_name?.trim()) return 'Missing last_name';
  return null;
}

// Line-for-line re-expression of the classification loop at
// index.ts:89-154 (the DB fetch itself is out of scope — `existing` is
// passed in as if it were the query result).
function classifyRows(
  rows: ImportRow[],
  existing: ExistingAttendee[],
): {
  results: RowResult[];
  toInsert: { row: ImportRow }[];
  toUpdate: { id: string; row: ImportRow }[];
} {
  const byExternalRef = new Map(
    existing.filter(a => a.external_ref).map(a => [a.external_ref as string, a]),
  );
  const byEmail = new Map(
    existing.filter(a => a.email).map(a => [(a.email as string).toLowerCase(), a]),
  );

  const results: RowResult[] = [];
  const toInsert: { row: ImportRow }[] = [];
  const toUpdate: { id: string; row: ImportRow }[] = [];

  // Tracks keys claimed by a 'create' row earlier in THIS batch, kept
  // separate from byExternalRef/byEmail (which only reflect existing
  // DB rows) — a row matching a not-yet-inserted create has no real
  // attendee id to update against, so it must be skipped, not merged.
  const claimedExternalRefs = new Set<string>();
  const claimedEmails = new Set<string>();

  for (const row of rows) {
    const invalid = validateRow(row);
    if (invalid) {
      results.push({ row, action: 'skip', reason: invalid });
      continue;
    }

    const normalizedEmail = row.email?.toLowerCase();
    const match =
      (row.external_ref && byExternalRef.get(row.external_ref)) ||
      (normalizedEmail && byEmail.get(normalizedEmail));

    // One registrant listed twice in the same CSV would otherwise
    // both classify as 'create' with two separate inserts. First
    // occurrence wins; later ones are skipped. This check only runs
    // when there is no real DB match.
    if (!match) {
      const dupInBatch =
        (row.external_ref && claimedExternalRefs.has(row.external_ref)) ||
        (normalizedEmail && claimedEmails.has(normalizedEmail));
      if (dupInBatch) {
        results.push({ row, action: 'skip', reason: 'Duplicate of another row in this import' });
        continue;
      }
    }

    if (match) {
      results.push({ row, action: 'update' });
      toUpdate.push({ id: match.id, row });
    } else {
      if (row.external_ref) claimedExternalRefs.add(row.external_ref);
      if (normalizedEmail) claimedEmails.add(normalizedEmail);
      results.push({ row, action: 'create' });
      toInsert.push({ row });
    }
  }

  return { results, toInsert, toUpdate };
}

// ════════════════════════════════════════════════════════════════
// validateRow
// ════════════════════════════════════════════════════════════════

describe('checkin-import: validateRow', () => {
  it('01 rejects a row missing first_name', () => {
    const row: ImportRow = { first_name: '', last_name: 'Doe' };
    expect(validateRow(row)).toBe('Missing first_name');
  });

  it('02 rejects a row missing last_name', () => {
    const row: ImportRow = { first_name: 'Jane', last_name: '' };
    expect(validateRow(row)).toBe('Missing last_name');
  });

  it('03 rejects a row whose first_name is only whitespace (falls through .trim())', () => {
    const row: ImportRow = { first_name: '   ', last_name: 'Doe' };
    expect(validateRow(row)).toBe('Missing first_name');
  });

  it('04 accepts a row with both names present and no email at all', () => {
    const row: ImportRow = { first_name: 'Jane', last_name: 'Doe' };
    expect(validateRow(row)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// classifyRows — single-row classification against existing DB rows
// ════════════════════════════════════════════════════════════════

describe('checkin-import: classifyRows against existing DB rows', () => {
  it('05 a row with an external_ref and email that match nothing in the DB classifies create', () => {
    const existing: ExistingAttendee[] = [{ id: 'att-1', external_ref: 'OTHER', email: 'other@x.com' }];
    const rows: ImportRow[] = [{ first_name: 'Jane', last_name: 'Doe', external_ref: 'NEW-1', email: 'jane@x.com' }];
    const { results, toInsert, toUpdate } = classifyRows(rows, existing);
    expect(results[0].action).toBe('create');
    expect(toInsert).toHaveLength(1);
    expect(toUpdate).toHaveLength(0);
  });

  it('06 a row whose external_ref matches an existing attendee classifies update, even when the email differs', () => {
    const existing: ExistingAttendee[] = [{ id: 'att-1', external_ref: 'REF-1', email: 'old-email@x.com' }];
    const rows: ImportRow[] = [{ first_name: 'Jane', last_name: 'Doe', external_ref: 'REF-1', email: 'new-email@x.com' }];
    const { results, toUpdate } = classifyRows(rows, existing);
    expect(results[0].action).toBe('update');
    expect(toUpdate).toEqual([{ id: 'att-1', row: rows[0] }]);
  });

  it('07 a row with no external_ref but an email matching an existing attendee, case-insensitively, classifies update', () => {
    const existing: ExistingAttendee[] = [{ id: 'att-1', external_ref: null, email: 'jane@x.com' }];
    const rows: ImportRow[] = [{ first_name: 'Jane', last_name: 'Doe', email: 'JANE@X.COM' }];
    const { results, toUpdate } = classifyRows(rows, existing);
    expect(results[0].action).toBe('update');
    expect(toUpdate).toEqual([{ id: 'att-1', row: rows[0] }]);
  });

  it('08 an invalid row (missing last_name) classifies skip regardless of an existing match on external_ref', () => {
    const existing: ExistingAttendee[] = [{ id: 'att-1', external_ref: 'REF-1', email: 'jane@x.com' }];
    const rows: ImportRow[] = [{ first_name: 'Jane', last_name: '', external_ref: 'REF-1', email: 'jane@x.com' }];
    const { results, toInsert, toUpdate } = classifyRows(rows, existing);
    expect(results[0]).toEqual({ row: rows[0], action: 'skip', reason: 'Missing last_name' });
    expect(toInsert).toHaveLength(0);
    expect(toUpdate).toHaveLength(0);
  });

  it('09 re-importing the exact same row twice, each as its own single-row batch against the same existing snapshot, classifies update both times (idempotent)', () => {
    const existing: ExistingAttendee[] = [{ id: 'att-1', external_ref: 'REF-1', email: 'jane@x.com' }];
    const row: ImportRow = { first_name: 'Jane', last_name: 'Doe', external_ref: 'REF-1', email: 'jane@x.com' };

    const first = classifyRows([row], existing);
    const second = classifyRows([row], existing);

    expect(first.results[0].action).toBe('update');
    expect(second.results[0].action).toBe('update');
    expect(first.toUpdate).toEqual([{ id: 'att-1', row }]);
    expect(second.toUpdate).toEqual([{ id: 'att-1', row }]);
  });
});

// ════════════════════════════════════════════════════════════════
// classifyRows — in-batch dedup (Task 8 round-2 fix)
// ════════════════════════════════════════════════════════════════

describe('checkin-import: classifyRows in-batch duplicate detection', () => {
  it('10 two rows in the same batch sharing an email in different casing: first creates, second skips with the specific duplicate reason', () => {
    const rows: ImportRow[] = [
      { first_name: 'Jane', last_name: 'Doe', email: 'jane@x.com' },
      { first_name: 'Jane', last_name: 'Doe (VIP ticket)', email: 'JANE@X.COM' },
    ];
    const { results, toInsert, toUpdate } = classifyRows(rows, []);
    expect(results[0].action).toBe('create');
    expect(results[1]).toEqual({ row: rows[1], action: 'skip', reason: 'Duplicate of another row in this import' });
    expect(toInsert).toHaveLength(1);
    expect(toUpdate).toHaveLength(0);
  });

  it('11 two rows in the same batch sharing the same external_ref: first creates, second skips with the specific duplicate reason', () => {
    const rows: ImportRow[] = [
      { first_name: 'Jane', last_name: 'Doe', external_ref: 'REF-1' },
      { first_name: 'Jane', last_name: 'Doe (VIP ticket)', external_ref: 'REF-1' },
    ];
    const { results, toInsert } = classifyRows(rows, []);
    expect(results[0].action).toBe('create');
    expect(results[1]).toEqual({ row: rows[1], action: 'skip', reason: 'Duplicate of another row in this import' });
    expect(toInsert).toHaveLength(1);
  });

  it('12 cross-field claim: row 2 matches row 1 via a claimed external_ref, and row 3 happens to share row 2\'s email — row 2 skips (ref-claim OR branch), and because a SKIPPED row never claims its email, row 3 still creates (claims only happen on the create path)', () => {
    const rows: ImportRow[] = [
      { first_name: 'Alice', last_name: 'A', external_ref: 'REF-A', email: 'alice@x.com' },
      { first_name: 'Alice', last_name: 'A (dup via ref)', external_ref: 'REF-A', email: 'bob@x.com' },
      { first_name: 'Bob', last_name: 'B', external_ref: 'REF-C', email: 'bob@x.com' },
    ];
    const { results, toInsert, toUpdate } = classifyRows(rows, []);

    expect(results[0].action).toBe('create'); // claims REF-A, alice@x.com
    expect(results[1]).toEqual({ row: rows[1], action: 'skip', reason: 'Duplicate of another row in this import' }); // matches row 1's claimed REF-A
    expect(results[2].action).toBe('create'); // bob@x.com was never claimed — row 2 was skipped, not created
    expect(toInsert).toHaveLength(2);
    expect(toUpdate).toHaveLength(0);
  });

  it('13 a row matching an EXISTING DB row still classifies update, never skip, even though claimedEmails/claimedExternalRefs independently already contain that same email key from an unrelated earlier batch row', () => {
    // Existing DB row is reachable only via external_ref (REF-DB); its
    // email (dave@x.com) is irrelevant to this scenario.
    const existing: ExistingAttendee[] = [{ id: 'att-db-1', external_ref: 'REF-DB', email: 'dave@x.com' }];
    const rows: ImportRow[] = [
      // Row 1: no DB match at all -> creates and claims carol@x.com.
      { first_name: 'Carol', last_name: 'C', email: 'carol@x.com' },
      // Row 2: matches the existing DB row via external_ref. Its email
      // (carol@x.com) also happens to already be in claimedEmails from
      // row 1 — but since `match` is truthy, the batch-claim check
      // (`if (!match)`) never even runs, so this must be 'update', not
      // 'skip'.
      { first_name: 'Someone', last_name: 'Else', external_ref: 'REF-DB', email: 'carol@x.com' },
    ];
    const { results, toInsert, toUpdate } = classifyRows(rows, existing);

    expect(results[0].action).toBe('create');
    expect(results[1].action).toBe('update');
    expect(toUpdate).toEqual([{ id: 'att-db-1', row: rows[1] }]);
    expect(toInsert).toHaveLength(1);
  });

  it('14 three rows that collide with neither each other nor the existing DB snapshot all classify create', () => {
    const existing: ExistingAttendee[] = [{ id: 'att-1', external_ref: 'UNRELATED', email: 'unrelated@x.com' }];
    const rows: ImportRow[] = [
      { first_name: 'Jane', last_name: 'Doe', external_ref: 'REF-1', email: 'jane@x.com' },
      { first_name: 'John', last_name: 'Smith', external_ref: 'REF-2', email: 'john@x.com' },
      { first_name: 'Sam', last_name: 'Lee', email: 'sam@x.com' },
    ];
    const { results, toInsert, toUpdate } = classifyRows(rows, existing);
    expect(results.map(r => r.action)).toEqual(['create', 'create', 'create']);
    expect(toInsert).toHaveLength(3);
    expect(toUpdate).toHaveLength(0);
  });
});
