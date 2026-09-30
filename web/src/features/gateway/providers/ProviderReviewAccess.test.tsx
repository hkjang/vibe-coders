import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderEditDialog } from "./ProviderEditDialog";
import { buildProviderRows } from "./provider-catalog";
import { providerImpactFixture } from "./provider-impact-test-fixtures";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ZodFormModule from "@/shared/components/form/use-zod-form";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { featureReadonlyReason } from "@/shared/feature-access/policy";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ readOnly: false }));
const validation = vi.hoisted(() => ({ started: false, wait: undefined as Promise<void> | undefined }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});
vi.mock("@/shared/components/form/use-zod-form", async (load) => {
  const real = await load<typeof ZodFormModule>();
  return {
    useZodForm: (...args: Parameters<typeof real.useZodForm>) => {
      const form = real.useZodForm(...args);
      const handleSubmit: typeof form.handleSubmit =
        (...callbacks) =>
        async (event) => {
          await form.handleSubmit(...callbacks)(event);
          validation.started = true;
          await validation.wait;
        };
      return { ...form, handleSubmit };
    },
  };
});

const row = buildProviderRows([
  {
    name: "fixed-provider",
    provider_ref: `prv_${"a".repeat(43)}`,
    base_url: "https://initial.example.invalid/v1",
    api_key_configured: true,
    enabled: true,
    timeout_ms: 30000,
    model_patterns: "*",
    failover_group: "",
    priority: 10,
    created_at: "2026-09-01T00:00:00Z",
  },
])[0];

function setup() {
  if (!row) throw new Error("missing fixed provider");
  const snapshot = row;
  const save = vi.fn(async () => undefined);
  mockApi({ "GET /admin/provider-impact": () => providerImpactFixture(snapshot.identity) });
  let refresh: () => void = () => undefined;
  function Host() {
    const [, redraw] = useState(0);
    const trigger = useRef<HTMLButtonElement>(null);
    refresh = () => redraw((value) => value + 1);
    return (
      <FeatureAccessContext.Provider
        value={{ featureId: "gateway.providers", permitted: true, readOnly: runtime.readOnly }}
      >
        <button ref={trigger}>기존 수정 버튼</button>
        <ProviderEditDialog
          row={snapshot}
          onSubmit={save}
          onOpenChange={() => undefined}
          returnFocusRef={trigger}
        />
      </FeatureAccessContext.Provider>
    );
  }
  renderScreen(<Host />);
  return { save, refresh, user: userEvent.setup() };
}
beforeEach(() => {
  runtime.readOnly = false;
  validation.started = false;
  validation.wait = undefined;
  tokenStore.clearAll();
});

describe("비동기 검증 뒤 공급자 검토 준비 경계", () => {
  it("읽기 전용 전환 중 검증이 끝나도 초안을 검토로 넘기거나 전송하지 않는다", async () => {
    let release!: () => void;
    validation.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = setup();
    const input = screen.getByLabelText(/^기본 URL/u);
    await current.user.clear(input);
    await current.user.type(input, "https://draft.example.invalid/v1");
    await current.user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    await waitFor(() => expect(validation.started).toBe(true));
    runtime.readOnly = true;
    act(current.refresh);
    await act(async () => {
      release();
    });
    expect(screen.queryByRole("table", { name: "공급자 변경 전후 비교" })).not.toBeInTheDocument();
    expect(input).toHaveValue("https://draft.example.invalid/v1");
    expect(input).toBeDisabled();
    expect(screen.getByText(featureReadonlyReason)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("이 작업을 수행할 권한이 없습니다.");
    expect(current.save).not.toHaveBeenCalled();
    runtime.readOnly = false;
    act(current.refresh);
    expect(screen.queryByRole("table", { name: "공급자 변경 전후 비교" })).not.toBeInTheDocument();
    validation.wait = undefined;
    await current.user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    expect(await screen.findByRole("table", { name: "공급자 변경 전후 비교" })).toHaveTextContent(
      "draft.example.invalid",
    );
    expect(current.save).not.toHaveBeenCalled();
  });

  it.each([false, true])("새 세션에서 이전 검증 %s 완료는 검토·오류를 남기지 않는다", async (failure) => {
    let release!: () => void;
    let reject!: (cause: unknown) => void;
    validation.wait = new Promise<void>((resolve, no) => {
      release = resolve;
      reject = no;
    });
    const current = setup();
    await current.user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    await waitFor(() => expect(validation.started).toBe(true));
    act(() => {
      tokenStore.clearAll();
      current.refresh();
    });
    await act(async () => {
      if (failure) reject(new Error("old validation failed"));
      else release();
    });
    expect(screen.queryByRole("table", { name: "공급자 변경 전후 비교" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^기본 URL/u)).toHaveValue("https://initial.example.invalid/v1");
    expect(current.save).not.toHaveBeenCalled();
  });
});
