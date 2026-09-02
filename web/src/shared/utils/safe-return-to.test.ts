import { describe, expect, it } from "vitest";

import {
  appReturnTo,
  consumeSsoReturnTo,
  safeReturnTo,
  stageSsoReturnTo,
} from "@/shared/utils/safe-return-to";

describe("safeReturnTo", () => {
  it.each(["https://attacker.example/app/overview", "//attacker.example/app", "/admin", "/app.evil"])(
    "rejects an unsafe return target: %s",
    (target) => {
      expect(safeReturnTo(target)).toBe("/overview");
    },
  );

  it("returns a router-relative app path with query and hash", () => {
    expect(safeReturnTo("/app/routing/rules?page=2#decision")).toBe("/routing/rules?page=2#decision");
  });

  it("removes unknown and credential-like values from nested return targets", () => {
    expect(
      safeReturnTo("/app/gateway/providers?q=openai&status=healthy&token=private&api_key=private#details"),
    ).toBe("/gateway/providers?q=openai&status=healthy#details");
    expect(safeReturnTo("/app/gateway/models?q=Bearer%20private&provider=openai")).toBe(
      "/gateway/models?provider=openai",
    );
    expect(safeReturnTo("/app/gateway/providers?q=%2561pi_key%253Dprivate&status=enabled")).toBe(
      "/gateway/providers?status=enabled",
    );
  });

  it("creates an application-scoped return path", () => {
    expect(appReturnTo("/overview", "?range=24h&token=private", "#health")).toBe(
      "/app/overview?range=24h#health",
    );
  });

  it("keeps the SSO hash in session storage but excludes it from server return_to", () => {
    expect(stageSsoReturnTo("/routing/rules?page=2#decision")).toBe("/app/routing/rules?page=2");
    expect(consumeSsoReturnTo()).toBe("/app/routing/rules?page=2#decision");
  });
});
