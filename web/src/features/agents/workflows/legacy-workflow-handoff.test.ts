import { expect, it } from "vitest";
import { workflowLegacyHandoff } from "./legacy-workflow-handoff";
const base = "/admin#/workflows";
it.each([" 앱 +%2F?&#/ ", "앱 " + "가".repeat(1300), "a".repeat(4096)])(
  "preserves exact workflow identity",
  (id) => {
    const result = workflowLegacyHandoff(base, id, true, []);
    expect(result.sameWorkflow).toBe(true);
    expect(new URLSearchParams(result.href?.split("?")[1]).get("workflow_id")).toBe(id);
  },
);
it.each(["", "\u200b", "\ud800", "a\\b", "a\nb", "a".repeat(4097), "corp_" + "x".repeat(43)])(
  "withholds invalid or unsafe workflow identity",
  (id) => {
    expect(workflowLegacyHandoff(base, id, true, ["corp_"])).toEqual({ href: base, sameWorkflow: false });
  },
);
it("preserves custom runtime destinations and old-server fallback", () => {
  expect(workflowLegacyHandoff("/admin#/custom?public=ok", "id", true, [])).toEqual({
    href: "/admin#/custom?public=ok",
    sameWorkflow: false,
  });
  expect(workflowLegacyHandoff(base, "id", false, []).sameWorkflow).toBe(false);
  expect(workflowLegacyHandoff(base, undefined, true, []).sameWorkflow).toBe(false);
});
it.each([undefined, "/administer", "https://outside.invalid/admin", "/admin#/workflows?token=private"])(
  "withholds unsafe runtime destination",
  (href) => {
    expect(workflowLegacyHandoff(href, "id", true, [])).toEqual({ sameWorkflow: false });
  },
);
