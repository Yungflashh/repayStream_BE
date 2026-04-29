import { Schema, model, Types } from "mongoose";

const businessSchema = new Schema(
  {
    name: { type: String, required: true, minlength: 2, maxlength: 120 },
    userId: { type: Types.ObjectId, ref: "User", required: true, unique: true },
  },
  { timestamps: true }
);

export const Business = model("Business", businessSchema);
