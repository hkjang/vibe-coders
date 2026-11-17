import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedTeamPreflightSummary } from "./RedTeamPreflightSummary";
import { preflightFixture } from "./preflight-fixture";
import { readPreflight } from "./read-preflight";
import { ApiClient, apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("레드팀 사전 점검", () => {
  it("승인 조건과 예산 초과를 함께 표시하고 실행 가능으로 단정하지 않는다", () => {
    render(<RedTeamPreflightSummary preview={preflightFixture} />);
    expect(screen.getByText("승인 조건 충족")).toBeInTheDocument();
    expect(screen.getByText("예산 초과 · 실행 전 조정 필요")).toBeInTheDocument();
    expect(screen.queryByText("실행 가능")).not.toBeInTheDocument();
    expect(screen.getByText(/긴급 중지 상태·키 권한·모델 연결/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "실행" })).not.toBeInTheDocument();
  });
  it("빈 검사와 예산·속도 미설정을 0원 안전 판정과 구분한다", () => {
    render(
      <RedTeamPreflightSummary
        preview={{
          ...preflightFixture,
          targets: 0,
          case_executions: 0,
          limits: { budget_limit_krw: 0, qps_limit: 0, concurrency: 0, timeout_ms: 0 },
        }}
      />,
    );
    expect(screen.getByText(/검사할 대상 또는 적용 가능한 검사가 없습니다/)).toBeInTheDocument();
    expect(screen.getByText("별도 예산 한도 없음")).toBeInTheDocument();
    expect(screen.getByText("비교할 예산 없음")).toBeInTheDocument();
    expect(screen.getByText("별도 속도 한도 없음")).toBeInTheDocument();
  });
  it("실제 클라이언트가 소수 비용·속도와 false 상태를 보존한다", async () => {
    const response = { ...preflightFixture, estimated_cost_krw: 0.2, can_run: false };
    const client = new ApiClient({ fetch: async () => Response.json(response) });
    await expect(client.request(endpoints.domains.redteam.campaigns.dryRun)).resolves.toEqual(response);
  });
  it.each([
    {},
    { ...preflightFixture, targets: undefined },
    { ...preflightFixture, can_run: "false" },
    { ...preflightFixture, approved: null },
    { ...preflightFixture, targets: -1 },
    { ...preflightFixture, case_executions: 0.5 },
    { ...preflightFixture, limits: {} },
    { ...preflightFixture, estimated_cost_krw: "0" },
    { ...preflightFixture, limits: { ...preflightFixture.limits, qps_limit: -1 } },
    { ...preflightFixture, targets: Number.MAX_SAFE_INTEGER + 1 },
  ])("잘못된 응답을 정상·0건으로 바꾸지 않는다 %#", async (response) => {
    const client = new ApiClient({ fetch: async () => Response.json(response) });
    await expect(client.request(endpoints.domains.redteam.campaigns.dryRun)).rejects.toMatchObject({
      kind: "contract",
    });
  });
  it("다른 캠페인의 응답을 거부하고 POST의 인증 재전송을 금지한다", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue(preflightFixture);
    await expect(readPreflight("different-campaign")).rejects.toMatchObject({ kind: "contract" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/admin/redteam/campaigns/different-campaign/dry-run" }),
      { routeId: "security.redteam", retryUnauthorized: false },
    );
  });
});
