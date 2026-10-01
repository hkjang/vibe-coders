import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppRequestSummary } from "@/shared/api/schemas";
import { TraceRequestTable } from "./TraceRequestTable";
import { TraceTimeline } from "./TraceTimeline";

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

const reason = "현재 목록을 확인한 뒤 요청을 선택하세요.";
const controls = [
  { label: "요청 표", Component: TraceRequestTable, name: "1번째 요청 request-control 상세 보기" },
  { label: "시간축", Component: TraceTimeline, name: "1번째 요청 request-control 흐름 선택" },
] as const;

describe.each(controls)("$label의 현재 목록 선택", ({ Component, name }) => {
  it("허용된 현재 행은 마우스와 키보드로 정확한 요청·버튼을 전달한다", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Component requests={[request]} selectionEnabled timeZone="UTC" onSelect={onSelect} />);
    const button = screen.getByRole("button", { name });

    await user.click(button);
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenNthCalledWith(1, request, button);
    expect(onSelect).toHaveBeenNthCalledWith(2, request, button);
  });

  it("일시 제한 중 같은 버튼과 초점을 유지하지만 마우스·Enter 선택은 보내지 않는다", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const props = { requests: [request], selectionEnabled: true, timeZone: "UTC", onSelect };
    const view = render(<Component {...props} />);
    const button = screen.getByRole("button", { name });
    await user.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(button).toHaveFocus();

    // A spread keeps this a runtime behavior RED against the old component;
    // a missing TypeScript prop must not replace the click-admission assertion.
    view.rerender(<Component {...{ ...props, selectionDisabledReason: reason }} />);
    expect(screen.getByRole("button", { name })).toBe(button);
    expect(button).toHaveFocus();
    await user.click(button);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAccessibleDescription(reason);
  });

  it("일시 제한이 해제되면 같은 버튼에서 현재 선택이 다시 가능하다", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const props = { requests: [request], selectionEnabled: true, timeZone: "UTC", onSelect };
    const view = render(<Component {...{ ...props, selectionDisabledReason: reason }} />);
    const button = screen.getByRole("button", { name });
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();

    view.rerender(<Component {...props} />);
    expect(screen.getByRole("button", { name })).toBe(button);
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(request, button);
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAccessibleDescription(reason);
  });

  it("v1 계약에서는 기존 native disabled와 선택 차단을 유지한다", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Component requests={[request]} selectionEnabled={false} timeZone="UTC" onSelect={onSelect} />);
    const button = screen.getByRole("button", { name });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "서버 배포 완료 후 요청 상세를 열 수 있습니다.");
    await user.click(button);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
