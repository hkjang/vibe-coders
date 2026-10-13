import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertRulesSection } from "./AlertRulesSection";
import type { AlertRule } from "@/shared/api/domains/governance";
import { apiFailure, mockApi } from "@/test/api";
import { FeatureAccessHarness } from "@/test/feature-access";
import { renderScreen } from "@/test/render";
import type * as SwitchModule from "@/shared/components/ui/Switch";
import type * as ConfirmModule from "@/shared/components/ui/ConfirmDialog";

const captured = vi.hoisted(() => ({
  toggle: undefined as SwitchModule.SwitchProps["onCheckedChange"] | undefined,
  remove: undefined as Parameters<typeof ConfirmModule.ConfirmDialog>[0]["onConfirm"] | undefined,
}));
vi.mock("@/shared/components/ui/Switch", async (original) => {
  const module = await original<typeof SwitchModule>();
  return {
    ...module,
    Switch: (props: SwitchModule.SwitchProps) => {
      captured.toggle = props.onCheckedChange;
      return <module.Switch {...props} />;
    },
  };
});
vi.mock("@/shared/components/ui/ConfirmDialog", async (original) => {
  const module = await original<typeof ConfirmModule>();
  return {
    ...module,
    ConfirmDialog: (props: Parameters<typeof module.ConfirmDialog>[0]) => {
      if (props.open) captured.remove = props.onConfirm;
      return <module.ConfirmDialog {...props} />;
    },
  };
});

const runtime = vi.hoisted(() => ({
  principal: "public-a",
  scopes: ["security:read", "admin:write"],
  readOnly: false,
}));
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notices }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: runtime.scopes, user: { id: runtime.principal } }) };
});

const rule: AlertRule = {
  id: "public-rule",
  name: "공개 알림",
  metric: "errors",
  scope: "global",
  scope_value: "*",
  threshold: 1,
  window_seconds: 300,
  enabled: true,
};
const createPath = "POST /admin/alerts";
const patchPath = "PATCH /admin/alerts/public-rule";
const deletePath = "DELETE /admin/alerts/public-rule";
function held<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  Object.assign(runtime, {
    principal: "public-a",
    scopes: ["security:read", "admin:write"],
    readOnly: false,
  });
  notices.success.mockClear();
  notices.error.mockClear();
  captured.toggle = undefined;
  captured.remove = undefined;
});
async function setup() {
  const response = {
    rows: [structuredClone(rule)],
    list: (): unknown => ({ rules: response.rows, events: [{ rule_name: "공개 발화" }] }),
    write: (): unknown => ({ ok: true }),
  };
  const api = mockApi({
    "GET /admin/alerts": () => response.list(),
    [createPath]: () => response.write(),
    [patchPath]: () => response.write(),
    [deletePath]: () => response.write(),
  });
  const content = () => (
    <FeatureAccessHarness featureId="governance.policies" readOnly={runtime.readOnly}>
      <AlertRulesSection canWrite={runtime.scopes.includes("admin:write")} />
    </FeatureAccessHarness>
  );
  let refresh = () => {};
  function Host() {
    const [, setRevision] = useState(0);
    useEffect(() => {
      refresh = () => setRevision((value) => value + 1);
    }, []);
    return content();
  }
  const view = renderScreen(<Host />);
  await screen.findByRole("button", { name: "공개 알림 알림 규칙 수정" });
  return {
    api,
    response,
    view,
    user: userEvent.setup(),
    update(change: Partial<typeof runtime>) {
      Object.assign(runtime, change);
      act(() => refresh());
    },
    refetch: () =>
      act(async () => {
        await view.client.refetchQueries({ queryKey: ["governance", "alerts"] });
      }),
  };
}

