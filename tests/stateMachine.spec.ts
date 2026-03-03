// tests/stateMachine.spec.ts
import { describe, it, expect } from 'vitest';

type SessionStatus = 'PLANNED'|'READY'|'CALLING'|'LIVE'|'OVERRUN'|'HOLD'|'ENDED'|'CANCELLED';

const ALLOWED: Record<SessionStatus, SessionStatus[]> = {
  PLANNED:   ['READY', 'CANCELLED'],
  READY:     ['CALLING', 'LIVE', 'PLANNED', 'CANCELLED'],
  CALLING:   ['LIVE', 'HOLD', 'READY', 'CANCELLED'],
  LIVE:      ['HOLD', 'ENDED', 'OVERRUN'],
  OVERRUN:   ['HOLD', 'ENDED'],
  HOLD:      ['LIVE', 'ENDED', 'CALLING', 'READY'],
  ENDED:     [],
  CANCELLED: ['PLANNED'],
};

function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

describe('Session State Machine', () => {

  // ── ALLOWED transitions ──────────────────────────────────
  it('01 PLANNED → READY allowed', () => {
    expect(canTransition('PLANNED', 'READY')).toBe(true);
  });

  it('02 READY → LIVE allowed (skip CALLING)', () => {
    expect(canTransition('READY', 'LIVE')).toBe(true);
  });

  it('03 READY → CALLING allowed', () => {
    expect(canTransition('READY', 'CALLING')).toBe(true);
  });

  it('04 CALLING → LIVE allowed', () => {
    expect(canTransition('CALLING', 'LIVE')).toBe(true);
  });

  it('05 LIVE → HOLD allowed', () => {
    expect(canTransition('LIVE', 'HOLD')).toBe(true);
  });

  it('06 HOLD → LIVE allowed (resume)', () => {
    expect(canTransition('HOLD', 'LIVE')).toBe(true);
  });

  it('07 LIVE → ENDED allowed', () => {
    expect(canTransition('LIVE', 'ENDED')).toBe(true);
  });

  it('08 OVERRUN → ENDED allowed', () => {
    expect(canTransition('OVERRUN', 'ENDED')).toBe(true);
  });

  it('09 CANCELLED → PLANNED allowed (reinstate)', () => {
    expect(canTransition('CANCELLED', 'PLANNED')).toBe(true);
  });

  it('10 CALLING → HOLD allowed (speaker no-show)', () => {
    expect(canTransition('CALLING', 'HOLD')).toBe(true);
  });

  // ── FORBIDDEN transitions ────────────────────────────────
  it('11 ENDED → LIVE FORBIDDEN (terminal)', () => {
    expect(canTransition('ENDED', 'LIVE')).toBe(false);
  });

  it('12 ENDED → READY FORBIDDEN', () => {
    expect(canTransition('ENDED', 'READY')).toBe(false);
  });

  it('13 ENDED → CANCELLED FORBIDDEN', () => {
    expect(canTransition('ENDED', 'CANCELLED')).toBe(false);
  });

  it('14 PLANNED → LIVE FORBIDDEN (must arm first)', () => {
    expect(canTransition('PLANNED', 'LIVE')).toBe(false);
  });

  it('15 LIVE → PLANNED FORBIDDEN', () => {
    expect(canTransition('LIVE', 'PLANNED')).toBe(false);
  });

  it('16 CANCELLED → LIVE FORBIDDEN (must reinstate first)', () => {
    expect(canTransition('CANCELLED', 'LIVE')).toBe(false);
  });

  it('17 OVERRUN → READY FORBIDDEN', () => {
    expect(canTransition('OVERRUN', 'READY')).toBe(false);
  });

  it('18 ENDED → any is empty set', () => {
    const targets: SessionStatus[] = ['PLANNED','READY','CALLING','LIVE','OVERRUN','HOLD','CANCELLED'];
    for (const t of targets) {
      expect(canTransition('ENDED', t)).toBe(false);
    }
  });

  // ── Role permission checks ───────────────────────────────
  const ROLE_CAN_WRITE: Record<string, string[]> = {
    director: ['READY','CALLING','LIVE','HOLD','ENDED','CANCELLED','PLANNED','OVERRUN'],
    stage:    ['READY','CALLING','LIVE','HOLD','ENDED'],
    av:       ['HOLD'],
    interp:   [],
    reg:      [],
    signage:  [],
  };

  function roleCanTransition(role: string, to: string): boolean {
    return ROLE_CAN_WRITE[role]?.includes(to) ?? false;
  }

  it('19 stage can go_live', () => expect(roleCanTransition('stage', 'LIVE')).toBe(true));
  it('20 av cannot go_live', () => expect(roleCanTransition('av', 'LIVE')).toBe(false));
  it('21 av can hold_stage', () => expect(roleCanTransition('av', 'HOLD')).toBe(true));
  it('22 interp cannot transition any state', () => {
    const all: SessionStatus[] = ['PLANNED','READY','CALLING','LIVE','OVERRUN','HOLD','ENDED','CANCELLED'];
    for (const s of all) expect(roleCanTransition('interp', s)).toBe(false);
  });
  it('23 director can cancel', () => expect(roleCanTransition('director', 'CANCELLED')).toBe(true));
  it('24 stage cannot cancel', () => expect(roleCanTransition('stage', 'CANCELLED')).toBe(false));
});
