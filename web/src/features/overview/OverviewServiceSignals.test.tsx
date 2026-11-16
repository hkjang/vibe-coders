import { useLayoutEffect, useState } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import {
  mcpServiceSummarySchema,
  text2sqlServiceSummarySchema,
} from "@/shared/api/domains/service-summaries";
import { testAuth } from "@/test/auth";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
import { mcpSummary, text2sqlSummary } from "../../../tests/fixtures/service-summaries";
import { OverviewRefreshContext } from "./overview-refresh-context";
import { OverviewServiceSignals } from "./OverviewServiceSignals";

const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
let fail = 0;
let refreshers = new Set<() => void>();
vi.mock("@/shared/api/client", () => ({ apiClient: { request: vi.fn() } }));
const read = vi.mocked(apiClient.request);
beforeEach(() => {
  state.auth = testAuth({ backendVersion: "v0.86.128" });
  fail = 0;
  refreshers = new Set();
  read.mockReset().mockImplementation(async (endpoint, options) => {
    if (endpoint.path === "/admin/mcp/overview") {
      if (fail)
        throw new AppError("private-server-error", {
          kind: "http",
          status: fail,
          requestId: "service-request",
        });
      return mcpSummary as never;
    }
    if (endpoint.path === "/admin/text2sql/summary")
      return {
        ...text2sqlSummary,
        window: options?.query && "window" in options.query ? options.query.window : undefined,
      } as never;
    throw new Error("unexpected endpoint");
  });
});
const component = (range: "24h" | "7d" = "24h") => (
  <FeatureAccessHarness featureId="overview" readOnly>
    <OverviewRefreshContext value={refreshers}>
      <button
        onClick={() => {
          for (const refresh of refreshers) refresh();
        }}
      >
        전체 새로고침
      </button>
      <OverviewServiceSignals range={range} interval={false} />
    </OverviewRefreshContext>
  </FeatureAccessHarness>
);
function setup() {
  let setRange: (range: "24h" | "7d") => void = () => undefined;
  let refresh: () => void = () => undefined;
  function Host() {
    const [range, updateRange] = useState<"24h" | "7d">("24h");
    const [, update] = useState(0);
    useLayoutEffect(() => {
      setRange = updateRange;
      refresh = () => update((n) => n + 1);
    }, []);
    return component(range);
  }
  return {
    ...renderScreen(<Host />),
    setRange: (range: "24h" | "7d") => act(() => setRange(range)),
    refresh: () => act(refresh),
  };
}
const widget = (name: string) => {
  const element = screen.getByRole("heading", { name }).closest("article");
  if (!element) throw new Error("Missing service widget");
  return element;
};

