import { useId } from "react";

import { ProviderImpactSection } from "@/features/gateway/providers/ProviderImpactSection";
import { providerImpactCategories } from "@/features/gateway/providers/provider-impact-labels";
import type { ProviderImpactReview } from "@/features/gateway/providers/use-provider-impact";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export const providerImpactAcknowledgement = "조회 범위와 확인하지 못한 영향을 확인했습니다";

export function ProviderImpactPanel({
  review,
  pending,
  credentialPrefixes,
}: {
  review: ProviderImpactReview;
  pending: boolean;
  credentialPrefixes?: readonly string[];
}): React.JSX.Element {
  const titleId = useId();
  const { query } = review;
  // A failed refresh must not masquerade as a current successful assessment.
  const data = query.isError ? undefined : query.data;
  const incomplete = data && providerImpactCategories.some(({ key }) => data[key].status !== "complete");
  return (
    <section
      className="form-grid provider-impact-panel"
      aria-labelledby={titleId}
      aria-busy={query.isFetching}
    >
      <h3 id={titleId}>현재 설정의 참조 영향</h3>
      <p>지금 저장된 설정만 읽습니다. 이번 편집안의 적용 결과나 실제 호출을 시험하지 않습니다.</p>
      <p className="field-description">
        모델 패턴 겹침·전체 모델 목록·실제 사용량·호출 성공·IP와 모델별 권한은 확인하지 않습니다. 여러 설정을
        한 시점에 고정한 조회가 아니며 다른 관리자의 동시 변경을 막지 않습니다.
      </p>
      {data ? (
        <p className="field-description">
          서버 조회 시각:{" "}
          <time dateTime={data.generated_at} title={data.generated_at}>
            {new Date(data.generated_at).toLocaleString("ko-KR")}
          </time>
        </p>
      ) : null}
      <Button
        size="small"
        variant="secondary"
        disabled={pending || query.fetchStatus !== "idle"}
        onClick={review.refresh}
      >
        참조 영향 다시 조회
      </Button>
      {query.isFetching ? (
        <p role="status">현재 설정의 참조를 조회하고 있습니다. 완료 후 범위를 확인하세요.</p>
      ) : null}
      {query.fetchStatus === "paused" ? (
        <InlineNotice tone="warning">
          연결 대기로 조회가 중단되었습니다. 연결이 복구되기 전에는 진행할 수 없습니다.
        </InlineNotice>
      ) : null}
      {query.isError ? (
        <InlineNotice tone="danger" title="참조 영향을 조회하지 못했습니다">
          {safeAppErrorMessage(query.error, "현재 설정의 참조 영향을 확인할 수 없습니다.")}
          {isAppError(query.error) && query.error.requestId ? (
            <span className="request-id"> 요청 ID: {query.error.requestId}</span>
          ) : null}
          <p>
            영향이 없다는 뜻이 아닙니다. 다시 조회하거나, 확인하지 못한 위험을 검토한 뒤 명시적으로 동의해야
            진행할 수 있습니다.
          </p>
        </InlineNotice>
      ) : incomplete ? (
        <InlineNotice tone="warning" title="확인하지 못한 영향이 있습니다">
          권한·조회 상한·설정 오류로 빠진 범위를 아래에서 확인하세요. 미확인을 0건으로 해석하지 마세요.
        </InlineNotice>
      ) : null}
      {data?.is_default ? (
        <InlineNotice tone="warning">
          기본 공급자입니다. 변경하거나 삭제하면 기본 경로의 호출에 영향을 줄 수 있습니다.
        </InlineNotice>
      ) : null}
      {data?.bootstrap_on_restart ? (
        <InlineNotice tone="warning">
          환경 설정에서 초기화하는 공급자입니다. 삭제해도 서버 재시작 후 다시 생성될 수 있습니다.
        </InlineNotice>
      ) : null}
      <div className="provider-impact-sections">
        {providerImpactCategories.map(({ key, ...category }) => (
          <ProviderImpactSection
            key={key}
            {...category}
            section={data?.[key]}
            pending={pending || query.isFetching}
            credentialPrefixes={credentialPrefixes}
          />
        ))}
      </div>
      <Checkbox
        label={providerImpactAcknowledgement}
        description="이 확인은 변경의 안전성이나 대체 호출의 성공을 보장하지 않습니다. 다시 조회하면 확인을 새로 해야 합니다."
        disabled={!review.canAcknowledge}
        checked={review.acknowledged}
        onChange={(event) => review.setAcknowledged(event.target.checked)}
      />
    </section>
  );
}
