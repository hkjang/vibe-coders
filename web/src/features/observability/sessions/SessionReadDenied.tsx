import { useEffect, useRef } from "react";
import { Button } from "@/shared/components/ui/Button";

export function SessionReadDenied({
  detail = false,
  focus = true,
  onRetry,
  requestId,
}: {
  detail?: boolean;
  focus?: boolean;
  onRetry: () => void;
  requestId?: string;
}): React.JSX.Element {
  const notice = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus) notice.current?.focus();
  }, [focus]);
  return (
    <section ref={notice} role="alert" tabIndex={-1} className="page-state page-state-error">
      {detail ? <h3>비행기록 조회가 거부되었습니다.</h3> : <h2>세션 목록 조회가 거부되었습니다.</h2>}
      <p>
        현재 조회 권한을 확인할 수 없어 이전 {detail ? "비행기록" : "목록"}을 표시하지 않습니다. 관리자에게
        계정의 조회 권한과 팀 접근 범위를 확인해 달라고 요청하세요.
      </p>
      {requestId ? <p className="request-id">요청 ID: {requestId}</p> : null}
      <Button onClick={onRetry}>권한 확인 후 다시 조회</Button>
    </section>
  );
}
