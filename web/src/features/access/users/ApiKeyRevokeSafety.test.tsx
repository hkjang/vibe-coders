import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ApiKeysTab } from "./ApiKeysTab";
import { accessKeys } from "./use-access-admin";
import { apiKeyPublicSchema } from "@/shared/api/domains/access.schemas";
import { AppError } from "@/shared/api/error";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ role: "super_admin" }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const row = apiKeyPublicSchema.parse({
  id: "key_review",
  name: "폐기 대상 키",
  revision: "a".repeat(64),
  status: "active",
});
const endpoint = "DELETE /admin/api-keys/key_review";
function setup(supported = true, failure = false) {
  const api = mockApi({
    "GET /admin/api-keys": () => ({ api_keys: [row], revoke_review_supported: supported }),
    [endpoint]: () => {
      if (failure) throw new AppError("응답 없음", { kind: "network" });
      return { id: row.id, status: "revoked" };
    },
  });
  const view = renderScreen(
    <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: false }}>
      <ApiKeysTab canWrite isSuperAdmin writeDeniedReason="변경 권한 필요" />
    </FeatureAccessContext.Provider>,
  );
  return { api, ...view };
}
async function review() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "폐기" }));
  const dialog = await screen.findByRole("dialog", { name: "API 키 폐기" });
  return { user, dialog };
}
it("대상과 사유를 확인하고 검토 버전을 보내며 완전 삭제 범위를 정확히 설명한다", async () => {
  const { api } = setup();
  const { user, dialog } = await review();
  const submit = within(dialog).getByRole("button", { name: "폐기" });
  expect(submit).toBeDisabled();
  expect(dialog).toHaveTextContent("기존 요청·감사 이력과 교체 이력은 남으며");
  await user.type(within(dialog).getByLabelText("확인 문구", { exact: false }), row.id);
  expect(submit).toBeDisabled();
  await user.type(within(dialog).getByLabelText("변경 사유", { exact: false }), "사용 종료");
  await user.click(within(dialog).getByRole("checkbox", { name: /^완전 삭제/ }));
  await user.click(submit);
  await waitFor(() =>
    expect(api.bodies(endpoint)).toEqual([{ reason: "사용 종료", expected_revision: row.revision }]),
  );
  const call = api.spy.mock.calls.find(([route]) => route.method === "DELETE");
  expect(call?.[1]).toMatchObject({ query: { hard: 1 }, retryUnauthorized: false });
});
it("구버전 서버에서는 확인 폐기를 실행하지 않는다", async () => {
  const { api } = setup(false);
  const { dialog } = await review();
  expect(within(dialog).getByRole("button", { name: "폐기" })).toBeDisabled();
  expect(dialog).toHaveTextContent("서버가 검토 폐기를 지원하지 않습니다");
  expect(api.bodies(endpoint)).toHaveLength(0);
});
it("검토 후 목록의 버전이 바뀌면 이전 확인을 전송하지 않는다", async () => {
  const { api, client } = setup();
  const { user, dialog } = await review();
  await user.type(within(dialog).getByLabelText("확인 문구", { exact: false }), row.id);
  await user.type(within(dialog).getByLabelText("변경 사유", { exact: false }), "검토 완료");
  act(() =>
    client.setQueriesData(
      { queryKey: accessKeys.apiKeys },
      { api_keys: [{ ...row, revision: "b".repeat(64) }], revoke_review_supported: true },
    ),
  );
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "폐기" })).toBeDisabled());
  expect(api.bodies(endpoint)).toHaveLength(0);
});
it("응답을 잃으면 확인창과 다시 연 목록에서 자동·수동 중복 요청을 차단한다", async () => {
  const { api } = setup(true, true);
  const { user, dialog } = await review();
  await user.type(within(dialog).getByLabelText("확인 문구", { exact: false }), row.id);
  await user.type(within(dialog).getByLabelText("변경 사유", { exact: false }), "사용 종료");
  await user.click(within(dialog).getByRole("button", { name: "폐기" }));
  await within(dialog).findByRole("alert");
  expect(within(dialog).getByRole("button", { name: "폐기" })).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "취소" }));
  expect(await screen.findByRole("button", { name: "폐기" })).toBeDisabled();
  expect(api.bodies(endpoint)).toHaveLength(1);
});
