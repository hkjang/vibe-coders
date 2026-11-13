import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowPage } from "../workflows/WorkflowPage";
import { AppPage } from "../apps/AppPage";
import { FeatureAccessHarness } from "@/test/feature-access";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { workAppReadFixture } from "@/test/work-app-fixtures";
import { workflowReadFixture } from "@/test/workflow-fixtures";

const runtime = vi.hoisted(() => ({ id: "first", team: "team-one" }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ user: { id: runtime.id, team_id: runtime.team } }) };
});
type Kind = "app" | "workflow";
let navigate: ReturnType<typeof useNavigate>;
const path = (kind: Kind) => `/agents/${kind}s`;
const endpoint = (kind: Kind, id = "run-one") => `GET /v1/${kind}-runs/${id}/receipt`;
function Host({ kind }: { kind: Kind }) {
  const { search } = useLocation();
  const move = useNavigate();
  const [, refresh] = useState(0);
  useLayoutEffect(() => {
    navigate = move;
  }, [move]);
  return (
    <FeatureAccessHarness featureId={kind === "app" ? "agents.apps" : "agents.workflows"}>
      <output aria-label="현재 주소">{search}</output>
      <button
        onClick={() => {
          runtime.team = "team-two";
          refresh((n) => n + 1);
        }}
      >
        팀 변경
      </button>
      {kind === "app" ? <AppPage /> : <WorkflowPage />}
    </FeatureAccessHarness>
  );
}
function fixture(kind: Kind, handlers: Record<string, ApiHandler> = {}) {
  return mockApi({
    [`GET /admin/${kind}s`]: ({ query }) =>
      kind === "app" ? workAppReadFixture([], query) : workflowReadFixture([], query),
    [`GET /me/${kind}-runs`]: () => ({ runs: [{ id: "run-one", status: "planned" }] }),
    [endpoint(kind)]: () => ({
      run_id: "run-one",
      status: "planned",
      ...(kind === "app" ? { app_title: "실행한 앱" } : { workflow_name: "실행한 업무" }),
    }),
    ...handlers,
  });
}
function setup(kind: Kind, query = "tab=runs&run=run-one") {
  return renderScreen(<Host kind={kind} />, { route: `${path(kind)}?${query}`, path: path(kind) });
}
const receipt = (kind: Kind) =>
  screen.findByRole("dialog", { name: kind === "app" ? "업무 앱 실행 영수증" : "워크플로 실행 영수증" });
beforeEach(() => {
  runtime.id = "first";
  runtime.team = "team-one";
});

