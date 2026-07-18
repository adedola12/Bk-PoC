import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  readTemplateSchema,
  readDataRows,
  templateRowsToIprs,
  iprsToTemplateRows,
  emitRows,
} from "../emitter/index.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const TEMPLATE = path.join(FIXTURES, "catalogue_template_Sanitary-Wash_Basins___Pedestals.xlsx");
const GOLDEN = path.join(FIXTURES, "01_Twyford__Sanitary_Ware__Wash_Basins__Pedestal.xlsx");

describe("D6 template reader — schema comes from the file, never hardcoded", () => {
  it("reads the 30-column contract with required markers and dropdowns", async () => {
    const schema = await readTemplateSchema(TEMPLATE);
    expect(schema.columns.length).toBeGreaterThanOrEqual(28);
    expect(schema.columns.filter((c) => c.required).length).toBeGreaterThanOrEqual(10);
    expect(schema.columns.find((c) => c.name === "System Product Name")?.formula).toBe(true);
    expect(Object.keys(schema.dropdowns).length).toBeGreaterThanOrEqual(5);
    expect(schema.maxRows).toBe(500);
  });
});

describe("Twyford golden round-trip (emitter regression, T2/T6 anchor)", () => {
  it("read golden → IPRs → emit → lossless content diff", async () => {
    const { rows: original } = await readDataRows(GOLDEN);
    expect(original.length).toBe(21); // KB §2: 21 products

    const iprs = templateRowsToIprs(original, path.basename(GOLDEN));
    expect(iprs[0].identity.brand.value).toBeTruthy();
    expect(iprs[0].identity.brand.method).toBe("rule");
    expect(iprs[0].identity.brand.confidence).toBe(1);

    const back = iprsToTemplateRows(iprs);
    const out = path.join(os.tmpdir(), `twyford_rt_${Date.now()}.xlsx`);
    const written = await emitRows(GOLDEN, back, out);
    expect(written).toHaveLength(1);

    const { rows: emitted } = await readDataRows(out);
    expect(emitted.length).toBe(original.length);
    original.forEach((orig, i) => {
      expect(emitted[i].values).toEqual(orig.values);
    });
    fs.unlinkSync(out);
  });

  it("shards above the template's own row cap", async () => {
    const { schema, rows } = await readDataRows(GOLDEN);
    const many = Array.from({ length: schema.maxRows + 1 }, (_, i) => ({
      ...rows[0].values,
      "Unique Product Name": `Row ${i}`,
    }));
    const out = path.join(os.tmpdir(), `shard_test_${Date.now()}.xlsx`);
    const written = await emitRows(GOLDEN, many, out);
    expect(written).toHaveLength(2);
    written.forEach((f) => fs.unlinkSync(f));
  }, 30000);
});
