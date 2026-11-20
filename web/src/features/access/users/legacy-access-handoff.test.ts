import { describe, expect, it } from "vitest";
import { accessLegacyHandoff } from "./legacy-access-handoff";
const base = "/admin#/users";
describe("exact access resource Legacy handoff", () => {
  it.each(["key", "account", "team"] as const)(
    "preserves resource kind for colliding IDs: %s",
    (resource) => {
      const result = accessLegacyHandoff(base, resource, "shared-id", true, []);
      expect(result.sameResource).toBe(true);
      expect(Object.fromEntries(new URLSearchParams(result.href?.split("?")[1]))).toEqual({
        resource,
        id: "shared-id",
      });
    },
  );
  it.each(["account", "team"] as const)("preserves long Unicode and whitespace ID: %s", (resource) => {
    const id = " 계정 +%2F?&#/ " + "가".repeat(1300) + " ";
    const result = accessLegacyHandoff(base, resource, id, true, []);
    expect(result.sameResource).toBe(true);
    expect(result.href?.length).toBeGreaterThan(9000);
    expect(new URLSearchParams(result.href?.split("?")[1]).get("id")).toBe(id);
    expect(accessLegacyHandoff(base, resource, "a".repeat(4096), true, []).sameResource).toBe(true);
    expect(accessLegacyHandoff(base, resource, "a".repeat(4097), true, []).sameResource).toBe(false);
  });
  it.each(["", "\u200b", "\ud800", "a\\b", "a\nb", "vc_sk_" + "x".repeat(40)])(
    "withholds unsafe identity %j",
    (id) => {
      for (const resource of ["key", "account", "team"] as const)
        expect(accessLegacyHandoff(base, resource, id, true, ["vc_sk_"])).toEqual({
          href: base,
          sameResource: false,
        });
    },
  );
  it("keeps key IDs within the existing ASCII policy", () => {
    expect(accessLegacyHandoff(base, "key", "a".repeat(512), true, []).sameResource).toBe(true);
    for (const id of ["a".repeat(513), " padded ", "한글", "a/b"])
      expect(accessLegacyHandoff(base, "key", id, true, []).sameResource).toBe(false);
  });
  it("preserves custom runtime destinations and old-server fallback", () => {
    expect(accessLegacyHandoff("/admin#/custom?public=ok", "team", "id", true, [])).toEqual({
      href: "/admin#/custom?public=ok",
      sameResource: false,
    });
    expect(accessLegacyHandoff(base, "key", "id", false, []).sameResource).toBe(false);
    expect(accessLegacyHandoff(base, "key", undefined, true, []).sameResource).toBe(false);
  });
  it.each([undefined, "https://outside.invalid/admin", "/administer", "/admin#/users?token=private"])(
    "withholds unsafe base %s",
    (href) => {
      expect(accessLegacyHandoff(href, "key", "id", true, [])).toEqual({ sameResource: false });
    },
  );
});
