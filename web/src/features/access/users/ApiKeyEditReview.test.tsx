import { useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeysTab } from "./ApiKeysTab";
import { accessKeys } from "./use-access-admin";
import { apiKeyPublicSchema } from "@/shared/api/domains/access.schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { keyEditReasonSchema } from "./use-key-edit-review";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ role: "admin", scopes: ["admin:read", "admin:write"] }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const row = apiKeyPublicSchema.parse({
  id: "key_edit",
  name: "검토용 키",
  status: "active",
  role: "developer",
  scopes: ["models:read"],
  revision: "a".repeat(64),
});
const endpoint = "PATCH /admin/api-keys/key_edit";
beforeEach(() => tokenStore.clearAll());

function setup(supported = true, mutation: ApiHandler = () => ({}), target = row) {
  const api = mockApi({
    "GET /admin/api-keys": () => ({ api_keys: [target], edit_review_supported: supported }),
    "GET /admin/roles": () => ({ roles: [], all_scopes: ["models:read", "chat:completion"] }),
    [endpoint]: mutation,
  });
  let restrict = () => {};
  function Harness() {
    const [canWrite, setCanWrite] = useState(true);
    restrict = () => setCanWrite(false);
    return (
      <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: false }}>
        <ApiKeysTab canWrite={canWrite} isSuperAdmin writeDeniedReason="관리 변경 권한 필요" />
      </FeatureAccessContext.Provider>
    );
  }
  return { api, ...renderScreen(<Harness />), restrict: () => restrict() };
}

const modes = [
  { trigger: "수정", title: "API 키 수정", save: "검토한 변경 저장" },
  { trigger: "권한 수정", title: "API 키 권한 수정", save: "권한 저장" },
] as const;
async function draft(mode: (typeof modes)[number]) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: mode.trigger }));
  const dialog = await screen.findByRole("dialog", { name: mode.title });
  if (mode.trigger === "수정") {
    fireEvent.change(within(dialog).getByRole("textbox", { name: "이름" }), {
      target: { value: "새 이름" },
    });
  } else {
    await user.click(within(dialog).getByRole("checkbox", { name: /models:read/ }));
  }
  const reason = within(dialog).getByRole("textbox", { name: "변경 사유" });
  fireEvent.change(reason, { target: { value: "운영 권한 정비" } });
  return {
    user,
    dialog,
    reason,
    confirm: () => within(dialog).getByRole("checkbox", { name: /변경 내용과 영향을 확인했습니다/ }),
    save: () => within(dialog).getByRole("button", { name: mode.save }),
  };
}

