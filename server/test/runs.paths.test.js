import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runsRoot, toRunRelative, resolveRunPath } from "../services/runs.js";

/**
 * Artifact paths must survive the machine that wrote them. Records created on
 * Render and on a Windows dev box carried absolute paths that named nothing
 * after the move to EC2, and every read of them failed with a raw ENOENT.
 */
const RUN_ID = "2026-07-29T18-42-27-196Z_intake";
const REL = `${RUN_ID}/intake/HD BOOKET.pdf`;
const ABS = path.join(runsRoot(), RUN_ID, "intake", "HD BOOKET.pdf");

describe("run artifact paths", () => {
  beforeAll(() => {
    fs.mkdirSync(path.dirname(ABS), { recursive: true });
    fs.writeFileSync(ABS, "pdf");
  });
  afterAll(() => fs.rmSync(path.join(runsRoot(), RUN_ID), { recursive: true, force: true }));

  it("stores paths relative to the runs root", () => {
    expect(toRunRelative(ABS)).toBe(REL);
  });

  it("resolves a run-relative path", () => {
    expect(resolveRunPath(REL)).toBe(ABS);
  });

  it("re-roots a Render absolute path onto this machine", () => {
    expect(resolveRunPath(`/opt/render/project/src/runs/${REL}`)).toBe(ABS);
  });

  it("re-roots a Windows absolute path read on Linux", () => {
    const win = `C:\\Users\\ADLM\\source\\repos\\bk-ingest\\runs\\${RUN_ID}\\intake\\HD BOOKET.pdf`;
    expect(resolveRunPath(win)).toBe(ABS);
  });

  it("returns null when the artifact is not on this deployment", () => {
    // The distinction the extract route depends on: a missing file is a 409
    // "re-upload it", never a 500 with another machine's layout in the message.
    expect(resolveRunPath(`${RUN_ID}/intake/never-migrated.pdf`)).toBeNull();
    expect(resolveRunPath(null)).toBeNull();
  });

  it("refuses to escape the runs root", () => {
    expect(resolveRunPath("../../../../etc/passwd")).toBeNull();
    expect(resolveRunPath("/etc/passwd")).toBeNull();
  });

  it("leaves a path outside the runs root untouched rather than inventing one", () => {
    expect(toRunRelative("/etc/passwd")).toBe("/etc/passwd");
    expect(toRunRelative(null)).toBeNull();
  });
});
