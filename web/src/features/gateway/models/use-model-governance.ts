import { modelWriteFlight } from "./model-write-flight";
import { modelOwnedKey, useModelReadOwner } from "./model-read-owner";
import { assertFeatureRead } from "@/shared/hooks/use-feature-read-owner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { apiClient } from "@/shared/api/client";
import type { ModelContractWriteBody, ModelDeprecationWriteBody } from "@/shared/api/domains/gateway";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useModelAccess } from "./use-model-access";
import { modelIdentityReason, safeModelTarget } from "./model-governance-form";
import { AppError } from "@/shared/api/error";

const routeId = "gateway.models";
const gateway = endpoints.domains.gateway;

export const modelGovernanceKeys = {
  contracts: ["gateway", "models", "contracts"] as const,
  deprecations: ["gateway", "models", "deprecations"] as const,
};

export const modelListUnknownReason =
  "목록이 확인되지 않아 저장하거나 삭제할 수 없습니다. 목록을 다시 조회하세요.";
export function useModelListPrerequisite(kind: keyof typeof modelGovernanceKeys) {
  const client = useQueryClient();
  const owner = useModelReadOwner();
  const key = useMemo(() => modelOwnedKey(modelGovernanceKeys[kind], owner), [kind, owner]);
  const getSnapshot = useCallback(() => client.getQueryState(key), [client, key]);
  const subscribe = useCallback((notify: () => void) => client.getQueryCache().subscribe(notify), [client]);
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const confirmed =
    owner.isCurrent() && state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated;
  const assertCurrent = () => {
    assertFeatureRead(owner);
    const latest = client.getQueryState(key);
    if (latest?.status !== "success" || latest.fetchStatus !== "idle" || latest.isInvalidated)
      throw new AppError(modelListUnknownReason, { kind: "contract" });
  };
  return { confirmed, reason: confirmed ? undefined : modelListUnknownReason, assertCurrent };
}

export function useModelContracts() {
  const owner = useModelReadOwner();
  return useQuery({
    queryKey: modelOwnedKey(modelGovernanceKeys.contracts, owner),
    enabled: owner.readable && !owner.denied,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(gateway.models.contracts.list, { signal, routeId });
      assertFeatureRead(owner, signal);
      return result;
    },
  });
}

export function useModelDeprecations() {
  const owner = useModelReadOwner();
  return useQuery({
    queryKey: modelOwnedKey(modelGovernanceKeys.deprecations, owner),
    enabled: owner.readable && !owner.denied,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(gateway.models.deprecations.list, { signal, routeId });
      assertFeatureRead(owner, signal);
      return result;
    },
  });
}

export function useModelGovernanceMutations() {
  const access = useModelAccess();
  const client = useQueryClient();
  const write = <T>(operation: () => Promise<T>) => modelWriteFlight(client, access.sessionKey, operation);
  const contracts = useModelListPrerequisite("contracts");
  const deprecations = useModelListPrerequisite("deprecations");
  const saveContract = useMutationFeedback({
    ownsResult: access.ownsResult,
    mutate: (body: ModelContractWriteBody) => {
      access.write.assertCurrent();
      contracts.assertCurrent();
      if (body.id != null && !safeModelTarget(body.id, "contract"))
        throw new AppError(modelIdentityReason, { kind: "contract" });
      return write(() =>
        apiClient.request(gateway.models.contracts.save, { body, routeId, retryUnauthorized: false }),
      );
    },
    invalidates: [modelGovernanceKeys.contracts],
    successMessage: "모델 계약을 저장했습니다.",
    errorMessage: "모델 계약을 저장하지 못했습니다.",
  });

  const removeContract = useMutationFeedback({
    ownsResult: access.ownsResult,
    mutate: (id: string) => {
      access.write.assertCurrent();
      contracts.assertCurrent();
      if (!safeModelTarget(id, "contract")) throw new AppError(modelIdentityReason, { kind: "contract" });
      return write(() =>
        apiClient.request(gateway.models.contracts.remove, {
          query: { id },
          routeId,
          retryUnauthorized: false,
        }),
      );
    },
    invalidates: [modelGovernanceKeys.contracts],
    successMessage: "모델 계약을 삭제했습니다.",
    errorMessage: "모델 계약을 삭제하지 못했습니다.",
  });

  const runContract = useMutationFeedback({
    ownsResult: access.ownsResult,
    mutate: (input: { model: string; contract_id?: string }) => {
      access.run.assertCurrent();
      return apiClient.request(gateway.models.contracts.run, {
        body: input,
        routeId,
        retryUnauthorized: false,
      });
    },
    successMessage: "계약 검증을 실행했습니다.",
    errorMessage: "계약 검증을 실행하지 못했습니다.",
  });

  const saveDeprecation = useMutationFeedback({
    ownsResult: access.ownsResult,
    mutate: (body: ModelDeprecationWriteBody) => {
      access.write.assertCurrent();
      deprecations.assertCurrent();
      return write(() =>
        apiClient.request(gateway.models.deprecations.save, { body, routeId, retryUnauthorized: false }),
      );
    },
    invalidates: [modelGovernanceKeys.deprecations, ["admin", "models"]],
    successMessage: "지원 종료 정책을 저장했습니다.",
    errorMessage: "지원 종료 정책을 저장하지 못했습니다.",
  });

  const removeDeprecation = useMutationFeedback({
    ownsResult: access.ownsResult,
    mutate: (id: string) => {
      access.write.assertCurrent();
      deprecations.assertCurrent();
      if (!safeModelTarget(id, "deprecation")) throw new AppError(modelIdentityReason, { kind: "contract" });
      return write(() =>
        apiClient.request(withPathParams(gateway.models.deprecations.remove, { id }), {
          routeId,
          retryUnauthorized: false,
        }),
      );
    },
    invalidates: [modelGovernanceKeys.deprecations, ["admin", "models"]],
    successMessage: "지원 종료 정책을 삭제했습니다.",
    errorMessage: "지원 종료 정책을 삭제하지 못했습니다.",
  });

  return { access, removeContract, removeDeprecation, runContract, saveContract, saveDeprecation } as const;
}
