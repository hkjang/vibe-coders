import { useMemo, useRef, useState } from "react";
import { z } from "zod";

import { statusLabel, statusTone } from "@/features/access/access-format";
import { QueryNotice, ScopeBadges, UpdatedAt } from "@/features/access/access-ui";
import { accessKeys, useApiKeysQuery } from "@/features/access/users/use-access-admin";
import { useReturnFocus } from "@/features/access/use-return-focus";
import { apiClient } from "@/shared/api/client";
import { withPathParams, type CreateApiKeyBody, type UpdateApiKeyBody } from "@/shared/api/domains/access";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, shortId } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "access.users";

const allScopes = [
  "chat:completion",
  "embeddings:create",
  "models:read",
  "admin:read",
  "admin:write",
  "routing:read",
  "routing:write",
  "observability:read",
  "costs:read",
  "security:read",
  "mcp:use",
  "mcp:admin",
  "team:read",
] as const;

const createKeySchema = z.object({
  name: z.string().min(1, "키 이름을 입력하세요."),
  owner: z.string(),
  team: z.string(),
  role: z.string(),
  allowed_ips: z.string(),
  allowed_models: z.string(),
  denied_models: z.string(),
  budget_limit_krw: z.string(),
  expires_at: z.string(),
});
type CreateKeyForm = z.infer<typeof createKeySchema>;

const editKeySchema = z.object({
  name: z.string(),
  owner: z.string(),
  team: z.string(),
  role: z.string(),
  status: z.enum(["active", "disabled"]),
});
type EditKeyForm = z.infer<typeof editKeySchema>;

function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function keyColumns(
  onEdit: (row: ApiKeyPublic, trigger: HTMLElement) => void,
  onScopes: (row: ApiKeyPublic, trigger: HTMLElement) => void,
  onRevoke: (row: ApiKeyPublic, trigger: HTMLElement) => void,
  canWrite: boolean,
  writeDeniedReason: string,
): ReadonlyArray<DataTableColumn<ApiKeyPublic>> {
  const column = createDataTableColumnHelper<ApiKeyPublic>();
  return column.columns([
    column.accessor((row) => row.name, {
      id: "name",
      header: "이름",
      cell: ({ row }) => (
        <div>
          <strong className="truncate">{row.original.name || "이름 없음"}</strong>
          <div className="access-list-detail mono" title={row.original.id}>
            {shortId(row.original.id, 18)}
          </div>
        </div>
      ),
    }),
    column.accessor((row) => row.owner, { id: "owner", header: "소유자" }),
    column.accessor((row) => row.team, { id: "team", header: "팀" }),
    column.accessor((row) => row.role, {
      id: "role",
      header: "역할",
      cell: ({ getValue }) => (getValue() ? <Badge tone="info">{getValue()}</Badge> : "—"),
    }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => <Badge tone={statusTone(getValue())}>{statusLabel(getValue())}</Badge>,
    }),
    column.accessor((row) => row.scopes.join(" "), {
      id: "scopes",
      header: "스코프",
      cell: ({ row }) => <ScopeBadges scopes={row.original.scopes} />,
    }),
    column.accessor((row) => row.allowed_ips.join(" "), {
      id: "allowed_ips",
      header: "허용 IP",
      cell: ({ row }) =>
        row.original.allowed_ips.length === 0 ? (
          <span className="access-note">제한 없음</span>
        ) : (
          <span className="mono truncate">{row.original.allowed_ips.join(", ")}</span>
        ),
    }),
    column.accessor((row) => row.expires_at, {
      id: "expires_at",
      header: "만료",
      cell: ({ getValue }) => (getValue() ? formatDateTime(getValue()) : "무기한"),
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => (
        <div className="table-actions">
          <Button
            size="small"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={(event) => onEdit(row.original, event.currentTarget)}
          >
            수정
          </Button>
          <Button
            size="small"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={(event) => onScopes(row.original, event.currentTarget)}
          >
            스코프
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!canWrite || row.original.status === "revoked"}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={(event) => onRevoke(row.original, event.currentTarget)}
          >
            폐기
          </Button>
        </div>
      ),
    }),
  ]);
}

interface ApiKeysTabProps {
  canWrite: boolean;
  isSuperAdmin: boolean;
  writeDeniedReason: string;
}

