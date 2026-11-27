import { Link } from "react-router";

import type { WorkScope } from "@/shared/api/domains/insights-common";
import type { WorkStatus } from "@/shared/api/domains/insights-usage";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

import {
  narrowingCount,
  periodRange,
  previousRange,
  rangeDays,
  type DayRange,
  type UsageFilters,
} from "./usage-filters";
import { actionLabel } from "./usage-labels";
import { metricLabels, suppressedLabel } from "./usage-metrics";

/** A server time or day as text: a full timestamp is shown in Seoul time, a bare day as is. */
function throughText(value: string): string {
  if (!value) return "—";
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : formatDateTime(value);
}

const rangeText = (range: DayRange): string =>
  range.from && range.to ? `${range.from} ~ ${range.to} (${formatNumber(rangeDays(range))}일)` : "—";

interface ScopeLineProps {
  filters: UsageFilters;
  today: string;
  scope: WorkScope | undefined;
  categoryName: string;
}

/**
 * States what the numbers below cover: everything or a filtered part, which
 * period, what it is compared with, and how far classification has got.
 */
export function ScopeLine({ filters, today, scope, categoryName }: ScopeLineProps): React.JSX.Element {
  const requested = periodRange(filters.period, today);
  const period: DayRange = scope?.from && scope.to ? { from: scope.from, to: scope.to } : requested;
  const previous: DayRange =
    scope?.prev_from && scope.prev_to ? { from: scope.prev_from, to: scope.prev_to } : previousRange(period);
  const narrowed = [
    filters.team ? `팀 ${filters.team}` : "",
    filters.category ? `업무 ${categoryName || filters.category}` : "",
    filters.action ? `작업 ${actionLabel(filters.action)}` : "",
    filters.model ? `모델 ${filters.model}` : "",
    filters.client ? `클라이언트 ${filters.client}` : "",
  ].filter(Boolean);
  return (
    <dl className="wi-scope-line" aria-label="현재 조회 범위">
      <div>
        <dt>범위</dt>
        <dd>
          {narrowingCount(filters) === 0
            ? scope?.team_scoped
              ? "내 팀 전체"
              : "전체"
            : `필터 ${narrowed.length}개 적용 · ${narrowed.join(" · ")}`}
          {scope?.team_scoped && narrowingCount(filters) > 0 ? " · 내 팀 범위" : ""}
        </dd>
      </div>
      <div>
        <dt>기간</dt>
        <dd>{rangeText(period)}</dd>
      </div>
      <div>
        <dt>비교 기간</dt>
        <dd>{filters.compare ? rangeText(previous) : "비교 안 함"}</dd>
      </div>
      <div>
        <dt>집계 기준</dt>
        <dd>{metricLabels[filters.metric]}</dd>
      </div>
      <div>
        <dt>데이터 반영 시점</dt>
        <dd>{scope ? throughText(scope.data_through) : "확인 중"}</dd>
      </div>
      {scope ? (
        <div>
          <dt>개인 보호</dt>
          <dd>
            고유 사용자 {formatNumber(scope.min_group_size)}명 미만 집계는 ‘{suppressedLabel}’으로 가립니다
            {scope.policy_version ? ` · 분류 정책 v${scope.policy_version}` : ""}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

interface ScopeNoticesProps {
  scope: WorkScope | undefined;
  status: WorkStatus | undefined;
  statusFailed: boolean;
}

/** Why the numbers may be incomplete: classification is off, or still catching up. */
export function ScopeNotices({ scope, status, statusFailed }: ScopeNoticesProps): React.JSX.Element | null {
  const classifyOff = scope ? !scope.classify_enabled : status?.classify_enabled === false;
  const backlog = scope?.backlog ?? status?.backlog ?? 0;
  const through = scope?.data_through ?? status?.cursor_at ?? "";
  if (!classifyOff && backlog <= 0 && !statusFailed) return null;
  return (
    <div className="wi-notices">
      {classifyOff ? (
        <InlineNotice tone="warning" title="분류 엔진이 꺼져 있습니다.">
          새 요청은 업무로 분류되지 않습니다. 아래 수치는 엔진이 꺼지기 전({throughText(through)}까지)에
          분류된 데이터입니다. <Link to="/insights/classification">업무 분류 관리</Link>에서 상태를
          확인하세요.
        </InlineNotice>
      ) : backlog > 0 ? (
        <InlineNotice tone="info" title="분류 진행 중">
          아직 분류하지 않은 요청이 {formatNumber(backlog)}건 있습니다. 아래 수치는 {throughText(through)}
          까지 반영된 것이며, 분류가 따라잡으면 최근 구간의 값이 늘어납니다.
        </InlineNotice>
      ) : null}
      {statusFailed ? (
        <InlineNotice tone="warning" title="분류 워커 상태를 확인하지 못했습니다.">
          분석 수치는 그대로 조회합니다. 분류 지연 여부는 잠시 후 다시 확인하세요.
        </InlineNotice>
      ) : null}
    </div>
  );
}

/** Shown instead of the tabs when the server cannot provide the analysis at all. */
export function AnalysisUnavailable({ disabled }: { disabled: boolean }): React.JSX.Element {
  return (
    <section className="wi-unavailable" role="status" aria-label="업무 활용 분석 사용 불가">
      <h2>
        {disabled
          ? "업무 활용 분석이 꺼져 있습니다."
          : "이 서버에서는 업무 활용 분석을 아직 제공하지 않습니다."}
      </h2>
      <p>
        {disabled
          ? "운영자가 분석 기능(WORK_INTEL_ANALYTICS_ENABLED)을 끈 상태입니다. 시스템 설정에서 다시 켜면 재시작 없이 이 화면이 채워집니다."
          : "서버가 이 기능의 API를 구현하지 않은 버전입니다(501). 서버를 업그레이드한 뒤 다시 열어 주세요. 화면 오류가 아닙니다."}
      </p>
    </section>
  );
}
