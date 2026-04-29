import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { DisputeThread } from "../models/DisputeThread.js";
import { DisputeMessage } from "../models/DisputeMessage.js";
import { Customer } from "../models/Customer.js";
import { Business } from "../models/Business.js";
import { AuditLog } from "../models/AuditLog.js";

const router = Router();
router.use(requireAuth);

// Create a new dispute thread
router.post("/", async (req, res) => {
  try {
    const { planId, subject, category, message } = req.body as {
      planId?: string;
      subject?: string;
      category?: string;
      message?: string;
    };

    if (!planId || !subject || !message) {
      return res.status(400).json({ error: "planId, subject, and message are required" });
    }

    // Determine if sender is customer or business
    const customer = await Customer.findOne({ userId: req.userId });
    const business = await Business.findOne({ userId: req.userId });

    let senderType: "customer" | "business";
    let customerId: string;
    let businessId: string;

    if (customer) {
      senderType = "customer";
      customerId = customer._id.toString();
      businessId = customer.businessId.toString();
    } else if (business) {
      senderType = "business";
      businessId = business._id.toString();
      // Find the customer from the plan
      const { RepaymentPlan } = await import("../models/RepaymentPlan.js");
      const plan = await RepaymentPlan.findById(planId);
      if (!plan) return res.status(404).json({ error: "Plan not found" });
      customerId = plan.customerId.toString();
    } else {
      return res.status(403).json({ error: "No customer or business profile found" });
    }

    const thread = await DisputeThread.create({
      planId,
      customerId,
      businessId,
      subject: subject.trim(),
      category: category ?? "general",
    });

    await DisputeMessage.create({
      threadId: thread._id,
      senderType,
      senderId: req.userId,
      body: message.trim(),
    });

    await AuditLog.create({
      actor: `user:${req.userId}`,
      action: "dispute_opened",
      entityType: "dispute_thread",
      entityId: thread._id,
      payload: { subject, category },
    });

    res.status(201).json({ thread: { id: thread._id, status: thread.status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create dispute" });
  }
});

// List dispute threads for current user
router.get("/", async (req, res) => {
  try {
    const customer = await Customer.findOne({ userId: req.userId });
    const business = await Business.findOne({ userId: req.userId });

    let threads;
    if (customer) {
      threads = await DisputeThread.find({ customerId: customer._id })
        .sort({ createdAt: -1 })
        .lean();
    } else if (business) {
      threads = await DisputeThread.find({ businessId: business._id })
        .sort({ createdAt: -1 })
        .lean();
    } else {
      return res.json({ threads: [] });
    }

    res.json({
      threads: threads.map((t) => ({
        id: t._id,
        subject: t.subject,
        status: t.status,
        category: t.category,
        created_at: t.createdAt,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load disputes" });
  }
});

// Get messages for a thread
router.get("/:threadId/messages", async (req, res) => {
  try {
    const thread = await DisputeThread.findById(req.params.threadId);
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    // Verify access
    const customer = await Customer.findOne({ userId: req.userId });
    const business = await Business.findOne({ userId: req.userId });
    const isCustomer = customer && thread.customerId.toString() === customer._id.toString();
    const isBusiness = business && thread.businessId.toString() === business._id.toString();
    if (!isCustomer && !isBusiness) return res.status(403).json({ error: "Access denied" });

    const messages = await DisputeMessage.find({ threadId: thread._id })
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      thread: {
        id: thread._id,
        subject: thread.subject,
        status: thread.status,
        category: thread.category,
      },
      messages: messages.map((m) => ({
        id: m._id,
        sender_type: m.senderType,
        body: m.body,
        created_at: m.createdAt,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load messages" });
  }
});

// Post a message to a thread
router.post("/:threadId/messages", async (req, res) => {
  try {
    const { body: messageBody } = req.body as { body?: string };
    if (!messageBody?.trim()) return res.status(400).json({ error: "Message body required" });

    const thread = await DisputeThread.findById(req.params.threadId);
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    const customer = await Customer.findOne({ userId: req.userId });
    const business = await Business.findOne({ userId: req.userId });
    const isCustomer = customer && thread.customerId.toString() === customer._id.toString();
    const isBusiness = business && thread.businessId.toString() === business._id.toString();
    if (!isCustomer && !isBusiness) return res.status(403).json({ error: "Access denied" });

    const senderType = isCustomer ? "customer" : "business";

    const msg = await DisputeMessage.create({
      threadId: thread._id,
      senderType,
      senderId: req.userId,
      body: messageBody.trim(),
    });

    // Reopen if was resolved
    if (thread.status === "resolved" || thread.status === "closed") {
      thread.status = "in_progress";
      await thread.save();
    }

    res.status(201).json({
      message: { id: msg._id, sender_type: senderType, body: msg.body, created_at: msg.createdAt },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// Update thread status (business only)
router.patch("/:threadId/status", async (req, res) => {
  try {
    const { status } = req.body as { status?: string };
    if (!status || !["open", "in_progress", "resolved", "closed"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const business = await Business.findOne({ userId: req.userId });
    if (!business) return res.status(403).json({ error: "Business access required" });

    const thread = await DisputeThread.findOne({ _id: req.params.threadId, businessId: business._id });
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    thread.status = status as any;
    if (status === "resolved") thread.resolvedAt = new Date();
    await thread.save();

    res.json({ status: thread.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

export default router;
