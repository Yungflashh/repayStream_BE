import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Business } from "../models/Business.js";

const router = Router();
router.use(requireAuth);

router.get("/me", async (req, res) => {
  const biz = await Business.findOne({ userId: req.userId });
  res.json({ business: biz ? { id: biz._id, name: biz.name } : null });
});

router.post("/", async (req, res) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name || name.trim().length < 2)
      return res.status(400).json({ error: "Name must be at least 2 characters" });

    const existing = await Business.findOne({ userId: req.userId });
    if (existing) return res.status(409).json({ error: "Business already exists" });

    const biz = await Business.create({ name: name.trim(), userId: req.userId });
    res.status(201).json({ business: { id: biz._id, name: biz.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create business" });
  }
});

router.patch("/", async (req, res) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name || name.trim().length < 2)
      return res.status(400).json({ error: "Name must be at least 2 characters" });

    const biz = await Business.findOneAndUpdate(
      { userId: req.userId },
      { name: name.trim() },
      { new: true }
    );
    if (!biz) return res.status(404).json({ error: "No business found" });
    res.json({ business: { id: biz._id, name: biz.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update" });
  }
});

export default router;
