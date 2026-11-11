import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { formatDateTime } from "@/shared/utils/format";
import { teamCost, teamNumber } from "./team-model";
import { TeamPartial, TeamQueryPanel } from "./team-ui";
import { useTeamRiskQuery, useTeamSavingsQuery } from "./use-team-queries";

export function TeamOperationsCards() {
  const savings = useTeamSavingsQuery(),
    risk = useTeamRiskQuery();
  const data = savings.data,
    danger = risk.data;
  const failed = danger?.partial_failures ?? [];
  const policy = failed.includes("policy_current"),
    prior = failed.includes("policy_prior");
  const trend = policy || prior ? undefined : danger?.blocked_trend;
  return (
    <div className="access-cards">
      <SectionCard
        title="비용 절감 챌린지"
        description="이번 달 지출 속도를 월말까지 연장한 예상치입니다. 실제 지출은 달라질 수 있습니다."
      >
        <TeamQueryPanel query={savings} label="절감 챌린지">
          <StatGrid label="절감 챌린지 지표">
            <StatCard label="이번 달" value={teamCost(data?.month_to_date_krw)} />
            <StatCard label="월말 예상" value={teamCost(data?.projected_month_end_krw)} />
            <StatCard label="지난달" value={teamCost(data?.last_month_krw)} />
            <StatCard
              label="예상 절감"
              value={teamCost(data?.projected_savings_krw)}
              tone={data?.on_track === undefined ? "default" : data.on_track ? "success" : "warning"}
              hint={
                data?.on_track === undefined
                  ? "목표 상태 미확인"
                  : data.on_track
                    ? "목표 진행 중"
                    : "목표 미달"
              }
            />
          </StatGrid>
        </TeamQueryPanel>
      </SectionCard>
      <SectionCard
        title="팀 위험 신호"
        description="최근 7일 기준입니다. 정책·비밀정보는 최대 5,000건, 승인 대기는 최대 100건에서 집계합니다."
      >
        <TeamQueryPanel query={risk} label="팀 위험 신호">
          <TeamPartial failed={failed.length > 0} retry={risk.refetch} />
          <StatGrid label="팀 위험 지표">
            <StatCard
              label="차단"
              value={teamNumber(policy ? undefined : danger?.blocked)}
              tone={!policy && (danger?.blocked ?? 0) > 0 ? "danger" : "default"}
              hint={
                trend === undefined
                  ? "이전 7일 대비 변화 미확인"
                  : "이전 7일 대비 " + (trend > 0 ? "+" : "") + teamNumber(trend) + "건"
              }
            />
            <StatCard label="경고" value={teamNumber(policy ? undefined : danger?.warned)} />
            <StatCard
              label="비밀정보 탐지"
              value={teamNumber(failed.includes("secrets") ? undefined : danger?.secrets_total)}
            />
            <StatCard
              label="승인 대기"
              value={teamNumber(failed.includes("approvals") ? undefined : danger?.pending_approvals)}
            />
          </StatGrid>
          {!policy && (danger?.recent_violations.length ?? 0) > 0 ? (
            <ul className="access-list">
              {danger?.recent_violations.map((row, index) => (
                <li key={index}>
                  <span className="access-list-title">
                    {({ block: "차단", deny: "거부", warn: "경고", allow: "허용" } as Record<string, string>)[
                      row.decision
                    ] ?? "정책 결정"}{" "}
                    · {row.rule || "규칙 미상"}
                  </span>
                  <span className="access-list-detail">
                    {row.reason} · {row.endpoint} · {formatDateTime(row.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </TeamQueryPanel>
      </SectionCard>
    </div>
  );
}
