import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Business } from "../models/Business.js";
import { Customer } from "../models/Customer.js";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { AuditLog } from "../models/AuditLog.js";
import { validatePlanBody } from "../lib/validators/plan.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const biz = await Business.findOne({ userId: req.userId });
  if (!biz) return res.json({ plans: [] });

  const plans = await RepaymentPlan.find({ businessId: biz._id })
    .sort({ createdAt: -1 })
    .lean();

  const customerIds = [...new Set(plans.map((p) => p.customerId.toString()))];
  const customers = await Customer.find({ _id: { $in: customerIds } }).lean();
  const custMap = new Map(customers.map((c) => [c._id.toString(), c]));

  res.json({
    plans: plans.map((p) => {
      const cust = custMap.get(p.customerId.toString());
      return {
        id: p._id,
        plan_name: (p as { planName?: string }).planName ?? null,
        group: (p as { group?: string }).group ?? null,
        total_amount: p.totalAmount,
        status: p.status,
        customer_id: p.customerId,
        payment_method: p.paymentMethod,
        schedule_json: p.scheduleJson,
        created_at: p.createdAt,
        customers: cust
          ? { name: (cust as { name?: string }).name ?? null, phone: cust.phone, email: cust.email }
          : null,
      };
    }),
  });
});

// Plan detail with installment-level payment status
router.get("/:id", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.status(403).json({ error: "No business" });

    const plan = await RepaymentPlan.findOne({ _id: req.params.id, businessId: biz._id }).lean();
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const customer = await Customer.findById(plan.customerId).lean();
    const attempts = await PaymentAttempt.find({ planId: plan._id }).sort({ createdAt: 1 }).lean();

    res.json({
      plan: {
        id: plan._id,
        plan_name: (plan as { planName?: string }).planName ?? null,
        total_amount: plan.totalAmount,
        status: plan.status,
        payment_method: plan.paymentMethod,
        fee_strategy: (plan as { feeStrategy?: string }).feeStrategy ?? "absorb",
        schedule_json: plan.scheduleJson,
        created_at: plan.createdAt,
        notes: ((plan as { notes?: { text: string; createdAt: Date }[] }).notes ?? []).map((n) => ({
          text: n.text,
          created_at: n.createdAt,
        })),
        customer: customer
          ? { id: customer._id, name: (customer as { name?: string }).name ?? null, phone: customer.phone, email: customer.email }
          : null,
      },
      attempts: attempts.map((a) => ({
        id: a._id,
        attempt_number: a.attemptNumber,
        amount: a.amount,
        status: a.status,
        provider: a.provider,
        failure_reason: a.failureReason,
        external_ref: a.externalRef,
        created_at: a.createdAt,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load plan" });
  }
});

router.post("/", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.status(400).json({ error: "Create a business first" });

    const error = validatePlanBody(req.body as Record<string, unknown>);
    if (error) return res.status(400).json({ error });

    const { customerName, customerPhone, customerEmail, totalAmount, paymentMethod, schedule, planName, group, feeStrategy } = req.body;
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

    // Idempotent replay check
    if (idempotencyKey) {
      const existing = await RepaymentPlan.findOne({ businessId: biz._id, idempotencyKey });
      if (existing) {
        return res.json({
          plan: { id: existing._id, customerId: existing.customerId.toString() },
          idempotentReplay: true,
        });
      }
    }

    // Find or create customer
    let customer = await Customer.findOne({ businessId: biz._id, email: customerEmail.trim().toLowerCase() });
    if (!customer) {
      customer = await Customer.create({
        name: customerName.trim(),
        phone: customerPhone.trim(),
        email: customerEmail.trim().toLowerCase(),
        businessId: biz._id,
      });
    } else if (customerName?.trim()) {
      customer.set("name", customerName.trim());
      await customer.save();
    }

    const plan = await RepaymentPlan.create({
      businessId: biz._id,
      customerId: customer._id,
      planName: planName?.trim() || undefined,
      group: (group as string | undefined)?.trim() || undefined,
      totalAmount: parseFloat(totalAmount),
      scheduleJson: schedule,
      paymentMethod,
      feeStrategy: feeStrategy === "pass_to_customer" ? "pass_to_customer" : "absorb",
      idempotencyKey: idempotencyKey || undefined,
    });

    res.status(201).json({ plan: { id: plan._id, customerId: customer._id.toString() }, idempotentReplay: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create plan" });
  }
});

// Pause / resume / cancel a plan
router.patch("/:id/status", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.status(403).json({ error: "No business" });

    const { action } = req.body as { action?: string };
    if (!action || !["pause", "resume", "cancel"].includes(action)) {
      return res.status(400).json({ error: "action must be one of: pause, resume, cancel" });
    }

    const plan = await RepaymentPlan.findOne({ _id: req.params.id, businessId: biz._id });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const prev = plan.status;
    let next: string;
    if (action === "pause") {
      if (plan.status !== "active") return res.status(400).json({ error: "Only active plans can be paused" });
      next = "paused";
    } else if (action === "resume") {
      if (plan.status !== "paused") return res.status(400).json({ error: "Only paused plans can be resumed" });
      next = "active";
    } else {
      if (["completed", "cancelled"].includes(plan.status)) {
        return res.status(400).json({ error: "Plan is already completed or cancelled" });
      }
      next = "cancelled";
    }

    plan.status = next;
    await plan.save();

    await AuditLog.create({
      actor: `business:${biz._id}`,
      action: `plan_${action}d`,
      entityType: "repayment_plan",
      entityId: plan._id,
      payload: { previousStatus: prev, newStatus: next },
    });

    res.json({ ok: true, status: next });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update plan status" });
  }
});

// Add a business note to a plan
router.post("/:id/notes", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.status(403).json({ error: "No business" });

    const { text } = req.body as { text?: string };
    if (!text?.trim()) return res.status(400).json({ error: "Note text required" });

    const plan = await RepaymentPlan.findOne({ _id: req.params.id, businessId: biz._id });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const note = { text: text.trim(), createdAt: new Date() };
    (plan as any).notes.push(note);
    await plan.save();

    res.json({ ok: true, note: { text: note.text, created_at: note.createdAt } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add note" });
  }
});

export default router;
