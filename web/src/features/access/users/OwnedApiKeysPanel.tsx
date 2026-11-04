import { useMemo, useRef, useState } from "react";
import { keyExpiryISO } from "../key-expiry";

import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { ApiKeyCreateFields } from "@/features/access/users/ApiKeyCreateFields";
import { ApiKeyScopesDialog } from "@/features/access/users/ApiKeyScopesDialog";
import { apiKeyColumns } from "@/features/access/users/api-key-columns";
import { createKeySchema, splitList, type CreateKeyForm } from "@/features/access/users/api-key-form";
import { accessKeys, useApiKeysQuery } from "@/features/access/users/use-access-admin";
import { useApiKeyScopeDraft } from "@/features/access/users/use-api-key-scope-draft";
import { useKeyRowFocus } from "./use-key-row-focus";
import { useKeyRevokeAttempts } from "./use-key-revoke-attempts";
import { apiClient } from "@/shared/api/client";
import type { CreateApiKeyBody, UpdateApiKeyBody } from "@/shared/api/domains/access";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { ApiKeyEditDialog } from "./ApiKeyEditDialog";
import { useAdminKeyLifetime } from "./use-admin-key-lifetime";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { ApiKeyRevokeDialog, type KeyRevokeSubmission } from "./ApiKeyRevokeDialog";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { ApiKeySummary } from "./ApiKeySummary";
import { keyLifecycle } from "../key-lifecycle";
import { useKeyExpiryClock } from "../use-key-expiry-clock";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

const access = endpoints.domains.access;
const routeId = "access.users";
const emptyKeys: ApiKeyPublic[] = [];

interface ApiKeysTabProps {
  owner: string;
  canWrite: boolean;
  isSuperAdmin: boolean;
  writeDeniedReason: string;
}

