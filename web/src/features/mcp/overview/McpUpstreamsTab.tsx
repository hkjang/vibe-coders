import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import { UpstreamFormDialog } from "@/features/mcp/overview/UpstreamFormDialog";
import { apiClient } from "@/shared/api/client";
import { isAppError } from "@/shared/api/error";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import type { McpUpstream } from "@/shared/api/domains/mcp.schemas";
import { upstreamColumns } from "./mcp-upstream-columns";
import { McpUpstreamDetails } from "./McpUpstreamDetails";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Sheet } from "@/shared/components/ui/Sheet";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatNumber } from "@/shared/utils/format";

const routeId = "mcp.overview";

export function McpUpstreamsTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const auth = useAuth();
  const access = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
    auth.user?.scopes,
    auth.credentialPrefixes,
    access?.featureId,
    access?.permitted,
  ]);
  if (
    !auth.user?.scopes.includes("admin:read") ||
    !auth.user.scopes.includes("observability:read") ||
    access?.permitted === false
  ) {
    return (
      <InlineNotice tone="warning" title="MCP 서버 조회 권한이 없습니다.">
        관리자에게 admin:read와 observability:read 권한을 요청하세요.
      </InlineNotice>
    );
  }
  return (
    <McpUpstreamsContent
      key={owner}
      owner={owner}
      canWrite={canWrite && auth.user.scopes.includes("mcp:admin")}
    />
  );
}

