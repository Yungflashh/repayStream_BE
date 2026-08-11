export type ScheduleRow = { amount: number; due_date: string };

export function splitTotalKobo(totalKobo: number, n: number): number[] {
  if (n < 1) return [];
  const base = Math.floor(totalKobo / n);
  const rem = totalKobo - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

export function parseSchedule(plan: { scheduleJson: unknown; totalAmount: number }): ScheduleRow[] {
  const sj = plan.scheduleJson;
  if (Array.isArray(sj) && sj.length > 0) {
    return sj
      .filter((r: any) => typeof r.amount === "number" && typeof r.due_date === "string")
      .map((r: any) => ({ amount: r.amount, due_date: r.due_date }));
  }
  if (sj && typeof sj === "object" && !Array.isArray(sj)) {
    const obj = sj as { type?: string; installments?: any[]; dueDate?: string };
    if (obj.type === "installments" && Array.isArray(obj.installments)) {
      return obj.installments.map((x: any) => ({
        amount: parseFloat(String(x.amount ?? 0)),
        due_date: String(x.dueDate ?? ""),
      }));
    }
    if (obj.type === "lump_sum" && obj.dueDate) {
      return [{ amount: plan.totalAmount, due_date: obj.dueDate }];
    }
  }
  return [{ amount: plan.totalAmount, due_date: "" }];
}

export type NextInstallmentInfo = {
  index: number;
  row: ScheduleRow | null;
  dueAmount: number;
  alreadyPaid: number;
  isComplete: boolean;
};

// Returns the next unpaid installment and how much is still owed on it.
// `dueAmount` is the *remaining* portion — critical when a partial offline
// payment covered some of the installment (charging the full row amount
// would overpay). `isComplete` is true when the schedule is fully covered.
export function computeNextInstallment(schedule: ScheduleRow[], totalPaid: number): NextInstallmentInfo {
  let cumulative = 0;
  for (let i = 0; i < schedule.length; i++) {
    const row = schedule[i];
    if (totalPaid < cumulative + row.amount) {
      return {
        index: i,
        row,
        dueAmount: Math.max(0, row.amount - (totalPaid - cumulative)),
        alreadyPaid: Math.max(0, totalPaid - cumulative),
        isComplete: false,
      };
    }
    cumulative += row.amount;
  }
  return { index: schedule.length, row: null, dueAmount: 0, alreadyPaid: 0, isComplete: true };
}

export function isFullyPaid(plan: { scheduleJson: unknown; totalAmount: number }, totalPaid: number): boolean {
  if (totalPaid >= plan.totalAmount) return true;
  const schedule = parseSchedule(plan);
  if (!schedule.length) return false;
  return computeNextInstallment(schedule, totalPaid).isComplete;
}
