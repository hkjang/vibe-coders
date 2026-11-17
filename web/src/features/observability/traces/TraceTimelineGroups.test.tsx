import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppRequestSummary } from "@/shared/api/schemas";
import { TraceTimeline } from "./TraceTimeline";
import { buildTraceTimeline, traceCount } from "./trace-utils";
import { groupTraceTimeline } from "./trace-timeline-groups";
function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected test fixture element");
  return value;
}

const request: AppRequestSummary = {
  request_id: "request-control",
  request_ref: `req_${"a".repeat(22)}.${"b".repeat(21)}`,
  request_filterable: true,
  trace_id: "trace-control",
  trace_filterable: true,
  session_id: "session-control",
  api_key_id: "",
  ip: "",
  method: "POST",
  model: "합성 모델",
  provider_ref: `prv_${"p".repeat(43)}`,
  provider_display: "합성 공급자",
  endpoint: "/v1/chat/completions",
  stream: false,
  status_code: 200,
  latency_ms: 125,
  first_chunk_ms: 0,
  prompt_tokens: 1,
  completion_tokens: 2,
  total_tokens: 3,
  cached_tokens: 0,
  reasoning_tokens: 0,
  estimated_cost: 0,
  currency: "KRW",
  finish_reason: "stop",
  created_at: "2026-10-01T01:02:03.123456789Z",
};

function row(
  letter: string,
  traceId = "trace-a",
  overrides: Partial<AppRequestSummary> = {},
): AppRequestSummary {
  return {
    ...request,
    request_id: `request-${letter}`,
    request_ref: `req_${letter.repeat(22)}.${letter.repeat(21)}`,
    trace_id: traceId,
    ...overrides,
  };
}
describe("추적별 요청 흐름", () => {
  it("정확한 공개 ID만 묶고 전역 순서와 시간 위치를 보존한다", () => {
    const a = row("a", "Trace-A"),
      b = row("b", "trace-a"),
      c = row("c", "Trace-A", { status_code: 503, latency_ms: 400 });
    const timeline = buildTraceTimeline([c, b, a]);
    const groups = groupTraceTimeline(timeline.lanes);
    expect(groups).toHaveLength(2);
    const group = present(groups.find((g) => g.traceId === "Trace-A"));
    expect(group.rows.map((r) => r.ordinal)).toEqual([1, 3]);
    expect(group.rows[1]?.lane).toBe(timeline.lanes[2]);
    expect(group).toMatchObject({ errors: 1, unknownStatuses: 0, maxLatency: 400 });
  });
  it("비공개·누락 ID와 상태 미확인을 정상 추적으로 합치지 않는다", () => {
    const rows = [
      row("a", "[값 비공개]", { trace_filterable: false, status_code: 0 }),
      row("b", "[값 비공개]", { trace_filterable: false, status_code: 600 }),
      row("c", ""),
      row("d", ""),
    ];
    const groups = groupTraceTimeline(buildTraceTimeline(rows).lanes);
    expect(groups).toHaveLength(4);
    expect(traceCount(rows)).toBe(0);
    expect(traceCount([...rows, row("e", "trace-visible"), row("f", "trace-visible")])).toBe(1);
    expect(groups.every((g) => g.traceId === null && g.rows.length === 1 && g.errors === 0)).toBe(true);
    expect(groups.reduce((sum, g) => sum + g.unknownStatuses, 0)).toBe(2);
  });
  it("묶음 조회와 펼침은 API 없이 현재 요청을 선택하고 같은 버튼을 유지한다", async () => {
    const onSelect = vi.fn(),
      user = userEvent.setup();
    const props = {
      requests: [row("a"), row("b")],
      onSelect,
      selectionEnabled: true,
      timeZone: "UTC",
      view: "trace" as const,
    };
    const view = render(<TraceTimeline {...props} />);
    const disclosure = present(document.querySelector("details"));
    expect(disclosure.open).toBe(false);
    await user.click(present(disclosure.querySelector("summary")));
    expect(disclosure.open).toBe(true);
    const button = screen.getByRole("button", { name: "2번째 요청 request-b 흐름 선택" });
    await user.click(button);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(props.requests[1], button);
    view.rerender(<TraceTimeline {...props} selectionDisabledReason="현재 목록을 확인하세요." />);
    expect(screen.getByRole("button", { name: "2번째 요청 request-b 흐름 선택" })).toBe(button);
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
  it("공유 선택이 있는 묶음을 펼치고 일반 갱신은 사용자가 접은 상태를 보존한다", () => {
    const rows = [row("a"), row("b", "trace-b")];
    const props = {
      requests: rows,
      onSelect: vi.fn(),
      selectionEnabled: true,
      timeZone: "UTC",
      view: "trace" as const,
    };
    const view = render(<TraceTimeline {...props} selectedRequestRef={present(rows[1]).request_ref} />);
    const groups = document.querySelectorAll("details");
    expect(present(groups[0]).open).toBe(false);
    expect(present(groups[1]).open).toBe(true);
    fireEvent.click(present(present(groups[1]).querySelector("summary")));
    expect(present(groups[1]).open).toBe(false);
    view.rerender(
      <TraceTimeline {...props} requests={[...rows]} selectedRequestRef={present(rows[1]).request_ref} />,
    );
    expect(present(groups[1]).open).toBe(false);
    view.rerender(<TraceTimeline {...props} selectedRequestRef={present(rows[0]).request_ref} />);
    expect(present(groups[0]).open).toBe(true);
  });
  it("v1 계약에서는 묶음 안의 요청도 선택하지 않는다", async () => {
    const onSelect = vi.fn(),
      user = userEvent.setup();
    render(
      <TraceTimeline
        requests={[row("a")]}
        onSelect={onSelect}
        selectionEnabled={false}
        timeZone="UTC"
        view="trace"
      />,
    );
    await user.click(present(document.querySelector("summary")));
    const button = screen.getByRole("button", { name: /request-a 흐름 선택/ });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
