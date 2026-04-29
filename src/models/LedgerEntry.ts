/**
 * Phase 2: Individual debit/credit entries in a ledger.
 * Supports historical records, balance tracking, and reconciliation.
 */
import { Schema, model, Types } from "mongoose";

const ledgerEntrySchema = new Schema(
  {
    ledgerId: { type: Types.ObjectId, ref: "Ledger", required: true },
    customerId: { type: Types.ObjectId, ref: "Customer", required: true },
    planId: { type: Types.ObjectId, ref: "RepaymentPlan" },
    paymentAttemptId: { type: Types.ObjectId, ref: "PaymentAttempt" },
    type: { type: String, enum: ["debit", "credit", "adjustment"], required: true },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    description: { type: String, maxlength: 300 },
    reference: { type: String },
    reconciledAt: { type: Date },
    reconciledBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ledgerEntrySchema.index({ ledgerId: 1, createdAt: -1 });
ledgerEntrySchema.index({ customerId: 1, createdAt: -1 });
ledgerEntrySchema.index({ reconciledAt: 1 }, { sparse: true });

export const LedgerEntry = model("LedgerEntry", ledgerEntrySchema);
