import { describe, expect, it } from "vitest";
import { mockApi } from "@/test/api";
import { readMeReceipt, readMeSkills } from "./me-console-api";
const scope = { user: "public-user", team: "public-team", prefixes: [] };
describe("personal API path boundaries", () => {
  it.each([".", "..", "../private", "a/b", "a\\b"])(
    "does not send a normalized receipt path for %s",
    async (id) => {
      const api = mockApi({});
      await expect(readMeReceipt(scope, id)).rejects.toMatchObject({ code: "me_console_invalid" });
      expect(api.calls).toHaveLength(0);
    },
  );
  it.each(["검토/skill", "..", "그룹\\스킬"])(
    "keeps supported display names in the catalog: %s",
    async (name) => {
      mockApi({ "GET /me/skills": () => ({ team: scope.team, available: [{ name }] }) });
      await expect(readMeSkills(scope)).resolves.toMatchObject({ available: [{ name }] });
    },
  );
});
