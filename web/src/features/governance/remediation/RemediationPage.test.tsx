import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RemediationPage } from "@/features/governance/remediation/RemediationPage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] as string[] }));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

vi.mock("sonner", () => ({ toast: { success: toastSpy.success, error: toastSpy.error } }));

const playbooksResponse = {
  overall_severity: "warning",
  window_hours: 6,
  note: "조치 후보는 dry-run 설명과 예상 영향을 포함합니다.",
  playbooks: [
    {
      situation: "provider_degraded",
      severity: "warning",
      summary: "프로바이더 openai 건강도 52/100 (5xx 8, 429 2, 폴백 15)",
      actions: [
        {
          id: "rem_1",
          type: "provider_disable",
          title: "openai 임시 비활성화",
          description: "건강도가 낮은 프로바이더를 비활성화해 라우팅에서 제외합니다.",
          severity: "warning",
          executable: true,
          reversible: true,
          dry_run: "provider.openai.enabled = false",
          expected_impact: "해당 프로바이더로 향하던 요청이 폴백으로 이동합니다.",
          params: { provider: "openai" },
        },
      ],
    },
    {
      situation: "cost_spike",
      severity: "critical",
      summary: "team platform 비용 급증 (z=5.2)",
      actions: [
        {
          id: "rem_2",
          type: "budget_cap_advisory",
          title: "team 예산 한도 검토",
          description: "비용 급증 대상에 월 예산 한도를 설정하세요.",
          severity: "critical",
          executable: false,
          reversible: true,
          dry_run: "예산 화면에서 team=platform 한도를 조정 (수동)",
          expected_impact: "한도 초과 시 신규 요청이 차단될 수 있습니다.",
          params: { scope: "team", scope_value: "platform" },
          link: "#/billing",
        },
      ],
    },
  ],
};

const dryRunResponse = {
  applied: false,
  dry_run: true,
  action_type: "provider_disable",
  before: { provider: "openai", enabled: true },
  after: { enabled: false },
  rollback: { action_type: "provider_enable", params: { provider: "openai" } },
  note: "dry-run: 변경이 적용되지 않았습니다.",
};

const applyResponse = { ...dryRunResponse, applied: true, dry_run: false, note: "조치가 적용되었습니다." };

function mockAllEndpoints(overrides: Record<string, () => unknown> = {}) {
  return mockApi({
    "GET /admin/remediation/playbooks": () => playbooksResponse,
    "POST /admin/remediation/apply": (options) =>
      (options.body as { dry_run?: boolean }).dry_run ? dryRunResponse : applyResponse,
    ...overrides,
  });
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write"];
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function render(route = "/governance/remediation") {
  return renderScreen(<RemediationPage />, { route, path: "/governance/remediation" });
}

describe("RemediationPage", () => {
  it("상황별 조치 후보와 요약 지표를 표시한다", async () => {
    mockAllEndpoints();
    render();

    expect(await screen.findByRole("heading", { name: "provider_degraded" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "openai 임시 비활성화" })).toBeInTheDocument();
    expect(screen.getByText("provider.openai.enabled = false")).toBeInTheDocument();
    expect(screen.getByText("감지 상황").closest(".stat-card")).toHaveTextContent("2");
    expect(screen.getByText("실행 가능").closest(".stat-card")).toHaveTextContent("1");
  });

  it("조치 후보가 없으면 빈 상태를 안내한다", async () => {
    mockAllEndpoints({
      "GET /admin/remediation/playbooks": () => ({ overall_severity: "info", playbooks: [] }),
    });
    render();

    expect(await screen.findByText("지금 필요한 조치가 없습니다.")).toBeInTheDocument();
  });

  it("조회에 실패하면 요청 ID와 함께 오류를 알린다", async () => {
    mockAllEndpoints({
      "GET /admin/remediation/playbooks": () => {
        throw apiFailure("playbooks failed", 500, "req_playbooks");
      },
    });
    render();

    const notice = (await screen.findByText("자동 조치 후보을(를) 불러오지 못했습니다.")).closest(
      ".inline-notice",
    );
    expect(notice).toHaveTextContent("요청 ID: req_playbooks");
  });

  it("수동 조치는 실행 버튼을 비활성화하고 사유를 표시한다", async () => {
    mockAllEndpoints();
    render();

    const applyButton = await screen.findByRole("button", { name: "team 예산 한도 검토 승인 후 적용" });
    expect(applyButton).toBeDisabled();
    expect(applyButton).toHaveAttribute("title", expect.stringContaining("수동 조치"));
  });

  it("영향 미리보기는 dry_run으로 호출하고 결과를 보여준다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole("button", { name: "openai 임시 비활성화 영향 미리보기" }));

    await waitFor(() =>
      expect(api.bodies("POST /admin/remediation/apply")).toEqual([
        {
          action_type: "provider_disable",
          params: { provider: "openai" },
          reason: "dry-run preview",
          dry_run: true,
        },
      ]),
    );
    expect(await screen.findByText("적용되지 않은 미리보기 결과입니다.")).toBeInTheDocument();
  });

  it("승인 후 적용은 사유를 받아 dry_run 없이 호출한다", async () => {
    const api = mockAllEndpoints();
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole("button", { name: "openai 임시 비활성화 승인 후 적용" }));
    const confirm = await screen.findByRole("button", { name: "적용" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/변경 사유/u), "공급자 장애 대응");
    await user.click(confirm);

    await waitFor(() =>
      expect(api.bodies("POST /admin/remediation/apply")).toEqual([
        {
          action_type: "provider_disable",
          params: { provider: "openai" },
          reason: "공급자 장애 대응",
          dry_run: false,
        },
      ]),
    );
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalled());
  });

  it("URL 쿼리에서 조회 기간을 복원한다", async () => {
    const api = mockAllEndpoints();
    render("/governance/remediation?window=24h");

    await screen.findByRole("heading", { name: "provider_degraded" });
    expect(api.calls.find((call) => call.key === "GET /admin/remediation/playbooks")?.options.query).toEqual({
      window: "24h",
    });
    expect(screen.getByLabelText("자동 조치 조회 기간")).toHaveValue("24h");
  });

  it("접근성 위반이 없다", async () => {
    mockAllEndpoints();
    const { container } = render();

    await screen.findByRole("heading", { name: "provider_degraded" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
