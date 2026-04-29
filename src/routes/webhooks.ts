import { Router } from "express";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { AuditLog } from "../models/AuditLog.js";
import { verifyPaystackSignature } from "../lib/webhooks/paystack-verify.js";
import { nextRetryDate } from "../lib/retry-policy.js";

const router = Router();

router.post("/paystack", async (req, res) => {
  try {
    const sig = req.headers["x-paystack-signature"] as string | undefined;
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!sig || !rawBody || !verifyPaystackSignature(rawBody, sig)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = req.body as { event?: string; data?: { reference?: string; status?: string; gateway_response?: string } };
    if (event.event !== "charge.success" && event.event !== "charge.failed") {
      return res.sendStatus(200);
    }

    const ref = event.data?.reference;
    if (!ref) return res.sendStatus(200);

    const attempt = await PaymentAttempt.findOne({ externalRef: ref });
    if (!attempt) return res.sendStatus(200);

    const newStatus = event.event === "charge.success" ? "success" : "failed";
    const failureReason = newStatus === "failed"
      ? event.data?.gateway_response?.toLowerCase().includes("insufficient") ? "insufficient_funds" : "gateway_declined"
      : null;

    attempt.status = newStatus;
    attempt.failureReason = failureReason;
    await attempt.save();

    // Activate plan on successful payment
    if (newStatus === "success") {
      await RepaymentPlan.findByIdAndUpdate(attempt.planId, { status: "active" });
      await AuditLog.create({
        actor: "webhook:paystack",
        action: "plan_activated",
        entityType: "repayment_plan",
        entityId: attempt.planId,
        payload: { previousStatus: "pending_mandate", newStatus: "active", paymentRef: ref },
      });
    }

    await AuditLog.create({
      actor: "webhook:paystack",
      action: "payment_attempt_update",
      entityType: "payment_attempt",
      entityId: attempt._id,
      payload: { status: newStatus, failureReason },
    });

    if (newStatus === "failed") {
      const retryDate = nextRetryDate(attempt.createdAt, attempt.attemptNumber, failureReason);
      if (retryDate) {
        await AuditLog.create({
          actor: "system:retry",
          action: "retry_scheduled",
          entityType: "payment_attempt",
          entityId: attempt._id,
          payload: { nextAttempt: attempt.attemptNumber + 1, retryDate },
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

export default router;
