/**
 * Email via Resend — uses their REST API directly (no SDK package needed).
 * Graceful no-op when RESEND_API_KEY is not set in env.
 *
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 */

interface ResendResponse {
  id?: string;
  name?: string;
  message?: string;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log("[email] RESEND_API_KEY not set — skipping");
    return { ok: false, error: "no_api_key" };
  }

  const from = process.env.EMAIL_FROM ?? "RepayStream <noreply@repaystream.co>";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from, to: opts.to, subject: opts.subject, html: opts.html }),
    });

    const data = (await res.json()) as ResendResponse;

    if (res.ok && data.id) return { ok: true };
    return { ok: false, error: data.message ?? JSON.stringify(data) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
