import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelContractsPanel } from "./ModelContractsPanel";
import { ModelDeprecationsPanel } from "./ModelDeprecationsPanel";
import { contractFixture, deprecationFixture, runFixture } from "./model-governance-test-fixtures";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});
beforeEach(() => {
  tokenStore.clearAll();
  toast.success.mockClear();
  toast.error.mockClear();
});
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup(
  kind: "contract" | "delete" | "deprecation" | "deprecationDelete",
  handlers: Record<string, ApiHandler> = {},
) {
  const api = mockApi({
    "GET /admin/models/contracts": () => ({ contracts: [contractFixture] }),
    "GET /admin/model-deprecations": () => ({ deprecations: [deprecationFixture] }),
    "POST /admin/models/contracts": () => ({ id: contractFixture.id, ok: true }),
    "DELETE /admin/models/contracts": () => ({ ok: true }),
    "POST /admin/model-deprecations": () => ({ deprecation: deprecationFixture }),
    "DELETE /admin/model-deprecations/moddep_original": () => ({ id: deprecationFixture.id, deleted: true }),
    "POST /admin/models/contracts/run": () => runFixture,
    ...handlers,
  });
  let setReadonly: (value: boolean) => void = () => undefined;
  function Host() {
    const [readOnly, change] = useState(false);
    setReadonly = change;
    return (
      <main id="main-content" tabIndex={-1}>
        <FeatureAccessContext.Provider value={{ featureId: "gateway.models", permitted: true, readOnly }}>
          {kind.startsWith("deprecation") ? <ModelDeprecationsPanel /> : <ModelContractsPanel />}
        </FeatureAccessContext.Provider>
      </main>
    );
  }
  renderScreen(<Host />);
  await screen.findByRole("table");
  const user = userEvent.setup();
  async function open() {
    await user.click(
      screen.getByRole("button", {
        name: kind === "contract" ? "수정" : kind === "deprecation" ? "정책 추가" : "삭제",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    if (kind === "contract") {
      const name = within(dialog).getByLabelText(/^이름/u);
      await user.clear(name);
      await user.type(name, "수동 초안");
      await user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
      await within(dialog).findByRole("table", { name: "모델 계약 변경 전후 비교" });
    } else if (kind === "deprecation") await user.type(within(dialog).getByLabelText(/^모델 패턴/u), "old-*");
    return dialog;
  }
  return { api, user, open, readonly: (value: boolean) => act(() => setReadonly(value)) };
}
const operations = [
  ["contract", "POST /admin/models/contracts", "검토한 계약 저장"],
  ["delete", "DELETE /admin/models/contracts", "삭제"],
  ["deprecation", "POST /admin/model-deprecations", "저장"],
  ["deprecationDelete", "DELETE /admin/model-deprecations/moddep_original", "삭제"],
] as const;
describe("모델 관리 요청·초안 소유권", () => {
  it("동일 tick 검토 저장은한번,실패RequestID와동일payload를보존하여수동재시도한다", async () => {
    const pending = deferred();
    let calls = 0;
    const view = await setup("contract", {
      "POST /admin/models/contracts": () =>
        ++calls === 1 ? pending.promise : { id: contractFixture.id, ok: true },
    });
    const dialog = await view.open();
    const form = dialog.querySelector("form");
    if (!form) throw new Error("missing form");
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(calls).toBe(1));
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    await view.user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    await act(async () => pending.reject(apiFailure("synthetic failure", 503, "req_contract_retry")));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("req_contract_retry");
    view.readonly(true);
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(calls).toBe(1);
    view.readonly(false);
    expect(calls).toBe(1);
    await view.user.click(within(dialog).getByRole("button", { name: "검토한 계약 저장" }));
    await waitFor(() => expect(calls).toBe(2));
    expect(view.api.bodies("POST /admin/models/contracts")[1]).toEqual(
      view.api.bodies("POST /admin/models/contracts")[0],
    );
  });
  it("전송후readonly와후속GET실패는성공한POST를실패로재분류하지않는다", async () => {
    const pending = deferred();
    let failedRead = false;
    const view = await setup("contract", {
      "POST /admin/models/contracts": () => pending.promise,
      "GET /admin/models/contracts": () => {
        if (failedRead) throw apiFailure("synthetic read", 503, "req_after_save");
        return { contracts: [contractFixture] };
      },
    });
    const dialog = await view.open();
    await view.user.click(within(dialog).getByRole("button", { name: "검토한 계약 저장" }));
    await waitFor(() => expect(view.api.bodies("POST /admin/models/contracts")).toHaveLength(1));
    view.readonly(true);
    failedRead = true;
    await act(async () => pending.resolve({ id: contractFixture.id, ok: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText(/req_after_save/u)).toBeVisible();
    expect(toast.success).toHaveBeenCalledExactlyOnceWith("모델 계약을 저장했습니다.");
    expect(toast.error).not.toHaveBeenCalled();
    expect(view.api.bodies("POST /admin/models/contracts")).toHaveLength(1);
  });
  for (const [kind, endpoint, label] of operations) {
    it.each([false, true])(
      `${kind} 이전세션의 늦은 실패=%s는새확인창/초안/알림을 건드리지않는다`,
      async (failure) => {
        const pending = deferred();
        let calls = 0;
        const view = await setup(kind, {
          [endpoint]: () =>
            ++calls === 1
              ? pending.promise
              : endpoint.includes("model-deprecations")
                ? { deprecation: deprecationFixture, id: deprecationFixture.id, deleted: true }
                : { id: contractFixture.id, ok: true },
        });
        const first = await view.open();
        await view.user.click(within(first).getByRole("button", { name: label }));
        await waitFor(() => expect(calls).toBe(1));
        act(() => {
          tokenStore.clearAll();
          tokenStore.saveTokens({
            access_token: "public-second",
            refresh_token: "public-refresh",
          });
        });
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        const next = await view.open();
        const reads = view.api.calls.filter((call) => call.key.startsWith("GET ")).length;
        await act(async () => {
          if (failure) pending.reject(apiFailure("old failure", 503, "req_old"));
          else pending.resolve({ id: contractFixture.id, ok: true });
        });
        expect(next).toBeVisible();
        expect(within(next).queryByRole("alert")).not.toBeInTheDocument();
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
        expect(view.api.calls.filter((call) => call.key.startsWith("GET "))).toHaveLength(reads);
        expect(calls).toBe(1);
        await view.user.click(within(next).getByRole("button", { name: label }));
        await waitFor(() => expect(calls).toBe(2));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      },
    );
  }
});
