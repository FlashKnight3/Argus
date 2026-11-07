import { describe, expect, it } from 'vitest';
import { parseRuleBased } from './handoff';

describe('rule-based MIST parser', () => {
  const report =
    'About 34 year old female, struck by falling steel when the roof collapsed. Penetrating wound to the left flank, still bleeding. HR 132, BP 84/50, RR 30, sats 91%, GCS 14. Wound packed, gave TXA, on oxygen.';

  it('extracts vitals exactly', () => {
    const h = parseRuleBased(report);
    expect(h.vitals).toEqual({ hr: 132, sbp: 84, rr: 30, spo2: 91, gcs: 14 });
    expect(h.age).toBe(34);
  });

  it('classifies the injury archetype', () => {
    expect(parseRuleBased(report).injuryType).toBe('penetrating_torso');
    expect(parseRuleBased('Partial amputation of the left leg, tourniquet applied').injuryType).toBe('blast_extremity');
    expect(parseRuleBased('Unequal pupils after being struck on the head').injuryType).toBe('head_injury');
  });

  it('fills every MIST field', () => {
    const { mist } = parseRuleBased(report);
    expect(mist.mechanism).toBe('Struck by falling steel when the roof collapsed');
    expect(mist.injuries).toMatch(/Penetrating wound/);
    expect(mist.signs).toBe('HR 132, SBP 84, RR 30, SpO₂ 91%, GCS 14');
    expect(mist.treatment).toBe('TXA, Wound packing, Oxygen');
  });

  it('captures observations that feed SALT', () => {
    expect(parseRuleBased(report).observations.hemorrhageControlled).toBe(false);
    expect(parseRuleBased('walking wounded, small cut').observations.walks).toBe(true);
  });

  it('never invents vitals', () => {
    const h = parseRuleBased('Burns to both arms, conscious and talking.');
    expect(h.vitals).toEqual({});
    expect(h.mist.signs).toBe('Not recorded');
  });
});
