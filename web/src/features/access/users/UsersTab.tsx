import { useMemo, useRef, useState } from "react";
import { z } from "zod";

import { formatSignedRatio, statusLabel, statusTone } from "@/features/access/access-format";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { UserDetailSheet } from "@/features/access/users/UserDetailSheet";
import { accessKeys, useUserBenchmarkQuery, useUsersQuery } from "@/features/access/users/use-access-admin";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { apiClient } from "@/shared/api/client";
import type { CreateUserBody, UpdateUserBody } from "@/shared/api/domains/access";
import type { AuthUserRow, UserSummary } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatKRW, formatNumber, shortId } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "access.users";

const assignableRoles = [
  "super_admin",
  "admin",
  "ops_admin",
  "ai_admin",
  "security_admin",
  "billing_admin",
  "team_admin",
  "team_manager",
  "developer",
  "service_account",
  "viewer",
  "readonly_admin",
] as const;

const createUserSchema = z.object({
  email: z.email("올바른 이메일 주소를 입력하세요."),
  password: z.string().min(8, "비밀번호는 8자 이상이어야 합니다."),
  name: z.string(),
  role: z.string(),
  team_id: z.string(),
});
type CreateUserForm = z.infer<typeof createUserSchema>;

const updateUserSchema = z.object({
  role: z.string(),
  status: z.enum(["active", "disabled"]),
  team_id: z.string(),
});
type UpdateUserForm = z.infer<typeof updateUserSchema>;

interface UsersTabProps {
  canWrite: boolean;
  writeDeniedReason: string;
}

function accountColumns(
  teamNames: Readonly<Record<string, string>>,
  onEdit: (user: AuthUserRow, trigger: HTMLElement) => void,
  canWrite: boolean,
  writeDeniedReason: string,
): ReadonlyArray<DataTableColumn<AuthUserRow>> {
  const column = createDataTableColumnHelper<AuthUserRow>();
  return column.columns([
    column.accessor((row) => row.email, {
      id: "email",
      header: "이메일",
      cell: ({ row }) => (
        <div>
          <strong className="truncate">{row.original.email || "—"}</strong>
          <div className="access-list-detail mono">{shortId(row.original.id, 18)}</div>
        </div>
      ),
    }),
    column.accessor((row) => row.name, { id: "name", header: "이름" }),
    column.accessor((row) => row.role, {
      id: "role",
      header: "역할",
      cell: ({ getValue }) => <Badge tone="info">{getValue() || "—"}</Badge>,
    }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => <Badge tone={statusTone(getValue())}>{statusLabel(getValue())}</Badge>,
    }),
    column.accessor((row) => row.team_id, {
      id: "team",
      header: "팀",
      cell: ({ getValue }) => teamNames[getValue()] ?? (getValue() || "—"),
    }),
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "생성",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => (
        <div className="table-actions">
          <Button
            size="small"
            disabled={!canWrite || !row.original.id.startsWith("usr_")}
            title={
              !canWrite
                ? writeDeniedReason
                : row.original.id.startsWith("usr_")
                  ? undefined
                  : "SSO 등 외부에서 만들어진 계정은 이 화면에서 수정할 수 없습니다."
            }
            onClick={(event) => onEdit(row.original, event.currentTarget)}
          >
            역할·상태 변경
          </Button>
        </div>
      ),
    }),
  ]);
}

