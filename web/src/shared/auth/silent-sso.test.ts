import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginSilentSso,
  clearSilentSsoState,
  markSignedOut,
  shouldAttemptSilentSso,
  silentSsoNavigation,
} from "@/shared/auth/silent-sso";

const enabled = { keycloak_enabled: true, auto_login: true } as const;
const home = { pathname: "/app/overview", search: "" };

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("shouldAttemptSilentSso", () => {
  it("requires both SSO and auto_login to be on", () => {
    expect(shouldAttemptSilentSso({ keycloak_enabled: true, auto_login: false }, home)).toBe(false);
    expect(shouldAttemptSilentSso({ keycloak_enabled: false, auto_login: true }, home)).toBe(false);
    expect(shouldAttemptSilentSso({ keycloak_enabled: true }, home)).toBe(false);
    expect(shouldAttemptSilentSso(enabled, home)).toBe(true);
  });

  it("never starts from the login route or the gateway auth endpoints", () => {
    expect(shouldAttemptSilentSso(enabled, { pathname: "/app/login", search: "" })).toBe(false);
    expect(shouldAttemptSilentSso(enabled, { pathname: "/app/login", search: "?return_to=%2Fapp%2Fx" })).toBe(
      false,
    );
    expect(shouldAttemptSilentSso(enabled, { pathname: "/auth/keycloak/callback", search: "?state=s" })).toBe(
      false,
    );
  });

  it("honours the refusal marker the callback leaves in the URL even with clean storage", () => {
    expect(shouldAttemptSilentSso(enabled, { pathname: "/app/overview", search: "?sso=none" })).toBe(false);
    expect(shouldAttemptSilentSso(enabled, { pathname: "/app/overview", search: "?sso=error" })).toBe(false);
    expect(shouldAttemptSilentSso(enabled, { pathname: "/app/overview", search: "?tab=spans" })).toBe(true);
  });

  it("tries once per tab session and not again after a refusal", () => {
    expect(shouldAttemptSilentSso(enabled, home)).toBe(true);
    vi.spyOn(silentSsoNavigation, "toProvider").mockImplementation(() => undefined);
    beginSilentSso("/auth/keycloak/login", "/app/overview");
    expect(shouldAttemptSilentSso(enabled, home)).toBe(false);
    // A session appearing again lifts the suppression (for example after a manual login).
    clearSilentSsoState();
    expect(shouldAttemptSilentSso(enabled, home)).toBe(true);
  });

  it("stays quiet after a deliberate sign-out until a session exists again", () => {
    markSignedOut();
    expect(shouldAttemptSilentSso(enabled, home)).toBe(false);
    clearSilentSsoState();
    expect(shouldAttemptSilentSso(enabled, home)).toBe(true);
  });

  it("fails closed when sessionStorage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(shouldAttemptSilentSso(enabled, home)).toBe(false);
  });
});

describe("beginSilentSso", () => {
  it("navigates top-level to the gateway login leg with prompt=none and the return path", () => {
    const navigate = vi.spyOn(silentSsoNavigation, "toProvider").mockImplementation(() => undefined);
    beginSilentSso("/auth/keycloak/login", "/app/traces/abc?tab=spans");
    expect(navigate).toHaveBeenCalledTimes(1);
    const target = new URL(navigate.mock.calls[0]?.[0] ?? "");
    expect(target.origin).toBe(window.location.origin);
    expect(target.pathname).toBe("/auth/keycloak/login");
    expect(target.searchParams.get("prompt")).toBe("none");
    expect(target.searchParams.get("return_to")).toBe("/app/traces/abc?tab=spans");
  });
});
