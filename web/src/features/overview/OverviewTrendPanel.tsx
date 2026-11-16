import { useOverviewQuery } from "./use-overview-query";

import { OverviewTrendData } from "./OverviewTrendData";
import { trendWindows, type TrendWindow } from "./overview-trend";
import { refreshIntervalMs } from "@/features/health/health-utils";
import { OverviewQueryFeedback } from "@/features/overview/OverviewQueryFeedback";
import { overviewReadDenied } from "@/features/overview/overview-query-state";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { usePreferences } from "@/shared/stores/preferences";
import { formatNumber } from "@/shared/utils/format";
import "@/features/observability/observability.css";

const routeId = "overview";

const windowIds = trendWindows.map((window) => window.id);

const weekdayLabels = ["일", "월", "화", "수", "목", "금", "토"];

/** The busiest cell sets the scale, so an all-quiet week does not paint itself red. */
function heatLevel(requests: number, peak: number): number {
  if (peak <= 0 || requests <= 0) return 0;
  return Math.min(4, Math.ceil((requests / peak) * 4));
}

/**
 * The dashboard's two charts: totals over time and the weekday/hour activity heatmap
 * (KST), both of which the legacy console drew and the new overview was missing.
 */
export function OverviewTrendPanel(): React.JSX.Element {
  const interval = refreshIntervalMs(usePreferences((state) => state.refreshInterval));
  const [range, setRange] = useTabParam<TrendWindow>(windowIds, "7d", "trend");
  const selected = trendWindows.find((item) => item.id === range) ?? trendWindows[2];

  const timeseries = useOverviewQuery({
    interval,
    key: ["timeseries", selected.id],
    read: (signal) =>
      apiClient.request(endpoints.admin.timeseries, {
        query: { window: selected.id, bucket: selected.bucket },
        routeId,
        signal,
      }),
  });
  const heatmap = useOverviewQuery({
    interval,
    key: ["heatmap", selected.heatmap],
    read: (signal) =>
      apiClient.request(endpoints.admin.heatmap, {
        query: { window: selected.heatmap },
        routeId,
        signal,
      }),
  });

  const cells = heatmap.data?.cells ?? [];
  const peak = Math.max(0, ...cells.map((cell) => cell.requests));
  const byCell = new Map(cells.map((cell) => [`${cell.day}-${cell.hour}`, cell.requests]));

  return (
    <>
      <SectionCard
        title="사용 추이"
        aria-label="사용 추이"
        description="보존된 요청 로그를 기간별로 집계한 요청 수와 비용입니다."
        actions={
          <div className="range-picker" role="group" aria-label="추이 기간">
            {trendWindows.map((item) => (
              <Button
                key={item.id}
                size="small"
                variant={item.id === range ? "primary" : "secondary"}
                aria-pressed={item.id === range}
                onClick={() => setRange(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        }
      >
        <OverviewQueryFeedback
          label="사용 추이"
          error={timeseries.error}
          fetching={timeseries.isFetching}
          updatedAt={timeseries.dataUpdatedAt}
          retry={() => void timeseries.refetch()}
        />
        {timeseries.isPending ? (
          <p className="obs-meta" role="status">
            추이를 불러오는 중입니다.
          </p>
        ) : timeseries.data && !overviewReadDenied(timeseries.error) ? (
          <OverviewTrendData
            key={range}
            data={timeseries.data}
            label={selected.label}
            range={range}
            isDataCurrent={timeseries.isDataCurrent}
          />
        ) : null}
      </SectionCard>

      <SectionCard
        title="요일·시간대 활동"
        description="한국 시간 기준으로 요청이 몰리는 시간대입니다."
        actions={<Badge tone="muted">{selected.heatmap === "30d" ? "최근 30일" : "최근 7일"}</Badge>}
      >
        <OverviewQueryFeedback
          label="활동 분포"
          error={heatmap.error}
          fetching={heatmap.isFetching}
          updatedAt={heatmap.dataUpdatedAt}
          retry={() => void heatmap.refetch()}
        />
        {heatmap.isPending ? (
          <p className="obs-meta" role="status">
            활동 분포를 불러오는 중입니다.
          </p>
        ) : !heatmap.data || overviewReadDenied(heatmap.error) ? null : peak === 0 ? (
          <p className="obs-meta">이 기간에 기록된 요청이 없습니다.</p>
        ) : (
          <div className="overview-heatmap-scroll" tabIndex={0} aria-label="요일·시간대 활동 표 영역">
            <table className="overview-heatmap">
              <caption className="sr-only">요일과 시간대별 요청 수 (KST)</caption>
              <thead>
                <tr>
                  <th scope="col">요일</th>
                  {Array.from({ length: 24 }, (_, hour) => (
                    <th key={hour} scope="col">
                      {hour}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weekdayLabels.map((label, day) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    {Array.from({ length: 24 }, (_, hour) => {
                      const requests = byCell.get(`${day}-${hour}`) ?? 0;
                      return (
                        <td
                          key={hour}
                          className={`overview-heat-cell overview-heat-${heatLevel(requests, peak)}`}
                          title={`${label}요일 ${hour}시 · ${formatNumber(requests)}건`}
                        >
                          <span className="sr-only">{`${label}요일 ${hour}시 ${formatNumber(requests)}건`}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
