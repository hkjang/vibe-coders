import { useMemo, useRef, useState } from "react";
import { z } from "zod";

import { managedRoleLabel } from "@/config/ui-labels";
import { RolePermissionMatrix } from "./RolePermissionMatrix";
import { QueryNotice, ScopeBadges, UpdatedAt } from "@/features/access/access-ui";
import { useRoleAdmin } from "./use-role-admin";
import { scopeTitle } from "./role-permission-matrix";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import type { RoleRow } from "@/shared/api/domains/access.schemas";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { ErrorState, LoadingState, PermissionDenied } from "@/shared/components/state/PageStates";
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
import { formatNumber } from "@/shared/utils/format";

const routeId = "access.users";

const roleSchema = z.object({
  role: z
    .string()
    .min(1, "역할 이름을 입력하세요.")
    .regex(/^[a-z0-9_]+$/u, "영문 소문자, 숫자, 밑줄만 사용할 수 있습니다."),
  description: z.string(),
  default_home: z.string(),
  scopes: z.array(z.string()),
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
          <strong>{managedRoleLabel(row.original.role)}</strong>
          {row.original.role && managedRoleLabel(row.original.role) !== row.original.role ? (
            <div className="access-list-detail mono">{row.original.role}</div>
          ) : null}
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
          {row.original.is_system ? "내장" : "사용자 정의"}
        </Badge>
      ),
    }),
    column.accessor((row) => row.rank, {
      id: "rank",
      header: "권한 등급",
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
      cell: ({ row }) =>
        row.original.scopes.length > 0 ? (
          <ScopeBadges scopes={row.original.scopes} />
        ) : (
          <span>부여된 권한 없음</span>
        ),
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
  const owner = useFeatureReadOwner(routeId, "role-administration");
  if (!owner.readable) return <PermissionDenied permission="admin:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="역할 조회 권한을 다시 확인하세요."
        message="이전 역할과 초안을 표시하지 않습니다."
        onRetry={owner.restart}
        legacyHref="/admin#/users"
      />
    );
  return (
    <RolesContent key={owner.id} owner={owner} canWrite={canWrite} writeDeniedReason={writeDeniedReason} />
  );
}

