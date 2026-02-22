import mongoose from "mongoose";

const complaintSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true },
  category: { type: String, required: true },
  urgency: { type: String, enum: ["low", "medium", "high"], default: "medium" },
  location: { type: String, required: true },
  description: { type: String, required: true },
  status: { type: String, enum: ["Pending", "In Progress", "Resolved", "Rejected"], default: "Pending" },
  progress: { type: Number, default: 20 },
  date: { type: String, required: true },
  imageUrl: { type: String, default: null },
  remarks: { type: String, default: null },
  proof: { type: String, default: null },
});

export const Complaint = mongoose.model("Complaint", complaintSchema);
