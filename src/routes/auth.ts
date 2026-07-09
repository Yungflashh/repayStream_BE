import { Router } from "express";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { Customer } from "../models/Customer.js";
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
    res.status(201).json({ user: { id: user._id, email: user.email }, token });
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
    res.json({ user: { id: user._id, email: user.email }, token });
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

router.patch("/password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: "Current and new password are required" });
    if (newPassword.length < 8)
      return res.status(400).json({ error: "New password must be at least 8 characters" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: "Not found" });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to change password" });
  }
});

// Public: validate a setup token and return the email
router.get("/setup-info", async (req, res) => {
  try {
    const token = req.query.token as string | undefined;
    if (!token) return res.status(400).json({ valid: false, error: "Token required" });

    const customer = await Customer.findOne({ setupToken: token });
    if (!customer || !customer.setupToken) {
      return res.status(404).json({ valid: false, error: "Invalid or expired link" });
    }
    if (customer.setupTokenExpiry && customer.setupTokenExpiry < new Date()) {
      return res.status(410).json({ valid: false, error: "This link has expired. Ask your provider to resend it." });
    }

    res.json({ valid: true, email: customer.email, customerId: customer._id.toString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, error: "Failed" });
  }
});

// Public: consume a setup token and create/link the user account
router.post("/setup-password", async (req, res) => {
  try {
    const { token, password } = req.body as { token?: string; password?: string };
    if (!token || !password) return res.status(400).json({ error: "Token and password are required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const customer = await Customer.findOne({ setupToken: token });
    if (!customer) return res.status(404).json({ error: "Invalid or expired link" });
    if (customer.setupTokenExpiry && customer.setupTokenExpiry < new Date()) {
      return res.status(410).json({ error: "This link has expired. Ask your provider to resend it." });
    }
    if (!customer.email) return res.status(400).json({ error: "No email on file for this customer" });

    const passwordHash = await bcrypt.hash(password, 10);

    // Find or create the User account.
    // IMPORTANT: if a User already exists for this email (from another business),
    // do NOT overwrite their password — that would lock them out of their other account.
    // Only set the password when creating a brand-new account.
    let user = await User.findOne({ email: customer.email.toLowerCase() });
    if (!user) {
      user = await User.create({ email: customer.email.toLowerCase(), passwordHash });
    }
    // If user already exists and this customer is already linked to a different user,
    // the email mismatch is a config issue — reject rather than silently takeover.
    if (customer.userId && String(customer.userId) !== String(user._id)) {
      return res.status(409).json({ error: "This customer account is already linked to a different user" });
    }

    // Link customer to user and clear the token
    customer.userId = user._id as any;
    customer.setupToken = null;
    customer.setupTokenExpiry = null;
    await customer.save();

    // Sign them in immediately
    const jwtToken = signToken(user._id.toHexString());
    res.cookie("token", jwtToken, cookieOptions);
    res.json({ ok: true, customerId: customer._id.toString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to set password" });
  }
});

// Helper exported for use in plan creation
export async function generateCustomerSetupToken(customerId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await Customer.findByIdAndUpdate(customerId, { setupToken: token, setupTokenExpiry: expiry });
  return token;
}

export default router;
