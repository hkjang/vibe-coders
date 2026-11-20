import { describe, expect, it } from "vitest";
import { routingRuleLegacyHandoff } from "./legacy-routing-handoff";
const base = "/admin#/routing";
const id = "분기 +%2F?&#/정산";
describe("routing rule Legacy handoff", () => {
  it("preserves only the exact selected ID", () => {
    const result = routingRuleLegacyHandoff(base, id, true, []);
    expect(result.sameRule).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(result.href?.split("?")[1]))).toEqual({ rule_id: id });
  });
  it.each(["", " padded ", "a\nb", "a\\b", "\ud800", "\u200b", "x".repeat(513), "vc_sk_" + "x".repeat(40)])(
    "withholds unsafe identity %j",
    (value) => {
      expect(routingRuleLegacyHandoff(base, value, true, ["vc_sk_"])).toEqual({
        href: base,
        sameRule: false,
      });
    },
  );
  it("uses fallback for old servers and unreadable selections", () => {
    expect(routingRuleLegacyHandoff(base, id, false, []).sameRule).toBe(false);
    expect(routingRuleLegacyHandoff(base, undefined, true, []).sameRule).toBe(false);
  });
  it("preserves custom runtime destinations without attaching another contract", () => {
    expect(routingRuleLegacyHandoff("/admin#/custom?public=ok", id, true, [])).toEqual({
      href: "/admin#/custom?public=ok",
      sameRule: false,
    });
  });
  it.each([undefined, "https://remote.invalid/admin", "/administer", "/admin#/routing?token=private"])(
    "withholds an unsafe runtime destination %s",
    (href) => {
      expect(routingRuleLegacyHandoff(href, id, true, [])).toEqual({ sameRule: false });
    },
  );
  it("accepts the exact maximum codepoint ID", () => {
    const value = "😀".repeat(512);
    expect(
      new URLSearchParams(routingRuleLegacyHandoff(base, value, true, []).href?.split("?")[1]).get("rule_id"),
    ).toBe(value);
  });
});
