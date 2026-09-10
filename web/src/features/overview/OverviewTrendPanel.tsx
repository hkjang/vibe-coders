import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { TimeSeriesChart, type ChartSeries } from "@/features/observability/charts";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatKRW, formatNumber } from "@/shared/utils/format";
import "@/features/observability/observability.css";

const routeId = "overview";

const windows = [
  { id: "24h", label: "최근 24시간", bucket: "hour", heatmap: "7d" },
  { id: "7d", label: "최근 7일", bucket: "day", heatmap: "7d" },
  { id: "30d", label: "최근 30일", bucket: "day", heatmap: "30d" },
] as const;
type WindowId = (typeof windows)[number]["id"];

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
  const [range, setRange] = useState<WindowId>("7d");
  const selected = windows.find((item) => item.id === range) ?? windows[1];

  const timeseries = useQuery({
    queryKey: ["overview", "timeseries", selected.id],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.timeseries, {
        query: { window: selected.id, bucket: selected.bucket },
        routeId,
        signal,
      }),
  });
  const heatmap = useQuery({
    queryKey: ["overview", "heatmap", selected.heatmap],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.heatmap, {
        query: { window: selected.heatmap },
        routeId,
        signal,
      }),
  });

  const points = timeseries.data?.points ?? [];
  const series: ChartSeries[] = [
    {
      id: "requests",
      name: "요청",
      colorVar: "--obs-series-1",
      points: points.map((point) => ({ label: point.date, value: point.requests })),
    },
  ];
  const costSeries: ChartSeries[] = [
    {
      id: "cost",
      name: "비용",
      colorVar: "--obs-series-2",
      points: points.map((point) => ({ label: point.date, value: point.cost_krw })),
    },
  ];

  const cells = heatmap.data?.cells ?? [];
  const peak = Math.max(0, ...cells.map((cell) => cell.requests));
  const byCell = new Map(cells.map((cell) => [`${cell.day}-${cell.hour}`, cell.requests]));

  return (
    <>
      <SectionCard
        title="사용 추이"
        description="보존된 요청 로그를 기간별로 집계한 요청 수와 비용입니다."
        actions={
          <div className="range-picker" role="group" aria-label="추이 기간">
            {windows.map((item) => (
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
        {timeseries.isError ? (
          <InlineNotice tone="warning" title="사용 추이를 불러오지 못했습니다.">
            잠시 후 다시 시도해 주세요.
          </InlineNotice>
        ) : timeseries.isPending ? (
          <p className="obs-meta" role="status">
            추이를 불러오는 중입니다.
          </p>
        ) : (
          <>
            <TimeSeriesChart
              caption={`${selected.label} 요청 수`}
              series={series}
              valueLabel="요청"
              format={(value) => formatNumber(value)}
            />
            <TimeSeriesChart
              caption={`${selected.label} 비용`}
              series={costSeries}
              valueLabel="비용"
              format={(value) => formatKRW(value)}
            />
          </>
        )}
      </SectionCard>

      <SectionCard
        title="요일·시간대 활동"
        description="한국 시간 기준으로 요청이 몰리는 시간대입니다."
        actions={<Badge tone="muted">{selected.heatmap === "30d" ? "최근 30일" : "최근 7일"}</Badge>}
      >
        {heatmap.isError ? (
          <InlineNotice tone="warning" title="활동 분포를 불러오지 못했습니다.">
            잠시 후 다시 시도해 주세요.
          </InlineNotice>
        ) : heatmap.isPending ? (
          <p className="obs-meta" role="status">
            활동 분포를 불러오는 중입니다.
          </p>
        ) : peak === 0 ? (
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
