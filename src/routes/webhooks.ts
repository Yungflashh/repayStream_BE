import { Router } from "express";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { AuditLog } from "../models/AuditLog.js";
import { verifyPaystackSignature } from "../lib/webhooks/paystack-verify.js";
import { nextRetryDate } from "../lib/retry-policy.js";
import { sendFailedAttemptReminder, sendPlanCompletedNotification } from "../services/reminder.js";

const router = Router();

function scheduleLength(plan: { scheduleJson: unknown; totalAmount: number }): number {
  const sj = plan.scheduleJson;
  if (Array.isArray(sj)) return sj.length || 1;
  if (sj && typeof sj === "object" && !Array.isArray(sj)) {
    const obj = sj as { type?: string; installments?: unknown[] };
    if (obj.type === "installments" && Array.isArray(obj.installments)) return obj.installments.length;
  }
  return 1;
}

router.post("/paystack", async (req, res) => {
  try {
    const sig = req.headers["x-paystack-signature"] as string | undefined;
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!sig || !rawBody || !verifyPaystackSignature(rawBody, sig)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = req.body as {
      event?: string;
      data?: {
        reference?: string;
        status?: string;
        amount?: number;
        gateway_response?: string;
        authorization?: { authorization_code?: string; reusable?: boolean };
      };
    };
    if (event.event !== "charge.success" && event.event !== "charge.failed") {
      return res.sendStatus(200);
    }

    const ref = event.data?.reference;
    if (!ref) return res.sendStatus(200);

    const attempt = await PaymentAttempt.findOne({ externalRef: ref });
    if (!attempt) return res.sendStatus(200);

    // Idempotency: skip if this attempt is already resolved
    if (attempt.status !== "pending") return res.sendStatus(200);

    // Validate that the webhook amount matches the attempt amount (prevents amount tampering)
    const webhookAmountKobo = event.data?.amount;
    if (webhookAmountKobo !== undefined) {
      const expectedKobo = Math.round(attempt.amount * 100);
      if (Math.abs(webhookAmountKobo - expectedKobo) > 1) {
        console.error(
          `[webhook] Amount mismatch for ref ${ref}: expected ${expectedKobo} kobo, got ${webhookAmountKobo} kobo`
        );
        return res.sendStatus(200);
      }
    }

    const newStatus = event.event === "charge.success" ? "success" : "failed";
    const failureReason =
      newStatus === "failed"
        ? event.data?.gateway_response?.toLowerCase().includes("insufficient")
          ? "insufficient_funds"
          : "gateway_declined"
        : null;

    attempt.status = newStatus;
    attempt.failureReason = failureReason;
    await attempt.save();

    if (newStatus === "success") {
      const plan = await RepaymentPlan.findById(attempt.planId);
      if (plan) {
        const wasMandate = plan.status === "pending_mandate";
        if (wasMandate) plan.status = "active";

        // Store authorization code unless Paystack explicitly marks it non-reusable
        const auth = event.data?.authorization;
        if (auth?.authorization_code && auth.reusable !== false) {
          const existing = (plan as unknown as { authorizationCode?: string }).authorizationCode;
          if (!existing) {
            (plan as unknown as { authorizationCode: string }).authorizationCode = auth.authorization_code;
          }
        }

        await plan.save();

        if (wasMandate) {
          await AuditLog.create({
            actor: "webhook:paystack",
            action: "plan_activated",
            entityType: "repayment_plan",
            entityId: plan._id,
            payload: { previousStatus: "pending_mandate", newStatus: "active", paymentRef: ref },
          });
        }

        // Auto-complete plan when all installments are paid
        if (plan.status === "active") {
          const totalInstallments = scheduleLength(plan);
          const successCount = await PaymentAttempt.countDocuments({
            planId: plan._id,
            status: "success",
          });
          if (successCount >= totalInstallments) {
            await RepaymentPlan.findByIdAndUpdate(plan._id, { status: "completed" });
            await AuditLog.create({
              actor: "webhook:paystack",
              action: "plan_completed",
              entityType: "repayment_plan",
              entityId: plan._id,
              payload: { totalInstallments, paidCount: successCount, paymentRef: ref },
            });
            sendPlanCompletedNotification(plan._id).catch((err: unknown) => {
              console.error("[webhook] Failed to send completion notification:", err);
            });
          }
        }
      }
    }

    await AuditLog.create({
      actor: "webhook:paystack",
      action: "payment_attempt_update",
      entityType: "payment_attempt",
      entityId: attempt._id,
      payload: { status: newStatus, failureReason },
    });

    if (newStatus === "failed") {
      sendFailedAttemptReminder(attempt._id).catch((err: unknown) => {
        console.error("[webhook] Failed to send reminder:", err);
      });

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
