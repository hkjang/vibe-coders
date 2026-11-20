import { MeActionsPanel } from "./MeActionsPanel";
import { severityTone } from "@/features/access/access-format";
import { UpdatedAt } from "@/features/access/access-ui";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { FormField } from "@/shared/components/form/FormField";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime } from "@/shared/utils/format";
import { useMeDashboardQuery, useMeNotificationsQuery, useMeReportQuery } from "./use-me-queries";
import { meCost, meLabel, meNumber, meRatio } from "./me-console-model";
import { MePartial, MeQueryContent } from "./me-console-ui";
import { MeHomeDetails } from "./MeHomeDetails";

export function MeHomeTab() {
  const dashboard = useMeDashboardQuery(),
    notifications = useMeNotificationsQuery();
  const [params, update] = useSearchState();
  const window = params.get("report_window") === "monthly" ? "monthly" : "weekly";
  const report = useMeReportQuery(window);
  const data = dashboard.data,
    reportData = report.data;
  const profileUnavailable = reportData?.partial_failures.includes("profile");
  const hasBaseline = reportData?.prior_cost_krw !== undefined && reportData.prior_cost_krw > 0;
  const delta = hasBaseline ? reportData?.cost_delta_ratio : undefined;
  return (
    <div className="access-stack">
      <MeQueryContent query={dashboard} label="내 사용 현황">
        <p className="me-period-note">
          오늘·이번 달은 UTC 날짜 경계 기준입니다. 성공률·자주 쓰는 모델도 이번 달 시작 이후를 집계합니다.
        </p>
        <StatGrid label="내 사용 요약">
          <StatCard label="오늘 요청" value={meNumber(data?.today?.requests)} />
          <StatCard
            label="오늘 오류"
            value={meNumber(data?.today?.errors)}
            tone={(data?.today?.errors ?? 0) > 0 ? "warning" : "default"}
          />
          <StatCard label="이번 달 비용" value={meCost(data?.month?.cost_krw)} />
          <StatCard
            label="이번 달 성공률"
            value={meRatio(data?.month?.requests ? data.profile?.success_rate : undefined)}
          />
          <StatCard
            label="절감 가능 금액"
            value={meCost(data?.potential_savings_krw)}
            hint={data?.potential_savings_model}
          />
          <StatCard label="개인 위험 점수" value={meNumber(data?.profile?.risk_score)} />
        </StatGrid>
        {data?.profile?.summary ? <InlineNotice tone="info">{data.profile.summary}</InlineNotice> : null}
      </MeQueryContent>
      <div className="me-home-columns">
        <MeActionsPanel />
        <SectionCard
          title="알림 센터"
          description="추천·키·실패·정책·비밀정보 신호를 모은 목록입니다. 읽음 여부를 추적하는 알림함은 아닙니다."
        >
          <MeQueryContent query={notifications} label="알림">
            <MePartial failures={notifications.data?.partial_failures} />
            <p className="access-note">
              모인 알림 {meNumber(notifications.data?.count)}건 · 중요{" "}
              {meNumber(notifications.data?.critical_count)}건
            </p>
            {notifications.data?.notifications.length ? (
              <ul className="access-list">
                {notifications.data.notifications.map((row, index) => (
                  <li key={index}>
                    <span className="access-list-title">
                      <Badge tone={severityTone(row.level)}>{meLabel(row.level)}</Badge>
                      {row.title}
                    </span>
                    <span className="access-list-detail">{row.detail}</span>
                    <span className="access-list-detail">{formatDateTime(row.created_at)}</span>
                  </li>
                ))}
              </ul>
            ) : !notifications.data?.partial_failures.length ? (
              <EmptyState
                title="조회된 알림이 없습니다."
                description="현재 조회 범위에서 알림 신호가 없습니다."
              />
            ) : null}
          </MeQueryContent>
        </SectionCard>
      </div>
      <SectionCard
        id="me-report"
        tabIndex={-1}
        title="내 리포트"
        description="조회 시각부터 최근 7일 또는 30일을 직전 같은 길이 기간과 비교합니다."
        actions={
          <FormField label="리포트 기간">
            {(control) => (
              <Select
                {...control}
                value={window}
                onChange={(event) => update({ report_window: event.target.value })}
              >
                <option value="weekly">최근 7일</option>
                <option value="monthly">최근 30일</option>
              </Select>
            )}
          </FormField>
        }
      >
        <MeQueryContent query={report} label="내 리포트">
          <MePartial failures={reportData?.partial_failures} />
          {reportData?.since ? (
            <p className="me-period-note">시작 시각: {formatDateTime(reportData.since)}</p>
          ) : null}
          <StatGrid label="리포트 지표">
            <StatCard label="요청" value={meNumber(reportData?.requests)} />
            <StatCard label="토큰" value={meNumber(reportData?.tokens)} />
            <StatCard label="비용" value={meCost(reportData?.cost_krw)} />
            <StatCard
              label="성공률"
              value={meRatio(reportData?.requests ? reportData.success_rate : undefined)}
            />
            <StatCard
              label="캐시 적중률"
              value={meRatio(profileUnavailable ? undefined : reportData?.cache_rate)}
            />
            <StatCard
              label="직전 대비 비용"
              value={delta === undefined ? "—" : meRatio(Math.abs(delta))}
              tone={delta === undefined || delta === 0 ? "default" : delta > 0 ? "warning" : "success"}
              hint={
                delta === undefined
                  ? "비교할 이전 비용 없음"
                  : delta > 0
                    ? "증가"
                    : delta < 0
                      ? "감소"
                      : "변화 없음"
              }
            />
          </StatGrid>
        </MeQueryContent>
      </SectionCard>
      {data ? <MeHomeDetails data={data} /> : null}
      <UpdatedAt at={dashboard.dataUpdatedAt} />
    </div>
  );
}
