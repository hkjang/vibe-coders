import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useState, useSyncExternalStore, type PropsWithChildren } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { tokenStore } from "@/shared/auth/token-store";
import { isAppError } from "@/shared/api/error";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { RoutingRuleWorkspaceContext } from "./routing-rule-workspace-context";

const isRuleQuery = ({ queryKey }: { queryKey: readonly unknown[] }) =>
  queryKey[0] === "routing" && (queryKey[1] === "rules" || queryKey[1] === "rule-detail");

/** Keep the existing mutation cache keys, but never reuse them across readers. */
export function RoutingRuleWorkspace({ children }: PropsWithChildren) {
  const client = useQueryClient();
  const auth = useAuth();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = useFeatureReadOwner("routing.rules", "routing-rules-workspace", [], "routing:read");
  // Display-mask changes invalidate approvals in the existing editors but do
  // not discard their drafts. Reader identity changes dispose the whole view.
  const principal = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.team_id,
    auth.user?.role,
    auth.user?.roles,
    owner.readable,
  ]);
  const [readyPrincipal, setReadyPrincipal] = useState<string>();
  const [, notifyDenial] = useState(0);
  const clear = useCallback(() => {
    const cancelled = client.cancelQueries({ predicate: isRuleQuery });
    client.removeQueries({ predicate: isRuleQuery });
    return cancelled;
  }, [client]);
  useLayoutEffect(() => {
    // No child observes the old shared mutation/list key during an identity
    // transition. Only mount the next reader after cancellation and disposal.
    let current = true;
    void clear().then(() => {
      if (current) setReadyPrincipal(principal);
    });
    return () => {
      current = false;
      void clear();
    };
  }, [clear, principal]);
  useLayoutEffect(() => {
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        event.action.type !== "error" ||
        !isRuleQuery(event.query) ||
        client.getQueryCache().get(event.query.queryHash) !== event.query
      )
        return;
      const error = event.query.state.error;
      if (!owner.isCurrent() || !isAppError(error) || (error.status !== 401 && error.status !== 403)) return;
      owner.denied = true;
      clear();
      notifyDenial((value) => value + 1);
    });
    return () => {
      unsubscribe();
    };
  }, [clear, client, owner]);
  useLayoutEffect(() => {
    // The shared read-owner listener may observe a detail denial before this
    // boundary's listener. Dispose the list as well in that notification order.
    if (owner.denied) {
      clear();
    }
  }, [clear, owner, owner.denied]);
  if (!owner.readable || owner.denied)
    return (
      <InlineNotice
        tone="warning"
        title="라우팅 규칙 조회 권한을 확인하세요."
        actions={
          owner.readable && owner.denied ? <Button onClick={owner.restart}>권한 다시 확인</Button> : undefined
        }
      >
        목록과 상세를 닫았습니다. 현재 계정의 routing:read 권한과 기능 공개 상태를 확인하세요.
      </InlineNotice>
    );
  if (readyPrincipal !== principal) return <LoadingState label="라우팅 규칙 조회를 준비하고 있습니다." />;
  return <RoutingRuleWorkspaceContext value={owner}>{children}</RoutingRuleWorkspaceContext>;
}
