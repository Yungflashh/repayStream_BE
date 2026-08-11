import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { Customer } from "../models/Customer.js";
import { AuditLog } from "../models/AuditLog.js";
import { chargeAuthorization } from "./paystack.js";
import { sendFailedAttemptReminder, sendPlanCompletedNotification } from "../services/reminder.js";
import { parseSchedule, computeNextInstallment } from "./utils/schedule.js";


/**
 * Check all active plans for due installments and initiate charges.
 * Runs on a timer — safe to call repeatedly.
 */
export async function processScheduledPayments() {
  const today = new Date().toISOString().slice(0, 10);

  const activePlans = await RepaymentPlan.find({ status: "active" }).lean();

  for (const plan of activePlans) {
    try {
      const schedule = parseSchedule(plan);

      // Find successful payments for this plan
      const successfulAttempts = await PaymentAttempt.find({
        planId: plan._id,
        status: "success",
      }).lean();

      const totalPaidAmount = successfulAttempts.reduce((sum, a) => sum + a.amount, 0);

      // Compute next unpaid installment + how much of it is still owed
      // (partial offline payments already reduce dueAmount).
      const next = computeNextInstallment(schedule, totalPaidAmount);

      // Mark complete only when total collected covers the full plan
      if (next.isComplete || totalPaidAmount >= plan.totalAmount) {
        await RepaymentPlan.findByIdAndUpdate(plan._id, { status: "completed" });
        await AuditLog.create({
          actor: "system:scheduler",
          action: "plan_completed",
          entityType: "repayment_plan",
          entityId: plan._id,
          payload: { totalInstallments: schedule.length, totalPaidAmount },
        });
        void sendPlanCompletedNotification(plan._id).catch((err: unknown) => {
          console.error("[scheduler] Failed to send completion notification:", err);
        });
        continue;
      }

      // Get next installment
      const nextInstallment = next.row;
      if (!nextInstallment || !nextInstallment.due_date) continue;

      // Only charge if due today or overdue
      if (nextInstallment.due_date > today) continue;

      // The remaining owed on this installment — critical: without this, a
      // partial offline payment would still get charged the full installment.
      const chargeAmount = next.dueAmount;
      if (chargeAmount <= 0) continue;

      // Skip if a fresh pending attempt already exists (prevents double-charging while
      // Paystack processes asynchronously). Stale pending attempts older than 6 hours
      // are ignored so a missed webhook never permanently blocks a plan.
      const recentPending = await PaymentAttempt.findOne({
        planId: plan._id,
        status: "pending",
        createdAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
      });
      if (recentPending) continue;

      // Check failed attempts for this installment (max 3 retries).
      // Match on the remaining (chargeAmount) since that's what we'd try again.
      const failedForInstallment = await PaymentAttempt.countDocuments({
        planId: plan._id,
        status: "failed",
        amount: chargeAmount,
      });
      if (failedForInstallment >= 3) {
        // Max retries exceeded — mark defaulted
        await RepaymentPlan.findByIdAndUpdate(plan._id, { status: "defaulted" });
        await AuditLog.create({
          actor: "system:scheduler",
          action: "plan_defaulted",
          entityType: "repayment_plan",
          entityId: plan._id,
          payload: { installmentIndex: next.index, failedAttempts: failedForInstallment },
        });
        continue;
      }

      const authCode = (plan as unknown as { authorizationCode?: string }).authorizationCode;
      if (!authCode) {
        console.warn(`[scheduler] Plan ${plan._id} has no authorization code — mandate not yet captured, skipping`);
        await AuditLog.create({
          actor: "system:scheduler",
          action: "installment_skipped",
          entityType: "repayment_plan",
          entityId: plan._id,
          payload: { reason: "no_authorization_code", installmentIndex: next.index + 1 },
        });
        continue;
      }

      const totalAttempts = await PaymentAttempt.countDocuments({ planId: plan._id });
      const customer = await Customer.findById(plan.customerId);
      const email = customer?.email ?? "customer@repaystream.local";
      const reference = `rs_${plan._id}_inst${next.index + 1}_${Date.now()}`;
      const amountKobo = Math.max(Math.round(chargeAmount * 100), 200);

      const attempt = await PaymentAttempt.create({
        planId: plan._id,
        attemptNumber: totalAttempts + 1,
        amount: chargeAmount,
        status: "pending",
        provider: "paystack",
        externalRef: reference,
        idempotencyKey: reference,
      });

      // Charge the stored authorization directly — no customer interaction needed
      const result = await chargeAuthorization({ authorizationCode: authCode, email, amount: amountKobo, reference });

      if (result.status === "success") {
        attempt.status = "success";
        await attempt.save();
      } else if (result.status === "failed") {
        attempt.status = "failed";
        attempt.failureReason = result.gateway_response || "gateway_declined";
        await attempt.save();
        void sendFailedAttemptReminder(attempt._id);
      }
      // "pending" — leave as pending; webhook will resolve it asynchronously

      await AuditLog.create({
        actor: "system:scheduler",
        action: "installment_charged",
        entityType: "repayment_plan",
        entityId: plan._id,
        payload: {
          installmentIndex: next.index + 1,
          amount: chargeAmount,
          fullInstallmentAmount: nextInstallment.amount,
          alreadyPaidOffline: next.alreadyPaid,
          provider: "paystack",
          reference,
          chargeStatus: result.status,
        },
      });

      console.log(`[scheduler] Charged installment ${next.index + 1} for plan ${plan._id} — ₦${chargeAmount} — ${result.status}`);
    } catch (err) {
      console.error(`[scheduler] Error processing plan ${plan._id}:`, err);
    }
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startScheduler(intervalMs = 60 * 60 * 1000) {
  // Run once immediately, then on interval (default: every hour)
  console.log(`[scheduler] Starting payment scheduler (interval: ${intervalMs / 1000}s)`);
  void processScheduledPayments();
  intervalHandle = setInterval(() => void processScheduledPayments(), intervalMs);
}

export function stopScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
