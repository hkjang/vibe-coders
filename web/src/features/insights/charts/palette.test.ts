import { describe, expect, it } from "vitest";

import {
  categoryPaint,
  failedId,
  levelPaints,
  paintFill,
  paintSlotCount,
  restId,
  siblingPaints,
  slotPaint,
  topCategoryId,
  unclassifiedId,
} from "./palette";

const defaults = [
  "dev",
  "infra",
  "itsm",
  "security",
  "data",
  "office",
  "planning",
  "support",
  "knowledge",
  "ai",
  "automation",
];

describe("category paints", () => {
  it("gives every default top-level category its own paint", () => {
    const keys = defaults.map((id) => categoryPaint(id).key);
    expect(new Set(keys).size).toBe(defaults.length);
  });

  it("keeps a category's paint whatever else is on screen and for its descendants", () => {
    expect(categoryPaint("dev")).toEqual(categoryPaint("dev.codegen.api"));
    expect(levelPaints(["data", "dev"], true).get("dev")).toEqual(categoryPaint("dev"));
    expect(levelPaints(["dev"], true).get("dev")).toEqual(categoryPaint("dev"));
  });

  it("reuses a hue only with a hatch", () => {
    expect(slotPaint(1)).toEqual({ key: "s1", colorVar: "--wi-cat-1", hatched: false });
    expect(slotPaint(9)).toEqual({ key: "s9", colorVar: "--wi-cat-1", hatched: true });
    expect(slotPaint(99).key).toBe(`s${paintSlotCount}`);
  });

  it("paints the catch-all, unclassified and failed rows apart from real categories", () => {
    expect(categoryPaint("other").colorVar).toBe("--wi-cat-neutral");
    expect(categoryPaint(restId).colorVar).toBe("--wi-cat-neutral");
    expect(categoryPaint(unclassifiedId)).toMatchObject({ colorVar: "--wi-cat-unclassified", hatched: true });
    expect(categoryPaint(failedId)).toMatchObject({ colorVar: "--wi-cat-failed", hatched: true });
  });

  it("assigns an unknown top-level category a stable paint", () => {
    expect(categoryPaint("legal")).toEqual(categoryPaint("legal"));
    expect(categoryPaint("legal").colorVar).toMatch(/^--wi-cat-[1-8]$/u);
  });

  it("tells siblings apart by their sorted position, not by their order of arrival", () => {
    const first = siblingPaints(["dev.test", "dev.codegen", "dev.review"]);
    const second = siblingPaints(["dev.review", "dev.codegen", "dev.test", unclassifiedId]);
    for (const id of ["dev.codegen", "dev.review", "dev.test"]) expect(first.get(id)).toEqual(second.get(id));
    expect(new Set([...first.values()].map((paint) => paint.key)).size).toBe(first.size);
    expect(second.get(unclassifiedId)?.colorVar).toBe("--wi-cat-unclassified");
  });

  it("derives the top-level ID and the SVG fill", () => {
    expect(topCategoryId("dev.codegen.api")).toBe("dev");
    expect(topCategoryId("dev")).toBe("dev");
    expect(paintFill(slotPaint(2), "c1")).toBe("var(--wi-cat-2)");
    expect(paintFill(slotPaint(10), "c1")).toBe("url(#c1-s10)");
  });
});
