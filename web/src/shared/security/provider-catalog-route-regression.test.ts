import { afterEach, describe, expect, it } from "vitest";

import { featureQueryKeys } from "@/features/registry";
import {
  sanitizeAppRouteSearch,
  sanitizeWindowAppLocationBeforeBootstrap,
} from "@/shared/security/app-route-query";
import {
  appReturnTo,
  consumeSsoReturnTo,
  safeReturnTo,
  stageSsoReturnTo,
} from "@/shared/utils/safe-return-to";

// Independent public contract: deliberately do not import the new product parser.
const sorts = [
  "name_asc",
  "name_desc",
  "priority_asc",
  "priority_desc",
  "timeout_asc",
  "timeout_desc",
] as const;
const modelSorts = [
  "model_asc",
  "model_desc",
  "provider_asc",
  "provider_desc",
  "quality_asc",
  "quality_desc",
  "success_asc",
  "success_desc",
  "input_price_asc",
  "input_price_desc",
  "output_price_asc",
  "output_price_desc",
] as const;
const providerPaths = ["/gateway/providers", "/providers"] as const;
const originalURL = window.location.href;
const originalState: unknown = window.history.state;
const secret = `vc_sk_${"a".repeat(43)}`;

afterEach(() => {
  window.history.replaceState(originalState, "", originalURL);
  window.sessionStorage.clear();
});

