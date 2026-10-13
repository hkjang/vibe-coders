import { useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiKeysTab } from "./ApiKeysTab";
import { apiKeyPublicSchema } from "@/shared/api/domains/access.schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ role: "admin", scopes: ["admin:read", "admin:write"] }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const row = apiKeyPublicSchema.parse({
  id: "key_review",
  revision: "a".repeat(64),
  name: "검토 대상 키",
  role: "developer",
  status: "active",
  scopes: ["models:read"],
});
const operations = [
  { trigger: "키 발급", title: "API 키 발급", submit: "발급", endpoint: "POST /admin/api-keys" },
  { trigger: "수정", title: "API 키 수정", submit: "저장", endpoint: "PATCH /admin/api-keys/key_review" },
  {
    trigger: "권한 수정",
    title: "API 키 권한 수정",
    submit: "권한 저장",
    endpoint: "PATCH /admin/api-keys/key_review",
  },
  { trigger: "폐기", title: "API 키 폐기", submit: "폐기", endpoint: "DELETE /admin/api-keys/key_review" },
] as const;

beforeEach(() => tokenStore.clearAll());

it("요청별 비용 상한의 의미와 필드 오류를 표시하고 올바른 소수 금액만 발급한다", async () => {
  const user = userEvent.setup();
  const api = mockApi({
    "GET /admin/api-keys": () => ({ api_keys: [] }),
    "POST /admin/api-keys": () => ({ api_key: { id: "key_created" }, secret: "synthetic-test-secret" }),
  });
  renderScreen(
    <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: false }}>
      <ApiKeysTab canWrite isSuperAdmin writeDeniedReason="관리 변경 권한 필요" />
    </FeatureAccessContext.Provider>,
  );
  await user.click(await screen.findByRole("button", { name: "키 발급" }));
  const dialog = await screen.findByRole("dialog", { name: "API 키 발급" });
  await user.type(within(dialog).getByLabelText("이름", { exact: false }), "비용 확인 키");
  const input = within(dialog).getByLabelText("요청별 예상 비용 상한(원)");
  expect(dialog).toHaveTextContent("누적 월 예산이 아닙니다.");
  expect(input).toHaveAttribute("step", "any");
  fireEvent.change(input, { target: { value: "-1" } });
  await user.click(within(dialog).getByRole("button", { name: "발급" }));
  expect(await within(dialog).findByText("0 이상의 올바른 금액을 입력하세요.")).toBeVisible();
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(api.bodies("POST /admin/api-keys")).toHaveLength(0);
  fireEvent.change(input, { target: { value: "0.5" } });
  await user.click(within(dialog).getByRole("button", { name: "발급" }));
  await waitFor(() => expect(api.bodies("POST /admin/api-keys")).toHaveLength(1));
  expect(api.bodies("POST /admin/api-keys")[0]).toMatchObject({ budget_limit_krw: 0.5 });
});

describe.each(["permission", "readonly", "allowed"] as const)("관리자 키 실행 중 %s 전환", (mode) => {
  it.each(operations)(
    mode === "allowed"
      ? "$title의 허용된 변경은 한 번만 전송한다"
      : "열린 $title 초안은 유지하고 제출을 차단한다",
    async (operation) => {
      const user = userEvent.setup();
      const api = mockApi({
        "GET /admin/api-keys": () => ({ api_keys: [row], revoke_review_supported: true }),
        "GET /admin/roles": () => ({ roles: [], all_scopes: ["models:read", "chat:completion"] }),
        "POST /admin/api-keys": () => ({ api_key: { id: "key_created" }, secret: "synthetic-test-secret" }),
        "PATCH /admin/api-keys/key_review": () => ({}),
        "DELETE /admin/api-keys/key_review": () => ({}),
      });
      let restrict: () => void = () => {
        throw new Error("harness not mounted");
      };
      function Harness() {
        const [restricted, setRestricted] = useState(false);
        restrict = () => setRestricted(true);
        return (
          <FeatureAccessContext.Provider
            value={{
              featureId: "access.users",
              permitted: true,
              readOnly: mode === "readonly" && restricted,
            }}
          >
            <ApiKeysTab
              canWrite={mode !== "permission" || !restricted}
              isSuperAdmin
              writeDeniedReason="관리 변경 권한 필요"
            />
          </FeatureAccessContext.Provider>
        );
      }
      renderScreen(<Harness />);
      await user.click(await screen.findByRole("button", { name: operation.trigger }));
      const dialog = await screen.findByRole("dialog", { name: operation.title });
      if (operation.trigger === "키 발급") {
        await user.type(within(dialog).getByLabelText("이름", { exact: false }), "새 테스트 키");
      }
      if (operation.trigger === "폐기") {
        await user.type(within(dialog).getByLabelText("확인 문구", { exact: false }), row.id);
        await user.type(within(dialog).getByLabelText("변경 사유", { exact: false }), "운영 키 정리");
      }
      const submit = within(dialog).getByRole("button", { name: operation.submit });
      await waitFor(() => expect(submit).toBeEnabled());
      act(() => restrict());
      expect(dialog).toBeInTheDocument();
      // Even a direct form submission must hit a fresh permission check.
      const form = dialog.querySelector("form");
      await act(async () => {
        if (form) fireEvent.submit(form);
        else fireEvent.click(submit);
      });
      const sent = api.calls.filter((call) => call.key === operation.endpoint);
      if (mode === "allowed") {
        expect(sent).toHaveLength(1);
        const call = api.spy.mock.calls.find(
          ([endpoint]) => `${endpoint.method} ${endpoint.path}` === operation.endpoint,
        );
        expect(call?.[1]).toMatchObject({ retryUnauthorized: false });
        return;
      }
      expect(sent).toHaveLength(0);
      expect(submit).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "취소" })).toBeEnabled();
    },
  );
});
