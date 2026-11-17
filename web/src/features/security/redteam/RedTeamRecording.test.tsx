import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { redTeamRecordingSchema } from "@/shared/api/domains/redteam-recording";
import { reviewedOutcomeSchema } from "@/shared/api/domains/redteam-reviewed";
import { redTeamRunOutcomeSchema } from "@/shared/api/domains/redteam";
import { executionOutcomeFixture } from "./reviewed-execution-fixture";
import { RedTeamRunOutcomeSheet } from "./RedTeamRunOutcomeSheet";

describe("레드팀 결과 저장 확인", () => {
  it.each([
    { confirmed: true, stage: "finalize", results: 1 },
    { confirmed: false, stage: "", results: 1 },
    { confirmed: true, stage: "", results: -1 },
    { confirmed: true, stage: "", results: 1001 },
  ])("잘못된 저장 확인 계약을 거부한다: %j", (value) => {
    expect(redTeamRecordingSchema.safeParse(value).success).toBe(false);
  });

  it("검토 실행에 저장 확인 정보가 없거나 집계가 다르면 성공으로 받아들이지 않는다", () => {
    const outcome = executionOutcomeFixture();
    expect(reviewedOutcomeSchema.safeParse({ ...outcome, recording: undefined }).success).toBe(false);
    expect(
      reviewedOutcomeSchema.safeParse({ ...outcome, recording: { confirmed: true, stage: "", results: 0 } })
        .success,
    ).toBe(false);
    expect(
      reviewedOutcomeSchema.safeParse({
        ...outcome,
        recording: { confirmed: false, stage: "finalize", results: 1 },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["run_start", "대상별 실행 기록 생성"],
    ["case_result", "검사 결과·증적·조치 저장"],
    ["finalize", "실행·캠페인 상태와 기준선 갱신"],
  ] as const)("%s 실패를 완료와 구분하고 자동 재실행을 제공하지 않는다", async (stage, label) => {
    const outcome = reviewedOutcomeSchema.parse({
      ...executionOutcomeFixture(),
      complete: false,
      status: "stopped",
      stopped: "recording_failed",
      recording: { confirmed: false, stage, results: 1 },
    });
    render(
      <RedTeamRunOutcomeSheet
        outcome={outcome}
        onClose={vi.fn()}
        onOpenRun={vi.fn()}
        returnFocusRef={createRef<HTMLElement>()}
      />,
    );
    expect(screen.getByText("결과 저장을 확인하지 못했습니다.")).toBeVisible();
    expect(screen.getByText("저장 확인 필요")).toBeVisible();
    expect(screen.getByText(new RegExp(label))).toBeVisible();
    expect(screen.queryByText("완료", { exact: true })).toBeNull();
    expect(screen.queryByText("확인됨", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: /재실행|재개/ })).toBeNull();
    expect((await axe.run(screen.getByRole("dialog"))).violations).toEqual([]);
  });

  it("이전 서버 응답의 저장 상태를 임의로 확인됨으로 표시하지 않는다", () => {
    render(
      <RedTeamRunOutcomeSheet
        outcome={redTeamRunOutcomeSchema.parse({ status: "completed" })}
        onClose={vi.fn()}
        onOpenRun={vi.fn()}
        returnFocusRef={createRef<HTMLElement>()}
      />,
    );
    expect(screen.getAllByText("확인 정보 없음")).toHaveLength(2);
    expect(screen.queryByText("확인됨", { exact: true })).toBeNull();
  });

  it("저장이 확인된 실행을 명확히 표시한다", () => {
    render(
      <RedTeamRunOutcomeSheet
        outcome={executionOutcomeFixture()}
        onClose={vi.fn()}
        onOpenRun={vi.fn()}
        returnFocusRef={createRef<HTMLElement>()}
      />,
    );
    expect(screen.getByText("확인됨", { exact: true })).toBeVisible();
    expect(screen.getByText("완료", { exact: true })).toBeVisible();
    expect(screen.queryByText("결과 저장을 확인하지 못했습니다.")).toBeNull();
  });
});
