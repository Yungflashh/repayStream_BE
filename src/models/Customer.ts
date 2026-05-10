import { Schema, model, Types } from "mongoose";

const customerSchema = new Schema(
  {
    name: { type: String, trim: true },
    phone: { type: String, required: true },
    email: { type: String, trim: true },
    businessId: { type: Types.ObjectId, ref: "Business", required: true },
    userId: { type: Types.ObjectId, ref: "User" }, // linked when customer claims portal
  },
  { timestamps: true }
);

customerSchema.index({ businessId: 1 });

export const Customer = model("Customer", customerSchema);
