import { Router } from "express";
import { Business } from "../models/Business.js";
import { RepaymentPlan } from "../models/RepaymentPlan.js";
import { PaymentAttempt } from "../models/PaymentAttempt.js";
import { DisputeThread } from "../models/DisputeThread.js";
import { Customer } from "../models/Customer.js";

const router = Router();

// All routes here require the business to be authenticated.
// The requireAuth + business lookup is done per-route so we can return
// the business _id for scoping queries.

// GET /api/analytics/summary
router.get("/summary", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId }).lean();
    if (!biz) return res.status(403).json({ error: "No business profile found" });

    const bizId = (biz as any)._id;

    // Plan counts
    const [total, active, completed, defaulted, paused, pending_mandate, cancelled] =
      await Promise.all([
        RepaymentPlan.countDocuments({ businessId: bizId }),
        RepaymentPlan.countDocuments({ businessId: bizId, status: "active" }),
        RepaymentPlan.countDocuments({ businessId: bizId, status: "completed" }),
        RepaymentPlan.countDocuments({ businessId: bizId, status: "defaulted" }),
        RepaymentPlan.countDocuments({ businessId: bizId, status: "paused" }),
        RepaymentPlan.countDocuments({ businessId: bizId, status: "pending_mandate" }),
        RepaymentPlan.countDocuments({ businessId: bizId, status: "cancelled" }),
      ]);

    // Revenue: get all plan IDs for this business
    const planIds = await RepaymentPlan.find({ businessId: bizId }, { _id: 1 }).lean();
    const planIdList = planIds.map((p) => (p as any)._id);

    // revenue.collected = sum of successful PaymentAttempt amounts
    const collectedAgg = await PaymentAttempt.aggregate([
      { $match: { planId: { $in: planIdList }, status: "success" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const collected: number = collectedAgg[0]?.total ?? 0;

    // revenue.expected = sum of RepaymentPlan.totalAmount
    const expectedAgg = await RepaymentPlan.aggregate([
      { $match: { businessId: bizId } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]);
    const expected: number = expectedAgg[0]?.total ?? 0;
    const outstanding = expected - collected;

    // Dispute counts
    const [disputeTotal, disputeOpen, disputeResolved] = await Promise.all([
      DisputeThread.countDocuments({ businessId: bizId }),
      DisputeThread.countDocuments({ businessId: bizId, status: { $in: ["open", "in_progress"] } }),
      DisputeThread.countDocuments({ businessId: bizId, status: { $in: ["resolved", "closed"] } }),
    ]);

    // Customer count
    const customerTotal = await Customer.countDocuments({ businessId: bizId });

    res.json({
      plans: { total, active, completed, defaulted, paused, pending_mandate, cancelled },
      revenue: { collected, expected, outstanding },
      disputes: { total: disputeTotal, open: disputeOpen, resolved: disputeResolved },
      customers: { total: customerTotal },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load analytics summary" });
  }
});

// GET /api/analytics/revenue-by-month
// Returns last 6 months of revenue data
router.get("/revenue-by-month", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId }).lean();
    if (!biz) return res.status(403).json({ error: "No business profile found" });

    const bizId = (biz as any)._id;

    // Get all plan IDs for this business
    const planIds = await RepaymentPlan.find({ businessId: bizId }, { _id: 1 }).lean();
    const planIdList = planIds.map((p) => (p as any)._id);

    // Last 6 months window
    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    // Aggregate successful payment amounts by month
    const collectedByMonth = await PaymentAttempt.aggregate([
      {
        $match: {
          planId: { $in: planIdList },
          status: "success",
          createdAt: { $gte: sixMonthsAgo },
        },
      },
      {
        $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          collected: { $sum: "$amount" },
        },
      },
    ]);

    // Aggregate expected amounts (totalAmount) by plan creation month
    const expectedByMonth = await RepaymentPlan.aggregate([
      {
        $match: {
          businessId: bizId,
          createdAt: { $gte: sixMonthsAgo },
        },
      },
      {
        $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          expected: { $sum: "$totalAmount" },
        },
      },
    ]);

    // Build a map keyed by "YYYY-M"
    const collectedMap = new Map<string, number>();
    for (const row of collectedByMonth) {
      collectedMap.set(`${row._id.year}-${row._id.month}`, row.collected);
    }
    const expectedMap = new Map<string, number>();
    for (const row of expectedByMonth) {
      expectedMap.set(`${row._id.year}-${row._id.month}`, row.expected);
    }

    const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    // Build the last 6 months ordered oldest → newest
    const result: Array<{ month: string; collected: number; expected: number }> = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
      result.push({
        month: SHORT_MONTHS[d.getMonth()],
        collected: collectedMap.get(key) ?? 0,
        expected: expectedMap.get(key) ?? 0,
      });
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load revenue-by-month" });
  }
});

// GET /api/analytics/plans-by-status
router.get("/plans-by-status", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId }).lean();
    if (!biz) return res.status(403).json({ error: "No business profile found" });

    const bizId = (biz as any)._id;

    const agg = await RepaymentPlan.aggregate([
      { $match: { businessId: bizId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const result = agg.map((row) => ({ status: row._id as string, count: row.count as number }));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load plans-by-status" });
  }
});

export default router;
