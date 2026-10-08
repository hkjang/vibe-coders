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

// Independent public URL contract: do not import the product parser under test.
const sorts = [
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
const modelPaths = ["/gateway/models", "/models"] as const;
const originalURL = window.location.href;
const originalState: unknown = window.history.state;
const secret = `vc_sk_${"a".repeat(43)}`;

afterEach(() => {
  window.history.replaceState(originalState, "", originalURL);
  window.sessionStorage.clear();
});

describe("model catalog public URL security regression", () => {
  it("registers the two finite keys on the actual gateway.models feature only", () => {
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
    expect(featureQueryKeys("/gateway/providers")?.has("sort")).toBe(false);
    expect(featureQueryKeys("/gateway/providers")?.has("page_size")).toBe(false);
  });

  describe.each(modelPaths)("%s including its /app entry", (path) => {
    it("keeps the existing default route and exact model/detail/filter identity", () => {
      const search =
        "?q=gpt&provider=openai&model=gpt-test&model_provider=openai&source=live&status=available&range=24h&page=3";
      for (const entry of [path, `/app${path}`]) {
        expect(sanitizeAppRouteSearch(entry, "").search).toBe("");
        expect(sanitizeAppRouteSearch(entry, search)).toEqual({
          rejectedKeys: [],
          sensitiveKeys: [],
          search,
        });
      }
    });

    it.each(sorts)("preserves exactly one valid sort=%s", (sort) => {
      for (const entry of [path, `/app${path}`]) {
        expect(sanitizeAppRouteSearch(entry, `?sort=${sort}&page=3`)).toEqual({
          rejectedKeys: [],
          sensitiveKeys: [],
          search: `?sort=${sort}&page=3`,
        });
      }
    });

    it.each(["10", "25", "50"])("preserves explicit page_size=%s", (size) => {
      for (const entry of [path, `/app${path}`]) {
        expect(sanitizeAppRouteSearch(entry, `?page_size=${size}&page=3`)).toEqual({
          rejectedKeys: [],
          sensitiveKeys: [],
          search: `?page_size=${size}&page=3`,
        });
      }
    });

    it.each(["", "default", "order", "model", "model_ASC", " model_asc", "model_asc ", "model-asc"])(
      "rejects an invalid sort without coercion: %j",
      (value) => {
        expect(sanitizeAppRouteSearch(path, `?sort=${encodeURIComponent(value)}&page=3`)).toEqual({
          rejectedKeys: ["sort"],
          sensitiveKeys: [],
          search: "?page=3",
        });
      },
    );

    it.each(["", "0", "15", "100", "010", "25.0", "+25", " 25", "25 ", "1e1"])(
      "rejects an invalid page size without coercion: %j",
      (value) => {
        expect(sanitizeAppRouteSearch(path, `?page_size=${encodeURIComponent(value)}&page=3`)).toEqual({
          rejectedKeys: ["page_size"],
          sensitiveKeys: [],
          search: "?page=3",
        });
      },
    );

    it.each([
      ["sort", "sort=model_asc&sort=model_asc"],
      ["sort", "sort=model_asc&sort=model_desc"],
      ["sort", "sort=model_asc&%73ort=model_desc"],
      ["sort", "sort=default&sort=model_asc"],
      ["page_size", "page_size=25&page_size=25"],
      ["page_size", "page_size=25&page_size=50"],
      ["page_size", "page_size=25&%70age_size=50"],
      ["page_size", "page_size=15&page_size=25"],
    ])("rejects the whole ambiguous %s key: %s", (key, parameters) => {
      expect(sanitizeAppRouteSearch(path, `?${parameters}&page=3`)).toEqual({
        rejectedKeys: [key],
        sensitiveKeys: [],
        search: "?page=3",
      });
    });

    it.each(["sort", "page_size"])("keeps secret rejection active for %s", (key) => {
      for (const value of [secret, encodeURIComponent(secret)]) {
        const result = sanitizeAppRouteSearch(path, `?${key}=${encodeURIComponent(value)}&page=3`);
        expect(result).toEqual({
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

    it("round-trips login return_to and one-shot SSO without forwarding secrets", () => {
      const search = "?sort=output_price_desc&page_size=50&page=3&model=gpt-test&model_provider=openai";
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

    it("does not recover invalid, duplicate or sensitive values through return_to or SSO", () => {
      const unsafe =
        `${path}?sort=model_asc&sort=model_desc&page_size=15&page=3&api_key=${secret}` + "#token=private";
      expect(safeReturnTo(`/app${unsafe}`)).toBe(`${path}?page=3`);
      expect(stageSsoReturnTo(unsafe)).toBe(`/app${path}?page=3`);
      expect(consumeSsoReturnTo()).toBe(`/app${path}?page=3`);
    });

    it("preserves the finite query before bootstrap and strips unsafe state and URL values", () => {
      window.history.replaceState(
        { idx: 2, key: "safe-key", usr: { token: secret }, token: secret },
        "",
        `/app${path}?sort=input_price_asc&page_size=25&page=3&token=${secret}#details`,
      );
      sanitizeWindowAppLocationBeforeBootstrap();
      expect(window.location.pathname + window.location.search + window.location.hash).toBe(
        `/app${path}?sort=input_price_asc&page_size=25&page=3#details`,
      );
      expect(window.history.state).toEqual({ idx: 2, key: "safe-key", usr: null });
      expect(JSON.stringify(window.history.state)).not.toContain(secret);
    });
  });

  it.each([
    "/overview",
    "/gateway/providers",
    "/providers",
    "/gateway/chat",
    "/gateway/health",
    "/observability/xview",
    "/routing/rules/learning",
    "/gateway/models/detail",
  ])("does not widen the query boundary for %s", (path) => {
    for (const entry of [path, `/app${path}`]) {
      expect(sanitizeAppRouteSearch(entry, "?sort=model_asc&page_size=25")).toEqual({
        rejectedKeys: ["sort", "page_size"],
        sensitiveKeys: [],
        search: "",
      });
    }
  });

  it("keeps existing bootstrap and SSO defaults as a positive control", () => {
    window.history.replaceState(null, "", "/app/models?q=gpt&page=3#details");
    sanitizeWindowAppLocationBeforeBootstrap();
    expect(window.location.search).toBe("?q=gpt&page=3");
    expect(appReturnTo("/models", "?q=gpt&page=3", "#details")).toBe("/app/models?q=gpt&page=3#details");
    expect(stageSsoReturnTo("/models?q=gpt&page=3#details")).toBe("/app/models?q=gpt&page=3");
    expect(consumeSsoReturnTo()).toBe("/app/models?q=gpt&page=3#details");
  });

  it.each([
    "https://outside.invalid/app/models?sort=model_asc",
    "//outside.invalid/app/models",
    "/models?sort=model_asc",
  ])("retains the same-origin /app boundary for %s", (destination) =>
    expect(safeReturnTo(destination)).toBe("/overview"),
  );
});
