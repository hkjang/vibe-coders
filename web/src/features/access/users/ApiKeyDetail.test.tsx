import { useState } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation, useNavigate } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiKeyPublicSchema } from "@/shared/api/domains/access.schemas";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { testAuth } from "@/test/auth";
import { ApiKeysTab } from "./ApiKeysTab";

const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
const row = apiKeyPublicSchema.parse({
  id: "key_one",
  name: "정산 자동화 키",
  status: "active",
  team: "alpha",
  owner: "정산 서비스",
  scopes: ["chat:completion"],
  allowed_models: ["model-a"],
  budget_limit_krw: 50000,
  created_at: "2026-11-01T00:00:00Z",
});
beforeEach(() => {
  state.auth = {
    ...testAuth({ role: "readonly_admin", scopes: ["admin:read"] }),
    credentialPrefixes: ["corp_"],
  };
});
function setup(route = "/access/users?tab=keys", detail?: ApiHandler) {
  let refresh = () => {};
  function Host() {
    const location = useLocation();
    const navigate = useNavigate();
    const [, update] = useState(0);
    refresh = () => update((v) => v + 1);
    return (
      <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: true }}>
        <output aria-label="현재 주소">{location.search}</output>
        <button onClick={() => navigate(-1)}>이전 주소</button>
        <button onClick={() => navigate(1)}>다음 주소</button>
        <main id="main-content" tabIndex={-1}>
          <ApiKeysTab canWrite={false} isSuperAdmin={false} writeDeniedReason="조회 전용입니다." />
        </main>
      </FeatureAccessContext.Provider>
    );
  }
  const api = mockApi({
    "GET /admin/api-keys": (options, endpoint) =>
      (options.query as { id?: string } | undefined)?.id && detail
        ? detail(options, endpoint)
        : { api_keys: [row] },
  });
  const view = renderScreen(<Host />, { route });
  return { ...view, api, refresh: () => act(refresh) };
}
const detailCalls = (api: ReturnType<typeof mockApi>) =>
  api.calls.filter((call) => (call.options.query as { id?: string } | undefined)?.id !== undefined);

it("조회 권한으로 키 상세를 열고 닫을 때 주소와 초점을 복원한다", async () => {
  const user = userEvent.setup();
  const { api } = setup("/access/users?tab=keys&registered_size=10");
  const link = await screen.findByRole("link", { name: "정산 자동화 키" });
  await user.click(link);
  const panel = within(await screen.findByRole("dialog", { name: "API 키 상세" }));
  expect(await panel.findByText("key_one")).toBeVisible();
  expect(panel.getByText("허용 모델")).toBeVisible();
  expect(panel.getByText("model-a")).toBeVisible();
  expect(panel.queryByRole("button", { name: /수정|폐기|발급/ })).not.toBeInTheDocument();
  expect(detailCalls(api)[0]?.options.query).toEqual({ id: "key_one" });
  await user.click(panel.getByRole("button", { name: "닫기" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(link).toHaveFocus();
  expect(screen.getByLabelText("현재 주소")).toHaveTextContent("registered_size=10");
  expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("api_key_id");
  expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
});
it("직접 연 상세는 목록에 없는 키도 정확한 ID로 조회한다", async () => {
  const { api } = setup("/access/users?tab=keys&api_key_id=key_other", () => ({
    api_keys: [{ ...row, id: "key_other", name: "다른 상세 키" }],
  }));
  const panel = within(await screen.findByRole("dialog"));
  expect(await panel.findByText("다른 상세 키")).toBeVisible();
  expect(detailCalls(api)[0]?.options.query).toEqual({ id: "key_other" });
  expect(panel.queryByText(row.name)).not.toBeInTheDocument();
});
it.each([{ keys: [] }, { keys: [{ ...row, id: "key_foreign" }] }, { keys: [row, row] }])(
  "빈 결과 또는 계약이 다른 응답은 목록으로 대체하지 않는다 (%j)",
  async ({ keys }) => {
    setup("/access/users?tab=keys&api_key_id=key_one", () => ({ api_keys: keys }));
    const panel = within(await screen.findByRole("dialog"));
    expect(
      await panel.findByText(keys.length ? "API 키 상세 조회 실패" : "조회 가능한 API 키가 없습니다."),
    ).toBeVisible();
    expect(panel.queryByText(row.name)).not.toBeInTheDocument();
  },
);
it("중복 ID를 서버에 보내지 않는다", async () => {
  const { api } = setup("/access/users?tab=keys&api_key_id=key_one&api_key_id=key_two");
  expect(await screen.findByText("API 키 상세 주소를 확인하세요.")).toBeVisible();
  expect(detailCalls(api)).toHaveLength(0);
});
it("이전 서버에는 상세 요청을 보내지 않는다", async () => {
  state.auth = { ...state.auth, backendVersion: "v0.86.100" };
  const { api } = setup("/access/users?tab=keys&api_key_id=key_one");
  expect(await screen.findByText("서버 업데이트가 필요합니다.")).toBeVisible();
  expect(detailCalls(api)).toHaveLength(0);
});
it("실패한 상세만 같은 ID로 재시도한다", async () => {
  const user = userEvent.setup();
  let attempts = 0;
  const { api } = setup("/access/users?tab=keys&api_key_id=key_one", () => {
    if (++attempts === 1) throw apiFailure("fixture");
    return { api_keys: [row] };
  });
  const panel = within(await screen.findByRole("dialog"));
  await user.click(await panel.findByRole("button", { name: "다시 시도" }));
  expect(await panel.findByText(row.name)).toBeVisible();
  expect(detailCalls(api).map((call) => call.options.query)).toEqual([{ id: "key_one" }, { id: "key_one" }]);
});
it("상세 권한 거부는 목록과 캐시도 폐기한다", async () => {
  const { client } = setup("/access/users?tab=keys&api_key_id=key_one", () => {
    throw apiFailure("permission", 403);
  });
  expect(await screen.findByText(/키 조회 권한이 거부되어/)).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText(row.name)).not.toBeInTheDocument();
  await waitFor(() =>
    expect(client.getQueryCache().findAll({ queryKey: ["access", "api-keys"] })).toHaveLength(0),
  );
});
it("팀 변경 뒤 늦게 도착한 이전 상세를 노출하지 않는다", async () => {
  let finish: ((value: unknown) => void) | undefined;
  let requests = 0;
  const view = setup("/access/users?tab=keys&api_key_id=key_one", () => {
    requests++;
    if (requests === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return { api_keys: [] };
  });
  await waitFor(() => expect(requests).toBe(1));
  if (!state.auth.user) throw new Error("Authenticated test identity required");
  state.auth = { ...state.auth, user: { ...state.auth.user, team_id: "beta" } };
  view.refresh();
  expect(await screen.findByText("조회 가능한 API 키가 없습니다.")).toBeVisible();
  await act(async () => finish?.({ api_keys: [row] }));
  expect(within(screen.getByRole("dialog")).queryByText(row.name)).not.toBeInTheDocument();
});
it("이전·다음 주소로 상세를 다시 열 수 있다", async () => {
  const user = userEvent.setup();
  setup();
  await user.click(await screen.findByRole("link", { name: row.name }));
  const panel = within(await screen.findByRole("dialog"));
  await panel.findByText("key_one");
  await user.click(panel.getByRole("button", { name: "닫기" }));
  await user.click(screen.getByRole("button", { name: "이전 주소" }));
  expect(await within(await screen.findByRole("dialog")).findByText("key_one")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
