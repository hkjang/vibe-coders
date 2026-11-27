import { ChevronRight } from "lucide-react";

import { LineChart } from "@/features/insights/charts/LineChart";
import { workTrendBuckets, type WorkTrendBucket } from "@/shared/api/domains/insights-usage";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useSearchState } from "@/shared/hooks/use-search-state";

import "@/features/observability/observability.css";

import { breakdownColumns, bucketLabel, rowSelectable } from "../category-format";
import { breakdownEmpty, breakdownRows, breakdownWithheld, type BreakdownRow } from "../category-view";
import { breadcrumb, categoryNames, childLevelName } from "../drill-path";
import {
  CategoryBars,
  CategoryBubbles,
  CategoryDonut,
  CategoryTreemap,
  TrendArea,
} from "../panels/CategoryPanels";
import { useCategories, useTrend } from "../use-usage-queries";
import { useUsageNav } from "../use-usage-nav";
import { defaultBucket, oneOf, optionsQuery, safeCategoryId } from "../usage-filters";
import { failedExplanation, unclassifiedExplanation } from "../usage-labels";
import {
  formatMetric,
  formatMetricCompact,
  metricLabels,
  metricValue,
  suppressedHint,
  suppressedLabel,
} from "../usage-metrics";
import type { UsageTabProps } from "../usage-tab-props";
import { CategoryLabel, Panel, PlainTable, type PlainColumn } from "../usage-ui";

const topCount = 10;
const bucketNames: Readonly<Record<WorkTrendBucket, string>> = { day: "일간", week: "주간" };

/**
 * 대분류 → 중분류 → 소분류. `parent` in the URL is the category whose children
 * are on screen; a row with children drills in, a leaf opens its sessions.
 */
