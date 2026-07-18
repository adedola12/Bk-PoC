import express from "express";
import { PriceEvent } from "../models/PriceEvent.js";
import { TodoItem } from "../models/TodoItem.js";
import { IPR } from "../models/IPR.js";
import { normCode } from "../stages/vision_extract.js";

const router = express.Router();

/* ─── GET /api/prices/compare?category= — cross-brand within a category (D10) ─── */
router.get("/compare", async (req, res, next) => {
  try {
    const category = req.query.category || "Plumbing & Sanitary Ware > Bathroom Accessories";
    const iprs = await IPR.find({ taxonomyPath: new RegExp(`^${category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })
      .select("identity taxonomyPath variantLabel")
      .lean();
    const bySku = new Map(iprs.map((i) => [normCode(i.identity?.productCode?.value), i]));

    const events = await PriceEvent.find({}).sort({ effectiveDate: 1 }).lean();
    const latest = new Map();
    for (const e of events) latest.set(normCode(e.sku), e); // last write wins = latest event

    const rows = [];
    for (const [sku, ipr] of bySku) {
      const e = latest.get(sku);
      rows.push({
        sku: ipr.identity?.productCode?.value,
        name: ipr.identity?.name?.value ?? null,
        brand: ipr.identity?.brand?.value ?? null,
        variantLabel: ipr.variantLabel,
        price: e?.price ?? null,
        currency: e?.currency ?? "NGN",
        effectiveDate: e?.effectiveDate ?? null,
        method: e?.method ?? null,
      });
    }
    res.json({ category, rows });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /api/prices/:sku — append-only history ─── */
router.get("/:sku", async (req, res, next) => {
  try {
    const events = await PriceEvent.find({ sku: new RegExp(`^${normCode(req.params.sku)}$`, "i") })
      .sort({ effectiveDate: -1, createdAt: -1 })
      .lean();
    // normalize lookup: stored skus keep original formatting
    const all = events.length
      ? events
      : (await PriceEvent.find({}).lean()).filter((e) => normCode(e.sku) === normCode(req.params.sku));
    res.json(all);
  } catch (err) {
    next(err);
  }
});

/* ─── POST /api/prices/manual — D4 manual entry (appends, never overwrites) ─── */
router.post("/manual", async (req, res, next) => {
  try {
    const { sku, variant = null, vendor = "Satkay Limited", brand, price, currency = "NGN" } = req.body;
    if (!sku || !brand || !(price > 0)) {
      return res.status(400).json({ error: "sku, brand and a positive price are required" });
    }
    const event = await PriceEvent.create({
      sku,
      variant,
      vendor,
      brand,
      price,
      currency,
      sourceFile: "manual entry",
      effectiveDate: new Date(),
      method: "manual",
    });
    await TodoItem.updateMany(
      { type: "price_missing", sku, status: "open" },
      { status: "done", doneAt: new Date() }
    );
    res.status(201).json(event);
  } catch (err) {
    next(err);
  }
});

/* ─── POST /api/prices/reupload — D4 delta: price events ONLY, nothing else touched ─── */
router.post("/reupload", async (req, res, next) => {
  try {
    const { sourceFile = "re-upload", prices = [] } = req.body;
    if (!prices.length) return res.status(400).json({ error: "prices[] required: {sku, brand, price, currency?}" });

    const appended = [];
    const unmatched = [];
    for (const p of prices) {
      const ipr = (await IPR.find({}).select("identity").lean()).find(
        (i) => normCode(i.identity?.productCode?.value) === normCode(p.sku)
      );
      if (!ipr) {
        unmatched.push(p.sku); // unknown identity — flagged, not guessed (§6.3)
        continue;
      }
      const event = await PriceEvent.create({
        sku: ipr.identity.productCode.value,
        variant: null,
        vendor: p.vendor ?? "Satkay Limited",
        brand: p.brand ?? ipr.identity?.brand?.value ?? "unknown",
        price: p.price,
        currency: p.currency ?? "NGN",
        sourceFile,
        effectiveDate: new Date(),
        method: "reupload_delta",
      });
      appended.push(event._id);
      await TodoItem.updateMany(
        { type: "price_missing", sku: ipr.identity.productCode.value, status: "open" },
        { status: "done", doneAt: new Date() }
      );
    }
    res.status(201).json({ appended: appended.length, unmatched });
  } catch (err) {
    next(err);
  }
});

export default router;
