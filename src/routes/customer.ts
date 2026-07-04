import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Customer } from "../models/Customer.js";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { OfflinePayment } from "../models/OfflinePayment.js";
import { Business } from "../models/Business.js";
import { User } from "../models/User.js";
import { AuditLog } from "../models/AuditLog.js";
import { chargeAuthorization, initializePaystackTransaction } from "../lib/paystack.js";

const router = Router();
router.use(requireAuth);

router.post("/claim", async (req, res) => {
  try {
    const { customerId } = req.body as { customerId?: string };
    if (!customerId) return res.status(400).json({ error: "customerId required" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    const customer = await Customer.findById(customerId);
    // Return 401 for both "not found" and "email mismatch" to prevent customer ID enumeration
    if (!customer || customer.email?.toLowerCase() !== user.email.toLowerCase()) {
      return res.status(401).json({ error: "Customer not found or email does not match" });
    }

    customer.userId = user._id as any;
    await customer.save();

    await AuditLog.create({
      actor: `user:${req.userId}`,
      action: "customer_portal_linked",
      entityType: "customer",
      entityId: customer._id,
      payload: { email: user.email },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Claim failed" });
  }
});

router.get("/mine", async (req, res) => {
  try {
    const customer = await Customer.findOne({ userId: req.userId }).lean();
    if (!customer) return res.json({ customer: null });
    res.json({ customer: { id: customer._id, phone: customer.phone, email: customer.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed" });
  }
});

router.get("/:id/portal", async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    if (!customer.userId || String(customer.userId) !== req.userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const plans = await RepaymentPlan.find({ customerId: customer._id })
      .sort({ createdAt: -1 })
      .lean();

    const planIds = plans.map((p) => p._id);
    const businessIds = [...new Set(plans.map((p) => p.businessId.toString()))];

    const [allAttempts, offlinePayments, businesses] = await Promise.all([
      PaymentAttempt.find({ planId: { $in: planIds } }).sort({ createdAt: 1 }).lean(),
      OfflinePayment.find({ planId: { $in: planIds } }).sort({ createdAt: -1 }).lean(),
      Business.find({ _id: { $in: businessIds } }).lean(),
    ]);

    const attemptsByPlan = new Map<string, typeof allAttempts>();
    for (const a of allAttempts) {
      const key = a.planId.toString();
      if (!attemptsByPlan.has(key)) attemptsByPlan.set(key, []);
      attemptsByPlan.get(key)!.push(a);
    }

    const offlineByPlan = new Map<string, typeof offlinePayments>();
    for (const op of offlinePayments) {
      const key = op.planId.toString();
      if (!offlineByPlan.has(key)) offlineByPlan.set(key, []);
      offlineByPlan.get(key)!.push(op);
    }

    const bizMap = new Map(businesses.map((b) => [b._id.toString(), b]));

    res.json({
      customer: { id: customer._id, phone: customer.phone, email: customer.email },
      plans: plans.map((p) => {
        const biz = bizMap.get(p.businessId.toString());
        return {
          id: p._id,
          plan_name: (p as { planName?: string }).planName ?? null,
          business_name: (biz as { name?: string } | undefined)?.name ?? null,
          total_amount: p.totalAmount,
          status: p.status,
          payment_method: p.paymentMethod,
          fee_strategy: (p as { feeStrategy?: string }).feeStrategy ?? "absorb",
          schedule_json: p.scheduleJson,
          created_at: p.createdAt,
          notes: ((p as { notes?: { text: string; createdAt: Date }[] }).notes ?? []).map((n) => ({
            text: n.text,
            created_at: n.createdAt,
          })),
          attempts: (attemptsByPlan.get(p._id.toString()) ?? []).map((a) => ({
            id: a._id,
            attempt_number: a.attemptNumber,
            amount: a.amount,
            status: a.status,
            provider: a.provider,
            failure_reason: a.failureReason,
            created_at: a.createdAt,
          })),
          offline_payments: (offlineByPlan.get(p._id.toString()) ?? []).map((op) => ({
            id: op._id,
            amount: op.amount,
            method: op.method,
            notes: op.notes,
            proof_url: op.proofUrl,
            status: op.status,
            recorded_by: op.recordedBy,
            created_at: op.createdAt,
          })),
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load portal" });
  }
});

const APP_URL = () => process.env.PUBLIC_APP_URL ?? "http://localhost:5173";

function parseScheduleForCustomer(plan: { scheduleJson: unknown; totalAmount: number }): { amount: number; due_date: string }[] {
  const sj = plan.scheduleJson;
  if (Array.isArray(sj)) return sj.filter((r: any) => typeof r.amount === "number").map((r: any) => ({ amount: r.amount, due_date: r.due_date ?? "" }));
  if (sj && typeof sj === "object" && !Array.isArray(sj)) {
    const obj = sj as { type?: string; installments?: any[]; dueDate?: string };
    if (obj.type === "installments" && Array.isArray(obj.installments)) {
      return obj.installments.map((x: any) => ({ amount: parseFloat(String(x.amount ?? 0)), due_date: String(x.dueDate ?? "") }));
    }
    if (obj.type === "lump_sum" && obj.dueDate) return [{ amount: plan.totalAmount, due_date: obj.dueDate }];
  }
  return [{ amount: plan.totalAmount, due_date: "" }];
}

// Retry auto-debit on next overdue installment
router.post("/:id/plans/:planId/retry-debit", async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer || String(customer.userId) !== req.userId) return res.status(403).json({ error: "Unauthorized" });

    const plan = await RepaymentPlan.findOne({ _id: req.params.planId, customerId: customer._id });
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    if (plan.status !== "active" && plan.status !== "defaulted") return res.status(400).json({ error: "Plan is not active" });

    const authCode = (plan as any).authorizationCode as string | undefined;
    if (!authCode) return res.status(400).json({ error: "No payment method on file. Update your payment method first." });

    // Prevent double-charge: reject if a payment is already in progress
    const existingPending = await PaymentAttempt.findOne({ planId: plan._id, status: "pending" });
    if (existingPending) return res.status(409).json({ error: "A payment is already in progress for this plan." });

    const schedule = parseScheduleForCustomer(plan);
    const successCount = await PaymentAttempt.countDocuments({ planId: plan._id, status: "success" });
    const nextInstallment = schedule[successCount];
    if (!nextInstallment) return res.status(400).json({ error: "No installment to retry" });

    const email = customer.email ?? "customer@repaystream.local";
    const reference = `rs_retry_${plan._id}_${Date.now()}`;
    const amountKobo = Math.max(Math.round(nextInstallment.amount * 100), 200);
    const totalAttempts = await PaymentAttempt.countDocuments({ planId: plan._id });

    const attempt = await PaymentAttempt.create({
      planId: plan._id, attemptNumber: totalAttempts + 1, amount: nextInstallment.amount,
      status: "pending", provider: "paystack", externalRef: reference, idempotencyKey: reference,
    });

    let chargeResult: { status: string; gateway_response?: string };
    try {
      chargeResult = await chargeAuthorization({ authorizationCode: authCode, email, amount: amountKobo, reference });
    } catch (chargeErr) {
      // Mark attempt failed if the charge call itself throws
      attempt.status = "failed";
      attempt.failureReason = "gateway_error";
      await attempt.save();
      throw chargeErr;
    }

    if (chargeResult.status === "success") { attempt.status = "success"; await attempt.save(); }
    else if (chargeResult.status === "failed") { attempt.status = "failed"; attempt.failureReason = chargeResult.gateway_response || "gateway_declined"; await attempt.save(); }

    if (plan.status === "defaulted" && chargeResult.status === "success") {
      plan.status = "active";
      await plan.save();
    }

    await AuditLog.create({ actor: `customer:${customer._id}`, action: "customer_retry_debit", entityType: "repayment_plan", entityId: plan._id, payload: { reference, status: chargeResult.status } });

    res.json({ ok: true, status: chargeResult.status, message: chargeResult.gateway_response });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Retry failed" });
  }
});

// Initialize Paystack transaction for manual payment (bank transfer / card)
router.post("/:id/plans/:planId/pay-now", async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer || String(customer.userId) !== req.userId) return res.status(403).json({ error: "Unauthorized" });

    const plan = await RepaymentPlan.findOne({ _id: req.params.planId, customerId: customer._id });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    // Prevent duplicate pending attempts
    const existingPending = await PaymentAttempt.findOne({ planId: plan._id, status: "pending" });
    if (existingPending) return res.status(409).json({ error: "A payment is already in progress for this plan." });

    const schedule = parseScheduleForCustomer(plan);
    const successCount = await PaymentAttempt.countDocuments({ planId: plan._id, status: "success" });
    const nextInstallment = schedule[successCount];
    if (!nextInstallment) return res.status(400).json({ error: "All installments are paid" });

    const email = customer.email ?? "customer@repaystream.local";
    const reference = `rs_manual_${plan._id}_${Date.now()}`;
    const amountKobo = Math.max(Math.round(nextInstallment.amount * 100), 200);
    const totalAttempts = await PaymentAttempt.countDocuments({ planId: plan._id });

    await PaymentAttempt.create({
      planId: plan._id, attemptNumber: totalAttempts + 1, amount: nextInstallment.amount,
      status: "pending", provider: "paystack", externalRef: reference, idempotencyKey: reference,
    });

    const result = await initializePaystackTransaction({
      email, amount: amountKobo, reference,
      callbackUrl: `${APP_URL()}/plan/${plan._id}?trxref=${reference}`,
    });

    res.json({ authorizationUrl: result.authorization_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not start payment" });
  }
});

// Update payment method — initializes a ₦100 Paystack transaction to capture new card/bank
router.post("/:id/plans/:planId/update-payment-method", async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer || String(customer.userId) !== req.userId) return res.status(403).json({ error: "Unauthorized" });

    const plan = await RepaymentPlan.findOne({ _id: req.params.planId, customerId: customer._id });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    // Prevent duplicate update-method attempts in flight
    const existingPending = await PaymentAttempt.findOne({ planId: plan._id, status: "pending", attemptNumber: 0 });
    if (existingPending) return res.status(409).json({ error: "A payment method update is already in progress." });

    const email = customer.email ?? "customer@repaystream.local";
    const reference = `rs_updmethod_${plan._id}_${Date.now()}`;
    const amountKobo = 10000; // ₦100 — smallest meaningful authorization charge

    await PaymentAttempt.create({
      planId: plan._id, attemptNumber: 0, amount: 100,
      status: "pending", provider: "paystack", externalRef: reference, idempotencyKey: reference,
    });

    const result = await initializePaystackTransaction({
      email, amount: amountKobo, reference,
      callbackUrl: `${APP_URL()}/plan/${plan._id}?trxref=${reference}&updateMethod=1`,
    });

    res.json({ authorizationUrl: result.authorization_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not start payment method update" });
  }
});

export default router;
