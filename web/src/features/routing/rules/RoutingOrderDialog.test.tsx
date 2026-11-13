import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/shared/api/client";
import { routingOrderEndpoints, type OrderSnapshot } from "@/shared/api/domains/routing-order";
import type { RoutingOrderRequest } from "@/shared/api/generated";
import { AppError } from "@/shared/api/error";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";
import { renderScreen } from "@/test/render";
import { RoutingOrderButton } from "./RoutingOrderButton";
import { orderText } from "./routing-order-state";

const runtime = vi.hoisted(() => ({
  version: "v0.86.91",
  scopes: ["routing:read", "routing:write"],
  user: "operator-a",
  readonly: false,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({ backendVersion: runtime.version, scopes: runtime.scopes, user: { id: runtime.user } }),
  };
});
const toasts = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
const snapshot: OrderSnapshot = {
  revision: "a".repeat(64),
  ambiguous_ties: false,
  rules: ["z-first", "a-second", "disabled"].map((id, index) => ({
    id,
    enabled: index !== 2,
    priority: 100,
    match_pattern: "public-*",
    min_complexity: 0,
    max_complexity: 100,
    target_model: id,
    target_provider: "",
    note: "preserved",
    created_at: `2026-11-01T00:00:0${index}Z`,
  })),
};
beforeEach(() => {
  runtime.version = "v0.86.91";
  runtime.scopes = ["routing:read", "routing:write"];
  runtime.user = "operator-a";
  runtime.readonly = false;
  toasts.success.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  tokenStore.clearAll();
});

function setup() {
  const calls: Array<{ kind: string; body: unknown }> = [];
  const responses: {
    snapshot?: () => unknown;
    preview?: () => Promise<unknown>;
    save?: (body: RoutingOrderRequest) => unknown;
  } = {};
  const spy = vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, options = {}) => {
    const kind =
      endpoint === routingOrderEndpoints.snapshot
        ? "snapshot"
        : endpoint === routingOrderEndpoints.preview
          ? "preview"
          : "save";
    calls.push({ kind, body: options.body });
    let raw: unknown;
    if (kind === "snapshot") raw = responses.snapshot?.() ?? structuredClone(snapshot);
    else if (kind === "preview")
      raw = responses.preview
        ? await responses.preview()
        : {
            stage: "complexity_rules",
            revision: snapshot.revision,
            ambiguous_before_order: false,
            before: {
              matched_rule_id: "z-first",
              applied: true,
              target_model: "z-first",
              target_provider: "",
            },
            after: {
              matched_rule_id: "a-second",
              applied: true,
              target_model: "a-second",
              target_provider: "",
            },
          };
    else {
      const body = options.body as RoutingOrderRequest;
      raw = responses.save
        ? await responses.save(body)
        : {
            revision: "b".repeat(64),
            ambiguous_ties: false,
            rules: body.order.map((id, index) => ({
              ...snapshot.rules.find((rule) => rule.id === id),
              priority: index + 1,
            })),
          };
    }
    const parsed = endpoint.schema.safeParse(raw);
    if (!parsed.success) throw new AppError("malformed synthetic response", { kind: "contract" });
    return parsed.data as never;
  });
  let refresh = () => {};
  function Harness() {
    const [, update] = useState(0);
    refresh = () => update((value) => value + 1);
    return (
      <FeatureAccessContext.Provider
        value={{ featureId: "routing.rules", permitted: true, readOnly: runtime.readonly, status: "preview" }}
      >
        <RoutingOrderButton canWrite />
      </FeatureAccessContext.Provider>
    );
  }
  const rendered = renderScreen(<Harness />, { route: "/routing/rules" });
  return { ...rendered, calls, responses, spy, user: userEvent.setup(), refresh: () => act(refresh) };
}
type Harness = ReturnType<typeof setup>;
async function open(current: Harness) {
  await current.user.click(screen.getByRole("button", { name: orderText.title }));
  // Loading and ready views have distinct dialog lifetimes; do not retain the
  // detached loading container while awaiting the first lazy module response.
  await screen.findByRole("button", { name: "1번째 규칙 아래로" });
  return screen.getByRole("dialog", { name: orderText.title });
}
async function review(current: Harness, dialog: HTMLElement) {
  await current.user.click(within(dialog).getByRole("button", { name: "2번째 규칙 위로" }));
  await current.user.type(within(dialog).getByLabelText(/변경 사유/u), "순서 검증 완료");
  await current.user.type(within(dialog).getByLabelText(/검증할 모델명/u), "public-model");
  await current.user.click(within(dialog).getByRole("button", { name: "순서 변경 비교" }));
  await within(dialog).findByRole("region", { name: "변경 후 선택" });
  await current.user.click(within(dialog).getByRole("checkbox", { name: orderText.confirm }));
}

