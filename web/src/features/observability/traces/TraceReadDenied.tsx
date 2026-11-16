import { useEffect, useRef } from "react";
import { Button } from "@/shared/components/ui/Button";

export function TraceReadDenied({
  detail = false,
  disabled = false,
  onRetry,
  requestId,
}: {
  detail?: boolean;
  disabled?: boolean;
  onRetry: () => void;
  requestId?: string;
}) {
  const notice = useRef<HTMLElement>(null);
  useEffect(() => {
    notice.current?.focus();
  }, []);
  return (
    <section ref={notice} role="alert" tabIndex={-1} className="page-state page-state-error">
      {detail ? <h4>단계 기록 조회가 거부되었습니다.</h4> : <h1>추적 목록 조회가 거부되었습니다.</h1>}
      <p>
        현재 조회 권한을 확인할 수 없어 이전 {detail ? "단계 기록" : "목록과 연결된 단계 기록"}을 표시하지
        않습니다. 관리자에게 계정의 조회 권한과 팀 접근 범위를 확인해 달라고 요청하세요.
      </p>
      {requestId ? <p className="request-id">요청 ID: {requestId}</p> : null}
      {disabled ? <p>먼저 목록을 다시 조회하세요.</p> : null}
      <Button onClick={onRetry} disabled={disabled}>
        권한 확인 후 다시 조회
      </Button>
    </section>
  );
}
