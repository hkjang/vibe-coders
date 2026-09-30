import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelContractsPanel } from "./ModelContractsPanel";
import { contractFixture } from "./model-governance-test-fixtures";
import { modelGovernanceKeys } from "./use-model-governance";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ZodForm from "@/shared/components/form/use-zod-form";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const gate = vi.hoisted(() => ({ started: false, wait: undefined as Promise<void> | undefined }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});
vi.mock("@/shared/components/form/use-zod-form", async (load) => {
  const real = await load<typeof ZodForm>();
  return {
    useZodForm: (...args: Parameters<typeof real.useZodForm>) => {
      const form = real.useZodForm(...args);
      const handleSubmit: typeof form.handleSubmit =
        (...callbacks) =>
        async (event) => {
          await form.handleSubmit(...callbacks)(event);
          gate.started = true;
          await gate.wait;
        };
      return { ...form, handleSubmit };
    },
  };
});
beforeEach(() => {
  gate.started = false;
  gate.wait = undefined;
  tokenStore.clearAll();
});
async function setup() {
  const api = mockApi({
    "GET /admin/models/contracts": () => ({ contracts: [contractFixture] }),
    "POST /admin/models/contracts": () => ({ id: contractFixture.id, ok: true }),
  });
  let readonly: (value: boolean) => void = () => undefined;
  function Host() {
    const [readOnly, update] = useState(false);
    readonly = update;
    return (
      <FeatureAccessContext.Provider value={{ featureId: "gateway.models", permitted: true, readOnly }}>
        <ModelContractsPanel />
      </FeatureAccessContext.Provider>
    );
  }
  const rendered = renderScreen(<Host />);
  const user = userEvent.setup();
  await screen.findByText(contractFixture.name);
  await user.click(screen.getByRole("button", { name: "수정" }));
  const dialog = await screen.findByRole("dialog");
  const input = within(dialog).getByLabelText(/^이름/u);
  await user.clear(input);
  await user.type(input, "검증 중 고정 초안");
  return { api, user, dialog, input, ...rendered, readonly: (value: boolean) => act(() => readonly(value)) };
}
describe("실제 RHF 검증 뒤 최신 접근 재검사", () => {
  it.each(["readonly", "invalidated"])(
    "비동기검증 중 %s 전환은검토진입·전송0이고입력보존",
    async (boundary) => {
      let release!: () => void;
      gate.wait = new Promise<void>((yes) => {
        release = yes;
      });
      const view = await setup();
      await view.user.click(within(view.dialog).getByRole("button", { name: "변경 내용 검토" }));
      await waitFor(() => expect(gate.started).toBe(true));
      if (boundary === "readonly") view.readonly(true);
      else
        await act(async () => {
          await view.client.invalidateQueries({
            queryKey: modelGovernanceKeys.contracts,
            refetchType: "none",
          });
        });
      await act(async () => {
        release();
      });
      expect(within(view.dialog).queryByRole("table")).not.toBeInTheDocument();
      expect(view.input).toHaveValue("검증 중 고정 초안");
      expect(view.api.bodies("POST /admin/models/contracts")).toEqual([]);
      expect(within(view.dialog).getByRole("button", { name: "변경 내용 검토" })).toBeDisabled();
      view.readonly(false);
      await act(async () => {
        await view.client.refetchQueries({ queryKey: modelGovernanceKeys.contracts });
      });
      expect(within(view.dialog).queryByRole("table")).not.toBeInTheDocument();
      gate.wait = undefined;
      await view.user.click(within(view.dialog).getByRole("button", { name: "변경 내용 검토" }));
      expect(
        await within(view.dialog).findByRole("table", { name: "모델 계약 변경 전후 비교" }),
      ).toHaveTextContent("검증 중 고정 초안");
    },
  );
  it.each([false, true])("이전 세션 검증실패=%s는 새초안에 검토·오류를 남기지 않는다", async (failure) => {
    let release!: () => void;
    let reject!: (cause: unknown) => void;
    gate.wait = new Promise<void>((yes, no) => {
      release = yes;
      reject = no;
    });
    const view = await setup();
    await view.user.click(within(view.dialog).getByRole("button", { name: "변경 내용 검토" }));
    await waitFor(() => expect(gate.started).toBe(true));
    act(() => tokenStore.clearAll());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await view.user.click(screen.getByRole("button", { name: "수정" }));
    const next = await screen.findByRole("dialog");
    await act(async () => {
      if (failure) reject(new Error("old validation"));
      else release();
    });
    expect(within(next).getByLabelText(/^이름/u)).toHaveValue(contractFixture.name);
    expect(within(next).queryByRole("table")).not.toBeInTheDocument();
    expect(within(next).queryByRole("alert")).not.toBeInTheDocument();
    expect(view.api.bodies("POST /admin/models/contracts")).toEqual([]);
  });
});
