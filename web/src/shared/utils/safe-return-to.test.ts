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

  it("creates an application-scoped return path", () => {
    expect(appReturnTo("/overview", "?range=24h", "#health")).toBe("/app/overview?range=24h#health");
  });

  it("keeps the SSO hash in session storage but excludes it from server return_to", () => {
    expect(stageSsoReturnTo("/routing/rules?page=2#decision")).toBe("/app/routing/rules?page=2");
    expect(consumeSsoReturnTo()).toBe("/app/routing/rules?page=2#decision");
  });
});
