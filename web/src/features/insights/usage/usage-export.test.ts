import { describe, expect, it } from "vitest";

import { exportFilename, exportQuery, exportView } from "./usage-export";

const base = { from: "2026-10-29", to: "2026-11-27", compare: "prev", metric: "cost", team: "ops" } as const;

describe("usage CSV export", () => {
  it("maps each tab to the server table it exports", () => {
    expect(exportView("summary", "sessions")).toBe("categories");
    expect(exportView("categories", "sessions")).toBe("categories");
    expect(exportView("teams", "sessions")).toBe("teams");
    expect(exportView("models", "requests")).toBe("models");
    expect(exportView("sessions", "sessions")).toBe("sessions");
    expect(exportView("sessions", "requests")).toBe("requests");
    expect(exportView("trends", "sessions")).toBeUndefined();
    expect(exportView("productivity", "sessions")).toBeUndefined();
  });

  it("carries the current filters and the view", () => {
    expect(exportQuery(base, "teams", { parent: "", status: "" })).toEqual({ ...base, view: "teams" });
  });

  it("narrows a drilled-down category export to that category unless a category filter is set", () => {
    expect(exportQuery(base, "categories", { parent: "dev", status: "" })).toEqual({
      ...base,
      category: "dev",
      view: "categories",
    });
    expect(
      exportQuery({ ...base, category: "data.sql" }, "categories", { parent: "dev", status: "" }).category,
    ).toBe("data.sql");
    expect(exportQuery(base, "teams", { parent: "dev", status: "" })).not.toHaveProperty("category");
  });

  it("keeps the request list's status filter for a request export only", () => {
    expect(exportQuery(base, "requests", { parent: "", status: "failed" }).status).toBe("failed");
    expect(exportQuery(base, "sessions", { parent: "", status: "failed" })).not.toHaveProperty("status");
  });

  it("names the file after the view and the period", () => {
    expect(exportFilename({ ...base, view: "models" })).toBe("work-usage-models-2026-10-29_2026-11-27.csv");
  });
});
