import { useLayoutEffect, useRef } from "react";
import type { AppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";

export function DomainReviewDenied({
  error,
  onRetry,
  returnFocusRef,
}: {
  error: AppError;
  onRetry: () => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  const heading = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    // The retired dialog also restores focus asynchronously on unmount. Point
    // its shared target at this new heading before that close callback runs.
    returnFocusRef.current = heading.current;
    heading.current?.focus();
  }, [returnFocusRef]);
  return (
    <SectionCard
      className="domain-review-section"
      title={
        <span tabIndex={-1} ref={heading}>
          도메인 라우팅 검토 큐
        </span>
      }
    >
      <InlineNotice tone="warning" title="도메인 검토 조회 권한을 확인하세요.">
        서버가 조회를 허용하지 않아 이전 목록과 열린 검토 내용을 지웠습니다. 로그인 상태와 원문 조회 권한을
        확인한 뒤 다시 조회하세요. 상태 기록 요청은 다시 보내지 않습니다.
        {error.requestId ? <p>요청 ID: {error.requestId}</p> : null}
      </InlineNotice>
      <Button onClick={onRetry}>검토 목록 다시 조회</Button>
    </SectionCard>
  );
}
