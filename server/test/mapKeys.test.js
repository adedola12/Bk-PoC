import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import { sanitizeMapKeys } from "../services/mapKeys.js";

/**
 * A single mis-parsed spec label ("3.7" read as its own attribute name) failed
 * the whole IPR insert with "Cast to Map failed", taking every other attribute
 * on that product with it. These lock in both halves of the fix: the illegal
 * key is repaired, and nothing is lost when the repair collides.
 */
describe("sanitizeMapKeys", () => {
  it("leaves legal keys untouched and reports no rewrites", () => {
    const { map, rewrites } = sanitizeMapKeys({ Power: { value: "5kW" }, Speed: { value: "10" } });
    expect(map).toEqual({ Power: { value: "5kW" }, Speed: { value: "10" } });
    expect(rewrites).toEqual([]);
  });

  it("replaces dots — the key from the reported crash", () => {
    const { map, rewrites } = sanitizeMapKeys({ "3.7": { value: "kW" } });
    expect(map).toEqual({ "3_7": { value: "kW" } });
    expect(rewrites).toEqual([{ from: "3.7", to: "3_7" }]);
  });

  it("replaces a leading $, which Mongo reads as an operator", () => {
    const { rewrites } = sanitizeMapKeys({ $price: { value: "12" } });
    expect(rewrites).toEqual([{ from: "$price", to: "_price" }]);
  });

  it("suffixes rather than overwrite when a repair collides", () => {
    const { map, rewrites } = sanitizeMapKeys({ "3_7": { value: "legal" }, "3.7": { value: "repaired" } });
    expect(map["3_7"]).toEqual({ value: "legal" });
    expect(map["3_7_2"]).toEqual({ value: "repaired" });
    expect(rewrites).toEqual([{ from: "3.7", to: "3_7_2" }]);
    expect(Object.keys(map)).toHaveLength(2); // nothing dropped
  });

  it("handles a null/undefined map", () => {
    expect(sanitizeMapKeys(undefined)).toEqual({ map: {}, rewrites: [] });
    expect(sanitizeMapKeys(null)).toEqual({ map: {}, rewrites: [] });
  });

  it("produces keys Mongoose actually accepts", () => {
    // The unit assertions above encode our reading of the Mongo rules; this
    // one checks that reading against the caster that rejected the input.
    const schema = new mongoose.Schema({ attributes: { type: Map, of: new mongoose.Schema({ value: String }, { _id: false }) } });
    const Model = mongoose.models.__MapKeyProbe ?? mongoose.model("__MapKeyProbe", schema);

    const dirty = { Power: { value: "5kW" }, "3.7": { value: "kW" }, $price: { value: "12" } };
    expect(new Model({ attributes: dirty }).validateSync()?.message).toMatch(/Cast to Map failed/);

    const { map } = sanitizeMapKeys(dirty);
    expect(new Model({ attributes: map }).validateSync()).toBeUndefined();
  });
});
