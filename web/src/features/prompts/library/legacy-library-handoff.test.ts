import { describe, expect, it } from "vitest";
import { libraryLegacyHandoff } from "./legacy-library-handoff";
const base = "/admin#/prompts";
const map = (tab: string, query = "", supported = true, path: string | undefined = base) =>
  libraryLegacyHandoff(path, tab, new URLSearchParams(query), ["vc_sk_", "corp_"], supported);
const params = (href?: string) => new URLSearchParams(href?.split("?")[1]);
describe("prompt library Legacy handoff", () => {
  it("preserves effective search semantics, exact instant, and fingerprint period", () => {
    const result = map(
      "search",
      "q=public%20%2B%25&language=go&ip=2001%3Adb8%3A%3A7&api_key_id=public-key&since=2026-11-20T03%3A04%3A05.123%2B09%3A00&limit=37&fp_window=90d",
    );
    expect(result.omitted).toBe(false);
    expect(Object.fromEntries(params(result.href))).toEqual({
      q: "public +%",
      language: "go",
      ip: "2001:db8::7",
      api_key_id: "public-key",
      since: "2026-11-19T18:04:05.123Z",
      limit: "37",
      fp_window: "90d",
    });
  });
  it("keeps selected asset independent of filters that exclude it", () => {
    const id = "id +%2F?&# 한글";
    const query = new URLSearchParams({
      asset: id,
      asset_q: "no-match",
      asset_status: "draft",
      asset_category: "custom",
      asset_tag: "public",
    });
    const result = map("assets", query.toString());
    expect(result.href?.startsWith("/admin#/prompt-assets?")).toBe(true);
    expect(Object.fromEntries(params(result.href))).toEqual({
      asset: id,
      q: "no-match",
      status: "draft",
      category: "custom",
      tag: "public",
    });
    expect(result.selectedAsset).toBe(true);
  });
  it.each(["7d", "30d", "90d"])("preserves debt window %s", (window) => {
    expect(map("debt", "debt_window=" + window).href).toBe("/admin#/prompt-debt?window=" + window);
  });
  it("uses the same default periods and limits as App", () => {
    expect(Object.fromEntries(params(map("search", "limit=999&fp_window=bad").href))).toEqual({
      limit: "100",
      fp_window: "7d",
    });
    expect(map("debt", "debt_window=bad").href).toBe("/admin#/prompt-debt?window=30d");
  });
  it.each(["contexts", "products", "promotions"])("does not invent a Legacy counterpart for %s", (tab) => {
    expect(map(tab).href).toBeUndefined();
  });
  it.each([
    ["search", "/admin#/prompts"],
    ["assets", "/admin#/prompt-assets"],
    ["debt", "/admin#/prompt-debt"],
  ])("keeps old server %s list fallback with explicit omission", (tab, href) => {
    expect(map(tab, "asset=public&debt_window=90d&q=public", false)).toEqual({
      href,
      selectedAsset: false,
      omitted: true,
    });
  });
  it("keeps a custom current runtime target without inventing its query contract", () => {
    expect(map("assets", "asset=public", true, "/admin#/custom?public=yes")).toEqual({
      href: "/admin#/custom?public=yes",
      selectedAsset: false,
      omitted: true,
    });
  });
  it.each([
    undefined,
    "/administrator",
    "https://outside.invalid/admin",
    "/admin#/vc_sk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ])("rejects invalid or secret destination %s", (path) => {
    expect(
      libraryLegacyHandoff(path, "assets", new URLSearchParams(), ["vc_sk_"], true).href,
    ).toBeUndefined();
  });
  it("omits invalid and credential-bearing query values without copying them into links", () => {
    const result = map("search", "q=corp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&since=invalid&language=go");
    expect(result.omitted).toBe(true);
    expect(result.href).not.toContain("b".repeat(40));
    expect(result.href).not.toContain("since");
    expect(params(result.href).get("language")).toBe("go");
  });
  it.each(["asset=a&asset=b", "asset=corp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "asset=a%0Ab"])(
    "withholds ambiguous or unsafe asset identity %s",
    (query) => {
      const result = map("assets", query);
      expect(result.selectedAsset).toBe(false);
      expect(result.omitted).toBe(true);
    },
  );
});
