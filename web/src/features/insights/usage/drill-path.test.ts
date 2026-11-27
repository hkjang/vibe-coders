import { describe, expect, it } from "vitest";

import { failedId, unclassifiedId } from "@/features/insights/charts/palette";

import {
  breadcrumb,
  categoryLevel,
  categoryNames,
  categoryPath,
  childLevelName,
  drillTarget,
  parentCategoryId,
} from "./drill-path";

const ref = (id: string, name: string) => ({
  id,
  name,
  level: id.split(".").length,
  parent_id: id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : "",
  top_id: id.split(".")[0] ?? id,
  enabled: true,
});

describe("category drill path", () => {
  it("reads the path, parent and level from the ID", () => {
    expect(categoryPath("")).toEqual([]);
    expect(categoryPath("dev")).toEqual(["dev"]);
    expect(categoryPath("dev.codegen.api")).toEqual(["dev", "dev.codegen", "dev.codegen.api"]);
    expect(parentCategoryId("dev.codegen.api")).toBe("dev.codegen");
    expect(parentCategoryId("dev")).toBe("");
    expect(categoryLevel("")).toBe(0);
    expect(categoryLevel("dev.codegen")).toBe(2);
  });

  it("names the level a breakdown lists", () => {
    expect(childLevelName("")).toBe("대분류");
    expect(childLevelName("dev")).toBe("중분류");
    expect(childLevelName("dev.codegen")).toBe("소분류");
    expect(childLevelName("dev.codegen.api")).toBe("소분류");
  });

  it("builds a breadcrumb from the root with known names and slug fallbacks", () => {
    const names = categoryNames([ref("dev", "소프트웨어 개발")], undefined, [
      null,
      ref("data", "데이터 분석"),
    ]);
    expect(breadcrumb("", names)).toEqual([{ id: "", label: "전체 업무" }]);
    expect(breadcrumb("dev.codegen", names)).toEqual([
      { id: "", label: "전체 업무" },
      { id: "dev", label: "소프트웨어 개발" },
      { id: "dev.codegen", label: "codegen" },
    ]);
  });

  it("lets a later reference rename a category", () => {
    const names = categoryNames([ref("dev", "개발")], [ref("dev", "소프트웨어 개발")]);
    expect(names.get("dev")).toBe("소프트웨어 개발");
  });

  it("drills into children while there are any, then to the category's sessions", () => {
    expect(drillTarget({ id: "dev", hasChildren: true })).toEqual({ kind: "children", parent: "dev" });
    expect(drillTarget({ id: "dev.codegen.api", hasChildren: false })).toEqual({
      kind: "sessions",
      category: "dev.codegen.api",
    });
  });

  it("sends the unclassified and failed rows to the matching requests", () => {
    expect(drillTarget({ id: unclassifiedId, hasChildren: false })).toEqual({
      kind: "requests",
      status: "unclassified",
    });
    expect(drillTarget({ id: failedId, hasChildren: true })).toEqual({ kind: "requests", status: "failed" });
  });
});