describe.each(modes)("$title 검토", (mode) => {
  it("변경 전후와 사유를 확인해야 하며 변경된 필드와 스냅샷만 한 번 전송한다", async () => {
    const { api } = setup();
    const { user, dialog, confirm, save } = await draft(mode);
    expect(within(dialog).getByRole("region", { name: "변경 전후 비교" })).toBeVisible();
    await user.click(save());
    expect(api.bodies(endpoint)).toHaveLength(0);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("변경 내용 확인을 다시 검토하세요");
    await user.click(confirm());
    await user.click(save());
    await waitFor(() =>
      expect(api.bodies(endpoint)).toEqual([
        {
          ...(mode.trigger === "수정" ? { name: "새 이름" } : { scopes: [] }),
          review: { reason: "운영 권한 정비", expected_revision: row.revision },
        },
      ]),
    );
  });
  it("입력을 바꿨다가 복원해도 이전 확인을 재사용하지 않는다", async () => {
    const { api } = setup();
    const { user, reason, confirm, save } = await draft(mode);
    await user.click(confirm());
    fireEvent.change(reason, { target: { value: "다른 사유" } });
    fireEvent.change(reason, { target: { value: "운영 권한 정비" } });
    expect(confirm()).not.toBeChecked();
    await user.click(save());
    expect(api.bodies(endpoint)).toHaveLength(0);
  });
  it("최신 목록이 바뀌면 초안을 유지하면서 직접 제출도 차단한다", async () => {
    const { api, client } = setup();
    const { user, dialog, reason, confirm, save } = await draft(mode);
    await user.click(confirm());
    act(() =>
      client.setQueriesData(
        { queryKey: accessKeys.apiKeys },
        { api_keys: [{ ...row, revision: "b".repeat(64) }], edit_review_supported: true },
      ),
    );
    expect(save()).toBeDisabled();
    expect(reason).toHaveValue("운영 권한 정비");
    const form = dialog.querySelector("form");
    if (!form) throw new Error("missing key edit form");
    fireEvent.submit(form);
    expect(api.bodies(endpoint)).toHaveLength(0);
  });
  it("현재 변경 권한을 잃으면 확인이 해제되고 초안을 유지한다", async () => {
    const { api, restrict } = setup();
    const { user, reason, confirm, save } = await draft(mode);
    await user.click(confirm());
    act(restrict);
    expect(save()).toBeDisabled();
    expect(confirm()).not.toBeChecked();
    expect(reason).toHaveValue("운영 권한 정비");
    expect(api.bodies(endpoint)).toHaveLength(0);
  });
  it("구버전 서버에는 검토 필드가 무시될 수 있는 변경을 보내지 않는다", async () => {
    const { api } = setup(false);
    const { dialog, save } = await draft(mode);
    expect(save()).toBeDisabled();
    expect(dialog).toHaveTextContent("서버가 검토 수정을 지원하지 않습니다");
    expect(api.bodies(endpoint)).toHaveLength(0);
  });
  it("결과가 불확실한 실패를 자동 재전송하지 않는다", async () => {
    const { api } = setup(true, () => {
      throw apiFailure("private response", 503, "req-edit");
    });
    const { user, dialog, confirm, save } = await draft(mode);
    await user.click(confirm());
    await user.click(save());
    await waitFor(() => expect(api.bodies(endpoint)).toHaveLength(1));
    expect(save()).toBeDisabled();
    expect(dialog).not.toHaveTextContent("private response");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("재전송하지 말고 목록과 감사 이력");
    const form = dialog.querySelector("form");
    if (!form) throw new Error("missing key edit form");
    fireEvent.submit(form);
    expect(api.bodies(endpoint)).toHaveLength(1);
  });
});

it("변경 사유는 서버와 같은 유니코드 문자 수로 검증한다", () => {
  expect(keyEditReasonSchema.safeParse(" ").success).toBe(false);
  expect(keyEditReasonSchema.safeParse("😀".repeat(1024)).success).toBe(true);
  expect(keyEditReasonSchema.safeParse("😀".repeat(1025)).success).toBe(false);
});

it("외부 키의 이름만 수정하면 외부 상태를 유지하고 폐기로 잘못 표시하지 않는다", async () => {
  const { api } = setup(true, undefined, { ...row, status: "external" });
  const { user, dialog, confirm, save } = await draft(modes[0]);
  expect(within(dialog).getByRole("combobox", { name: "상태" })).toHaveValue("unchanged");
  expect(dialog).toHaveTextContent("현재 상태: 외부 키");
  expect(within(dialog).getByRole("region", { name: "변경 전후 비교" })).not.toHaveTextContent("폐기");
  await user.click(confirm());
  await user.click(save());
  await waitFor(() =>
    expect(api.bodies(endpoint)).toEqual([
      { name: "새 이름", review: { reason: "운영 권한 정비", expected_revision: row.revision } },
    ]),
  );
});

it("외부 키를 명시적으로 사용 상태로 바꾸면 상태 변경도 검토해 전송한다", async () => {
  const { api } = setup(true, undefined, { ...row, status: "external" });
  const { user, dialog, confirm, save } = await draft(modes[0]);
  await user.selectOptions(within(dialog).getByRole("combobox", { name: "상태" }), "active");
  expect(within(dialog).getByRole("region", { name: "변경 전후 비교" })).toHaveTextContent("외부 키");
  await user.click(confirm());
  await user.click(save());
  await waitFor(() =>
    expect(api.bodies(endpoint)).toEqual([
      {
        name: "새 이름",
        status: "active",
        review: { reason: "운영 권한 정비", expected_revision: row.revision },
      },
    ]),
  );
});
