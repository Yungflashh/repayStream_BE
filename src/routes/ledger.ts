/**
 * Phase 2: Ledger routes for schools/cooperatives.
 * Basic CRUD is scaffolded; full logic (reconciliation, balance tracking) in Phase 2.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Business } from "../models/Business.js";
import { Ledger } from "../models/Ledger.js";
import { LedgerEntry } from "../models/LedgerEntry.js";

const router = Router();
router.use(requireAuth);

// Create a new ledger
router.post("/", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.status(403).json({ error: "Business required" });

    const { name, description, type } = req.body as { name?: string; description?: string; type?: string };
    if (!name) return res.status(400).json({ error: "Name required" });

    const ledger = await Ledger.create({
      businessId: biz._id,
      name: name.trim(),
      description: description?.trim(),
      type: type ?? "custom",
    });

    res.status(201).json({ ledger: { id: ledger._id, name: ledger.name, type: ledger.type } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create ledger" });
  }
});

// List ledgers for business
router.get("/", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.json({ ledgers: [] });

    const ledgers = await Ledger.find({ businessId: biz._id }).sort({ createdAt: -1 }).lean();
    res.json({
      ledgers: ledgers.map((l) => ({
        id: l._id,
        name: l.name,
        type: l.type,
        description: l.description,
        is_active: l.isActive,
        created_at: l.createdAt,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load ledgers" });
  }
});

// Get entries for a ledger
router.get("/:ledgerId/entries", async (req, res) => {
  try {
    const biz = await Business.findOne({ userId: req.userId });
    if (!biz) return res.status(403).json({ error: "Business required" });

    const ledger = await Ledger.findOne({ _id: req.params.ledgerId, businessId: biz._id });
    if (!ledger) return res.status(404).json({ error: "Ledger not found" });

    const entries = await LedgerEntry.find({ ledgerId: ledger._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.json({
      entries: entries.map((e) => ({
        id: e._id,
        type: e.type,
        amount: e.amount,
        balance_after: e.balanceAfter,
        description: e.description,
        created_at: e.createdAt,
        reconciled: !!e.reconciledAt,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load entries" });
  }
});

export default router;
