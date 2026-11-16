import { useSystemHealthQuery } from "./use-system-health-query";
import { SystemDestination } from "./SystemDestination";
import { cardLabels, categoryLabels, useSystemText } from "./system-health-labels";

import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { bySeverity, opsStatusLabel, opsStatusTone } from "@/features/system/health/ops-status";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";

export const opsRouteId = "system.health";

/**
 * "오늘 봐야 할 것" — the operations home the legacy console showed under #/ops-home:
 * the day's signal cards, then the incidents already past their threshold. Read-only.
 */
export function OpsHomeTab(): React.JSX.Element {
  const safe = useSystemText();
  const home = useSystemHealthQuery({
    key: ["system", "ops", "home"],
    read: (signal) => apiClient.request(endpoints.domains.system.ops.home, { routeId: opsRouteId, signal }),
  });
  const incidents = useSystemHealthQuery({
    key: ["system", "ops", "incidents"],
    read: (signal) =>
      apiClient.request(endpoints.domains.system.ops.incidents, { routeId: opsRouteId, signal }),
  });

  const windowHours = home.data?.window_hours ?? 24;
  const cards = home.data?.cards ?? [];
  const rows = [...(incidents.data?.incidents ?? [])].sort((left, right) =>
    bySeverity(left.severity, right.severity),
  );
  const counts = incidents.data?.counts ?? {};

  return (
    <div className="page-stack">
      {home.isError ? (
        <QueryNotice
          error={home.error}
          hasPreviousData={home.data !== undefined}
          label="운영 홈"
          onRetry={() => void home.refetch()}
        />
      ) : null}

      <SectionCard
        title={`운영 신호 (최근 ${windowHours}시간)`}
        description="게이트웨이가 지금 집계한 신호입니다. 카드를 누르면 해당 화면으로 이동합니다."
        actions={
          home.data ? (
            <Badge tone={opsStatusTone(home.data.overall)}>{opsStatusLabel(home.data.overall)}</Badge>
          ) : null
        }
      >
        {home.isPending ? (
          <p className="metric-note">불러오는 중…</p>
        ) : !home.data ? (
          <p className="metric-note">운영 신호를 확인하지 못했습니다.</p>
        ) : cards.length === 0 ? (
          <EmptyState title="표시할 운영 신호가 없습니다." description="집계할 트래픽이 아직 없습니다." />
        ) : (
          <ul className="ops-card-grid" aria-label="운영 신호 카드">
            {cards.map((card) => {
              const body = (
                <>
                  <div className="ops-card-head">
                    <strong>{cardLabels[card.key] ?? safe(card.title)}</strong>
                    <Badge tone={opsStatusTone(card.status)}>{opsStatusLabel(card.status)}</Badge>
                  </div>
                  <div className="ops-card-value">{card.value?.trim() ? safe(card.value) : "—"}</div>
                  {card.detail ? <p className="metric-note">{safe(card.detail)}</p> : null}
                </>
              );
              return (
                <li key={card.key} className={`ops-card ops-card-${opsStatusTone(card.status)}`}>
                  <SystemDestination link={card.link}>{body}</SystemDestination>
                </li>
              );
            })}
          </ul>
        )}
        <UpdatedAt at={home.dataUpdatedAt} />
      </SectionCard>

      {incidents.isError ? (
        <QueryNotice
          error={incidents.error}
          hasPreviousData={incidents.data !== undefined}
          label="확인할 이슈"
          onRetry={() => void incidents.refetch()}
        />
      ) : null}

      <SectionCard
        title="지금 확인할 이슈"
        description={
          incidents.data?.note ? safe(incidents.data.note) : "임계치를 넘은 신호만 장애 후보로 표시합니다."
        }
        actions={
          <span className="metric-note">
            위험 {counts.critical ?? "—"} · 경고 {counts.warning ?? "—"}
          </span>
        }
      >
        {incidents.isPending ? (
          <p className="metric-note">불러오는 중…</p>
        ) : !incidents.data ? (
          <p className="metric-note">장애 후보를 확인하지 못했습니다.</p>
        ) : rows.length === 0 ? (
          <EmptyState title="지금 확인할 이슈가 없습니다." description="임계치를 넘은 신호가 없습니다." />
        ) : (
          <ul className="ops-incident-list" aria-label="장애 후보">
            {rows.map((incident) => (
              <li
                key={incident.id}
                className={`ops-incident ops-incident-${opsStatusTone(incident.severity)}`}
              >
                <div className="ops-card-head">
                  <strong>{safe(incident.title)}</strong>
                  <Badge tone={opsStatusTone(incident.severity)}>{opsStatusLabel(incident.severity)}</Badge>
                  {incident.category ? (
                    <span className="metric-note">
                      {categoryLabels[incident.category] ?? safe(incident.category)}
                    </span>
                  ) : null}
                </div>
                {incident.summary ? <p className="metric-note">{safe(incident.summary)}</p> : null}
                {incident.recommended_actions?.length ? (
                  <>
                    <p className="ops-incident-actions-title">추천 조치</p>
                    <ul className="ops-incident-actions">
                      {incident.recommended_actions.map((action) => (
                        <li key={action}>{safe(action)}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <UpdatedAt at={incidents.dataUpdatedAt} />
      </SectionCard>
    </div>
  );
}