export function CategoriesTab({ filters, query, range, minGroupSize }: UsageTabProps): React.JSX.Element {
  const [params, update] = useSearchState();
  const nav = useUsageNav();
  const { metric } = filters;
  const parent = safeCategoryId(params.get("parent"));
  const bucket = oneOf(params.get("bucket"), workTrendBuckets, defaultBucket(range));

  const categories = useCategories(query, parent);
  // Names of the steps above the current one come from the lists the filter bar already loaded.
  const topLevel = useCategories(optionsQuery(range), "");
  const trend = useTrend(parent ? { ...query, category: parent } : query, bucket);

  const names = categoryNames(
    topLevel.data?.rows.map((row) => row.category),
    [categories.data?.parent],
    categories.data?.rows.map((row) => row.category),
  );
  const crumbs = breadcrumb(parent, names);
  const here = crumbs.at(-1)?.label ?? "전체 업무";
  const level = childLevelName(parent);
  const select = (rows: readonly BreakdownRow[], id: string): void => {
    const row = rows.find((item) => item.id === id);
    if (row && rowSelectable(row)) nav.selectCategory({ id, hasChildren: row.hasChildren });
  };

  return (
    <div className="wi-stack">
      <nav className="wi-breadcrumb" aria-label="업무 분류 단계">
        <ol>
          {crumbs.map((crumb, index) => (
            <li key={crumb.id || "root"}>
              {index > 0 ? <ChevronRight aria-hidden="true" /> : null}
              {index === crumbs.length - 1 ? (
                <span aria-current="page">{crumb.label}</span>
              ) : (
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => nav.go({ parent: crumb.id || undefined })}
                >
                  {crumb.label}
                </Button>
              )}
            </li>
          ))}
        </ol>
        <span className="wi-breadcrumb-level">
          {here}의 {level}
        </span>
      </nav>

      <Panel
        query={categories}
        label={`${here} ${level}`}
        isEmpty={breakdownEmpty}
        emptyHint={parent ? "이 분류에는 기간 안에 집계된 하위 업무가 없습니다." : undefined}
        withheld={{ when: breakdownWithheld, minGroupSize }}
      >
        {(data) => {
          const rows = breakdownRows(data, metric);
          const total = metricValue(data.total, metric);
          const onSelect = (id: string): void => select(rows, id);
          const columns: PlainColumn<BreakdownRow>[] = [
            {
              id: "name",
              header: level,
              cell: (row) =>
                rowSelectable(row) ? (
                  <Button
                    size="small"
                    variant="ghost"
                    className="wi-row-button"
                    aria-label={`${row.label} ${row.hasChildren ? "하위 분류 보기" : row.kind === "category" ? "세션 보기" : "요청 보기"}`}
                    onClick={() => onSelect(row.id)}
                  >
                    <CategoryLabel name={row.label} paint={row.paint} />
                    <ChevronRight aria-hidden="true" />
                  </Button>
                ) : (
                  <CategoryLabel name={row.label} paint={row.paint} />
                ),
            },
            ...breakdownColumns(metric, filters.compare).map((column): PlainColumn<BreakdownRow> => ({
              id: column.id,
              header: column.header,
              help: column.help,
              numeric: true,
              cell: (row) => {
                const text = column.value(row);
                return text === suppressedLabel ? (
                  <span className="wi-suppressed" title={suppressedHint(minGroupSize)}>
                    {text}
                  </span>
                ) : (
                  text
                );
              },
            })),
          ];
          return (
            <div className="wi-stack">
              <SectionCard
                title={`${level}별 비중`}
                description={`${here}의 ${metricLabels[metric]}가 ${level}에 어떻게 나뉘는지입니다. 조각·타일·범례를 누르면 한 단계 들어갑니다.`}
              >
                <div className="wi-two-up">
                  <CategoryDonut
                    rows={rows}
                    metric={metric}
                    total={total}
                    caption={`${here} ${level}별 ${metricLabels[metric]} 비중`}
                    onSelect={onSelect}
                  />
                  <CategoryTreemap
                    rows={rows}
                    metric={metric}
                    caption={`${here} ${level}별 ${metricLabels[metric]} 트리맵`}
                    onSelect={onSelect}
                  />
                </div>
                <p className="wi-note">
                  {unclassifiedExplanation} {failedExplanation}
                </p>
              </SectionCard>

              <SectionCard
                title={`${level} TOP ${topCount}`}
                description={`${metricLabels[metric]} 기준 상위 항목과 직전 기간 대비 증감입니다.`}
              >
                <CategoryBars
                  rows={rows}
                  metric={metric}
                  compare={filters.compare}
                  limit={topCount}
                  caption={`${here} ${level} 상위 ${topCount}`}
                  onSelect={onSelect}
                />
              </SectionCard>

              <SectionCard
                title="사용량 · 비용 · 사용자"
                description="가로는 사용량, 세로는 비용, 원의 넓이는 활성 사용자입니다. 오른쪽 위일수록 많이 쓰고 비용도 큰 업무입니다."
              >
                <CategoryBubbles
                  rows={rows}
                  metric={metric}
                  caption={`${here} ${level}별 사용량과 비용`}
                  onSelect={onSelect}
                />
              </SectionCard>

              <SectionCard
                title={`${level} 표`}
                description="행을 누르면 하위 분류나 세션 목록으로 이동합니다."
              >
                <PlainTable
                  caption={`${here} ${level} 목록`}
                  columns={columns}
                  rows={rows}
                  rowKey={(row) => row.id}
                  rowClassName={(row) => (row.kind === "category" ? undefined : "wi-row-special")}
                  wide
                />
                <p className="wi-note">
                  활성 사용자가 {minGroupSize}명 미만인 행과, 다른 행에서 빼서 그런 값을 알아낼 수 있는 행은
                  값을 ‘{suppressedLabel}’으로 가립니다.
                </p>
              </SectionCard>
            </div>
          );
        }}
      </Panel>

      <SectionCard
        title="증감 추이"
        description={`${here}의 ${level}별 ${metricLabels[metric]} 추이와 전체 합계입니다.`}
        actions={
          <div className="range-picker" role="group" aria-label="추이 집계 단위">
            {workTrendBuckets.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={bucket === item}
                onClick={() => update({ bucket: item === defaultBucket(range) ? undefined : item })}
              >
                {bucketNames[item]}
              </button>
            ))}
          </div>
        }
      >
        <Panel
          query={trend}
          label="증감 추이"
          isEmpty={(data) => data.buckets.length === 0}
          withheld={{ when: (data) => data.suppressed, minGroupSize }}
        >
          {(data) => (
            <div className="wi-stack">
              <TrendArea
                data={data}
                metric={metric}
                caption={`${here} ${level}별 ${metricLabels[metric]} 추이`}
                onSelect={(id) => {
                  const row = categories.data?.rows.find((item) => item.category.id === id);
                  nav.selectCategory({ id, hasChildren: row?.has_children ?? false });
                }}
              />
              <h3 className="wi-subheading">전체 합계 추이</h3>
              <LineChart
                caption={`${here} ${metricLabels[metric]} 합계 추이`}
                buckets={data.buckets}
                values={data.total}
                valueHeader={metricLabels[metric]}
                colorVar="--obs-series-1"
                format={(value) => formatMetric(value, metric)}
                formatAxis={(value) =>
                  value >= 10_000 ? formatMetricCompact(value, metric) : formatMetric(value, metric)
                }
                bucketLabel={bucketLabel}
                withheldLabel={suppressedLabel}
              />
            </div>
          )}
        </Panel>
      </SectionCard>
    </div>
  );
}
