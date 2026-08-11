import { Schema, model, Types } from "mongoose";

const offlinePaymentSchema = new Schema(
  {
    planId: { type: Types.ObjectId, ref: "RepaymentPlan", required: true },
    businessId: { type: Types.ObjectId, ref: "Business", required: true },
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: ["cash", "pos", "transfer", "other"], required: true },
    notes: { type: String, trim: true },
    proofUrl: { type: String, trim: true },
    status: { type: String, enum: ["pending_approval", "approved", "rejected"], default: "pending_approval" },
    recordedBy: { type: String, enum: ["business", "customer"], required: true },
    recordedByUserId: { type: Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    approvedByUserId: { type: Types.ObjectId, ref: "User" },
    rejectedAt: { type: Date },
    rejectedByUserId: { type: Types.ObjectId, ref: "User" },
    rejectionReason: { type: String, trim: true },
  },
  { timestamps: true }
);

offlinePaymentSchema.index({ planId: 1 });
offlinePaymentSchema.index({ businessId: 1, status: 1 });

export const OfflinePayment = model("OfflinePayment", offlinePaymentSchema);
