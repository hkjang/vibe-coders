import { describe, expect, it } from "vitest";

import {
  buildTraceQuery,
  buildTraceTimeline,
  requestExplorerPath,
  selectedRequestFromSearch,
  traceCount,
  traceStatusTone,
} from "@/features/observability/traces/trace-utils";
import type { AppRequestSummary } from "@/shared/api/schemas";

const providerRef = `prv_${"a".repeat(43)}`;

function request(
  requestId: string,
  createdAt: string,
  latencyMs: number,
  traceId = "trace-001",
): AppRequestSummary {
  return {
    request_id: requestId,
    trace_id: traceId,
    session_id: "session-001",
    api_key_id: "key-001",
    ip: "192.0.2.10",
    method: "POST",
    model: "gpt-test",
    provider_ref: providerRef,
    provider_display: "테스트 공급자",
    endpoint: "/v1/chat/completions",
    stream: true,
    status_code: 200,
    latency_ms: latencyMs,
    first_chunk_ms: 30,
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
    cached_tokens: 1,
    reasoning_tokens: 0,
    estimated_cost: 1.25,
    currency: "KRW",
    finish_reason: "stop",
    created_at: createdAt,
  };
}

describe("trace utilities", () => {
  it.each([
    [0, "muted"],
    [100, "muted"],
    [199, "muted"],
    [200, "success"],
    [399, "success"],
    [400, "warning"],
    [499, "warning"],
    [500, "danger"],
    [599, "danger"],
    [600, "muted"],
  ] as const)("maps HTTP status %i to the %s tone", (status, tone) => {
    expect(traceStatusTone(status)).toBe(tone);
  });

  it("builds only safe request-list fields while preserving bounded exact filters", () => {
    const search = new URLSearchParams(
      "trace_id=trace-001&selected_request=req-1&status=503&model=gpt-test&limit=75&from=2026-09-04T01%3A00%3A00Z&to=2026-09-04T02%3A00%3A00%2B00%3A00&tz=UTC&unknown=drop",
    );

    expect(buildTraceQuery(search)).toEqual({
      trace_id: "trace-001",
      status: "503",
      model: "gpt-test",
      limit: 75,
      from: "2026-09-04T01:00:00Z",
      to: "2026-09-04T02:00:00+00:00",
      tz: "UTC",
    });
    expect(selectedRequestFromSearch(search)).toBe("req-1");
  });

  it("drops invalid exact statuses and applies bounded defaults", () => {
    expect(buildTraceQuery(new URLSearchParams("status=099&limit=500&tz="))).toEqual({
      limit: 50,
      tz: "Asia/Seoul",
    });
    expect(buildTraceQuery(new URLSearchParams(`trace_id=${"한".repeat(171)}`))).toEqual({
      limit: 50,
      tz: "Asia/Seoul",
    });
  });

  it("orders request lanes by time and computes bounded timeline positions", () => {
    const later = request("req-later", "2026-09-04T00:00:00.100Z", 100);
    const first = request("req-first", "2026-09-04T00:00:00.000Z", 200);
    const layout = buildTraceTimeline([later, first]);

    expect(layout.spanMs).toBe(200);
    expect(layout.lanes.map((lane) => lane.request.request_id)).toEqual(["req-first", "req-later"]);
    expect(layout.lanes[0]).toMatchObject({ startOffsetMs: 0, offsetPercent: 0, widthPercent: 100 });
    expect(layout.lanes[1]).toMatchObject({ startOffsetMs: 100, offsetPercent: 50, widthPercent: 50 });
  });

  it("counts only recorded trace IDs and builds a request-explorer deep link without trace cursors", () => {
    const rows = [
      request("req-1", "2026-09-04T00:00:00.000Z", 20),
      request("req-2", "2026-09-04T00:00:00.100Z", 20, ""),
      request("req-3", "2026-09-04T00:00:00.200Z", 20, "trace-002"),
    ];
    const search = new URLSearchParams(
      "trace_id=trace-001&status=success&cursor=opaque&selected_request=req-1",
    );

    expect(traceCount(rows)).toBe(2);
    expect(requestExplorerPath(buildTraceQuery(search), "req-1")).toBe(
      "/observability/requests?status=success&trace_id=trace-001&limit=50&tz=Asia%2FSeoul&request_id=req-1",
    );
  });
});
