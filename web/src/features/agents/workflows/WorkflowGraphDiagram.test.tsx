import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphInput } from "@/shared/api/domains/workflow-graph.schemas";
import { WorkflowGraphDiagram } from "./WorkflowGraphDiagram";
import { fitGraphScale, nextGraphScale } from "./use-workflow-graph-view";

const draft: GraphInput = {
  id: "graph",
  name: "단계 탐색",
  description: "",
  allowed_teams: "",
  enabled: false,
  steps: [
    { id: "start", name: "처음 단계", type: "transform" },
    { id: "last", name: "마지막 단계", type: "transform" },
  ],
  flow: {
    version: 1,
    entry: "start",
    edges: [
      { from: "start", to: "last", when: "next" },
      { from: "last", to: "$end", when: "next" },
    ],
  },
};

describe("분기 그림 탐색", () => {
  it("조회 그림에서 키보드로 단계를 이동하고 정의는 바꾸지 않는다", async () => {
    const original = structuredClone(draft);
    const user = userEvent.setup();
    render(<WorkflowGraphDiagram draft={draft} />);
    const first = screen.getByRole("button", { name: /^처음 단계,/u });
    const last = screen.getByRole("button", { name: /^마지막 단계,/u });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(last).toHaveAttribute("tabindex", "-1");
    first.focus();
    await user.keyboard("{End}");
    expect(last).toHaveFocus();
    expect(last).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("그림에서 찾을 단계")).toHaveValue("last");
    await user.keyboard("{ArrowUp}");
    expect(first).toHaveFocus();
    expect(draft).toEqual(original);
  });

  it("편집 선택과 탐색 상자를 연결하며 화면 배율은 정의 변경을 요청하지 않는다", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<WorkflowGraphDiagram draft={draft} selected="start" onSelect={onSelect} />);
    await user.selectOptions(screen.getByLabelText("그림에서 찾을 단계"), "last");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("last");
    rerender(<WorkflowGraphDiagram draft={draft} selected="last" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: /^마지막 단계,/u })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "확대" }));
    await user.click(screen.getByRole("button", { name: "전체 보기" }));
    await user.click(screen.getByRole("button", { name: "선택 단계 보기" }));
    expect(screen.getByLabelText("그림 배율")).toHaveTextContent("100%");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("단계 삭제 후 남아 있는 단계로 초점을 진입할 수 있고 빈 정의에서도 실패하지 않는다", () => {
    const { rerender } = render(<WorkflowGraphDiagram draft={draft} />);
    fireEvent.change(screen.getByLabelText("그림에서 찾을 단계"), { target: { value: "last" } });
    rerender(<WorkflowGraphDiagram draft={{ ...draft, steps: draft.steps.slice(0, 1) }} />);
    expect(screen.getByRole("button", { name: /^처음 단계,/u })).toHaveAttribute("tabindex", "0");
    rerender(<WorkflowGraphDiagram draft={{ ...draft, steps: [] }} />);
    expect(screen.getByLabelText("그림에서 찾을 단계")).toBeDisabled();
    expect(screen.getByRole("button", { name: "선택 단계 보기" })).toBeDisabled();
  });

  it("그림만 확대·축소하고 명시된 배율 한도와 복귀를 제공한다", () => {
    render(<WorkflowGraphDiagram draft={draft} />);
    const zoomIn = screen.getByRole("button", { name: "확대" });
    const zoomOut = screen.getByRole("button", { name: "축소" });
    for (let i = 0; i < 10; i++) fireEvent.click(zoomIn);
    expect(zoomIn).toBeDisabled();
    expect(screen.getByLabelText("그림 배율")).toHaveTextContent("200%");
    for (let i = 0; i < 10; i++) fireEvent.click(zoomOut);
    expect(zoomOut).toBeDisabled();
    expect(screen.getByLabelText("그림 배율")).toHaveTextContent("25%");
    fireEvent.click(screen.getByRole("button", { name: "선택 단계 보기" }));
    expect(screen.getByLabelText("그림 배율")).toHaveTextContent("100%");
  });

  it("최대 길이의 그림도 전체 영역에 맞추고 다시 읽을 수 있는 배율로 확대한다", () => {
    const scale = fitGraphScale(33800, 150, 260, 150);
    expect(33800 * scale).toBeLessThanOrEqual(244);
    expect(150 * scale).toBeLessThanOrEqual(134);
    expect(nextGraphScale(scale, "in")).toBe(0.25);
    expect(fitGraphScale(260, 150, 1000, 400)).toBe(1);
    expect(fitGraphScale(260, 150, 0, 0)).toBe(1);
  });
});
