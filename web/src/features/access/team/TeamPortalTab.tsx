import { statusLabel, statusTone } from "@/features/access/access-format";
import { UsageMeter } from "@/features/access/access-ui";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { formatDate, formatDateTime } from "@/shared/utils/format";
import { useTeamPortalQuery } from "./use-team-queries";
import { teamCost, teamNumber, teamPercent, teamLatency } from "./team-model";
import { TeamTable } from "./TeamTable";
import { TeamPartial, TeamQueryPanel } from "./team-ui";

export function TeamPortalTab() {
  const query = useTeamPortalQuery();
  const data = query.data,
    usage = data?.usage;
  const failed = data?.partial_failures ?? [];
  const keysFailed = failed.includes("keys"),
    skillsFailed = failed.includes("skills");
  return (
    <div className="access-stack">
      <TeamQueryPanel query={query} label="팀 포털">
        <TeamPartial failed={failed.length > 0} retry={query.refetch} />
        <StatGrid label="팀 포털 요약">
          <StatCard label="요청" value={teamNumber(usage?.requests)} />
          <StatCard label="성공률" value={teamPercent(usage?.success_rate)} />
          <StatCard label="비용" value={teamCost(usage?.cost_krw)} />
          <StatCard label="평균 지연" value={teamLatency(usage?.avg_latency_ms)} />
          <StatCard label="API 키" value={teamNumber(keysFailed ? undefined : data?.api_key_count)} />
          <StatCard label="관측된 팀원" value={teamNumber(keysFailed ? undefined : data?.member_count)} />
          <StatCard label="사용 가능 스킬" value={teamNumber(skillsFailed ? undefined : data?.skill_count)} />
        </StatGrid>
        {!failed.includes("budgets") ? (
          <SectionCard title="팀 예산 소진" description="설정된 월 예산과 이번 달 소진 현황입니다.">
            {(data?.budgets.length ?? 0) === 0 ? (
              <EmptyState
                title="설정된 예산이 없습니다."
                description="관리자가 팀 예산을 설정하면 소진율과 예상 지출을 볼 수 있습니다."
              />
            ) : (
              <ul className="access-list">
                {data?.budgets.map((row, index) => (
                  <li key={index}>
                    <span className="access-list-title">
                      {teamCost(row.spent_krw)} / {teamCost(row.monthly_krw)}
                      <Badge
                        tone={row.on_track === undefined ? "muted" : row.on_track ? "success" : "danger"}
                      >
                        {row.on_track === undefined ? "미확인" : row.on_track ? "정상" : "초과 예상"}
                      </Badge>
                    </span>
                    {row.burn_ratio !== undefined && row.burn_ratio >= 0 ? (
                      <UsageMeter ratio={row.burn_ratio} label="팀 예산 소진율" />
                    ) : null}
                    <span className="access-list-detail">
                      소진율 {teamPercent(row.burn_ratio)} · 월말 예상 {teamCost(row.projected_krw)}
                      {row.exhaustion_date ? " · 소진 예상 " + formatDate(row.exhaustion_date) : ""}
                    </span>
                    {row.note ? <span className="access-list-detail">{row.note}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        ) : null}
        {!keysFailed ? (
          <SectionCard title="팀 API 키" description="키의 이름·상태·소유자·만료 정보입니다.">
            <TeamTable
              id="keys"
              caption="팀 API 키"
              rows={data?.api_keys ?? []}
              getRowId={(row) => row.id}
              columns={[
                { id: "name", header: "이름", value: (row) => row.name || row.id },
                { id: "id", header: "키 ID", value: (row) => row.id },
                {
                  id: "status",
                  header: "상태",
                  value: (row) => statusLabel(row.status),
                  cell: (row) => <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>,
                },
                { id: "owner", header: "소유자", value: (row) => row.owner || row.user_id },
                {
                  id: "expires",
                  header: "만료",
                  value: (row) => row.expires_at,
                  cell: (row) => (row.expires_at ? formatDateTime(row.expires_at) : "무기한"),
                },
                {
                  id: "budget",
                  header: "한도 (원)",
                  value: (row) => row.budget_limit_krw,
                  cell: (row) => teamCost(row.budget_limit_krw),
                },
              ]}
            />
          </SectionCard>
        ) : null}
        {!skillsFailed ? (
          <SectionCard title="사용 가능한 스킬" description="팀에 공개된 운영 단계의 스킬 목록입니다.">
            <TeamTable
              id="available"
              caption="사용 가능한 스킬"
              rows={data?.accessible_skills ?? []}
              columns={[
                { id: "name", header: "스킬", value: (row) => row.name },
                { id: "version", header: "버전", value: (row) => row.version },
                { id: "description", header: "설명", value: (row) => row.description },
                {
                  id: "risk",
                  header: "위험도",
                  value: (row) =>
                    (
                      ({ low: "낮음", medium: "보통", high: "높음", critical: "심각" }) as Record<
                        string,
                        string
                      >
                    )[row.risk_level] ??
                    (row.risk_level || "미확인"),
                },
              ]}
            />
          </SectionCard>
        ) : null}
        {!failed.includes("requests") ? (
          <SectionCard title="대기 중인 스킬 접근 요청" description="팀원이 신청한 스킬 접근 요청입니다.">
            <TeamTable
              id="requests"
              caption="스킬 접근 요청"
              rows={data?.pending_skill_requests ?? []}
              getRowId={(row) => row.id}
              columns={[
                { id: "name", header: "스킬", value: (row) => row.skill_name },
                { id: "user", header: "사용자", value: (row) => row.user_id },
                { id: "reason", header: "사유", value: (row) => row.reason },
                {
                  id: "created",
                  header: "신청 시각",
                  value: (row) => row.created_at,
                  cell: (row) => formatDateTime(row.created_at),
                },
              ]}
            />
          </SectionCard>
        ) : null}
        {!keysFailed ? (
          <SectionCard
            title="관측된 팀원"
            description="팀 키의 소유자와 사용량 상위 사용자에서 확인한 목록입니다. 전체 구성원 명부와는 다를 수 있습니다."
          >
            <TeamTable
              id="members"
              caption="관측된 팀원"
              rows={[...(data?.members ?? [])]
                .sort((a, b) => a.localeCompare(b, "ko"))
                .map((name) => ({ name }))}
              columns={[{ id: "name", header: "사용자", value: (row) => row.name }]}
            />
          </SectionCard>
        ) : null}
      </TeamQueryPanel>
    </div>
  );
}
