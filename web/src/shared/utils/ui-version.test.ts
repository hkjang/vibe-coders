import { describe, expect, it } from "vitest";

import { staleBundle } from "./ui-version";

describe("staleBundle", () => {
  it("warns only when two release versions differ", () => {
    expect(staleBundle("v0.86.61", "v0.86.62")).toBe(true);
    expect(staleBundle("v0.86.62", "v0.86.62")).toBe(false);
  });

  it("ignores development and CI builds", () => {
    expect(staleBundle("dev", "v0.86.62")).toBe(false);
    expect(staleBundle("ci-abc123", "v0.86.62")).toBe(false);
    expect(staleBundle("v0.86.62", "확인 불가")).toBe(false);
  });
});
