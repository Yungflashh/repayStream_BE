import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import type { IncomingMessage, ServerResponse } from "http";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";

import logger from "./lib/logger.js";
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
    logger.fatal({ missing }, "Missing required env vars — aborting startup");
    process.exit(1);
  }
}

const app = express();
const PORT = parseInt(process.env.PORT ?? "4000", 10);

// Trust the first hop from the reverse proxy so req.ip reflects the real client IP.
// Required for rate limiting to work correctly in production (Render, Railway, etc.).
app.set("trust proxy", 1);

// ── HTTP request/response logging ────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    // Skip logging for health checks — too noisy
    autoLogging: { ignore: (req: IncomingMessage) => req.url === "/health" },
    customLogLevel: (_req: IncomingMessage, res: ServerResponse) => {
      if (res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage: (req: IncomingMessage, res: ServerResponse) =>
      `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req: IncomingMessage, res: ServerResponse) =>
      `${req.method} ${req.url} ${res.statusCode}`,
  })
);

// ── CORS ──────────────────────────────────────────────────────────────────────
logger.info({ allowedOrigins: process.env.CLIENT_ORIGIN }, "CORS config");
const allowedOrigins = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn({ origin }, "CORS blocked request from disallowed origin");
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
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, "public rate limit exceeded");
    res.status(429).json({ error: "Too many requests, please try again later." });
  },
});

// Strict limiter for write auth routes — prevents brute-force password attacks.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, "auth rate limit exceeded");
    res.status(429).json({ error: "Too many auth attempts, please try again later." });
  },
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
// Rate-limit only the write/sensitive auth routes that are brute-force targets.
// /api/auth/me is a read-only session check hit on every page load — do NOT limit it.
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/reset-password", authLimiter);
app.use("/api/auth/setup-password", authLimiter);
app.use("/api/auth", authRoutes);
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

// Client is served from Vercel — this server is API-only.
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ── Global error handler ──────────────────────────────────────────────────────
// Catches any error passed via next(err) or thrown in async routes.
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, method: req.method, path: req.path }, "unhandled error");
  res.status(500).json({ error: "Internal server error" });
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
    logger.info({ port: PORT }, "server started");
  });

  function shutdown(signal: string) {
    logger.info({ signal }, "graceful shutdown initiated");
    stopScheduler();
    stopReminderScheduler();
    server.close(() => {
      mongoose.connection
        .close()
        .then(() => {
          logger.info("graceful shutdown complete");
          process.exit(0);
        })
        .catch(() => process.exit(1));
    });
    setTimeout(() => {
      logger.error("forced exit after shutdown timeout");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => logger.fatal({ err }, "startup failed"));
