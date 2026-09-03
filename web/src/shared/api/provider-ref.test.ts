import { describe, expect, it } from "vitest";

import { isProviderRef, isSafeLegacyProviderName, providerDisplayLabels } from "@/shared/api/provider-ref";

describe("opaque Provider references", () => {
  it("accepts only the fixed URL-safe provider_ref contract", () => {
    expect(isProviderRef(`prv_${"a".repeat(43)}`)).toBe(true);
    for (const value of [
      "openai",
      `prv_${"a".repeat(42)}`,
      `prv_${"a".repeat(44)}`,
      `prv_${"a".repeat(42)}=`,
      `PRV_${"a".repeat(43)}`,
    ]) {
      expect(isProviderRef(value)).toBe(false);
    }
  });

  it("creates stable unique labels for colliding masked and reserved names", () => {
    const firstRef = `prv_${"a".repeat(43)}`;
    const secondRef = `prv_${"b".repeat(43)}`;
    const labels = providerDisplayLabels([
      { name: "[provider-name-omitted]", providerRef: firstRef },
      { name: "Bearer private-provider", providerRef: secondRef },
    ]);

    expect(new Set(labels.values()).size).toBe(2);
    expect(labels.get(firstRef)).toMatch(/^공급자 이름 비공개 · 01 · /);
    expect(labels.get(secondRef)).toMatch(/^공급자 이름 비공개 · 02 · /);
    expect([...labels.values()].join(" ")).not.toContain("private-provider");
    expect(isSafeLegacyProviderName("openai")).toBe(true);
    expect(isSafeLegacyProviderName("sk-provider-private-value")).toBe(false);
  });
});
