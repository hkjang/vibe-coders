import { useMemo, useRef, useState } from "react";

import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { ApiKeyCreateFields } from "@/features/access/users/ApiKeyCreateFields";
import { ApiKeyScopesDialog } from "@/features/access/users/ApiKeyScopesDialog";
import { apiKeyColumns } from "@/features/access/users/api-key-columns";
import {
  createKeySchema,
  editKeySchema,
  splitList,
  type CreateKeyForm,
  type EditKeyForm,
} from "@/features/access/users/api-key-form";
import { accessKeys, useApiKeysQuery } from "@/features/access/users/use-access-admin";
import { useApiKeyScopeDraft } from "@/features/access/users/use-api-key-scope-draft";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { apiClient } from "@/shared/api/client";
import type { CreateApiKeyBody, UpdateApiKeyBody } from "@/shared/api/domains/access";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { LoadingState } from "@/shared/components/state/PageStates";
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
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";

const access = endpoints.domains.access;
const routeId = "access.users";

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
  const {
    target: scopeTarget,
    open: openScopes,
    close: closeScopes,
    returnFocusRef: scopeReturnFocus,
    rememberTrigger: rememberScopeTrigger,
  } = useApiKeyScopeDraft();
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
    scopes: [],
  });
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
                scopes: [],
              });
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
          columns={apiKeyColumns(
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
            openScopes,
            (row, trigger) => {
              rememberRowTrigger(trigger);
              setHardDelete(false);
              setRevoking(row);
            },
            canWrite,
            writeDeniedReason,
            rememberScopeTrigger,
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
            ...(values.scopes.length > 0 ? { scopes: values.scopes } : {}),
            ...(values.allowed_ips ? { allowed_ips: splitList(values.allowed_ips) } : {}),
            ...(values.allowed_models ? { allowed_models: splitList(values.allowed_models) } : {}),
            ...(values.denied_models ? { denied_models: splitList(values.denied_models) } : {}),
            ...(Number.isFinite(budget) && budget > 0 ? { budget_limit_krw: budget } : {}),
            ...(values.expires_at ? { expires_at: values.expires_at } : {}),
          });
        }}
      >
        <ApiKeyCreateFields form={createForm} />
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

      {scopeTarget ? (
        <ApiKeyScopesDialog
          key={`${scopeTarget.row.id}:${scopeTarget.epoch}`}
          target={scopeTarget.row}
          onOpenChange={(open) => {
            if (!open) closeScopes();
          }}
          returnFocusRef={scopeReturnFocus}
          onSubmit={(id, scopes) => {
            if (scopeTarget.epoch !== tokenStore.getSessionEpoch()) {
              throw new AppError("인증 세션이 변경되어 이전 권한 초안을 취소했습니다.", { kind: "aborted" });
            }
            return updateKey.mutateAsync({ id, body: { scopes } });
          }}
        />
      ) : null}

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
