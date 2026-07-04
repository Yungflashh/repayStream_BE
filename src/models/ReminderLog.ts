import { Schema, model, Types } from "mongoose";

const reminderLogSchema = new Schema(
  {
    planId: { type: Types.ObjectId, ref: "RepaymentPlan", required: true },
    customerId: { type: Types.ObjectId, ref: "Customer", required: true },
    type: { type: String, enum: ["pre_due", "failed_attempt", "overdue"], required: true },
    channel: { type: String, enum: ["sms", "email", "whatsapp"], required: true },
    /** Unique dedup key — format varies by type (see reminder.ts) */
    reminderKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ["sent", "failed", "skipped"], required: true },
    error: { type: String },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

reminderLogSchema.index({ planId: 1, createdAt: -1 });
reminderLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // 30-day TTL

export const ReminderLog = model("ReminderLog", reminderLogSchema);
