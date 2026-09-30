import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayHealthPage } from "./GatewayHealthPage";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { usePreferences } from "@/shared/stores/preferences";
import { tokenStore } from "@/shared/auth/token-store";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ readOnly: false, scopes: ["routing:read", "routing:write"] }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes });
      return {
        ...auth,
        features: auth.features.map((feature) => ({ ...feature, readOnly: runtime.readOnly })),
      };
    },
  };
});
async function setup(write: ApiHandler = () => ({ status: "reset" })) {
  const api = mockApi({
    "GET /health": () => ({ status: "ok" }),
    "GET /ready": () => ({ status: "ready" }),
    "GET /admin/routing/health": () => ({
      since: "2026-09-01T00:00:00Z",
      until: "2026-09-02T00:00:00Z",
      threshold: 70,
      providers: [],
      ranking: [],
      degraded: [],
      alerts: [],
      trend: [],
      breakers: {
        enabled: true,
        threshold: 3,
        cooldown_seconds: 30,
        shared: false,
        instance_id: "fixture",
        states: [
          {
            provider: "public-provider",
            provider_ref: `prv_${"a".repeat(43)}`,
            phase: "open",
            failures: 3,
            opens: 1,
            last_reason: "",
            retry_in_seconds: 12,
          },
        ],
      },
    }),
    "GET /admin/routing/balancer": () => ({
      mode: "session_hash",
      active_sessions: 2,
      sticky_sessions: true,
      multi_instance_safe: false,
      pools: [],
    }),
    "POST /admin/routing/breaker-reset": write,
    "POST /admin/routing/balancer": write,
  });
  const selected = migrationRegistry.find((feature) => feature.featureId === "gateway.health");
  if (!selected) throw new Error("missing health feature");
  const feature = selected;
  let refresh: () => void = () => undefined;
  function Host() {
    const [, redraw] = useState(0);
    refresh = () => redraw((value) => value + 1);
    return (
      <FeatureRoute feature={feature}>
        <GatewayHealthPage />
      </FeatureRoute>
    );
  }
  renderScreen(<Host />, { route: "/gateway/health" });
  await screen.findByRole("button", { name: "세션 고정 전체 해제" });
  await waitFor(() => expect(screen.getByRole("button", { name: /^새로고침$/u })).toBeEnabled());
  return {
    api,
    user: userEvent.setup(),
    readonly: (value: boolean) => {
      runtime.readOnly = value;
      act(refresh);
    },
  };
}
beforeEach(() => {
  runtime.readOnly = false;
  runtime.scopes = ["routing:read", "routing:write"];
  usePreferences.setState({ refreshInterval: 0 });
  tokenStore.clearAll();
  toast.success.mockClear();
  toast.error.mockClear();
});
describe("게이트웨이 상태 runtime readonly", () => {
  it("routing:write가 있어도 FeatureRoute readonly는 두 복구 작업을 막는다", async () => {
    runtime.readOnly = true;
    await setup();
    expect(screen.getByRole("button", { name: "세션 고정 전체 해제" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^전체 해제$/u })).toBeDisabled();
  });
  it.each([
    ["해제", "회로 차단기 해제", "POST /admin/routing/breaker-reset", "public-provider"],
    ["전체 해제", "회로 차단기 해제", "POST /admin/routing/breaker-reset", ""],
    ["세션 고정 전체 해제", "세션 고정 해제", "POST /admin/routing/balancer", ""],
  ])(
    "%s 확인 대상은 readonly에도 보존되고 복구 뒤 수동 한 번만 전송된다",
    async (opener, title, endpoint, target) => {
      const current = await setup();
      await current.user.click(screen.getByRole("button", { name: opener }));
      const dialog = await screen.findByRole("dialog", { name: title });
      const description = dialog.getAttribute("aria-describedby");
      const original = description ? document.getElementById(description)?.textContent : undefined;
      current.readonly(true);
      expect(within(dialog).getByRole("button", { name: "해제" })).toBeDisabled();
      expect(description ? document.getElementById(description)?.textContent : undefined).toBe(original);
      expect(current.api.bodies(endpoint)).toEqual([]);
      current.readonly(false);
      expect(current.api.bodies(endpoint)).toEqual([]);
      await current.user.click(within(dialog).getByRole("button", { name: "해제" }));
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(current.api.bodies(endpoint)).toEqual([{ provider: target }]);
    },
  );
  it("admin:write는 routing:write를 대체하지 않고 단순 권한 부족을 readonly로 표시하지 않는다", async () => {
    runtime.scopes = ["admin:write", "routing:read"];
    await setup();
    expect(screen.getByRole("button", { name: "세션 고정 전체 해제" })).toBeDisabled();
    expect(screen.getByText("조작 권한 없음")).toBeVisible();
    expect(screen.queryByText("읽기 전용")).not.toBeInTheDocument();
  });
  it.each([false, true])(
    "이미 전송한 작업의 늦은 응답은 새 세션 확인창을 닫거나 오류를 넣지 않는다: failure=%s",
    async (failure) => {
      let settle!: () => void;
      let calls = 0;
      const current = await setup(() => {
        calls += 1;
        return calls === 1
          ? new Promise((resolve, reject) => {
              settle = () =>
                failure ? reject(apiFailure("synthetic", 500, "old-request")) : resolve({ status: "reset" });
            })
          : { status: "reset" };
      });
      await current.user.click(screen.getByRole("button", { name: "해제" }));
      await current.user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "해제" }));
      await waitFor(() => expect(calls).toBe(1));
      act(() => {
        tokenStore.clearAll();
        tokenStore.saveTokens({ access_token: "public-next-session", refresh_token: "public-next-refresh" });
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await current.user.click(screen.getByRole("button", { name: "전체 해제" }));
      const next = screen.getByRole("dialog", { name: "회로 차단기 해제" });
      await act(async () => settle());
      expect(next).toBeInTheDocument();
      expect(within(next).queryByRole("alert")).not.toBeInTheDocument();
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      await current.user.click(within(next).getByRole("button", { name: "해제" }));
      await waitFor(() =>
        expect(current.api.bodies("POST /admin/routing/breaker-reset")).toEqual([
          { provider: "public-provider" },
          { provider: "" },
        ]),
      );
    },
  );
});
