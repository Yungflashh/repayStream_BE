import { processScheduledReminders } from "../services/reminder.js";

let handle: ReturnType<typeof setInterval> | null = null;

/** Runs pre-due and overdue reminder checks on a fixed interval (default: every 30 min). */
export function startReminderScheduler(intervalMs = 30 * 60 * 1000) {
  console.log(`[reminder-scheduler] Starting (interval: ${intervalMs / 1000}s)`);
  void processScheduledReminders();
  handle = setInterval(() => void processScheduledReminders(), intervalMs);
}

export function stopReminderScheduler() {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}
