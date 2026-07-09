import { Types } from "mongoose";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { Customer } from "../models/Customer.js";
import { Business } from "../models/Business.js";
import { dispatchReminder } from "./notifications/dispatcher.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function fmt(amount: number) {
  return `₦${amount.toLocaleString("en-NG")}`;
}

function portalUrl(customerId: string) {
  const base = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";
  return `${base}/portal/${customerId}`;
}

// ─── Email templates ─────────────────────────────────────────────────────────

function emailWrapper(bodyHtml: string) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:100%">
<tr><td style="background:#0f172a;padding:20px 32px">
  <span style="color:#fff;font-size:18px;font-weight:700">RepayStream</span>
</td></tr>
<tr><td style="padding:32px">${bodyHtml}</td></tr>
<tr><td style="background:#f4f4f5;padding:16px 32px;font-size:12px;color:#6b7280;text-align:center">
  You received this because a repayment plan involves your account.<br>
  RepayStream &mdash; Automated Repayment Management
</td></tr>
</table></td></tr></table>
</body></html>`;
}

function preDueEmailHtml(customerName: string, businessName: string, amount: number, dueDate: string, customerId: string) {
  return emailWrapper(`
<p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#0f172a">Payment reminder</p>
<p style="margin:0 0 20px;color:#374151">Hi ${customerName || "there"},</p>
<p style="margin:0 0 20px;color:#374151">
  A repayment of <strong>${fmt(amount)}</strong> to <strong>${businessName}</strong> is due on <strong>${dueDate}</strong>.
  Please ensure your card has sufficient funds so the automatic deduction goes through smoothly.
</p>
<a href="${portalUrl(customerId)}" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View your plan</a>
<p style="margin:24px 0 0;font-size:13px;color:#6b7280">If you have questions, contact ${businessName} directly.</p>
`);
}

function failedAttemptEmailHtml(customerName: string, businessName: string, amount: number, customerId: string) {
  return emailWrapper(`
<p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#dc2626">Payment unsuccessful</p>
<p style="margin:0 0 20px;color:#374151">Hi ${customerName || "there"},</p>
<p style="margin:0 0 20px;color:#374151">
  A debit of <strong>${fmt(amount)}</strong> for your repayment plan with <strong>${businessName}</strong> was unsuccessful.
  Please ensure your card has sufficient funds — we'll retry automatically.
</p>
<a href="${portalUrl(customerId)}" style="display:inline-block;background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Resolve now</a>
<p style="margin:24px 0 0;font-size:13px;color:#6b7280">You can also make a manual payment or update your payment method from your portal.</p>
`);
}

function overdueEmailHtml(customerName: string, businessName: string, amount: number, daysOverdue: number, customerId: string) {
  return emailWrapper(`
<p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#dc2626">Overdue payment — action required</p>
<p style="margin:0 0 20px;color:#374151">Hi ${customerName || "there"},</p>
<p style="margin:0 0 20px;color:#374151">
  Your repayment of <strong>${fmt(amount)}</strong> to <strong>${businessName}</strong> is now
  <strong>${daysOverdue} day${daysOverdue !== 1 ? "s" : ""} overdue</strong>.
  Please log in and settle this payment to avoid further action.
</p>
<a href="${portalUrl(customerId)}" style="display:inline-block;background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Pay now</a>
`);
}

function planCompletedEmailHtml(customerName: string, businessName: string, totalAmount: number, customerId: string) {
  return emailWrapper(`
<p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#16a34a">You're all paid up! 🎉</p>
<p style="margin:0 0 20px;color:#374151">Hi ${customerName || "there"},</p>
<p style="margin:0 0 20px;color:#374151">
  Your repayment plan with <strong>${businessName}</strong> is now <strong>fully settled</strong>.
  A total of <strong>${fmt(totalAmount)}</strong> has been paid — you have no remaining balance.
</p>
<p style="margin:0 0 20px;color:#374151">Thank you for keeping up with your payments. You can view your repayment history any time from your portal.</p>
<a href="${portalUrl(customerId)}" style="display:inline-block;background:#16a34a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View your portal</a>
`);
}

// ─── Public trigger functions ─────────────────────────────────────────────────

/**
 * Called immediately after a PaymentAttempt fails (from scheduler + webhook handler).
 * Fire-and-forget: callers should use `void sendFailedAttemptReminder(...)`.
 */
export async function sendFailedAttemptReminder(attemptId: string | Types.ObjectId): Promise<void> {
  try {
    const attempt = await PaymentAttempt.findById(attemptId).lean();
    if (!attempt) return;

    const plan = await RepaymentPlan.findById(attempt.planId).lean();
    if (!plan) return;

    const [customer, business] = await Promise.all([
      Customer.findById(plan.customerId).lean(),
      Business.findById(plan.businessId).lean(),
    ]);
    if (!customer) return;

    const customerName = customer.name ?? "";
    const businessName = business?.name ?? "the business";
    const amount = attempt.amount;
    const customerId = String(customer._id);

    const smsMessage =
      `Hi ${customerName || "there"}, your debit of ${fmt(amount)} to ${businessName} failed. ` +
      `Please fund your card — we'll retry automatically. Portal: ${portalUrl(customerId)}`;

    await dispatchReminder({
      planId: String(plan._id),
      customerId,
      reminderKey: `failed_attempt:${String(attempt._id)}`,
      type: "failed_attempt",
      phone: customer.phone,
      email: customer.email ?? undefined,
      smsMessage,
      emailSubject: `Payment unsuccessful — ${fmt(amount)} to ${businessName}`,
      emailHtml: failedAttemptEmailHtml(customerName, businessName, amount, customerId),
      meta: { attemptId: String(attempt._id), amount, planId: String(plan._id) },
    });
  } catch (err) {
    console.error("[reminder] sendFailedAttemptReminder error:", err);
  }
}

