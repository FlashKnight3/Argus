import { describe, expect, it } from 'vitest';
import {
  WEIGHTED_RTS_MAX,
  codeGcs,
  codeRr,
  codeSbp,
  jumpStart,
  precedenceDeadline,
  precedenceFor,
  retriage,
  revisedTraumaScore,
  salt,
  start,
  triage,
} from '../src/protocols';

const stable = { hr: 88, sbp: 124, rr: 16, spo2: 98, gcs: 15 };

describe('Revised Trauma Score', () => {
  it('codes GCS bands', () => {
    expect([15, 13, 12, 9, 8, 6, 5, 4, 3].map(codeGcs)).toEqual([4, 4, 3, 3, 2, 2, 1, 1, 0]);
  });
  it('codes systolic BP bands', () => {
    expect([120, 90, 89, 76, 75, 50, 49, 1, 0].map(codeSbp)).toEqual([4, 4, 3, 3, 2, 2, 1, 1, 0]);
  });
  it('codes respiratory rate bands', () => {
    expect([35, 30, 29, 10, 9, 6, 5, 1, 0].map(codeRr)).toEqual([3, 3, 4, 4, 2, 2, 1, 1, 0]);
  });
  it('scores a normal adult at the maximum', () => {
    const r = revisedTraumaScore(stable);
    expect(r.tRts).toBe(12);
    expect(r.weighted).toBeCloseTo(WEIGHTED_RTS_MAX, 3);
    expect(WEIGHTED_RTS_MAX).toBeCloseTo(7.8408, 4);
  });
  it('computes the weighted score with published coefficients', () => {
    // GCS 10 → 3, SBP 70 → 2, RR 32 → 3
    const r = revisedTraumaScore({ gcs: 10, sbp: 70, rr: 32 });
    expect(r.tRts).toBe(8);
    expect(r.weighted).toBeCloseTo(0.9368 * 3 + 0.7326 * 2 + 0.2908 * 3, 4);
  });
});

describe('SALT', () => {
  it('marks non-breathing casualties Dead', () => {
    expect(salt({ ...stable, rr: 0 }).category).toBe('dead');
  });
  it('assigns Minimal when all checks pass and injuries are minor', () => {
    expect(salt(stable, { walks: true, minorInjuriesOnly: true }).category).toBe('minimal');
  });
  it('assigns Delayed when all checks pass but injuries are not minor', () => {
    expect(salt(stable).category).toBe('delayed');
  });
  it('assigns Immediate when a life-threat check fails', () => {
    expect(salt({ ...stable, sbp: 70 }).category).toBe('immediate');
    expect(salt({ ...stable, rr: 34 }).category).toBe('immediate');
    expect(salt(stable, { hemorrhageControlled: false }).category).toBe('immediate');
    expect(salt({ ...stable, gcs: 9 }).category).toBe('immediate');
  });
  it('never infers Expectant; only an explicit medic answer can', () => {
    const critical = { hr: 150, sbp: 40, rr: 40, spo2: 70, gcs: 4 };
    expect(salt(critical).category).toBe('immediate');
    expect(salt(critical, { likelyToSurvive: false }).category).toBe('expectant');
  });
  it('records a readable decision trace', () => {
    const r = salt({ ...stable, sbp: 70 });
    expect(r.protocol).toBe('SALT');
    expect(r.trace.join(' ')).toMatch(/peripheral pulse/);
  });
});

describe('START', () => {
  it('sends walking wounded to Minimal', () => {
    expect(start(stable, { walks: true }).category).toBe('minimal');
  });
  it('RR > 30 is Immediate', () => {
    expect(start({ ...stable, rr: 32 }).category).toBe('immediate');
  });
  it('poor perfusion is Immediate', () => {
    expect(start(stable, { capRefillOver2s: true }).category).toBe('immediate');
  });
  it('cannot follow commands is Immediate', () => {
    expect(start({ ...stable, gcs: 10 }).category).toBe('immediate');
  });
  it('otherwise Delayed', () => {
    expect(start(stable).category).toBe('delayed');
  });
  it('apnoeic after airway repositioning is Dead', () => {
    expect(start({ ...stable, rr: 0 }).category).toBe('dead');
  });
});

describe('JumpSTART', () => {
  const child = { hr: 110, sbp: 100, rr: 24, spo2: 98, gcs: 15 };
  it('apnoeic with pulse and rescue breaths that work is Immediate', () => {
    expect(jumpStart({ ...child, rr: 0 }, { breathingAfterRescueBreaths: true }).category).toBe('immediate');
  });
  it('apnoeic without a pulse is Dead', () => {
    expect(jumpStart({ ...child, rr: 0, hr: 0 }).category).toBe('dead');
  });
  it('RR outside 15–45 is Immediate', () => {
    expect(jumpStart({ ...child, rr: 12 }).category).toBe('immediate');
    expect(jumpStart({ ...child, rr: 50 }).category).toBe('immediate');
  });
  it('inappropriate response to pain is Immediate', () => {
    expect(jumpStart(child, { avpu: 'P', painResponseAppropriate: false }).category).toBe('immediate');
  });
  it('alert child with normal RR and pulse is Delayed', () => {
    expect(jumpStart(child).category).toBe('delayed');
  });
  it('START teams route under-8s to JumpSTART', () => {
    expect(triage('START', 5, child).protocol).toBe('JumpSTART');
    expect(triage('START', 30, stable).protocol).toBe('START');
    expect(triage('SALT', 5, child).protocol).toBe('SALT');
  });
});

describe('MEDEVAC precedence', () => {
  it('maps categories to precedence tiers', () => {
    expect(precedenceFor('immediate', false)).toBe('A');
    expect(precedenceFor('immediate', true)).toBe('B');
    expect(precedenceFor('delayed', false)).toBe('C');
    expect(precedenceFor('minimal', false)).toBe('D');
    expect(precedenceFor('expectant', false)).toBeNull();
    expect(precedenceFor('dead', false)).toBeNull();
  });
  it('sets deadlines from the evacuation window', () => {
    expect(precedenceDeadline(10, 'A')).toBe(130);
    expect(precedenceDeadline(10, 'C')).toBe(250);
    expect(precedenceDeadline(10, null)).toBe(-1);
  });
});

describe('re-triage guardrails', () => {
  const immediate = { protocol: 'SALT' as const, category: 'immediate' as const, trace: [] };
  const dead = { protocol: 'SALT' as const, category: 'dead' as const, trace: [] };
  const minimal = { protocol: 'SALT' as const, category: 'minimal' as const, trace: [] };
  it('escalates when vitals worsen', () => {
    expect(retriage('delayed', false, immediate)).toEqual({ category: 'immediate', changed: true });
  });
  it('never auto-downgrades', () => {
    expect(retriage('immediate', false, minimal).changed).toBe(false);
  });
  it('never auto-assigns Dead or Expectant', () => {
    expect(retriage('immediate', false, dead).category).toBe('immediate');
  });
  it('respects a medic-set category', () => {
    expect(retriage('delayed', true, immediate).changed).toBe(false);
  });
});
