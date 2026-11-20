import { useRef, type KeyboardEvent } from "react";
import type { DwTimeseriesPoint, dwTimeseriesSchema } from "@/shared/api/domains/data.schemas";
import type { z } from "zod";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { SimpleTable, type SimpleColumn } from "@/features/data/SimpleTable";
import { formatKRW, formatNumber } from "@/shared/utils/format";
import {
  dwBoundsLabel,
  dwPointBounds,
  type DwDateBounds,
  type DwDateSelection,
} from "@/shared/utils/dw-date-bounds";
import { InsightQueryStatus } from "./InsightQueryStatus";
import type { InsightQuery } from "./use-insight-query";
import { dwBucketLabels, dwWindowLabels, type DwBucket, type DwWindow } from "./warehouse-filters";
import "./dw-trend.css";

const columns: readonly SimpleColumn<DwTimeseriesPoint>[] = [
  { id: "day", header: "기간 시작 (UTC)", cell: (row) => row.day },
  {
    id: "requests",
    header: "요청",
    cell: (row) => <span className="cell-number">{formatNumber(row.requests)}</span>,
  },
  {
    id: "tokens",
    header: "토큰",
    cell: (row) => <span className="cell-number">{formatNumber(row.tokens)}</span>,
  },
  {
    id: "cost",
    header: "비용",
    cell: (row) => <span className="cell-number">{formatKRW(row.cost_krw)}</span>,
  },
  {
    id: "errors",
    header: "오류",
    cell: (row) => <span className="cell-number">{formatNumber(row.errors)}</span>,
  },
];

export function DwTrendPanel({
  query,
  bucket,
  range,
  selection,
  onSelect,
}: {
  query: InsightQuery<z.output<typeof dwTimeseriesSchema>>;
  bucket: DwBucket;
  range: DwWindow;
  selection: DwDateSelection;
  onSelect: (bounds: DwDateBounds) => void;
}): React.JSX.Element {
  const track = useRef<HTMLDivElement>(null);
  const points = query.data?.points ?? [];
  const maximum = Math.max(0, ...points.map((point) => point.cost_krw));
  const supported = query.data?.date_bounds_supported === true && !query.isError;
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const buttons = [...(track.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const current = buttons.indexOf(event.currentTarget);
    const next =
      event.key === "ArrowRight"
        ? current + 1
        : event.key === "ArrowLeft"
          ? current - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  };
  return (
    <SectionCard
      title="비용 추이"
      description={`${dwBucketLabels[bucket]} · ${dwWindowLabels[range]} 전체 · UTC 기준`}
    >
      <InsightQueryStatus query={query} label="비용 추이" />
      <p className="dw-trend-help">
        {supported
          ? "막대를 선택하면 아래 차원별 집계와 CSV를 해당 기간으로 좁힙니다. 방향키로 이동하고 Enter로 선택할 수 있습니다."
          : "날짜 선택을 지원하는 서버의 정상 응답이 확인되면 기간별 상세 집계를 사용할 수 있습니다."}
      </p>
      {points.length ? (
        <>
          <div className="dw-trend-scale">
            <span>비용 (원)</span>
            <span>최댓값 {formatKRW(maximum)}</span>
          </div>
          <div className="dw-trend-scroll" ref={track} role="group" aria-label="비용 추이 기간 선택">
            <div className="dw-trend-bars">
              {points.map((point) => {
                const bounds = dwPointBounds(point.day, bucket, query.data?.since ?? "");
                const selected =
                  bounds &&
                  selection.kind === "selected" &&
                  bounds.since_day === selection.bounds.since_day &&
                  bounds.until_day === selection.bounds.until_day;
                const label = bounds ? dwBoundsLabel(bounds) : point.day;
                return (
                  <button
                    key={point.day}
                    type="button"
                    className="dw-trend-point"
                    disabled={!supported || !bounds}
                    aria-label={`${label}, 비용 ${formatKRW(point.cost_krw)}, 요청 ${formatNumber(point.requests)}건`}
                    aria-pressed={Boolean(selected)}
                    title={`${label} · ${formatKRW(point.cost_krw)}`}
                    onKeyDown={(event) => move(event)}
                    onClick={() => {
                      if (bounds) onSelect(bounds);
                    }}
                  >
                    <span className="dw-trend-bar-track" aria-hidden="true">
                      <span
                        className="dw-trend-bar"
                        style={{
                          height: `${maximum > 0 ? Math.max(2, (Math.max(0, point.cost_krw) / maximum) * 100) : 2}%`,
                        }}
                      />
                    </span>
                    <span className="dw-trend-date" aria-hidden="true">
                      {point.day.slice(5)}
                    </span>
                    <span className="dw-trend-selected" aria-hidden="true">
                      {selected ? "선택됨" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
      <details className="dw-trend-data" open={points.length === 0 || undefined}>
        <summary>추이 데이터 표로 보기</summary>
        <SimpleTable
          caption="일자별 요청, 토큰, 비용, 오류"
          loading={query.isPending}
          rows={points}
          emptyMessage="선택한 구간에 집계된 데이터가 없습니다."
          columns={columns}
        />
      </details>
    </SectionCard>
  );
}
