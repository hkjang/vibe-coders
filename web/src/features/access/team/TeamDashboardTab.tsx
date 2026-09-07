import { formatSignedRatio, httpTone, severityTone, statusTone } from "@/features/access/access-format";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import {
  useTeamCandidatesQuery,
  useTeamDashboardQuery,
  useTeamOnboardingQuery,
  useTeamReportsQuery,
  useTeamRiskQuery,
  useTeamSavingsQuery,
  useTeamSkillsQuery,
} from "@/features/access/team/use-team-queries";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { formatDateTime, formatDuration, formatKRW, formatNumber, shortId } from "@/shared/utils/format";

export function TeamDashboardTab({ team }: { team: string }): React.JSX.Element {
  const dashboard = useTeamDashboardQuery(team, true);
  const reports = useTeamReportsQuery(team, true);
  const savings = useTeamSavingsQuery(team, true);
  const onboarding = useTeamOnboardingQuery(team, true);
  const risk = useTeamRiskQuery(team, true);
  const skills = useTeamSkillsQuery(team, true);
  const candidates = useTeamCandidatesQuery(team, true);

  if (dashboard.isPending && !dashboard.data) {
    return <LoadingState label="팀 대시보드를 불러오는 중입니다." />;
  }

  const board = dashboard.data?.dashboard;
  const totals = board?.totals;
  const reportRows = reports.data?.reports ?? [];
  const pendingReports = reportRows.filter((row) => row.approval_status === "pending");

  return (
    <div className="access-stack">
      {dashboard.isError ? (
        <QueryNotice
          error={dashboard.error}
          hasData={Boolean(dashboard.data)}
          label="팀 대시보드"
          onRetry={() => void dashboard.refetch()}
        />
      ) : null}

      <StatGrid label="팀 사용 요약">
        <StatCard label="요청" value={formatNumber(totals?.requests)} />
        <StatCard label="성공률" value={formatSignedRatio(totals?.success_rate)} />
        <StatCard
          label="오류"
          tone={(totals?.errors ?? 0) > 0 ? "warning" : "default"}
          value={formatNumber(totals?.errors)}
        />
        <StatCard label="비용" value={formatKRW(totals?.cost_krw)} />
        <StatCard label="평균 지연" value={formatDuration(totals?.avg_latency_ms)} />
        <StatCard label="팀 키" value={formatNumber(board?.team_keys.length)} />
      </StatGrid>

      <div className="access-cards">
        <SectionCard
          title="팀원 사용량 Top"
          description="사용자 ID 기준 집계입니다. 서버는 이메일을 제공하지 않습니다."
        >
          {(board?.top_users ?? []).length === 0 ? (
            <EmptyState
              title="집계된 사용량이 없습니다."
              description="팀원이 요청을 보내면 여기에 쌓입니다."
            />
          ) : (
            <ul className="access-list">
              {(board?.top_users ?? []).map((row, index) => (
                <li key={`${row.user_id}-${String(index)}`}>
                  <span className="access-list-title mono">{shortId(row.user_id, 20)}</span>
                  <span className="access-list-detail">
                    요청 {formatNumber(row.requests)} · {formatKRW(row.cost_krw)} · 오류{" "}
                    {formatNumber(row.errors)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="팀 모델 사용" description="요청 수 기준 상위 모델입니다.">
          {(board?.models ?? []).length === 0 ? (
            <EmptyState title="집계된 모델이 없습니다." description="요청이 쌓이면 모델 분포가 보입니다." />
          ) : (
            <ul className="access-list">
              {(board?.models ?? []).map((row, index) => (
                <li key={`${row.model}-${String(index)}`}>
                  <span className="access-list-title">{row.model || "—"}</span>
                  <span className="access-list-detail">
                    요청 {formatNumber(row.requests)} · {formatKRW(row.cost_krw)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="팀 최근 실패" description="가장 최근에 실패한 팀 요청입니다.">
          {(board?.recent_failures ?? []).length === 0 ? (
            <EmptyState
              title="최근 실패가 없습니다."
              description="실패한 요청이 생기면 원인을 함께 봅니다."
            />
          ) : (
            <ul className="access-list">
              {(board?.recent_failures ?? []).map((row, index) => (
                <li key={`${row.id}-${String(index)}`}>
                  <span className="access-list-title">
                    <Badge tone={httpTone(row.status_code)}>{row.status_code || "오류"}</Badge>
                    {row.model || "모델 미상"}
                  </span>
                  <span className="access-list-detail">{row.error}</span>
                  <span className="access-list-detail">{formatDateTime(row.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="비용 절감 챌린지" description="이번 달 지출과 지난달 대비 예상 절감액입니다.">
          {savings.isError ? (
            <QueryNotice
              error={savings.error}
              hasData={Boolean(savings.data)}
              label="절감 챌린지"
              onRetry={() => void savings.refetch()}
            />
          ) : savings.data ? (
            <StatGrid label="절감 챌린지 지표">
              <StatCard label="이번 달" value={formatKRW(savings.data.month_to_date_krw)} />
              <StatCard label="월말 예상" value={formatKRW(savings.data.projected_month_end_krw)} />
              <StatCard label="지난달" value={formatKRW(savings.data.last_month_krw)} />
              <StatCard
                label="예상 절감"
                tone={savings.data.on_track ? "success" : "warning"}
                value={formatKRW(savings.data.projected_savings_krw)}
                hint={savings.data.on_track ? "목표 진행 중" : "목표 미달"}
              />
            </StatGrid>
          ) : null}
        </SectionCard>

        <SectionCard title="팀 위험 신호" description="최근 7일 정책 차단과 승인 대기 현황입니다.">
          {risk.isError ? (
            <QueryNotice
              error={risk.error}
              hasData={Boolean(risk.data)}
              label="팀 위험 신호"
              onRetry={() => void risk.refetch()}
            />
          ) : risk.data ? (
            <div className="access-stack">
              <StatGrid label="팀 위험 지표">
                <StatCard
                  label="차단"
                  tone={risk.data.blocked > 0 ? "danger" : "default"}
                  value={formatNumber(risk.data.blocked)}
                  hint={risk.data.blocked_trend || undefined}
                />
                <StatCard label="경고" value={formatNumber(risk.data.warned)} />
                <StatCard label="Secret 탐지" value={formatNumber(risk.data.secrets_total)} />
                <StatCard label="승인 대기" value={formatNumber(risk.data.pending_approvals)} />
              </StatGrid>
              {risk.data.recent_violations.length > 0 ? (
                <ul className="access-list">
                  {risk.data.recent_violations.map((row, index) => (
                    <li key={`${row.rule}-${String(index)}`}>
                      <span className="access-list-title">
                        <Badge tone={severityTone(row.decision)}>{row.decision || "—"}</Badge>
                        {row.rule || "규칙 미상"}
                      </span>
                      <span className="access-list-detail">
                        {row.reason} · {row.endpoint} · {formatDateTime(row.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </SectionCard>

        <SectionCard title="팀 인기 Skill" description="최근 30일 실행 기준입니다.">
          {skills.isError ? (
            <QueryNotice
              error={skills.error}
              hasData={Boolean(skills.data)}
              label="팀 인기 Skill"
              onRetry={() => void skills.refetch()}
            />
          ) : (skills.data?.skills ?? []).length === 0 ? (
            <EmptyState title="실행된 Skill이 없습니다." description="팀원이 Skill을 쓰면 순위가 생깁니다." />
          ) : (
            <ul className="access-list">
              {(skills.data?.skills ?? []).map((row, index) => (
                <li key={`${row.skill_name}-${String(index)}`}>
                  <span className="access-list-title">{row.skill_name}</span>
                  <span className="access-list-detail">
                    실행 {formatNumber(row.runs)} · 성공률 {formatSignedRatio(row.success_rate)} ·{" "}
                    {formatKRW(row.total_cost_krw)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="팀 온보딩 팩" description="새 팀원에게 권할 모델과 MCP 도구입니다.">
          {onboarding.isError ? (
            <QueryNotice
              error={onboarding.error}
              hasData={Boolean(onboarding.data)}
              label="팀 온보딩 팩"
              onRetry={() => void onboarding.refetch()}
            />
          ) : (onboarding.data?.recommended_mcp ?? []).length === 0 ? (
            <EmptyState
              title="추천할 항목이 아직 없습니다."
              description="팀 사용 기록이 쌓이면 추천 모델과 도구를 만들어 드립니다."
            />
          ) : (
            <ul className="access-list">
              {(onboarding.data?.recommended_mcp ?? []).map((row, index) => (
                <li key={`${row.ref}-${String(index)}`}>
                  <span className="access-list-title">
                    {row.server_label} / {row.tool_name}
                  </span>
                  <span className="access-list-detail">
                    호출 {formatNumber(row.calls)} · 성공률 {formatSignedRatio(row.success_rate)} · 평균{" "}
                    {formatDuration(row.avg_latency_ms)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {onboarding.data?.note ? <p className="access-note">{onboarding.data.note}</p> : null}
        </SectionCard>

        <SectionCard title="추천 템플릿 후보" description="반복되는 질문 패턴을 템플릿으로 만들 후보입니다.">
          {candidates.isError ? (
            <QueryNotice
              error={candidates.error}
              hasData={Boolean(candidates.data)}
              label="템플릿 후보"
              onRetry={() => void candidates.refetch()}
            />
          ) : (candidates.data?.candidates ?? []).length === 0 ? (
            <EmptyState
              title="후보가 없습니다."
              description="같은 형태의 요청이 3회 이상 반복되면 후보로 제안합니다."
            />
          ) : (
            <ul className="access-list">
              {(candidates.data?.candidates ?? []).map((row) => (
                <li key={row.fingerprint}>
                  <span className="access-list-title">
                    {row.task_type || "작업 유형 미상"}
                    {row.already_product ? <Badge tone="success">이미 상품화</Badge> : null}
                  </span>
                  <span className="access-list-detail mono">{shortId(row.fingerprint, 20)}</span>
                  <span className="access-list-detail">
                    요청 {formatNumber(row.requests)} · 평균 {formatKRW(row.avg_cost_krw)} · 성공률{" "}
                    {formatSignedRatio(row.success_rate)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="팀 공용 리포트"
        description={`승인 대기 ${formatNumber(pendingReports.length)}건을 포함한 팀 리포트 목록입니다.`}
      >
        <InlineNotice tone="info" title="승인과 반려는 기존 화면에서 하세요.">
          이 UI 버전의 API 목록에 팀 리포트 승인·반려 경로가 포함되어 있지 않아 여기서는 조회만 할 수
          있습니다.
        </InlineNotice>
        {reports.isError ? (
          <QueryNotice
            error={reports.error}
            hasData={Boolean(reports.data)}
            label="팀 리포트"
            onRetry={() => void reports.refetch()}
          />
        ) : null}
        {reportRows.length === 0 ? (
          <EmptyState
            title="공유된 리포트가 없습니다."
            description="팀원이 저장한 리포트를 팀에 제출하면 여기에서 확인할 수 있습니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="팀 공용 리포트 표 영역">
            <table className="data-table">
              <caption className="sr-only">팀 공용 리포트</caption>
              <thead>
                <tr>
                  <th scope="col">이름</th>
                  <th scope="col">승인 상태</th>
                  <th scope="col">종류</th>
                  <th scope="col">스키마</th>
                  <th scope="col">작성자</th>
                  <th scope="col">생성</th>
                  <th scope="col">최근 실행</th>
                </tr>
              </thead>
              <tbody>
                {reportRows.map((row) => (
                  <tr key={row.id}>
                    <td className="truncate">{row.name}</td>
                    <td>
                      <Badge tone={statusTone(row.approval_status)}>{row.approval_status || "—"}</Badge>
                    </td>
                    <td>{row.kind}</td>
                    <td>{row.schema_name}</td>
                    <td className="mono truncate">{shortId(row.created_by, 16)}</td>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td>{row.last_run_at ? formatDateTime(row.last_run_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <UpdatedAt at={dashboard.dataUpdatedAt} />
    </div>
  );
}
