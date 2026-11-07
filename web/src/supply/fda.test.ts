import { describe, expect, it } from 'vitest';
import { isCurrentShortage, shortageForNdc } from './fda';
import type { Shortage } from './useSupply';

describe('FDA signal matching', () => {
  const notices = [
    { key: 'a', packageNdc: '0228-2551-06', genericName: 'Example vial', active: true, status: 'Currently in Shortage' },
    { key: 'b', packageNdc: '0228-2551-10', genericName: 'Example vial', active: true, status: 'Currently in Shortage' },
  ] as Shortage[];

  it('matches the exact package code across punctuation only', () => {
    expect(shortageForNdc(notices, '0228255106')?.key).toBe('a');
    expect(shortageForNdc(notices, '0228255110')?.key).toBe('b');
    expect(shortageForNdc(notices, '02282551')).toBeUndefined();
  });

  it('does not present resolved or discontinued notices as current', () => {
    expect(isCurrentShortage(notices[0])).toBe(true);
    expect(isCurrentShortage({ active: true, status: 'Resolved' })).toBe(false);
    expect(isCurrentShortage({ active: true, status: 'Discontinued' })).toBe(false);
  });
});