function RolesContent({
  owner,
  canWrite,
  writeDeniedReason,
}: RolesTabProps & { owner: FeatureReadOwner }): React.JSX.Element {
  const {
    roles,
    save: saveRole,
    remove: removeRole,
    write,
    confirmed,
    assertCurrent,
  } = useRoleAdmin(owner, canWrite, writeDeniedReason);
  const changeAllowed = write.allowed && confirmed;
  const [editorOpen, setEditorOpen] = useState(false);
  const [baseline, setBaseline] = useState<RoleRow>();
  const [matrixOpen, setMatrixOpen] = useState(false);
  const matrixTrigger = useRef<HTMLButtonElement>(null);
  const [editingRole, setEditingRole] = useState("");
  const [removingRole, setRemovingRole] = useState<RoleRow | undefined>();
  const createTrigger = useRef<HTMLButtonElement>(null);
  const { returnFocusRef: rowTrigger, remember: rememberRowTrigger } = useReturnFocus();

  const form = useZodForm<RoleForm, RoleForm>(roleSchema, {
    role: "",
    description: "",
    default_home: "",
    scopes: [],
  });
  const scopes = form.watch("scopes");
  const { reset: resetRoleForm } = form;
  const columns = useMemo(
    () =>
      roleColumns(
        (row, trigger) => {
          rememberRowTrigger(trigger);
          resetRoleForm({
            role: row.role,
            description: row.description,
            default_home: row.default_home,
            // Canonicalize the baseline while retaining unknown scopes.
            scopes: [...row.scopes].sort(),
          });
          setEditingRole(row.role);
          setBaseline(row);
          setEditorOpen(true);
        },
        (row, trigger) => {
          rememberRowTrigger(trigger);
          setRemovingRole(row);
        },
        write.allowed,
        writeDeniedReason,
      ),
    [rememberRowTrigger, resetRoleForm, write.allowed, writeDeniedReason],
  );

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
        <StatCard
          label="사용자 정의 역할"
          value={formatNumber(rows.filter((row) => !row.is_system).length)}
        />
        <StatCard label="권한 종류" value={formatNumber(allScopes.length)} />
      </StatGrid>

      <InlineNotice tone="info" title="사용자 정의 역할은 최고 관리자만 부여할 수 있습니다.">
        사용자 정의 역할의 권한 등급은 0이라서, 사용자에게 부여하려면 최고 관리자(super_admin) 권한이
        필요합니다. 내장 역할은 수정하거나 삭제할 수 없습니다.
      </InlineNotice>

      <SectionCard
        title="역할과 권한"
        description="역할별로 부여되는 권한과 기본 진입 화면입니다. 내장 역할은 읽기 전용입니다."
        actions={
          <div className="table-actions">
            <Button ref={matrixTrigger} onClick={() => setMatrixOpen(true)}>
              권한 비교
            </Button>
            <Button
              ref={createTrigger}
              variant="primary"
              disabled={!changeAllowed}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={(event) => {
                rememberRowTrigger(event.currentTarget);
                form.reset({ role: "", description: "", default_home: "", scopes: [] });
                setEditingRole("");
                setBaseline(undefined);
                setEditorOpen(true);
              }}
            >
              역할 추가
            </Button>
          </div>
        }
      >
        {!write.allowed ? <InlineNotice tone="info">{write.reason}</InlineNotice> : null}
        <DataTable
          caption="역할 목록"
          columns={columns}
          data={rows}
          getRowId={(row) => row.role}
          emptyMessage="등록된 역할이 없습니다."
        />
        <UpdatedAt at={roles.dataUpdatedAt} />
      </SectionCard>

      {matrixOpen ? (
        <RolePermissionMatrix onClose={() => setMatrixOpen(false)} returnFocusRef={matrixTrigger} />
      ) : null}
      <FormDialog
        form={form}
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) setEditingRole("");
        }}
        returnFocusRef={rowTrigger}
        title={editingRole ? "역할 수정" : "역할 추가"}
        submitDisabled={!changeAllowed}
        description="저장 직전에 기존 역할과 권한 목록을 재확인합니다. 다른 관리자의 동시 변경까지 잠그는 것은 아닙니다."
        onSubmit={async (values) => {
          await saveRole.mutateAsync({
            baseline,
            body: {
              role: values.role,
              ...(values.description ? { description: values.description } : {}),
              scopes: values.scopes,
              ...(values.default_home ? { default_home: values.default_home } : {}),
            },
          });
          assertCurrent();
        }}
      >
        {!write.allowed ? <InlineNotice tone="warning">{write.reason}</InlineNotice> : null}
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
          <legend>권한 범위</legend>
          <div className="access-scope-grid">
            {[...new Set([...allScopes, ...scopes])].map((scope) => (
              <Checkbox
                key={scope}
                label={`${scopeTitle(scope)} (${scope})`}
                description={
                  allScopes.includes(scope)
                    ? undefined
                    : "목록에 없는 기존 권한입니다. 저장하려면 선택을 해제하세요."
                }
                checked={scopes.includes(scope)}
                onChange={(event) => {
                  const current = form.getValues("scopes");
                  form.setValue(
                    "scopes",
                    event.target.checked
                      ? [...current, scope].sort()
                      : current.filter((item) => item !== scope),
                    { shouldDirty: true },
                  );
                }}
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
        description={`사용자 정의 역할 '${removingRole?.role ?? ""}'을(를) 삭제합니다. 해당 역할을 사용하는 계정과 키의 권한에 영향을 줄 수 있습니다.`}
        confirmLabel="삭제"
        confirmDisabled={!changeAllowed}
        onConfirm={async () => {
          if (removingRole) await removeRole.mutateAsync(removingRole);
          assertCurrent();
        }}
      />
    </div>
  );
}
