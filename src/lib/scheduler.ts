import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { Customer } from "../models/Customer.js";
import { AuditLog } from "../models/AuditLog.js";
import { initializePaystackTransaction } from "./paystack.js";

const APP_URL = () => process.env.PUBLIC_APP_URL ?? "http://localhost:5173";

type ScheduleRow = { amount: number; due_date: string };

function parseSchedule(plan: { scheduleJson: unknown; totalAmount: number }): ScheduleRow[] {
  const sj = plan.scheduleJson;

  if (Array.isArray(sj) && sj.length > 0) {
    return sj
      .filter((r: any) => typeof r.amount === "number" && typeof r.due_date === "string")
      .map((r: any) => ({ amount: r.amount, due_date: r.due_date }));
  }

  if (sj && typeof sj === "object" && !Array.isArray(sj)) {
    const obj = sj as { type?: string; installments?: any[]; dueDate?: string };
    if (obj.type === "installments" && Array.isArray(obj.installments)) {
      return obj.installments.map((x: any) => ({
        amount: parseFloat(String(x.amount ?? 0)),
        due_date: String(x.dueDate ?? ""),
      }));
    }
    if (obj.type === "lump_sum" && obj.dueDate) {
      return [{ amount: plan.totalAmount, due_date: obj.dueDate }];
    }
  }

  return [{ amount: plan.totalAmount, due_date: "" }];
}

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

      const paidCount = successfulAttempts.length;

      // All installments paid — mark complete
      if (paidCount >= schedule.length) {
        await RepaymentPlan.findByIdAndUpdate(plan._id, { status: "completed" });
        await AuditLog.create({
          actor: "system:scheduler",
          action: "plan_completed",
          entityType: "repayment_plan",
          entityId: plan._id,
          payload: { totalInstallments: schedule.length, paidCount },
        });
        continue;
      }

      // Get next installment
      const nextInstallment = schedule[paidCount];
      if (!nextInstallment || !nextInstallment.due_date) continue;

      // Only charge if due today or overdue
      if (nextInstallment.due_date > today) continue;

      // Check if there's already a pending attempt for this installment
      const pendingAttempt = await PaymentAttempt.findOne({
        planId: plan._id,
        status: "pending",
        amount: nextInstallment.amount,
      });
      if (pendingAttempt) continue;

      // Check failed attempts for this installment (max 3 retries)
      const failedForInstallment = await PaymentAttempt.countDocuments({
        planId: plan._id,
        status: "failed",
        amount: nextInstallment.amount,
      });
      if (failedForInstallment >= 3) {
        // Max retries exceeded — mark defaulted
        await RepaymentPlan.findByIdAndUpdate(plan._id, { status: "defaulted" });
        await AuditLog.create({
          actor: "system:scheduler",
          action: "plan_defaulted",
          entityType: "repayment_plan",
          entityId: plan._id,
          payload: { installmentIndex: paidCount, failedAttempts: failedForInstallment },
        });
        continue;
      }

      const totalAttempts = await PaymentAttempt.countDocuments({ planId: plan._id });
      const customer = await Customer.findById(plan.customerId);
      const email = customer?.email ?? "customer@repaystream.local";
      const amount = nextInstallment.amount;

      if (plan.paymentMethod === "card") {
        const reference = `rs_${plan._id}_inst${paidCount + 1}_${Date.now()}`;
        const amountKobo = Math.max(Math.round(amount * 100), 200);

        await PaymentAttempt.create({
          planId: plan._id,
          attemptNumber: totalAttempts + 1,
          amount,
          status: "pending",
          provider: "paystack",
          externalRef: reference,
          idempotencyKey: reference,
        });

        // Note: For recurring charges, Paystack requires the authorization code
        // from the first successful charge. For now, we initialize a new transaction
        // that the customer will need to complete via the plan link.
        await initializePaystackTransaction({
          email,
          amount: amountKobo,
          reference,
          callbackUrl: `${APP_URL()}/plan/${plan._id}?trxref=${reference}`,
        });

        await AuditLog.create({
          actor: "system:scheduler",
          action: "installment_initiated",
          entityType: "repayment_plan",
          entityId: plan._id,
          payload: { installmentIndex: paidCount + 1, amount, provider: "paystack", reference },
        });
      } else {
        const reference = `rs_${plan._id}_inst${paidCount + 1}_${Date.now()}`;
        const amountKobo = Math.max(Math.round(amount * 100), 200);

        await PaymentAttempt.create({
          planId: plan._id,
          attemptNumber: totalAttempts + 1,
          amount,
          status: "pending",
          provider: "paystack",
          externalRef: reference,
          idempotencyKey: reference,
        });

        await initializePaystackTransaction({
          email,
          amount: amountKobo,
          reference,
          callbackUrl: `${APP_URL()}/plan/${plan._id}?trxref=${reference}`,
        });

        await AuditLog.create({
          actor: "system:scheduler",
          action: "installment_initiated",
          entityType: "repayment_plan",
          entityId: plan._id,
          payload: { installmentIndex: paidCount + 1, amount, provider: "paystack", reference },
        });
      }

      console.log(`[scheduler] Initiated installment ${paidCount + 1} for plan ${plan._id} — ₦${amount}`);
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
