import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../auth/jwt.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

function extractToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return req.cookies?.token as string | undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Invalid token" });
  req.userId = payload.sub;
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload) req.userId = payload.sub;
  }
  next();
}