/**
 * Called when a plan transitions to "completed".
 * Fire-and-forget: callers should use `void sendPlanCompletedNotification(...)`.
 */
export async function sendPlanCompletedNotification(planId: string | Types.ObjectId): Promise<void> {
  try {
    const plan = await RepaymentPlan.findById(planId).lean();
    if (!plan) return;

    const [customer, business] = await Promise.all([
      Customer.findById(plan.customerId).lean(),
      Business.findById(plan.businessId).lean(),
    ]);
    if (!customer) return;

    const customerName = customer.name ?? "";
    const businessName = business?.name ?? "the business";
    const totalAmount = plan.totalAmount;
    const customerId = String(customer._id);

    const smsMessage =
      `Congratulations ${customerName || "there"}! Your repayment plan with ${businessName} is fully settled (${fmt(totalAmount)}). ` +
      `No further deductions will be made. - RepayStream`;

    await dispatchReminder({
      planId: String(plan._id),
      customerId,
      reminderKey: `plan_completed:${String(plan._id)}`,
      type: "pre_due",
      phone: customer.phone,
      email: customer.email ?? undefined,
      smsMessage,
      emailSubject: `Repayment complete — ${fmt(totalAmount)} to ${businessName}`,
      emailHtml: planCompletedEmailHtml(customerName, businessName, totalAmount, customerId),
      meta: { planId: String(plan._id), totalAmount },
    });
  } catch (err) {
    console.error("[reminder] sendPlanCompletedNotification error:", err);
  }
}

/**
 * Scans all active plans and sends:
 *  - Pre-due reminders (1 day before due date)
 *  - Overdue reminders (at T+1, T+3, T+7 days)
 *
 * Safe to run repeatedly — deduplication prevents double-sends.
 */
export async function processScheduledReminders(): Promise<void> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const activePlans = await RepaymentPlan.find({ status: { $in: ["active", "defaulted"] } }).lean();

  for (const plan of activePlans) {
    try {
      const schedule = parseSchedule(plan);

      // Use cumulative amount to find next installment — count-based indexing
      // breaks when partial offline payments create extra PaymentAttempt records.
      const successAttempts = await PaymentAttempt.find({ planId: plan._id, status: "success" }).lean();
      const totalPaid = successAttempts.reduce((s, a) => s + a.amount, 0);
      let rem = totalPaid;
      let nextInstallmentIdx = schedule.length;
      for (let i = 0; i < schedule.length; i++) {
        if (rem >= schedule[i].amount) { rem -= schedule[i].amount; } else { nextInstallmentIdx = i; break; }
      }

      const nextInstallment = schedule[nextInstallmentIdx];
      if (!nextInstallment || !nextInstallment.due_date) continue;

      const [customer, business] = await Promise.all([
        Customer.findById(plan.customerId).lean(),
        Business.findById(plan.businessId).lean(),
      ]);
      if (!customer) continue;

      const customerName = customer.name ?? "";
      const businessName = business?.name ?? "the business";
      const { amount, due_date } = nextInstallment;
      const customerId = String(customer._id);
      const planId = String(plan._id);
      const installmentIdx = nextInstallmentIdx;

      // ── Pre-due (T-1): due tomorrow ──────────────────────────────────────
      if (due_date === tomorrowStr) {
        const smsMessage =
          `Hi ${customerName || "there"}, your repayment of ${fmt(amount)} to ${businessName} is due tomorrow (${due_date}). ` +
          `Please ensure your card is funded. - RepayStream`;

        await dispatchReminder({
          planId,
          customerId,
          reminderKey: `pre_due:${planId}:${installmentIdx}`,
          type: "pre_due",
          phone: customer.phone,
          email: customer.email ?? undefined,
          smsMessage,
          emailSubject: `Repayment reminder — ${fmt(amount)} due tomorrow`,
          emailHtml: preDueEmailHtml(customerName, businessName, amount, due_date, customerId),
          meta: { dueDate: due_date, amount, installmentIndex: installmentIdx },
        });
      }

      // ── Overdue: T+1, T+3, T+7 ───────────────────────────────────────────
      if (due_date < todayStr) {
        const dueDateObj = new Date(due_date);
        const msPerDay = 86_400_000;
        const daysOverdue = Math.floor((today.getTime() - dueDateObj.getTime()) / msPerDay);

        for (const threshold of [1, 3, 7]) {
          if (daysOverdue === threshold) {
            const smsMessage =
              `Hi ${customerName || "there"}, your repayment of ${fmt(amount)} to ${businessName} is ${threshold} day${threshold > 1 ? "s" : ""} overdue. ` +
              `Log in now: ${portalUrl(customerId)}`;

            await dispatchReminder({
              planId,
              customerId,
              reminderKey: `overdue:${planId}:${installmentIdx}:d${threshold}`,
              type: "overdue",
              phone: customer.phone,
              email: customer.email ?? undefined,
              smsMessage,
              emailSubject: `Overdue payment — ${fmt(amount)} to ${businessName} (${threshold}d)`,
              emailHtml: overdueEmailHtml(customerName, businessName, amount, threshold, customerId),
              meta: { dueDate: due_date, amount, daysOverdue: threshold, installmentIndex: installmentIdx },
            });
          }
        }
      }
    } catch (err) {
      console.error(`[reminder] Error processing plan ${plan._id}:`, err);
    }
  }
}
