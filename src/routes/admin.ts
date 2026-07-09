import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { processScheduledPayments } from "../lib/scheduler.js";
import { processScheduledReminders } from "../services/reminder.js";

const router = Router();
router.use(requireAuth);

// All admin routes additionally require the ADMIN_SECRET header to match the env var.
// This prevents any authenticated business/customer user from triggering privileged ops.
router.use((req, res, next) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: "Admin endpoint not configured" });
  if (req.headers["x-admin-secret"] !== secret) return res.status(403).json({ error: "Forbidden" });
  next();
});

/** Manually trigger a scheduler sweep — useful in dev/test without waiting an hour. */
router.post("/run-scheduler", async (_req, res) => {
  try {
    console.log("[admin] Manual scheduler run triggered");
    await processScheduledPayments();
    res.json({ ok: true, message: "Scheduler run complete" });
  } catch (err) {
    console.error("[admin] Scheduler run failed:", err);
    res.status(500).json({ error: "Scheduler run failed" });
  }
});

/** Manually trigger a reminder sweep. */
router.post("/run-reminders", async (_req, res) => {
  try {
    console.log("[admin] Manual reminder run triggered");
    await processScheduledReminders();
    res.json({ ok: true, message: "Reminder run complete" });
  } catch (err) {
    console.error("[admin] Reminder run failed:", err);
    res.status(500).json({ error: "Reminder run failed" });
  }
});

export default router;
