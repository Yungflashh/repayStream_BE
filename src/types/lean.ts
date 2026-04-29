import type { Types } from "mongoose";

/** Utility: replace _id with id in lean query results */
export type WithId<T> = Omit<T, "_id"> & { id: string };

/** Convert mongoose _id to id string */
export function toId(doc: { _id: Types.ObjectId } | null) {
  return doc ? doc._id.toHexString() : null;
}
