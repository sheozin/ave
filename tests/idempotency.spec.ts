// tests/idempotency.spec.ts
import { describe, it, expect, vi } from 'vitest';

// ── Idempotency store simulation ──────────────────────────────
type CommandStatus = 'PENDING'|'EXECUTED'|'REJECTED'|'CONFLICT';
interface Command { command_id: string; status: CommandStatus; result?: unknown; error?: string; }

class CommandStore {
  private store = new Map<string, Command>();

  register(command_id: string): boolean {
    if (this.store.has(command_id)) return false; // already registered
    this.store.set(command_id, { command_id, status: 'PENDING' });
    return true;
  }

  getStatus(command_id: string): Command | undefined {
    return this.store.get(command_id);
  }

  markExecuted(command_id: string, result: unknown) {
    const c = this.store.get(command_id);
    if (c) { c.status = 'EXECUTED'; c.result = result; }
  }

  markRejected(command_id: string, error: string) {
    const c = this.store.get(command_id);
    if (c) { c.status = 'REJECTED'; c.error = error; }
  }
}

// ── Simulated transition function ────────────────────────────
function simulateTransition(
  store: CommandStore,
  executeFn: vi.Mock,
  command_id: string,
  session_version: number,
  expected_version: number,
): unknown {
  // 1. Idempotency check
  const existing = store.getStatus(command_id);
  if (existing?.status === 'EXECUTED') return existing.result;

  // 2. Register
  if (!store.register(command_id)) {
    // PENDING — concurrent in-flight, reject
    return { error: 'IN_FLIGHT' };
  }

  // 3. Version check
  if (session_version !== expected_version) {
    store.markRejected(command_id, 'VERSION_MISMATCH');
    return { error: 'CONFLICT', current_version: session_version };
  }

  // 4. Execute
  const result = executeFn();
  store.markExecuted(command_id, result);
  return result;
}

describe('Command Idempotency', () => {

  it('01 first execution calls executeFn and returns result', () => {
    const store = new CommandStore();
    const fn = vi.fn().mockReturnValue({ ok: true, session: { id: 's1', version: 2 } });
    const result = simulateTransition(store, fn, 'cmd-001', 1, 1);
    expect(fn).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
  });

  it('02 second call with same command_id returns cached result, does NOT re-execute', () => {
    const store = new CommandStore();
    const fn = vi.fn().mockReturnValue({ ok: true, session: { id: 's1', version: 2 } });
    simulateTransition(store, fn, 'cmd-002', 1, 1);
    const result2 = simulateTransition(store, fn, 'cmd-002', 1, 1);
    expect(fn).toHaveBeenCalledOnce(); // only once
    expect(result2).toMatchObject({ ok: true });
  });

  it('03 third retry with same command_id also returns cache', () => {
    const store = new CommandStore();
    const fn = vi.fn().mockReturnValue({ done: true });
    simulateTransition(store, fn, 'cmd-003', 1, 1);
    simulateTransition(store, fn, 'cmd-003', 1, 1);
    simulateTransition(store, fn, 'cmd-003', 1, 1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('04 different command_ids each execute independently', () => {
    const store = new CommandStore();
    const fn = vi.fn().mockReturnValue({ ok: true });
    simulateTransition(store, fn, 'cmd-A', 1, 1);
    simulateTransition(store, fn, 'cmd-B', 2, 2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('05 version mismatch returns CONFLICT, does NOT execute', () => {
    const store = new CommandStore();
    const fn = vi.fn().mockReturnValue({ ok: true });
    const result = simulateTransition(store, fn, 'cmd-005', 5, 3); // version 5 ≠ expected 3
    expect(fn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: 'CONFLICT' });
  });

  it('06 concurrent in-flight returns IN_FLIGHT error for second request', () => {
    const store = new CommandStore();
    store.register('cmd-006'); // simulate first request registered PENDING but not yet executed
    const fn = vi.fn();
    const result = simulateTransition(store, fn, 'cmd-006', 1, 1);
    expect(fn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: 'IN_FLIGHT' });
  });

  it('07 command marked REJECTED does not affect subsequent commands with different IDs', () => {
    const store = new CommandStore();
    const fn = vi.fn().mockReturnValue({ ok: true });
    simulateTransition(store, fn, 'cmd-bad', 5, 3); // CONFLICT → REJECTED
    simulateTransition(store, fn, 'cmd-good', 3, 3); // should succeed
    expect(fn).toHaveBeenCalledOnce();
  });

  it('08 EXECUTED command status is preserved after multiple retries', () => {
    const store = new CommandStore();
    const fn = vi.fn().mockReturnValue({ session_id: 'x' });
    simulateTransition(store, fn, 'cmd-exe', 1, 1);
    simulateTransition(store, fn, 'cmd-exe', 1, 1);
    expect(store.getStatus('cmd-exe')?.status).toBe('EXECUTED');
  });

  it('09 simultaneous GO_LIVE race: first wins, second gets CONFLICT', () => {
    const store = new CommandStore();
    let dbVersion = 4; // simulated DB session version
    let callCount = 0;

    function executor(expectedVersion: number): unknown {
      if (dbVersion !== expectedVersion) return { error: 'CONFLICT', current_version: dbVersion };
      dbVersion++;
      callCount++;
      return { ok: true, new_version: dbVersion };
    }

    // Both operators read version=4 and send their commands
    const r1 = executor(4); // first wins: version 4 → 5
    const r2 = executor(4); // second loses: version is now 5

    expect(r1).toMatchObject({ ok: true, new_version: 5 });
    expect(r2).toMatchObject({ error: 'CONFLICT' });
    expect(callCount).toBe(1);
    expect(dbVersion).toBe(5);
  });

  it('10 CONFLICT response contains current_version for client to reload', () => {
    const store = new CommandStore();
    const fn = vi.fn();
    const result = simulateTransition(store, fn, 'cmd-010', 7, 4) as { current_version?: number };
    expect(result.current_version).toBe(7);
  });
});
