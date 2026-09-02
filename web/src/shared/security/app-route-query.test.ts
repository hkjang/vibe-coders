import { afterEach, describe, expect, it } from "vitest";

import {
  locationStateWithSensitiveRejections,
  rejectedSensitiveQuery,
  sanitizeAppRouteHash,
  sanitizeAppRouteSearch,
  sanitizeWindowAppLocationBeforeBootstrap,
} from "@/shared/security/app-route-query";

function encoded(value: string, passes: number): string {
  let result = value;
  for (let pass = 0; pass < passes; pass += 1) result = encodeURIComponent(result);
  return result;
}

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

  it("preserves only strict Keycloak callback keys on login", () => {
    const opaqueCode = "eyJheader.eyJpayload.signature";
    expect(sanitizeAppRouteHash(`#kc_code=${opaqueCode}&token=private&safe=ignored`, "/app/login")).toBe(
      `#kc_code=${opaqueCode}`,
    );
    expect(sanitizeAppRouteHash(`#kc_code=${opaqueCode}`, "/app/gateway/models")).toBe("");
    expect(sanitizeAppRouteHash("#kc_access=private&kc_refresh=private", "/login")).toBe(
      "#kc_access=&kc_refresh=",
    );
  });

  it("preserves an opaque Keycloak code during pre-bootstrap cleanup without retaining other state", () => {
    const opaqueCode = "eyJheader.eyJpayload.signature";
    window.history.replaceState(
      { token: "state-private", usr: { clientSecret: "state-private" } },
      "",
      `/app/login#kc_code=${opaqueCode}&token=fragment-private`,
    );

    sanitizeWindowAppLocationBeforeBootstrap();

    expect(window.location.hash).toBe(`#kc_code=${opaqueCode}`);
    expect(JSON.stringify(window.history.state)).not.toContain("state-private");
    expect(window.location.href).not.toContain("fragment-private");
  });

  it("records only safe rejection metadata", () => {
    const state = locationStateWithSensitiveRejections(
      {
        appSensitiveQueryKeys: ["q", "token", "private-value"],
        providerDetailRejected: true,
        providerSearchRejected: true,
        ignoredFalseMarker: false,
        from: "test",
        nested: { api_key: "private-value" },
      },
      ["q", "token"],
    );
    expect(rejectedSensitiveQuery(state, "q")).toBe(true);
    expect(state).toEqual({
      appSensitiveQueryKeys: ["q"],
      providerDetailRejected: true,
      providerSearchRejected: true,
    });
    expect(JSON.stringify(state)).not.toContain("private-value");
  });

  it("preserves rejection markers only as an exact true boolean", () => {
    expect(
      locationStateWithSensitiveRejections(
        {
          providerDetailRejected: "true",
          providerSearchRejected: { rawProvider: "legacy,unsafe" },
          rawProvider: "legacy,unsafe",
        },
        [],
      ),
    ).toBeNull();
    expect(
      locationStateWithSensitiveRejections(
        {
          providerDetailRejected: true,
          providerSearchRejected: true,
          rawProvider: "legacy,unsafe",
        },
        [],
      ),
    ).toEqual({ providerDetailRejected: true, providerSearchRejected: true });
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

  it("rebuilds browser history from safe router keys without retaining arbitrary state", () => {
    window.history.replaceState(
      {
        idx: 4,
        key: "router-key_4",
        nested: { clientSecret: "history-private" },
        token: "history-private",
        usr: {
          appSensitiveQueryKeys: ["q", "history-private"],
          nested: { password: "history-private" },
          token: "history-private",
        },
      },
      "",
      "/app/gateway/providers?status=enabled",
    );

    sanitizeWindowAppLocationBeforeBootstrap();

    expect(window.history.state).toEqual({
      idx: 4,
      key: "router-key_4",
      usr: { appSensitiveQueryKeys: ["q"] },
    });
    expect(JSON.stringify(window.history.state)).not.toContain("history-private");
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

  it("rejects deeply encoded q, hash, and nested return_to values", () => {
    const deepSecret = encoded("api_key=deep-private", 7);
    expect(sanitizeAppRouteSearch("/gateway/models", `?q=${deepSecret}&provider=openai`).search).toBe(
      "?provider=openai",
    );
    expect(sanitizeAppRouteHash(`#${deepSecret}`)).toBe("");
    const nestedReturnTo = `/app/gateway/providers?q=${deepSecret}&status=enabled`;
    expect(sanitizeAppRouteSearch("/login", `?return_to=${encodeURIComponent(nestedReturnTo)}`).search).toBe(
      "",
    );
  });

  it("rejects scheme-less userinfo from q, hash parameters, and nested return targets", () => {
    const userinfo = "operator:password@example.invalid";
    expect(sanitizeAppRouteSearch("/gateway/providers", `?q=${userinfo}&status=enabled`).search).toBe(
      "?status=enabled",
    );
    expect(sanitizeAppRouteHash(`#next=${userinfo}`)).toBe("");
    const nestedReturnTo = `/app/gateway/models?q=${userinfo}&provider=openai`;
    expect(sanitizeAppRouteSearch("/login", `?return_to=${encodeURIComponent(nestedReturnTo)}`).search).toBe(
      "",
    );
  });
});
