import { useRef, useState } from "react";
import { z } from "zod";

import { QueryNotice, ScopeBadges, UpdatedAt } from "@/features/access/access-ui";
import { accessKeys, useRolesQuery } from "@/features/access/users/use-access-admin";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { apiClient } from "@/shared/api/client";
import type { SaveRoleBody } from "@/shared/api/domains/access";
import type { RoleRow } from "@/shared/api/domains/access.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatNumber } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "access.users";

const roleSchema = z.object({
  role: z
    .string()
    .min(1, "역할 이름을 입력하세요.")
    .regex(/^[a-z0-9_]+$/u, "영문 소문자, 숫자, 밑줄만 사용할 수 있습니다."),
  description: z.string(),
  default_home: z.string(),
});
type RoleForm = z.infer<typeof roleSchema>;

function roleColumns(
  onEdit: (row: RoleRow, trigger: HTMLElement) => void,
  onRemove: (row: RoleRow, trigger: HTMLElement) => void,
  canWrite: boolean,
  writeDeniedReason: string,
): ReadonlyArray<DataTableColumn<RoleRow>> {
  const column = createDataTableColumnHelper<RoleRow>();
  return column.columns([
    column.accessor((row) => row.role, {
      id: "role",
      header: "역할",
      cell: ({ row }) => (
        <div>
          <strong>{row.original.role}</strong>
          {row.original.description ? (
            <div className="access-list-detail">{row.original.description}</div>
          ) : null}
        </div>
      ),
    }),
    column.accessor((row) => row.is_system, {
      id: "kind",
      header: "구분",
      cell: ({ row }) => (
        <Badge tone={row.original.is_system ? "info" : "muted"}>
          {row.original.is_system ? "내장" : "커스텀"}
        </Badge>
      ),
    }),
    column.accessor((row) => row.rank, {
      id: "rank",
      header: "랭크",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.default_home, {
      id: "default_home",
      header: "기본 화면",
      cell: ({ getValue }) => <span className="mono truncate">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.scopes.join(" "), {
      id: "scopes",
      header: "스코프",
      cell: ({ row }) => <ScopeBadges scopes={row.original.scopes} />,
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => (
        <div className="table-actions">
          <Button
            size="small"
            disabled={!canWrite || row.original.is_system}
            title={
              !canWrite
                ? writeDeniedReason
                : row.original.is_system
                  ? "내장 역할은 수정할 수 없습니다."
                  : undefined
            }
            onClick={(event) => onEdit(row.original, event.currentTarget)}
          >
            수정
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!canWrite || row.original.is_system}
            title={
              !canWrite
                ? writeDeniedReason
                : row.original.is_system
                  ? "내장 역할은 삭제할 수 없습니다."
                  : undefined
            }
            onClick={(event) => onRemove(row.original, event.currentTarget)}
          >
            삭제
          </Button>
        </div>
      ),
    }),
  ]);
}

interface RolesTabProps {
  canWrite: boolean;
  writeDeniedReason: string;
}

export function RolesTab({ canWrite, writeDeniedReason }: RolesTabProps): React.JSX.Element {
  const roles = useRolesQuery(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRole, setEditingRole] = useState("");
  const [scopeDraft, setScopeDraft] = useState<readonly string[]>([]);
  const [removingRole, setRemovingRole] = useState<RoleRow | undefined>();
  const createTrigger = useRef<HTMLButtonElement>(null);
  const { returnFocusRef: rowTrigger, remember: rememberRowTrigger } = useReturnFocus();

  const form = useZodForm<RoleForm, RoleForm>(roleSchema, { role: "", description: "", default_home: "" });
  const saveRole = useMutationFeedback({
    mutate: (body: SaveRoleBody) => apiClient.request(access.roles.save, { body, routeId }),
    invalidates: [accessKeys.roles],
    successMessage: "역할을 저장했습니다.",
  });

  const removeRole = useMutationFeedback({
    // The server takes the role name in the query string, not the path.
    mutate: (role: string) => apiClient.request(access.roles.remove, { query: { role }, routeId }),
    invalidates: [accessKeys.roles],
    successMessage: "역할을 삭제했습니다.",
  });

  if (roles.isPending && !roles.data) return <LoadingState label="역할을 불러오는 중입니다." />;

  const rows = roles.data?.roles ?? [];
  const allScopes = roles.data?.all_scopes ?? [];

  return (
    <div className="access-stack">
      {roles.isError ? (
        <QueryNotice
          error={roles.error}
          hasData={Boolean(roles.data)}
          label="역할 목록"
          onRetry={() => void roles.refetch()}
        />
      ) : null}

      <StatGrid label="역할 요약">
        <StatCard label="전체 역할" value={formatNumber(rows.length)} />
        <StatCard label="내장 역할" value={formatNumber(rows.filter((row) => row.is_system).length)} />
        <StatCard label="커스텀 역할" value={formatNumber(rows.filter((row) => !row.is_system).length)} />
        <StatCard label="스코프 종류" value={formatNumber(allScopes.length)} />
      </StatGrid>

      <InlineNotice tone="info" title="커스텀 역할은 최고 관리자만 부여할 수 있습니다.">
        커스텀 역할의 랭크는 0이라서, 사용자에게 부여하려면 super_admin 권한이 필요합니다. 내장 역할은
        수정하거나 삭제할 수 없습니다.
      </InlineNotice>

      <SectionCard
        title="역할과 스코프"
        description="역할별로 부여되는 스코프와 기본 진입 화면입니다. 내장 역할은 읽기 전용입니다."
        actions={
          <Button
            ref={createTrigger}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              form.reset({ role: "", description: "", default_home: "" });
              setScopeDraft([]);
              setEditingRole("");
              setEditorOpen(true);
            }}
          >
            역할 추가
          </Button>
        }
      >
        {!canWrite ? <InlineNotice tone="info">{writeDeniedReason}</InlineNotice> : null}
        <DataTable
          caption="역할 목록"
          columns={roleColumns(
            (row, trigger) => {
              rememberRowTrigger(trigger);
              form.reset({
                role: row.role,
                description: row.description,
                default_home: row.default_home,
              });
              setScopeDraft(row.scopes);
              setEditingRole(row.role);
              setEditorOpen(true);
            },
            (row, trigger) => {
              rememberRowTrigger(trigger);
              setRemovingRole(row);
            },
            canWrite,
            writeDeniedReason,
          )}
          data={rows}
          getRowId={(row) => row.role}
          emptyMessage="등록된 역할이 없습니다."
        />
        <UpdatedAt at={roles.dataUpdatedAt} />
      </SectionCard>

      <FormDialog
        form={form}
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) setEditingRole("");
        }}
        returnFocusRef={editingRole ? rowTrigger : createTrigger}
        title={editingRole ? "역할 수정" : "역할 추가"}
        description="역할 이름이 내장 역할과 같으면 저장할 수 없습니다. 스코프는 서버가 제공하는 목록에서만 고를 수 있습니다."
        onSubmit={async (values) => {
          await saveRole.mutateAsync({
            role: values.role,
            ...(values.description ? { description: values.description } : {}),
            scopes: scopeDraft,
            ...(values.default_home ? { default_home: values.default_home } : {}),
          });
          setEditorOpen(false);
          setEditingRole("");
        }}
      >
        <FormField label="역할 이름" required error={form.formState.errors.role?.message}>
          {(control) => <Input {...control} readOnly={editingRole !== ""} {...form.register("role")} />}
        </FormField>
        <FormField label="설명">
          {(control) => <Input {...control} {...form.register("description")} />}
        </FormField>
        <FormField label="기본 화면" description="예: #/me. 비우면 서버 기본값을 사용합니다.">
          {(control) => <Input {...control} {...form.register("default_home")} />}
        </FormField>
        <fieldset>
          <legend>스코프</legend>
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
        </fieldset>
      </FormDialog>

      <ConfirmDialog
        open={removingRole !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemovingRole(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone="danger"
        title="역할 삭제"
        description={`커스텀 역할 '${removingRole?.role ?? ""}'을(를) 삭제합니다. 이 역할을 쓰던 사용자와 키는 스코프를 잃습니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (removingRole) await removeRole.mutateAsync(removingRole.role);
          setRemovingRole(undefined);
        }}
      />
    </div>
  );
}
