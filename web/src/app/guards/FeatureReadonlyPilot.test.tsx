import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureRoute } from "./FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { SkillPage } from "@/features/agents/skills/SkillPage";
import { RequestInsightPanel } from "@/features/observability/request-insight/RequestInsightPanel";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ readOnly: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth();
      return {
        ...auth,
        features: auth.features.map((feature) => ({ ...feature, readOnly: runtime.readOnly })),
      };
    },
  };
});
function feature(id: string) {
  const result = migrationRegistry.find((entry) => entry.featureId === id);
  if (!result) throw new Error("unknown fixture feature");
  return result;
}
beforeEach(() => {
  runtime.readOnly = true;
});
describe("FeatureRoute readonly pilot", () => {
  it("admin:write가 있어도 스킬 저장을 막는다", async () => {
    mockApi({
      "GET /admin/skills": () => ({ skills: [] }),
      "GET /admin/skills/stats": () => ({ stats: [] }),
    });
    renderScreen(
      <FeatureRoute feature={feature("agents.skills")}>
        <SkillPage />
      </FeatureRoute>,
      { route: "/agents/skills" },
    );
    expect(await screen.findByRole("button", { name: "스킬 추가" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "추천 스킬 추가" })).toBeDisabled();
  });
  it.each(["observability.llm", "observability.xview"])(
    "%s의 메모와 실제 provider 실행을 막는다",
    async (id) => {
      mockApi({
        "GET /admin/requests/req/note": () => ({
          request_id: "req",
          note: "",
          tags: [],
          exists: true,
          redacted_fields: [],
          created_by: "test",
          updated_at: "2026-01-01T00:00:00Z",
        }),
        "GET /admin/requests/req/explain": () => new Promise(() => undefined),
        "GET /admin/requests/req/trace": () => new Promise(() => undefined),
        "GET /admin/requests/req/links": () => new Promise(() => undefined),
      });
      renderScreen(
        <FeatureRoute feature={feature(id)}>
          <RequestInsightPanel requestId="req" canWriteNote canInspectRaw />
        </FeatureRoute>,
      );
      await waitFor(() => expect(screen.getByRole("button", { name: "메모·태그 새로고침" })).toBeEnabled());
      expect(screen.getByRole("button", { name: "메모·태그 수정" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "태그·메모 삭제" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "분석 실행" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "재실행" })).toBeDisabled();
    },
  );
});
