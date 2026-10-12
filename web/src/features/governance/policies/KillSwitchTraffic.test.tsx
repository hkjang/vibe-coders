import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { killSwitchSchema } from "@/shared/api/domains/governance";
import { KillSwitchTraffic } from "./KillSwitchTraffic";

const traffic = {
  scope: "responding_process" as const,
  instance_ref: "process_0123456789abcdef",
  observed_at: "2026-10-12T02:00:00Z",
  proxy_inflight: 0,
};

describe("긴급 정지 트래픽 관측", () => {
  it("이전 서버의 관측값 부재를 0건으로 만들지 않는다", () => {
    const state = killSwitchSchema.parse({ disabled: false });
    render(<KillSwitchTraffic traffic={state.traffic} stale={false} />);
    expect(screen.getByText("요청 수 관측값이 없습니다.")).toBeVisible();
    expect(screen.queryByText("0건")).not.toBeInTheDocument();
  });
  it("실제 0을 보존하고 서버 범위와 관측 시각을 명시한다", () => {
    render(<KillSwitchTraffic traffic={traffic} stale={false} />);
    expect(screen.getByText("0건")).toBeVisible();
    expect(screen.getByText(traffic.instance_ref)).toBeVisible();
    expect(screen.getByTitle(traffic.observed_at)).toHaveAttribute("dateTime", traffic.observed_at);
    expect(screen.getByText(/전체 서버 합계가 아니며/u)).toBeVisible();
  });
  it("재조회 중이거나 실패하면 이전 수치임을 표시한다", () => {
    render(<KillSwitchTraffic traffic={{ ...traffic, proxy_inflight: 3 }} stale />);
    expect(screen.getByRole("status")).toHaveTextContent("이전 관측값");
    expect(screen.getByText("3건")).toBeVisible();
  });
  it.each([-1, 0.5, "0", null, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "잘못된 요청 수 %s를 거부한다",
    (value) => {
      expect(
        killSwitchSchema.safeParse({ disabled: false, traffic: { ...traffic, proxy_inflight: value } })
          .success,
      ).toBe(false);
    },
  );
  it.each([
    { scope: "cluster" },
    { instance_ref: "raw-host.example" },
    { observed_at: "unknown" },
    { proxy_inflight: undefined },
  ])("불완전하거나 다른 범위인 관측값을 거부한다: %j", (overrides) => {
    expect(
      killSwitchSchema.safeParse({ disabled: false, traffic: { ...traffic, ...overrides } }).success,
    ).toBe(false);
  });
});
