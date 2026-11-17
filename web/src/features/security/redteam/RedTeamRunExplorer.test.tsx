import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation, useNavigate } from "react-router";
import axe from "axe-core";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { RedTeamHistoryBoundary } from "./RedTeamHistoryBoundary";
import { RedTeamRunExplorer } from "./RedTeamRunExplorer";
import { RunResultsSheet } from "./RunResultsSheet";
import type { RedTeamRunMetadata } from "@/shared/api/generated";

const auth = vi.hoisted(() => ({ backendVersion: "v0.86.146", scopes: ["admin:read"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth(auth) };
});
const runs: RedTeamRunMetadata[] = Array.from({ length: 127 }, (_, i) => ({
  id: `run-${String(i).padStart(3, "0")}`,
  campaign_id: "campaign",
  target_id: "target",
  started_at: "2026-11-01T00:00:00Z",
  ended_at: "",
  created_at: "2026-11-01T00:00:00Z",
  status: i < 2 ? "stopped" : "passed",
  mode: i < 2 ? "active-controlled" : "dry-run",
  total_cases: 1,
  failed_cases: 0,
  risk_score: 0,
  cost_krw: 0,
  ...(i < 2 ? { source_result_id: "original", review_id: "review" } : {}),
}));
function handlers() {
  return {
    "GET /admin/redteam/runs": ({ query }: { query?: object }) => {
      const q = query as Record<string, string | number>;
      const rows = runs.filter(
        (run) =>
          (!q.source_result_id || run.source_result_id === q.source_result_id) &&
          (!q.status || run.status === q.status),
      );
      return {
        runs: rows.slice(Number(q.offset), Number(q.offset) + Number(q.limit)),
        total: rows.length,
        offset: q.offset,
        limit: q.limit,
        generated_at: "2026-11-17T00:00:00Z",
      };
    },
    "GET /admin/redteam/runs/run-100/results": () => ({
      run: runs[100],
      results: [],
      prompts: {},
      count: 0,
      masked: true,
    }),
  };
}
function Harness() {
  const [params, update] = useSearchState();
  const location = useLocation(),
    navigate = useNavigate();
  return (
    <FeatureAccessContext.Provider value={{ featureId: "security.redteam", permitted: true, readOnly: true }}>
      <output aria-label="현재 주소">{location.search}</output>
      <button onClick={() => void navigate(-1)}>뒤로</button>
      <RedTeamHistoryBoundary>
        <RedTeamRunExplorer onOpen={(run) => update({ run }, { replace: false })} />
        <RunResultsSheet
          canWrite={false}
          onClose={() => update({ run: null }, { replace: false })}
          onCreateRemediation={() => undefined}
          onOpenEvidence={() => undefined}
          remediationByResult={new Map()}
          returnFocusRef={{ current: null }}
          runId={params.get("run") ?? ""}
          writeTitle="조회 전용"
        />
      </RedTeamHistoryBoundary>
    </FeatureAccessContext.Provider>
  );
}
const mount = (route = "/redteam?tab=runs") => renderScreen(<Harness />, { route });
beforeEach(() => {
  auth.backendVersion = "v0.86.146";
  auth.scopes = ["admin:read"];
});
afterEach(() => vi.restoreAllMocks());

describe("실행 이력 탐색", () => {
  it("100건 이후 페이지와 상세 주소를 복원하고 뒤로 가기를 지원한다", async () => {
    const api = mockApi(handlers());
    const user = userEvent.setup();
    mount("/redteam?tab=runs&runs_page=5");
    const link = await screen.findByRole("link", { name: "run-100 실행 상세" });
    expect(link).toHaveAttribute("href", "/redteam?tab=runs&runs_page=5&run=run-100");
    await user.click(link);
    expect(await screen.findByRole("dialog", { name: "레드팀 결과" })).toBeInTheDocument();
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent("run=run-100");
    expect(api.calls.find((call) => call.key.endsWith("/runs"))?.options.query).toMatchObject({
      view: "page",
      limit: 25,
      offset: 100,
    });
    await user.click(screen.getByRole("button", { name: "패널 닫기" }));
    await user.click(screen.getByRole("button", { name: "뒤로" }));
    expect(await screen.findByRole("dialog", { name: "레드팀 결과" })).toBeInTheDocument();
  });
  it("직접 상세 주소로 실행을 연다", async () => {
    mockApi(handlers());
    mount("/redteam?tab=runs&run=run-100");
    const dialog = await screen.findByRole("dialog", { name: "레드팀 결과" });
    expect(await within(dialog).findByText("run-100")).toBeInTheDocument();
  });
  it("조건 적용 때 페이지를 초기화하고 재실행 원본을 검색한다", async () => {
    const api = mockApi(handlers());
    const user = userEvent.setup();
    mount("/redteam?tab=runs&runs_page=5");
    await screen.findByRole("button", { name: "run-100 결과 보기" });
    await user.click(screen.getByText("식별자·기간 상세 조건"));
    await user.type(screen.getByLabelText("원본 결과 ID"), "original");
    expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("original");
    await user.selectOptions(screen.getByLabelText("실행 상태"), "stopped");
    await user.click(screen.getByRole("button", { name: "조건 적용" }));
    expect(await screen.findByText("조건에 맞는 실행 2건")).toBeInTheDocument();
    expect(api.calls.at(-1)?.options.query).toMatchObject({
      offset: 0,
      source_result_id: "original",
      status: "stopped",
    });
    expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("runs_page");
    await user.selectOptions(screen.getByLabelText("페이지당 표시 건수"), "50");
    await waitFor(() => expect(api.calls.at(-1)?.options.query).toMatchObject({ limit: 50, offset: 0 }));
  });
  it.each([
    "runs_page=0",
    "runs_status=bad",
    "runs_source_result_id=sk-proj-privatecredential12345678",
    "run=a&run=b",
  ])("잘못된 주소로 이력을 조회하지 않는다: %s", async (query) => {
    const api = mockApi(handlers());
    mount(`/redteam?tab=runs&${query}`);
    expect(await screen.findByText("실행 이력 조건을 확인하세요.")).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
  it("구버전 서버에서 필터를 버리고 전체 조회하지 않는다", async () => {
    auth.backendVersion = "v0.86.144";
    const api = mockApi(handlers());
    mount("/redteam?tab=runs&runs_source_result_id=original");
    expect(await screen.findByText(/서버 v0.86.145 이상/)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
  it("권한 오류가 나면 기존 목록과 상세 캐시를 닫는다", async () => {
    let denied = false;
    const list = handlers()["GET /admin/redteam/runs"];
    mockApi({
      ...handlers(),
      "GET /admin/redteam/runs": (options) => {
        if (denied) throw apiFailure("denied", 403);
        return list(options);
      },
    });
    const user = userEvent.setup();
    const { client } = mount();
    await screen.findByRole("button", { name: "run-000 결과 보기" });
    denied = true;
    await user.click(screen.getByRole("button", { name: "이력 새로고침" }));
    expect(await screen.findByText("실행 이력 조회 권한을 확인하세요.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "run-000 결과 보기" })).not.toBeInTheDocument();
    expect(
      client
        .getQueryCache()
        .getAll()
        .some((query) => query.queryKey.includes("redteam-run-history")),
    ).toBe(false);
  });
  it("한글 필터와 표가 기본 접근성 검사를 통과한다", async () => {
    mockApi(handlers());
    const { container } = mount();
    await screen.findByRole("button", { name: "run-000 결과 보기" });
    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
