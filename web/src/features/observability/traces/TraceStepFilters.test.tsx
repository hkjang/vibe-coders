import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { describe, expect, it } from "vitest";
import type { TraceSafeFlow } from "@/shared/api/domains/trace-safe-flow.schema";
import { TraceSafeFlowResult } from "./TraceSafeFlowResult";
import { readStepFilters } from "@/shared/utils/trace-step-query";

function safeFlow(): TraceSafeFlow {
  const at = "2026-10-01T00:00:00.123456789Z";
  const root: TraceSafeFlow["spans"][number] = {
    span_ref: "root",
    parent_ref: null,
    kind: "request",
    name: "게이트웨이 요청",
    status: "ok",
    recorded_at: at,
    offset_ms: 0,
    duration_ms: 450,
  };
  return {
    flow_version: 1,
    request_ref: "public",
    created_at: at,
    generated_at: at,
    spans: [
      root,
      {
        ...root,
        span_ref: "tool",
        parent_ref: "root",
        kind: "mcp_tool",
        name: "공개 검색 도구",
        status: "unknown",
        offset_ms: -5,
        duration_ms: null,
      },
      {
        ...root,
        span_ref: "sql",
        parent_ref: "root",
        kind: "text2sql",
        name: "권한 검사",
        status: "error",
        offset_ms: 1000,
        duration_ms: 0,
      },
    ],
    coverage: {
      tools: { limit: 100, truncated: false, omitted: 0 },
      text2sql: { limit: 100, truncated: false, omitted: 0 },
    },
  };
}

function RouteControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="현재 주소">{location.search}</output>
      <button onClick={() => navigate(-1)}>이전 조건</button>
    </>
  );
}
const table = () => screen.getByRole("table", { name: "기록된 요청 단계와 시간" });
function setup(data: TraceSafeFlow, search = "?selected_ref=public-selection&tz=UTC&limit=25") {
  return render(
    <MemoryRouter initialEntries={[`/observability/traces${search}`]}>
      <RouteControls />
      <TraceSafeFlowResult data={data} prefixes={["corp_"]} timeZone="UTC" />
    </MemoryRouter>,
  );
}

describe("요청 하위 단계 탐색", () => {
  it("오류와 유형을 함께 좁히되 부모와 기준 시간축을 보존한다", async () => {
    const user = userEvent.setup();
    setup(safeFlow());
    const parent = within(table())
      .getByRole("rowheader", { name: /^게이트웨이 요청/u })
      .closest("tr");
    if (!parent) throw new Error("Missing parent row");
    const before = parent.querySelector(".trace-safe-flow-bar")?.getAttribute("style");
    await user.selectOptions(screen.getByLabelText("단계 상태"), "error");
    expect(within(table()).queryByText("공개 검색 도구")).not.toBeInTheDocument();
    expect(within(table()).getByText("권한 검사")).toBeVisible();
    expect(parent.querySelector(".trace-safe-flow-bar")?.getAttribute("style")).toBe(before);
    expect(screen.getByRole("status", { name: "단계 필터 결과" })).toHaveTextContent(
      "하위 단계 2개 중 1개 표시",
    );
    expect(screen.getByLabelText("조회된 하위 단계 상태 요약")).toHaveTextContent("오류 1개정상 0개");
    await user.selectOptions(screen.getByLabelText("단계 유형"), "mcp_tool");
    expect(table().querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "단계 필터 결과" })).toHaveTextContent(
      "조건에 맞는 하위 단계가 없습니다",
    );
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent(
      "selected_ref=public-selection&tz=UTC&limit=25&flow_kind=mcp_tool&flow_status=error",
    );
    await user.click(screen.getByRole("button", { name: "단계 필터 초기화" }));
    expect(table().querySelectorAll("tbody tr")).toHaveLength(3);
    expect(screen.getByLabelText("현재 주소")).toHaveTextContent(
      "?selected_ref=public-selection&tz=UTC&limit=25",
    );
  });
  it("주소의 조건으로 처음 렌더링하고 뒤로 가기에서 이전 필터를 복원한다", async () => {
    const user = userEvent.setup();
    setup(safeFlow(), "?flow_kind=text2sql&flow_status=error");
    expect(screen.getByLabelText("단계 유형")).toHaveValue("text2sql");
    expect(screen.getByLabelText("단계 상태")).toHaveValue("error");
    expect(table().querySelectorAll("tbody tr")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "단계 필터 초기화" }));
    await user.click(screen.getByRole("button", { name: "이전 조건" }));
    expect(screen.getByLabelText("단계 상태")).toHaveValue("error");
    expect(table().querySelectorAll("tbody tr")).toHaveLength(2);
  });
  it("중복·알 수 없는 주소 값은 출력하지 않고 전체 조건을 적용한다", () => {
    expect(
      readStepFilters(new URLSearchParams("flow_kind=tool&flow_kind=mcp_tool&flow_status=corp_private")),
    ).toEqual({ kind: "all", status: "all" });
    expect(readStepFilters(new URLSearchParams("flow_kind=constructor&flow_status=toString"))).toEqual({
      kind: "all",
      status: "all",
    });
    setup(safeFlow(), "?flow_kind=tool&flow_kind=mcp_tool&flow_status=corp_private");
    expect(screen.getByLabelText("단계 유형")).toHaveValue("all");
    expect(screen.getByLabelText("단계 상태")).toHaveValue("all");
    expect(table().querySelectorAll("tbody tr")).toHaveLength(3);
  });
  it("부분 조회 범위와 비공개 이름 보호는 필터 후에도 유지한다", async () => {
    const data = safeFlow();
    const child = data.spans[2];
    if (!child) throw new Error("Missing child fixture");
    child.name = `corp_${"x".repeat(32)}`;
    data.coverage.tools = { limit: 100, truncated: true, omitted: 10 };
    setup(data);
    await userEvent.setup().selectOptions(screen.getByLabelText("단계 상태"), "error");
    expect(within(table()).getByText("[값 비공개]")).toBeVisible();
    expect(screen.queryByText(child.name)).not.toBeInTheDocument();
    expect(screen.getByText(/표시 생략 10개/u)).toBeVisible();
    expect(screen.getByText(/조회 상한 초과: 일부 후보만 확인했습니다/u)).toBeVisible();
  });
});
