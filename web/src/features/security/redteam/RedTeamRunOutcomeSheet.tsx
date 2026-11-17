import type { RefObject } from "react";
import type { RedTeamRunOutcome } from "@/shared/api/domains/redteam";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { Sheet } from "@/shared/components/ui/Sheet";
import { formatKRW, formatNumber } from "@/shared/utils/format";
import { statusLabel, statusTone, stopReasonLabel } from "./redteam-ui";

export function RedTeamRunOutcomeSheet({
  outcome,
  onClose,
  onOpenRun,
  returnFocusRef,
}: {
  outcome: RedTeamRunOutcome | undefined;
  onClose: () => void;
  onOpenRun: (id: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const stopped = outcome?.status === "stopped" || Boolean(outcome?.stopped);
  return (
    <Sheet
      open={Boolean(outcome)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="캠페인 실행 결과"
      description="실행 상태와 기록된 검사 결과를 확인하세요."
      returnFocusRef={returnFocusRef}
      size="wide"
      scrollLabel="캠페인 실행 결과 내용"
    >
      {outcome ? (
        <div className="rt-stack">
          {stopped ? (
            <InlineNotice tone="warning" title="실행이 중단되었습니다.">
              {stopReasonLabel(outcome.stopped)}. 아직 수행하지 않은 검사는 통과한 것으로 처리하지 않습니다.
              중단된 실행은 통과 기준선을 갱신하지 않습니다. 이미 보낸 호출은 취소되지 않을 수 있으며 비용이
              발생할 수 있습니다. 결과와 실행 이력을 확인한 뒤 캠페인을 다시 검토하세요. 이 화면에서 자동으로
              재실행하지 않습니다.
            </InlineNotice>
          ) : null}
          <KeyValueList
            items={[
              {
                label: "상태",
                value: <Badge tone={statusTone(outcome.status)}>{statusLabel(outcome.status)}</Badge>,
              },
              { label: "대상별 실행", value: formatNumber(outcome.summary.runs) },
              { label: "기록된 검사 결과", value: formatNumber(outcome.summary.results) },
              { label: "치명", value: formatNumber(outcome.summary.critical) },
              { label: "실패", value: formatNumber(outcome.summary.failures) },
              { label: "경고", value: formatNumber(outcome.summary.warnings) },
              { label: "실제 모델 호출 시도", value: `${formatNumber(outcome.summary.live_calls)}건` },
              { label: "기록된 실제 호출 비용", value: formatKRW(outcome.summary.live_cost_krw) },
            ]}
          />
          <p className="rt-note">
            호출 시도에는 게이트웨이가 거부하거나 오류를 반환한 요청도 포함됩니다. 비용은 응답 사용량과 가격
            설정으로 계산하며, 사용량이 없으면 기본 추정치를 사용합니다. 예산은 호출 후 비용을 확인하는 중단
            기준이므로 마지막 호출로 한도를 넘을 수 있습니다.
          </p>
          {outcome.runs.length > 0 ? (
            <section aria-label="대상별 기록된 결과" className="rt-stack">
              <h3>대상별 기록된 결과</h3>
              {outcome.runs.map((run) => (
                <Button
                  key={run.id}
                  onClick={() => {
                    onClose();
                    onOpenRun(run.id);
                  }}
                >
                  {run.target_id || run.id} · {statusLabel(run.status)} · 결과 {formatNumber(run.total_cases)}
                  건 보기
                </Button>
              ))}
            </section>
          ) : (
            <p>저장된 대상별 실행이 없습니다. 실행 이력을 새로 조회해 확인하세요.</p>
          )}
          <details>
            <summary>실행 식별자와 서버 안내</summary>
            <p className="mono">{outcome.campaign_id}</p>
            <p className="rt-note">{outcome.note}</p>
          </details>
        </div>
      ) : null}
    </Sheet>
  );
}
