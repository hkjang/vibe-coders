import { describe, expect, it } from "vitest";
import { selectedSessionID, sessionLegacyHandoff, validSessionHandoffID } from "./legacy-session-handoff";
const base = "/admin#/sessions";
describe("same-session handoff", () => {
  it.each(["session +%2F?&# 한글", "reader@example.invalid", "😀".repeat(1024)])(
    "preserves the exact supported lookup target %s",
    (id) => {
      const result = sessionLegacyHandoff(base, id, true, []);
      expect(result.sameSession).toBe(true);
      expect(new URLSearchParams(result.href?.split("?")[1]).get("session_id")).toBe(id);
      expect(selectedSessionID(new URLSearchParams({ session_id: id }), [])).toBe(id);
    },
  );
  it.each(["", " padded", "padded ", ".", "..", "a/b", "a\\\\b", "a\u0000b", "a\u200bb", "a".repeat(4097)])(
    "never constructs a retargeted lookup %s",
    (id) => {
      expect(validSessionHandoffID(id, [])).toBe(false);
      expect(sessionLegacyHandoff(base, id, true, [])).toEqual({ href: base, sameSession: false });
      expect(selectedSessionID(new URLSearchParams({ session_id: id }), [])).toBe("");
    },
  );
  it("rejects repeated selections and configured credentials", () => {
    expect(selectedSessionID(new URLSearchParams("session_id=a&session_id=b"), [])).toBe("");
    expect(sessionLegacyHandoff(base, "corp_" + "x".repeat(43), true, ["corp_"]).sameSession).toBe(false);
  });
  it("keeps custom destinations and old-server fallback policy", () => {
    expect(sessionLegacyHandoff("/admin#/dashboard", "id", true, [])).toEqual({
      href: "/admin#/dashboard",
      sameSession: false,
    });
    expect(sessionLegacyHandoff(base, "id", false, [])).toEqual({ href: base, sameSession: false });
    expect(sessionLegacyHandoff(undefined, "id", true, [])).toEqual({ sameSession: false });
  });
});
