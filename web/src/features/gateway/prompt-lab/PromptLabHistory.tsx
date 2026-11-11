import type { PromptTestCase } from "@/shared/api/domains/gateway.schemas";
import { Sheet } from "@/shared/components/ui/Sheet";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { LoadingState } from "@/shared/components/state/PageStates";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatNumber, formatKRW } from "@/shared/utils/format";
import { usePromptCaseHistory } from "./use-prompt-lab";
import type { PromptLabController } from "./use-prompt-lab-controller";

export function PromptLabHistory({ lab, target }: { lab: PromptLabController; target: PromptTestCase }) {
  const query = usePromptCaseHistory(lab.owner, lab.selectedExperiment, target.id);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) lab.setHistoryCase(undefined);
      }}
      returnFocusRef={lab.returnFocusRef}
      title="테스트 케이스 실행 이력"
      size="wide"
      description={`${target.name} · 최근 실행 기록 최대 30건`}
      footer={
        <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
          이력 새로고침
        </Button>
      }
    >
      <div className="page-stack">
        <InlineNotice title="기록 확인 안내">
          기록 저장에 실패한 실행은 이 목록에 없을 수 있습니다. 응답이 끊긴 경우 호출·감사 기록도 확인한 뒤
          다시 실행하세요.
        </InlineNotice>
        {query.isFetching && !query.isPending ? <p role="status">최신 이력을 확인하는 중입니다.</p> : null}
        {query.isPending ? (
          <LoadingState label="실행 이력을 불러오는 중입니다." />
        ) : query.isError ? (
          <InlineNotice tone="danger" title="실행 이력을 불러오지 못했습니다.">
            {safeAppErrorMessage(query.error, "실행 이력을 확인할 수 없습니다.")}
            {isAppError(query.error) && query.error.requestId ? (
              <p>요청 ID: {query.error.requestId}</p>
            ) : null}
          </InlineNotice>
        ) : query.data.history.length === 0 ? (
          <EmptyState
            title="저장된 실행 이력이 없습니다."
            description="테스트 케이스를 실행한 후 기록을 확인하세요."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="실행 이력 표 영역">
            <table className="data-table lab-history-table">
              <caption className="sr-only">테스트 케이스 실행 기록</caption>
              <thead>
                <tr>
                  {[
                    "실행 시각",
                    "실행 ID",
                    "최고 점수 모델",
                    "평균 점수",
                    "모델 수",
                    "계약 통과 수",
                    "평균 비용 (원)",
                    "평균 지연 (ms)",
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {query.data.history.map((row, index) => (
                  <tr key={`${row.id ?? row.run_id}:${index}`}>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td>{row.run_id || "미확인"}</td>
                    <td>{row.best_model || "미확인"}</td>
                    <td>{formatNumber(row.avg_score, 2)}</td>
                    <td>{formatNumber(row.model_count)}</td>
                    <td>{formatNumber(row.contract_pass)}</td>
                    <td>{formatKRW(row.avg_cost_krw)}</td>
                    <td>{formatNumber(row.avg_latency_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Sheet>
  );
}
