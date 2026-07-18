import express from "express";
import { TodoItem } from "../models/TodoItem.js";

const router = express.Router();

/* ─── GET /api/todos — the D4 first-class queue ─── */
router.get("/", async (req, res, next) => {
  try {
    const items = await TodoItem.find({}).sort({ status: 1, createdAt: -1 }).limit(500).lean();
    res.json(items);
  } catch (err) {
    next(err);
  }
});

/* ─── POST /api/todos/:id/done ─── */
router.post("/:id/done", async (req, res, next) => {
  try {
    const item = await TodoItem.findByIdAndUpdate(
      req.params.id,
      { status: "done", doneAt: new Date() },
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Todo not found" });
    res.json(item);
  } catch (err) {
    next(err);
  }
});

export default router;
