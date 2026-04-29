/**
 * Retry schedule:
 *   Attempt 1 — due date
 *   Attempt 2 — due date + 24 h
 *   Attempt 3 — due date + 72 h
 *   If failure is "insufficient_funds", add +6 h backoff to next retry
 */

const BASE_OFFSETS_MS = [0, 24 * 3600_000, 72 * 3600_000];
const INSUFFICIENT_FUNDS_EXTRA_MS = 6 * 3600_000;

export function nextRetryDate(
  dueDate: Date,
  currentAttempt: number,
  failureReason: string | null
): Date | null {
  const nextAttempt = currentAttempt + 1;
  if (nextAttempt > 3) return null;

  const offsetMs = BASE_OFFSETS_MS[nextAttempt - 1] ?? 0;
  let retry = new Date(dueDate.getTime() + offsetMs);

  if (failureReason === "insufficient_funds") {
    retry = new Date(retry.getTime() + INSUFFICIENT_FUNDS_EXTRA_MS);
  }

  return retry;
}
