import { Schema, model, Types } from "mongoose";

const disputeThreadSchema = new Schema(
  {
    planId: { type: Types.ObjectId, ref: "RepaymentPlan", required: true },
    customerId: { type: Types.ObjectId, ref: "Customer", required: true },
    businessId: { type: Types.ObjectId, ref: "Business", required: true },
    subject: { type: String, required: true, maxlength: 200 },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
    },
    category: {
      type: String,
      enum: ["payment_issue", "wrong_amount", "unauthorized_debit", "refund_request", "general"],
      default: "general",
    },
    resolvedAt: { type: Date },
  },
  { timestamps: true }
);

disputeThreadSchema.index({ customerId: 1 });
disputeThreadSchema.index({ businessId: 1 });
disputeThreadSchema.index({ planId: 1 });

export const DisputeThread = model("DisputeThread", disputeThreadSchema);
