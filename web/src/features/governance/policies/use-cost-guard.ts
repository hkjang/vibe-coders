import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { useAuth } from "@/app/auth/AuthProvider";
import { confirmedCostGuard, type CostGuardValues } from "./cost-guard-state";
import { apiClient } from "@/shared/api/client";
import { costGuardQueryKeys, type CostGuard } from "@/shared/api/domains/cost-guard";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { costGuardContractMessage, supportsCostGuardContract } from "@/shared/utils/cost-guard";

const queryKey = costGuardQueryKeys.governance;
const routeId = "governance.policies";
export interface CostGuardDraft {
  baseline: CostGuard;
  epoch: number;
  instance: number;
}

export function useCostGuard(canWrite: boolean, epoch: number) {
  const auth = useAuth();
  const supported = supportsCostGuardContract(auth.backendVersion);
  const contract = useRef(supported);
  useLayoutEffect(() => {
    contract.current = supported;
  }, [supported]);
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.costGuard.get, { signal, routeId }),
    retry: false,
    gcTime: 0,
    refetchOnMount: "always",
  });
  // QueryObserver does not expose isInvalidated. The actual state also makes
  // non-refetching invalidations visible to the summary and action controls.
  const state = useSyncExternalStore(
    useCallback((listener) => client.getQueryCache().subscribe(listener), [client]),
    useCallback(() => client.getQueryState<CostGuard>(queryKey), [client]),
  );
  const confirmed = supported ? confirmedCostGuard(state) : undefined;
  const [target, setTarget] = useState<CostGuardDraft>();
  const [pending, setPending] = useState(false);
  const [committed, setCommitted] = useState(false);
  useLayoutEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        // Retire the post-save warning on a confirmed read event, not in a
        // render effect or on unrelated observer notifications of old data.
        if (
          event.type === "updated" &&
          event.action.type === "success" &&
          event.query === client.getQueryCache().find({ queryKey, exact: true }) &&
          contract.current &&
          confirmedCostGuard(event.query.state)
        )
          setCommitted(false);
      }),
    [client],
  );
  const active = useRef<CostGuardDraft | undefined>(undefined);
  const flight = useRef<number | undefined>(undefined);
  const sequence = useRef(0);
  const writable = useRef(canWrite);
  const mounted = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    writable.current = canWrite;
  }, [canWrite]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current = undefined;
    };
  }, []);

  const current = (draft: CostGuardDraft): boolean =>
    mounted.current &&
    active.current?.instance === draft.instance &&
    draft.epoch === tokenStore.getSessionEpoch();
  const open = (trigger: HTMLElement): void => {
    if (!writable.current || !contract.current || active.current || epoch !== tokenStore.getSessionEpoch())
      return;
    const baseline = confirmedCostGuard(client.getQueryState<CostGuard>(queryKey));
    if (!baseline) return;
    const draft = { baseline: { ...baseline }, epoch, instance: ++sequence.current };
    active.current = draft;
    setCommitted(false);
    returnFocusRef.current = trigger;
    setTarget(draft);
  };
  const close = (instance: number): void => {
    if (active.current?.instance !== instance) return;
    active.current = undefined;
    setTarget(undefined);
  };
  const submit = async (draft: CostGuardDraft, values: CostGuardValues): Promise<void> => {
    if (!current(draft) || !writable.current)
      throw new AppError("현재 세션의 설정 변경 권한을 확인한 뒤 다시 시도하세요.", { kind: "permission" });
    if (!contract.current) throw new AppError(costGuardContractMessage, { kind: "contract" });
    // Async form validation may yield to invalidation or a failed refresh.
    // A fixed baseline is not a lock on the latest server configuration.
    if (!confirmedCostGuard(client.getQueryState<CostGuard>(queryKey)))
      throw new AppError("현재 비용 보호 설정을 다시 조회한 뒤 저장하세요.", { kind: "contract" });
    if (flight.current !== undefined) throw new AppError("처리 중입니다.", { kind: "aborted" });
    const body = Object.freeze({ enabled: values.enabled, threshold_krw: values.thresholdKrw });
    flight.current = draft.instance;
    setCommitted(false);
    setPending(true);
    try {
      await apiClient.request(endpoints.domains.governance.costGuard.save, { body, routeId });
      if (!current(draft)) return;
      setCommitted(true);
      toast.success("비용 보호 설정을 저장했습니다.");
      // POST is committed. Refresh is a separate read, not a reason to replay.
      for (const key of Object.values(costGuardQueryKeys))
        void client.invalidateQueries({ queryKey: key, exact: true }).catch(() => undefined);
    } finally {
      if (flight.current === draft.instance) flight.current = undefined;
      if (current(draft)) setPending(false);
    }
  };
  return {
    query,
    state,
    supported,
    confirmed,
    target,
    pending,
    committed,
    returnFocusRef,
    open,
    close,
    submit,
  };
}

export type CostGuardEditor = ReturnType<typeof useCostGuard>;
