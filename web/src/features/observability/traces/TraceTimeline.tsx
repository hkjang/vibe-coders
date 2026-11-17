import { useId } from "react";
import type { AppRequestSummary } from "@/shared/api/schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { buildTraceTimeline, formatTraceDuration } from "./trace-utils";
import { TraceTimelineLane, type TraceLaneControls } from "./TraceTimelineLane";
import { TraceTimelineGroup } from "./TraceTimelineGroup";
import { groupTraceTimeline } from "./trace-timeline-groups";
import type { TraceTimelineView } from "@/shared/utils/trace-timeline-query";
import "./trace-timeline-groups.css";
interface TraceTimelineProps extends Omit<TraceLaneControls, "reasonId"> {
  requests: readonly AppRequestSummary[];
  view?: TraceTimelineView;
  onViewChange?: (view: TraceTimelineView) => void;
}
export function TraceTimeline({
  requests,
  view = "time",
  onViewChange,
  ...controls
}: TraceTimelineProps): React.JSX.Element {
  const timeline = buildTraceTimeline(requests);
  const reasonId = useId();
  const groupHelpId = useId();
  const laneControls = { ...controls, reasonId };
  return (
    <section
      className="trace-panel trace-timeline"
      data-timeline-view={view}
      aria-labelledby="trace-timeline-title"
    >
      <header className="trace-panel-header">
        <div>
          <h2 id="trace-timeline-title">요청 처리 흐름</h2>
          <p>
            각 막대는 안전한 운영 메타데이터의 요청 기록 시각과 기록된 지연을 나타냅니다. 실제 실행 시작·종료
            시각을 보장하지 않습니다.
          </p>
        </div>
        <Badge tone="info">요청 단위</Badge>
      </header>
      {onViewChange ? (
        <div className="trace-timeline-toolbar" role="group" aria-label="요청 흐름 표시 방식">
          <Button
            variant="secondary"
            size="small"
            aria-pressed={view === "time"}
            onClick={() => onViewChange("time")}
          >
            시간순 보기
          </Button>
          <Button
            variant="secondary"
            size="small"
            aria-pressed={view === "trace"}
            onClick={() => onViewChange("trace")}
          >
            추적별 보기
          </Button>
        </div>
      ) : null}
      {controls.selectionDisabledReason ? <p id={reasonId}>{controls.selectionDisabledReason}</p> : null}
      {view === "trace" ? (
        <p className="trace-group-help" id={groupHelpId}>
          현재 페이지에서 공개된 추적 ID가 같은 요청만 묶습니다. 전체 추적 집계나 부모·자식 관계를 뜻하지
          않습니다. 추적 ID를 확인할 수 없는 요청은 각각 표시합니다.
        </p>
      ) : null}
      <div className="trace-scale" aria-hidden="true">
        <span>0ms</span>
        <span>{formatTraceDuration(timeline.spanMs / 2)}</span>
        <span>{formatTraceDuration(timeline.spanMs)}</span>
      </div>
      {view === "trace" ? (
        <div className="trace-timeline-groups" aria-describedby={groupHelpId}>
          {groupTraceTimeline(timeline.lanes).map((group) => (
            <TraceTimelineGroup key={group.key} group={group} controls={laneControls} />
          ))}
        </div>
      ) : (
        <ol className="trace-lanes">
          {timeline.lanes.map((lane, index) => (
            <TraceTimelineLane
              key={lane.request.request_ref}
              lane={lane}
              ordinal={index + 1}
              {...laneControls}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
