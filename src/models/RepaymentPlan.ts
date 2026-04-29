import { Schema, model, Types } from "mongoose";

const repaymentPlanSchema = new Schema(
  {
    businessId: { type: Types.ObjectId, ref: "Business", required: true },
    customerId: { type: Types.ObjectId, ref: "Customer", required: true },
    totalAmount: { type: Number, required: true },
    scheduleJson: { type: Schema.Types.Mixed, required: true },
    status: { type: String, default: "pending_mandate" },
    idempotencyKey: { type: String },
    paymentMethod: { type: String, enum: ["card"], default: "card" },
  },
  { timestamps: true }
);

repaymentPlanSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
repaymentPlanSchema.index({ customerId: 1 });

export const RepaymentPlan = model("RepaymentPlan", repaymentPlanSchema);
