import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import type { PromptTestCaseRun } from "@/shared/api/domains/gateway.schemas";
import { formatKRW, formatNumber } from "@/shared/utils/format";
const verdictLabels: Readonly<Record<string, string>> = {
  pass: "합격",
  warn: "주의",
  fail: "불합격",
};

/**
 * Score card of the latest test-case run. The server returns judgements and contract
 * verdicts only, so no answer text reaches this screen.
 */
export function TestCaseRunResult({
  name,
  result,
}: {
  name: string;
  result: PromptTestCaseRun;
}): React.JSX.Element {
  return (
    <div className="gateway-run-result">
      <InlineNotice
        tone={result.results.some((row) => row.status !== "ok") ? "warning" : "info"}
        title={`${name} 실행 결과`}
      >
        {`최고 점수 모델 ${result.best_model || "미확인"} · 평균 점수 ${formatNumber(result.avg_score, 1)} · 모델 ${formatNumber(result.model_count)}개`}
        {result.contract_applied
          ? ` · 출력 계약 통과 ${formatNumber(result.contract_pass)}개`
          : result.contract_applied === false
            ? " · 출력 계약 미적용"
            : " · 출력 계약 적용 여부 미확인"}
      </InlineNotice>
      {result.results.length === 0 ? null : (
        <div className="data-table-scroll" tabIndex={0} aria-label="테스트 케이스 실행 결과 표 영역">
          <table className="data-table">
            <caption className="sr-only">{`${name} 테스트 케이스 실행의 모델별 점수`}</caption>
            <thead>
              <tr>
                <th scope="col">모델</th>
                <th scope="col">점수</th>
                <th scope="col">판정</th>
                <th scope="col">출력 계약</th>
                <th scope="col">비용</th>
                <th scope="col">지연</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((row, index) => (
                <tr key={`${row.model ?? "model"}-${index}`}>
                  <td className="mono">{row.model || "-"}</td>
                  <td className="cell-number">{formatNumber(row.score, 1)}</td>
                  <td>
                    {row.status !== "ok"
                      ? "실행 실패 또는 상태 미확인"
                      : (verdictLabels[row.verdict ?? ""] ?? "미확인")}
                  </td>
                  <td>
                    {row.contract_pass === null || row.contract_pass === undefined
                      ? result.contract_applied === false
                        ? "미적용"
                        : "미확인"
                      : row.contract_pass
                        ? "통과"
                        : `위반 ${formatNumber(row.contract_errors?.length ?? 0)}건`}
                  </td>
                  <td className="cell-number">{formatKRW(row.cost_krw)}</td>
                  <td className="cell-number">{formatNumber(row.latency_ms)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