describe("라우팅 순서의 원본·검토·저장 경계", () => {
  it("서버 순서와 전체 우선순위 차이를 보여주고 검토한 순서를 한 번 저장한다", async () => {
    const current = setup();
    const dialog = await open(current);
    const rows = within(dialog).getByRole("list");
    expect(within(rows).getAllByRole("listitem")[0]).toHaveTextContent("z-first");
    expect(rows).toHaveTextContent("우선순위 100 → 1");
    await review(current, dialog);
    expect(dialog).toHaveTextContent(orderText.scope);
    const save = within(dialog).getByRole("button", { name: "검토한 순서 저장" });
    await current.user.dblClick(save);
    await within(dialog).findByText(orderText.saved);
    expect(current.calls.filter((call) => call.kind === "save")).toEqual([
      {
        kind: "save",
        body: {
          order: ["a-second", "z-first", "disabled"],
          expected_revision: snapshot.revision,
          reason: "순서 검증 완료",
        },
      },
    ]);
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(save).toBeDisabled();
    await current.user.click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: orderText.title })).toHaveFocus());
  });
  it.each(["model", "complexity", "reason"] as const)(
    "%s 입력이 바뀌면 비교와 확인을 폐기한다",
    async (field) => {
      const current = setup();
      const dialog = await open(current);
      await review(current, dialog);
      const label = { model: /검증할 모델명/u, complexity: /요청 복잡도/u, reason: /변경 사유/u }[field];
      await current.user.type(within(dialog).getByLabelText(label), "1");
      expect(within(dialog).queryByRole("region", { name: "변경 후 선택" })).not.toBeInTheDocument();
      expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
      expect(within(dialog).getByRole("button", { name: "검토한 순서 저장" })).toBeDisabled();
      expect(current.calls.some((call) => call.kind === "save")).toBe(false);
    },
  );
  it("오류 필드로 초점을 옮기며 원문을 전송하지 않는다", async () => {
    const current = setup();
    const dialog = await open(current);
    await current.user.click(within(dialog).getByRole("button", { name: "순서 변경 비교" }));
    expect(within(dialog).getByLabelText(/검증할 모델명/u)).toHaveFocus();
    expect(dialog).toHaveTextContent("모델명을 1~256자로");
    expect(current.calls.map((call) => call.kind)).toEqual(["snapshot"]);
  });
  it.each(["network", "malformed", "conflict"])(
    "%s 응답 후에는 다시 저장하지 않고 확인 안내를 유지한다",
    async (mode) => {
      const current = setup();
      const dialog = await open(current);
      await review(current, dialog);
      current.responses.save = () => {
        if (mode === "malformed") return { ...snapshot, revision: "b".repeat(64) };
        throw new AppError("private server detail", {
          kind: mode === "network" ? "network" : "http",
          status: mode === "conflict" ? 409 : undefined,
          code: mode === "conflict" ? "routing_order_conflict" : undefined,
        });
      };
      await current.user.click(within(dialog).getByRole("button", { name: "검토한 순서 저장" }));
      await within(dialog).findByRole("alert");
      expect(dialog).toHaveTextContent(mode === "conflict" ? orderText.stale : orderText.unknown);
      expect(dialog).not.toHaveTextContent("private server detail");
      expect(within(dialog).getByRole("button", { name: "검토한 순서 저장" })).toBeDisabled();
      expect(current.calls.filter((call) => call.kind === "save")).toHaveLength(1);
      expect(toasts.success).not.toHaveBeenCalled();
    },
  );
  it("변경을 버릴 때 확인하고 규칙 이동 전에는 바로 닫는다", async () => {
    const current = setup();
    let dialog = await open(current);
    await current.user.click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    dialog = await open(current);
    await current.user.click(within(dialog).getByRole("button", { name: "1번째 규칙 아래로" }));
    await current.user.click(within(dialog).getByRole("button", { name: "닫기" }));
    const warning = await screen.findByRole("alertdialog");
    await current.user.click(within(warning).getByRole("button", { name: "변경 버리기" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: orderText.title })).not.toBeInTheDocument(),
    );
    expect(current.calls.some((call) => call.kind === "save")).toBe(false);
  });
  it.each(["old-version", "read-only", "write-only"])(
    "%s 권한에서는 순서 편집을 열거나 조회하지 않는다",
    async (mode) => {
      if (mode === "old-version") runtime.version = "v0.86.90";
      if (mode === "read-only") runtime.readonly = true;
      if (mode === "write-only") runtime.scopes = ["routing:write"];
      const current = setup();
      if (mode === "old-version") {
        expect(screen.queryByRole("button", { name: orderText.title })).not.toBeInTheDocument();
        expect(current.calls).toEqual([]);
        return;
      }
      const trigger = screen.getByRole("button", { name: orderText.title });
      expect(trigger).toBeDisabled();
      await current.user.click(trigger);
      expect(current.calls).toEqual([]);
    },
  );
  it("검토 후 변경 권한이 없어지면 확인과 저장을 막는다", async () => {
    const current = setup();
    const dialog = await open(current);
    await review(current, dialog);
    runtime.readonly = true;
    current.refresh();
    expect(within(dialog).getByRole("button", { name: "검토한 순서 저장" })).toBeDisabled();
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
    expect(current.calls.some((call) => call.kind === "save")).toBe(false);
  });
  it("다른 사용자로 바뀐 뒤 늦게 도착한 비교 결과를 폐기한다", async () => {
    const current = setup();
    const dialog = await open(current);
    let resolve!: (value: unknown) => void;
    current.responses.preview = () =>
      new Promise((done) => {
        resolve = done;
      });
    await current.user.type(within(dialog).getByLabelText(/검증할 모델명/u), "public-model");
    await current.user.click(within(dialog).getByRole("button", { name: "순서 변경 비교" }));
    runtime.user = "operator-b";
    current.refresh();
    await act(async () =>
      resolve({
        stage: "complexity_rules",
        revision: snapshot.revision,
        ambiguous_before_order: false,
        before: {
          matched_rule_id: "private-old",
          applied: false,
          target_model: "old-model",
          target_provider: "",
        },
        after: {
          matched_rule_id: "private-old",
          applied: false,
          target_model: "old-model",
          target_provider: "",
        },
      }),
    );
    expect(screen.queryByText("old-model")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: orderText.title })).not.toBeInTheDocument();
    expect(toasts.success).not.toHaveBeenCalled();
  });
});
