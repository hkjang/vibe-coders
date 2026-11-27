import { ArrowRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { categoryPaint, restId } from "@/features/insights/charts/palette";
import { RankedBars } from "@/features/insights/charts/RankedBars";
import type { WorkInsight, WorkOverview, WorkOverviewMetrics } from "@/shared/api/domains/insights-usage";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatGrid } from "@/shared/components/ui/StatCard";
import { formatNumber, formatPercent } from "@/shared/utils/format";

import { breakdownEmpty, breakdownRows, breakdownWithheld } from "../category-view";
import { AutomationTable } from "../panels/AutomationPanel";
import { CategoryDonut, TrendArea } from "../panels/CategoryPanels";
import { InsightList } from "../panels/InsightList";
import { MatrixPanel } from "../panels/MatrixPanel";
import { ModelTable } from "../panels/ModelTable";
import { SignalList } from "../panels/SignalList";
import {
  useAutomation,
  useCategories,
  useInsights,
  useMatrix,
  useModels,
  useTrend,
  useTrendSignals,
  type UsageRead,
} from "../use-usage-queries";
import { sessionsUpdates, useUsageNav } from "../use-usage-nav";
import { defaultBucket } from "../usage-filters";
import {
  automationDisclaimer,
  classificationLabel,
  failedExplanation,
  methodLabel,
  qualityWithheldNote,
  unclassifiedExplanation,
} from "../usage-labels";
import {
  changeRate,
  formatChange,
  formatPointChange,
  metricLabels,
  metricValue,
  suppressedLabel,
} from "../usage-metrics";
import type { UsageTabProps } from "../usage-tab-props";
import { KpiTile, Panel, Suppressed } from "../usage-ui";

const risingKinds = ["new", "rising_7d", "rising_30d"];
const summarySignals = 6;
const summaryCandidates = 5;
const summaryModels = 8;
const summaryInsights = 6;

interface SummaryTabProps extends UsageTabProps {
  overview: UsageRead<WorkOverview>;
}

/** Link in a section header to the tab that shows the whole picture. */
function More({ to, label }: { to: string; label: string }): React.JSX.Element {
  return (
    <Link className="wi-more" to={{ search: to }}>
      {label} <ArrowRight aria-hidden="true" />
    </Link>
  );
}

