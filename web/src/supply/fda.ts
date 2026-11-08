import type { Shortage } from './useSupply';

export const ndcDigits = (value: string) => value.replace(/[^0-9]/g, '');

export function isCurrentShortage(row: Pick<Shortage, 'active' | 'status'>): boolean {
  return row.active && /current|shortage/i.test(row.status) && !/resolved|discontinued/i.test(row.status);
}

export function shortageForNdc(shortages: readonly Shortage[], code: string): Shortage | undefined {
  const digits = ndcDigits(code);
  return shortages.find(row => row.active && ndcDigits(row.packageNdc) === digits);
}
