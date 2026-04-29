import { Router } from "express";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { Customer } from "../models/Customer.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { initializePaystackTransaction } from "../lib/paystack.js";

const router = Router();
const APP_URL = () => process.env.PUBLIC_APP_URL ?? "http://localhost:5173";

/** Get the first installment amount from the plan's schedule, falling back to totalAmount. */
function getFirstInstallmentAmount(plan: { scheduleJson: unknown; totalAmount: number }): number {
  const sj = plan.scheduleJson;

  // Array of { amount, due_date } rows (generated or custom schedule)
  if (Array.isArray(sj) && sj.length > 0) {
    const first = sj[0] as { amount?: number };
    if (typeof first.amount === "number" && first.amount > 0) return first.amount;
  }

  // Object format: { type: "installments", installments: [...] }
  if (sj && typeof sj === "object" && !Array.isArray(sj)) {
    const obj = sj as { type?: string; installments?: { amount?: number | string }[]; dueDate?: string };
    if (obj.type === "installments" && Array.isArray(obj.installments) && obj.installments.length > 0) {
      const amt = parseFloat(String(obj.installments[0].amount ?? 0));
      if (amt > 0) return amt;
    }
    // Lump sum — use totalAmount
  }

  return plan.totalAmount;
}

router.post("/paystack", async (req, res) => {
  try {
    const { planId } = req.body as { planId?: string };
    if (!planId) return res.status(400).json({ error: "planId required" });

    const plan = await RepaymentPlan.findById(planId);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const customer = await Customer.findById(plan.customerId);
    const email = customer?.email ?? "customer@repaystream.local";
    const firstAmount = getFirstInstallmentAmount(plan);
    const amountKobo = Math.max(Math.round(firstAmount * 100), 200);
    const reference = `rs_${plan._id}_${Date.now()}`;

    // Count previous attempts for this plan
    const prevAttempts = await PaymentAttempt.countDocuments({ planId: plan._id });

    // Create PaymentAttempt so the webhook can find it
    await PaymentAttempt.create({
      planId: plan._id,
      attemptNumber: prevAttempts + 1,
      amount: firstAmount,
      status: "pending",
      provider: "paystack",
      externalRef: reference,
      idempotencyKey: reference,
    });

    const result = await initializePaystackTransaction({
      email,
      amount: amountKobo,
      reference,
      callbackUrl: `${APP_URL()}/plan/${plan._id}?trxref=${reference}`,
    });

    res.json({ authorizationUrl: result.authorization_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not start Paystack session" });
  }
});

export default router;
