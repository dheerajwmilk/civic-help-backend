import mongoose from "mongoose";

const counterSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  value: { type: Number, default: 0 },
});

export const Counter = mongoose.model("Counter", counterSchema);

export async function getNextComplaintId() {
  const counter = await Counter.findOneAndUpdate(
    { name: "complaintId" },
    { $inc: { value: 1 } },
    { new: true, upsert: true }
  );
  return `CC${100000 + counter.value}`;
}
