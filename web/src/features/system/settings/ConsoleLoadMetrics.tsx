import type { UITelemetrySummary } from "@/shared/api/domains/ui-telemetry";
import { formatLoad } from "@/features/system/settings/console-load-format";

export function ConsoleLoadMetrics({ usage }: { usage: UITelemetrySummary }): React.JSX.Element {
  if (!usage.load_metrics_available)
    return <p>이 서버 버전은 화면 표시 시간과 UI 버전 집계를 제공하지 않습니다.</p>;
  const samples = usage.features.reduce((sum, row) => sum + (row.load_samples ?? 0), 0);
  const visits = usage.features.reduce((sum, row) => sum + row.visits, 0);
  const totalMS = usage.features.reduce((sum, row) => sum + (row.load_total_ms ?? 0), 0);
  const maxMS = Math.max(0, ...usage.features.map((row) => row.load_max_ms ?? 0));
  return (
    <section className="settings-tab-stack min-w-0" aria-label="첫 화면 표시 시간과 UI 버전">
      <h3>첫 화면 표시 시간</h3>
      <p>
        측정된 방문 {samples.toLocaleString("ko-KR")} / {visits.toLocaleString("ko-KR")}회 · 평균{" "}
        {formatLoad(samples ? totalMS / samples : undefined)} · 최대 {formatLoad(samples ? maxMS : undefined)}
      </p>
      <p>
        페이지 진입 또는 화면 이동 시작부터 첫 화면을 표시할 때까지의 시간입니다. 모든 데이터 조회의 완료
        시간은 아닙니다. 숨겨진 탭·중단된 이동·2분 초과·전송 실패·구버전 방문은 측정에서 빠질 수 있습니다.
        측정이 없는 방문은 평균에 포함하지 않습니다.
      </p>
      {(usage.versions?.length ?? 0) > 0 ? (
        <div className="data-table-scroll" role="region" aria-label="UI 버전별 사용 관측" tabIndex={0}>
          <table className="data-table">
            <caption className="sr-only">UI 버전별 방문과 첫 화면 표시 시간</caption>
            <thead>
              <tr>
                <th scope="col">UI 버전</th>
                <th scope="col">방문</th>
                <th scope="col">측정된 방문</th>
                <th scope="col">평균 표시 시간</th>
                <th scope="col">최대 표시 시간</th>
              </tr>
            </thead>
            <tbody>
              {usage.versions?.map((row) => (
                <tr key={row.ui_version}>
                  <th scope="row">{row.ui_version || "버전 확인 불가"}</th>
                  <td>{row.visits.toLocaleString("ko-KR")}</td>
                  <td>{row.load_samples.toLocaleString("ko-KR")}</td>
                  <td>{formatLoad(row.load_samples ? row.load_total_ms / row.load_samples : undefined)}</td>
                  <td>{formatLoad(row.load_samples ? row.load_max_ms : undefined)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p>
        방문 수가 많은 버전부터 최대 20개를 표시합니다. 기타 버전 방문{" "}
        {(usage.other_version_visits ?? 0).toLocaleString("ko-KR")}회. 버전 정보가 없거나 사용자 정의 빌드이면
        ‘버전 확인 불가’로 집계합니다.
      </p>
    </section>
  );
}
