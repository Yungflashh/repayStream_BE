import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Business } from "../models/Business.js";
import { Customer } from "../models/Customer.js";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { OfflinePayment } from "../models/OfflinePayment.js";
import { AuditLog } from "../models/AuditLog.js";

const router = Router();
router.use(requireAuth);

// ── BUSINESS ROUTES ──────────────────────────────────────────────────────────

// Business records an offline payment (auto-approved, immediately updates balance)
router.post("/plans/:planId/record", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.status(403).json({ error: "No business" });

    const plan = await RepaymentPlan.findOne({ _id: req.params.planId, businessId: biz._id });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const { amount, method, notes, proofUrl } = req.body as {
      amount?: number; method?: string; notes?: string; proofUrl?: string;
    };

    if (!amount || amount <= 0) return res.status(400).json({ error: "Valid amount required" });
    if (!["cash", "pos", "transfer", "other"].includes(method ?? "")) return res.status(400).json({ error: "Valid method required (cash, pos, transfer, other)" });

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
    });

    // Create a PaymentAttempt so balance tracking works automatically
    const totalAttempts = await PaymentAttempt.countDocuments({ planId: plan._id });
    await PaymentAttempt.create({
      planId: plan._id,
      attemptNumber: totalAttempts + 1,
      amount,
      status: "success",
      provider: null,
      externalRef: `offline_${op._id}`,
      idempotencyKey: `offline_${op._id}`,
    });

    await AuditLog.create({
      actor: `business:${biz._id}`,
      action: "offline_payment_recorded",
      entityType: "repayment_plan",
      entityId: plan._id,
      payload: { amount, method, offlinePaymentId: op._id },
    });

    res.json({ ok: true, payment: { id: op._id, amount, method, status: "approved" } });
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

    const op = await OfflinePayment.findOne({ _id: req.params.paymentId, businessId: biz._id });
    if (!op) return res.status(404).json({ error: "Payment not found" });
    if (op.status !== "pending_approval") return res.status(400).json({ error: "Payment is not pending approval" });

    op.status = "approved";
    op.approvedAt = new Date();
    await op.save();

    // Create PaymentAttempt to update balance
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

    await AuditLog.create({
      actor: `business:${biz._id}`,
      action: "offline_payment_approved",
      entityType: "offline_payment",
      entityId: op._id,
      payload: { amount: op.amount, method: op.method },
    });

    res.json({ ok: true });
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

    const op = await OfflinePayment.findOne({ _id: req.params.paymentId, businessId: biz._id });
    if (!op) return res.status(404).json({ error: "Payment not found" });
    if (op.status !== "pending_approval") return res.status(400).json({ error: "Payment is not pending approval" });

    op.status = "rejected";
    await op.save();

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

    const { amount, method, notes, proofUrl } = req.body as {
      amount?: number; method?: string; notes?: string; proofUrl?: string;
    };

    if (!amount || amount <= 0) return res.status(400).json({ error: "Valid amount required" });
    if (!["cash", "pos", "transfer", "other"].includes(method ?? "")) return res.status(400).json({ error: "Valid method required" });

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
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load payments" });
  }
});

export default router;