describe.each(["app", "workflow"] as const)("%s 실행 영수증 주소", (kind) => {
  it("목록 조회가 실패해도 직접 주소를 열고 닫을 때 검색과 페이지를 보존한다", async () => {
    const user = userEvent.setup();
    const api = fixture(kind, {
      [`GET /admin/${kind}s`]: () => {
        throw apiFailure("목록 실패");
      },
      [`GET /me/${kind}-runs`]: () => {
        throw apiFailure("이력 실패");
      },
    });
    setup(kind, "tab=runs&run=run-one&q=보존&page=2");
    const dialog = await receipt(kind);
    expect(await within(dialog).findByText("계획됨")).toBeVisible();
    expect(api.bodies(endpoint(kind))).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "대화상자 닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const address = screen.getByLabelText("현재 주소").textContent ?? "";
    expect(new URLSearchParams(address).get("q")).toBe("보존");
    expect(new URLSearchParams(address).get("page")).toBe("2");
    expect(new URLSearchParams(address).has("run")).toBe(false);
    expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  });

  it("명시적 링크와 브라우저 뒤로·앞으로 이동으로 영수증을 열고 닫는다", async () => {
    const user = userEvent.setup();
    fixture(kind);
    setup(kind, "tab=runs&q=유지");
    const link = await screen.findByRole("link", { name: "실행 run-one 영수증 보기" });
    expect(link.getAttribute("href")).toContain("run=run-one");
    await user.click(link);
    expect(await within(await receipt(kind)).findByText("계획됨")).toBeVisible();
    act(() => {
      void navigate(-1);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(link).toHaveFocus();
    act(() => {
      void navigate(1);
    });
    expect(await within(await receipt(kind)).findByText("계획됨")).toBeVisible();
  });

  it.each([
    ["빈 ID", "run="],
    ["중복 ID", "run=a&run=b"],
    ["제어 문자", "run=%00"],
    ["길이 초과", "run=" + "a".repeat(4097)],
    ["정의와 동시 선택", `run=a&${kind}=definition`],
  ])("잘못된 주소 %s는 상세 API를 호출하지 않는다", async (_label, query) => {
    const api = fixture(kind);
    setup(kind, query);
    expect(await within(await receipt(kind)).findByText("영수증 주소를 확인하세요.")).toBeVisible();
    expect(api.calls.some((call) => call.key.includes("/receipt"))).toBe(false);
    expect(api.calls.some((call) => (call.options.query as { view?: string })?.view === "detail")).toBe(
      false,
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("다른 실행 ID의 응답을 숨기고 다시 조회한다", async () => {
    const user = userEvent.setup();
    let count = 0;
    fixture(kind, {
      [endpoint(kind)]: () => ({
        run_id: ++count === 1 ? "wrong" : "run-one",
        status: "ok",
        output_summary: "잘못된 실행",
        workflow_name: "잘못된 실행",
      }),
    });
    setup(kind);
    const dialog = await receipt(kind);
    expect(
      await within(dialog).findByText("요청한 실행의 영수증인지 확인하지 못했습니다. 다시 조회하세요."),
    ).toBeVisible();
    expect(within(dialog).queryByText("잘못된 실행")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    expect(await within(dialog).findByText("완료")).toBeVisible();
    expect(count).toBe(2);
  });

  it("없는 실행을 로딩이나 권한 거부와 구분한다", async () => {
    fixture(kind, {
      [endpoint(kind)]: () => {
        throw apiFailure("없음", 404);
      },
    });
    setup(kind);
    expect(await within(await receipt(kind)).findByText("실행 영수증을 찾을 수 없습니다.")).toBeVisible();
  });

  it("다른 실행으로 이동한 뒤 늦은 응답을 표시하거나 보관하지 않는다", async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const api = fixture(kind, {
      [endpoint(kind)]: () => pending,
      [endpoint(kind, "run-two")]: () => ({ run_id: "run-two", status: "error" }),
    });
    const { client } = setup(kind);
    await waitFor(() => expect(api.bodies(endpoint(kind))).toHaveLength(1));
    act(() => {
      void navigate(`${path(kind)}?tab=runs&run=run-two`);
    });
    expect(await within(await receipt(kind)).findByText("오류")).toBeVisible();
    await act(async () => {
      finish({ run_id: "run-one", status: "planned", output_summary: "이전 실행 정보" });
      await pending;
    });
    expect(screen.queryByText("이전 실행 정보")).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("이전 실행 정보");
  });

  it("민감정보로 보이는 실행 ID를 주소와 요청에서 제거한다", async () => {
    const api = fixture(kind);
    setup(kind, "run=vc_sk_should_not_be_in_history");
    await waitFor(() => expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("vc_sk_"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.calls.some((call) => call.key.includes("/receipt"))).toBe(false);
  });

  it("팀 변경 후 같은 주소의 이전 캐시를 재사용하지 않는다", async () => {
    fixture(kind, {
      [endpoint(kind)]: () => ({
        run_id: "run-one",
        status: runtime.team === "team-one" ? "planned" : "error",
      }),
    });
    const { client } = setup(kind);
    expect(await within(await receipt(kind)).findByText("계획됨")).toBeVisible();
    fireEvent.click(screen.getByText("팀 변경", { selector: "button" }));
    expect(await within(await receipt(kind)).findByText("오류")).toBeVisible();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .filter((q) => q.queryKey.includes("receipt"))
          .map((q) => q.state.data),
      ),
    ).not.toContain("planned");
  });
});

it("앱 이름이 receipt여도 버전 이력과 실행 영수증 캐시가 충돌하지 않는다", async () => {
  const api = fixture("app", { [endpoint("app", "versions")]: () => ({ run_id: "versions", status: "ok" }) });
  const { client } = setup("app", "tab=runs");
  await screen.findByRole("link", { name: "실행 run-one 영수증 보기" });
  const query = client
    .getQueryCache()
    .getAll()
    .find((q) => q.queryKey[2] === "runs");
  expect(query).toBeDefined();
  if (!query) throw new Error("실행 조회 누락");
  client.setQueryDefaults(["agents", "apps"], { staleTime: 15_000 });
  client.setQueryData(["agents", "apps", "receipt", "versions", ...query.queryKey.slice(-2)], {
    versions: [{ note: "다른 앱 이력" }],
  });
  act(() => {
    void navigate("/agents/apps?tab=runs&run=versions");
  });
  expect(await within(await receipt("app")).findByText("완료")).toBeVisible();
  expect(api.bodies(endpoint("app", "versions"))).toHaveLength(1);
  expect(screen.queryByText("다른 앱 이력")).not.toBeInTheDocument();
});
