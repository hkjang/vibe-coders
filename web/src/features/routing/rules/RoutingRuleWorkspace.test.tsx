import { useState } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { testAuth } from "@/test/auth";
import { FeatureAccessHarness } from "@/test/feature-access";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { RulesTab } from "./RulesTab";

const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
const row = {
  id: "route-one",
  enabled: true,
  priority: 5,
  match_pattern: "정산-*",
  min_complexity: 10,
  max_complexity: 80,
  target_model: "계정 A 모델",
  target_provider: "공급자",
  note: "계정 A 메모",
  created_at: "2026-11-01T00:00:00Z",
};
beforeEach(() => {
  state.auth = testAuth({ backendVersion: "v0.86.103", scopes: ["routing:read"] });
});
function setup(handler: ApiHandler) {
  const api = mockApi({ "GET /admin/routing-rules": handler });
  let refresh = () => {};
  function Host() {
    const [, update] = useState(0);
    refresh = () => update((value) => value + 1);
    return (
      <FeatureAccessHarness featureId="routing.rules" readOnly>
        <main id="main-content" tabIndex={-1}>
          <RulesTab canWrite={false} />
        </main>
      </FeatureAccessHarness>
    );
  }
  const view = renderScreen(<Host />, { route: "/routing/rules?rule_id=route-one" });
  return { ...view, api, refresh: () => act(refresh) };
}
it.each(["detail", "list"])("%s 권한 거부는 배경 목록·상세와 조회 캐시를 함께 폐기한다", async (kind) => {
  let denied = true;
  const view = setup((options) => {
    const detail = !!(options.query as { id?: string } | undefined)?.id;
    if (denied && (kind === "detail") === detail) throw apiFailure("denied", 403);
    return { rules: [row] };
  });
  expect(await screen.findByText("라우팅 규칙 조회 권한을 확인하세요.")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText(row.target_model)).not.toBeInTheDocument();
  await waitFor(() => expect(view.client.getQueryCache().getAll()).toHaveLength(0));
  denied = false;
  await userEvent.click(screen.getByRole("button", { name: "권한 다시 확인" }));
  expect(await within(await screen.findByRole("dialog")).findByText(row.note)).toBeVisible();
});
it("팀 전환은 이전 목록·상세의 늦은 응답을 폐기하고 새 계정으로 조회한다", async () => {
  const pending: Array<(value: unknown) => void> = [];
  const view = setup(() =>
    state.auth.user?.team_id !== "beta"
      ? new Promise((resolve) => {
          pending.push(resolve);
        })
      : { rules: [] },
  );
  await waitFor(() => expect(pending).toHaveLength(2));
  if (!state.auth.user) throw new Error("fixture user required");
  state.auth = { ...state.auth, user: { ...state.auth.user, team_id: "beta" } };
  view.refresh();
  expect(await screen.findByText("해당 라우팅 규칙이 없습니다.")).toBeVisible();
  await act(async () => {
    for (const finish of pending) finish({ rules: [row] });
  });
  expect(screen.queryByText(row.target_model)).not.toBeInTheDocument();
  expect(screen.queryByText(row.note)).not.toBeInTheDocument();
  expect(view.api.calls).toHaveLength(4);
});
