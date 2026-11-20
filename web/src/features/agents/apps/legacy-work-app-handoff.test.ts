import { expect, it } from "vitest";
import { workAppLegacyHandoff } from "./legacy-work-app-handoff";
const base = "/admin#/apps";
it.each([" 앱 +%2F?&#/ ", "앱 " + "가".repeat(1300), "a".repeat(4096)])(
  "preserves exact work app identity",
  (id) => {
    const result = workAppLegacyHandoff(base, id, true, []);
    expect(result.sameApp).toBe(true);
    expect(new URLSearchParams(result.href?.split("?")[1]).get("app_id")).toBe(id);
  },
);
it.each(["", "\u200b", "\ud800", "a\\b", "a\nb", "a".repeat(4097), "corp_" + "x".repeat(43)])(
  "withholds invalid or unsafe app identity",
  (id) => {
    expect(workAppLegacyHandoff(base, id, true, ["corp_"])).toEqual({ href: base, sameApp: false });
  },
);
it("preserves custom runtime destinations and old-server fallback", () => {
  expect(workAppLegacyHandoff("/admin#/custom?public=ok", "id", true, [])).toEqual({
    href: "/admin#/custom?public=ok",
    sameApp: false,
  });
  expect(workAppLegacyHandoff(base, "id", false, []).sameApp).toBe(false);
  expect(workAppLegacyHandoff(base, undefined, true, []).sameApp).toBe(false);
});
it.each([undefined, "/administer", "https://outside.invalid/admin", "/admin#/apps?token=private"])(
  "withholds unsafe runtime destination",
  (href) => {
    expect(workAppLegacyHandoff(href, "id", true, [])).toEqual({ sameApp: false });
  },
);
