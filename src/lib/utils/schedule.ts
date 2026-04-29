export type ScheduleRow = { amount: number; due_date: string };

export function splitTotalKobo(totalKobo: number, n: number): number[] {
  if (n < 1) return [];
  const base = Math.floor(totalKobo / n);
  const rem = totalKobo - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}