export function SummaryTab({
  filters,
  query,
  range,
  minGroupSize,
  overview,
}: SummaryTabProps): React.JSX.Element {
  const nav = useUsageNav();
  const { metric } = filters;
  const categories = useCategories(query, "");
  const trend = useTrend(query, defaultBucket(range));
  const matrix = useMatrix(query);
  const models = useModels(query);
  const signals = useTrendSignals(query);
  const automation = useAutomation(query, "");
  const insights = useInsights(query);

  return (
    <div className="wi-stack">
      <Panel query={overview} label="요약 지표">
        {(data) => (
          <Kpis data={data} compare={filters.compare} minGroupSize={minGroupSize} nav={nav} metric={metric} />
        )}
      </Panel>

      <SectionCard
        title="업무 유형별 비중"
        description={`대분류별 ${metricLabels[metric]}의 비중입니다. 조각이나 범례를 누르면 하위 분류로 들어갑니다.`}
        actions={<More to={nav.search({ tab: "categories" })} label="업무 유형 탭" />}
      >
        <Panel
          query={categories}
          label="업무 유형별 비중"
          isEmpty={breakdownEmpty}
          withheld={{ when: breakdownWithheld, minGroupSize }}
        >
          {(data) => {
            const rows = breakdownRows(data, metric);
            return (
              <>
                <CategoryDonut
                  rows={rows}
                  metric={metric}
                  caption={`업무 유형별 ${metricLabels[metric]} 비중`}
                  total={metricValue(data.total, metric)}
                  onSelect={(id) =>
                    nav.selectCategory({
                      id,
                      hasChildren: rows.find((row) => row.id === id)?.hasChildren ?? false,
                    })
                  }
                />
                <p className="wi-note">
                  {unclassifiedExplanation} {failedExplanation}
                  {metric === "users"
                    ? " 한 사용자가 여러 업무에 집계되므로 사용자 비중의 합은 100%를 넘을 수 있습니다."
                    : ""}
                </p>
              </>
            );
          }}
        </Panel>
      </SectionCard>

      <SectionCard
        title="증감 추이"
        description={`업무 유형별 ${metricLabels[metric]}의 ${defaultBucket(range) === "week" ? "주간" : "일간"} 추이입니다.`}
        actions={<More to={nav.search({ tab: "categories" })} label="단계별 추이" />}
      >
        <Panel
          query={trend}
          label="증감 추이"
          isEmpty={(data) => data.buckets.length === 0}
          withheld={{ when: (data) => data.suppressed, minGroupSize }}
        >
          {(data) => (
            <TrendArea
              data={data}
              metric={metric}
              caption={`업무 유형별 ${metricLabels[metric]} 추이`}
              onSelect={(id) => nav.go({ tab: "categories", parent: id })}
            />
          )}
        </Panel>
      </SectionCard>

      <SectionCard
        title="조직별 히트맵"
        description={`조직이 어떤 업무에 AI를 쓰는지 ${metricLabels[metric]}로 봅니다. 칸을 누르면 그 조직·업무의 세션으로 이동합니다.`}
        actions={<More to={nav.search({ tab: "teams" })} label="조직 탭" />}
      >
        <Panel query={matrix} label="조직별 히트맵" isEmpty={(data) => data.rows.length === 0}>
          {(data) => (
            <MatrixPanel
              data={data}
              metric={metric}
              minGroupSize={minGroupSize}
              onSelectCell={(team, category) => nav.go(sessionsUpdates({ team, category }))}
              onSelectCategory={(category) => nav.go({ tab: "categories", parent: category })}
            />
          )}
        </Panel>
      </SectionCard>

      <SectionCard
        title="업무별 모델·비용"
        description="업무마다 어떤 모델이 얼마나 쓰이고 세션당 얼마가 드는지입니다(세션이 많은 순)."
        actions={<More to={nav.search({ tab: "models" })} label="모델 탭" />}
      >
        <Panel
          query={models}
          label="업무별 모델·비용"
          isEmpty={(data) => data.rows.length === 0}
          withheld={{ when: (data) => data.suppressed && data.rows.length === 0, minGroupSize }}
        >
          {(data) => (
            <ModelTable
              compact
              minGroupSize={minGroupSize}
              rows={[...data.rows]
                .sort((left, right) => (right.sessions ?? -1) - (left.sessions ?? -1))
                .slice(0, summaryModels)}
            />
          )}
        </Panel>
      </SectionCard>

      <SectionCard
        title="신규·급증 업무"
        description="비교 기간보다 새로 나타났거나 크게 늘어난 업무입니다."
        actions={<More to={nav.search({ tab: "trends" })} label="트렌드 전체" />}
      >
        <Panel
          query={signals}
          label="신규·급증 업무"
          isEmpty={(data) => !data.signals.some((signal) => risingKinds.includes(signal.kind))}
          emptyHint="이 기간에는 기준을 넘는 신규·급증 신호가 없습니다."
        >
          {(data) => (
            <SignalList
              label="신규·급증 업무"
              showKind
              metric={metric}
              signals={data.signals
                .filter((signal) => risingKinds.includes(signal.kind))
                .slice(0, summarySignals)}
              onOpen={(signal) =>
                nav.go(sessionsUpdates({ category: signal.category.id, team: signal.team || undefined }))
              }
            />
          )}
        </Panel>
      </SectionCard>

      <SectionCard
        title="반복 업무·자동화 후보"
        description={automationDisclaimer}
        actions={<More to={nav.search({ tab: "trends" })} label="후보 전체" />}
      >
        <Panel
          query={automation}
          label="반복 업무·자동화 후보"
          isEmpty={(data) => data.rows.length === 0}
          emptyHint="반복 패턴이 충분히 쌓이면 후보가 나타납니다."
        >
          {(data) => (
            <AutomationTable
              compact
              rows={data.rows.slice(0, summaryCandidates)}
              minGroupSize={minGroupSize}
              onOpen={(row) => nav.go({ tab: "trends", candidate: row.id })}
            />
          )}
        </Panel>
      </SectionCard>

      <SectionCard
        title="인사이트"
        description="집계에서 계산한 관찰과 그 근거입니다. 기간·비교·표본을 함께 확인하세요."
      >
        <Panel
          query={insights}
          label="인사이트"
          isEmpty={(data) => data.rows.length === 0}
          emptyHint="아직 생성된 인사이트가 없습니다. 주기 작업이 돌면 채워집니다."
        >
          {(data) => <InsightSummary insights={data.rows} llmUsed={data.llm_used} />}
        </Panel>
      </SectionCard>
    </div>
  );
}

