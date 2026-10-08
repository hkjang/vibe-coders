import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { formatDateTime, formatRelative } from "@/shared/utils/format";
import type { useXViewLive } from "./use-xview-live";

export function XViewLiveStatus({
  state,
  live,
  scatter,
  fixedEnd,
}: {
  state: ReturnType<typeof useXViewLive>;
  live: boolean;
  scatter: boolean;
  fixedEnd: boolean;
}) {
  let message = "약 1.5초 간격으로 새 요청을 조회합니다.";
  if (!live) message = "실시간 꺼짐";
  else if (!scatter) message = "다른 화면을 보는 동안 산점도 자동 조회를 멈췄습니다.";
  else if (fixedEnd) message = "종료 시각이 정해진 구간입니다. 자동 조회를 하지 않습니다.";
  else if (!state.automaticRead)
    message = "조회 권한 확인 후 자동 조회가 중지되어 있습니다. 지금 새로고침으로 다시 확인하세요.";
  else if (state.initialError)
    message = "목록 재조회에 실패해 자동 조회를 멈췄습니다. 지금 새로고침으로 다시 확인하세요.";
  else if (state.snapshotFetching) message = "요청 목록의 새 응답을 기다리고 있습니다.";
  else if (state.snapshotInvalidated)
    message = "요청 목록 재조회가 필요해 자동 조회를 멈췄습니다. 지금 새로고침으로 다시 확인하세요.";
  else if (state.paused) message = "탭이 가려져 실시간 갱신을 멈췄습니다.";
  else if (state.status === "retrying") message = "조회 실패로 재시도를 기다리고 있습니다.";
  else if (state.status === "catching-up") message = "남은 요청을 이어서 조회하고 있습니다.";
  else if (state.status === "stalled") message = "커서 진행을 확인할 수 없어 빠른 연속 조회를 멈췄습니다.";
  else if (state.initialPending) message = "첫 응답을 기다리고 있습니다.";
  return (
    <div className="xview-live-status">
      <div className="obs-meta" role="status">
        <span>{message}</span>
        {state.lastUpdatedAt > 0 ? (
          <span title={formatDateTime(state.lastUpdatedAt)}>
            마지막 응답 확인 {formatRelative(state.lastUpdatedAt)}
          </span>
        ) : null}
      </div>
      {!state.initialPending && state.lastUpdatedAt > 0 && !state.clockConfirmed ? (
        <InlineNotice tone="warning" title="서버 시각을 확인할 수 없습니다.">
          {state.clockEstimated
            ? "마지막으로 확인한 서버 시각과 경과 시간으로 상대 구간을 계산합니다."
            : "브라우저 시각만으로 요청을 제거하지 않습니다. 상대 구간의 현재 범위를 확인하려면 지금 새로고침을 눌러 주세요."}
        </InlineNotice>
      ) : null}
    </div>
  );
}
