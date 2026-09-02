import { describe, expect, it } from "vitest";

import { safeEndSessionUrl } from "@/shared/auth/logout-navigation";

describe("safeEndSessionUrl", () => {
  it("allows a backend-produced HTTPS identity-provider URL", () => {
    expect(safeEndSessionUrl("https://idp.example.test/logout?client_id=vibe")).toBe(
      "https://idp.example.test/logout?client_id=vibe",
    );
  });

  it.each([
    "http://idp.example.test/logout",
    "javascript:alert(1)",
    "https://user:password@idp.example.test/logout",
  ])("rejects an unsafe external end-session URL: %s", (url) => {
    expect(safeEndSessionUrl(url)).toBeUndefined();
  });

  it("allows a same-origin development callback", () => {
    expect(safeEndSessionUrl("/app/login")).toBe(`${window.location.origin}/app/login`);
  });
});
