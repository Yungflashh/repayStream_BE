/**
 * Phase 2: Ledger accounts for schools/cooperatives.
 * Schema is ready — routes and full logic will be added in Phase 2.
 */
import { Schema, model, Types } from "mongoose";

const ledgerSchema = new Schema(
  {
    businessId: { type: Types.ObjectId, ref: "Business", required: true },
    name: { type: String, required: true, maxlength: 120 },
    description: { type: String, maxlength: 500 },
    type: {
      type: String,
      enum: ["school_fees", "cooperative", "savings", "repayment", "custom"],
      default: "custom",
    },
    currency: { type: String, default: "NGN" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ledgerSchema.index({ businessId: 1 });

export const Ledger = model("Ledger", ledgerSchema);
