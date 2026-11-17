import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TraceRelatedRuns } from "./TraceRelatedRuns";
import { relatedRunsCriteria } from "./related-runs-state";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { migrationRegistry } from "@/config/migration-registry";
import { traceRelatedRunsSchema } from "@/shared/api/domains/trace-related-runs.schema";

const runtime = vi.hoisted(() => ({
  team: "team-a",
  user: "owner-a",
  denied: false,
  scopes: ["admin:read"],
  prefixes: ["corp_"],
}));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "authenticated",
    backendVersion: "v0.86.152",
    credentialPrefixes: runtime.prefixes,
    user: {
      id: runtime.user,
      team_id: runtime.team,
      roles: ["admin"],
      role: "admin",
      scopes: runtime.scopes,
    },
    features: migrationRegistry.map((feature) =>
      feature.featureId.startsWith("agents.") && runtime.denied
        ? { ...feature, serverAvailable: false }
        : feature,
    ),
    legacyFallback: true,
  }),
}));
const row = {
  row_key: `run_${"a".repeat(43)}`,
  id: "run-a",
  resource_id: "wf-a",
  resource_name: "질의 처리",
  status: "ok",
  created_at: "2026-11-18T00:00:00Z",
  latency_ms: 120,
  cost_krw: 2,
  receipt_available: true,
};
const relatedEndpoint = withPathParams(endpoints.domains.observability.relatedRuns, { trace_id: "trace-a" });
const page = { related_runs_version: 1, kind: "workflow", limit: 25, offset: 0, items: [row], total: 30 };
function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="현재 주소">{location.search}</output>
      <button onClick={() => void navigate(-1)}>기록 뒤로</button>
    </>
  );
}
function setup(entry = "/observability/traces?trace_id=trace-a&model=test-model") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <FeatureAccessContext.Provider
          value={{
            featureId: "observability.traces",
            permitted: true,
            readOnly: true,
            status: "preview_read_only",
          }}
        >
          <TraceRelatedRuns />
          <Probe />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(view), client, view };
}
function requestMock() {
  return vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, options) => {
    expect(endpoint).toEqual(relatedEndpoint);
    const query = options?.query as { kind: string; limit: number; offset: number };
    return { ...page, ...query, items: [{ ...row, id: `${query.kind}-${query.offset}` }] } as never;
  });
}
describe("연관 실행", () => {
  beforeEach(() => {
    runtime.team = "team-a";
    runtime.user = "owner-a";
    runtime.denied = false;
    runtime.scopes = ["admin:read"];
  });
  it("연관 실행 범위와 원화, 본인 영수증 및 정의 링크를 표시하고 접근성을 유지한다", async () => {
    const request = requestMock();
    const { container } = setup();
    expect(await screen.findByRole("link", { name: "내 실행 영수증" })).toHaveAttribute(
      "href",
      "/agents/workflows?tab=runs&run=workflow-0",
    );
    expect(screen.getByRole("link", { name: "정의 보기" })).toHaveAttribute(
      "href",
      "/agents/workflows?workflow=wf-a",
    );
    expect(screen.getByText(/요청 목록의 기간·상태·모델 필터는 적용되지/)).toBeVisible();
    expect(request).toHaveBeenCalledWith(
      relatedEndpoint,
      expect.objectContaining({
        query: { kind: "workflow", limit: 25, offset: 0 },
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect((await axe.run(container)).violations).toEqual([]);
  });
  it("페이지 및 실행 종류를 URL에 저장하며 필터와 키보드 초점을 보존한다", async () => {
    const request = requestMock();
    const user = userEvent.setup();
    setup();
    await screen.findByText("workflow-0");
    await user.click(screen.getByRole("button", { name: "다음 실행" }));
    await screen.findByText("workflow-25");
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("model=test-model");
    const select = screen.getByRole("combobox", { name: "실행 종류" });
    select.focus();
    await user.selectOptions(select, "app");
    await screen.findByText("app-0");
    expect(screen.getByRole("combobox", { name: "실행 종류" })).toHaveFocus();
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("related_offset=0");
    expect(request).toHaveBeenLastCalledWith(
      relatedEndpoint,
      expect.objectContaining({ query: { kind: "app", limit: 25, offset: 0 } }),
    );
    await user.click(screen.getByRole("button", { name: "기록 뒤로" }));
    await screen.findByText("workflow-25");
  });
  it("다른 팀으로 변경하면 이전 데이터와 미완료 응답을 폐기한다", async () => {
    let complete: ((value: never) => void) | undefined;
    const request = vi
      .spyOn(apiClient, "request")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue({ ...page, items: [{ ...row, id: "new-owner-run" }] } as never);
    const view = setup();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const signal = request.mock.calls[0]?.[1]?.signal;
    runtime.team = "team-b";
    runtime.user = "owner-b";
    view.rerender(
      <QueryClientProvider client={view.client}>
        <MemoryRouter>
          <FeatureAccessContext.Provider
            value={{
              featureId: "observability.traces",
              permitted: true,
              readOnly: true,
              status: "preview_read_only",
            }}
          >
            <TraceRelatedRuns />
            <Probe />
          </FeatureAccessContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("new-owner-run");
    expect(signal?.aborted).toBe(true);
    await act(async () => complete?.(page as never));
    expect(screen.queryByText("run-a")).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        view.client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('"run-a"');
  });
  it("403 이후 기존 결과를 닫고 명시적으로 권한 확인 후 재조회한다", async () => {
    const request = vi
      .spyOn(apiClient, "request")
      .mockResolvedValueOnce(page as never)
      .mockRejectedValueOnce(new AppError("private failure", { kind: "permission", status: 403 }))
      .mockResolvedValue(page as never);
    const user = userEvent.setup();
    setup();
    await screen.findByText("run-a");
    await user.click(screen.getByRole("button", { name: "연관 실행 새로고침" }));
    await screen.findByText("연관 실행 조회 권한 확인 필요");
    expect(screen.queryByText("run-a")).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "권한 확인 후 연관 실행 다시 조회" }));
    await screen.findByText("run-a");
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("실패와 데이터 없음을 구분하며 원문 오류를 노출하지 않는다", async () => {
    vi.spyOn(apiClient, "request").mockRejectedValue(
      new AppError("private-prompt", { kind: "http", status: 500, requestId: "diagnostic-1" }),
    );
    setup();
    await screen.findByRole("heading", { name: "연관 실행을 불러오지 못했습니다." });
    expect(screen.queryByText("private-prompt")).not.toBeInTheDocument();
    expect(screen.queryByText(/현재 페이지에 연관 실행이 없습니다/)).not.toBeInTheDocument();
  });
  it("타인 영수증과 권한이 없는 화면 링크를 노출하지 않는다", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue({
      ...page,
      items: [{ ...row, receipt_available: false }],
    } as never);
    runtime.denied = true;
    setup();
    await screen.findByText("run-a");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
  it.each([
    "trace_id=one&trace_id=two",
    "trace_id=%20one",
    "trace_id=corp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "trace_id=one&related_offset=01",
    "trace_id=one&related_kind=other",
    "trace_id=one&related_limit=10",
    "trace_id=one&related_offset=25&related_limit=50",
  ])("잘못된 주소 %s는 조회하지 않는다", async (search) => {
    const request = requestMock();
    setup(`/observability/traces?${search}`);
    expect(screen.getByText("연관 실행 조회 주소를 확인하세요.")).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  });
  it("추적 ID가 없으면 연관 실행을 조회하지 않는다", () => {
    const request = requestMock();
    setup("/observability/traces");
    expect(request).not.toHaveBeenCalled();
    expect(relatedRunsCriteria(new URLSearchParams(), []).state).toBe("absent");
  });
  it("다른 조회 기준의 응답을 표시하지 않는다", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue({ ...page, kind: "app" } as never);
    setup();
    await screen.findByText("연관 실행을 불러오지 못했습니다.");
    expect(screen.queryByText("run-a")).not.toBeInTheDocument();
  });
  it("계약은 원문 및 중복 행, 잘못된 개수·지표를 거부한다", () => {
    expect(traceRelatedRunsSchema.safeParse(page).success).toBe(true);
    for (const bad of [
      { ...page, output: "raw" },
      { ...page, items: [{ ...row, output_summary: "raw" }] },
      { ...page, items: [row, row] },
      { ...page, total: 0 },
      { ...page, items: [{ ...row, cost_krw: -1 }] },
    ])
      expect(traceRelatedRunsSchema.safeParse(bad).success).toBe(false);
  });
});
