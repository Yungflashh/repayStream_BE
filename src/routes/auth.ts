import { Router } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { signToken } from "../auth/jwt.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const isProd = process.env.NODE_ENV === "production";
const cookieOptions = {
  httpOnly: true,
  sameSite: (isProd ? "none" : "lax") as "none" | "lax",
  secure: isProd,
  maxAge: 7 * 86400_000,
};

router.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password || password.length < 8)
      return res.status(400).json({ error: "Email and password (min 8 chars) required" });

    const exists = await User.findOne({ email: email.trim().toLowerCase() });
    if (exists) return res.status(409).json({ error: "Email already registered" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email: email.trim().toLowerCase(), passwordHash });
    const token = signToken(user._id.toHexString());

    res.cookie("token", token, cookieOptions);
    res.status(201).json({ user: { id: user._id, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken(user._id.toHexString());
    res.cookie("token", token, cookieOptions);
    res.json({ user: { id: user._id, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

router.post("/logout", (_req, res) => {
  res.clearCookie("token", cookieOptions).json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.userId).select("-passwordHash");
  if (!user) return res.status(401).json({ error: "Not found" });
  res.json({ user: { id: user._id, email: user.email } });
});

export default router;
