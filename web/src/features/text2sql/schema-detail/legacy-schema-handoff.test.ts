import { expect, it } from "vitest";
import { schemaLegacyHandoff } from "./legacy-schema-handoff";
const base = "/admin#/text2sql";
it.each(["스키마 +%2F?&#/정확", "😀".repeat(512)])("preserves an exact supported schema name", (name) => {
  const result = schemaLegacyHandoff(base, name, true, []);
  expect(result.sameSchema).toBe(true);
  expect(new URLSearchParams(result.href?.split("?")[1]).get("schema_name")).toBe(name);
});
it.each(["", " padded ", "a\u200bb", "a\nb", "\ud800", "a\\b", "x".repeat(513), "corp_" + "x".repeat(43)])(
  "withholds invalid or unsafe name %j",
  (name) => {
    expect(schemaLegacyHandoff(base, name, true, ["corp_"])).toEqual({ href: base, sameSchema: false });
  },
);
it("retains custom destinations and truthful fallback on old servers or invalid selections", () => {
  expect(schemaLegacyHandoff("/admin#/custom?public=ok", "name", true, [])).toEqual({
    href: "/admin#/custom?public=ok",
    sameSchema: false,
  });
  expect(schemaLegacyHandoff(base, "name", false, []).sameSchema).toBe(false);
  expect(schemaLegacyHandoff(base, undefined, true, []).sameSchema).toBe(false);
});
it.each([undefined, "/administer", "https://outside.invalid/admin", "/admin#/text2sql?token=private"])(
  "withholds unsafe base %s",
  (base) => {
    expect(schemaLegacyHandoff(base, "name", true, [])).toEqual({ sameSchema: false });
  },
);
