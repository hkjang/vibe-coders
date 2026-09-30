import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { useState, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CostGuardSection } from "./CostGuardSection";
import { useCostGuard } from "./use-cost-guard";
import { PreviewTab } from "@/features/routing/rules/PreviewTab";
import { tokenStore } from "@/shared/auth/token-store";
import { supportsCostGuardContract } from "@/shared/utils/cost-guard";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({
  version: "v0.86.15",
  fallback: true,
  scopes: ["admin:read", "admin:write"] as string[],
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({ backendVersion: runtime.version, legacyFallback: runtime.fallback, scopes: runtime.scopes }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const config = { enabled: true, threshold_krw: 0.125 };
beforeEach(() => {
  runtime.version = "v0.86.15";
  runtime.fallback = true;
  runtime.scopes = ["admin:read", "admin:write"];
  tokenStore.clearAll();
});
function api() {
  return mockApi({ "GET /admin/cost": () => config, "POST /admin/cost": () => config });
}

describe("비용 보호 설정만의 서버 버전 보호", () => {
  it("공통 버전 비교로 누락·잘못된 값·구버전·prerelease를 차단한다", () => {
    for (const version of [undefined, null, "", "unknown", "v0.86.14", "v0.86.15-rc.1"])
      expect(supportsCostGuardContract(version)).toBe(false);
    for (const version of ["v0.86.15", "0.86.15+build", "v0.86.16", "v1.0.0"])
      expect(supportsCostGuardContract(version)).toBe(true);
  });
  it.each(["v0.86.14", "", "broken-version"])(
    "%s 서버에서는 새 확인 계약과 편집을 제공하지 않는다",
    async (version) => {
      runtime.version = version;
      const calls = api();
      renderScreen(<CostGuardSection canWrite />);
      expect(await screen.findByText("비용 보호 설정의 서버 버전을 확인하세요.")).toBeVisible();
      expect(screen.getByRole("button", { name: "비용 보호 설정 수정" })).toBeDisabled();
      expect(screen.queryByText("0.125원")).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "기존 관리자에서 비용 보호 설정 열기" })).toHaveAttribute(
        "href",
        "/admin#/safety",
      );
      expect(calls.bodies("POST /admin/cost")).toEqual([]);
    },
  );
  it("허용되지 않은 기존 관리자 링크는 노출하지 않는다", async () => {
    runtime.version = "v0.86.14";
    runtime.scopes = ["routing:read"];
    api();
    renderScreen(<CostGuardSection canWrite={false} />);
    expect(await screen.findByText("비용 보호 설정의 서버 버전을 확인하세요.")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "기존 관리자에서 비용 보호 설정 열기" }),
    ).not.toBeInTheDocument();
  });
  it("라우팅 요약도 구버전은 미확인으로 남기며 다른 미리보기는 유지한다", async () => {
    runtime.version = "v0.86.14";
    api();
    renderScreen(<PreviewTab canPredict />);
    expect(await screen.findByText("비용 보호 설정의 서버 버전을 확인하세요.")).toBeVisible();
    expect(screen.getByText("설정 미확인")).toBeVisible();
    expect(screen.queryByText("0.125원")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "비용 예측" })).toBeInTheDocument();
  });
  it("열린 초안의 서버 버전이 낮아지면 입력을 보존하고 직접 submit도 차단한다", async () => {
    const calls = api();
    const user = userEvent.setup();
    let refresh: () => void = () => undefined;
    function Harness() {
      const [, render] = useState(0);
      refresh = () => render((count) => count + 1);
      return <CostGuardSection canWrite />;
    }
    renderScreen(<Harness />);
    const edit = screen.getByRole("button", { name: "비용 보호 설정 수정" });
    await waitFor(() => expect(edit).toBeEnabled());
    await user.click(edit);
    const dialog = screen.getByRole("dialog", { name: "비용 보호 설정 수정" });
    const input = within(dialog).getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "12.5");
    act(() => {
      runtime.version = "v0.86.14";
      refresh();
    });
    expect(within(dialog).getByRole("button", { name: "비용 보호 설정 저장" })).toBeDisabled();
    expect(input).toHaveValue(12.5);
    const form = dialog.querySelector("form");
    if (!form) throw new Error("missing cost form");
    fireEvent.submit(form);
    expect(calls.bodies("POST /admin/cost")).toEqual([]);
    act(() => {
      runtime.version = "v0.86.15";
      refresh();
    });
    await user.click(within(dialog).getByRole("button", { name: "비용 보호 설정 저장" }));
    await waitFor(() =>
      expect(calls.bodies("POST /admin/cost")).toEqual([{ enabled: true, threshold_krw: 12.5 }]),
    );
  });
  it("실제 저장 경계가 최신 버전을 확인해 오래된 callback도 거부한다", async () => {
    const calls = api();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    function Wrapper({ children }: PropsWithChildren) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const epoch = tokenStore.getSessionEpoch();
    const { result, rerender } = renderHook(() => useCostGuard(true, epoch), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.confirmed).toEqual(config));
    act(() => result.current.open(document.createElement("button")));
    const target = result.current.target;
    if (!target) throw new Error("missing cost target");
    const submit = result.current.submit;
    runtime.version = "v0.86.14";
    rerender();
    await expect(submit(target, { enabled: true, thresholdKrw: 10 })).rejects.toMatchObject({
      kind: "contract",
    });
    expect(calls.bodies("POST /admin/cost")).toEqual([]);
  });
});
