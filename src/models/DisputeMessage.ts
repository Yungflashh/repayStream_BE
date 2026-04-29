import { Schema, model, Types } from "mongoose";

const disputeMessageSchema = new Schema(
  {
    threadId: { type: Types.ObjectId, ref: "DisputeThread", required: true },
    senderType: { type: String, enum: ["customer", "business", "system"], required: true },
    senderId: { type: Types.ObjectId, ref: "User" },
    body: { type: String, required: true, maxlength: 2000 },
    attachments: [{ type: String }], // URLs for future file uploads
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

disputeMessageSchema.index({ threadId: 1, createdAt: 1 });

export const DisputeMessage = model("DisputeMessage", disputeMessageSchema);
