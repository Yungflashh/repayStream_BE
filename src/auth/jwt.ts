import jwt from "jsonwebtoken";

const SECRET = () => process.env.JWT_SECRET ?? "dev-secret-change-me";

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, SECRET(), { expiresIn: "7d" });
}

export function verifyToken(token: string): { sub: string } | null {
  try {
    return jwt.verify(token, SECRET()) as { sub: string };
  } catch {
    return null;
  }
}
