import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PromptLabPage } from "@/features/gateway/prompt-lab/PromptLabPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

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

  it("has no accessibility violations", async () => {
    mockApi(listHandlers());
    const { container } = renderLab();

    await screen.findByText("SQL 생성 품질");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