interface KpisProps {
  data: WorkOverview;
  compare: boolean;
  minGroupSize: number;
  metric: UsageTabProps["filters"]["metric"];
  nav: ReturnType<typeof useUsageNav>;
}

function Kpis({ data, compare, minGroupSize, metric, nav }: KpisProps): React.JSX.Element {
  const { current, previous } = data;
  // A withheld period has its figures null: they read as 보호됨, never as 0.
  const withheld = <Suppressed minGroupSize={minGroupSize} />;
  const shown = (value: number | null, write: (value: number) => string = formatNumber): ReactNode =>
    value === null ? withheld : write(value);
  const against = (pick: (metrics: WorkOverviewMetrics) => number | null, unit = ""): string => {
    if (!compare) return "직전 기간 비교 꺼짐";
    if (!previous) return "직전 기간 데이터 없음";
    const before = pick(previous);
    if (before === null) return `직전 기간은 ${suppressedLabel}`;
    const now = pick(current);
    if (now === null) return `직전 ${formatNumber(before)}${unit}`;
    return `직전 ${formatNumber(before)}${unit} · ${formatChange(changeRate(now, before))}`;
  };
  const classifiedAgainst = (): string => {
    if (!compare) return "직전 기간 비교 꺼짐";
    if (!previous) return "직전 기간 데이터 없음";
    if (previous.classified_rate === null) return `직전 기간은 ${suppressedLabel}`;
    if (current.classified_rate === null) return `직전 ${formatPercent(previous.classified_rate)}`;
    return `직전 ${formatPercent(previous.classified_rate)} · ${formatPointChange(current.classified_rate, previous.classified_rate)}`;
  };
  // A caller who may not see raw prompts never gets the classification-quality distributions.
  const qualityWithheld = data.scope.small_groups_withheld;
  const growthWithheld = data.growth_rate === null && (current.suppressed || (previous?.suppressed ?? false));
  const sessions = nav.search({ tab: "sessions", list: undefined });
  const totalConfidence = data.confidence.reduce((sum, bucket) => sum + bucket.requests, 0);
  const totalMethods = data.methods.reduce((sum, item) => sum + item.requests, 0);
  return (
    <>
      <StatGrid label="요약 지표">
        <KpiTile
          label="업무 세션"
          value={shown(current.sessions)}
          comparison={against((metrics) => metrics.sessions)}
          to={sessions}
          linkLabel="세션 목록"
        />
        <KpiTile
          label="LLM 요청"
          value={shown(current.requests)}
          comparison={against((metrics) => metrics.requests)}
          to={nav.search({ tab: "sessions", list: "requests" })}
          linkLabel="요청 목록"
        />
        <KpiTile
          label="활용 사용자"
          value={shown(current.users)}
          comparison={against((metrics) => metrics.users, "명")}
          to={nav.search({ tab: "teams" })}
          linkLabel="조직별 사용자"
        />
        <KpiTile
          label="활용 조직"
          value={formatNumber(current.teams)}
          comparison={against((metrics) => metrics.teams, "곳")}
          to={nav.search({ tab: "teams" })}
          linkLabel="조직 탭"
        />
        <KpiTile
          label="활성 업무 유형"
          value={shown(current.active_categories)}
          comparison={against((metrics) => metrics.active_categories, "개")}
          to={nav.search({ tab: "categories" })}
          linkLabel="업무 유형 탭"
        />
        <KpiTile
          label="분류 완료율"
          value={shown(current.classified_rate, (rate) => formatPercent(rate))}
          comparison={classifiedAgainst()}
          to={nav.search({ tab: "sessions", list: "requests", status: "unclassified" })}
          linkLabel="미분류 요청"
        />
        <KpiTile
          label="증가율"
          value={compare ? (growthWithheld ? withheld : formatChange(data.growth_rate)) : "—"}
          comparison={compare ? `${metricLabels[metric]} · 직전 기간 대비` : "직전 기간 비교 꺼짐"}
          to={nav.search({ tab: "trends" })}
          linkLabel="트렌드"
        />
        <KpiTile
          label="신규 업무"
          value={shown(current.new_categories)}
          comparison={against((metrics) => metrics.new_categories, "개")}
          to={nav.search({ tab: "trends" })}
          linkLabel="신규 업무 신호"
        />
        <KpiTile
          label="자동화 후보"
          value={formatNumber(current.automation_candidates)}
          comparison="현재 후보 수 · 이력이 없어 비교하지 않음"
          to={nav.search({ tab: "trends" })}
          linkLabel="후보 목록"
        />
      </StatGrid>
      <section className="wi-confidence" aria-label="분류 신뢰도 분포">
        <h2>신뢰도 분포</h2>
        {qualityWithheld ? (
          <p className="wi-note">{qualityWithheldNote}</p>
        ) : current.suppressed ? (
          <p className="wi-note">
            {withheld} 이 기간 전체가 보호 대상이어서 신뢰도·분류 방식·상태 분포를 보여 주지 않습니다.
          </p>
        ) : data.confidence.length > 0 ? (
          <RankedBars
            label="분류 신뢰도 구간별 요청 수"
            items={data.confidence.map((bucket) => ({
              id: bucket.bucket,
              label: bucket.bucket,
              value: bucket.requests,
              display: `${formatNumber(bucket.requests)}건`,
              detail: totalConfidence > 0 ? formatPercent(bucket.requests / totalConfidence) : undefined,
              paint: categoryPaint(restId),
            }))}
          />
        ) : (
          <p className="wi-note">신뢰도 분포 데이터가 없습니다.</p>
        )}
        {data.methods.length > 0 && !current.suppressed && !qualityWithheld ? (
          <p className="wi-note">
            분류 방식:{" "}
            {data.methods
              .map(
                (item) =>
                  `${methodLabel(item.method)} ${formatNumber(item.requests)}건${
                    totalMethods > 0 ? ` (${formatPercent(item.requests / totalMethods)})` : ""
                  }`,
              )
              .join(" · ")}
            {data.statuses.length > 0
              ? ` · 상태: ${data.statuses.map((item) => `${classificationLabel(item.status)} ${formatNumber(item.requests)}건`).join(" · ")}`
              : ""}
          </p>
        ) : null}
      </section>
    </>
  );
}

/** The summary shows the first insights; the rest open in place rather than lengthening every visit. */
function InsightSummary({
  insights,
  llmUsed,
}: {
  insights: readonly WorkInsight[];
  llmUsed: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hidden = insights.length - summaryInsights;
  return (
    <>
      <InsightList insights={expanded ? insights : insights.slice(0, summaryInsights)} />
      {hidden > 0 ? (
        <Button size="small" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          {expanded
            ? `처음 ${formatNumber(summaryInsights)}개만 보기`
            : `나머지 ${formatNumber(hidden)}개 더 보기`}
        </Button>
      ) : null}
      <p className="wi-note">
        {llmUsed
          ? "문장은 LLM이 집계 수치만으로 다듬었습니다. 수치는 집계 값 그대로입니다."
          : "문장과 수치 모두 집계에서 규칙으로 만든 것입니다."}
      </p>
    </>
  );
}
