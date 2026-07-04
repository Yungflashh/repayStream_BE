import { DisputeThread } from "../models/DisputeThread.js";
import { Customer } from "../models/Customer.js";
import { Business } from "../models/Business.js";
import { User } from "../models/User.js";
import { sendEmail } from "./notifications/email.js";

// ─── Email template helpers ───────────────────────────────────────────────────

function emailWrapper(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:100%">
<tr><td style="background:#0f172a;padding:20px 32px">
  <span style="color:#fff;font-size:18px;font-weight:700">RepayStream</span>
</td></tr>
<tr><td style="padding:32px">${bodyHtml}</td></tr>
<tr><td style="background:#f4f4f5;padding:16px 32px;font-size:12px;color:#6b7280;text-align:center">
  You received this because a dispute involves your account.<br>
  RepayStream &mdash; Automated Repayment Management
</td></tr>
</table></td></tr></table>
</body></html>`;
}

function newMessageEmailHtml(subject: string): string {
  return emailWrapper(`
<p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#0f172a">New message on your dispute</p>
<p style="margin:0 0 20px;color:#374151">
  A new message has been posted to your dispute: <strong>${subject}</strong>.
</p>
<p style="margin:0 0 20px;color:#374151">
  Please log in to RepayStream to view and reply to this message.
</p>
`);
}

function statusChangedEmailHtml(newStatus: string, resolutionNote?: string): string {
  const statusLabel = newStatus.replace(/_/g, " ");
  const noteSection = resolutionNote
    ? `<p style="margin:0 0 20px;color:#374151;background:#f9fafb;border-left:4px solid #0f172a;padding:12px 16px;border-radius:4px">
        <strong>Resolution note:</strong><br>${resolutionNote}
      </p>`
    : "";
  return emailWrapper(`
<p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#0f172a">Your dispute status has been updated</p>
<p style="margin:0 0 20px;color:#374151">
  Your dispute has been marked as: <strong>${statusLabel}</strong>.
</p>
${noteSection}
<p style="margin:0 0 20px;color:#374151">
  Log in to RepayStream to view the full dispute thread.
</p>
`);
}

// ─── Public notification functions ───────────────────────────────────────────

/**
 * Notify the OTHER party when a message is posted to a dispute thread.
 * Fire-and-forget — never throws.
 */
export async function notifyDisputeMessage(
  threadId: string,
  senderType: "customer" | "business"
): Promise<void> {
  try {
    const thread = await DisputeThread.findById(threadId).lean();
    if (!thread) return;

    const subject = (thread as { subject: string }).subject;

    if (senderType === "customer") {
      // Notify the business — get business email via User model
      const business = await Business.findById((thread as any).businessId).lean();
      if (!business) return;
      const user = await User.findById((business as any).userId).lean();
      if (!user || !(user as any).email) return;

      await sendEmail({
        to: (user as any).email as string,
        subject: `New message on your dispute: ${subject}`,
        html: newMessageEmailHtml(subject),
      });
    } else {
      // Notify the customer
      const customer = await Customer.findById((thread as any).customerId).lean();
      if (!customer || !(customer as any).email) return;

      await sendEmail({
        to: (customer as any).email as string,
        subject: `New message on your dispute: ${subject}`,
        html: newMessageEmailHtml(subject),
      });
    }
  } catch (err) {
    console.error("[dispute-notifications] notifyDisputeMessage error:", err);
  }
}

/**
 * Notify the customer when business updates the dispute status.
 * Fire-and-forget — never throws.
 */
export async function notifyDisputeStatusChanged(
  threadId: string,
  newStatus: string,
  resolutionNote?: string
): Promise<void> {
  try {
    const thread = await DisputeThread.findById(threadId).lean();
    if (!thread) return;

    const customer = await Customer.findById((thread as any).customerId).lean();
    if (!customer || !(customer as any).email) return;

    await sendEmail({
      to: (customer as any).email as string,
      subject: `Your dispute has been ${newStatus.replace(/_/g, " ")}`,
      html: statusChangedEmailHtml(newStatus, resolutionNote),
    });
  } catch (err) {
    console.error("[dispute-notifications] notifyDisputeStatusChanged error:", err);
  }
}