describe("provider catalog public URL security regression", () => {
  it("registers finite provider keys without replacing the existing model key contract", () => {
    expect(featureQueryKeys("/gateway/providers")).toEqual(
      new Set(["page", "provider", "q", "range", "status", "sort", "page_size"]),
    );
    expect(featureQueryKeys("/gateway/models")).toEqual(
      new Set([
        "model",
        "model_provider",
        "page",
        "provider",
        "q",
        "range",
        "source",
        "status",
        "tab",
        "sort",
        "page_size",
      ]),
    );
  });

  describe.each(providerPaths)("%s and its /app entry", (path) => {
    it("preserves the default route and existing filter/detail identity", () => {
      const search = "?q=public&provider=managed-main&status=enabled&range=24h&page=3";
      for (const entry of [path, `/app${path}`]) {
        expect(sanitizeAppRouteSearch(entry, "")).toEqual({
          rejectedKeys: [],
          sensitiveKeys: [],
          search: "",
        });
        expect(sanitizeAppRouteSearch(entry, search)).toEqual({
          rejectedKeys: [],
          sensitiveKeys: [],
          search,
        });
      }
    });

    it.each(sorts)("preserves exactly one sort=%s", (sort) => {
      for (const entry of [path, `/app${path}`]) {
        expect(sanitizeAppRouteSearch(entry, `?sort=${sort}&page=3`)).toEqual({
          rejectedKeys: [],
          sensitiveKeys: [],
          search: `?sort=${sort}&page=3`,
        });
      }
    });

    it.each(["10", "25", "50"])("preserves exactly one page_size=%s", (size) => {
      for (const entry of [path, `/app${path}`]) {
        expect(sanitizeAppRouteSearch(entry, `?page_size=${size}&page=3`)).toEqual({
          rejectedKeys: [],
          sensitiveKeys: [],
          search: `?page_size=${size}&page=3`,
        });
      }
    });

    it.each(["", "default", "name", "name_ASC", " name_asc", "name_asc ", "name-asc", "priority_descending"])(
      "rejects invalid sort without trimming or coercion: %j",
      (value) => {
        expect(sanitizeAppRouteSearch(path, `?sort=${encodeURIComponent(value)}&page=3`)).toEqual({
          rejectedKeys: ["sort"],
          sensitiveKeys: [],
          search: "?page=3",
        });
      },
    );

    it.each(["", "0", "15", "100", "010", "25.0", "+25", " 25", "25 ", "1e1"])(
      "rejects invalid page size without coercion: %j",
      (value) => {
        expect(sanitizeAppRouteSearch(path, `?page_size=${encodeURIComponent(value)}&page=3`)).toEqual({
          rejectedKeys: ["page_size"],
          sensitiveKeys: [],
          search: "?page=3",
        });
      },
    );

    it.each([
      ["sort", "sort=name_asc&sort=name_asc"],
      ["sort", "sort=name_asc&sort=name_desc"],
      ["sort", "sort=name_asc&%73ort=name_desc"],
      ["sort", "sort=default&sort=name_asc"],
      ["page_size", "page_size=25&page_size=25"],
      ["page_size", "page_size=25&page_size=50"],
      ["page_size", "page_size=25&%70age_size=50"],
      ["page_size", "page_size=15&page_size=25"],
    ])("rejects the entire ambiguous %s key: %s", (key, parameters) => {
      expect(sanitizeAppRouteSearch(path, `?${parameters}&page=3`)).toEqual({
        rejectedKeys: [key],
        sensitiveKeys: [],
        search: "?page=3",
      });
    });

    it.each(["sort", "page_size"])("rejects synthetic secrets in %s", (key) => {
      for (const value of [secret, encodeURIComponent(secret)]) {
        expect(sanitizeAppRouteSearch(path, `?${key}=${encodeURIComponent(value)}&page=3`)).toEqual({
          rejectedKeys: [key],
          sensitiveKeys: [key],
          search: "?page=3",
        });
      }
      expect(
        sanitizeAppRouteSearch(path, `?${key}=synthetic_private_${"b".repeat(43)}&page=3`, [
          "synthetic_private_",
        ]),
      ).toEqual({ rejectedKeys: [key], sensitiveKeys: [key], search: "?page=3" });
    });

    it("preserves finite query across login and one-shot SSO without forwarding secrets", () => {
      const search = "?sort=timeout_desc&page_size=50&page=3&provider=managed-main";
      const expected = `${path}${search}#details`;
      const returnTo = appReturnTo(path, `${search}&api_key=${secret}`, "#details");
      expect(returnTo).toBe(`/app${expected}`);
      expect(safeReturnTo(returnTo)).toBe(expected);
      const loginSearch = sanitizeAppRouteSearch(
        "/login",
        `?return_to=${encodeURIComponent(returnTo)}&token=private`,
      ).search;
      expect(safeReturnTo(new URLSearchParams(loginSearch).get("return_to"))).toBe(expected);
      expect(stageSsoReturnTo(expected)).toBe(`/app${path}${search}`);
      expect(consumeSsoReturnTo()).toBe(`/app${expected}`);
      expect(consumeSsoReturnTo()).toBeUndefined();
    });

    it("does not recover duplicate, invalid or sensitive values through SSO", () => {
      const unsafe = `${path}?sort=name_asc&sort=name_desc&page_size=15&page=3&api_key=${secret}#token=private`;
      expect(safeReturnTo(`/app${unsafe}`)).toBe(`${path}?page=3`);
      expect(stageSsoReturnTo(unsafe)).toBe(`/app${path}?page=3`);
      expect(consumeSsoReturnTo()).toBe(`/app${path}?page=3`);
    });

    it("retains finite values before bootstrap while dropping unsafe state and URL values", () => {
      window.history.replaceState(
        { idx: 2, key: "safe-key", usr: { token: secret }, token: secret },
        "",
        `/app${path}?sort=priority_asc&page_size=25&page=3&token=${secret}#details`,
      );
      sanitizeWindowAppLocationBeforeBootstrap();
      expect(window.location.pathname + window.location.search + window.location.hash).toBe(
        `/app${path}?sort=priority_asc&page_size=25&page=3#details`,
      );
      expect(window.history.state).toEqual({ idx: 2, key: "safe-key", usr: null });
      expect(JSON.stringify(window.history.state)).not.toContain(secret);
    });
  });

  it.each(modelSorts)("preserves model sort=%s while rejecting it on provider catalogs", (sort) => {
    for (const path of ["/models", "/gateway/models"]) {
      expect(sanitizeAppRouteSearch(path, `?sort=${sort}&page_size=25`)).toEqual({
        rejectedKeys: [],
        sensitiveKeys: [],
        search: `?sort=${sort}&page_size=25`,
      });
    }
    for (const path of providerPaths) {
      expect(sanitizeAppRouteSearch(path, `?sort=${sort}&page_size=25`)).toEqual({
        rejectedKeys: ["sort"],
        sensitiveKeys: [],
        search: "?page_size=25",
      });
    }
  });

  it.each(sorts)("does not accept provider sort=%s as a model sort", (sort) => {
    for (const path of ["/models", "/gateway/models"]) {
      expect(sanitizeAppRouteSearch(path, `?sort=${sort}&page_size=25`)).toEqual({
        rejectedKeys: ["sort"],
        sensitiveKeys: [],
        search: "?page_size=25",
      });
    }
  });

  it.each([
    "/overview",
    "/gateway/chat",
    "/gateway/health",
    "/observability/xview",
    "/routing/rules/learning",
    "/gateway/providers/detail",
    "/providers/detail",
    "/gateway/models/detail",
  ])("does not widen unrelated or descendant route %s", (path) => {
    for (const entry of [path, `/app${path}`]) {
      expect(sanitizeAppRouteSearch(entry, "?sort=name_asc&page_size=25")).toEqual({
        rejectedKeys: ["sort", "page_size"],
        sensitiveKeys: [],
        search: "",
      });
    }
  });

  it.each([
    "https://outside.invalid/app/providers?sort=name_asc",
    "//outside.invalid/app/providers",
    "/providers?sort=name_asc",
  ])("preserves the same-origin /app return boundary for %s", (destination) => {
    expect(safeReturnTo(destination)).toBe("/overview");
  });
});
