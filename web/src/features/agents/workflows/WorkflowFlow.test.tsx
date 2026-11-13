import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { WorkflowFlow } from "./WorkflowFlow";
import type { WorkflowStep } from "@/shared/api/domains/agents.schemas";

const steps: WorkflowStep[] = [
  { name: "입력 확인", type: "condition", note: "공백 입력 확인" },
  {
    name: "초안 작성",
    type: "chat",
    ref: "vibe/auto",
    timeout_ms: 30000,
    max_tokens: 800,
    max_cost_krw: 1.25,
    allowed_tools: ["search"],
    allowed_tables: ["reports"],
  },
  { name: "담당자 확인", type: "approval" },
];
const panel = () => screen.getByRole("tabpanel");

describe("워크플로 정의 흐름", () => {
  it.each([undefined, "", "__proto__", "constructor", "toString"])(
    "등록되지 않은 종류 %s는 안전한 안내로 표시한다",
    (type) => {
      render(<WorkflowFlow steps={[{ name: "예외 단계", type }]} prefixes={[]} />);
      expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(
        "1. 예외 단계 알 수 없는 종류",
      );
      expect(panel()).toHaveTextContent("알 수 없는 종류");
    },
  );

  it("키보드로 저장된 순서를 따라가며 선택한 단계의 등록값을 읽는다", async () => {
    const user = userEvent.setup();
    render(
      <div role="dialog" aria-label="워크플로 상세">
        <WorkflowFlow steps={steps} prefixes={[]} />
      </div>,
    );
    const first = screen.getByRole("tab", { name: "1. 입력 확인 조건" });
    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("tab", { name: "2. 초안 작성 채팅" })).toHaveFocus();
    expect(panel()).toHaveTextContent("vibe/auto");
    expect(panel()).toHaveTextContent("30,000 ms");
    expect(panel()).toHaveTextContent("800 토큰");
    expect(panel()).toHaveTextContent("1.25 원");
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "3. 담당자 확인 승인" })).toHaveFocus();
    expect(panel()).toHaveTextContent("등록 안 함");
    await user.keyboard("{Home}");
    expect(first).toHaveFocus();
    expect(panel()).toHaveTextContent("공백 입력 확인");
    expect(await axe.run(document.body)).toHaveProperty("violations", []);
  });

  it("긴 정의는 25단계씩 표시하고 마지막·첫 페이지에서 초점을 유지한다", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 60 }, (_, index) => ({ name: `업무 ${index + 1}`, type: "transform" }));
    render(<WorkflowFlow steps={many} prefixes={[]} />);
    expect(screen.getAllByRole("tab")).toHaveLength(25);
    const next = screen.getByRole("button", { name: "다음 25단계" });
    const previous = screen.getByRole("button", { name: "이전 25단계" });
    await user.click(next);
    expect(panel()).toHaveAccessibleName("26. 업무 26 변환");
    await user.click(next);
    expect(screen.getAllByRole("tab")).toHaveLength(10);
    expect(previous).toHaveFocus();
    expect(next).toBeDisabled();
    expect(panel()).toHaveAccessibleName("51. 업무 51 변환");
    await user.click(previous);
    await user.click(previous);
    expect(next).toHaveFocus();
    expect(previous).toBeDisabled();
    expect(panel()).toHaveAccessibleName("1. 업무 1 변환");
  });

  it("새 정의에서는 이전 선택을 폐기하고 표시 보호 기준 변경을 반영한다", async () => {
    const user = userEvent.setup();
    const secret = "corp_" + "a".repeat(40);
    const current: WorkflowStep[] = [
      { name: "후속 업무", type: "unknown", ref: secret, note: "<script>public</script>", max_tokens: -1 },
    ];
    const { rerender } = render(<WorkflowFlow steps={steps} prefixes={[]} />);
    await user.click(screen.getByRole("tab", { name: "3. 담당자 확인 승인" }));
    rerender(<WorkflowFlow steps={current} prefixes={["corp_"]} />);
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("1. 후속 업무 알 수 없는 종류");
    expect(panel()).toHaveTextContent("민감정보가 포함될 수 있어 표시하지 않습니다.");
    expect(panel()).toHaveTextContent("값 확인 필요");
    expect(panel()).not.toHaveTextContent(secret);
    expect(document.querySelector("script")).toBeNull();
    expect(panel()).toHaveTextContent("<script>public</script>");
  });

  it("허용 자원의 긴 목록은 요청한 만큼만 펼치고 원본을 바꾸지 않는다", async () => {
    const user = userEvent.setup();
    const values = Array.from({ length: 52 }, (_, index) => `public-${index}`);
    const source: WorkflowStep[] = [{ name: "도구 확인", type: "mcp_tool", allowed_tools: values }];
    const before = structuredClone(source);
    render(<WorkflowFlow steps={source} prefixes={[]} />);
    await user.click(screen.getByText("허용 도구 (52개)"));
    expect(within(panel()).getAllByRole("listitem")).toHaveLength(25);
    await user.click(screen.getByRole("button", { name: "25개 더 보기" }));
    expect(within(panel()).getAllByRole("listitem")).toHaveLength(50);
    await user.click(screen.getByRole("button", { name: "25개 더 보기" }));
    expect(within(panel()).getAllByRole("listitem")).toHaveLength(52);
    expect(screen.queryByRole("button", { name: "25개 더 보기" })).not.toBeInTheDocument();
    expect(screen.getByText("허용 도구 (52개)")).toHaveFocus();
    expect(source).toEqual(before);
  });
});
