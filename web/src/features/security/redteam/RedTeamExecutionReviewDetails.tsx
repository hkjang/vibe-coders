import type { ReviewedRedTeamRun } from "@/shared/api/domains/redteam-reviewed";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { formatNumber, formatKRW, formatDateTime } from "@/shared/utils/format";
export function RedTeamExecutionReviewDetails({ review }: { review: ReviewedRedTeamRun }): React.JSX.Element {
  return (
    <div className="rt-stack">
      <KeyValueList
        items={[
          {
            label: "실행 방식",
            value:
              review.kind === "live" ? "실제 호출 + 지원하지 않는 대상의 시뮬레이션" : "시뮬레이션만 실행",
          },
          { label: "캠페인", value: review.campaign_name },
          { label: "실행 사유", value: review.reason },
          { label: "예정 검사", value: `${formatNumber(review.case_executions)}건` },
          {
            label: "실제 모델 호출",
            value: `${formatNumber(review.planned_live_calls)}건 / 상한 ${review.limits.max_calls}건`,
          },
          { label: "호출당 출력 토큰 요청 상한", value: formatNumber(review.limits.max_output_tokens) },
          { label: "출력 토큰 요청 상한 합계", value: formatNumber(review.requested_output_tokens) },
          { label: "등록된 입력 크기 합계", value: `${formatNumber(review.registered_input_bytes)}바이트` },
          { label: "예상 비용", value: formatKRW(review.estimated_cost_krw) },
          { label: "비용 중단 기준", value: formatKRW(review.limits.budget_limit_krw) },
          { label: "전체 실행 제한 시간", value: `${formatNumber(review.timeout_ms / 1000)}초 · 순차 실행` },
          { label: "검토 만료", value: formatDateTime(review.expires_at) },
        ]}
      />
      <section aria-label="검토한 실행 대상" className="rt-stack">
        <h3>검토한 실행 대상</h3>
        {review.targets.map((target) => (
          <div key={target.id} className="rt-fieldset">
            <strong>{target.target_ref}</strong>
            <p>
              제공자: {target.provider || "해당 없음"} · 실제 호출 {target.live_calls}건 · 검사{" "}
              {target.case_executions}건
            </p>
            {target.models.length ? (
              <ul>
                {target.models.map((model) => (
                  <li key={model}>
                    <code>{model}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>시뮬레이션 대상</p>
            )}
          </div>
        ))}
      </section>
      {review.retain_raw_evidence ? (
        <InlineNotice tone="warning" title="원문 증적을 보관합니다.">
          캠페인 설정에 따라 마스킹하지 않은 입력과 응답이 저장될 수 있습니다.
        </InlineNotice>
      ) : (
        <p className="rt-note">증적은 마스킹해 보관합니다.</p>
      )}
      <p className="rt-note">
        비용은 호출 후 확인하므로 마지막 호출로 중단 기준을 넘을 수 있습니다. 출력 토큰은 제공자에 보내는 요청
        상한이며 실제 과금 한도를 보장하지 않습니다. 게이트웨이 내부 재시도와 확장된 입력은 위 호출·입력
        합계에 포함되지 않습니다.
      </p>
      <p className="rt-note">
        이 검토는 응답한 서버에서 5분 동안 한 번만 사용합니다. 다른 서버나 재시작 후에는 다시 검토해야 합니다.
        현재 라우팅·권한·보안 정책은 실행 때 적용되며, 다른 서버·예약·기존 관리자 실행과의 중복을 전역
        차단하지 않습니다.
      </p>
    </div>
  );
}
