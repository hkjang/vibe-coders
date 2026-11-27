import { RefreshCw } from "lucide-react";

import {
  automationReviewStatuses,
  workSignalKinds,
  type AutomationReviewStatus,
} from "@/shared/api/domains/insights-usage";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatNumber, formatPercent } from "@/shared/utils/format";

import { AutomationSheet, AutomationTable } from "../panels/AutomationPanel";
import { SignalList } from "../panels/SignalList";
import { useAutomation, useTrendSignals, useUsageWrites } from "../use-usage-queries";
import { sessionsUpdates, useUsageNav } from "../use-usage-nav";
import { oneOf, safeText } from "../usage-filters";
import { automationDisclaimer, reviewStatusLabels, signalKindHints, signalKindLabels } from "../usage-labels";
import { metricLabels } from "../usage-metrics";
import type { UsageTabProps } from "../usage-tab-props";
import { Panel } from "../usage-ui";

const reviewFilters = ["", ...automationReviewStatuses] as const;

export function TrendsTab({ filters, query, minGroupSize }: UsageTabProps): React.JSX.Element {
  const [params, update] = useSearchState();
  const nav = useUsageNav();
  const { returnFocusRef, remember } = useReturnFocus();
  const writes = useUsageWrites();
  const { metric } = filters;
  const review = oneOf<AutomationReviewStatus | "">(params.get("review"), reviewFilters, "");
  const candidateId = safeText(params.get("candidate"), 200);

  const signals = useTrendSignals(query);
  const automation = useAutomation(query, review);
  const candidate = automation.data?.rows.find((row) => row.id === candidateId);

  return (
    <div className="wi-stack">
      <SectionCard
        title="트렌드 신호"
        description={`${metricLabels[metric]} 기준으로 집계에서 찾은 변화입니다. 신호마다 절대 증감, 증감률, 사용자 수 변화와 표본을 함께 봅니다.`}
        actions={
          <Button
            variant="secondary"
            disabled={!writes.access.allowed || writes.runInsights.isPending}
            title={writes.access.reason}
            onClick={() => writes.runInsights.mutate(undefined)}
          >
            <RefreshCw aria-hidden="true" /> {writes.runInsights.isPending ? "계산하는 중" : "지금 다시 계산"}
          </Button>
        }
      >
        <Panel query={signals} label="트렌드 신호">
          {(data) => (
            <div className="wi-stack">
              <p className="wi-note">
                적용 기준: 표본 {formatNumber(data.thresholds.min_sample)}건 이상, 절대 증감{" "}
                {formatNumber(data.thresholds.min_change_abs)} 이상, 증감률{" "}
                {formatPercent(data.thresholds.min_change_rate, 0)} 이상. 기준에 못 미치는 변화는 신호로
                올리지 않습니다.
              </p>
              <div className="wi-signal-groups">
                {workSignalKinds.map((kind) => {
                  const group = data.signals.filter((signal) => signal.kind === kind);
                  return (
                    <section
                      key={kind}
                      className="wi-signal-group"
                      aria-label={`${signalKindLabels[kind]} 신호`}
                    >
                      <h3>
                        {signalKindLabels[kind]}{" "}
                        <span className="wi-count">{formatNumber(group.length)}</span>
                      </h3>
                      <p className="wi-note">{signalKindHints[kind]}</p>
                      {group.length > 0 ? (
                        <SignalList
                          label={`${signalKindLabels[kind]} 목록`}
                          metric={metric}
                          signals={group}
                          onOpen={(signal) =>
                            nav.go(
                              sessionsUpdates({
                                category: signal.category.id,
                                team: signal.team || undefined,
                                model: signal.model || undefined,
                              }),
                            )
                          }
                        />
                      ) : (
                        <p className="wi-signal-none">이 기간에는 해당 신호가 없습니다.</p>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          )}
        </Panel>
      </SectionCard>

      <SectionCard
        title="반복 업무·자동화 후보"
        description={automationDisclaimer}
        actions={
          <label className="wi-inline-filter" htmlFor="wi-review">
            <span>검토 상태</span>
            <Select
              id="wi-review"
              value={review}
              onChange={(event) => update({ review: event.target.value, candidate: undefined })}
              placeholder="전체"
              options={automationReviewStatuses.map((value) => ({ value, label: reviewStatusLabels[value] }))}
            />
          </label>
        }
      >
        <Panel
          query={automation}
          label="자동화 후보"
          isEmpty={(data) => data.rows.length === 0}
          emptyHint={
            review
              ? "이 검토 상태의 후보가 없습니다. 검토 상태 필터를 바꿔 보세요."
              : "반복 패턴이 충분히 쌓이면 후보가 나타납니다."
          }
        >
          {(data) => (
            <>
              <AutomationTable
                rows={data.rows}
                minGroupSize={minGroupSize}
                onOpen={(row, trigger) => {
                  remember(trigger);
                  update({ candidate: row.id }, { replace: false });
                }}
              />
              <p className="wi-note">
                후보 {formatNumber(data.count || data.rows.length)}건. 실현 가능성과 예상 효과는 집계에서
                계산한 추정치입니다.
              </p>
            </>
          )}
        </Panel>
      </SectionCard>

      {candidateId ? (
        <AutomationSheet
          candidate={candidate}
          loading={automation.isPending}
          minGroupSize={minGroupSize}
          writes={writes}
          returnFocusRef={returnFocusRef}
          onClose={() => update({ candidate: undefined })}
        />
      ) : null}
    </div>
  );
}
