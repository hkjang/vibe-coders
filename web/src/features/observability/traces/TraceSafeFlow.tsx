import { useId } from "react";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useTraceSafeFlowAccess, type TraceSafeFlowAccess } from "./trace-safe-flow-access";
import { useTraceSafeFlowQuery, type TraceFlowSelection } from "./trace-safe-flow-query";
import { TraceSafeFlowResult } from "./TraceSafeFlowResult";
import { flowDisplay } from "./trace-safe-flow-display";
import "./trace-safe-flow.css";

function FlowBody({
  selection,
  access,
  timeZone,
}: {
  selection: TraceFlowSelection;
  access: TraceSafeFlowAccess;
  timeZone: string;
}) {
  const { query, retry, previous } = useTraceSafeFlowQuery(selection, access);
  const error = isAppError(query.error) ? query.error : undefined;
  const unavailable = error?.status === 404;
  return (
    <>
      <Button
        variant="secondary"
        size="small"
        aria-disabled={!selection.ready || query.isFetching}
        aria-busy={query.isFetching}
        onClick={retry}
      >
        단계 기록 다시 조회
      </Button>
      {!selection.ready ? (
        <InlineNotice title="현재 목록을 확인해야 합니다.">
          목록을 조회 중이거나 최신 조회에 실패했습니다. 이전 기록은 현재 선택을 다시 확인하기 전까지 새
          결과로 보지 마세요.
        </InlineNotice>
      ) : null}
      {query.isFetching ? <p role="status">단계 기록을 확인하는 중입니다.</p> : null}
      {query.isError ? (
        <InlineNotice
          tone="danger"
          title={unavailable ? "이 요청의 단계 기록을 열 수 없습니다." : "단계 기록을 불러오지 못했습니다."}
        >
          <p>
            {unavailable
              ? "서버 지원 또는 현재 조회 범위를 확인하세요. 원시 요청 상세로 대신 조회하지 않습니다."
              : "권한과 현재 목록을 확인한 뒤 직접 다시 조회하세요."}
          </p>
          {error?.requestId ? <p>요청 ID: {flowDisplay(error.requestId, access.prefixes)}</p> : null}
        </InlineNotice>
      ) : null}
      {query.data ? (
        <>
          {previous ? <p role="status">이전 단계 기록입니다. 현재 목록 기준의 재확인이 필요합니다.</p> : null}
          <TraceSafeFlowResult data={query.data.response} prefixes={access.prefixes} timeZone={timeZone} />
        </>
      ) : !query.isFetching && !query.isError && selection.ready ? (
        <p role="status">단계 조회를 준비하고 있습니다.</p>
      ) : null}
    </>
  );
}

export function TraceSafeFlow(selection: TraceFlowSelection & { timeZone: string }) {
  const access = useTraceSafeFlowAccess();
  const titleId = useId();
  return (
    <section className="trace-safe-flow" aria-labelledby={titleId}>
      <h3 id={titleId}>선택한 요청의 단계 기록</h3>
      <p>
        기록된 부모 요청과 하위 단계를 확인합니다. 기록 상대 위치는 요청 기록 시각과의 차이이며 실제 실행
        시작·종료나 전체 분산 추적을 뜻하지 않습니다. 기록된 지연 0도 실제 측정 0을 보장하지 않습니다.
      </p>
      {access.readable ? (
        <FlowBody
          key={JSON.stringify([access.key, selection.request_ref, selection.created_at])}
          selection={selection}
          access={access}
          timeZone={selection.timeZone}
        />
      ) : (
        <p role="status">현재 화면의 요청 조회 권한을 확인할 수 없습니다.</p>
      )}
    </section>
  );
}
