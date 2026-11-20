import { describe, expect, it } from "vitest";
import { legacyProviderDetailHref } from "./legacy-provider-map";

const ref = "prv_" + "a".repeat(43);
describe("provider detail Legacy destination", () => {
  it("preserves the exact opaque reference on the known screen", () => {
    expect(legacyProviderDetailHref("/admin#/settings", ref)).toBe("/admin#/settings?provider_ref=" + ref);
    const mixed = "prv_" + "a_-".repeat(14) + "Z";
    expect(legacyProviderDetailHref("/admin#/settings", mixed)).toBe(
      "/admin#/settings?provider_ref=" + mixed,
    );
  });
  it.each([
    undefined,
    "",
    "public name",
    ref + "\\n",
    ref + "x",
    "prv_" + "a".repeat(42),
    "prv_" + "/".repeat(43),
  ])("does not turn an invalid identity into a link: %j", (value) => {
    expect(legacyProviderDetailHref("/admin#/settings", value)).toBeUndefined();
  });
  it.each([
    undefined,
    "/admin",
    "/admin#/settings/runtime",
    "/admin#/settings?provider_ref=old",
    "https://example.invalid/admin#/settings",
  ])("does not apply a detail query to a different runtime destination: %j", (path) => {
    expect(legacyProviderDetailHref(path, ref)).toBeUndefined();
  });
});
