import { Router } from "express";
import { Types } from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { Business } from "../models/Business.js";
import { Customer } from "../models/Customer.js";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { OfflinePayment } from "../models/OfflinePayment.js";
import { AuditLog } from "../models/AuditLog.js";
import { isFullyPaid } from "../lib/utils/schedule.js";
import { sendPlanCompletedNotification } from "../services/reminder.js";

const router = Router();
router.use(requireAuth);

// Returns the remaining balance on a plan (totalAmount minus all successful attempts).
async function remainingBalance(plan: { _id: unknown; totalAmount: number }): Promise<number> {
  const successAttempts = await PaymentAttempt.find({ planId: plan._id, status: "success" }).lean();
  const paid = successAttempts.reduce((s, a) => s + a.amount, 0);
  return Math.max(0, plan.totalAmount - paid);
}

// Applies a successful offline payment to a plan: creates the PaymentAttempt that
// drives balance tracking, then transitions plan status (pending_mandate/defaulted
// → active, active → completed when fully paid). Returns whether the plan just
// completed so the caller can dispatch the completion notification.
async function applyOfflineToPlan(op: {
  _id: unknown; planId: unknown; amount: number;
}): Promise<{ completed: boolean }> {
  const totalAttempts = await PaymentAttempt.countDocuments({ planId: op.planId });
  await PaymentAttempt.create({
    planId: op.planId,
    attemptNumber: totalAttempts + 1,
    amount: op.amount,
    status: "success",
    provider: null,
    externalRef: `offline_${op._id}`,
    idempotencyKey: `offline_${op._id}`,
  });

  const plan = await RepaymentPlan.findById(op.planId);
  if (!plan) return { completed: false };

  const successAttempts = await PaymentAttempt.find({ planId: plan._id, status: "success" }).lean();
  const totalPaid = successAttempts.reduce((s, a) => s + a.amount, 0);

  // Bring paused/completed/cancelled plans out of scope; otherwise reactivate
  // pending_mandate and defaulted plans since money has now been collected.
  let statusChanged = false;
  if (plan.status === "pending_mandate" || plan.status === "defaulted") {
    plan.status = "active";
    statusChanged = true;
  }

  const nowComplete = plan.status === "active" && isFullyPaid(plan, totalPaid);
  if (nowComplete) {
    plan.status = "completed";
    statusChanged = true;
  }

  if (statusChanged) await plan.save();

  if (nowComplete) {
    await AuditLog.create({
      actor: "system:offline",
      action: "plan_completed",
      entityType: "repayment_plan",
      entityId: plan._id,
      payload: { totalPaid, offlinePaymentId: op._id },
    });
  }

  return { completed: nowComplete };
}

// ── BUSINESS ROUTES ──────────────────────────────────────────────────────────

