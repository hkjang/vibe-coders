import { useLayoutEffect, useRef } from "react";
import { Badge } from "@/shared/components/ui/Badge";
import { TraceTimelineLane, type TraceLaneControls } from "./TraceTimelineLane";
import type { TraceTimelineGroupData } from "./trace-timeline-groups";
import { formatTraceDuration } from "./trace-utils";
export function TraceTimelineGroup({
  group,
  controls,
}: {
  group: TraceTimelineGroupData;
  controls: TraceLaneControls;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const selected = group.rows.some(({ lane }) => lane.request.request_ref === controls.selectedRequestRef);
  // Open the containing group when selection comes from a shared URL or the request table.
  // Ordinary refreshes must not override the user's native disclosure state.
  useLayoutEffect(() => {
    if (selected && ref.current) ref.current.open = true;
  }, [selected, controls.selectedRequestRef]);
  return (
    <details ref={ref} className="trace-timeline-group">
      <summary>
        <span className="trace-group-title">
          {group.traceId === null ? (
            `추적 미확인 · ${group.rows[0]?.ordinal}번째 요청`
          ) : (
            <>
              <span>추적</span> <code>{group.traceId}</code>
            </>
          )}
        </span>
        <span className="trace-group-metrics">
          <span>현재 페이지 {group.rows.length.toLocaleString("ko-KR")}건</span>
          <Badge tone={group.errors ? "danger" : "muted"}>
            오류 {group.errors.toLocaleString("ko-KR")}건
          </Badge>
          {group.unknownStatuses ? (
            <Badge tone="warning">상태 미확인 {group.unknownStatuses.toLocaleString("ko-KR")}건</Badge>
          ) : null}
          <span>최대 지연 {formatTraceDuration(group.maxLatency)}</span>
          {selected ? <Badge tone="info">선택한 요청 포함</Badge> : null}
        </span>
      </summary>
      <ol className="trace-lanes">
        {group.rows.map(({ lane, ordinal }) => (
          <TraceTimelineLane key={lane.request.request_ref} lane={lane} ordinal={ordinal} {...controls} />
        ))}
      </ol>
    </details>
  );
}
