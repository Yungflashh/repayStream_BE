import { ReminderLog } from "../../models/ReminderLog.js";
import { sendSms } from "./sms.js";
import { sendEmail } from "./email.js";

export interface ReminderPayload {
  planId: string;
  customerId: string;
  /** Base key — channel suffix added internally: `{baseKey}:{channel}` */
  reminderKey: string;
  type: "pre_due" | "failed_attempt" | "overdue";
  phone?: string;
  email?: string;
  smsMessage: string;
  emailSubject: string;
  emailHtml: string;
  meta?: Record<string, unknown>;
}

/**
 * Dispatches a reminder across all available channels (SMS + email).
 * Each channel is deduplicated independently via ReminderLog.
 * Channels with no API key are silently skipped — never throws.
 */
export async function dispatchReminder(payload: ReminderPayload): Promise<void> {
  const channels: Array<{ ch: "sms" | "email"; contact: string }> = [];
  if (payload.phone) channels.push({ ch: "sms", contact: payload.phone });
  if (payload.email) channels.push({ ch: "email", contact: payload.email });

  for (const { ch, contact } of channels) {
    const key = `${payload.reminderKey}:${ch}`;

    try {
      const exists = await ReminderLog.exists({ reminderKey: key });
      if (exists) continue;

      let result: { ok: boolean; error?: string };

      if (ch === "sms") {
        result = await sendSms(contact, payload.smsMessage);
      } else {
        result = await sendEmail({
          to: contact,
          subject: payload.emailSubject,
          html: payload.emailHtml,
        });
      }

      const status = result.ok ? "sent" : result.error === "no_api_key" ? "skipped" : "failed";

      await ReminderLog.create({
        planId: payload.planId,
        customerId: payload.customerId,
        type: payload.type,
        channel: ch,
        reminderKey: key,
        status,
        error: result.error,
        meta: payload.meta,
      });

      console.log(`[reminder] ${ch} ${status} — ${key}`);
    } catch (err) {
      // Never let one channel failure cascade
      console.error(`[reminder] ${ch} dispatch error — ${key}:`, err);
    }
  }
}