it("전체 MCP 기록과 검증 통과율을 구분하고 질문·SQL 원문 API를 조회하지 않는다", async () => {
  setup();
  await screen.findByText("1,234");
  await screen.findByText("95%");
  expect(screen.getByText("경로 발견 서버")).toBeVisible();
  expect(screen.getByText(/SQL 실행 성공률이 아닙니다/)).toBeVisible();
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("link", { name: "MCP 상태 열기" })).toHaveAttribute("href", "/mcp");
});
it("선택 기간은 Text2SQL만 다시 조회하고 MCP 24시간 집계는 유지한다", async () => {
  const view = setup();
  await screen.findByText("95%");
  view.setRange("7d");
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(read.mock.calls.filter(([endpoint]) => endpoint.path === "/admin/mcp/overview")).toHaveLength(1);
  expect(read.mock.calls.at(-1)?.[1]?.query).toEqual({ window: "7d" });
});
it.each(["hidden", "scope", "legacy", "rollout", "old-backend"])(
  "%s에서는 요약 조회 권한을 넓히지 않는다",
  async (restriction) => {
    if (restriction === "scope") state.auth = testAuth({ scopes: [] });
    if (restriction === "old-backend") state.auth.backendVersion = "v0.86.127";
    if (["hidden", "legacy", "rollout"].includes(restriction))
      state.auth.features = state.auth.features.map((f) =>
        f.featureId === "mcp.overview" || f.featureId === "text2sql.overview"
          ? {
              ...f,
              serverAvailable: undefined,
              status: restriction === "hidden" ? "hidden" : restriction === "legacy" ? "legacy" : "preview",
              rolloutPercent: restriction === "rollout" ? 0 : 100,
            }
          : f,
      );
    setup();
    await act(async () => {});
    expect(read).not.toHaveBeenCalled();
    if (["hidden", "scope"].includes(restriction))
      expect(screen.queryByRole("heading", { name: "연결 서비스" })).toBeNull();
    else expect(screen.getAllByText("요약 미제공")).toHaveLength(2);
  },
);
it.each([401, 403])("%s 뒤 이전 MCP 수치는 지우고 다른 서비스와 수동 재시도는 유지한다", async (status) => {
  const view = setup();
  await screen.findByText("1,234");
  fail = status;
  await userEvent.click(screen.getByRole("button", { name: "전체 새로고침" }));
  await waitFor(() => expect(screen.queryByText("1,234")).toBeNull());
  expect(screen.getByText("95%")).toBeVisible();
  expect(JSON.stringify(view.client.getQueryData(["overview", "mcp-service"]) ?? {})).not.toContain("1234");
  fail = 0;
  await userEvent.click(within(widget("MCP 도구 호출")).getByRole("button", { name: /다시|재시도/ }));
  await screen.findByText("1,234");
});
it("일시적 실패는 마지막 정상 수치와 갱신 실패를 함께 보여 준다", async () => {
  setup();
  await screen.findByText("1,234");
  fail = 503;
  await userEvent.click(screen.getByRole("button", { name: "전체 새로고침" }));
  await screen.findByText("갱신 실패");
  expect(screen.getByText("1,234")).toBeVisible();
  expect(screen.getByText("95%")).toBeVisible();
  expect(screen.queryByText("private-server-error")).toBeNull();
});
it("서비스 권한 제거 시 진행 중인 응답과 캐시를 폐기한다", async () => {
  let finish: (data: typeof mcpSummary) => void = () => undefined;
  read.mockImplementation(async (endpoint) =>
    endpoint.path === "/admin/mcp/overview"
      ? new Promise((resolve) => {
          finish = (data) => resolve(data as never);
        })
      : (text2sqlSummary as never),
  );
  const view = setup();
  await screen.findByText("95%");
  state.auth = { ...state.auth, features: state.auth.features.filter((f) => f.featureId !== "mcp.overview") };
  view.refresh();
  await act(async () => finish(mcpSummary));
  expect(screen.queryByText("1,234")).toBeNull();
  expect(view.client.getQueryCache().findAll({ queryKey: ["overview", "mcp-service"] })).toHaveLength(0);
});
it("0건은 성공률 0%로 표시하지 않으며 비활성 상태를 구분한다", async () => {
  read.mockImplementation(async (endpoint) =>
    endpoint.path === "/admin/mcp/overview"
      ? ({
          ...mcpSummary,
          upstream_count: 0,
          enabled_upstream_count: 0,
          recent_call_count: 0,
          recent_error_count: 0,
          discovery_error_count: 0,
        } as never)
      : ({
          ...text2sqlSummary,
          enabled: false,
          stats: { total: 0, valid: 0, executed: 0, errors: 0, cost_krw: 0, valid_rate: 0 },
        } as never),
  );
  setup();
  await screen.findByText("미설정");
  await screen.findByText("비활성");
  expect(screen.queryByText("0%")).toBeNull();
});
it("필수 집계가 누락되거나 원문 필드가 추가된 응답을 0건으로 정규화하지 않는다", () => {
  expect(mcpServiceSummarySchema.safeParse(mcpSummary).success).toBe(true);
  expect(text2sqlServiceSummarySchema.safeParse(text2sqlSummary).success).toBe(true);
  expect(mcpServiceSummarySchema.safeParse({ ...mcpSummary, recent_error_count: undefined }).success).toBe(
    false,
  );
  expect(text2sqlServiceSummarySchema.safeParse({ ...text2sqlSummary, logs: ["private"] }).success).toBe(
    false,
  );
});
