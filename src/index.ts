import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";

import { connectDB } from "./db.js";
import { startScheduler } from "./lib/scheduler.js";
import authRoutes from "./routes/auth.js";
import businessRoutes from "./routes/business.js";
import planRoutes from "./routes/plans.js";
import mandateRoutes from "./routes/mandate.js";
import customerRoutes from "./routes/customer.js";
import publicRoutes from "./routes/public.js";
import webhookRoutes from "./routes/webhooks.js";
import disputeRoutes from "./routes/disputes.js";
import ledgerRoutes from "./routes/ledger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT ?? "4000", 10);

// CORS
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
    credentials: true,
  })
);

app.use(cookieParser());

// Raw body for webhook signature verification (before JSON parsing)
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

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/business", businessRoutes);
app.use("/api/plans", planRoutes);
app.use("/api/mandate", mandateRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/disputes", disputeRoutes);
app.use("/api/ledger", ledgerRoutes);

// Serve client in production
const clientDist = path.resolve(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

async function start() {
  await connectDB();
  startScheduler();
  app.listen(PORT, () => {
    console.log(`[server] running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);
