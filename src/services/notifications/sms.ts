/**
 * SMS via Termii — Nigeria's dominant transactional SMS gateway.
 * Graceful no-op when TERMII_API_KEY is not set in env.
 *
 * Docs: https://developers.termii.com/sending-messages
 */

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("234")) return digits;
  if (digits.startsWith("0")) return "234" + digits.slice(1);
  if (digits.length === 10) return "234" + digits;
  return digits;
}

interface TermiiResponse {
  message?: string;
  message_id?: string;
  code?: string;
}

export async function sendSms(
  to: string,
  message: string
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey) {
    console.log("[sms] TERMII_API_KEY not set — skipping");
    return { ok: false, error: "no_api_key" };
  }

  const phone = normalizePhone(to);

  try {
    const res = await fetch("https://api.ng.termii.com/api/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: phone,
        from: process.env.TERMII_SENDER_ID ?? "RepayStream",
        sms: message,
        type: "plain",
        channel: "generic",
        api_key: apiKey,
      }),
    });

    const data = (await res.json()) as TermiiResponse;

    if (res.ok && data.message_id) {
      return { ok: true };
    }
    return { ok: false, error: data.message ?? JSON.stringify(data) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