export function OwnedApiKeysPanel({
  owner,
  canWrite,
  isSuperAdmin,
  writeDeniedReason,
}: ApiKeysTabProps): React.JSX.Element {
  const writeAccess = useFeatureMutationAccess([routeId], canWrite, writeDeniedReason);
  const keys = useApiKeysQuery(true, owner);
  const all = keys.data?.api_keys ?? emptyKeys;
  const now = useKeyExpiryClock(all);
  const { denied, ownsResult, assertCurrent } = useAdminKeyLifetime(keys.error, writeAccess.assertCurrent);
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
  const { attempts: revokeAttempts, record, reject } = useKeyRevokeAttempts(ownsResult, () => keys.refetch());
  const [issuedSecret, setIssuedSecret] = useState("");
  const createTrigger = useRef<HTMLButtonElement>(null);
  const { returnFocusRef: rowTrigger, remember: rememberRowTrigger, bind: bindRowTrigger } = useKeyRowFocus();

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

  const createKey = useMutationFeedback({
    ownsResult,
    mutate: (body: CreateApiKeyBody) => {
      assertCurrent();
      return apiClient.request(access.apiKeys.create, { body, routeId, retryUnauthorized: false });
    },
    invalidates: [accessKeys.apiKeys, accessKeys.users],
    successMessage: "API 키를 발급했습니다.",
    onSuccess: (result) => setIssuedSecret(result.secret),
  });
  const updateKey = useMutationFeedback({
    ownsResult,
    mutate: ({ id, body }: { id: string; body: UpdateApiKeyBody }) => {
      assertCurrent();
      return apiClient.request(withPathParams(access.apiKeys.update, { id }), {
        body,
        routeId,
        retryUnauthorized: false,
      });
    },
    invalidates: [accessKeys.apiKeys, accessKeys.users],
    successMessage: "API 키를 변경했습니다.",
  });
  const revokeKey = useMutationFeedback({
    ownsResult,
    mutate: ({ id, hard, reason, expected_revision }: KeyRevokeSubmission) => {
      assertCurrent();
      return apiClient.request(withPathParams(access.apiKeys.revoke, { id }), {
        ...(hard ? { query: { hard: 1 } } : {}),
        body: { reason, expected_revision },
        routeId,
        retryUnauthorized: false,
      });
    },
    invalidates: [accessKeys.apiKeys, accessKeys.users],
    successMessage: "API 키를 폐기했습니다.",
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all.filter((row) => {
      if (statusFilter !== "all" && keyLifecycle(row, now).state !== statusFilter) return false;
      if (!needle) return true;
      return [row.id, row.name, row.owner, row.team, row.role].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [all, now, search, statusFilter]);

  if (denied)
    return (
      <InlineNotice tone="warning">
        키 조회 권한이 거부되어 데이터와 작업을 잠갔습니다. 다시 로그인하거나 화면을 다시 열어 권한을
        확인하세요.
      </InlineNotice>
    );
  if (keys.isPending && !keys.data) return <LoadingState label="API 키를 불러오는 중입니다." />;

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

      <ApiKeySummary rows={all} now={now} />

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
            disabled={!writeAccess.allowed}
            title={writeAccess.reason}
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
        {!writeAccess.allowed ? <InlineNotice tone="info">{writeAccess.reason}</InlineNotice> : null}
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
              <option value="grace">교체 유예 중</option>
              <option value="expired">만료</option>
              <option value="grace-ended">유예 종료</option>
              <option value="invalid">만료 시각 확인 필요</option>
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
              rememberRowTrigger(row.id, "edit", trigger);
              setEditing(row);
            },
            openScopes,
            (row, trigger) => {
              rememberRowTrigger(row.id, "revoke", trigger);
              setRevoking(row);
            },
            writeAccess.allowed,
            writeAccess.reason ?? writeDeniedReason,
            rememberScopeTrigger,
            revokeAttempts,
            now,
            bindRowTrigger,
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
        submitDisabled={!writeAccess.allowed}
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
            ...(values.expires_at ? { expires_at: keyExpiryISO(values.expires_at) } : {}),
          });
        }}
      >
        {!writeAccess.allowed ? <InlineNotice tone="warning">{writeAccess.reason}</InlineNotice> : null}
        <ApiKeyCreateFields form={createForm} />
      </FormDialog>

      {editing ? (
        <ApiKeyEditDialog
          key={editing.id}
          owner={owner}
          target={editing}
          canWrite={writeAccess.allowed}
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
          returnFocusRef={rowTrigger}
          onSubmit={(id, body) => updateKey.mutateAsync({ id, body })}
        />
      ) : null}

      {scopeTarget ? (
        <ApiKeyScopesDialog
          owner={owner}
          key={`${scopeTarget.row.id}:${scopeTarget.epoch}`}
          target={scopeTarget.row}
          onOpenChange={(open) => {
            if (!open) closeScopes();
          }}
          returnFocusRef={scopeReturnFocus}
          writeDisabled={!writeAccess.allowed}
          onSubmit={(id, scopes, review) => {
            if (scopeTarget.epoch !== tokenStore.getSessionEpoch()) {
              throw new AppError("인증 세션이 변경되어 이전 권한 초안을 취소했습니다.", { kind: "aborted" });
            }
            return updateKey.mutateAsync({ id, body: { scopes, review } });
          }}
        />
      ) : null}

      {revokeAttempts.size > 0 ? (
        <InlineNotice tone="warning">
          폐기를 요청한 키의 재전송을 막았습니다. 목록을 새로고침하고 감사 이력에서 처리 결과를 확인하세요.
        </InlineNotice>
      ) : null}
      {revoking ? (
        <ApiKeyRevokeDialog
          target={revoking}
          catalogKey={[...accessKeys.apiKeys, owner]}
          returnFocusRef={rowTrigger}
          canWrite={writeAccess.allowed}
          reason={writeAccess.reason}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setRevoking(undefined)}
          onAttempt={record}
          onRejected={reject}
          onSubmit={(input) => revokeKey.mutateAsync(input)}
        />
      ) : null}

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
