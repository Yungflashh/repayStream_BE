import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Customer } from "../models/Customer.js";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { User } from "../models/User.js";
import { AuditLog } from "../models/AuditLog.js";

const router = Router();
router.use(requireAuth);

router.post("/claim", async (req, res) => {
  try {
    const { customerId } = req.body as { customerId?: string };
    if (!customerId) return res.status(400).json({ error: "customerId required" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    const customer = await Customer.findById(customerId);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    if (customer.email?.toLowerCase() !== user.email.toLowerCase()) {
      return res.status(403).json({ error: "Email does not match" });
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

    // Fetch all payment attempts for the customer's plans
    const planIds = plans.map((p) => p._id);
    const allAttempts = await PaymentAttempt.find({ planId: { $in: planIds } })
      .sort({ createdAt: 1 })
      .lean();

    const attemptsByPlan = new Map<string, typeof allAttempts>();
    for (const a of allAttempts) {
      const key = a.planId.toString();
      if (!attemptsByPlan.has(key)) attemptsByPlan.set(key, []);
      attemptsByPlan.get(key)!.push(a);
    }

    res.json({
      customer: { id: customer._id, phone: customer.phone, email: customer.email },
      plans: plans.map((p) => ({
        id: p._id,
        total_amount: p.totalAmount,
        status: p.status,
        payment_method: p.paymentMethod,
        schedule_json: p.scheduleJson,
        created_at: p.createdAt,
        attempts: (attemptsByPlan.get(p._id.toString()) ?? []).map((a) => ({
          id: a._id,
          attempt_number: a.attemptNumber,
          amount: a.amount,
          status: a.status,
          provider: a.provider,
          failure_reason: a.failureReason,
          created_at: a.createdAt,
        })),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load portal" });
  }
});

export default router;
