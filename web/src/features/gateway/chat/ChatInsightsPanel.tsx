import { safeModelLabel } from "@/features/gateway/chat/chat-console";
import { useCodeVerifyStats, useJudgeLeaderboard } from "@/features/gateway/chat/use-chat-console";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatNumber } from "@/shared/utils/format";

export function ChatInsightsPanel(): React.JSX.Element {
  const leaderboard = useJudgeLeaderboard(true);
  const codeStats = useCodeVerifyStats(true);

  return (
    <div className="page-stack">
      <SectionCard
        title="모델 리더보드"
        description="저장된 자동 평가 결과 기준입니다. 승리 횟수는 해당 실행에서 최고 점수를 받은 횟수입니다."
        actions={
          <Button size="small" variant="ghost" onClick={() => void leaderboard.refetch()}>
            새로고침
          </Button>
        }
      >
        {leaderboard.isError ? (
          <InlineNotice tone="warning" title="리더보드를 불러오지 못했습니다.">
            {safeAppErrorMessage(leaderboard.error, "권한 또는 네트워크 상태를 확인하세요.")}
          </InlineNotice>
        ) : (leaderboard.data?.leaderboard.length ?? 0) === 0 ? (
          <EmptyState
            title="집계된 평가 결과가 없습니다."
            description="멀티 모델 비교에서 자동 평가를 실행하면 모델별 순위가 쌓입니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="모델 리더보드 표 영역">
            <table className="data-table">
              <caption className="sr-only">자동 평가 기반 모델 리더보드</caption>
              <thead>
                <tr>
                  <th scope="col">모델</th>
                  <th scope="col">평가 횟수</th>
                  <th scope="col">평균 점수</th>
                  <th scope="col">합격률</th>
                  <th scope="col">승리</th>
                </tr>
              </thead>
              <tbody>
                {(leaderboard.data?.leaderboard ?? []).map((row) => (
                  <tr key={row.model}>
                    <td>{safeModelLabel(row.model)}</td>
                    <td className="cell-number">{formatNumber(row.appearances ?? 0)}</td>
                    <td className="cell-number">{formatNumber(row.avg_score ?? 0, 1)}</td>
                    <td className="cell-number">{formatNumber(row.pass_rate ?? 0, 1)}%</td>
                    <td className="cell-number">{formatNumber(row.wins ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="코드 위험 리더보드"
        description="응답에 포함된 코드의 검증 결과를 모델별로 집계합니다. 코드 원문은 저장하지 않습니다."
        actions={
          <Button size="small" variant="ghost" onClick={() => void codeStats.refetch()}>
            새로고침
          </Button>
        }
      >
        {codeStats.isError ? (
          <InlineNotice tone="warning" title="코드 검증 통계를 불러오지 못했습니다.">
            {safeAppErrorMessage(codeStats.error, "권한 또는 네트워크 상태를 확인하세요.")}
          </InlineNotice>
        ) : (codeStats.data?.models ?? []).length === 0 ? (
          <EmptyState
            title="집계된 코드 검증 결과가 없습니다."
            description="응답 텍스트 캡처가 켜진 요청에서 코드가 검출되면 여기에 쌓입니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="코드 위험 리더보드 표 영역">
            <table className="data-table">
              <caption className="sr-only">모델별 코드 검증 위험도</caption>
              <thead>
                <tr>
                  <th scope="col">모델</th>
                  <th scope="col">검증 수</th>
                  <th scope="col">높음</th>
                  <th scope="col">보통</th>
                  <th scope="col">비밀값 검출</th>
                </tr>
              </thead>
              <tbody>
                {(codeStats.data?.models ?? []).map((row, index) => (
                  <tr key={`${row.model ?? "model"}-${index}`}>
                    <td>{safeModelLabel(row.model)}</td>
                    <td className="cell-number">{formatNumber(row.verdicts ?? 0)}</td>
                    <td className="cell-number">{formatNumber(row.risk_high ?? 0)}</td>
                    <td className="cell-number">{formatNumber(row.risk_medium ?? 0)}</td>
                    <td className="cell-number">{formatNumber(row.secret_findings ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
