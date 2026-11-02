import { useMemo, useRef, useState } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { accountColumns, keyUsageColumns, benchmarkColumns } from "./user-columns";
import { useExternalKeyPromotion } from "./use-external-key-promotion";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { UserAccountDialog } from "@/features/access/users/UserAccountDialog";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { UserDetailSheet } from "@/features/access/users/UserDetailSheet";
import { useUserBenchmarkQuery, useUsersQuery } from "@/features/access/users/use-access-admin";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import type { AuthUserRow, UserSummary } from "@/shared/api/domains/access.schemas";
import { LoadingState, ErrorState, PermissionDenied } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { DataTable } from "@/shared/data-table/DataTable";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatKRW, formatNumber } from "@/shared/utils/format";

const routeId = "access.users";

interface UsersTabProps {
  canWrite: boolean;
  writeDeniedReason: string;
}

export function UsersTab({ canWrite, writeDeniedReason }: UsersTabProps): React.JSX.Element {
  const owner = useFeatureReadOwner(routeId, "user-administration");
  if (!owner.readable) return <PermissionDenied permission="admin:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="사용자 조회 권한을 다시 확인하세요."
        message="이전 계정·사용량·상세와 열린 작업을 표시하지 않습니다."
        onRetry={owner.restart}
        legacyHref="/admin#/users"
      />
    );
  return (
    <UsersContent key={owner.id} owner={owner} canWrite={canWrite} writeDeniedReason={writeDeniedReason} />
  );
}

function UsersContent({
  owner,
  canWrite,
  writeDeniedReason,
}: UsersTabProps & { owner: FeatureReadOwner }): React.JSX.Element {
  const auth = useAuth();
  const users = useUsersQuery(true, owner);
  const { promoteKey, write, assertCurrent } = useExternalKeyPromotion(owner, canWrite, writeDeniedReason);
  const allowed = write.allowed;
  const [benchmarkWindow, setBenchmarkWindow] = useState("30d");
  const benchmark = useUserBenchmarkQuery(benchmarkWindow, true, owner);
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

  // Stable cell renderers keep the opener connected while the dialog changes.
  const accountTableColumns = useMemo(
    () =>
      accountColumns(
        teamNames ?? {},
        (user, trigger) => {
          rememberDialogTrigger(trigger);
          setEditing(user);
        },
        allowed,
        write.reason ?? writeDeniedReason,
      ),
    [teamNames, rememberDialogTrigger, allowed, write.reason, writeDeniedReason],
  );
  const usageTableColumns = useMemo(
    () =>
      keyUsageColumns(
        (row, trigger) => {
          rememberDialogTrigger(trigger);
          setPromoting(row);
        },
        allowed,
        write.reason ?? writeDeniedReason,
      ),
    [rememberDialogTrigger, allowed, write.reason, writeDeniedReason],
  );

  if (users.isPending && !users.data) return <LoadingState label="사용자 목록을 불러오는 중입니다." />;
  if (users.isError && !users.data)
    return (
      <QueryNotice
        error={users.error}
        hasData={false}
        label="사용자 목록"
        onRetry={() => void users.refetch()}
      />
    );

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
            disabled={!allowed}
            title={allowed ? undefined : write.reason}
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            사용자 등록
          </Button>
        }
      >
        {!allowed ? <InlineNotice tone="info">{write.reason}</InlineNotice> : null}
        <DataTable
          caption="로그인 계정 목록"
          columns={accountTableColumns}
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
                if (containsPotentialSecret(next, auth.credentialPrefixes)) {
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
          columns={usageTableColumns}
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
        {benchmarkRows.length === 0 && benchmark.isSuccess ? (
          <EmptyState
            title="활용지수를 계산할 데이터가 없습니다."
            description="선택한 기간에 요청이 기록되면 사용자별 점수가 채워집니다."
          />
        ) : benchmark.isPending || benchmarkRows.length > 0 ? (
          <DataTable
            caption="사용자 AI 활용지수"
            loading={benchmark.isPending}
            columns={benchmarkColumns()}
            data={benchmarkRows}
            getRowId={(row, index) => `${row.api_key_id}-${String(index)}`}
          />
        ) : null}
        <UpdatedAt at={benchmark.dataUpdatedAt} />
      </SectionCard>

      {createOpen ? (
        <UserAccountDialog
          canWrite={canWrite}
          writeDeniedReason={writeDeniedReason}
          returnFocusRef={createTrigger}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
      {editing ? (
        <UserAccountDialog
          key={editing.id}
          user={editing}
          canWrite={canWrite}
          writeDeniedReason={writeDeniedReason}
          returnFocusRef={dialogTrigger}
          onClose={() => setEditing(undefined)}
        />
      ) : null}

      <ConfirmDialog
        confirmDisabled={!allowed}
        open={promoting !== undefined}
        onOpenChange={(open) => {
          if (!open) setPromoting(undefined);
        }}
        returnFocusRef={dialogTrigger}
        title="관리 키로 등록"
        description={`${promoting?.name || promoting?.api_key_id || ""} 키를 관리 대상(사용 상태)으로 전환합니다.`}
        confirmLabel="등록"
        onConfirm={async () => {
          assertCurrent();
          if (promoting) await promoteKey.mutateAsync(promoting);
          assertCurrent();
          setPromoting(undefined);
        }}
      />

      <UserDetailSheet
        owner={owner}
        apiKeyId={selectedKeyId}
        onClose={() => setSelectedKeyId("")}
        returnFocusRef={detailTrigger}
      />
    </div>
  );
}
