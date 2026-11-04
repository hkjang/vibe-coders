import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { assertProviderRead, providerOwnedKey, useProviderReadScope } from "./provider-read-owner";

/** A current-configuration read, never a simulation of an editor's draft. */
export function useProviderImpact(providerRef: string, enabled: boolean, pending: boolean) {
  const client = useQueryClient();
  const owner = useProviderReadScope();
  const queryKey = providerOwnedKey(["admin", "providers", "impact", providerRef], owner);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      assertProviderRead(owner, signal);
      const result = await apiClient.request(endpoints.admin.providers.impact, {
        query: { provider_ref: providerRef },
        signal,
        routeId: "gateway.providers",
      });
      assertProviderRead(owner, signal);
      if (result.provider_ref !== providerRef)
        throw new AppError("영향 조회의 공급자 참조가 요청한 대상과 다릅니다.", {
          kind: "contract",
          code: "provider_impact_reference_mismatch",
        });
      return result;
    },
    enabled: enabled && !pending && owner.readable && !owner.denied,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // An acknowledgement belongs to one response, including an identical refetch.
    structuralSharing: false,
  });
  const [acknowledgedResult, setAcknowledgedResult] = useState<object>();
  const consent = useRef<object | undefined>(undefined);
  const rememberConsent = (value: object | undefined): void => {
    consent.current = value;
    setAcknowledgedResult(value);
  };
  const result = query.isError ? query.error : query.data;
  const settled = owner.isCurrent() && enabled && !query.isPending && query.fetchStatus === "idle";
  const acknowledged = settled && result !== undefined && acknowledgedResult === result;
  return {
    query,
    acknowledged,
    canConfirm: acknowledged && !pending,
    canSubmit: (): boolean => {
      // Consult live cache state as well as React state: refresh + submit in the
      // same event tick must not use a consent from the previous response.
      const current = client.getQueryState(queryKey);
      const currentResult = current?.status === "error" ? current.error : current?.data;
      return (
        owner.isCurrent() &&
        enabled &&
        !pending &&
        current?.fetchStatus === "idle" &&
        consent.current !== undefined &&
        consent.current === currentResult
      );
    },
    canAcknowledge: settled && !pending,
    setAcknowledged: (checked: boolean): void => {
      if (pending || !settled) return;
      rememberConsent(checked ? result : undefined);
    },
    resetAcknowledgement: (): void => rememberConsent(undefined),
    refresh: (): void => {
      if (!owner.isCurrent()) return;
      if (pending || !enabled || query.fetchStatus !== "idle") return;
      rememberConsent(undefined);
      void query.refetch();
    },
  };
}

export type ProviderImpactReview = ReturnType<typeof useProviderImpact>;
