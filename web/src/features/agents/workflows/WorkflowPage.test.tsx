import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowPage } from "@/features/agents/workflows/WorkflowPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

const workflow = {
  id: "wf_reporting",
  name: "주간 보고 자동화",
  description: "주간 지표를 모아 보고서를 만듭니다.",
  steps: [
    { name: "지표 수집", type: "text2sql" },
    { name: "초안 작성", type: "chat", ref: "vibe/auto", max_tokens: 800 },
  ],
  allowed_teams: "platform",
  enabled: true,
  created_by: "admin",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-05T02:00:00Z",
};

const listHandler = () => ({ workflows: [workflow] });

function renderPage(route = "/agents/workflows"): ReturnType<typeof renderScreen> {
  return renderScreen(<WorkflowPage />, { path: "/agents/workflows", route });
}

describe("WorkflowPage", () => {
  beforeEach(() => {
    authRuntime.scopes = ["admin:read", "admin:write"];
  });

  it("shows the workflow list with its key values", async () => {
    mockApi({ "GET /admin/workflows": listHandler });
    renderPage();

    expect(await screen.findByRole("heading", { level: 1, name: "워크플로" })).toBeVisible();
    const table = await screen.findByRole("table", { name: "정의된 워크플로 목록" });
    expect(within(table).getByText("주간 보고 자동화")).toBeVisible();
    expect(within(table).getByText("platform")).toBeVisible();
    expect(within(table).getByText("사용")).toBeVisible();
  });

  it("shows an empty state when no workflow is defined", async () => {
    mockApi({ "GET /admin/workflows": () => ({ workflows: [] }) });
    renderPage();

    expect(await screen.findByText("아직 워크플로가 없습니다.")).toBeVisible();
  });

  it("shows the request id when the list fails", async () => {
    mockApi({
      "GET /admin/workflows": () => {
        throw apiFailure("workflow store unavailable", 500, "req_wf_1");
      },
    });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("요청 ID: req_wf_1");
  });

  it("disables write actions without admin:write", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi({ "GET /admin/workflows": listHandler });
    renderPage();

    expect(await screen.findByRole("button", { name: /새 워크플로/u })).toBeDisabled();
  });

  it("runs a dry-run from the detail panel", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /admin/workflows": listHandler,
      "POST /admin/workflows/wf_reporting/dry-run": () => ({
        workflow_id: "wf_reporting",
        name: "주간 보고 자동화",
        steps: [
          { name: "지표 수집", type: "text2sql", resolved: true, detail: "" },
          { name: "초안 작성", type: "chat", ref: "vibe/auto", resolved: false, detail: "skill not found" },
        ],
        issues: ["step 1 (초안 작성): skill not found"],
        ok: false,
        note: "dry-run",
      }),
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "주간 보고 자동화 상세 열기" }));
    await user.click(await screen.findByRole("button", { name: "드라이런" }));

    expect(await screen.findByText("해결되지 않은 단계가 있어 게시할 수 없습니다.")).toBeVisible();
    expect(screen.getByText("step 1 (초안 작성): skill not found")).toBeVisible();
  });

  it("publishes a workflow with the operator's note", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /admin/workflows": listHandler,
      "POST /admin/workflows/wf_reporting/publish": () => ({
        workflow_id: "wf_reporting",
        version: 3,
        enabled: true,
        published: true,
      }),
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "주간 보고 자동화 상세 열기" }));
    await user.click(await screen.findByRole("button", { name: "게시" }));
    await user.type(await screen.findByLabelText(/변경 사유/u), "9월 지표 반영");
    await user.click(screen.getByRole("button", { name: "게시" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/workflows/wf_reporting/publish")).toEqual([{ note: "9월 지표 반영" }]);
    });
  });

  it("restores the runs tab from the URL", async () => {
    mockApi({
      "GET /admin/workflows": listHandler,
      "GET /me/workflow-runs": () => ({
        runs: [
          {
            id: "wfrun_1",
            workflow_id: "wf_reporting",
            user_id: "usr_test",
            team: "platform",
            status: "ok",
            steps_total: 2,
            steps_ok: 2,
            latency_ms: 1500,
            cost_krw: 12,
            error_class: "",
            trace_id: "",
            created_at: "2026-09-06T01:00:00Z",
          },
        ],
      }),
    });
    renderPage("/agents/workflows?tab=runs");

    const table = await screen.findByRole("table", { name: "내 워크플로 실행 이력" });
    expect(within(table).getByText("주간 보고 자동화")).toBeVisible();
    expect(within(table).getByText("2/2")).toBeVisible();
  });

  it("opens the receipt for a workflow run", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /admin/workflows": listHandler,
      "GET /me/workflow-runs": () => ({
        runs: [
          {
            id: "wfrun_1",
            workflow_id: "wf_reporting",
            user_id: "usr_test",
            team: "platform",
            status: "ok",
            steps_total: 2,
            steps_ok: 2,
            latency_ms: 1500,
            cost_krw: 12,
            error_class: "",
            trace_id: "",
            created_at: "2026-09-06T01:00:00Z",
          },
        ],
      }),
      "GET /v1/workflow-runs/wfrun_1/receipt": () => ({
        run_id: "wfrun_1",
        kind: "workflow",
        workflow_id: "wf_reporting",
        workflow_name: "주간 보고 자동화",
        status: "ok",
        error_class: "",
        steps_total: 2,
        steps_ok: 2,
        latency_ms: 1500,
        cost_krw: 12,
        created_at: "2026-09-06T01:00:00Z",
        steps: [
          {
            step_index: 0,
            name: "지표 수집",
            type: "text2sql",
            ref: "",
            status: "ok",
            output_chars: 120,
            error_class: "",
          },
          {
            step_index: 1,
            name: "초안 작성",
            type: "chat",
            ref: "vibe/auto",
            status: "ok",
            output_chars: 800,
            error_class: "",
          },
        ],
        note: "워크플로 실행 영수증입니다.",
      }),
    });
    renderPage("/agents/workflows?tab=runs");

    await user.click(await screen.findByRole("button", { name: "실행 wfrun_1 영수증 열기" }));
    const dialog = await screen.findByRole("dialog", { name: "워크플로 실행 영수증" });
    expect(within(dialog).getByText("초안 작성")).toBeVisible();
  });

  it("has no automated accessibility violations", async () => {
    mockApi({ "GET /admin/workflows": listHandler });
    const { container } = renderPage();

    await screen.findByRole("table", { name: "정의된 워크플로 목록" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