// Business records an offline payment (auto-approved, immediately updates balance)
router.post("/plans/:planId/record", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.status(403).json({ error: "No business" });

    const plan = await RepaymentPlan.findOne({ _id: req.params.planId, businessId: biz._id });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    if (["completed", "cancelled"].includes(plan.status)) {
      return res.status(400).json({ error: "Cannot record payment for a completed or cancelled plan" });
    }

    const { amount, method, notes, proofUrl } = req.body as {
      amount?: number; method?: string; notes?: string; proofUrl?: string;
    };

    if (!amount || amount <= 0) return res.status(400).json({ error: "Valid amount required" });
    if (!["cash", "pos", "transfer", "other"].includes(method ?? "")) return res.status(400).json({ error: "Valid method required (cash, pos, transfer, other)" });
    if (proofUrl && !/^https:\/\//i.test(proofUrl.trim())) return res.status(400).json({ error: "proofUrl must be an https:// URL" });

    // Prevent overpayment: cap at remaining balance (small tolerance for rounding).
    const remaining = await remainingBalance(plan);
    if (amount > remaining + 0.01) {
      return res.status(400).json({ error: `Amount exceeds remaining balance (₦${remaining.toFixed(2)})` });
    }

    const op = await OfflinePayment.create({
      planId: plan._id,
      businessId: biz._id,
      amount,
      method,
      notes: notes?.trim() || undefined,
      proofUrl: proofUrl?.trim() || undefined,
      status: "approved",
      recordedBy: "business",
      recordedByUserId: req.userId,
      approvedAt: new Date(),
      approvedByUserId: req.userId,
    });

    const { completed } = await applyOfflineToPlan(op);

    await AuditLog.create({
      actor: `business:${biz._id}`,
      action: "offline_payment_recorded",
      entityType: "repayment_plan",
      entityId: plan._id,
      payload: { amount, method, offlinePaymentId: op._id, planCompleted: completed },
    });

    if (completed) {
      sendPlanCompletedNotification(plan._id).catch((err: unknown) => {
        console.error("[offline] Failed to send completion notification:", err);
      });
    }

    res.json({ ok: true, payment: { id: op._id, amount, method, status: "approved" }, planCompleted: completed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to record payment" });
  }
});

// List offline payments for a plan (business view)
router.get("/plans/:planId", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.status(403).json({ error: "No business" });

    const plan = await RepaymentPlan.findOne({ _id: req.params.planId, businessId: biz._id });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const payments = await OfflinePayment.find({ planId: plan._id }).sort({ createdAt: -1 }).lean();

    res.json({
      payments: payments.map((p) => ({
        id: p._id,
        amount: p.amount,
        method: p.method,
        notes: p.notes,
        proof_url: p.proofUrl,
        status: p.status,
        recorded_by: p.recordedBy,
        created_at: p.createdAt,
        approved_at: p.approvedAt,
        rejected_at: p.rejectedAt,
        rejection_reason: p.rejectionReason,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load payments" });
  }
});

// Business approves a customer-submitted offline payment
router.post("/:paymentId/approve", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.status(403).json({ error: "No business" });

    // Atomic compare-and-swap: only succeeds if status is still pending_approval,
    // preventing double-approval race conditions from concurrent requests.
    const op = await OfflinePayment.findOneAndUpdate(
      { _id: req.params.paymentId, businessId: biz._id, status: "pending_approval" },
      { status: "approved", approvedAt: new Date(), approvedByUserId: new Types.ObjectId(req.userId) },
      { new: true }
    );
    if (!op) {
      const exists = await OfflinePayment.exists({ _id: req.params.paymentId, businessId: biz._id });
      return res.status(exists ? 400 : 404).json({ error: exists ? "Payment is not pending approval" : "Payment not found" });
    }

    // Overpayment check on approval — the plan balance may have moved since the
    // customer submitted; reject rather than allow the plan to go negative.
    const plan = await RepaymentPlan.findById(op.planId);
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    const remaining = await remainingBalance(plan);
    if (op.amount > remaining + 0.01) {
      // Roll back the approval so the operator can reject instead
      await OfflinePayment.findByIdAndUpdate(op._id, {
        $set: { status: "pending_approval" },
        $unset: { approvedAt: 1, approvedByUserId: 1 },
      });
      return res.status(400).json({ error: `Amount exceeds remaining balance (₦${remaining.toFixed(2)}). Reject instead.` });
    }

    const { completed } = await applyOfflineToPlan(op);

    await AuditLog.create({
      actor: `business:${biz._id}`,
      action: "offline_payment_approved",
      entityType: "offline_payment",
      entityId: op._id,
      payload: { amount: op.amount, method: op.method, planCompleted: completed },
    });

    if (completed) {
      sendPlanCompletedNotification(String(op.planId)).catch((err: unknown) => {
        console.error("[offline] Failed to send completion notification:", err);
      });
    }

    res.json({ ok: true, planCompleted: completed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Approval failed" });
  }
});

// Business rejects a customer-submitted offline payment
router.post("/:paymentId/reject", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.status(403).json({ error: "No business" });

    const { reason } = req.body as { reason?: string };
    const rejectionReason = reason?.trim() || undefined;

    // Atomic CAS — mirrors approve to eliminate approve/reject and reject/reject races.
    const op = await OfflinePayment.findOneAndUpdate(
      { _id: req.params.paymentId, businessId: biz._id, status: "pending_approval" },
      { status: "rejected", rejectedAt: new Date(), rejectedByUserId: new Types.ObjectId(req.userId), rejectionReason },
      { new: true }
    );
    if (!op) {
      const exists = await OfflinePayment.exists({ _id: req.params.paymentId, businessId: biz._id });
      return res.status(exists ? 400 : 404).json({ error: exists ? "Payment is not pending approval" : "Payment not found" });
    }

    await AuditLog.create({
      actor: `business:${biz._id}`,
      action: "offline_payment_rejected",
      entityType: "offline_payment",
      entityId: op._id,
      payload: { amount: op.amount, method: op.method, rejectionReason: rejectionReason ?? null },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Rejection failed" });
  }
});

// ── CUSTOMER ROUTES ───────────────────────────────────────────────────────────

// Customer submits an offline payment (pending business approval)
router.post("/customer/:customerId/plans/:planId/submit", async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.customerId);
    if (!customer || String(customer.userId) !== req.userId) return res.status(403).json({ error: "Unauthorized" });

    const plan = await RepaymentPlan.findOne({ _id: req.params.planId, customerId: customer._id });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    // Don't accept submissions for terminal plan states
    if (["completed", "cancelled"].includes(plan.status)) {
      return res.status(400).json({ error: "Cannot submit payment for a completed or cancelled plan" });
    }

    const { amount, method, notes, proofUrl } = req.body as {
      amount?: number; method?: string; notes?: string; proofUrl?: string;
    };

    if (!amount || amount <= 0) return res.status(400).json({ error: "Valid amount required" });
    if (!["cash", "pos", "transfer", "other"].includes(method ?? "")) return res.status(400).json({ error: "Valid method required" });
    if (proofUrl && !/^https:\/\//i.test(proofUrl.trim())) return res.status(400).json({ error: "proofUrl must be an https:// URL" });

    // Cap against remaining balance to prevent customers from submitting overpay
    // amounts that would then trap the operator into rejecting.
    const remaining = await remainingBalance(plan);
    if (amount > remaining + 0.01) {
      return res.status(400).json({ error: `Amount exceeds remaining balance (₦${remaining.toFixed(2)})` });
    }

    const op = await OfflinePayment.create({
      planId: plan._id,
      businessId: plan.businessId,
      amount,
      method,
      notes: notes?.trim() || undefined,
      proofUrl: proofUrl?.trim() || undefined,
      status: "pending_approval",
      recordedBy: "customer",
      recordedByUserId: req.userId,
    });

    await AuditLog.create({
      actor: `customer:${customer._id}`,
      action: "customer_offline_payment_submitted",
      entityType: "repayment_plan",
      entityId: plan._id,
      payload: { amount, method, offlinePaymentId: op._id },
    });

    res.json({ ok: true, payment: { id: op._id, amount, method, status: "pending_approval" } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to submit payment" });
  }
});

// Customer views their offline payments for a plan
router.get("/customer/:customerId/plans/:planId", async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.customerId);
    if (!customer || String(customer.userId) !== req.userId) return res.status(403).json({ error: "Unauthorized" });

    const plan = await RepaymentPlan.findOne({ _id: req.params.planId, customerId: customer._id });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const payments = await OfflinePayment.find({ planId: plan._id }).sort({ createdAt: -1 }).lean();

    res.json({
      payments: payments.map((p) => ({
        id: p._id,
        amount: p.amount,
        method: p.method,
        notes: p.notes,
        proof_url: p.proofUrl,
        status: p.status,
        recorded_by: p.recordedBy,
        created_at: p.createdAt,
        approved_at: p.approvedAt,
        rejected_at: p.rejectedAt,
        rejection_reason: p.rejectionReason,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load payments" });
  }
});

export default router;
