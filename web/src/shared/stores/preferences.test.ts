import { describe, expect, it } from "vitest";

import { safeRefreshInterval } from "@/shared/stores/preferences";

describe("preference safety", () => {
  it("keeps automatic refresh opt-in and retires unsafe legacy defaults", () => {
    expect(safeRefreshInterval(undefined)).toBe(0);
    expect(safeRefreshInterval(15)).toBe(0);
    expect(safeRefreshInterval(30)).toBe(0);
    expect(safeRefreshInterval(60)).toBe(60);
    expect(safeRefreshInterval(300)).toBe(300);
  });
});
