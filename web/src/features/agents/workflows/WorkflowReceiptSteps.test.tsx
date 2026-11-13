import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { WorkflowReceiptSteps } from "./WorkflowReceiptSteps";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});

it("긴 영수증은 25단계씩 렌더링하고 페이지를 이동한다", async () => {
  const user = userEvent.setup();
  renderScreen(
    <WorkflowReceiptSteps
      steps={Array.from({ length: 68 }, (_, i) => ({
        step_index: i,
        name: `단계 ${i + 1}`,
        type: "condition",
        status: "passed",
        output_chars: 0,
      }))}
    />,
  );
  const table = await screen.findByRole("table", { name: "워크플로 실행 단계별 결과" });
  expect(within(table).getAllByRole("row")).toHaveLength(26);
  expect(within(table).getByText("단계 25")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "다음" }));
  expect(within(table).getByText("단계 26")).toBeVisible();
  expect(within(table).queryByText("단계 25")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "다음" }));
  expect(within(table).getAllByRole("row")).toHaveLength(19);
  expect(within(table).getByText("단계 68")).toBeVisible();
});

it("누락된 수치와 알 수 없는 종류·상태를 정상으로 표시하지 않는다", async () => {
  renderScreen(
    <WorkflowReceiptSteps steps={[{ name: "미확인 단계", type: "__proto__", status: "unknown" }]} />,
  );
  const table = await screen.findByRole("table", { name: "워크플로 실행 단계별 결과" });
  expect(within(table).getByText("알 수 없는 종류")).toBeVisible();
  expect(within(table).getByText("상태 확인 필요")).toBeVisible();
  expect(within(table).getAllByText("—")).toHaveLength(2);
});
