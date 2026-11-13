import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AppScopeBoundary, appsKey, useAppRead } from "./app-scope";
import { useWorkAppDetailQuery } from "./use-work-app-queries";
import { FeatureAccessHarness } from "@/test/feature-access";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { workAppReadFixture } from "@/test/work-app-fixtures";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});
function ConcurrentReads() {
  // A pinned detail can keep its versions alive while an external selection is
  // loading. These are valid opaque app IDs, not reserved API route segments.
  const versions = useAppRead({
    queryKey: [...appsKey, "detail", "versions"],
    queryFn: async () => ({ versions: [{ version: 7 }] }),
  });
  const detail = useWorkAppDetailQuery("versions");
  return (
    <>
      <output aria-label="기존 앱 발행 버전">{versions.data?.versions?.[0]?.version ?? "조회 중"}</output>
      <output aria-label="새 앱 제목">{detail.data?.app?.title ?? "조회 중"}</output>
    </>
  );
}
it("특수 이름 앱의 발행 이력과 새 상세 조회 캐시를 분리한다", async () => {
  mockApi({
    "GET /admin/apps": ({ query }) => workAppReadFixture([{ id: "versions", title: "별도 업무 앱" }], query),
  });
  renderScreen(
    <FeatureAccessHarness featureId="agents.apps">
      <AppScopeBoundary>
        <ConcurrentReads />
      </AppScopeBoundary>
    </FeatureAccessHarness>,
  );
  expect(await screen.findByText("별도 업무 앱")).toBeVisible();
  expect(screen.getByLabelText("기존 앱 발행 버전")).toHaveTextContent("7");
});
