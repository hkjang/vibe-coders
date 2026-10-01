import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/shared/components/ui/Button";
import { traceSafeFlowQuerySchema } from "@/shared/api/domains/trace-safe-flow.schema";
import { TraceSafeFlow } from "../traces/TraceSafeFlow";
import type { AppRequestSummary } from "@/shared/api/schemas";

export function RequestSafeFlowPanel({
  request,
  contractV2,
  ready,
  generation,
  assertSelected,
  timeZone,
}: {
  request: AppRequestSummary;
  contractV2: boolean;
  ready: boolean;
  generation: number;
  assertSelected: () => void;
  timeZone: string;
}) {
  const [armed, setArmed] = useState(false);
  const mounted = useRef(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const latest = useRef(assertSelected);
  useLayoutEffect(() => {
    latest.current = assertSelected;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (armed) resultRef.current?.focus();
  }, [armed]);
  const target = traceSafeFlowQuerySchema.safeParse({
    request_ref: request.request_ref,
    created_at: request.created_at,
  });
  if (!contractV2 || !target.success)
    return (
      <p>이 목록 응답에서는 처리 단계 조회를 지원하지 않습니다. 기존 요청 요약은 계속 확인할 수 있습니다.</p>
    );
  if (armed)
    return (
      <div ref={resultRef} role="group" aria-label="단계 기록 조회 결과" tabIndex={-1}>
        <TraceSafeFlow
          {...target.data}
          expectedOwner="observability.requests"
          ready={ready}
          revision={generation}
          assertParent={assertSelected}
          timeZone={timeZone}
        />
      </div>
    );
  return (
    <section aria-label="요청 처리 단계 조회">
      <p>선택한 요청의 단계 기록을 필요할 때 조회합니다. 원시 요청 본문을 대신 열지 않습니다.</p>
      {!ready ? <p role="status">현재 목록을 확인해야 합니다.</p> : null}
      <Button
        variant="secondary"
        aria-disabled={!ready}
        onClick={() => {
          if (!mounted.current) return;
          try {
            latest.current();
          } catch {
            return;
          }
          setArmed(true);
        }}
      >
        처리 단계 보기
      </Button>
    </section>
  );
}
