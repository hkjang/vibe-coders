import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PromptLabPage } from "@/features/gateway/prompt-lab/PromptLabPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: { success: toastSpy.success, error: toastSpy.error } }));

const testCaseRun = {
  status: "completed",
  run_id: "mmt_9",
  best_model: "gpt-4.1",
  avg_score: 4.2,
  contract_applied: true,
  contract_pass: 1,
  model_count: 1,
  results: [
    {
      model: "gpt-4.1",
      score: 4.2,
      verdict: "pass",
      contract_pass: true,
      cost_krw: 3.5,
      latency_ms: 900,
      status: "ok",
    },
  ],
  history: [
    {
      id: "ptcr_1",
      run_id: "mmt_9",
      best_model: "gpt-4.1",
      avg_score: 4.2,
      contract_pass: 1,
      model_count: 1,
      avg_cost_krw: 3.5,
      avg_latency_ms: 900,
      created_at: "2026-09-07T00:00:00Z",
    },
  ],
};

const experiments = {
  experiments: [
    {
      id: "pexp_1",
      title: "SQL 생성 품질",
      description: "",
      team: "data",
      owner: "operator@example.com",
      status: "active",
      created_at: "2026-09-01T09:00:00Z",
      updated_at: "2026-09-01T09:00:00Z",
    },
  ],
};

const experimentDetail = {
  experiment: experiments.experiments[0],
  test_cases: [
    {
      id: "ptc_1",
      experiment_id: "pexp_1",
      name: "월별 매출 집계",
      messages_hash: "abc",
      rubric_id: "",
      contract_id: "pctr_1",
      models_json: '["gpt-4.1"]',
      created_by: "operator@example.com",
      created_at: "2026-09-02T09:00:00Z",
      updated_at: "2026-09-02T09:00:00Z",
    },
  ],
};

const contracts = {
  contracts: [
    {
      id: "pctr_1",
      name: "JSON 응답",
      type: "json_schema",
      schema_json: "{}",
      strict: true,
      created_by: "operator@example.com",
      created_at: "2026-09-01T09:00:00Z",
    },
  ],
};

const rubrics = {
  rubrics: [
    {
      id: "prub_1",
      name: "정확성 우선",
      criteria_json: '{"accuracy":0.6}',
      created_by: "operator@example.com",
      created_at: "2026-09-01T09:00:00Z",
    },
  ],
};

function listHandlers() {
  return {
    "GET /admin/prompt-lab/experiments": () => experiments,
    "GET /admin/prompt-lab/contracts": () => contracts,
    "GET /admin/prompt-lab/rubrics": () => rubrics,
  };
}

function renderLab(route = "/prompts/lab") {
  return renderScreen(<PromptLabPage />, { path: "/prompts/lab", route });
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write"];
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});

describe("PromptLabPage", () => {
  it("lists experiments", async () => {
    mockApi(listHandlers());
    renderLab();

    expect(await screen.findByText("SQL 생성 품질")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /실험 만들기/ })).toBeEnabled();
  });

  it("shows an empty state when nothing is registered", async () => {
    mockApi({ ...listHandlers(), "GET /admin/prompt-lab/experiments": () => ({ experiments: [] }) });
    renderLab();

    expect(await screen.findByText("등록된 실험이 없습니다.")).toBeInTheDocument();
  });

  it("shows the request id when the list fails", async () => {
    mockApi({
      ...listHandlers(),
      "GET /admin/prompt-lab/experiments": () =>
        Promise.reject(apiFailure("prompt lab unavailable", 500, "req_lab_1")),
    });
    renderLab();

    expect(await screen.findByText("실험 목록을 불러오지 못했습니다.")).toBeInTheDocument();
  });

  it("disables writes without admin:write", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi(listHandlers());
    renderLab();

    expect(await screen.findByRole("button", { name: /실험 만들기/ })).toBeDisabled();
    expect(screen.getByText(/admin:write 권한이 필요합니다/)).toBeInTheDocument();
  });

  it("creates an experiment and invalidates the list", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...listHandlers(),
      "POST /admin/prompt-lab/experiments": () => ({ id: "pexp_2", title: "요약 품질" }),
    });
    renderLab();

    await screen.findByText("SQL 생성 품질");
    await user.click(screen.getByRole("button", { name: /실험 만들기/ }));
    await user.type(await screen.findByLabelText(/^제목/), "요약 품질");
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/prompt-lab/experiments")[0]).toMatchObject({ title: "요약 품질" });
    });
  });

  it("restores the selected experiment and tab from the URL", async () => {
    mockApi({
      ...listHandlers(),
      "GET /admin/prompt-lab/experiments/pexp_1": () => experimentDetail,
    });
    renderLab("/prompts/lab?exp=pexp_1");

    expect(await screen.findByText("월별 매출 집계")).toBeInTheDocument();
  });

  it("shows the rubric tab from the URL", async () => {
    mockApi(listHandlers());
    renderLab("/prompts/lab?tab=rubrics");

    expect(await screen.findByText("정확성 우선")).toBeInTheDocument();
  });

  it("runs a saved test case after confirming and shows only the scores", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...listHandlers(),
      "GET /admin/prompt-lab/experiments/pexp_1": () => experimentDetail,
      "POST /admin/prompt-lab/test-cases/ptc_1/run": () => testCaseRun,
    });
    renderLab("/prompts/lab?exp=pexp_1");

    await user.click(await screen.findByRole("button", { name: "월별 매출 집계 테스트 케이스 실행" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("비용이 발생합니다");
    await user.click(within(dialog).getByRole("button", { name: "실행" }));

    await waitFor(() => expect(api.bodies("POST /admin/prompt-lab/test-cases/ptc_1/run")).toHaveLength(1));
    expect(api.bodies("POST /admin/prompt-lab/test-cases/ptc_1/run")[0]).toEqual({ save_prompt: false });
    expect(await screen.findByText(/최고 점수 모델 gpt-4.1/)).toBeInTheDocument();
    await waitFor(() =>
      expect(toastSpy.success).toHaveBeenCalledWith("실행을 마쳤습니다. 최고 점수 모델: gpt-4.1"),
    );
  });

  it("archives an experiment through the status patch", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...listHandlers(),
      "PATCH /admin/prompt-lab/experiments/pexp_1": () => ({ status: "archived" }),
    });
    renderLab();

    await user.click(await screen.findByRole("button", { name: "SQL 생성 품질 실험 보관" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "보관" }));

    await waitFor(() =>
      expect(api.bodies("PATCH /admin/prompt-lab/experiments/pexp_1")[0]).toEqual({ status: "archived" }),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("실험을 보관했습니다."));
  });

  it("deletes an experiment after a destructive confirmation", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...listHandlers(),
      "DELETE /admin/prompt-lab/experiments/pexp_1": () => ({ status: "deleted" }),
    });
    renderLab();

    await user.click(await screen.findByRole("button", { name: "SQL 생성 품질 실험 삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "DELETE /admin/prompt-lab/experiments/pexp_1")).toBe(true),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("실험을 삭제했습니다."));
  });

  it("disables the run and archive actions without admin:write", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi({ ...listHandlers(), "GET /admin/prompt-lab/experiments/pexp_1": () => experimentDetail });
    renderLab("/prompts/lab?exp=pexp_1");

    expect(await screen.findByRole("button", { name: "월별 매출 집계 테스트 케이스 실행" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "SQL 생성 품질 실험 보관" })).toBeDisabled();
  });

  it("has no accessibility violations", async () => {
    mockApi(listHandlers());
    const { container } = renderLab();

    await screen.findByText("SQL 생성 품질");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
