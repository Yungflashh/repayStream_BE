import { Schema, model, Types } from "mongoose";

const auditLogSchema = new Schema(
  {
    actor: { type: String, required: true }, // "user:<id>" | "webhook:<provider>" | "system:retry"
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: Types.ObjectId },
    payload: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ entityType: 1, entityId: 1 });

export const AuditLog = model("AuditLog", auditLogSchema);
