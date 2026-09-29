import { useQuery } from "@tanstack/react-query";

import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { FormField } from "@/shared/components/form/FormField";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { useSearchState } from "@/shared/hooks/use-search-state";

const featureTitles = new Map(migrationRegistry.map((feature) => [feature.featureId, feature.title]));
const percentage = new Intl.NumberFormat("ko-KR", { style: "percent", maximumFractionDigits: 1 });

/** Observed feature visits, never unique users or proof of Stable readiness. */
export function ConsoleUsagePanel(): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const days = params.get("telemetry_days") === "30" ? 30 : 7;
  const usage = useQuery({
    queryKey: ["ui-telemetry", "summary", days],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.uiTelemetry.summary, {
        query: { days },
        signal,
        routeId: "system.settings",
        referrerPolicy: "no-referrer",
      }),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const rows = (usage.data?.features ?? []).filter((row) => row.visits > 0);
  const total = rows.reduce((sum, row) => sum + row.visits, 0);
  const legacy = rows.reduce((sum, row) => sum + row.legacy_opens, 0);
  return (
    <SectionCard
      title="신규 콘솔 사용 관측"
      headingLevel={2}
      description="관측된 기능 방문 중 기존 화면 링크를 한 번 이상 연 방문의 비율입니다."
    >
      <div className="toolbar">
        <FormField label="조회 기간">
          {(control) => (
            <Select
              {...control}
              value={days}
              onChange={(event) => updateSearch({ telemetry_days: event.target.value })}
            >
              <option value={7}>최근 7일</option>
              <option value={30}>최근 30일</option>
            </Select>
          )}
        </FormField>
        <Button
          variant="secondary"
          onClick={() => {
            if (!usage.isFetching) void usage.refetch();
          }}
          aria-disabled={usage.isFetching}
          aria-busy={usage.isFetching}
        >
          관측 결과 새로고침
        </Button>
      </div>
      <p>
        수집은 기본 꺼짐입니다. 전체 설정의 ‘콘솔 사용 관측’을 켠 환경에서만 기록합니다. 방문별 임시 식별값의
        해시와 기능·시각·이동 여부만 최근 30일, 최대 10만 방문까지 집계합니다. 만료 기록은 서버 시작 시와
        매시간 정리합니다. 사용자·팀·IP·검색어·프롬프트는 이 집계에 저장하지 않습니다.
      </p>
      {usage.isError ? (
        <InlineNotice tone="warning" title="사용 관측을 불러오지 못했습니다.">
          전환 설정은 계속 사용할 수 있습니다. 새로고침으로 다시 확인하세요.
          {isAppError(usage.error) && usage.error.requestId ? (
            <span> 요청 ID: {usage.error.requestId}</span>
          ) : null}
        </InlineNotice>
      ) : null}
      {usage.isPending ? <p role="status">사용 관측을 불러오는 중입니다.</p> : null}
      {usage.data ? (
        <>
          <p role="status">
            수집 {usage.data.enabled ? "켜짐" : "꺼짐"} · 관측된 방문 {total.toLocaleString("ko-KR")}회 · 기존
            화면 이동 {legacy.toLocaleString("ko-KR")}회
            {total > 0 ? ` (${percentage.format(legacy / total)})` : " (비율 산정 불가)"}
          </p>
          {!usage.data.enabled ? (
            <p>현재 수집을 중지했습니다. 아래에는 보존 기간 안의 기존 기록만 표시합니다.</p>
          ) : null}
          {rows.length === 0 ? (
            <p>이 기간에 관측된 방문이 없습니다. 수집 설정과 실제 기능 방문 여부를 확인하세요.</p>
          ) : (
            <div className="data-table-scroll" role="region" aria-label="기능별 사용 관측" tabIndex={0}>
              <table className="data-table">
                <caption className="sr-only">최근 {days}일 동안 관측된 기능 방문과 기존 화면 이동</caption>
                <thead>
                  <tr>
                    <th scope="col">기능</th>
                    <th scope="col">방문</th>
                    <th scope="col">기존 화면 이동</th>
                    <th scope="col">이동 비율</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.feature_id}>
                      <th scope="row">{featureTitles.get(row.feature_id) ?? row.feature_id}</th>
                      <td>{row.visits.toLocaleString("ko-KR")}</td>
                      <td>{row.legacy_opens.toLocaleString("ko-KR")}</td>
                      <td>{percentage.format(row.legacy_opens / row.visits)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p>
            <time dateTime={usage.data.from}>{new Date(usage.data.from).toLocaleString("ko-KR")}</time> ~{" "}
            <time dateTime={usage.data.to}>{new Date(usage.data.to).toLocaleString("ko-KR")}</time>
          </p>
        </>
      ) : null}
      <p>
        순사용자 수나 전체 채택률이 아닙니다. 전송 실패·수집 상한·비활성 기간은 집계에서 빠질 수 있으며,
        로그인·최상위 오류 화면은 대상이 아닙니다. 기존 화면 도착을 보장하지 않고 링크 열기만 관측합니다. 정식
        기능 승격에는 별도의 권한·업무 흐름·안정성 검증이 필요합니다.
      </p>
    </SectionCard>
  );
}
