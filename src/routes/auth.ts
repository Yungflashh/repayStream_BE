import { Router } from "express";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { Customer } from "../models/Customer.js";
import { signToken, verifyToken } from "../auth/jwt.js";
import { requireAuth } from "../middleware/auth.js";
import { sendEmail } from "../services/notifications/email.js";

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
  // Omit maxAge — passing it to clearCookie causes Max-Age to override Expires,
  // leaving the cookie alive (just empty) instead of deleting it.
  const { maxAge: _discard, ...clearOptions } = cookieOptions;
  res.clearCookie("token", clearOptions).json({ ok: true });
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

    // Only issue a new session if the requester isn't already logged in as a
    // different user. This prevents overwriting a business owner's cookie when
    // they open a customer setup link in their own browser.
    const existingToken = req.cookies?.token as string | undefined;
    const existingPayload = existingToken ? verifyToken(existingToken) : null;
    const isCorrectUser = existingPayload?.sub === user._id.toHexString();

    const sessionSet = !existingPayload || isCorrectUser;
    if (sessionSet) {
      res.cookie("token", signToken(user._id.toHexString()), cookieOptions);
    }

    res.json({ ok: true, customerId: customer._id.toString(), sessionSet });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to set password" });
  }
});

// ── Forgot / reset password ────────────────────────────────────────────────────

// Step 1: request a reset link
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email) return res.status(400).json({ error: "Email is required" });

    // Always respond with the same message to prevent email enumeration
    const ok = { ok: true, message: "If that email exists, a reset link has been sent." };

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) return res.json(ok);

    const token = randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    (user as any).resetToken = token;
    (user as any).resetTokenExpiry = expiry;
    await user.save();

    const appUrl = process.env.APP_URL ?? process.env.CLIENT_ORIGIN?.split(",")[0] ?? "http://localhost:5173";
    const resetUrl = `${appUrl}/reset-password?token=${token}`;

    await sendEmail({
      to: user.email,
      subject: "Reset your RepayStream password",
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:100%">
<tr><td style="background:#0f172a;padding:20px 32px">
  <span style="color:#fff;font-size:18px;font-weight:700">RepayStream</span>
</td></tr>
<tr><td style="padding:32px">
  <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#0f172a">Reset your password</p>
  <p style="margin:0 0 20px;color:#374151;font-size:15px">
    We received a request to reset your password. Click the button below — this link expires in <strong>1 hour</strong>.
  </p>
  <a href="${resetUrl}" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:600;font-size:15px;margin-bottom:24px">
    Reset my password →
  </a>
  <p style="color:#94a3b8;font-size:13px;margin:0 0 8px">If you didn't request this, you can safely ignore this email.</p>
  <p style="color:#94a3b8;font-size:12px;margin:0;word-break:break-all">Or copy this link: ${resetUrl}</p>
</td></tr>
<tr><td style="background:#f4f4f5;padding:16px 32px;font-size:12px;color:#6b7280;text-align:center">
  RepayStream &mdash; Automated Repayment Management
</td></tr>
</table></td></tr></table>
</body></html>`,
    });

    res.json(ok);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to process request" });
  }
});

// Step 2: validate the reset token (used by the UI to show the form vs. invalid state)
router.get("/reset-info", async (req, res) => {
  try {
    const token = req.query.token as string | undefined;
    if (!token) return res.status(400).json({ valid: false, error: "Token required" });

    const user = await User.findOne({ resetToken: token });
    if (!user || !(user as any).resetToken) {
      return res.status(404).json({ valid: false, error: "Invalid or expired link" });
    }
    const expiry = (user as any).resetTokenExpiry as Date | null;
    if (!expiry || expiry < new Date()) {
      return res.status(410).json({ valid: false, error: "This link has expired. Please request a new one." });
    }

    res.json({ valid: true, email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, error: "Failed" });
  }
});

// Step 3: consume the token and set the new password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body as { token?: string; password?: string };
    if (!token || !password) return res.status(400).json({ error: "Token and password are required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const user = await User.findOne({ resetToken: token });
    if (!user || !(user as any).resetToken) {
      return res.status(404).json({ error: "Invalid or expired link" });
    }
    const expiry = (user as any).resetTokenExpiry as Date | null;
    if (!expiry || expiry < new Date()) {
      return res.status(410).json({ error: "This link has expired. Please request a new one." });
    }

    user.passwordHash = await bcrypt.hash(password, 10);
    (user as any).resetToken = null;
    (user as any).resetTokenExpiry = null;
    await user.save();

    // Sign them in immediately
    const jwtToken = signToken(user._id.toHexString());
    res.cookie("token", jwtToken, cookieOptions);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset password" });
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
