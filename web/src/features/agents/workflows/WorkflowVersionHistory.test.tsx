import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { expect, it, vi } from "vitest";
import { renderScreen } from "@/test/render";
import { WorkflowVersionHistory } from "./WorkflowVersionHistory";
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});
it("게시한 분기 연결을 지연 표시하고 닫을 때 원래 버전 버튼으로 돌아온다", async () => {
  const user = userEvent.setup();
  renderScreen(
    <WorkflowVersionHistory
      prefixes={[]}
      versions={[
        {
          id: "version1",
          workflow_id: "wf",
          version: 1,
          name: "검토 정의",
          steps: [{ id: "one", name: "입력 전달", type: "transform" }],
          flow: { version: 1, entry: "one", edges: [{ from: "one", to: "$end", when: "next" }] },
        },
      ]}
    />,
  );
  expect(screen.queryByRole("region", { name: "워크플로 분기 연결 그림" })).not.toBeInTheDocument();
  const button = screen.getByRole("button", { name: "버전 1 정의 보기" });
  await user.click(button);
  expect(screen.getByRole("heading", { name: "버전 1 정의" })).toHaveFocus();
  const region = screen.getByRole("region", { name: "선택한 게시 정의" });
  expect(within(region).getByRole("table", { name: "단계 연결" })).toBeVisible();
  expect((await axe.run(region)).violations).toEqual([]);
  await user.click(within(region).getByRole("button", { name: "정의 닫기" }));
  expect(button).toHaveFocus();
});
