import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Business } from "../models/Business.js";
import { Customer } from "../models/Customer.js";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
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
    plans: plans.map((p) => ({
      id: p._id,
      total_amount: p.totalAmount,
      status: p.status,
      customer_id: p.customerId,
      payment_method: p.paymentMethod,
      schedule_json: p.scheduleJson,
      created_at: p.createdAt,
      customers: custMap.get(p.customerId.toString())
        ? { phone: custMap.get(p.customerId.toString())!.phone, email: custMap.get(p.customerId.toString())!.email }
        : null,
    })),
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
        total_amount: plan.totalAmount,
        status: plan.status,
        payment_method: plan.paymentMethod,
        schedule_json: plan.scheduleJson,
        created_at: plan.createdAt,
        customer: customer
          ? { id: customer._id, phone: customer.phone, email: customer.email }
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

    const { customerPhone, customerEmail, totalAmount, paymentMethod, schedule } = req.body;
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

    // Idempotent replay check
    if (idempotencyKey) {
      const existing = await RepaymentPlan.findOne({ businessId: biz._id, idempotencyKey });
      if (existing) {
        return res.json({
          plan: { id: existing._id },
          idempotentReplay: true,
        });
      }
    }

    // Find or create customer
    let customer = await Customer.findOne({ businessId: biz._id, email: customerEmail.trim().toLowerCase() });
    if (!customer) {
      customer = await Customer.create({
        phone: customerPhone.trim(),
        email: customerEmail.trim().toLowerCase(),
        businessId: biz._id,
      });
    }

    const plan = await RepaymentPlan.create({
      businessId: biz._id,
      customerId: customer._id,
      totalAmount: parseFloat(totalAmount),
      scheduleJson: schedule,
      paymentMethod,
      idempotencyKey: idempotencyKey || undefined,
    });

    res.status(201).json({ plan: { id: plan._id }, idempotentReplay: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create plan" });
  }
});

export default router;
