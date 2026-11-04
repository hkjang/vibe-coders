import { useQuery } from "@tanstack/react-query";
import { useContext, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { resourceSearchPath } from "@/app/layouts/resource-search-items";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Sheet } from "@/shared/components/ui/Sheet";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatNumber } from "@/shared/utils/format";

/** Read-only navigation detail; policy execution and editing remain in their existing flows. */
export function PolicySearchDetail(): React.JSX.Element | null {
  const auth = useAuth();
  const access = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const [params, update] = useSearchState();
  const id = params.get("policy");
  const returnRef = useRef<HTMLElement>(null);
  if (id === null) return null;
  const permitted =
    access?.featureId === "governance.policies" &&
    access.permitted === true &&
    auth.user?.scopes.includes("security:read") === true;
  const valid =
    id.trim() === id &&
    !/[\p{Cc}]/u.test(id) &&
    Boolean(resourceSearchPath("policy", id, auth.credentialPrefixes));
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
    permitted,
  ]);
  return (
    <Sheet
      open
      title="정책 상세"
      description="검색한 정책의 현재 상태를 확인합니다. 이 패널에서는 정책을 변경하지 않습니다."
      returnFocusRef={returnRef}
      onOpenChange={(open) => {
        if (!open) update({ policy: undefined });
      }}
    >
      {!permitted ? (
        <InlineNotice tone="warning" title="정책 조회 권한이 없습니다.">
          관리자에게 security:read 권한을 요청하세요.
        </InlineNotice>
      ) : !valid ? (
        <EmptyState
          title="정책 주소를 확인하세요."
          description="자원 검색에서 정책 이름을 다시 선택하세요."
        />
      ) : (
        <PolicyDetailContent key={owner + id} owner={owner} id={id} prefixes={auth.credentialPrefixes} />
      )}
    </Sheet>
  );
}

function PolicyDetailContent({
  owner,
  id,
  prefixes,
}: {
  owner: string;
  id: string;
  prefixes: readonly string[];
}): React.JSX.Element {
  const query = useQuery({
    queryKey: ["governance", "policy-search-detail", owner, id],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.policies.list, {
        signal,
        routeId: "governance.policies",
      }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  // Never show a cached policy as current after a denial or failed revalidation.
  const selected =
    query.isSuccess && !query.isFetching
      ? query.data.policies?.find((policy) => policy.id === id)
      : undefined;
  const denied = isAppError(query.error) && [401, 403].includes(query.error.status ?? 0);
  const rawRequestId = isAppError(query.error) ? query.error.requestId : undefined;
  const requestId =
    rawRequestId &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(rawRequestId) &&
    !containsPotentialSecret(rawRequestId, prefixes)
      ? rawRequestId
      : undefined;
  const display = (value: string | undefined) =>
    !value
      ? "확인할 수 없음"
      : [...value].length > 512
        ? "표시 범위를 초과한 값입니다."
        : containsPotentialSecret(value, prefixes)
          ? "민감정보가 포함될 수 있어 표시하지 않습니다."
          : value;
  return (
    <div className="page-stack">
      {query.isPending || query.isFetching ? (
        <p role="status">정책을 불러오고 있습니다…</p>
      ) : query.isError ? (
        <InlineNotice
          tone="danger"
          title={denied ? "정책 조회 권한을 확인하세요." : "정책을 불러오지 못했습니다."}
        >
          {denied
            ? "현재 로그인과 security:read 권한을 확인한 뒤 다시 시도하세요."
            : "연결 상태를 확인한 뒤 다시 시도하세요."}
          {requestId ? <p>요청 ID: {requestId}</p> : null}
        </InlineNotice>
      ) : !selected ? (
        <EmptyState
          title="정책을 찾을 수 없습니다."
          description="삭제되었거나 주소가 변경되었을 수 있습니다. 자원 검색을 다시 실행하세요."
        />
      ) : (
        <>
          <h3>{display(selected.name)}</h3>
          <dl className="policy-search-summary">
            <div>
              <dt>정책 ID</dt>
              <dd>{display(selected.id)}</dd>
            </div>
            <div>
              <dt>상태</dt>
              <dd>
                {selected.enabled === undefined
                  ? "확인할 수 없음"
                  : selected.enabled
                    ? "사용 중"
                    : "사용 중지"}
              </dd>
            </div>
            <div>
              <dt>우선순위</dt>
              <dd>{selected.priority === undefined ? "확인할 수 없음" : formatNumber(selected.priority)}</dd>
            </div>
            <div>
              <dt>적용 비율</dt>
              <dd>
                {selected.rollout_percent === undefined
                  ? "확인할 수 없음"
                  : `${formatNumber(selected.rollout_percent || 100)}%`}
              </dd>
            </div>
            <div>
              <dt>규칙 수</dt>
              <dd>{formatNumber(selected.rules?.length ?? 0)}개</dd>
            </div>
          </dl>
          <p>조건·동작 본문은 이 요약에 표시하지 않습니다. 변경은 정책 목록의 검토 절차를 이용하세요.</p>
        </>
      )}
      <Button
        variant="secondary"
        aria-disabled={query.isFetching}
        onClick={() => {
          if (!query.isFetching) void query.refetch({ cancelRefetch: false });
        }}
      >
        정책 다시 조회
      </Button>
    </div>
  );
}
