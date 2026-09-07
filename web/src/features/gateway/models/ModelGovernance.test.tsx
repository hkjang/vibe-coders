import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModelPage } from "@/features/gateway/models/ModelPage";
import { usePreferences } from "@/shared/stores/preferences";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

const catalogue = {
  generated_at: "2026-09-02T00:00:00Z",
  models: [],
  partial_failures: [],
  providers: [],
  request_id: "req_models",
};

const contracts = {
  contracts: [
    {
      id: "mcon_1",
      name: "코드 리뷰 최소 품질",
      task_type: "code_review",
      min_quality_score: 70,
      min_golden_pass_rate: 0.8,
      min_success_rate: 0.95,
      max_latency_ms: 4000,
      max_avg_cost_krw: 12,
      enabled: true,
      created_by: "operator@example.com",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    },
  ],
};

const deprecations = {
  deprecations: [
    {
      id: "moddep_1",
      model_glob: "gpt-3.5*",
      replacement: "gpt-4.1-mini",
      sunset_date: "2026-12-31",
      message: "상위 모델로 이전하세요.",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    },
  ],
};

function catalogueHandlers() {
  return {
    "GET /admin/models": () => catalogue,
    "GET /admin/models/quality": () => ({ categories: [], models: [], since: "2026-09-01T00:00:00Z" }),
    "GET /admin/pricing": () => ({ effective: {}, versions: [] }),
    "GET /admin/model-tags": () => ({ tags: [] }),
  };
}

function renderModels() {
  return renderScreen(<ModelPage />, { path: "/gateway/models", route: "/gateway/models" });
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write"];
  usePreferences.setState({ refreshInterval: 0 });
});

describe("ModelPage governance", () => {
  it("shows the model contracts tab", async () => {
    const user = userEvent.setup();
    mockApi({ ...catalogueHandlers(), "GET /admin/models/contracts": () => contracts });
    renderModels();

    await user.click(await screen.findByRole("tab", { name: "모델 계약" }));
    expect(await screen.findByText("코드 리뷰 최소 품질")).toBeInTheDocument();
  });

  it("creates a contract and invalidates the list", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...catalogueHandlers(),
      "GET /admin/models/contracts": () => contracts,
      "POST /admin/models/contracts": () => ({ id: "mcon_2", ok: true }),
    });
    renderModels();

    await user.click(await screen.findByRole("tab", { name: "모델 계약" }));
    await user.click(await screen.findByRole("button", { name: /계약 추가/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^이름/), "SQL 최소 품질");
    await user.type(within(dialog).getByLabelText("작업 유형"), "sql");
    await user.type(within(dialog).getByLabelText(/최소 품질 점수/), "80");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/models/contracts")[0]).toMatchObject({
        name: "SQL 최소 품질",
        task_type: "sql",
        min_quality_score: 80,
        enabled: true,
      });
    });
  });

  it("deletes a contract after confirmation", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...catalogueHandlers(),
      "GET /admin/models/contracts": () => contracts,
      "DELETE /admin/models/contracts": () => ({ ok: true }),
    });
    renderModels();

    await user.click(await screen.findByRole("tab", { name: "모델 계약" }));
    const row = (await screen.findByText("코드 리뷰 최소 품질")).closest("tr");
    await user.click(within(row as HTMLElement).getByRole("button", { name: /삭제/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      const call = api.calls.find((entry) => entry.key === "DELETE /admin/models/contracts");
      expect(call?.options.query).toEqual({ id: "mcon_1" });
    });
  });

  it("creates a deprecation policy", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...catalogueHandlers(),
      "GET /admin/model-deprecations": () => deprecations,
      "POST /admin/model-deprecations": () => ({ deprecation: { id: "moddep_2", model_glob: "old-*" } }),
    });
    renderModels();

    await user.click(await screen.findByRole("tab", { name: "지원 종료" }));
    expect(await screen.findByText("gpt-3.5*")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /정책 추가/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^모델 패턴/), "old-*");
    await user.type(within(dialog).getByLabelText("대체 모델"), "new-model");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/model-deprecations")[0]).toMatchObject({
        model_glob: "old-*",
        replacement: "new-model",
      });
    });
  });

  it("shows an empty state and disables writes without admin:write", async () => {
    authRuntime.scopes = ["admin:read"];
    const user = userEvent.setup();
    mockApi({ ...catalogueHandlers(), "GET /admin/models/contracts": () => ({ contracts: [] }) });
    renderModels();

    await user.click(await screen.findByRole("tab", { name: "모델 계약" }));
    expect(await screen.findByText("등록된 모델 계약이 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /계약 추가/ })).toBeDisabled();
  });

  it("surfaces a contract list failure", async () => {
    const user = userEvent.setup();
    mockApi({
      ...catalogueHandlers(),
      "GET /admin/models/contracts": () => Promise.reject(apiFailure("db down", 500, "req_contract")),
    });
    renderModels();

    await user.click(await screen.findByRole("tab", { name: "모델 계약" }));
    expect(await screen.findByText("모델 계약을 불러오지 못했습니다.")).toBeInTheDocument();
  });

  it("has no accessibility violations on the governance tab", async () => {
    const user = userEvent.setup();
    mockApi({ ...catalogueHandlers(), "GET /admin/models/contracts": () => contracts });
    const { container } = renderModels();

    await user.click(await screen.findByRole("tab", { name: "모델 계약" }));
    await screen.findByText("코드 리뷰 최소 품질");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
