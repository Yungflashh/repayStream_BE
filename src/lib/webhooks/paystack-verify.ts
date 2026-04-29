import crypto from "crypto";

export function verifyPaystackSignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.PAYSTACK_SECRET_KEY ?? "";
  const hash = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  return hash === signature;
}
