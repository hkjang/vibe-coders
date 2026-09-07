import { useRef, useState } from "react";
import { z } from "zod";

import { formatSignedRatio, formatSignedScore } from "@/features/access/access-format";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { TeamDetailSheet } from "@/features/access/users/TeamDetailSheet";
import {
  accessKeys,
  useTeamBenchmarkQuery,
  useTeamScorecardQuery,
  useTeamsQuery,
} from "@/features/access/users/use-access-admin";
import { apiClient } from "@/shared/api/client";
import type { CreateTeamBody } from "@/shared/api/domains/access";
import type { AuthTeamRow, TeamSummary } from "@/shared/api/domains/access.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "access.users";

const teamSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "팀 이름을 입력하세요."),
});
type TeamForm = z.infer<typeof teamSchema>;

function gradeTone(grade: string): "danger" | "info" | "muted" | "success" | "warning" {
  switch (grade) {
    case "A":
      return "success";
    case "B":
      return "info";
    case "C":
      return "warning";
    case "D":
      return "danger";
    default:
      return "muted";
  }
}

function usageColumns(): ReadonlyArray<DataTableColumn<TeamSummary>> {
  const column = createDataTableColumnHelper<TeamSummary>();
  return column.columns([
    column.accessor((row) => row.team, {
      id: "team",
      header: "팀",
      cell: ({ getValue }) => <strong>{getValue() || "미지정"}</strong>,
    }),
    column.accessor((row) => row.keys, {
      id: "keys",
      header: "API 키",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.tokens, {
      id: "tokens",
      header: "토큰",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost",
      header: "비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.average_latency_ms, {
      id: "latency",
      header: "평균 지연",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}ms</span>,
    }),
    column.accessor((row) => row.last_seen, {
      id: "last_seen",
      header: "최근 사용",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
  ]);
}

function registeredColumns(): ReadonlyArray<DataTableColumn<AuthTeamRow>> {
  const column = createDataTableColumnHelper<AuthTeamRow>();
  return column.columns([
    column.accessor((row) => row.name, { id: "name", header: "팀 이름" }),
    column.accessor((row) => row.id, {
      id: "id",
      header: "팀 ID",
      cell: ({ getValue }) => <span className="mono">{getValue()}</span>,
    }),
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "생성",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
    column.accessor((row) => row.updated_at, {
      id: "updated_at",
      header: "수정",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
  ]);
}

interface TeamsTabProps {
  canWrite: boolean;
  writeDeniedReason: string;
}

export function TeamsTab({ canWrite, writeDeniedReason }: TeamsTabProps): React.JSX.Element {
  const teams = useTeamsQuery();
  const [window, setWindow] = useState("30d");
  const scorecard = useTeamScorecardQuery(window, true);
  const benchmark = useTeamBenchmarkQuery(window, true);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState("");
  const createTrigger = useRef<HTMLButtonElement>(null);
  const detailTrigger = useRef<HTMLElement>(null);

  const form = useZodForm<TeamForm, TeamForm>(teamSchema, { id: "", name: "" });
  const saveTeam = useMutationFeedback({
    mutate: (body: CreateTeamBody) => apiClient.request(access.teams.create, { body, routeId }),
    invalidates: [accessKeys.teams, accessKeys.users],
    successMessage: "팀을 저장했습니다.",
  });

  if (teams.isPending && !teams.data) return <LoadingState label="팀 목록을 불러오는 중입니다." />;

  const usage = teams.data?.teams ?? [];
  const registered = teams.data?.auth_teams ?? [];
  const scorecardRows = scorecard.data?.teams ?? [];
  const benchmarkRows = benchmark.data?.teams ?? [];

  return (
    <div className="access-stack">
      {teams.isError ? (
        <QueryNotice
          error={teams.error}
          hasData={Boolean(teams.data)}
          label="팀 목록"
          onRetry={() => void teams.refetch()}
        />
      ) : null}

      <StatGrid label="팀 요약">
        <StatCard label="등록 팀" value={formatNumber(registered.length)} />
        <StatCard label="사용 기록이 있는 팀" value={formatNumber(usage.length)} />
        <StatCard label="총 요청" value={formatNumber(usage.reduce((sum, row) => sum + row.requests, 0))} />
        <StatCard label="총 비용" value={formatKRW(usage.reduce((sum, row) => sum + row.cost_krw, 0))} />
      </StatGrid>

      <InlineNotice tone="info" title="팀 배정은 사용자 화면에서 합니다.">
        멤버를 직접 추가·제거하는 API는 없습니다. 사용자 탭에서 계정의 팀을 바꾸면 팀 구성이 바뀝니다. API
        키의 팀은 별도의 자유 입력 값입니다.
      </InlineNotice>

      <SectionCard
        title="등록된 팀"
        description="팀 ID와 이름을 관리합니다. 같은 ID로 저장하면 이름이 갱신됩니다."
        actions={
          <Button
            ref={createTrigger}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              form.reset({ id: "", name: "" });
              setCreateOpen(true);
            }}
          >
            팀 추가
          </Button>
        }
      >
        {!canWrite ? <InlineNotice tone="info">{writeDeniedReason}</InlineNotice> : null}
        <DataTable
          caption="등록된 팀 목록"
          columns={registeredColumns()}
          data={registered}
          getRowId={(row) => row.id}
          emptyMessage="등록된 팀이 없습니다. '팀 추가'로 첫 팀을 만드세요."
        />
      </SectionCard>

      <SectionCard title="팀별 사용량" description="행을 선택하면 팀 상세 사용 내역을 볼 수 있습니다.">
        <DataTable
          caption="팀별 사용량"
          columns={usageColumns()}
          data={usage}
          getRowId={(row) => row.team}
          getRowActionLabel={(row) => `${row.team} 상세 열기`}
          onRowClick={(row) => {
            detailTrigger.current = document.activeElement as HTMLElement | null;
            setSelectedTeam(row.team);
          }}
          emptyMessage="집계된 팀 사용량이 없습니다."
        />
        <UpdatedAt at={teams.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="팀 성숙도 스코어카드"
        description="비용 효율, 성공률, 캐시 활용 등을 종합한 등급입니다. 값이 없는 항목은 대시로 표시합니다."
        actions={
          <label className="access-toolbar-field">
            <span>기간</span>
            <Select value={window} onChange={(event) => setWindow(event.target.value)}>
              <option value="7d">7일</option>
              <option value="30d">30일</option>
            </Select>
          </label>
        }
      >
        {scorecard.isError ? (
          <QueryNotice
            error={scorecard.error}
            hasData={Boolean(scorecard.data)}
            label="팀 스코어카드"
            onRetry={() => void scorecard.refetch()}
          />
        ) : null}
        {scorecardRows.length === 0 && !scorecard.isPending ? (
          <EmptyState
            title="스코어카드를 계산할 데이터가 없습니다."
            description="선택한 기간에 팀 요청이 쌓이면 등급이 계산됩니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="팀 성숙도 스코어카드 표 영역">
            <table className="data-table">
              <caption className="sr-only">팀 성숙도 스코어카드</caption>
              <thead>
                <tr>
                  <th scope="col">팀</th>
                  <th scope="col">등급</th>
                  <th scope="col">종합</th>
                  <th scope="col">성공률</th>
                  <th scope="col">캐시</th>
                  <th scope="col">Skill 재사용</th>
                  <th scope="col">정책 준수</th>
                  <th scope="col">비용</th>
                </tr>
              </thead>
              <tbody>
                {scorecardRows.map((row) => (
                  <tr key={row.team}>
                    <td>{row.team || "미지정"}</td>
                    <td>
                      <Badge tone={gradeTone(row.grade)}>{row.grade || "—"}</Badge>
                    </td>
                    <td className="cell-number">{formatSignedScore(row.overall)}</td>
                    <td className="cell-number">{formatSignedRatio(row.success_rate)}</td>
                    <td className="cell-number">{formatSignedRatio(row.cache_rate)}</td>
                    <td className="cell-number">{formatSignedRatio(row.skill_reuse)}</td>
                    <td className="cell-number">{formatSignedRatio(row.policy_compliance)}</td>
                    <td className="cell-number">{formatKRW(row.cost_krw)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {scorecard.data?.note ? <p className="access-note">{scorecard.data.note}</p> : null}
      </SectionCard>

      <SectionCard title="팀 벤치마크" description="팀별 활동 사용자와 성과 점수입니다.">
        {benchmark.isError ? (
          <QueryNotice
            error={benchmark.error}
            hasData={Boolean(benchmark.data)}
            label="팀 벤치마크"
            onRetry={() => void benchmark.refetch()}
          />
        ) : null}
        {benchmarkRows.length === 0 && !benchmark.isPending ? (
          <EmptyState
            title="벤치마크 데이터가 없습니다."
            description="선택한 기간에 팀 요청이 기록되면 점수가 채워집니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="팀 벤치마크 표 영역">
            <table className="data-table">
              <caption className="sr-only">팀 벤치마크</caption>
              <thead>
                <tr>
                  <th scope="col">팀</th>
                  <th scope="col">활동 사용자</th>
                  <th scope="col">요청</th>
                  <th scope="col">성공률</th>
                  <th scope="col">커밋</th>
                  <th scope="col">병합 MR</th>
                  <th scope="col">점수</th>
                </tr>
              </thead>
              <tbody>
                {benchmarkRows.map((row) => (
                  <tr key={row.team}>
                    <td>{row.team || "미지정"}</td>
                    <td className="cell-number">{formatNumber(row.active_users)}</td>
                    <td className="cell-number">{formatNumber(row.requests)}</td>
                    <td className="cell-number">{formatSignedRatio(row.success_rate)}</td>
                    <td className="cell-number">{formatNumber(row.commits)}</td>
                    <td className="cell-number">{formatNumber(row.merged_mrs)}</td>
                    <td className="cell-number">{formatNumber(row.score, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <FormDialog
        form={form}
        open={createOpen}
        onOpenChange={setCreateOpen}
        returnFocusRef={createTrigger}
        title="팀 추가"
        description="팀 ID를 비우면 서버가 새 ID를 만듭니다. 기존 ID를 넣으면 이름이 갱신됩니다."
        onSubmit={async (values) => {
          await saveTeam.mutateAsync({
            ...(values.id ? { id: values.id } : {}),
            name: values.name,
          });
          setCreateOpen(false);
        }}
      >
        <FormField label="팀 이름" required error={form.formState.errors.name?.message}>
          {(control) => <Input {...control} {...form.register("name")} />}
        </FormField>
        <FormField label="팀 ID" description="비우면 자동으로 생성합니다.">
          {(control) => <Input {...control} {...form.register("id")} />}
        </FormField>
      </FormDialog>

      <TeamDetailSheet
        team={selectedTeam}
        onClose={() => setSelectedTeam("")}
        returnFocusRef={detailTrigger}
      />
    </div>
  );
}
