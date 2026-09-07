import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SkillPage } from "@/features/agents/skills/SkillPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

const skill = {
  name: "code-review",
  description: "코드 리뷰를 표준화합니다.",
  version: "1.2.0",
  owner: "platform",
  status: "staging",
  risk_level: "medium",
  allowed_models: "gpt-4o",
  allowed_tools: "sql-runner",
  allowed_teams: "platform",
  daily_limit: 100,
  instructions: "PR 디프를 표준 기준으로 검토합니다.",
  metadata: "{}",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-09-05T00:00:00Z",
  updated_by: "operator@example.com",
};

const statsResponse = {
  window_since: "2026-08-08T00:00:00Z",
  stats: [
    {
      skill_name: "code-review",
      runs: 40,
      ok: 36,
      errors: 2,
      blocked: 2,
      block_rate: 0.05,
      total_cost_krw: 1234,
      avg_latency_ms: 820,
      actors: 6,
      last_run_at: "2026-09-06T00:00:00Z",
    },
  ],
};

const baseHandlers = {
  "GET /admin/skills": () => ({ skills: [skill] }),
  "GET /admin/skills/stats": () => statsResponse,
};

function renderPage(route = "/agents/skills"): ReturnType<typeof renderScreen> {
  return renderScreen(<SkillPage />, { path: "/agents/skills", route });
}

