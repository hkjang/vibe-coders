import { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { isAppError } from "@/shared/api/error";
import {
  createLegacyRecoveryRequestId,
  legacyRecoveryNavigation,
  legacyRecoveryTimeoutMs,
  readLegacyRecoveryDecision,
  type LegacyRecoveryDecision,
} from "@/shared/api/legacy-recovery";
import { subscribeToLogout, tokenStore } from "@/shared/auth/token-store";

interface RecoveryState {
  pending: boolean;
  message?: string;
  requestId?: string;
}

interface Attempt {
  epoch: number;
  queryKey: readonly ["root-legacy-recovery", number];
  requestId: string;
  timer?: number;
  timedOut: boolean;
}

const decisionMessages: Record<Exclude<LegacyRecoveryDecision, "allowed">, string> = {
  disabled: "현재 설정에서 기존 관리자 이동을 허용하지 않습니다.",
  anonymous: "로그인 상태를 확인할 수 없습니다. 화면을 다시 불러와 로그인하세요.",
  forbidden: "현재 계정에는 기존 관리자 화면을 열 권한이 없습니다.",
};

/** The failed provider tree cannot supply auth, routing, or query context here. */
export function RootLegacyRecovery(): React.JSX.Element {
  const [queryClient] = useState(() => new QueryClient());
  const [state, setState] = useState<RecoveryState>({ pending: false });
  const attemptRef = useRef<Attempt | undefined>(undefined);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const retire = (): void => {
      const attempt = attemptRef.current;
      attemptRef.current = undefined;
      if (attempt?.timer !== undefined) window.clearTimeout(attempt.timer);
      queryClient.clear();
    };
    const unsubscribeSession = tokenStore.subscribeSession(() => {
      retire();
      if (mounted.current) {
        setState({ pending: false, message: "로그인 상태가 변경되었습니다. 다시 확인하세요." });
      }
    });
    // AuthProvider was unmounted; this fallback owns cross-tab logout reception.
    const unsubscribeLogout = subscribeToLogout(() => undefined);
    return () => {
      mounted.current = false;
      retire();
      unsubscribeSession();
      unsubscribeLogout();
    };
  }, [queryClient]);

  const recover = async (): Promise<void> => {
    if (attemptRef.current) return;
    const epoch = tokenStore.getSessionEpoch();
    const attempt: Attempt = {
      epoch,
      queryKey: ["root-legacy-recovery", epoch],
      requestId: createLegacyRecoveryRequestId(),
      timedOut: false,
    };
    const current = (): boolean =>
      mounted.current && attemptRef.current === attempt && tokenStore.getSessionEpoch() === attempt.epoch;
    attemptRef.current = attempt;
    setState({ pending: true });
    // Bound the recovery UI even if a transport does not settle after cancellation.
    attempt.timer = window.setTimeout(() => {
      if (!current()) return;
      attempt.timedOut = true;
      void queryClient.cancelQueries({ queryKey: attempt.queryKey, exact: true });
    }, legacyRecoveryTimeoutMs);
    try {
      const decision = await queryClient.fetchQuery({
        queryKey: attempt.queryKey,
        queryFn: ({ signal }) => readLegacyRecoveryDecision(signal, attempt.requestId),
        staleTime: 0,
        gcTime: 0,
        retry: false,
      });
      if (!current()) return;
      if (decision === "allowed") legacyRecoveryNavigation.open();
      else setState({ pending: false, message: decisionMessages[decision] });
    } catch (error) {
      if (!current()) return;
      const message =
        attempt.timedOut || (isAppError(error) && error.kind === "timeout")
          ? "접근 확인 시간이 초과되었습니다. 다시 시도하거나 화면을 다시 불러오세요."
          : isAppError(error) && error.status === 401
            ? decisionMessages.anonymous
            : isAppError(error) && error.status === 403
              ? decisionMessages.forbidden
              : "기존 관리자 접근을 확인하지 못했습니다. 다시 시도하거나 화면을 다시 불러오세요.";
      setState({
        pending: false,
        message,
        // Only show the server's echo of this attempt's generated correlation ID.
        requestId: isAppError(error) && error.requestId === attempt.requestId ? error.requestId : undefined,
      });
    } finally {
      if (attempt.timer !== undefined) window.clearTimeout(attempt.timer);
      if (attemptRef.current === attempt) {
        attemptRef.current = undefined;
        queryClient.removeQueries({ queryKey: attempt.queryKey, exact: true });
      }
    }
  };

  return (
    <div className="root-legacy-recovery">
      <button
        className="button button-default"
        aria-disabled={state.pending}
        aria-busy={state.pending}
        onClick={() => void recover()}
        aria-describedby="root-legacy-recovery-status"
      >
        {state.pending ? "기존 관리자 접근 확인 중…" : "기존 관리자 화면 열기"}
      </button>
      <p id="root-legacy-recovery-status" role="status">
        {state.pending
          ? "현재 전환 설정과 접근 권한을 확인하고 있습니다."
          : (state.message ?? "현재 전환 설정과 접근 권한을 확인한 뒤 기존 관리자로 이동합니다.")}
      </p>
      {state.requestId ? <p className="request-id">요청 ID: {state.requestId}</p> : null}
    </div>
  );
}