export function ApiKeysTab({
  canWrite,
  isSuperAdmin,
  writeDeniedReason,
}: ApiKeysTabProps): React.JSX.Element {
  const keys = useApiKeysQuery(true);
  const [search, setSearch] = useState("");
  const [searchError, setSearchError] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKeyPublic | undefined>();
  const [scopeTarget, setScopeTarget] = useState<ApiKeyPublic | undefined>();
  const [scopeDraft, setScopeDraft] = useState<readonly string[]>([]);
  const [revoking, setRevoking] = useState<ApiKeyPublic | undefined>();
  const [hardDelete, setHardDelete] = useState(false);
  const [issuedSecret, setIssuedSecret] = useState("");
  const createTrigger = useRef<HTMLButtonElement>(null);
  const { returnFocusRef: rowTrigger, remember: rememberRowTrigger } = useReturnFocus();

  const createForm = useZodForm<CreateKeyForm, CreateKeyForm>(createKeySchema, {
    name: "",
    owner: "",
    team: "",
    role: "",
    allowed_ips: "",
    allowed_models: "",
    denied_models: "",
    budget_limit_krw: "",
    expires_at: "",
  });
  const [createScopes, setCreateScopes] = useState<readonly string[]>([]);
  const editForm = useZodForm<EditKeyForm, EditKeyForm>(editKeySchema, {
    name: "",
    owner: "",
    team: "",
    role: "",
    status: "active",
  });

  const createKey = useMutationFeedback({
    mutate: (body: CreateApiKeyBody) => apiClient.request(access.apiKeys.create, { body, routeId }),
    invalidates: [accessKeys.apiKeys, accessKeys.users],
    successMessage: "API 키를 발급했습니다.",
    onSuccess: (result) => setIssuedSecret(result.secret),
  });
  const updateKey = useMutationFeedback({
    mutate: ({ id, body }: { id: string; body: UpdateApiKeyBody }) =>
      apiClient.request(withPathParams(access.apiKeys.update, { id }), { body, routeId }),
    invalidates: [accessKeys.apiKeys, accessKeys.users],
    successMessage: "API 키를 변경했습니다.",
  });
  const revokeKey = useMutationFeedback({
    mutate: ({ id, hard }: { id: string; hard: boolean }) =>
      apiClient.request(withPathParams(access.apiKeys.revoke, { id }), {
        ...(hard ? { query: { hard: 1 } } : {}),
        routeId,
      }),
    invalidates: [accessKeys.apiKeys, accessKeys.users],
    successMessage: "API 키를 폐기했습니다.",
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (keys.data?.api_keys ?? []).filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (!needle) return true;
      return [row.id, row.name, row.owner, row.team, row.role].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [keys.data?.api_keys, search, statusFilter]);

  if (keys.isPending && !keys.data) return <LoadingState label="API 키를 불러오는 중입니다." />;

  const all = keys.data?.api_keys ?? [];

  return (
    <div className="access-stack">
      {keys.isError ? (
        <QueryNotice
          error={keys.error}
          hasData={Boolean(keys.data)}
          label="API 키 목록"
          onRetry={() => void keys.refetch()}
        />
      ) : null}

      <StatGrid label="API 키 요약">
        <StatCard label="전체 키" value={all.length} />
        <StatCard label="사용 중" value={all.filter((row) => row.status === "active").length} />
        <StatCard label="중지" value={all.filter((row) => row.status === "disabled").length} />
        <StatCard label="폐기" value={all.filter((row) => row.status === "revoked").length} />
      </StatGrid>

      <InlineNotice tone="info" title="비밀값은 발급 시 한 번만 표시됩니다.">
        서버는 키 목록에 비밀값을 포함하지 않습니다. 분실한 키는 폐기하고 새로 발급하세요.
      </InlineNotice>

      <SectionCard
        title="프록시 API 키"
        description="게이트웨이 호출에 쓰이는 키입니다. 허용 IP와 모델 제한은 발급할 때만 설정할 수 있습니다."
        actions={
          <Button
            ref={createTrigger}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              createForm.reset({
                name: "",
                owner: "",
                team: "",
                role: "",
                allowed_ips: "",
                allowed_models: "",
                denied_models: "",
                budget_limit_krw: "",
                expires_at: "",
              });
              setCreateScopes([]);
              setCreateOpen(true);
            }}
          >
            키 발급
          </Button>
        }
      >
        {!canWrite ? <InlineNotice tone="info">{writeDeniedReason}</InlineNotice> : null}
        <Toolbar label="API 키 필터">
          <label className="access-toolbar-field">
            <span>검색</span>
            <Input
              value={search}
              aria-invalid={searchError ? true : undefined}
              aria-describedby={searchError ? "access-key-search-error" : undefined}
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
            </Select>
          </label>
        </Toolbar>
        {searchError ? (
          <p className="form-error" id="access-key-search-error" role="alert">
            {searchError}
          </p>
        ) : null}
        <DataTable
          caption="프록시 API 키 목록"
          columns={keyColumns(
            (row, trigger) => {
              rememberRowTrigger(trigger);
              editForm.reset({
                name: row.name,
                owner: row.owner,
                team: row.team,
                role: row.role,
                status: row.status === "disabled" ? "disabled" : "active",
              });
              setEditing(row);
            },
            (row, trigger) => {
              rememberRowTrigger(trigger);
              setScopeDraft(row.scopes);
              setScopeTarget(row);
            },
            (row, trigger) => {
              rememberRowTrigger(trigger);
              setHardDelete(false);
              setRevoking(row);
            },
            canWrite,
            writeDeniedReason,
          )}
          data={rows}
          getRowId={(row) => row.id}
          emptyMessage="조건에 맞는 API 키가 없습니다."
        />
        <UpdatedAt at={keys.dataUpdatedAt} />
      </SectionCard>

      <FormDialog
        form={createForm}
        open={createOpen}
        onOpenChange={setCreateOpen}
        returnFocusRef={createTrigger}
        title="API 키 발급"
        description="발급 후 비밀값은 한 번만 표시됩니다. 허용 IP와 모델 제한은 발급 시에만 설정할 수 있습니다."
        submitLabel="발급"
        onSubmit={async (values) => {
          const budget = Number(values.budget_limit_krw);
          await createKey.mutateAsync({
            name: values.name,
            ...(values.owner ? { owner: values.owner } : {}),
            ...(values.team ? { team: values.team } : {}),
            ...(values.role ? { role: values.role } : {}),
            ...(createScopes.length > 0 ? { scopes: createScopes } : {}),
            ...(values.allowed_ips ? { allowed_ips: splitList(values.allowed_ips) } : {}),
            ...(values.allowed_models ? { allowed_models: splitList(values.allowed_models) } : {}),
            ...(values.denied_models ? { denied_models: splitList(values.denied_models) } : {}),
            ...(Number.isFinite(budget) && budget > 0 ? { budget_limit_krw: budget } : {}),
            ...(values.expires_at ? { expires_at: values.expires_at } : {}),
          });
          setCreateOpen(false);
        }}
      >
        <FormField label="이름" required error={createForm.formState.errors.name?.message}>
          {(control) => <Input {...control} {...createForm.register("name")} />}
        </FormField>
        <FormField label="소유자">
          {(control) => <Input {...control} {...createForm.register("owner")} />}
        </FormField>
        <FormField label="팀">
          {(control) => <Input {...control} {...createForm.register("team")} />}
        </FormField>
        <FormField label="역할" description="비우면 기본 역할을 사용합니다.">
          {(control) => <Input {...control} {...createForm.register("role")} />}
        </FormField>
        <FormField
          label="허용 IP"
          description="쉼표 또는 공백으로 구분합니다. 비우면 IP 제한이 없습니다. 발급 후에는 바꿀 수 없습니다."
        >
          {(control) => <Input {...control} {...createForm.register("allowed_ips")} />}
        </FormField>
        <FormField label="허용 모델" description="쉼표 또는 공백으로 구분합니다.">
          {(control) => <Input {...control} {...createForm.register("allowed_models")} />}
        </FormField>
        <FormField label="차단 모델" description="쉼표 또는 공백으로 구분합니다.">
          {(control) => <Input {...control} {...createForm.register("denied_models")} />}
        </FormField>
        <FormField label="월 예산 한도(원)">
          {(control) => (
            <Input {...control} type="number" min={0} {...createForm.register("budget_limit_krw")} />
          )}
        </FormField>
        <FormField label="만료" description="비우면 무기한입니다.">
          {(control) => <Input {...control} type="datetime-local" {...createForm.register("expires_at")} />}
        </FormField>
        <fieldset>
          <legend>스코프</legend>
          <p className="access-note">선택하지 않으면 역할의 스코프를 그대로 상속합니다.</p>
          <div className="access-scope-grid">
            {allScopes.map((scope) => (
              <Checkbox
                key={scope}
                label={scope}
                checked={createScopes.includes(scope)}
                onChange={(event) =>
                  setCreateScopes((current) =>
                    event.target.checked ? [...current, scope] : current.filter((item) => item !== scope),
                  )
                }
              />
            ))}
          </div>
        </fieldset>
      </FormDialog>

      <FormDialog
        form={editForm}
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
        returnFocusRef={rowTrigger}
        title="API 키 수정"
        description="이름, 소유자, 팀, 역할과 사용 상태를 변경합니다. 폐기 상태로는 바꿀 수 없습니다."
        onSubmit={async (values) => {
          if (!editing) return;
          await updateKey.mutateAsync({
            id: editing.id,
            body: {
              name: values.name,
              owner: values.owner,
              team: values.team,
              role: values.role,
              status: values.status,
            },
          });
          setEditing(undefined);
        }}
      >
        <FormField label="이름">
          {(control) => <Input {...control} {...editForm.register("name")} />}
        </FormField>
        <FormField label="소유자">
          {(control) => <Input {...control} {...editForm.register("owner")} />}
        </FormField>
        <FormField label="팀">{(control) => <Input {...control} {...editForm.register("team")} />}</FormField>
        <FormField label="역할">
          {(control) => <Input {...control} {...editForm.register("role")} />}
        </FormField>
        <FormField label="상태">
          {(control) => (
            <Select {...control} {...editForm.register("status")}>
              <option value="active">사용</option>
              <option value="disabled">중지</option>
            </Select>
          )}
        </FormField>
      </FormDialog>

      <Dialog
        open={scopeTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setScopeTarget(undefined);
        }}
        returnFocusRef={rowTrigger}
        title="스코프 변경"
        description={`${scopeTarget?.name ?? ""} 키가 사용할 수 있는 스코프를 선택합니다. 모두 해제하면 역할 스코프를 상속합니다.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setScopeTarget(undefined)}>
              취소
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!scopeTarget) return;
                updateKey.mutate(
                  { id: scopeTarget.id, body: { scopes: scopeDraft } },
                  { onSuccess: () => setScopeTarget(undefined) },
                );
              }}
            >
              저장
            </Button>
          </>
        }
      >
        <div className="access-scope-grid">
          {allScopes.map((scope) => (
            <Checkbox
              key={scope}
              label={scope}
              checked={scopeDraft.includes(scope)}
              onChange={(event) =>
                setScopeDraft((current) =>
                  event.target.checked ? [...current, scope] : current.filter((item) => item !== scope),
                )
              }
            />
          ))}
        </div>
      </Dialog>

      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone="danger"
        title="API 키 폐기"
        description={`${revoking?.name || revoking?.id || ""} 키를 폐기합니다. 이 키를 쓰는 클라이언트는 즉시 인증에 실패합니다.`}
        confirmLabel="폐기"
        onConfirm={async () => {
          if (revoking) await revokeKey.mutateAsync({ id: revoking.id, hard: hardDelete });
          setRevoking(undefined);
        }}
      >
        {isSuperAdmin ? (
          <Checkbox
            label="완전 삭제"
            description="기록까지 지웁니다. 되돌릴 수 없으며 최고 관리자만 실행할 수 있습니다."
            checked={hardDelete}
            onChange={(event) => setHardDelete(event.target.checked)}
          />
        ) : null}
      </ConfirmDialog>

      <Dialog
        open={issuedSecret !== ""}
        onOpenChange={(open) => {
          if (!open) setIssuedSecret("");
        }}
        returnFocusRef={createTrigger}
        title="발급된 비밀값"
        description="이 값은 지금 한 번만 표시됩니다. 안전한 곳에 보관하세요."
        footer={
          <Button variant="primary" onClick={() => setIssuedSecret("")}>
            확인했습니다
          </Button>
        }
      >
        <div className="access-secret">
          <code>{issuedSecret}</code>
          <CopyButton value={issuedSecret} label="비밀값 복사" />
        </div>
      </Dialog>
    </div>
  );
}
