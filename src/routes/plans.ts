import { Router } from "express";
import { randomBytes } from "crypto";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { Business } from "../models/Business.js";
import { Customer } from "../models/Customer.js";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { AuditLog } from "../models/AuditLog.js";
import { validatePlanBody } from "../lib/validators/plan.js";
import { sendEmail } from "../services/notifications/email.js";

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

    // Wrap customer upsert + plan create in a transaction to prevent partial writes
    const session = await mongoose.startSession();
    let planId: string;
    let customerId: string;

    try {
      await session.withTransaction(async () => {
        let customer = await Customer.findOne(
          { businessId: biz._id, email: customerEmail.trim().toLowerCase() },
          null,
          { session }
        );
        if (!customer) {
          [customer] = await Customer.create(
            [
              {
                name: customerName.trim(),
                phone: customerPhone.trim(),
                email: customerEmail.trim().toLowerCase(),
                businessId: biz._id,
              },
            ],
            { session }
          );
        } else if (customerName?.trim()) {
          customer.set("name", customerName.trim());
          await customer.save({ session });
        }

        const [plan] = await RepaymentPlan.create(
          [
            {
              businessId: biz._id,
              customerId: customer._id,
              planName: planName?.trim() || undefined,
              group: (group as string | undefined)?.trim() || undefined,
              totalAmount: parseFloat(totalAmount),
              scheduleJson: schedule,
              paymentMethod,
              feeStrategy: feeStrategy === "pass_to_customer" ? "pass_to_customer" : "absorb",
              idempotencyKey: idempotencyKey || undefined,
            },
          ],
          { session }
        );

        planId = plan._id.toString();
        customerId = customer._id.toString();
      });
    } finally {
      await session.endSession();
    }

    // Fire-and-forget: send setup email if customer has no User account yet
    void (async () => {
      try {
        const customer = await Customer.findById(customerId!);
        if (!customer || !customer.email || customer.userId) return; // already has account
        const token = randomBytes(32).toString("hex");
        const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        customer.setupToken = token;
        customer.setupTokenExpiry = expiry;
        await customer.save();

        const appUrl = process.env.APP_URL ?? "http://localhost:5173";
        const setupUrl = `${appUrl}/set-password?token=${token}`;
        await sendEmail({
          to: customer.email,
          subject: `${biz.name} has created a repayment plan for you`,
          html: `
            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#0f172a">
              <div style="margin-bottom:28px">
                <span style="font-size:18px;font-weight:700;letter-spacing:-0.5px">RepayStream</span>
              </div>
              <h1 style="font-size:22px;font-weight:700;margin:0 0 8px">You have a new repayment plan</h1>
              <p style="color:#64748b;font-size:15px;margin:0 0 24px">
                <strong>${biz.name}</strong> has set up a repayment schedule for you.
                Set a password to access your portal and view all your plan details.
              </p>
              <a href="${setupUrl}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:600;font-size:15px;margin-bottom:24px">
                Set my password →
              </a>
              <p style="color:#94a3b8;font-size:13px;margin:0 0 8px">This link expires in 7 days.</p>
              <p style="color:#94a3b8;font-size:13px;margin:0">
                If you weren't expecting this, you can ignore this email.
              </p>
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0">
              <p style="color:#cbd5e1;font-size:12px;margin:0">RepayStream · Secured by Paystack</p>
            </div>
          `,
        });
      } catch (e) {
        console.error("[setup-email]", e);
      }
    })();

    res.status(201).json({ plan: { id: planId!, customerId: customerId! }, idempotentReplay: false });
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
