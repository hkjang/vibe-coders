import { describe, expect, it } from "vitest";

import { insightSearch } from "./insight-link";

describe("insightSearch", () => {
  it("builds the view an insight points at from the keys this screen owns", () => {
    expect(
      insightSearch({
        tab: "categories",
        parent: "dev",
        team: "플랫폼팀",
        metric: "cost",
        from: "2026-11-01",
        to: "2026-11-27",
      }),
    ).toBe(
      `?tab=categories&parent=dev&team=${encodeURIComponent("플랫폼팀")}&metric=cost&from=2026-11-01&to=2026-11-27`,
    );
    expect(insightSearch({ tab: "sessions", list: "requests", status: "failed" })).toBe(
      "?tab=sessions&list=requests&status=failed",
    );
  });

  it("ignores keys and values it does not own", () => {
    expect(
      insightSearch({
        tab: "models",
        token: "secret",
        category: "../../x",
        action: "destroy",
        metric: "bogus",
        from: "2026-11-27",
        to: "2026-11-01",
        redirect: "https://example.com",
      }),
    ).toBe("?tab=models");
  });

  it("omits defaults so the link is the canonical URL", () => {
    expect(insightSearch({ tab: "summary", metric: "sessions", list: "sessions", category: "dev" })).toBe(
      "?category=dev",
    );
    expect(insightSearch({ tab: "summary" })).toBe("");
  });

  it("offers no link when nothing usable is named", () => {
    expect(insightSearch({})).toBeUndefined();
    expect(insightSearch({ tab: "nowhere", foo: "bar" })).toBeUndefined();
  });
});
