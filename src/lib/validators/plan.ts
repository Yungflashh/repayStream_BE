type ScheduleRow = { amount: number; due_date: string };

export function validatePlanBody(body: Record<string, unknown>): string | null {
  const { customerPhone, customerEmail, totalAmount, paymentMethod, schedule } = body;

  if (typeof customerPhone !== "string" || customerPhone.trim().length < 8)
    return "customerPhone must be at least 8 chars";
  if (typeof customerEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))
    return "Invalid customerEmail";
  if (typeof totalAmount !== "string" || !/^\d+(\.\d{1,2})?$/.test(totalAmount))
    return "totalAmount must be a decimal string with up to 2 places";
  if (paymentMethod !== "card")
    return "paymentMethod must be 'card'";
  if (!Array.isArray(schedule) || schedule.length < 1 || schedule.length > 60)
    return "schedule must have 1-60 rows";

  const totalKobo = Math.round(parseFloat(totalAmount) * 100);
  let sumKobo = 0;
  const dates = new Set<string>();
  const today = new Date().toISOString().slice(0, 10);

  for (const row of schedule as ScheduleRow[]) {
    if (typeof row.amount !== "number" || row.amount <= 0) return "Each amount must be positive";
    if (typeof row.due_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.due_date))
      return "Each due_date must be YYYY-MM-DD";
    if (row.due_date < today) return "All due dates must be today or later";
    if (dates.has(row.due_date)) return "Duplicate due dates are not allowed";
    dates.add(row.due_date);
    sumKobo += Math.round(row.amount * 100);
  }

  if (sumKobo !== totalKobo) return "Installment amounts must add up to total amount";
  return null;
}