function keyUsageColumns(
  onPromote: (row: UserSummary, trigger: HTMLElement) => void,
  canWrite: boolean,
  writeDeniedReason: string,
): ReadonlyArray<DataTableColumn<UserSummary>> {
  const column = createDataTableColumnHelper<UserSummary>();
  return column.columns([
    column.accessor((row) => row.name || row.api_key_id, {
      id: "name",
      header: "사용자 / 키",
      cell: ({ row }) => (
        <div>
          <strong className="truncate">{row.original.name || "이름 없음"}</strong>
          <div className="access-list-detail mono" title={row.original.api_key_id}>
            {shortId(row.original.api_key_id, 18)}
          </div>
        </div>
      ),
    }),
    column.accessor((row) => row.owner, { id: "owner", header: "소유자" }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ row }) => (
        <div className="access-inline-actions">
          <Badge tone={statusTone(row.original.status)}>{statusLabel(row.original.status)}</Badge>
          {row.original.status === "external" ? (
            <Button
              size="small"
              disabled={!canWrite}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={(event) => onPromote(row.original, event.currentTarget)}
            >
              관리 키로 등록
            </Button>
          ) : null}
        </div>
      ),
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

export function UsersTab({ canWrite, writeDeniedReason }: UsersTabProps): React.JSX.Element {
  const users = useUsersQuery();
  const [benchmarkWindow, setBenchmarkWindow] = useState("30d");
  const benchmark = useUserBenchmarkQuery(benchmarkWindow, true);
  const [search, setSearch] = useState("");
  const [searchError, setSearchError] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AuthUserRow | undefined>();
  const [promoting, setPromoting] = useState<UserSummary | undefined>();
  const createTrigger = useRef<HTMLButtonElement>(null);
  const { returnFocusRef: dialogTrigger, remember: rememberDialogTrigger } = useReturnFocus();
  const { returnFocusRef: detailTrigger, rememberActive: rememberDetailTrigger } = useReturnFocus();

  const teamNames = users.data?.team_names;
  const authUsers = users.data?.auth_users;
  const keyUsers = users.data?.users;
  const accountRows = authUsers ?? [];
  const keyRows = keyUsers ?? [];

  const filteredKeyUsers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (keyUsers ?? []).filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (!needle) return true;
      return [row.api_key_id, row.name, row.owner, row.team].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [keyUsers, search, statusFilter]);

  const createForm = useZodForm<CreateUserForm, CreateUserForm>(createUserSchema, {
    email: "",
    password: "",
    name: "",
    role: "developer",
    team_id: "",
  });
  const editForm = useZodForm<UpdateUserForm, UpdateUserForm>(updateUserSchema, {
    role: "developer",
    status: "active",
    team_id: "",
  });

  const createUser = useMutationFeedback({
    mutate: (body: CreateUserBody) => apiClient.request(access.users.create, { body, routeId }),
    invalidates: [accessKeys.users],
    successMessage: "사용자를 등록했습니다.",
  });
  const updateUser = useMutationFeedback({
    mutate: ({ id, body }: { id: string; body: UpdateUserBody }) =>
      apiClient.request(withPathParams(access.users.update, { id }), { body, routeId }),
    invalidates: [accessKeys.users],
    successMessage: "사용자 정보를 변경했습니다.",
  });
  const promoteKey = useMutationFeedback({
    mutate: (row: UserSummary) =>
      apiClient.request(withPathParams(access.apiKeys.update, { id: row.api_key_id }), {
        body: { status: "active", name: row.name || row.api_key_id, team: row.team },
        routeId,
      }),
    invalidates: [accessKeys.users, accessKeys.apiKeys],
    successMessage: "외부 키를 관리 키로 등록했습니다.",
  });

  if (users.isPending && !users.data) return <LoadingState label="사용자 목록을 불러오는 중입니다." />;

  const benchmarkRows = benchmark.data?.users ?? [];

  return (
    <div className="access-stack">
      {users.isError ? (
        <QueryNotice
          error={users.error}
          hasData={Boolean(users.data)}
          label="사용자 목록"
          onRetry={() => void users.refetch()}
        />
      ) : null}

      <StatGrid label="사용자 요약">
        <StatCard label="로그인 계정" value={formatNumber(accountRows.length)} />
        <StatCard label="프록시 키 사용자" value={formatNumber(keyRows.length)} />
        <StatCard label="총 요청" value={formatNumber(keyRows.reduce((sum, row) => sum + row.requests, 0))} />
        <StatCard label="총 비용" value={formatKRW(keyRows.reduce((sum, row) => sum + row.cost_krw, 0))} />
      </StatGrid>

      <SectionCard
        title="로그인 계정"
        description="이메일과 비밀번호로 콘솔에 로그인하는 계정입니다. 역할·상태·팀만 변경할 수 있습니다."
        actions={
          <Button
            ref={createTrigger}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              createForm.reset({ email: "", password: "", name: "", role: "developer", team_id: "" });
              setCreateOpen(true);
            }}
          >
            사용자 등록
          </Button>
        }
      >
        {!canWrite ? <InlineNotice tone="info">{writeDeniedReason}</InlineNotice> : null}
        <DataTable
          caption="로그인 계정 목록"
          columns={accountColumns(
            teamNames ?? {},
            (user, trigger) => {
              rememberDialogTrigger(trigger);
              editForm.reset({
                role: user.role || "developer",
                status: user.status === "disabled" ? "disabled" : "active",
                team_id: user.team_id,
              });
              setEditing(user);
            },
            canWrite,
            writeDeniedReason,
          )}
          data={accountRows}
          getRowId={(row) => row.id}
          emptyMessage="등록된 로그인 계정이 없습니다. '사용자 등록'으로 첫 계정을 만드세요."
        />
      </SectionCard>

      <SectionCard
        title="프록시 키 사용량"
        description="요청 로그와 API 키를 합친 사용량입니다. 행을 선택하면 상세 사용 내역을 볼 수 있습니다."
      >
        <Toolbar label="프록시 키 사용자 필터">
          <label className="access-toolbar-field">
            <span>검색</span>
            <Input
              value={search}
              aria-invalid={searchError ? true : undefined}
              aria-describedby={searchError ? "access-user-search-error" : undefined}
              placeholder="이름, 소유자, 팀, 키 ID"
              onChange={(event) => {
                const next = event.target.value;
                if (containsPotentialSecret(next)) {
                  setSearchError(secretSearchMessage);
                  return;
                }
                setSearchError(undefined);
                setSearch(next);
              }}
            />
          </label>
          <label className="access-toolbar-field">
            <span>상태</span>
            <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">전체</option>
              <option value="active">사용</option>
              <option value="disabled">중지</option>
              <option value="revoked">폐기</option>
              <option value="external">외부 키</option>
            </Select>
          </label>
        </Toolbar>
        {searchError ? (
          <p className="form-error" id="access-user-search-error" role="alert">
            {searchError}
          </p>
        ) : null}
        <DataTable
          caption="프록시 키 사용량"
          columns={keyUsageColumns(
            (row, trigger) => {
              rememberDialogTrigger(trigger);
              setPromoting(row);
            },
            canWrite,
            writeDeniedReason,
          )}
          data={filteredKeyUsers}
          getRowId={(row) => row.api_key_id}
          getRowActionLabel={(row) => `${row.name || row.api_key_id} 상세 열기`}
          onRowClick={(row) => {
            rememberDetailTrigger();
            setSelectedKeyId(row.api_key_id);
          }}
          emptyMessage="조건에 맞는 사용자가 없습니다."
        />
        <UpdatedAt at={users.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="AI 활용지수"
        description="요청, 세션, 커밋과 병합 요청을 합산한 사용자별 활용 점수입니다."
        actions={
          <label className="access-toolbar-field">
            <span>기간</span>
            <Select value={benchmarkWindow} onChange={(event) => setBenchmarkWindow(event.target.value)}>
              <option value="7d">7일</option>
              <option value="30d">30일</option>
            </Select>
          </label>
        }
      >
        {benchmark.isError ? (
          <QueryNotice
            error={benchmark.error}
            hasData={Boolean(benchmark.data)}
            label="AI 활용지수"
            onRetry={() => void benchmark.refetch()}
          />
        ) : null}
        {benchmarkRows.length === 0 && !benchmark.isPending ? (
          <EmptyState
            title="활용지수를 계산할 데이터가 없습니다."
            description="선택한 기간에 요청이 기록되면 사용자별 점수가 채워집니다."
          />
        ) : (
          <DataTable
            caption="사용자 AI 활용지수"
            loading={benchmark.isPending}
            columns={benchmarkColumns()}
            data={benchmarkRows}
            getRowId={(row, index) => `${row.api_key_id}-${String(index)}`}
          />
        )}
      </SectionCard>

      <FormDialog
        form={createForm}
        open={createOpen}
        onOpenChange={setCreateOpen}
        returnFocusRef={createTrigger}
        title="사용자 등록"
        description="콘솔에 로그인할 계정을 만듭니다. 내 역할보다 낮은 역할만 부여할 수 있습니다."
        submitLabel="등록"
        onSubmit={async (values) => {
          await createUser.mutateAsync({
            email: values.email,
            password: values.password,
            ...(values.name ? { name: values.name } : {}),
            role: values.role,
            ...(values.team_id ? { team_id: values.team_id } : {}),
          });
          setCreateOpen(false);
        }}
      >
        <FormField label="이메일" required error={createForm.formState.errors.email?.message}>
          {(control) => <Input {...control} type="email" {...createForm.register("email")} />}
        </FormField>
        <FormField
          label="비밀번호"
          required
          description="8자 이상. 등록 후에는 이 화면에서 변경할 수 없습니다."
          error={createForm.formState.errors.password?.message}
        >
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              {...createForm.register("password")}
            />
          )}
        </FormField>
        <FormField label="이름">
          {(control) => <Input {...control} {...createForm.register("name")} />}
        </FormField>
        <FormField label="역할">
          {(control) => (
            <Select {...control} {...createForm.register("role")}>
              {assignableRoles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="팀" description="팀 ID 또는 팀 이름. 비우면 팀 없이 등록합니다.">
          {(control) => <Input {...control} {...createForm.register("team_id")} />}
        </FormField>
      </FormDialog>

      <FormDialog
        form={editForm}
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
        returnFocusRef={dialogTrigger}
        title="사용자 변경"
        description={`${editing?.email ?? ""} 계정의 역할, 상태, 팀을 변경합니다. 이름과 비밀번호는 변경할 수 없습니다.`}
        onSubmit={async (values) => {
          if (!editing) return;
          await updateUser.mutateAsync({
            id: editing.id,
            body: { role: values.role, status: values.status, team_id: values.team_id },
          });
          setEditing(undefined);
        }}
      >
        <FormField label="역할">
          {(control) => (
            <Select {...control} {...editForm.register("role")}>
              {assignableRoles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="상태" description="중지하면 해당 사용자의 모든 세션이 즉시 폐기됩니다.">
          {(control) => (
            <Select {...control} {...editForm.register("status")}>
              <option value="active">사용</option>
              <option value="disabled">중지</option>
            </Select>
          )}
        </FormField>
        <FormField label="팀" description="팀 ID 또는 팀 이름. 비우면 팀 배정을 해제합니다.">
          {(control) => <Input {...control} {...editForm.register("team_id")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={promoting !== undefined}
        onOpenChange={(open) => {
          if (!open) setPromoting(undefined);
        }}
        returnFocusRef={dialogTrigger}
        title="관리 키로 등록"
        description={`${promoting?.name || promoting?.api_key_id || ""} 키를 관리 대상(사용 상태)으로 전환합니다.`}
        confirmLabel="등록"
        onConfirm={async () => {
          if (promoting) await promoteKey.mutateAsync(promoting);
          setPromoting(undefined);
        }}
      />

      <UserDetailSheet
        apiKeyId={selectedKeyId}
        onClose={() => setSelectedKeyId("")}
        returnFocusRef={detailTrigger}
      />
    </div>
  );
}

function benchmarkColumns(): ReadonlyArray<
  DataTableColumn<{
    api_key_id: string;
    name: string;
    team: string;
    requests: number;
    sessions: number;
    active_days: number;
    commits: number;
    merged_mrs: number;
    tool_calls: number;
    success_rate: number;
    cost_krw: number;
    score: number;
  }>
> {
  const column = createDataTableColumnHelper<{
    api_key_id: string;
    name: string;
    team: string;
    requests: number;
    sessions: number;
    active_days: number;
    commits: number;
    merged_mrs: number;
    tool_calls: number;
    success_rate: number;
    cost_krw: number;
    score: number;
  }>();
  return column.columns([
    column.accessor((row) => row.name || row.api_key_id, { id: "name", header: "사용자" }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.score, {
      id: "score",
      header: "점수",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue(), 1)}</span>,
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.sessions, {
      id: "sessions",
      header: "세션",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.active_days, {
      id: "active_days",
      header: "활동일",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.commits, {
      id: "commits",
      header: "커밋",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.merged_mrs, {
      id: "merged_mrs",
      header: "병합 MR",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.success_rate, {
      id: "success_rate",
      header: "성공률",
      cell: ({ getValue }) => <span className="cell-number">{formatSignedRatio(getValue())}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost",
      header: "비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
  ]);
}
