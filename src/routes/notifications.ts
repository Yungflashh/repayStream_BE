import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { AuditLog } from "../models/AuditLog.js";
import { Business } from "../models/Business.js";
import { Customer } from "../models/Customer.js";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { User } from "../models/User.js";

const router = Router();
router.use(requireAuth);

const MAX_NOTIFICATIONS = 40;

type NotificationRow = {
  id: string;
  action: string;
  title: string;
  body: string;
  plan_id: string | null;
  entity_type: string;
  created_at: Date;
  read: boolean;
};

// Actions that should surface to a business user as a notification.
const BUSINESS_ACTIONS = new Set([
  "plan_completed",
  "plan_defaulted",
  "customer_offline_payment_submitted",
  "offline_payment_recorded",
  "offline_payment_approved",
  "offline_payment_rejected",
  "installment_charged",
  "payment_attempt_update",
  "customer_retry_debit",
  "customer_portal_linked",
  "dispute_opened",
  "dispute_message_sent",
  "dispute_status_changed",
]);

// Actions that should surface to a customer user.
const CUSTOMER_ACTIONS = new Set([
  "plan_completed",
  "plan_defaulted",
  "offline_payment_recorded",
  "offline_payment_approved",
  "offline_payment_rejected",
  "payment_attempt_update",
  "plan_activated",
  "dispute_message_sent",
  "dispute_status_changed",
]);

function naira(amount: number | undefined | null): string {
  if (typeof amount !== "number") return "";
  return "₦" + amount.toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function humanize(action: string, payload: Record<string, unknown> | undefined, audience: "business" | "customer") {
  const amount = typeof payload?.amount === "number" ? payload.amount as number : undefined;
  const method = typeof payload?.method === "string" ? payload.method as string : undefined;

  switch (action) {
    case "plan_completed":
      return audience === "customer"
        ? { title: "Plan fully paid", body: "You've cleared your repayment plan." }
        : { title: "Plan completed", body: "A repayment plan has been fully paid." };
    case "plan_defaulted":
      return audience === "customer"
        ? { title: "Plan marked defaulted", body: "Your plan is now in default. Please settle to resume." }
        : { title: "Plan defaulted", body: "A plan reached the max failed attempts." };
    case "plan_activated":
      return { title: "Plan activated", body: "Auto-debit is now set up on your plan." };
    case "customer_offline_payment_submitted":
      return { title: "Offline payment awaiting approval", body: `${naira(amount)} via ${method ?? "offline"} — review it in the plan.` };
    case "offline_payment_recorded":
      return audience === "customer"
        ? { title: "Offline payment recorded", body: `${naira(amount)} via ${method ?? "offline"} was applied to your plan.` }
        : { title: "Offline payment recorded", body: `${naira(amount)} via ${method ?? "offline"} recorded.` };
    case "offline_payment_approved":
      return audience === "customer"
        ? { title: "Offline payment approved", body: `${naira(amount)} was approved and applied to your balance.` }
        : { title: "Offline payment approved", body: `${naira(amount)} approved.` };
    case "offline_payment_rejected":
      return audience === "customer"
        ? { title: "Offline payment rejected", body: (payload?.rejectionReason as string) || "Your submitted payment was rejected. Please contact the business." }
        : { title: "Offline payment rejected", body: `${naira(amount)} rejected.` };
    case "installment_charged":
      return { title: "Auto-debit attempted", body: `${naira(amount)} — ${(payload?.chargeStatus as string) || "processing"}.` };
    case "payment_attempt_update": {
      const status = payload?.status as string | undefined;
      if (status === "failed") return { title: "Payment failed", body: (payload?.failureReason as string)?.replace(/_/g, " ") ?? "Card charge declined." };
      if (status === "success") return { title: "Payment received", body: "A charge succeeded." };
      return { title: "Payment update", body: status ?? "" };
    }
    case "customer_retry_debit":
      return { title: "Customer retried debit", body: `Status: ${(payload?.status as string) ?? "unknown"}.` };
    case "customer_portal_linked":
      return { title: "Customer portal linked", body: "A customer connected their account." };
    case "dispute_opened":
      return { title: "New dispute", body: (payload?.subject as string) || "A customer opened a dispute." };
    case "dispute_message_sent":
      return { title: "New dispute message", body: (payload?.preview as string) || "You have a new message." };
    case "dispute_status_changed":
      return { title: "Dispute status changed", body: `Now ${(payload?.status as string) ?? "updated"}.` };
    default:
      return { title: action.replace(/_/g, " "), body: "" };
  }
}

// ── GET /api/notifications ──────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    const [biz, customer] = await Promise.all([
      Business.findOne({ userId: user._id }).lean(),
      Customer.findOne({ userId: user._id }).lean(),
    ]);

    const notifications: NotificationRow[] = [];
    const readAt = user.notificationsReadAt ?? new Date(0);

    // Business feed
    if (biz) {
      const planIds = await RepaymentPlan.find({ businessId: biz._id }).distinct("_id");
      const logs = await AuditLog.find({
        $or: [
          { entityId: { $in: planIds }, action: { $in: [...BUSINESS_ACTIONS] } },
          { entityType: "offline_payment", action: { $in: [...BUSINESS_ACTIONS] } },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(MAX_NOTIFICATIONS)
        .lean();

      for (const log of logs) {
        const payload = log.payload as Record<string, unknown> | undefined;
        const { title, body } = humanize(log.action, payload, "business");
        const planId = log.entityType === "repayment_plan"
          ? String(log.entityId)
          : (payload && typeof (payload as { planId?: unknown }).planId === "string" ? (payload as { planId: string }).planId : null);

        notifications.push({
          id: String(log._id),
          action: log.action,
          title,
          body,
          plan_id: planId,
          entity_type: log.entityType,
          created_at: log.createdAt,
          read: log.createdAt <= readAt,
        });
      }
    }

    // Customer feed (also runs when the same user is both a business owner
    // and a customer somewhere; entries dedupe by AuditLog id).
    if (customer) {
      const planIds = await RepaymentPlan.find({ customerId: customer._id }).distinct("_id");
      const logs = await AuditLog.find({
        entityId: { $in: planIds },
        action: { $in: [...CUSTOMER_ACTIONS] },
      })
        .sort({ createdAt: -1 })
        .limit(MAX_NOTIFICATIONS)
        .lean();

      const existing = new Set(notifications.map((n) => n.id));
      for (const log of logs) {
        if (existing.has(String(log._id))) continue;
        const payload = log.payload as Record<string, unknown> | undefined;
        const { title, body } = humanize(log.action, payload, "customer");
        notifications.push({
          id: String(log._id),
          action: log.action,
          title,
          body,
          plan_id: String(log.entityId),
          entity_type: log.entityType,
          created_at: log.createdAt,
          read: log.createdAt <= readAt,
        });
      }
    }

    notifications.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    const trimmed = notifications.slice(0, MAX_NOTIFICATIONS);
    const unread = trimmed.filter((n) => !n.read).length;

    res.json({ notifications: trimmed, unread, is_business: !!biz, is_customer: !!customer, customer_id: customer ? String(customer._id) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load notifications" });
  }
});

// POST /api/notifications/mark-read — bump the read pointer to now
router.post("/mark-read", async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, { notificationsReadAt: new Date() });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to mark read" });
  }
});

export default router;
