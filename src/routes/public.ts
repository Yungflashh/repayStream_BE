import { Router } from "express";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { Customer } from "../models/Customer.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { AuditLog } from "../models/AuditLog.js";
import { verifyPaystackTransaction } from "../lib/paystack.js";

const router = Router();

router.get("/plans/:id", async (req, res) => {
  try {
    const plan = await RepaymentPlan.findById(req.params.id).lean();
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const customer = await Customer.findById(plan.customerId).lean();

    res.json({
      plan: {
        id: plan._id,
        total_amount: plan.totalAmount,
        status: plan.status,
        schedule_json: plan.scheduleJson,
        payment_method: plan.paymentMethod,
        customers: customer
          ? { phone: customer.phone, email: customer.email }
          : null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load plan" });
  }
});

// Verify payment status after redirect from payment gateway
router.get("/plans/:id/verify", async (req, res) => {
  try {
    const plan = await RepaymentPlan.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const ref = (req.query.trxref ?? req.query.tx_ref) as string | undefined;
    if (!ref) {
      return res.json({ planStatus: plan.status, paymentStatus: "no_ref" });
    }

    const attempt = await PaymentAttempt.findOne({ externalRef: ref });
    if (!attempt) {
      return res.json({ planStatus: plan.status, paymentStatus: "not_found" });
    }

    // If already resolved locally (e.g. webhook arrived first), return immediately
    if (attempt.status === "success" || attempt.status === "failed") {
      return res.json({ planStatus: plan.status, paymentStatus: attempt.status });
    }

    // Still pending — actively verify with the payment provider
    if (attempt.provider === "paystack") {
      const verification = await verifyPaystackTransaction(ref);

      if (verification.status === "success") {
        attempt.status = "success";
        await attempt.save();

        // Activate the plan
        if (plan.status === "pending_mandate") {
          plan.status = "active";
          await plan.save();
          await AuditLog.create({
            actor: "verify:paystack",
            action: "plan_activated",
            entityType: "repayment_plan",
            entityId: plan._id,
            payload: { previousStatus: "pending_mandate", newStatus: "active", paymentRef: ref },
          });
        }

        await AuditLog.create({
          actor: "verify:paystack",
          action: "payment_attempt_update",
          entityType: "payment_attempt",
          entityId: attempt._id,
          payload: { status: "success" },
        });

        return res.json({ planStatus: plan.status, paymentStatus: "success" });
      }

      if (verification.status === "failed" || verification.status === "abandoned") {
        attempt.status = "failed";
        attempt.failureReason = verification.gateway_response || "gateway_declined";
        await attempt.save();
        return res.json({ planStatus: plan.status, paymentStatus: "failed" });
      }

      // Still pending at Paystack
      return res.json({ planStatus: plan.status, paymentStatus: "pending" });
    }

    res.json({ planStatus: plan.status, paymentStatus: attempt.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Verification failed" });
  }
});

export default router;
