const PAYSTACK_SECRET = () => process.env.PAYSTACK_SECRET_KEY ?? "";

export async function initializePaystackTransaction(opts: {
  email: string;
  amount: number; // kobo
  reference: string;
  callbackUrl: string;
}) {
  const key = PAYSTACK_SECRET();
  if (!key) {
    console.warn("[paystack] no secret key — returning placeholder");
    return { authorization_url: opts.callbackUrl + "?trxref=" + opts.reference };
  }

  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: opts.email,
      amount: opts.amount,
      reference: opts.reference,
      callback_url: opts.callbackUrl,
    }),
  });

  const json = (await res.json()) as { status: boolean; data?: { authorization_url: string }; message?: string };
  if (!json.status || !json.data) throw new Error(json.message ?? "Paystack init failed");
  return { authorization_url: json.data.authorization_url };
}

export async function verifyPaystackTransaction(reference: string): Promise<{
  status: "success" | "failed" | "abandoned" | "pending";
  amount: number; // kobo
  gateway_response: string;
}> {
  const key = PAYSTACK_SECRET();
  if (!key) {
    console.warn("[paystack] no secret key — cannot verify");
    return { status: "pending", amount: 0, gateway_response: "no key" };
  }

  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  const json = (await res.json()) as {
    status: boolean;
    data?: { status: string; amount: number; gateway_response: string };
    message?: string;
  };

  if (!json.status || !json.data) {
    return { status: "pending", amount: 0, gateway_response: json.message ?? "verify failed" };
  }

  const s = json.data.status;
  const mapped = s === "success" ? "success" : s === "failed" ? "failed" : s === "abandoned" ? "abandoned" : "pending";
  return { status: mapped, amount: json.data.amount, gateway_response: json.data.gateway_response };
}
