import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import type { AppRequestsQuery } from "@/shared/api/schemas";
import { TraceListCriteria } from "./TraceListCriteria";

const requested: AppRequestsQuery = {
  trace_id: "trace-new",
  from: "2026-10-01T01:02:03.123456789Z",
  to: "2026-10-01T09:00:00+09:00",
  status: "503",
  model: "새 모델",
  limit: 75,
  tz: "UTC",
};
const displayed: AppRequestsQuery = {
  trace_id: "trace-old",
  from: "2026-09-30",
  status: "success",
  model: "기존 모델",
  limit: 25,
  tz: "Asia/Seoul",
  cursor: "opaque-cursor-never-rendered",
};
const props = { requested, displayed, prefixes: ["corp_"], pending: false, failed: false };

describe("TraceListCriteria", () => {
  it("요청한 기준과 표시 응답의 기준을 구분하고 임의로 기간·건수를 바꾸지 않는다", () => {
    render(<TraceListCriteria {...props} pending />);
    const card = screen.getByRole("region", { name: "추적 조회 기준" });
    const current = within(card).getByRole("region", { name: "요청한 조회 기준" });
    const previous = within(card).getByRole("region", { name: "표시 중인 결과의 조회 기준" });
    for (const text of ["trace-new", requested.from, requested.to, "HTTP 503", "새 모델", "75건", "UTC"])
      expect(within(current).getByText(text as string, { exact: true })).toBeVisible();
    for (const text of ["trace-old", "2026-09-30", "성공 (HTTP 2xx·3xx)", "기존 모델", "25건", "Asia/Seoul"])
      expect(within(previous).getByText(text, { exact: true })).toBeVisible();
    expect(within(current).getByText("첫 페이지", { exact: true })).toBeVisible();
    expect(within(previous).getByText("이동한 페이지", { exact: true })).toBeVisible();
    expect(card).toHaveTextContent("현재 목록을 확인하는 동안 이전 결과를 표시합니다.");
    expect(card).not.toHaveTextContent("opaque-cursor-never-rendered");
  });

  it("클라이언트 제출 기준과 현재 페이지 집계임을 밝히고 서버 전체 집계로 표시하지 않는다", () => {
    render(<TraceListCriteria {...props} />);
    const card = screen.getByRole("region", { name: "추적 조회 기준" });
    expect(card).toHaveTextContent(
      "클라이언트가 전송한 조회 기준입니다. 서버의 정규화 결과를 뜻하지 않습니다.",
    );
    expect(card).toHaveTextContent("수신한 현재 페이지(최대 200건) 기준이며 전체 추적의 집계가 아닙니다.");
    expect(card).toHaveTextContent("표시 중인 결과의 조회 기준을 확인하세요.");
  });

  it.each([
    [true, false, "현재 조회 기준의 결과를 확인하고 있습니다."],
    [false, true, "현재 조회 기준의 결과를 확인하지 못했습니다."],
    [false, false, "아직 확인된 결과가 없습니다."],
  ])("응답 없는 pending=%s failed=%s 상태를 0건이나 전체 부재로 만들지 않는다", (pending, failed, notice) => {
    render(<TraceListCriteria {...props} displayed={undefined} pending={pending} failed={failed} />);
    const card = screen.getByRole("region", { name: "추적 조회 기준" });
    expect(within(card).getByRole("status")).toHaveTextContent(notice);
    const previous = within(card).getByRole("region", { name: "표시 중인 결과의 조회 기준" });
    expect(previous).toHaveTextContent("표시할 응답의 조회 기준이 아직 확인되지 않았습니다.");
    expect(previous.querySelector("dl")).toBeNull();
    expect(previous).not.toHaveTextContent("0건");
    expect(previous).not.toHaveTextContent("전체 기록이 없습니다");
  });

  it("이전 응답의 실패와 현재 재조회 중을 구분하고 한 개의 상태 안내를 유지한다", () => {
    const view = render(<TraceListCriteria {...props} failed />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("현재 조회에 실패해 마지막 정상 결과를 표시합니다.");
    view.rerender(<TraceListCriteria {...props} failed pending />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("현재 목록을 확인하는 동안 이전 결과를 표시합니다.");
    expect(status).not.toHaveTextContent("현재 조회에 실패");
  });

  it.each([
    [undefined, "전체"],
    ["success", "성공 (HTTP 2xx·3xx)"],
    ["error", "오류 (HTTP 4xx·5xx)"],
    ["4xx", "HTTP 4xx"],
    ["5xx", "HTTP 5xx"],
    ["429", "HTTP 429"],
  ])("HTTP 상태 %s를 %s로 표시한다", (status, label) => {
    render(<TraceListCriteria {...props} requested={{ status }} displayed={undefined} />);
    const current = screen.getByRole("region", { name: "요청한 조회 기준" });
    expect(within(current).getByText(label, { exact: true })).toBeVisible();
    expect(within(current).getByText("기본값 (50건)")).toBeVisible();
    expect(within(current).getByText("기본값 (Asia/Seoul)")).toBeVisible();
    expect(within(current).getAllByText("지정하지 않음")).toHaveLength(4);
  });

  it("요청과 표시 기준 모두 현재 접두사로 다시 보호하고 cursor는 항상 DOM에서 제외한다", () => {
    const marker = `later_${"x".repeat(40)}`;
    const rawCursor = `cursor_${"z".repeat(80)}`;
    const query = { ...requested, trace_id: marker, model: marker, cursor: rawCursor };
    const view = render(<TraceListCriteria {...props} requested={query} displayed={query} prefixes={[]} />);
    expect(screen.getAllByText(marker, { exact: true })).toHaveLength(4);
    expect(view.container.innerHTML).not.toContain(rawCursor);

    view.rerender(<TraceListCriteria {...props} requested={query} displayed={query} prefixes={["later_"]} />);
    expect(view.container.innerHTML).not.toContain(marker);
    expect(view.container.innerHTML).not.toContain(rawCursor);
    expect(screen.getAllByText("[값 비공개]", { exact: true })).toHaveLength(4);
    expect(screen.getAllByText("이동한 페이지", { exact: true })).toHaveLength(2);
  });

  it("기준 영역과 두 기준 제목의 접근성 연결을 제공한다", async () => {
    const view = render(<TraceListCriteria {...props} />);
    expect(screen.getByRole("heading", { name: "추적 조회 기준", level: 2 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "요청한 조회 기준", level: 3 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "표시 중인 결과의 조회 기준", level: 3 })).toBeVisible();
    expect((await axe.run(view.container)).violations).toHaveLength(0);
  });
});
