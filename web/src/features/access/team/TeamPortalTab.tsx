import { formatSignedRatio, statusLabel, statusTone } from "@/features/access/access-format";
import { QueryNotice, UpdatedAt, UsageMeter } from "@/features/access/access-ui";
import { useTeamPortalQuery } from "@/features/access/team/use-team-queries";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { formatDate, formatDateTime, formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";

export function TeamPortalTab({ team }: { team: string }): React.JSX.Element {
  const portal = useTeamPortalQuery(team, true);

  if (portal.isPending && !portal.data) return <LoadingState label="팀 포털을 불러오는 중입니다." />;

  const data = portal.data;
  const usage = data?.usage;

  return (
    <div className="access-stack">
      {portal.isError ? (
        <QueryNotice
          error={portal.error}
          hasData={Boolean(portal.data)}
          label="팀 포털"
          onRetry={() => void portal.refetch()}
        />
      ) : null}

      <StatGrid label="팀 포털 요약">
        <StatCard label="요청" value={formatNumber(usage?.requests)} />
        <StatCard label="성공률" value={formatSignedRatio(usage?.success_rate)} />
        <StatCard label="비용" value={formatKRW(usage?.cost_krw)} />
        <StatCard label="평균 지연" value={formatDuration(usage?.avg_latency_ms)} />
        <StatCard label="API 키" value={formatNumber(data?.api_key_count)} />
        <StatCard label="팀원" value={formatNumber(data?.member_count)} />
        <StatCard label="사용 가능 Skill" value={formatNumber(data?.skill_count)} />
      </StatGrid>

      <div className="access-cards">
        <SectionCard title="팀 예산 소진" description="설정된 월 예산과 이번 달 소진 현황입니다.">
          {(data?.budgets ?? []).length === 0 ? (
            <EmptyState
              title="설정된 예산이 없습니다."
              description="관리자가 팀 예산을 설정하면 소진율과 예상 지출을 볼 수 있습니다."
            />
          ) : (
            <ul className="access-list">
              {(data?.budgets ?? []).map((row, index) => (
                <li key={index}>
                  <span className="access-list-title">
                    {formatKRW(row.spent_krw)} / {formatKRW(row.monthly_krw)}
                    <Badge tone={row.on_track ? "success" : "danger"}>
                      {row.on_track ? "정상" : "초과 예상"}
                    </Badge>
                  </span>
                  <UsageMeter ratio={row.burn_ratio} label="팀 예산 소진율" />
                  <span className="access-list-detail">
                    소진율 {formatSignedRatio(row.burn_ratio)} · 월말 예상 {formatKRW(row.projected_krw)}
                    {row.exhaustion_date ? ` · 소진 예상 ${formatDate(row.exhaustion_date)}` : ""}
                  </span>
                  {row.note ? <span className="access-list-detail">{row.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="팀 API 키" description="비밀값은 표시하지 않습니다. 상태와 만료만 확인합니다.">
          {(data?.api_keys ?? []).length === 0 ? (
            <EmptyState
              title="팀에 발급된 키가 없습니다."
              description="관리자가 팀 키를 발급하면 여기에 나타납니다."
            />
          ) : (
            <ul className="access-list">
              {(data?.api_keys ?? []).map((row) => (
                <li key={row.id}>
                  <span className="access-list-title">
                    {row.name || row.id}
                    <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
                  </span>
                  <span className="access-list-detail mono">{row.id}</span>
                  <span className="access-list-detail">
                    {row.owner ? `소유자 ${row.owner} · ` : ""}
                    {row.expires_at ? `만료 ${formatDateTime(row.expires_at)}` : "무기한"}
                    {row.budget_limit_krw > 0 ? ` · 한도 ${formatKRW(row.budget_limit_krw)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="사용 가능한 Skill" description="팀에 열려 있는 Skill 목록입니다.">
          {(data?.accessible_skills ?? []).length === 0 ? (
            <EmptyState
              title="열려 있는 Skill이 없습니다."
              description="관리자가 Skill을 팀에 배포하면 여기에 표시됩니다."
            />
          ) : (
            <ul className="access-list">
              {(data?.accessible_skills ?? []).map((row) => (
                <li key={row.name}>
                  <span className="access-list-title">
                    {row.name}
                    {row.version ? <Badge tone="muted">{row.version}</Badge> : null}
                  </span>
                  <span className="access-list-detail">{row.description}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="대기 중인 Skill 접근 요청" description="팀원이 신청한 Skill 접근 요청입니다.">
          {(data?.pending_skill_requests ?? []).length === 0 ? (
            <EmptyState
              title="대기 중인 요청이 없습니다."
              description="팀원이 Skill 접근을 신청하면 여기에 모입니다."
            />
          ) : (
            <ul className="access-list">
              {(data?.pending_skill_requests ?? []).map((row) => (
                <li key={row.id}>
                  <span className="access-list-title">{row.skill_name}</span>
                  <span className="access-list-detail mono">{row.user_id}</span>
                  <span className="access-list-detail">
                    {row.reason} · {formatDateTime(row.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="팀원"
          description="서버는 순서를 보장하지 않으므로 이름순으로 정렬해 보여 줍니다."
        >
          {(data?.members ?? []).length === 0 ? (
            <EmptyState title="등록된 팀원이 없습니다." description="사용자에게 팀을 배정하면 채워집니다." />
          ) : (
            <span className="badge-list">
              {[...(data?.members ?? [])]
                .sort((left, right) => left.localeCompare(right))
                .map((member) => (
                  <Badge key={member} tone="muted">
                    {member}
                  </Badge>
                ))}
            </span>
          )}
        </SectionCard>
      </div>

      {data?.note ? <InlineNotice tone="info">{data.note}</InlineNotice> : null}
      <UpdatedAt at={portal.dataUpdatedAt} />
    </div>
  );
}
