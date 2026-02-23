import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { v2 as cloudinary } from "cloudinary";
import { Complaint } from "./models/Complaint.js";
import { Counter, getNextComplaintId } from "./models/Counter.js";
import { initDiscordBot, sendComplaintToDiscord } from "./services/discordBot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/civic-complaints";

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer config - memory storage for Cloudinary upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/i;
    const ext = path.extname(file.originalname).slice(1);
    if (allowed.test(ext)) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

const CORS_ORIGINS = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
  : ["http://localhost:5173", "http://127.0.0.1:5173"];
app.use(cors({ origin: CORS_ORIGINS }));
app.use(express.json());

// Seed sample data if collection is empty
const seedData = [
  { id: "CC123456", name: "John Doe", phone: "+1 555-0100", email: "john@example.com", category: "Roads & Potholes", location: "Main Street, Block A", description: "Large pothole causing traffic issues", status: "In Progress", progress: 60, date: "2026-02-15", imageUrl: null },
  { id: "CC789012", name: "Jane Smith", phone: "+1 555-0101", email: "jane@example.com", category: "Water Supply", location: "Park Avenue, Block B", description: "Water leakage in the main pipeline", status: "Resolved", progress: 100, date: "2026-02-10", imageUrl: null },
  { id: "CC345678", name: "Bob Wilson", phone: "+1 555-0102", email: "bob@example.com", category: "Street Lights", location: "Oak Road, Block C", description: "Multiple street lights not working", status: "Pending", progress: 20, date: "2026-02-17", imageUrl: null },
];

async function seedIfEmpty() {
  const count = await Complaint.countDocuments();
  if (count === 0) {
    await Complaint.insertMany(seedData);
    await Counter.findOneAndUpdate(
      { name: "complaintId" },
      { $set: { value: 689013 } },
      { upsert: true }
    );
    console.log("Seeded sample complaints");
  }
}

// Upload image to Cloudinary
async function uploadToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: "civic-complaints" },
      (err, result) => {
        if (err) reject(err);
        else resolve(result?.secure_url);
      }
    );
    uploadStream.end(file.buffer);
  });
}

const MAX_PENDING = 2;

// Health check (for deployment verification)
app.get("/api/health", (req, res) => res.json({ ok: true }));

// POST /api/complaints - Create complaint (max 2 pending per user)
app.post("/api/complaints", upload.array("images", 3), async (req, res) => {
  try {
    const { name, phone, email, category, urgency, location, description, existingComplaintIds } = req.body;
    if (!name || !phone || !email || !category || !location || !description) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    let ids = [];
    try {
      ids = existingComplaintIds ? JSON.parse(existingComplaintIds) : [];
    } catch {}
    if (Array.isArray(ids) && ids.length > 0) {
      const existing = await Complaint.find({
        id: { $in: ids.map((i) => String(i).toUpperCase()) },
        status: { $in: ["Pending", "In Progress"] },
      });
      if (existing.length >= MAX_PENDING) {
        return res.status(400).json({
          error: `Maximum ${MAX_PENDING} pending complaints allowed. Please wait for existing complaints to be resolved.`,
        });
      }
    }
    let imageUrls = [];
    const files = req.files || [];
    if (files.length > 0) {
      if (!process.env.CLOUDINARY_CLOUD_NAME) {
        return res.status(503).json({ error: "Image upload not configured. Set CLOUDINARY_* in .env" });
      }
      for (const file of files) {
        const url = await uploadToCloudinary(file);
        if (url) imageUrls.push(url);
      }
    }
    const id = await getNextComplaintId();
    const complaint = await Complaint.create({
      id,
      name,
      phone,
      email,
      category,
      urgency: urgency && ["low", "medium", "high"].includes(urgency) ? urgency : "medium",
      location,
      description,
      status: "Pending",
      progress: 20,
      date: new Date().toISOString().split("T")[0],
      imageUrls,
    });

    // Discord bot: create channel under urgency category and post complaint — non-blocking
    sendComplaintToDiscord(complaint.toObject()).catch((err) =>
      console.error("[Discord] Notification failed:", err)
    );

    res.status(201).json(complaint);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to create complaint" });
  }
});

// GET /api/complaints/:id - Get complaint by ID
app.get("/api/complaints/:id", async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const complaint = await Complaint.findOne({ id });
    if (!complaint) {
      return res.status(404).json({ error: "Complaint not found" });
    }
    res.json(complaint);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch complaint" });
  }
});

// GET /api/stats - Dashboard stats
app.get("/api/stats", async (req, res) => {
  try {
    const total = await Complaint.countDocuments();
    const resolved = await Complaint.countDocuments({ status: "Resolved" });
    const satisfaction = total > 0 ? Math.round((resolved / total) * 100) : 98;
    res.json({
      totalComplaints: total,
      resolvedIssues: resolved,
      satisfactionRate: satisfaction,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch stats" });
  }
});

async function start() {
  const connected = await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB", connected.connection.host);
  await seedIfEmpty();

  initDiscordBot();

  app.listen(PORT, () => {
    console.log(`Backend running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
