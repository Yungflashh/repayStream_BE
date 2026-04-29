import { Schema, model, Types } from "mongoose";

const paymentAttemptSchema = new Schema(
  {
    planId: { type: Types.ObjectId, ref: "RepaymentPlan", required: true },
    attemptNumber: { type: Number, required: true, min: 1, max: 3 },
    amount: { type: Number, required: true },
    status: { type: String, default: "pending" },
    idempotencyKey: { type: String, unique: true },
    failureReason: { type: String, default: null },
    provider: { type: String, enum: ["paystack", null], default: null },
    externalRef: { type: String },
  },
  { timestamps: true }
);

paymentAttemptSchema.index({ planId: 1 });

export const PaymentAttempt = model("PaymentAttempt", paymentAttemptSchema);
