import { useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { QueryNotice } from "@/features/mcp/mcp-ui";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { McpContract } from "@/shared/api/domains/mcp.schemas";
import { ErrorState, LoadingState, PermissionDenied } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { DataTable } from "@/shared/data-table/DataTable";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { formatDateTime } from "@/shared/utils/format";
import { ContractDelete, ContractEditor } from "./ContractDialogs";
import { validationColumns } from "./gateway-columns";

import { ContractTable } from "./ContractTable";

export function ContractRegistry() {
  const owner = useFeatureReadOwner("mcp.gateway", "gateway-contracts", [], "observability:read");
  if (!owner.readable) return <PermissionDenied permission="observability:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="도구 계약 조회 권한을 다시 확인하세요."
        message="이전 계약과 편집 입력을 표시하지 않습니다."
        onRetry={owner.restart}
        showLegacy={false}
      />
    );
  return <RegistryContent key={owner.id} owner={owner} />;
}
function RegistryContent({ owner }: { owner: FeatureReadOwner }) {
  const auth = useAuth();
  const canValidate = auth.user?.scopes.includes("mcp:admin") === true;
  const currentScope = useRef(canValidate);
  useLayoutEffect(() => {
    currentScope.current = canValidate;
  }, [canValidate]);
  const access = useFeatureMutationAccess(
    ["mcp.gateway"],
    canValidate,
    "MCP 관리 권한(mcp:admin)이 필요합니다.",
  );
  const [editor, setEditor] = useState<{ original?: McpContract }>();
  const [deletion, setDeletion] = useState<McpContract>();
  const focus = useReturnFocus();
  const interval = useRefreshInterval();
  const query = useQuery({
    queryKey: featureOwnedKey(["mcp", "gateway", "contracts"], owner),
    retry: false,
    gcTime: 0,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.mcp.gateway.contracts, {
        query: {},
        signal,
        routeId: "mcp.gateway",
      });
      assertFeatureRead(owner, signal);
      return data;
    },
  });
  const validate = useMutationFeedback({
    gcTime: 0,
    ownsResult: () => owner.isCurrent() && currentScope.current,
    errorMessage: "계약 검증을 완료하지 못했습니다.",
    mutate: async () => {
      assertFeatureRead(owner);
      if (!currentScope.current) throw new AppError("MCP 관리 권한이 필요합니다.", { kind: "permission" });
      const data = await apiClient.request(endpoints.domains.mcp.gateway.validateContracts, {
        body: {},
        routeId: "mcp.gateway",
        retryUnauthorized: false,
      });
      assertFeatureRead(owner);
      if (!currentScope.current) throw new AppError("권한이 바뀌었습니다.", { kind: "permission" });
      return data;
    },
  });
  const writable = access.allowed && query.isSuccess && !query.isFetching;
  const results = canValidate && !validate.isPending && !validate.isError ? validate.data : undefined;
  return (
    <>
      <SectionCard
        title="도구 계약 레지스트리"
        description="등록한 선언과 게이트웨이 입력 속성의 차이를 비교합니다."
        actions={
          <div className="mcp-row-actions">
            <Button
              disabled={!canValidate || validate.isPending || !query.isSuccess}
              onClick={() => validate.mutate()}
            >
              {validate.isPending ? "검증 중" : "드리프트 검증"}
            </Button>
            <Button
              variant="primary"
              disabled={!writable}
              onClick={(event) => {
                focus.remember(event);
                setEditor({});
              }}
            >
              계약 등록
            </Button>
          </div>
        }
      >
        {!access.allowed ? <p>{access.reason}</p> : null}
        {query.data ? (
          <p>
            등록 {query.data.contracts.length}건 · 마지막 갱신 {formatDateTime(query.dataUpdatedAt)}
          </p>
        ) : null}
        {query.isError ? (
          <QueryNotice
            error={query.error}
            hasData={Boolean(query.data)}
            label="도구 계약"
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {query.isPending ? (
          <LoadingState label="도구 계약을 불러오는 중입니다." />
        ) : query.data ? (
          query.data.contracts.length === 0 ? (
            !query.isError ? (
              <EmptyState
                title="등록된 도구 계약이 없습니다."
                description="계약을 등록해 입력·출력 선언을 관리하세요."
              />
            ) : null
          ) : (
            <ContractTable
              data={query.data.contracts}
              writable={writable}
              onEdit={(row, trigger) => {
                focus.remember(trigger);
                setEditor({ original: row });
              }}
              onDelete={(row, trigger) => {
                focus.remember(trigger);
                setDeletion(row);
              }}
            />
          )
        ) : null}
      </SectionCard>
      {canValidate && validate.isError ? (
        <QueryNotice
          error={validate.error}
          hasData={false}
          label="도구 계약 검증"
          onRetry={() => validate.mutate()}
        />
      ) : null}
      {results ? (
        <SectionCard
          title="드리프트 검증 결과"
          description={`검사 ${results.checked}건 · 드리프트 ${results.drift_count}건 · 누락 ${results.missing_count}건 · 검증 불가 ${results.results.filter((row) => row.status === "not_checkable").length}건`}
        >
          <p>
            게이트웨이 입력 스키마의 최상위 속성 이름만 비교합니다. 출력·중첩 타입·실행 권한·타임아웃이나 실제
            외부 호출은 검증하지 않습니다.
          </p>
          <DataTable
            caption="도구 계약 드리프트 검증 결과"
            columns={validationColumns}
            data={results.results}
            getRowId={(row, index) => `${row.contract_id}:${index}`}
            emptyMessage="검증 대상 계약이 없습니다."
          />
        </SectionCard>
      ) : null}
      {editor ? (
        <ContractEditor
          owner={owner}
          original={editor.original}
          returnFocusRef={focus.returnFocusRef}
          onClose={() => {
            setEditor(undefined);
            validate.reset();
          }}
        />
      ) : null}
      {deletion ? (
        <ContractDelete
          owner={owner}
          original={deletion}
          returnFocusRef={focus.returnFocusRef}
          onClose={() => {
            setDeletion(undefined);
            validate.reset();
          }}
        />
      ) : null}
    </>
  );
}
