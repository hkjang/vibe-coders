import { createRef } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { renderScreen } from "@/test/render";
import { ProbeCaseDialog } from "./ProbeCaseDialog";
import { probeCaseDefaults, type ProbeCaseFormValues } from "./probe-case-form";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});

function mount(overrides: Partial<ProbeCaseFormValues> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  renderScreen(
    <ProbeCaseDialog
      defaults={{
        ...probeCaseDefaults(""),
        case_key: "public-probe",
        input_template: "공개 검사 입력",
        ...overrides,
      }}
      onOpenChange={vi.fn()}
      onSubmit={onSubmit}
      open
      packs={[]}
      returnFocusRef={createRef<HTMLElement>()}
    />,
  );
  return { onSubmit, user: userEvent.setup() };
}

describe("한글 검사 편집", () => {
  it("한글 선택 항목을 기존 API 식별자로 제출한다", async () => {
    const { user, onSubmit } = mount();
    await user.selectOptions(
      screen.getByLabelText("기대 정책"),
      screen.getByRole("option", { name: "요청 차단" }),
    );
    await user.selectOptions(
      screen.getByLabelText("평가 방식"),
      screen.getByRole("option", { name: "도구 호출 검사" }),
    );
    await user.selectOptions(screen.getByLabelText("심각도"), screen.getByRole("option", { name: "높음" }));
    const group = screen.getByRole("group", { name: "적용 대상 유형" });
    await user.click(within(group).getByRole("checkbox", { name: "모델" }));
    await user.click(within(group).getByRole("checkbox", { name: "MCP 도구" }));
    expect(screen.getByText("선택한 2개 유형에만 적용합니다.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          expected_policy: "block",
          evaluator_type: "tool_call",
          severity: "high",
          target_types: "model,mcp_tool",
        }),
      ),
    );
  });

  it("알려지지 않은 등록값과 사용자 정의 대상은 알려진 유형 선택 후에도 보존한다", async () => {
    const { user, onSubmit } = mount({
      case_id: "public-case",
      expected_policy: "vendor_policy",
      evaluator_type: "vendor_eval",
      severity: "vendor_risk",
      target_types: "vendor_type,model",
    });
    expect(screen.getByLabelText("기대 정책")).toHaveValue("vendor_policy");
    expect(screen.getByRole("option", { name: "등록된 값: vendor_policy" })).toBeInTheDocument();
    expect(screen.getByLabelText("평가 방식")).toHaveValue("vendor_eval");
    expect(screen.getByLabelText("심각도")).toHaveValue("vendor_risk");
    expect(screen.getByText(/기존 사용자 정의 유형을 유지합니다: vendor_type/)).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: "제공자" }));
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          expected_policy: "vendor_policy",
          evaluator_type: "vendor_eval",
          severity: "vendor_risk",
          target_types: "vendor_type,model,provider",
        }),
      ),
    );
  });

  it("마지막 선택을 해제하면 전체 대상 적용을 알리고 빈 기존 계약으로 저장한다", async () => {
    const { user, onSubmit } = mount({ target_types: "model" });
    await user.click(screen.getByRole("checkbox", { name: "모델" }));
    expect(screen.getByText("선택 없음 — 모든 대상 유형에 적용합니다.")).toBeVisible();
    expect((await axe.run(screen.getByRole("dialog"))).violations).toEqual([]);
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ target_types: "" })));
  });
});
