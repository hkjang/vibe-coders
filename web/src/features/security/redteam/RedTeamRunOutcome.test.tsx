import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { redTeamRunOutcomeSchema } from "@/shared/api/domains/redteam";
import { RedTeamRunOutcomeSheet } from "./RedTeamRunOutcomeSheet";

describe("레드팀 중단 결과", () => {
  it.each([
    ["budget_exceeded", "비용 중단 기준에 도달했습니다"],
    ["kill_switch", "긴급 중지가 적용되었습니다"],
    ["call_limit", "실제 호출 횟수 한도에 도달했습니다"],
    ["context_cancelled", "요청 연결 또는 실행 대기가 취소되었습니다"],
    ["cost_unavailable", "호출 비용을 확인할 수 없습니다"],
    ["new-server-code", "서버가 실행 중단을 보고했습니다"],
  ])("%s를 한글로 안내하고 저장된 결과만 연다", async (stopped, label) => {
    const onOpenRun = vi.fn(),
      onClose = vi.fn();
    const outcome = redTeamRunOutcomeSchema.parse({
      campaign_id: "synthetic-campaign",
      status: "stopped",
      stopped,
      summary: { runs: 1, results: 1, live_calls: 1, live_cost_krw: 20 },
      runs: [{ id: "synthetic-run", target_id: "공개 모델", status: "stopped", total_cases: 1 }],
    });
    render(
      <RedTeamRunOutcomeSheet
        outcome={outcome}
        onClose={onClose}
        onOpenRun={onOpenRun}
        returnFocusRef={createRef<HTMLElement>()}
      />,
    );
    const panel = screen.getByRole("dialog", { name: "캠페인 실행 결과" });
    expect(within(panel).getByText("실행이 중단되었습니다.")).toBeVisible();
    expect(within(panel).getByText(new RegExp(label))).toBeVisible();
    expect(within(panel).queryByRole("button", { name: /재실행|재개/ })).toBeNull();
    expect(within(panel).queryByText("시뮬레이션", { exact: true })).toBeNull();
    await userEvent
      .setup()
      .click(within(panel).getByRole("button", { name: "공개 모델 · 중단 · 결과 1건 보기" }));
    expect(onOpenRun).toHaveBeenCalledExactlyOnceWith("synthetic-run");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("호출 전 중단을 시뮬레이션 성공으로 표시하지 않으며 접근성을 유지한다", async () => {
    const outcome = redTeamRunOutcomeSchema.parse({ status: "stopped", stopped: "kill_switch" });
    render(
      <RedTeamRunOutcomeSheet
        outcome={outcome}
        onClose={vi.fn()}
        onOpenRun={vi.fn()}
        returnFocusRef={createRef<HTMLElement>()}
      />,
    );
    const panel = screen.getByRole("dialog", { name: "캠페인 실행 결과" });
    expect(within(panel).getByText("0건", { exact: true })).toBeVisible();
    expect(within(panel).queryByText(/시뮬레이션/)).toBeNull();
    expect(within(panel).getByText(/저장된 대상별 실행이 없습니다/)).toBeVisible();
    expect((await axe.run(panel)).violations).toEqual([]);
  });

  it("완료한 실행에는 중단 경고를 붙이지 않는다", () => {
    render(
      <RedTeamRunOutcomeSheet
        outcome={redTeamRunOutcomeSchema.parse({ status: "completed" })}
        onClose={vi.fn()}
        onOpenRun={vi.fn()}
        returnFocusRef={createRef<HTMLElement>()}
      />,
    );
    expect(screen.getByText("완료", { exact: true })).toBeVisible();
    expect(screen.queryByText("실행이 중단되었습니다.")).toBeNull();
  });
});
