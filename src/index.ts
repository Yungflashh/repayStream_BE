import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";

import { connectDB } from "./db.js";
import { startScheduler, stopScheduler } from "./lib/scheduler.js";
import { startReminderScheduler, stopReminderScheduler } from "./lib/reminder-scheduler.js";
import authRoutes from "./routes/auth.js";
import businessRoutes from "./routes/business.js";
import planRoutes from "./routes/plans.js";
import mandateRoutes from "./routes/mandate.js";
import customerRoutes from "./routes/customer.js";
import publicRoutes from "./routes/public.js";
import webhookRoutes from "./routes/webhooks.js";
import disputeRoutes from "./routes/disputes.js";
import ledgerRoutes from "./routes/ledger.js";
import offlinePaymentRoutes from "./routes/offline-payments.js";
import adminRoutes from "./routes/admin.js";
import analyticsRoutes from "./routes/analytics.js";
import { requireAuth } from "./middleware/auth.js";

// ── Startup env validation ────────────────────────────────────────────────────
// PAYSTACK_WEBHOOK_SECRET is intentionally omitted — Paystack signs webhooks with
// PAYSTACK_SECRET_KEY (same key used for API calls, per Paystack docs).
const REQUIRED_IN_PROD = ["JWT_SECRET", "MONGODB_URI", "PAYSTACK_SECRET_KEY"];
if (process.env.NODE_ENV === "production") {
  const missing = REQUIRED_IN_PROD.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[startup] Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT ?? "4000", 10);

// ── CORS ──────────────────────────────────────────────────────────────────────
console.log("[cors] CLIENT_ORIGIN =", process.env.CLIENT_ORIGIN);
const allowedOrigins = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
  })
);

app.use(cookieParser());

// ── Raw body for webhook signature verification (before JSON parsing) ─────────
app.use(
  "/api/webhooks",
  express.raw({ type: "application/json" }),
  (req, _res, next) => {
    (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
    req.body = JSON.parse((req.body as Buffer).toString());
    next();
  }
);

app.use(express.json());

// ── Rate limiting ─────────────────────────────────────────────────────────────
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// Strict limiter for auth routes — prevents brute-force password attacks.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts, please try again later." },
});

// ── Health check with real DB ping ───────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    await mongoose.connection.db!.admin().ping();
    res.json({ status: "ok", db: "connected" });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/business", businessRoutes);
app.use("/api/plans", planRoutes);
app.use("/api/mandate", publicLimiter, mandateRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/public", publicLimiter, publicRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/disputes", disputeRoutes);
app.use("/api/ledger", ledgerRoutes);
app.use("/api/offline", offlinePaymentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/analytics", requireAuth, analyticsRoutes);

// ── Serve client in production ────────────────────────────────────────────────
const clientDist = path.resolve(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await connectDB();

  const schedulerIntervalMs = parseInt(
    process.env.SCHEDULER_INTERVAL_MS ?? String(60 * 60 * 1000),
    10
  );
  startScheduler(schedulerIntervalMs);
  startReminderScheduler();

  const server = app.listen(PORT, () => {
    console.log(`[server] running on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  function shutdown(signal: string) {
    console.log(`[server] ${signal} received — shutting down gracefully`);
    stopScheduler();
    stopReminderScheduler();
    server.close(() => {
      mongoose.connection
        .close()
        .then(() => {
          console.log("[server] graceful shutdown complete");
          process.exit(0);
        })
        .catch(() => process.exit(1));
    });
    // Force exit after 10 seconds if graceful shutdown stalls
    setTimeout(() => {
      console.error("[server] forced exit after timeout");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch(console.error);
