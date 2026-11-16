import { afterEach, describe, expect, it } from "vitest";

import {
  sanitizeAppRouteSearch,
  sanitizeWindowAppLocationBeforeBootstrap,
} from "@/shared/security/app-route-query";
import { shouldAttemptSilentSso } from "@/shared/auth/silent-sso";

afterEach(() => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});

describe("Keycloak callback refusal route", () => {
  it.each(["none", "error"])("keeps the %s outcome through pre-bootstrap cleanup", (outcome) => {
    const returnTo = "/app/overview?tab=usage&trend=30d";
    window.history.replaceState(
      { token: "private-state" },
      "",
      `/app/login?sso=${outcome}&return_to=${encodeURIComponent(returnTo)}&token=private-query`,
    );

    sanitizeWindowAppLocationBeforeBootstrap();

    const search = new URLSearchParams(window.location.search);
    expect(search.get("sso")).toBe(outcome);
    expect(search.get("return_to")).toBe(returnTo);
    expect(search.has("token")).toBe(false);
    expect(JSON.stringify(window.history.state)).not.toContain("private-state");
    expect(shouldAttemptSilentSso({ keycloak_enabled: true, auto_login: true })).toBe(false);
  });

  it.each([
    "?sso=",
    "?sso=NONE",
    "?sso=login_required",
    "?sso=none&sso=error",
    "?sso=none&sso=none",
    "?sso=none%20",
    "?sso=Bearer%20private-token",
  ])("drops unsupported or ambiguous outcomes: %s", (search) => {
    expect(sanitizeAppRouteSearch("/app/login", search).search).toBe("");
  });

  it("does not allow the callback outcome on an unrelated feature route", () => {
    expect(sanitizeAppRouteSearch("/app/overview", "?sso=none&tab=usage").search).toBe("?tab=usage");
  });
});
