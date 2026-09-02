import { afterEach, describe, expect, it } from "vitest";

import {
  locationStateWithSensitiveRejections,
  rejectedSensitiveQuery,
  sanitizeAppRouteHash,
  sanitizeAppRouteSearch,
  sanitizeWindowAppLocationBeforeBootstrap,
} from "@/shared/security/app-route-query";

describe("app route query security", () => {
  const initialURL = window.location.href;

  afterEach(() => window.history.replaceState(null, "", initialURL));

  it("keeps only the exact safe allowlist for provider and model routes", () => {
    expect(
      sanitizeAppRouteSearch(
        "/app/gateway/providers",
        "?q=openai&status=healthy&range=7d&page=2&provider=openai&team=platform",
      ),
    ).toEqual({
      rejectedKeys: ["team"],
      sensitiveKeys: [],
      search: "?q=openai&status=healthy&range=7d&page=2&provider=openai",
    });
    expect(
      sanitizeAppRouteSearch(
        "/gateway/models",
        "?q=gpt&provider=openai&model=gpt-5&model_provider=openai&source=live&status=available&range=24h&page=3",
      ).search,
    ).toBe(
      "?q=gpt&provider=openai&model=gpt-5&model_provider=openai&source=live&status=available&range=24h&page=3",
    );
  });

  it("removes unknown credential parameters and allowed values that contain secrets", () => {
    const result = sanitizeAppRouteSearch(
      "/app/gateway/models",
      "?q=Bearer+private&provider=openai&token=private&api_key=also-private",
    );
    expect(result.search).toBe("?provider=openai");
    expect(result.rejectedKeys).toEqual(["q", "token", "api_key"]);
    expect(result.sensitiveKeys).toEqual(["q", "token", "api_key"]);
  });

  it("allows ordinary hashes but drops credential-like fragments", () => {
    expect(sanitizeAppRouteHash("#details")).toBe("#details");
    expect(sanitizeAppRouteHash("#token=private")).toBe("");
    expect(sanitizeAppRouteHash("#Bearer+privatecredential")).toBe("");
  });

  it("records only safe rejection metadata", () => {
    const state = locationStateWithSensitiveRejections({ from: "test" }, ["q"]);
    expect(rejectedSensitiveQuery(state, "q")).toBe(true);
    expect(state).toEqual({ from: "test", appSensitiveQueryKeys: ["q"] });
  });

  it("replaces the browser URL before bootstrap without retaining a secret", () => {
    window.history.replaceState(null, "", "/app/gateway/providers?q=sk-private12345678&status=enabled");
    sanitizeWindowAppLocationBeforeBootstrap();
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/app/gateway/providers?status=enabled",
    );
    expect(JSON.stringify(window.history.state)).not.toContain("private12345678");
    expect(rejectedSensitiveQuery(window.history.state?.usr, "q")).toBe(true);
  });

  it("removes a secret-like hash even when the query is already safe", () => {
    window.history.replaceState(null, "", "/app/gateway/models?provider=openai#token=private");
    sanitizeWindowAppLocationBeforeBootstrap();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/app/gateway/models?provider=openai",
    );
  });

  it("rejects double-encoded secrets without removing safe deep-link state", () => {
    const result = sanitizeAppRouteSearch(
      "/app/gateway/providers",
      "?q=%2561pi_key%253Dprivate&status=enabled&range=7d",
    );
    expect(result.search).toBe("?status=enabled&range=7d");
    expect(result.sensitiveKeys).toEqual(["q"]);
    expect(sanitizeAppRouteHash("#%2574oken%253Dprivate")).toBe("");
  });
});
