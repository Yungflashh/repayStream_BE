import { Schema, model, Types } from "mongoose";

const repaymentPlanSchema = new Schema(
  {
    businessId: { type: Types.ObjectId, ref: "Business", required: true },
    customerId: { type: Types.ObjectId, ref: "Customer", required: true },
    planName: { type: String, trim: true },
    group: { type: String, trim: true },
    totalAmount: { type: Number, required: true },
    scheduleJson: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ["pending_mandate", "active", "completed", "defaulted", "paused", "cancelled"], default: "pending_mandate" },
    idempotencyKey: { type: String },
    paymentMethod: { type: String, enum: ["card"], default: "card" },
    authorizationCode: { type: String },
    feeStrategy: { type: String, enum: ["absorb", "pass_to_customer"], default: "absorb" },
    notes: [
      {
        text: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

repaymentPlanSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
repaymentPlanSchema.index({ customerId: 1 });
repaymentPlanSchema.index({ status: 1 });

export const RepaymentPlan = model("RepaymentPlan", repaymentPlanSchema);
