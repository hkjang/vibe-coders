import { useId, useState } from "react";
import type { AppRequestSummary } from "@/shared/api/schemas";
import { requestComparisonMetrics } from "./request-comparison-metrics";

export function RequestComparisonResult({
  left,
  right,
  prefixes,
}: {
  left: AppRequestSummary;
  right: AppRequestSummary;
  prefixes: readonly string[];
}): React.JSX.Element {
  const [changedOnly, setChangedOnly] = useState(false);
  const hintId = useId();
  const rows = requestComparisonMetrics(left, right, prefixes);
  // Unavailable values remain visible so a missing comparison cannot look like equality.
  const visible = changedOnly ? rows.filter((row) => row.state !== "same") : rows;
  const changed = rows.filter((row) => row.state === "different").length;
  const unavailable = rows.filter((row) => row.state === "unavailable").length;
  return (
    <div className="request-comparison-result">
      <div className="request-comparison-summary">
        <output aria-live="polite" aria-label="요청 비교 요약">
          다른 항목 {changed}개 · 비교 제외 {unavailable}개
        </output>
        <label>
          <input
            type="checkbox"
            checked={changedOnly}
            onChange={(event) => setChangedOnly(event.currentTarget.checked)}
          />{" "}
          같은 항목 숨기기
        </label>
      </div>
      <p id={hintId}>
        증가·감소는 비교 대상에서 이 요청을 뺀 값입니다. 비용은 기록된 통화가 같을 때만 비교하며 환산하지
        않습니다. 소수 6자리보다 작은 값은 지수 표기로 표시합니다.
      </p>
      {visible.length === 0 ? (
        <p role="status">표시할 차이가 없습니다. 모든 비교 가능한 항목이 같습니다.</p>
      ) : (
        <div className="data-table-scroll" role="region" tabIndex={0} aria-label="요청 비교 표 가로 스크롤">
          <table className="data-table request-comparison-table" aria-describedby={hintId}>
            <caption className="sr-only">두 요청의 운영 지표 비교</caption>
            <thead>
              <tr>
                <th scope="col">항목</th>
                <th scope="col">이 요청</th>
                <th scope="col">비교 대상</th>
                <th scope="col">변화</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td title={row.leftExact}>{row.left}</td>
                  <td
                    title={row.rightExact}
                    className={row.state === "different" ? "request-compare-differs" : undefined}
                  >
                    {row.right}
                    {row.state === "different" ? <span className="sr-only"> (값이 다름)</span> : null}
                  </td>
                  <td>{row.change}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