describe("알림 규칙의 현재 소유권과 변경 권한", () => {
  it.each(["readonly", "scope", "principal", "unmount"])(
    "%s 이후 이전 사용 상태 콜백은 전송하지 않는다",
    async (boundary) => {
      const c = await setup();
      const callback = captured.toggle;
      expect(callback).toBeTypeOf("function");
      if (boundary === "readonly") c.update({ readOnly: true });
      if (boundary === "scope") c.update({ scopes: ["security:read"] });
      if (boundary === "principal") c.update({ principal: "public-b" });
      if (boundary === "unmount") c.view.unmount();
      await act(async () => callback?.(false));
      expect(c.api.bodies(patchPath)).toEqual([]);
    },
  );
  it("같은 규칙의 동시 변경은 한 번만 전송하고 잠금을 유지한다", async () => {
    const c = await setup();
    const pending = held<unknown>();
    c.response.write = () => pending.promise;
    const callback = captured.toggle;
    await act(async () => {
      callback?.(false);
      callback?.(false);
    });
    expect(c.api.bodies(patchPath)).toEqual([{ enabled: false }]);
    expect(screen.getByRole("switch", { name: "공개 알림 사용" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "공개 알림 알림 규칙 수정" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "공개 알림 알림 규칙 삭제" })).toBeDisabled();
    await act(async () => pending.resolve({ ok: true }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "공개 알림 사용" })).toBeEnabled());
    expect(c.api.spy.mock.calls.find(([endpoint]) => endpoint.method === "PATCH")?.[1]).toMatchObject({
      retryUnauthorized: false,
    });
  });
  it("닫힌 삭제 검토를 재사용하지 않고 취소 후 현재 버튼으로 초점을 복원한다", async () => {
    const c = await setup();
    await c.user.click(screen.getByRole("button", { name: "공개 알림 알림 규칙 삭제" }));
    const callback = captured.remove;
    await c.user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "공개 알림 알림 규칙 삭제" })).toHaveFocus(),
    );
    await c.user.click(screen.getByRole("button", { name: "공개 알림 알림 규칙 삭제" }));
    await act(async () => {
      await expect(Promise.resolve(callback?.(""))).rejects.toBeDefined();
    });
    expect(c.api.bodies(deletePath)).toEqual([]);
    await c.user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(c.api.bodies(deletePath)).toHaveLength(1));
    expect(c.api.spy.mock.calls.find(([endpoint]) => endpoint.method === "DELETE")?.[1]).toMatchObject({
      retryUnauthorized: false,
    });
  });
  it.each(["create", "edit"])("%s 권한 복구 뒤 명시 저장하고 인증 후 재전송은 금지한다", async (kind) => {
    const c = await setup();
    await c.user.click(
      screen.getByRole("button", { name: kind === "create" ? "규칙 추가" : "공개 알림 알림 규칙 수정" }),
    );
    const dialog = screen.getByRole("dialog");
    if (kind === "create")
      await c.user.type(within(dialog).getByRole("textbox", { name: "이름" }), "공개 새 규칙");
    await c.user.type(within(dialog).getByRole("textbox", { name: "메모" }), "공개 메모");
    c.update({ scopes: ["security:read"] });
    const button = within(dialog).getByRole("button", { name: kind === "create" ? "규칙 추가" : "저장" });
    expect(button).toBeDisabled();
    c.update({ scopes: ["security:read", "admin:write"] });
    expect(c.api.bodies(kind === "create" ? createPath : patchPath)).toEqual([]);
    await c.user.click(button);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(c.api.bodies(kind === "create" ? createPath : patchPath)).toHaveLength(1);
    expect(
      c.api.spy.mock.calls.find(
        ([endpoint]) => endpoint.method === (kind === "create" ? "POST" : "PATCH"),
      )?.[1],
    ).toMatchObject({ retryUnauthorized: false, body: { note: "공개 메모" } });
  });
  it("읽기 전용에서는 생성·수정·삭제·사용 상태 변경을 차단한다", async () => {
    const c = await setup();
    c.update({ readOnly: true });
    for (const name of ["규칙 추가", "공개 알림 알림 규칙 수정", "공개 알림 알림 규칙 삭제"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "공개 알림 사용" })).toBeDisabled();
  });
  it.each(["create", "edit"])("열린 %s 폼의 초안을 유지하면서 저장을 잠근다", async (kind) => {
    const c = await setup();
    await c.user.click(
      screen.getByRole("button", { name: kind === "create" ? "규칙 추가" : "공개 알림 알림 규칙 수정" }),
    );
    const dialog = screen.getByRole("dialog");
    await c.user.type(within(dialog).getByRole("textbox", { name: "메모" }), "보존할 초안");
    c.update({ readOnly: true });
    expect(within(dialog).getByRole("textbox", { name: "메모" })).toHaveValue("보존할 초안");
    expect(
      within(dialog).getByRole("button", { name: kind === "create" ? "규칙 추가" : "저장" }),
    ).toBeDisabled();
  });
  it.each(["수정", "삭제"])("원본이 바뀌면 열린 %s 검토의 실행을 막는다", async (action) => {
    const c = await setup();
    await c.user.click(screen.getByRole("button", { name: `공개 알림 알림 규칙 ${action}` }));
    c.response.rows = [{ ...rule, threshold: 7 }];
    await c.refetch();
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByRole("button", { name: action === "수정" ? "저장" : "삭제" }),
      ).toBeDisabled(),
    );
    expect(c.api.bodies(patchPath)).toEqual([]);
    expect(c.api.bodies(deletePath)).toEqual([]);
  });
  it.each([401, 403, 503])("조회 %s 실패 시 이전 규칙과 발화 결과를 숨긴다", async (status) => {
    const c = await setup();
    c.response.list = () => {
      throw apiFailure("공개 조회 실패", status);
    };
    await c.refetch();
    await waitFor(() => expect(screen.queryByText("공개 알림")).not.toBeInTheDocument());
    expect(screen.queryByText("공개 발화")).not.toBeInTheDocument();
  });
  it("계정 변경 시 이전 폼과 목록을 폐기한다", async () => {
    const c = await setup();
    await c.user.click(screen.getByRole("button", { name: "공개 알림 알림 규칙 수정" }));
    const next = held<unknown>();
    c.response.list = () => next.promise;
    c.update({ principal: "public-b" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("공개 알림")).not.toBeInTheDocument();
    await act(async () => next.resolve({ rules: [], events: [] }));
  });
  it("이전 계정의 변경 완료는 새 계정 알림과 조회 갱신을 만들지 않는다", async () => {
    const c = await setup();
    const pending = held<unknown>();
    c.response.write = () => pending.promise;
    await c.user.click(screen.getByRole("switch", { name: "공개 알림 사용" }));
    await waitFor(() => expect(c.api.bodies(patchPath)).toHaveLength(1));
    c.update({ principal: "public-b" });
    await screen.findByRole("button", { name: "공개 알림 알림 규칙 수정" });
    const reads = c.api.calls.filter((call) => call.key === "GET /admin/alerts").length;
    await act(async () => pending.resolve({ ok: true }));
    expect(notices.success).not.toHaveBeenCalled();
    expect(notices.error).not.toHaveBeenCalled();
    expect(c.api.calls.filter((call) => call.key === "GET /admin/alerts")).toHaveLength(reads);
  });
});
