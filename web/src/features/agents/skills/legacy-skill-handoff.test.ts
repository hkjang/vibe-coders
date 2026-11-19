import { expect, it } from "vitest";
import { skillLegacyHandoff } from "./legacy-skill-handoff";
const base = "/admin#/skills";
it.each(["/스킬 +%2F?&#/", "__proto__", " exact name ", "앱 " + "가".repeat(1300), "a".repeat(4096)])(
  "preserves exact skill identity",
  (id) => {
    const result = skillLegacyHandoff(base, id, true, []);
    expect(result.sameSkill).toBe(true);
    expect(new URLSearchParams(result.href?.split("?")[1]).get("skill_name")).toBe(id);
  },
);
it.each(["", "\u200b", "\ud800", "a\\b", "a\nb", "a".repeat(4097), "corp_" + "x".repeat(43)])(
  "withholds invalid or unsafe skill identity",
  (id) => {
    expect(skillLegacyHandoff(base, id, true, ["corp_"])).toEqual({ href: base, sameSkill: false });
  },
);
it("preserves custom runtime destinations and old-server fallback", () => {
  expect(skillLegacyHandoff("/admin#/custom?public=ok", "id", true, [])).toEqual({
    href: "/admin#/custom?public=ok",
    sameSkill: false,
  });
  expect(skillLegacyHandoff(base, "id", false, []).sameSkill).toBe(false);
  expect(skillLegacyHandoff(base, undefined, true, []).sameSkill).toBe(false);
});
it.each([undefined, "/administer", "https://outside.invalid/admin", "/admin#/skills?token=private"])(
  "withholds unsafe runtime destination",
  (href) => {
    expect(skillLegacyHandoff(href, "id", true, [])).toEqual({ sameSkill: false });
  },
);
