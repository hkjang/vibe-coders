import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { WorkflowPage } from "./WorkflowPage";
import { FeatureAccessHarness } from "@/test/feature-access";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { workflowReadFixture } from "@/test/workflow-fixtures";

const runtime = vi.hoisted(() => ({ id: "first", team: "first-team" }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ user: { id: runtime.id, team_id: runtime.team } }) };
});
const workflow = { id: "wf_one", name: "검토할 업무", steps: [] };
const base = {
  "GET /admin/workflows": ({ query }: { query?: object }) => workflowReadFixture([workflow], query),
  "GET /me/workflow-runs": () => ({ runs: [{ id: "run_one", workflow_id: workflow.id }] }),
};
function Host() {
  const [, update] = useState(0);
  return (
    <FeatureAccessHarness featureId="agents.workflows">
      <button
        onClick={() => {
          runtime.id = "second";
          update((n) => n + 1);
        }}
      >
        계정 변경
      </button>
      <button
        onClick={() => {
          runtime.team = "second-team";
          update((n) => n + 1);
        }}
      >
        팀 변경
      </button>
      <WorkflowPage />
    </FeatureAccessHarness>
  );
}
function setup(receipt = false) {
  const result = renderScreen(<Host />, {
    path: "/agents/workflows",
    route: receipt ? "/agents/workflows?tab=runs" : "/agents/workflows?workflow=wf_one",
  });
  // Match the production cache lifetime instead of the test harness's immediate eviction.
  result.client.setQueryDefaults(["agents", "workflows"], { gcTime: 300_000, staleTime: 15_000 });
  return result;
}
beforeEach(() => {
  runtime.id = "first";
  runtime.team = "first-team";
});

it("새 드라이런이 실패하면 이전 성공 결과를 현재 결과로 표시하지 않는다", async () => {
  const user = userEvent.setup();
  let calls = 0;
  mockApi({
    ...base,
    "POST /admin/workflows/wf_one/dry-run": () => {
      if (++calls > 1) throw apiFailure("검사 실패", 500);
      return { workflow_id: workflow.id, ok: true, note: "이전 검사 근거" };
    },
  });
  setup();
  await user.click(await screen.findByRole("button", { name: "드라이런" }));
  expect(await screen.findByText("이전 검사 근거")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "드라이런" }));
  expect(await screen.findByText("드라이런에 실패했습니다.")).toBeVisible();
  expect(screen.queryByText("이전 검사 근거")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "드라이런 결과" })).not.toBeInTheDocument();
  expect(calls).toBe(2);
});

it.each(["계정 변경", "팀 변경"])("%s 후 이전 버전 이력을 다시 표시하지 않는다", async (change) => {
  const user = userEvent.setup();
  let calls = 0;
  mockApi({
    ...base,
    "GET /admin/workflows/wf_one/versions": () => {
      calls++;
      return {
        workflow_id: workflow.id,
        versions: [{ id: "version_one", version: 1, note: calls === 1 ? "이전 팀 메모" : "새 팀 메모" }],
      };
    },
  });
  const { client } = setup();
  await user.click(
    within(await screen.findByRole("dialog", { name: workflow.name })).getByRole("button", {
      name: "버전 이력",
    }),
  );
  expect(await screen.findByText("이전 팀 메모")).toBeVisible();
  fireEvent.click(screen.getByText(change, { selector: "button" }));
  await user.click(
    within(await screen.findByRole("dialog", { name: workflow.name })).getByRole("button", {
      name: "버전 이력",
    }),
  );
  expect(await screen.findByText("새 팀 메모")).toBeVisible();
  expect(screen.queryByText("이전 팀 메모")).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("이전 팀 메모");
});

it.each(["versions", "dry-run", "receipt"] as const)(
  "%s 권한 거부 시 상세를 폐기하고 명시적으로 복구한다",
  async (kind) => {
    const user = userEvent.setup();
    const key =
      kind === "receipt"
        ? "GET /v1/workflow-runs/run_one/receipt"
        : `${kind === "versions" ? "GET" : "POST"} /admin/workflows/wf_one/${kind}`;
    let reads = 0;
    const api = mockApi({
      ...base,
      [key]: () => {
        if (++reads > 1 && kind === "receipt") return { run_id: "run_one", status: "ok" };
        throw apiFailure("권한 없음", 403);
      },
    });
    const { client } = setup(kind === "receipt");
    const button =
      kind === "receipt" ? "실행 run_one 영수증 열기" : kind === "versions" ? "버전 이력" : "드라이런";
    await user.click(await screen.findByRole("button", { name: button }));
    expect(await screen.findByText(/워크플로 조회 권한이 없거나 인증 상태가 변경되었습니다/)).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((q) => q.queryKey[0] === "agents"),
    ).toHaveLength(0);
    expect(api.bodies(key)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    if (kind === "receipt") {
      // Explicit recovery reopens the receipt selected by the preserved URL.
      const recovered = await screen.findByRole("dialog", { name: "워크플로 실행 영수증" });
      expect(await within(recovered).findByText("완료")).toBeVisible();
      expect(api.bodies(key)).toHaveLength(2);
    } else {
      expect(await screen.findByRole("dialog", { name: workflow.name })).toBeVisible();
      expect(api.bodies(key)).toHaveLength(1);
    }
    if (kind === "dry-run")
      expect(api.spy.mock.calls.find(([endpoint]) => endpoint.path.endsWith("/dry-run"))?.[1]).toMatchObject({
        retryUnauthorized: false,
      });
  },
);

it("이전 팀의 늦은 버전 응답을 캐시에 남기지 않는다", async () => {
  const user = userEvent.setup();
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const api = mockApi({ ...base, "GET /admin/workflows/wf_one/versions": () => pending });
  const { client } = setup();
  await user.click(await screen.findByRole("button", { name: "버전 이력" }));
  await waitFor(() => expect(api.bodies("GET /admin/workflows/wf_one/versions")).toHaveLength(1));
  fireEvent.click(screen.getByText("팀 변경", { selector: "button" }));
  await act(async () => {
    finish({ workflow_id: workflow.id, versions: [{ note: "폐기할 이전 메모" }] });
    await pending;
  });
  expect(screen.queryByText("폐기할 이전 메모")).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("폐기할 이전 메모");
});
