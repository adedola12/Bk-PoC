import express from "express";
import { ReviewItem } from "../models/ReviewItem.js";

const router = express.Router();

/* ─── GET /api/review — open items first, with product context ─── */
router.get("/", async (req, res, next) => {
  try {
    const items = await ReviewItem.find({})
      .sort({ status: 1, createdAt: -1 })
      .limit(300)
      .populate("ipr", "identity taxonomyPath variantLabel")
      .populate("upload", "originalName")
      .lean();
    res.json(items);
  } catch (err) {
    next(err);
  }
});

/* ─── POST /api/review/:id/resolve — every correction is calibration data (§9) ─── */
router.post("/:id/resolve", async (req, res, next) => {
  try {
    const { resolution, correctedValue = null } = req.body; // accepted | corrected | rejected
    if (!["accepted", "corrected", "rejected"].includes(resolution)) {
      return res.status(400).json({ error: "resolution must be accepted | corrected | rejected" });
    }
    const item = await ReviewItem.findById(req.params.id);
    if (!item) return res.status(404).json({ error: "Review item not found" });

    item.status = resolution === "rejected" ? "dismissed" : "resolved";
    item.resolution = resolution;
    item.correctedValue = correctedValue;
    item.resolvedAt = new Date();
    await item.save();
    res.json(item);
  } catch (err) {
    next(err);
  }
});

export default router;
