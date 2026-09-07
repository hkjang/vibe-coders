import { useRef, useState } from "react";

import { formatSignedRatio, severityTone } from "@/features/access/access-format";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import {
  meKeys,
  useMeActionsQuery,
  useMeDashboardQuery,
  useMeNotificationsQuery,
  useMeReportQuery,
} from "@/features/access/me/use-me-queries";
import { apiClient } from "@/shared/api/client";
import type { SnoozeActionBody } from "@/shared/api/domains/access";
import type { MeAction } from "@/shared/api/domains/access.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "me.home";

/** Legacy `#/...` hrefs point at the old console; only those become links. */
function legacyHref(href: string): string | undefined {
  return href.startsWith("#/") ? `/admin${href}` : undefined;
}

export function MeHomeTab(): React.JSX.Element {
  const dashboard = useMeDashboardQuery();
  const actions = useMeActionsQuery();
  const notifications = useMeNotificationsQuery();
  const [reportWindow, setReportWindow] = useState<"weekly" | "monthly">("weekly");
  const report = useMeReportQuery(reportWindow);
  const [snoozing, setSnoozing] = useState<MeAction | undefined>();
  const snoozeTrigger = useRef<HTMLElement>(null);

  const snooze = useMutationFeedback({
    mutate: (body: SnoozeActionBody) => apiClient.request(access.me.snooze, { body, routeId }),
    invalidates: [meKeys.actions],
    successMessage: "이 액션을 잠시 숨겼습니다.",
  });

  if (dashboard.isPending && !dashboard.data) {
    return <LoadingState label="내 사용 현황을 불러오는 중입니다." />;
  }

  const data = dashboard.data;
  const today = data?.today;
  const month = data?.month;
  const profile = data?.profile;
  const actionRows = actions.data?.actions ?? [];
  const notificationRows = notifications.data?.notifications ?? [];

  return (
    <div className="access-stack">
      {dashboard.isError ? (
        <QueryNotice
          error={dashboard.error}
          hasData={Boolean(dashboard.data)}
          label="내 사용 현황"
          onRetry={() => void dashboard.refetch()}
        />
      ) : null}

      <StatGrid label="내 사용 요약">
        <StatCard label="오늘 요청" value={formatNumber(today?.requests)} />
        <StatCard
          label="오늘 오류"
          tone={(today?.errors ?? 0) > 0 ? "warning" : "default"}
          value={formatNumber(today?.errors)}
        />
        <StatCard label="이번 달 비용" value={formatKRW(month?.cost_krw)} />
        <StatCard label="30일 성공률" value={formatSignedRatio(profile?.success_rate)} />
        <StatCard
          label="절감 가능 금액"
          value={formatKRW(data?.potential_savings_krw)}
          hint={data?.potential_savings_model || undefined}
        />
        <StatCard label="개인 위험 점수" value={formatNumber(profile?.risk_score)} />
      </StatGrid>

      <div className="access-cards">
        <SectionCard title="내 액션 큐" description="지금 처리하면 좋은 항목입니다.">
          {actions.isError ? (
            <QueryNotice
              error={actions.error}
              hasData={Boolean(actions.data)}
              label="액션 큐"
              onRetry={() => void actions.refetch()}
            />
          ) : null}
          {actionRows.length === 0 ? (
            <EmptyState
              title="처리할 액션이 없습니다."
              description="비용, 키 만료, 정책 위반 신호가 생기면 여기에 모입니다."
            />
          ) : (
            <ul className="access-list">
              {actionRows.map((action, index) => (
                <li key={`${action.type}-${String(index)}`}>
                  <span className="access-list-title">
                    <Badge tone={severityTone(action.severity)}>{action.severity || "정보"}</Badge>
                    {action.message}
                  </span>
                  <span className="access-inline-actions">
                    {legacyHref(action.button_href) ? (
                      <a
                        className="button button-secondary button-small"
                        href={legacyHref(action.button_href)}
                      >
                        {action.button_label || "열기"}
                      </a>
                    ) : null}
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={(event) => {
                        snoozeTrigger.current = event.currentTarget;
                        setSnoozing(action);
                      }}
                    >
                      7일 숨기기
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="알림 센터"
          description={`읽지 않은 알림 ${formatNumber(notifications.data?.count)}건 중 중요 ${formatNumber(notifications.data?.critical_count)}건`}
        >
          {notifications.isError ? (
            <QueryNotice
              error={notifications.error}
              hasData={Boolean(notifications.data)}
              label="알림"
              onRetry={() => void notifications.refetch()}
            />
          ) : null}
          {notificationRows.length === 0 ? (
            <EmptyState
              title="새 알림이 없습니다."
              description="비용 초과, 정책 위반, 키 만료 같은 사건이 생기면 알려 드립니다."
            />
          ) : (
            <ul className="access-list">
              {notificationRows.map((row, index) => (
                <li key={`${row.category}-${String(index)}`}>
                  <span className="access-list-title">
                    <Badge tone={severityTone(row.level)}>{row.level || "정보"}</Badge>
                    {row.title}
                  </span>
                  <span className="access-list-detail">{row.detail}</span>
                  <span className="access-list-detail">{formatDateTime(row.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="내 리포트"
        description="선택한 기간의 사용량과 직전 기간 대비 변화입니다."
        actions={
          <label className="access-toolbar-field">
            <span>기간</span>
            <Select
              value={reportWindow}
              onChange={(event) => setReportWindow(event.target.value === "monthly" ? "monthly" : "weekly")}
            >
              <option value="weekly">주간</option>
              <option value="monthly">월간</option>
            </Select>
          </label>
        }
      >
        {report.isError ? (
          <QueryNotice
            error={report.error}
            hasData={Boolean(report.data)}
            label="내 리포트"
            onRetry={() => void report.refetch()}
          />
        ) : null}
        {report.data ? (
          <StatGrid label="리포트 지표">
            <StatCard label="요청" value={formatNumber(report.data.requests)} />
            <StatCard label="토큰" value={formatNumber(report.data.tokens)} />
            <StatCard label="비용" value={formatKRW(report.data.cost_krw)} />
            <StatCard label="성공률" value={formatSignedRatio(report.data.success_rate)} />
            <StatCard label="캐시 적중률" value={formatSignedRatio(report.data.cache_rate)} />
            <StatCard
              label="직전 대비 비용"
              tone={report.data.cost_delta_ratio > 0 ? "warning" : "success"}
              value={formatSignedRatio(Math.abs(report.data.cost_delta_ratio))}
              hint={report.data.cost_delta_ratio > 0 ? "증가" : "감소"}
            />
          </StatGrid>
        ) : null}
      </SectionCard>

      <div className="access-cards">
        <SectionCard title="자주 쓰는 모델" description="최근 30일 사용 기준입니다.">
          {(data?.frequent_models ?? []).length === 0 ? (
            <EmptyState title="집계된 모델이 없습니다." description="요청을 보내면 사용 모델이 쌓입니다." />
          ) : (
            <ul className="access-list">
              {(data?.frequent_models ?? []).map((row, index) => (
                <li key={`${row.model}-${String(index)}`}>
                  <span className="access-list-title">{row.model}</span>
                  <span className="access-list-detail">
                    요청 {formatNumber(row.requests)} · 평균 {formatKRW(row.avg_cost_krw)} · 성공률{" "}
                    {formatSignedRatio(row.success_rate)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="최근 실패" description="가장 최근에 실패한 요청입니다.">
          {(data?.recent_failures ?? []).length === 0 ? (
            <EmptyState
              title="최근 실패가 없습니다."
              description="실패한 요청이 생기면 원인을 함께 봅니다."
            />
          ) : (
            <ul className="access-list">
              {(data?.recent_failures ?? []).map((row, index) => (
                <li key={`${row.id}-${String(index)}`}>
                  <span className="access-list-title">
                    <Badge tone="danger">{row.status_code || "오류"}</Badge>
                    {row.model || "모델 미상"}
                  </span>
                  <span className="access-list-detail">{row.error}</span>
                  <span className="access-list-detail">{formatDateTime(row.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="내 키 상태" description="만료가 가깝거나 오래 쓰지 않은 키를 알려 줍니다.">
          {(data?.key_alerts ?? []).length === 0 ? (
            <EmptyState title="주의할 키가 없습니다." description="만료나 미사용 신호가 생기면 표시합니다." />
          ) : (
            <ul className="access-list">
              {(data?.key_alerts ?? []).map((row) => (
                <li key={row.id}>
                  <span className="access-list-title">
                    <Badge tone={severityTone(row.severity)}>{row.severity || "정보"}</Badge>
                    {row.name || row.id}
                  </span>
                  <span className="access-list-detail">
                    {row.flags.length > 0 ? row.flags.join(", ") : "특이 신호 없음"}
                    {row.expires_at ? ` · 만료 ${formatDateTime(row.expires_at)}` : ""}
                    {row.days_idle > 0 ? ` · ${formatNumber(row.days_idle)}일 미사용` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="최근 차단" description="정책에 걸려 차단된 요청입니다.">
          {(data?.recent_blocks ?? []).length === 0 ? (
            <EmptyState
              title="차단된 요청이 없습니다."
              description="정책 위반이 생기면 규칙과 사유를 봅니다."
            />
          ) : (
            <ul className="access-list">
              {(data?.recent_blocks ?? []).map((row, index) => (
                <li key={`${row.rule}-${String(index)}`}>
                  <span className="access-list-title">{row.rule || "규칙 미상"}</span>
                  <span className="access-list-detail">
                    {row.reason} · {row.model || "모델 미상"} · {formatDateTime(row.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="내 저장 리포트" description="Text2SQL에서 저장한 리포트입니다.">
          {(data?.my_saved_reports ?? []).length === 0 ? (
            <EmptyState
              title="저장한 리포트가 없습니다."
              description="Text2SQL 화면에서 질문 결과를 저장하면 여기에 모입니다."
            />
          ) : (
            <ul className="access-list">
              {(data?.my_saved_reports ?? []).map((row) => (
                <li key={row.id}>
                  <span className="access-list-title">
                    {row.name}
                    <Badge tone={severityTone(row.approval_status)}>{row.approval_status || "—"}</Badge>
                  </span>
                  <span className="access-list-detail">
                    {row.schema_name} · {row.kind} · {formatDateTime(row.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      {profile?.summary ? <InlineNotice tone="info">{profile.summary}</InlineNotice> : null}
      <UpdatedAt at={dashboard.dataUpdatedAt} />

      <ConfirmDialog
        open={snoozing !== undefined}
        onOpenChange={(open) => {
          if (!open) setSnoozing(undefined);
        }}
        returnFocusRef={snoozeTrigger}
        title="액션 숨기기"
        description={`"${snoozing?.message ?? ""}" 액션을 7일 동안 숨깁니다.`}
        confirmLabel="숨기기"
        onConfirm={async () => {
          if (snoozing) await snooze.mutateAsync({ type: snoozing.type, days: 7 });
          setSnoozing(undefined);
        }}
      />
    </div>
  );
}