describe("SkillPage", () => {
  beforeEach(() => {
    authRuntime.scopes = ["admin:read", "admin:write"];
  });

  it("shows the skill catalog with its key values", async () => {
    mockApi(baseHandlers);
    renderPage();

    const table = await screen.findByRole("table", { name: "Skill 카탈로그" });
    expect(within(table).getByText("code-review")).toBeVisible();
    expect(within(table).getByText("스테이징")).toBeVisible();
    expect(within(table).getByText("gpt-4o")).toBeVisible();
  });

  it("shows an empty state when no skill exists", async () => {
    mockApi({ ...baseHandlers, "GET /admin/skills": () => ({ skills: [] }) });
    renderPage();

    expect(await screen.findByText("등록된 Skill이 없습니다.")).toBeVisible();
  });

  it("shows the request id when the catalog fails", async () => {
    mockApi({
      ...baseHandlers,
      "GET /admin/skills": () => {
        throw apiFailure("skill store unavailable", 500, "req_skill_1");
      },
    });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("요청 ID: req_skill_1");
  });

  it("disables write actions without admin:write", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi(baseHandlers);
    renderPage();

    await screen.findByRole("table", { name: "Skill 카탈로그" });
    expect(screen.getByRole("button", { name: /새 Skill/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "추천 Skill 시드" })).toBeDisabled();
  });

  it("runs the security scan only when the operator asks for it", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/skills/scan": () => ({
        scans: [
          {
            name: "code-review",
            status: "staging",
            risk_level: "medium",
            max_severity: "medium",
            high_count: 0,
            medium_count: 1,
            low_count: 0,
            clean: false,
            findings: [{ severity: "medium", category: "policy_hygiene", detail: "허용 도구가 넓습니다" }],
          },
        ],
      }),
    });
    renderPage();

    await screen.findByRole("table", { name: "Skill 카탈로그" });
    expect(api.calls.some((call) => call.key === "GET /admin/skills/scan")).toBe(false);

    await user.click(screen.getByRole("button", { name: "보안 스캔" }));
    const table = await screen.findByRole("table", { name: "Skill 보안 스캔 결과" });
    expect(within(table).getByText("policy_hygiene: 허용 도구가 넓습니다")).toBeVisible();
  });

  it("promotes a skill with the operator's note", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/skills/promote": () => ({ skill }),
      "POST /admin/skills/promote": () => ({ skill: { ...skill, status: "production" } }),
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "code-review 상세 열기" }));
    await user.click(await screen.findByRole("button", { name: "승격" }));
    await user.type(await screen.findByLabelText(/변경 사유/u), "스테이징 검증 완료");
    await user.click(screen.getByRole("button", { name: "승격" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/skills/promote")).toEqual([
        { name: "code-review", to_status: "production", note: "스테이징 검증 완료" },
      ]);
    });
  });

  it("records fitness evidence from the detail sheet", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/skills/fitness": () => ({
        skill: "code-review",
        evidence: [],
        passing_count: 0,
        required: 2,
      }),
      "POST /admin/skills/fitness": () => ({
        id: "skfit_1",
        skill_name: "code-review",
        kind: "multimodel",
        ref_id: "cmp-42",
        passed: true,
        score: 0.9,
        note: "",
        created_by: "operator@example.com",
        created_at: "2026-09-07T00:00:00Z",
      }),
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "code-review 상세 열기" }));
    await user.click(await screen.findByRole("button", { name: "적합성 근거" }));

    await user.type(await screen.findByLabelText(/참조 ID/u), "cmp-42");
    await user.type(screen.getByLabelText(/^점수/u), "0.9");
    await user.click(screen.getByRole("button", { name: "근거 기록" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/skills/fitness")).toEqual([
        { skill: "code-review", kind: "multimodel", ref_id: "cmp-42", passed: true, score: 0.9, note: "" },
      ]);
    });
  });

  it("disables fitness recording without write scope", async () => {
    authRuntime.scopes = ["admin:read"];
    const user = userEvent.setup();
    mockApi({
      ...baseHandlers,
      "GET /admin/skills/fitness": () => ({
        skill: "code-review",
        evidence: [],
        passing_count: 0,
        required: 2,
      }),
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "code-review 상세 열기" }));
    await user.click(await screen.findByRole("button", { name: "적합성 근거" }));

    expect(await screen.findByRole("button", { name: "근거 기록" })).toBeDisabled();
  });

  it("renders the dependency graph tab from the URL", async () => {
    mockApi({
      ...baseHandlers,
      "GET /admin/skills/dependency-graph": () => ({
        nodes: [
          { id: "skill:code-review", type: "skill", label: "code-review", risk: "medium" },
          { id: "model:gpt-4o", type: "model", label: "gpt-4o" },
          { id: "team:platform", type: "team", label: "platform" },
        ],
        edges: [
          { from: "skill:code-review", to: "model:gpt-4o", kind: "uses_model" },
          { from: "skill:code-review", to: "team:platform", kind: "allowed_team" },
        ],
        skills: [
          {
            name: "code-review",
            risk_level: "medium",
            models: ["gpt-4o"],
            tools: [],
            teams: ["platform"],
            governing_policies: [{ id: "pol_1", name: "모델 제한", via: "model:gpt-4o" }],
          },
        ],
        note: "production Skill의 의존성",
      }),
    });
    renderPage("/agents/skills?tab=graph");

    expect(await screen.findByRole("img", { name: /Skill 의존성 그래프/u })).toBeVisible();
    const detail = await screen.findByRole("list", { name: "Skill 의존성 상세" });
    expect(within(detail).getByText("모델 제한 (model:gpt-4o)")).toBeVisible();
  });

  it("shows the studio readiness checklist for the selected skill", async () => {
    mockApi({
      ...baseHandlers,
      "GET /admin/skill-studio/candidates": () => ({
        candidates: [
          {
            id: "skill-report",
            source: "fingerprint",
            suggested_name: "skill-report",
            title: "보고서 작성 표준화 (12회 반복)",
            description: "프롬프트 클러스터",
            sample: "",
            rationale: "12회 반복",
            signal: { requests: 12 },
            suggested: {
              risk_level: "low",
              allowed_models: "",
              allowed_tools: "",
              instructions: "표준 절차",
            },
            already_skill: false,
            score: 18,
          },
        ],
        count: 1,
        by_source: { fingerprint: 1 },
        window_since: "2026-08-08T00:00:00Z",
      }),
      "GET /admin/skill-studio/readiness": () => ({
        name: "code-review",
        status: "staging",
        next_status: "production",
        checks: [
          { key: "instructions", label: "지침(instructions)", ok: true, required: true, detail: "" },
          {
            key: "allowed_teams",
            label: "허용 팀(allowed_teams)",
            ok: false,
            required: true,
            detail: "필요",
          },
        ],
        production_ready: false,
        scan: { findings: [], max_severity: "", high_count: 0, medium_count: 0, low_count: 0, clean: true },
        fitness_required: false,
        fitness_passing: 0,
        fitness_threshold: 2,
      }),
    });
    renderPage("/agents/skills?tab=studio&skill=code-review");

    const checklist = await screen.findByRole("list", { name: "승격 게이트 점검 결과" });
    expect(within(checklist).getByText(/허용 팀\(allowed_teams\) \(필수\)/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "프로덕션으로 승격" })).toBeEnabled();
  });

  it("has no automated accessibility violations", async () => {
    mockApi(baseHandlers);
    const { container } = renderPage();

    await screen.findByRole("table", { name: "Skill 카탈로그" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