function McpUpstreamsContent({
  canWrite: scopeCanWrite,
  owner,
}: {
  canWrite: boolean;
  owner: string;
}): React.JSX.Element {
  const alive = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const ownsResult = () => alive.current;
  const mutationAccess = useFeatureMutationAccess([routeId], scopeCanWrite, "mcp:admin 권한이 필요합니다.");
  const canWrite = mutationAccess.allowed;
  const writeDisabledReason = mutationAccess.reason;
  const refetchInterval = useRefreshInterval();
  const [params, updateParams] = useSearchState();
  const selectedId = params.get("upstream") ?? "";
  const currentSelection = useRef(selectedId);
  useLayoutEffect(() => {
    currentSelection.current = selectedId;
  }, [selectedId]);
  const [formOpen, setFormOpen] = useState(false);
  const [formInstance, setFormInstance] = useState(0);
  const [editing, setEditing] = useState<McpUpstream | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<McpUpstream | undefined>();
  const [toggleTarget, setToggleTarget] = useState<McpUpstream | undefined>();
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const detailReturnRef = useRef<HTMLElement>(null);

  const upstreams = useQuery({
    queryKey: ["mcp", "upstreams", owner],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.mcp.upstreams, { signal, routeId }),
    refetchInterval,
    refetchIntervalInBackground: false,
    gcTime: 0,
  });
  const readDenied = isAppError(upstreams.error) && [401, 403].includes(upstreams.error.status ?? 0);
  const rows = readDenied ? [] : (upstreams.data?.upstreams ?? []);
  const selected = rows.find((row) => row.id === selectedId);
  const flow = useQuery({
    queryKey: ["mcp", "upstreams", owner, selectedId, "flow"],
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.mcp.upstreamFlow, { id: selectedId }), {
        signal,
        routeId,
      }),
    enabled: Boolean(selected) && !readDenied,
    gcTime: 0,
  });

  const remove = useMutationFeedback({
    mutate: (id: string) => {
      mutationAccess.assertCurrent();
      return apiClient.request(withPathParams(endpoints.domains.mcp.deleteUpstream, { id }), {
        routeId,
        retryUnauthorized: false,
      });
    },
    ownsResult,
    invalidates: [["mcp"]],
    successMessage: "업스트림을 삭제했습니다.",
    errorMessage: "업스트림을 삭제하지 못했습니다.",
  });
  // POST .../probe forces a fresh handshake and records a discovery run, so it is the
  // real "is this registration working, and what does it expose?" check.
  const probe = useMutationFeedback({
    mutate: (id: string) => {
      mutationAccess.assertCurrent();
      return apiClient.request(withPathParams(endpoints.domains.mcp.probeUpstream, { id }), {
        routeId,
        retryUnauthorized: false,
      });
    },
    ownsResult,
    invalidates: [["mcp"]],
    successMessage: (result) =>
      result.ok
        ? `연결에 성공했습니다. 도구 ${formatNumber(result.tool_count)}개를 찾았습니다.`
        : "연결 진단이 실패했습니다.",
    errorMessage: "연결 진단을 실행하지 못했습니다.",
  });
  const toggleEnabled = useMutationFeedback({
    mutate: (variables: { enabled: boolean; id: string }) => {
      mutationAccess.assertCurrent();
      return apiClient.request(withPathParams(endpoints.domains.mcp.patchUpstream, { id: variables.id }), {
        body: { enabled: variables.enabled },
        routeId,
        retryUnauthorized: false,
      });
    },
    ownsResult,
    invalidates: [["mcp"]],
    successMessage: (_result, variables) =>
      variables.enabled ? "업스트림을 사용 상태로 바꿨습니다." : "업스트림 사용을 중지했습니다.",
    errorMessage: "업스트림 사용 상태를 바꾸지 못했습니다.",
  });

  const discoveryErrors = readDenied ? {} : (upstreams.data?.discovery_errors ?? {});

  const closeDetail = (): void => updateParams({ upstream: undefined });

  return (
    <div className="mcp-section-stack">
      {upstreams.isError ? (
        <QueryNotice
          error={upstreams.error}
          hasData={Boolean(upstreams.data)}
          label="업스트림 목록"
          onRetry={() => void upstreams.refetch()}
        />
      ) : null}

      <Toolbar
        label="업스트림 작업"
        end={
          <Button
            ref={createButtonRef}
            variant="primary"
            disabled={!canWrite}
            title={writeDisabledReason}
            onClick={() => {
              setEditing(undefined);
              setFormInstance((value) => value + 1);
              setFormOpen(true);
            }}
          >
            <Plus aria-hidden="true" /> 업스트림 등록
          </Button>
        }
      >
        <span className="mcp-note">
          등록 {formatNumber(rows.length)}개 · 사용 중{" "}
          {formatNumber(rows.filter((row) => row.enabled).length)}개
        </span>
      </Toolbar>

      {Object.entries(discoveryErrors).map(([upstream, message]) => (
        <InlineNotice key={upstream} tone="warning" title={`${upstream} 도구 디스커버리 오류`}>
          <p className="mono">{message}</p>
        </InlineNotice>
      ))}

      {upstreams.isSuccess && rows.length === 0 ? (
        <EmptyState
          title="등록된 MCP 업스트림이 없습니다."
          description="MCP 서버를 등록하면 게이트웨이가 도구를 모아 하나의 /mcp 엔드포인트로 노출합니다."
          actions={
            <Button
              variant="primary"
              disabled={!canWrite}
              onClick={() => {
                setEditing(undefined);
                setFormInstance((value) => value + 1);
                setFormOpen(true);
              }}
            >
              업스트림 등록
            </Button>
          }
        />
      ) : (
        <DataTable
          caption="등록된 MCP 업스트림"
          columns={upstreamColumns(discoveryErrors)}
          data={rows}
          getRowId={(row) => row.id}
          loading={upstreams.isPending}
          getRowActionLabel={(row) => `${row.name} 상세 열기`}
          onRowClick={(row) => updateParams({ upstream: row.id })}
        />
      )}

      <UpstreamFormDialog
        key={`upstream-form-${formInstance}`}
        canWrite={canWrite}
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={createButtonRef}
        upstream={editing}
      />

      <ConfirmDialog
        open={deleteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        returnFocusRef={detailReturnRef}
        tone="danger"
        title="업스트림을 삭제할까요?"
        description={`${deleteTarget?.name ?? ""} 업스트림과 노출 중인 도구가 즉시 사라집니다.`}
        confirmLabel="삭제"
        confirmDisabled={!canWrite}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await remove.mutateAsync(deleteTarget.id);
          setDeleteTarget(undefined);
          if (currentSelection.current === deleteTarget.id) closeDetail();
        }}
      >
        {writeDisabledReason ? <p>{writeDisabledReason}</p> : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={toggleTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setToggleTarget(undefined);
        }}
        returnFocusRef={detailReturnRef}
        tone={toggleTarget?.enabled ? "danger" : "primary"}
        title={toggleTarget?.enabled ? "업스트림 사용을 중지할까요?" : "업스트림을 사용할까요?"}
        description={
          toggleTarget?.enabled
            ? `${toggleTarget.name} 업스트림의 도구가 게이트웨이 /mcp 목록에서 즉시 빠집니다.`
            : `${toggleTarget?.name ?? ""} 업스트림의 도구가 게이트웨이 /mcp 목록에 즉시 노출됩니다.`
        }
        confirmLabel={toggleTarget?.enabled ? "사용 중지" : "사용 시작"}
        confirmDisabled={!canWrite}
        onConfirm={async () => {
          if (!toggleTarget) return;
          await toggleEnabled.mutateAsync({ enabled: !toggleTarget.enabled, id: toggleTarget.id });
          setToggleTarget(undefined);
        }}
      >
        {writeDisabledReason ? <p>{writeDisabledReason}</p> : null}
        {toggleTarget?.enabled ? null : (
          <p>
            부분 수정은 온보딩 필수 항목을 다시 확인하지 않습니다. 위험 등급과 승인 게이트를 먼저 점검하세요.
          </p>
        )}
      </ConfirmDialog>

      <Sheet
        open={selectedId !== ""}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
        returnFocusRef={detailReturnRef}
        size="wide"
        title={selected?.name || selectedId}
        description="업스트림 연결 흐름, 노출 라우트와 최근 호출을 확인합니다."
        footer={
          <>
            <Button
              disabled={!canWrite || probe.isPending || !selected}
              title={writeDisabledReason}
              onClick={() => selected && probe.mutate(selected.id)}
            >
              {probe.isPending ? "확인 중" : "연결 진단"}
            </Button>
            <Button
              disabled={!canWrite || !selected}
              title={writeDisabledReason}
              onClick={() => setToggleTarget(selected)}
            >
              {selected?.enabled ? "사용 중지" : "사용 시작"}
            </Button>
            <Button
              disabled={!canWrite || !selected}
              onClick={() => {
                setEditing(selected);
                setFormInstance((value) => value + 1);
                setFormOpen(true);
              }}
            >
              수정
            </Button>
            <Button
              variant="danger"
              disabled={!canWrite || !selected}
              onClick={() => setDeleteTarget(selected)}
            >
              삭제
            </Button>
          </>
        }
      >
        {upstreams.isPending ? (
          <InlineNotice tone="info" title="MCP 서버 정보를 불러오고 있습니다.">
            조회가 끝나면 연결 상태와 운영 정보를 표시합니다.
          </InlineNotice>
        ) : null}
        {upstreams.isError ? (
          <QueryNotice
            error={upstreams.error}
            hasData={Boolean(selected)}
            label="MCP 서버 정보"
            onRetry={() => void upstreams.refetch()}
          />
        ) : null}
        {upstreams.isSuccess && !selected ? (
          <EmptyState
            title="MCP 서버를 찾을 수 없습니다."
            description="서버가 삭제되었거나 주소가 변경되었을 수 있습니다. 목록을 새로고침하세요."
            actions={<Button onClick={() => void upstreams.refetch()}>서버 목록 새로고침</Button>}
          />
        ) : null}
        {selected ? (
          <McpUpstreamDetails
            selected={selected}
            flow={flow}
            probe={probe.variables === selectedId ? probe.data : undefined}
          />
        ) : null}
      </Sheet>
    </div>
  );
}
